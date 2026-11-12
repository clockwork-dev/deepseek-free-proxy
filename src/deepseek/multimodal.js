const fs = require('fs');
const crypto = require('crypto');
const { isTruthy, isLoopbackHost } = require('../utils/auth');

function envNumber(name, fallback, min = 0) {
    const val = Number(process.env[name]);
    return Number.isFinite(val) && val >= min ? val : fallback;
}

function imageUploadEnabled(env = process.env) {
    const value = env.DEEPSEEK_IMAGE_UPLOAD;
    return value === undefined ? true : isTruthy(String(value));
}

const IMAGE_UPLOAD_ENABLED = imageUploadEnabled();
const MAX_IMAGES_PER_REQUEST = Math.floor(envNumber('DEEPSEEK_MAX_IMAGES', 4, 1));
// A 10 MB request body carries at most ~7.5 MB of base64-decoded images.
const MAX_IMAGE_BYTES = Math.floor(envNumber('DEEPSEEK_MAX_IMAGE_BYTES', 7 * 1024 * 1024, 1024));
const DS_FILE_TIMEOUT_MS = envNumber('DEEPSEEK_FILE_TIMEOUT_MS', 60000, 1000);
const DS_FILE_POLL_MS = envNumber('DEEPSEEK_FILE_POLL_MS', 1000, 50);
const REMOTE_IMAGE_FETCH_TIMEOUT_MS = envNumber('DEEPSEEK_IMAGE_FETCH_TIMEOUT_MS', 15000, 1000);
const UPLOADED_FILE_TTL_MS = envNumber('DEEPSEEK_FILE_CACHE_TTL_MS', 30 * 60 * 1000, 1000);
const UPLOADED_FILE_CACHE_MAX = Math.floor(envNumber('DEEPSEEK_FILE_CACHE_MAX', 256, 1));

const COMPLETION_PATH = '/api/v0/chat/completion';
const FILE_UPLOAD_PATH = '/api/v0/file/upload_file';

function isSystemRole(role) {
    return role === 'system' || role === 'developer';
}

function describeAttachment(kind, reference) {
    const value = typeof reference === 'string' ? reference.trim() : '';
    if (!value || value.startsWith('data:') || value.length > 512 || !/^(?:https?:\/\/|[\w.-]+$)/i.test(value)) {
        return `[${kind} attached; not visible through this proxy]`;
    }
    return `[${kind}: ${value}]`;
}

/**
 * Robust in-memory LRU Cache with TTL and statistics.
 * Extends Map compatibility for drop-in usage across tests and code.
 */
class ImageUploadCache {
    constructor(maxEntries = UPLOADED_FILE_CACHE_MAX, defaultTtlMs = UPLOADED_FILE_TTL_MS) {
        this.maxEntries = maxEntries;
        this.defaultTtlMs = defaultTtlMs;
        this.map = new Map();
        this.stats = { hits: 0, misses: 0, evictions: 0 };
    }

    get(key) {
        const entry = this.map.get(key);
        if (!entry) {
            this.stats.misses++;
            return null;
        }
        if (Date.now() - entry.at > entry.ttlMs) {
            this.map.delete(key);
            this.stats.misses++;
            return null;
        }
        // Move to most recently used position
        this.map.delete(key);
        this.map.set(key, entry);
        this.stats.hits++;
        return entry.id;
    }

    set(key, id, ttlMs = this.defaultTtlMs) {
        if (this.map.has(key)) {
            this.map.delete(key);
        }
        this.map.set(key, { id, at: Date.now(), ttlMs });
        while (this.map.size > this.maxEntries) {
            const oldestKey = this.map.keys().next().value;
            this.map.delete(oldestKey);
            this.stats.evictions++;
        }
        return this;
    }

    has(key) {
        return this.get(key) !== null;
    }

    delete(key) {
        return this.map.delete(key);
    }

    clear() {
        this.map.clear();
        this.stats = { hits: 0, misses: 0, evictions: 0 };
    }

    _purgeExpired() {
        const now = Date.now();
        for (const [key, entry] of this.map.entries()) {
            if (now - entry.at > entry.ttlMs) {
                this.map.delete(key);
            }
        }
    }

