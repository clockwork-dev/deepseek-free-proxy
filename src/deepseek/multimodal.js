const fs = require('fs');
const crypto = require('crypto');
const { isTruthy } = require('../utils/auth');

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

const decodedImageCache = new WeakMap();

// Inline image of a content part (OpenAI image_url / Responses input_image
// data URLs, Anthropic base64 sources) as { mime, data, hash, filename }, or
// null for remote URLs and anything that is not a usable image.
function decodeImagePart(part) {
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
    // Formats DeepSeek's image understanding accepts; anything else (SVG, ...)
    // stays a text marker instead of failing the whole request.
    if (/^image\/(?:png|jpe?g|webp|gif)$/i.test(mime) && base64) {
        const data = Buffer.from(base64.replace(/\s+/g, ''), 'base64');
        if (data.length > 0 && data.length <= MAX_IMAGE_BYTES) {
            const hash = crypto.createHash('sha256').update(data).digest('hex').substring(0, 12);
            const extension = (mime.split('/')[1] || 'png').replace(/[^\w]/g, '').substring(0, 8) || 'png';
            image = { mime, data, hash, filename: `image-${hash}.${extension}` };
        }
    }
    decodedImageCache.set(part, image);
    return image;
}

function hasInlineImageData(part) {
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

// Uploaded file ids per `account:imageHash`, shared across requests: a turn
// that starts a new chat must not upload the same images again.
const UPLOADED_FILE_TTL_MS = 30 * 60 * 1000;
const UPLOADED_FILE_CACHE_MAX = 256;
const uploadedFileCache = new Map();

function getCachedUpload(key) {
    const entry = uploadedFileCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > UPLOADED_FILE_TTL_MS) { uploadedFileCache.delete(key); return null; }
    return entry.id;
}

function setCachedUpload(key, id) {
    uploadedFileCache.delete(key);
    uploadedFileCache.set(key, { id, at: Date.now() });
    while (uploadedFileCache.size > UPLOADED_FILE_CACHE_MAX) uploadedFileCache.delete(uploadedFileCache.keys().next().value);
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

// Uploads the images of a request once per account (files belong to the
// account that uploaded them).
async function uploadImagesForAccount(account, images, signal, agentTag, deadlineAt = Infinity) {
    if (!images || images.length === 0) return [];
    const ids = [];
    let uploaded = 0;
    try {
        for (const image of images) {
            const key = `${account.id}:${image.hash}`;
            let id = getCachedUpload(key);
            if (!id) {
                // Uploads count against the request's overall deadline.
                if (Date.now() > deadlineAt) {
                    const { timeoutError } = require('./client');
                    throw timeoutError('Request deadline reached while uploading images');
                }
                id = await uploadImageToDeepSeek(account, image, signal, deadlineAt);
                setCachedUpload(key, id);
                uploaded++;
            }
            ids.push(id);
        }
    } catch (error) {
        const { isAccountLevelError } = require('../accounts/pool');
        const { isTimeoutError } = require('./client');
        if (signal?.aborted || isAccountLevelError(error) || isTimeoutError(error)) throw error;
        const failure = new Error(`DeepSeek image upload failed: ${error.message}`);
        failure.status = 502;
        failure.type = 'image_upload_failed';
        throw failure;
    }
    if (uploaded) console.log(`${agentTag} Uploaded ${uploaded} image(s) to DeepSeek`);
    return ids;
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
    COMPLETION_PATH,
    FILE_UPLOAD_PATH,
    uploadedFileCache,
    getCachedUpload,
    setCachedUpload,
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
    normalizeMessageContent,
    extractScreenshotPaths,
    isSystemRole,
};