    get size() {
        this._purgeExpired();
        return this.map.size;
    }

    keys() {
        this._purgeExpired();
        return this.map.keys();
    }

    values() {
        this._purgeExpired();
        return Array.from(this.map.values()).map(e => e.id);
    }

    entries() {
        this._purgeExpired();
        return Array.from(this.map.entries()).map(([k, e]) => [k, e.id]);
    }

    [Symbol.iterator]() {
        return this.entries()[Symbol.iterator]();
    }
}

const uploadedFileCache = new ImageUploadCache();

function getCachedUpload(key) {
    return uploadedFileCache.get(key);
}

function setCachedUpload(key, id) {
    uploadedFileCache.set(key, id);
}

/**
 * Detect image MIME type by inspecting magic header bytes.
 */
function detectMimeType(buffer) {
    if (!buffer || buffer.length < 4) return null;
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buffer.length >= 8 &&
        buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
        buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
        return 'image/png';
    }
    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return 'image/jpeg';
    }
    // GIF: 47 49 46 38 (GIF87a / GIF89a)
    if (buffer.length >= 6 &&
        buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
        return 'image/gif';
    }
    // WebP: RIFF .... WEBP
    if (buffer.length >= 12 &&
        buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
        return 'image/webp';
    }
    // BMP: 42 4D
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
        return 'image/bmp';
    }
    return null;
}

function isSupportedVisionMime(mime) {
    return /^image\/(?:png|jpe?g|webp|gif)$/i.test(String(mime || ''));
}

/**
 * SSRF validation: check if a hostname is private or loopback.
 */
function isPrivateHost(hostname) {
    const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (isLoopbackHost(host)) return true;
    // IPv4 private ranges
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) || /^169\.254\./.test(host)) {
        return true;
    }
    // IPv6 unique local / link local
    if (/^fe80:/i.test(host) || /^fc00:/i.test(host) || /^fd[0-9a-f]{2}:/i.test(host)) {
        return true;
    }
    return false;
}

/**
 * Fetch remote image URL with timeout, bounds checking, and MIME detection.
 */
async function fetchRemoteImage(url, { signal, timeoutMs = REMOTE_IMAGE_FETCH_TIMEOUT_MS, maxBytes = MAX_IMAGE_BYTES, allowPrivate = false } = {}) {
    if (!url || typeof url !== 'string') return null;
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
    }

    if (!allowPrivate && isPrivateHost(parsed.hostname)) {
        console.warn(`[multimodal] SSRF protection blocked remote image fetch to private host: ${parsed.hostname}`);
        return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Timeout fetching remote image after ${timeoutMs}ms`)), timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

    try {
        const resp = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; DeepSeekProxy/1.0; +https://github.com/deepseek-free-proxy)',
                'Accept': 'image/png,image/jpeg,image/webp,image/gif,*/*;q=0.8',
            },
            signal: combinedSignal,
        });

        if (!resp.ok) {
            console.warn(`[multimodal] Remote image fetch failed: HTTP ${resp.status} for ${url}`);
            return null;
        }

        const contentLength = Number(resp.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            console.warn(`[multimodal] Remote image ${url} content-length (${contentLength}) exceeds limit of ${maxBytes} bytes`);
            return null;
        }

        const arrayBuffer = await resp.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        if (buffer.length === 0) return null;
        if (buffer.length > maxBytes) {
            console.warn(`[multimodal] Remote image ${url} (${buffer.length} bytes) exceeds limit of ${maxBytes} bytes`);
            return null;
        }

        let mime = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const detectedMime = detectMimeType(buffer);
        if (detectedMime && (!isSupportedVisionMime(mime) || mime === 'application/octet-stream' || mime === 'binary/octet-stream')) {
            mime = detectedMime;
        }

        if (!isSupportedVisionMime(mime)) {
            console.warn(`[multimodal] Unsupported image MIME "${mime}" for remote image ${url}`);
            return null;
        }

        const hash = crypto.createHash('sha256').update(buffer).digest('hex').substring(0, 12);
        const extension = (mime.split('/')[1] || 'png').replace(/[^\w]/g, '').substring(0, 8) || 'png';
        return {
            mime,
            data: buffer,
            hash,
            filename: `image-${hash}.${extension}`,
            url,
        };
    } catch (err) {
        console.warn(`[multimodal] Failed to fetch remote image ${url}: ${err.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

const decodedImageCache = new WeakMap();

// Inline image of a content part (OpenAI image_url / Responses input_image
// data URLs, Anthropic base64 sources) as { mime, data, hash, filename }, or
// null for remote URLs and anything that is not a usable image.
function decodeImagePart(part, maxBytes = MAX_IMAGE_BYTES) {
    if (!part || typeof part !== 'object') return null;
    if (decodedImageCache.has(part)) return decodedImageCache.get(part);
    let mime = '';
    let base64 = '';
    if (part.type === 'image' && part.source?.type === 'base64') {
        mime = String(part.source.media_type || '');
        base64 = String(part.source.data || '');
    } else if (part.type === 'image_url' || part.type === 'input_image') {
        const url = part.image_url?.url ?? part.image_url ?? part.url;
        const match = typeof url === 'string' ? url.match(/^data:([\w.+-]+\/[\w.+-]+)?((?:;[^;,]*)*),([\s\S]*)$/) : null;
        if (match && /;base64/i.test(match[2])) {
            mime = match[1] || 'image/png';
            base64 = match[3];
        }
    }
    let image = null;
    if (base64) {
        const data = Buffer.from(base64.replace(/\s+/g, ''), 'base64');
        const detectedMime = detectMimeType(data);
        if (detectedMime && !isSupportedVisionMime(mime)) {
            mime = detectedMime;
        }

        // Formats DeepSeek's image understanding accepts; anything else (SVG, ...)
        // stays a text marker instead of failing the whole request.
        if (isSupportedVisionMime(mime)) {
            if (data.length > 0) {
                if (data.length <= maxBytes) {
                    const hash = crypto.createHash('sha256').update(data).digest('hex').substring(0, 12);
                    const extension = (mime.split('/')[1] || 'png').replace(/[^\w]/g, '').substring(0, 8) || 'png';
                    image = { mime, data, hash, filename: `image-${hash}.${extension}` };
                } else {
                    console.warn(`[multimodal] Inline image (${data.length} bytes) exceeds limit of ${maxBytes} bytes; gracefully omitted.`);
                }
            }
        }
    }
    decodedImageCache.set(part, image);
    return image;
}

function hasInlineImageData(part) {
    if (!part || typeof part !== 'object') return false;
    if (part.type === 'image') return part.source?.type === 'base64';
    const url = part.image_url?.url ?? part.image_url ?? part.url;
    return typeof url === 'string' && /^data:/i.test(url);
}

function describeImagePart(part) {
    // Without upload there is nothing to decode: inline data becomes a marker.
    if (!IMAGE_UPLOAD_ENABLED && hasInlineImageData(part)) return '[Image attached; not visible through this proxy]';
    const image = decodeImagePart(part);
    // The marker depends only on the image itself, so message fingerprints
    // stay stable across turns.
    if (image) return IMAGE_UPLOAD_ENABLED ? `[Image ${image.hash} attached]` : '[Image attached; not visible through this proxy]';
    return describeAttachment('Image', part.image_url?.url ?? part.image_url ?? part.url ?? part.source?.url ?? part.source?.data);
}

// Inline images of the given messages in order (including images inside
// Anthropic tool results), de-duplicated, keeping the most recent `limit`.
function collectImages(messages, limit = MAX_IMAGES_PER_REQUEST) {
    const images = [];
    const seen = new Set();
    const visit = (content) => {
        if (!Array.isArray(content)) return;
        for (const part of content) {
            if (!part || typeof part !== 'object') continue;
            if (part.type === 'tool_result') { visit(part.content); continue; }
            const image = decodeImagePart(part);
            if (!image) continue;
            // A repeated image counts at its newest position.
            if (seen.has(image.hash)) images.splice(images.findIndex(item => item.hash === image.hash), 1);
            seen.add(image.hash);
            images.push(image);
        }
    };
    for (const msg of messages || []) {
        if (msg && !isSystemRole(msg.role)) visit(msg.content);
    }
    return images.slice(-limit);
}

/**
 * Collect images with asynchronous remote URL prefetching and resolution.
 */
async function collectImagesAsync(messages, limit = MAX_IMAGES_PER_REQUEST, opts = {}) {
    const remoteTasks = [];

    const visit = (content) => {
        if (!Array.isArray(content)) return;
        for (const part of content) {
            if (!part || typeof part !== 'object') continue;
            if (part.type === 'tool_result') { visit(part.content); continue; }
            if (decodedImageCache.has(part)) continue;

            let remoteUrl = null;
            if (part.type === 'image_url' || part.type === 'input_image') {
                const u = part.image_url?.url ?? part.image_url ?? part.url;
                if (typeof u === 'string' && /^https?:\/\//i.test(u)) remoteUrl = u;
            } else if (part.type === 'image' && part.source?.type === 'url') {
                const u = part.source.url;
                if (typeof u === 'string' && /^https?:\/\//i.test(u)) remoteUrl = u;
            }

            if (remoteUrl) {
                remoteTasks.push(
                    fetchRemoteImage(remoteUrl, opts).then(img => {
                        if (img) decodedImageCache.set(part, img);
                    })
                );
            }
        }
    };

    for (const msg of messages || []) {
        if (msg && !isSystemRole(msg.role)) visit(msg.content);
    }

    if (remoteTasks.length > 0) {
        await Promise.allSettled(remoteTasks);
    }

    return collectImages(messages, limit);
}

function normalizeMessageContent(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return part.text || '';
            if (part.type === 'tool_result') return `[Tool Result ${part.tool_use_id || ''}]\n${normalizeMessageContent(part.content)}`;
            // Earlier reasoning blocks (Anthropic thinking, Responses reasoning)
            // carry signatures/encrypted payloads, not conversation text.
            if (part.type === 'thinking' || part.type === 'redacted_thinking' || part.type === 'reasoning') return '';
            if (part.type === 'image_url' || part.type === 'input_image' || part.type === 'image') {
                return describeImagePart(part);
            }
            if (part.type === 'file' || part.type === 'input_file' || part.type === 'document') {
                return describeAttachment('File', part.file?.filename ?? part.filename ?? part.title ?? part.file_url ?? part.source?.url ?? part.source?.data);
            }
            if (typeof part.text === 'string') return part.text;
            if (part.content !== undefined) return normalizeMessageContent(part.content);
            return JSON.stringify(part);
        }).filter(Boolean).join('\n');
    }
    return String(content);
}

// Status of one uploaded file in a fetch_files response. Read defensively:
// the Web API has returned both lists and id-keyed maps.
function extractUploadedFileStatus(json, fileId) {
    const biz = json?.data?.biz_data;
    const list = Array.isArray(biz?.files) ? biz.files
        : Array.isArray(biz) ? biz
        : (biz && typeof biz === 'object' && biz[fileId]) ? [biz[fileId]]
        : (biz && (biz.id || biz.file_id)) ? [biz] : [];
    const entry = list.find(file => file && (file.id === fileId || file.file_id === fileId)) || (list.length === 1 ? list[0] : null);
    return { status: String(entry?.status || '').toUpperCase(), error: entry?.error_msg || entry?.error || null };
}

// DeepSeek can report throttling inside an HTTP 200 business-error envelope.
// Read a message only when the numeric biz_code says the envelope is an error;
// normal successful response content is never inspected for rate-limit text.
function throwIfImageBusinessRateLimited(account, resp, json) {
    const { isRateLimitError } = require('./client');
    const { throwIfRateLimited } = require('../accounts/pool');
    const bizCode = json?.data?.biz_code;
    if (!Number.isSafeInteger(bizCode) || bizCode === 0) return;
    const bizData = json?.data?.biz_data;
    const message = [
        json?.data?.biz_msg, json?.data?.biz_message, json?.data?.message, json?.data?.msg,
        bizData?.biz_msg, bizData?.biz_message, bizData?.message, bizData?.msg, bizData?.error_msg,
    ].find(value => typeof value === 'string' && value.length <= 2048);
    if (!message || !isRateLimitError(message)) return;
    // Do not expose upstream envelope text in a proxy error or log.
    throwIfRateLimited(account, resp.status, `Too many messages (DeepSeek business code ${bizCode})`, resp.headers.get('retry-after'));
}

const FILE_READY_STATUS = /^(?:SUCCESS|PARSED|DONE|COMPLETED?|FINISHED|READY)$/;
const FILE_FAILED_STATUS = /FAIL|ERROR|REJECT|UNSUPPORT|INVALID|EMPTY/;

// Uploads one image with the account that owns the chat, then waits until
// DeepSeek has processed it. Returns the file id for ref_file_ids.
async function uploadImageToDeepSeek(account, image, signal, deadlineAt = Infinity) {
    const { createPowHeader, dsUrl, dsFetch, timeoutError, sleepWithSignal, createUpstreamHttpError } = require('./client');
    const { readDeepSeekJsonResponse, throwIfRateLimited } = require('../accounts/pool');
    const powB64 = await createPowHeader(account, signal, FILE_UPLOAD_PATH);
    const form = new FormData();
    form.append('file', new Blob([image.data], { type: image.mime }), image.filename);
    const headers = { ...account.headers, 'X-DS-PoW-Response': powB64, 'x-file-size': String(image.data.length) };
    delete headers['Content-Type'];  // fetch sets the multipart boundary
    const resp = await dsFetch(dsUrl(FILE_UPLOAD_PATH), { method: 'POST', headers, body: form, signal }, DS_FILE_TIMEOUT_MS);
    const { json, text } = await readDeepSeekJsonResponse(resp, 'file upload', account);
    if (!resp.ok) {
        throwIfRateLimited(account, resp.status, text, resp.headers.get('retry-after'));
        throw createUpstreamHttpError(resp.status, text, resp.headers.get('retry-after'));
    }
    throwIfImageBusinessRateLimited(account, resp, json);
    const biz = json?.data?.biz_data;
    const fileId = biz?.id || biz?.file_id || biz?.file?.id;
    if (!fileId) throw new Error(`DeepSeek file upload returned no file id. First chars: ${String(text || '').substring(0, 160)}`);

    let { status } = { status: String(biz?.status || '').toUpperCase() };
    const deadline = Math.min(Date.now() + DS_FILE_TIMEOUT_MS, deadlineAt);
    const statusHeaders = { ...account.headers };
    delete statusHeaders['Content-Type'];
    while (!FILE_READY_STATUS.test(status)) {
        if (FILE_FAILED_STATUS.test(status)) throw new Error(`DeepSeek could not process the image (status ${status})`);
        if (Date.now() > deadline) throw timeoutError('DeepSeek did not finish processing the image in time');
        await sleepWithSignal(DS_FILE_POLL_MS, signal);
        const pr = await dsFetch(dsUrl(`/api/v0/file/fetch_files?file_ids=${encodeURIComponent(fileId)}`), { method: 'GET', headers: statusHeaders, signal });
        const polled = await readDeepSeekJsonResponse(pr, 'file status', account);
        if (!pr.ok) {
            throwIfRateLimited(account, pr.status, polled.text, pr.headers.get('retry-after'));
            throw createUpstreamHttpError(pr.status, polled.text, pr.headers.get('retry-after'));
        }
        throwIfImageBusinessRateLimited(account, pr, polled.json);
        const state = extractUploadedFileStatus(polled.json, fileId);
        status = state.status;
        if (state.error && FILE_FAILED_STATUS.test(status)) throw new Error(`DeepSeek could not process the image: ${state.error}`);
    }
    return fileId;
}

// Uploads the images of a request concurrently per account using Promise.all
// and LRU caching (files belong to the account that uploaded them).
async function uploadImagesForAccount(account, images, signal, agentTag, deadlineAt = Infinity) {
    if (!images || images.length === 0) return [];
    try {
        const uploadTasks = images.map(async (image) => {
            const key = `${account.id}:${image.hash}`;
            let id = getCachedUpload(key);
            if (id) {
                return { id, uploaded: false };
            }
            if (Date.now() > deadlineAt) {
                const { timeoutError } = require('./client');
                throw timeoutError('Request deadline reached while uploading images');
            }
            id = await uploadImageToDeepSeek(account, image, signal, deadlineAt);
            setCachedUpload(key, id);
            return { id, uploaded: true };
        });

        const results = await Promise.all(uploadTasks);
        const uploadedCount = results.filter(r => r.uploaded).length;
        if (uploadedCount && agentTag) {
            console.log(`${agentTag} Uploaded ${uploadedCount} image(s) to DeepSeek concurrently`);
        }
        return results.map(r => r.id);
    } catch (error) {
        const { isAccountLevelError } = require('../accounts/pool');
        const { isTimeoutError } = require('./client');
        if (signal?.aborted || isAccountLevelError(error) || isTimeoutError(error)) throw error;
        const failure = new Error(`DeepSeek image upload failed: ${error.message}`);
        failure.status = 502;
        failure.type = 'image_upload_failed';
        throw failure;
    }
}

// Extract MEDIA: paths for screenshots produced during the current turn, so a
// Hermes/Telegram gateway delivers the file. Only messages since the latest
// user message are scanned; older screenshots were delivered with earlier
// answers. Paths are attached only if the file actually exists (DeepSeek
// hallucinates paths).
function extractScreenshotPaths(messages) {
    const paths = [];
    const list = Array.isArray(messages) ? messages : [];
    let start = 0;
    for (let i = list.length - 1; i >= 0; i--) {
        if (list[i]?.role === 'user') { start = i; break; }
    }
    const addPath = (filePath) => {
        const tag = `MEDIA:${filePath}`;
        if (paths.includes(tag)) return;
        try {
            if (fs.statSync(filePath).isFile()) paths.push(tag);
        } catch (e) { /* missing or unreadable: skip */ }
    };
    for (const msg of list.slice(start)) {
        if (!msg) continue;
        const content = normalizeMessageContent(msg.content);
        if (!content) continue;
        if (msg.role === 'tool') {
            // screenshot_path/path fields come directly from browser_vision.
            const pngMatch = content.match(/["'](screenshot_path|path)["']\s*:\s*["']([^"']+\.(?:png|jpg|jpeg|webp|gif))["']/i);
            if (pngMatch && pngMatch[2].startsWith('/')) addPath(pngMatch[2]);
            for (const tag of content.match(/MEDIA:(\S+)/g) || []) addPath(tag.replace(/^MEDIA:/, ''));
        }
        if (msg.role === 'user' || msg.role === 'assistant') {
            const pathRegex = /(\/[^\s<>"']+\.(?:png|jpg|jpeg|webp|gif))/gi;
            let match;
            while ((match = pathRegex.exec(content)) !== null) addPath(match[1]);
        }
    }
    return paths;
}

module.exports = {
    imageUploadEnabled,
    IMAGE_UPLOAD_ENABLED,
    MAX_IMAGES_PER_REQUEST,
    MAX_IMAGE_BYTES,
    DS_FILE_TIMEOUT_MS,
    DS_FILE_POLL_MS,
    REMOTE_IMAGE_FETCH_TIMEOUT_MS,
    COMPLETION_PATH,
    FILE_UPLOAD_PATH,
    uploadedFileCache,
    ImageUploadCache,
    getCachedUpload,
    setCachedUpload,
    detectMimeType,
    isSupportedVisionMime,
    isPrivateHost,
    fetchRemoteImage,
    extractUploadedFileStatus,
    throwIfImageBusinessRateLimited,
    uploadImageToDeepSeek,
    uploadImagesForAccount,
    describeAttachment,
    decodedImageCache,
    decodeImagePart,
    hasInlineImageData,
    describeImagePart,
    collectImages,
    collectImagesAsync,
    normalizeMessageContent,
    extractScreenshotPaths,
    isSystemRole,
    FILE_READY_STATUS,
    FILE_FAILED_STATUS,
};
