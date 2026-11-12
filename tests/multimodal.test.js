'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const multimodal = require('../src/deepseek/multimodal');
const serverInternals = require('../server').__test;

test('multimodal: detectMimeType identifies PNG, JPEG, GIF, WebP, BMP', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    assert.equal(multimodal.detectMimeType(png), 'image/png');

    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    assert.equal(multimodal.detectMimeType(jpeg), 'image/jpeg');

    const gif = Buffer.from('GIF89a...');
    assert.equal(multimodal.detectMimeType(gif), 'image/gif');

    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)]);
    assert.equal(multimodal.detectMimeType(webp), 'image/webp');

    const bmp = Buffer.from('BM1234');
    assert.equal(multimodal.detectMimeType(bmp), 'image/bmp');

    const invalid = Buffer.from('Plain text or invalid bytes');
    assert.equal(multimodal.detectMimeType(invalid), null);
    assert.equal(multimodal.detectMimeType(Buffer.alloc(2)), null);
    assert.equal(multimodal.detectMimeType(null), null);
});

test('multimodal: isSupportedVisionMime validates allowed vision formats', () => {
    assert.equal(multimodal.isSupportedVisionMime('image/png'), true);
    assert.equal(multimodal.isSupportedVisionMime('image/jpeg'), true);
    assert.equal(multimodal.isSupportedVisionMime('image/jpg'), true);
    assert.equal(multimodal.isSupportedVisionMime('image/webp'), true);
    assert.equal(multimodal.isSupportedVisionMime('image/gif'), true);

    // Unsupported formats
    assert.equal(multimodal.isSupportedVisionMime('image/svg+xml'), false);
    assert.equal(multimodal.isSupportedVisionMime('image/bmp'), false);
    assert.equal(multimodal.isSupportedVisionMime('application/pdf'), false);
    assert.equal(multimodal.isSupportedVisionMime('text/html'), false);
});

test('multimodal: isPrivateHost blocks SSRF on private and loopback hosts', () => {
    assert.equal(multimodal.isPrivateHost('localhost'), true);
    assert.equal(multimodal.isPrivateHost('127.0.0.1'), true);
    assert.equal(multimodal.isPrivateHost('::1'), true);
    assert.equal(multimodal.isPrivateHost('10.0.1.5'), true);
    assert.equal(multimodal.isPrivateHost('192.168.1.1'), true);
    assert.equal(multimodal.isPrivateHost('172.16.5.1'), true);
    assert.equal(multimodal.isPrivateHost('169.254.169.254'), true);

    // External valid domains
    assert.equal(multimodal.isPrivateHost('example.com'), false);
    assert.equal(multimodal.isPrivateHost('images.unsplash.com'), false);
    assert.equal(multimodal.isPrivateHost('cdn.openai.com'), false);
});

test('multimodal: ImageUploadCache manages LRU eviction, TTL, and Map-compatible methods', async () => {
    const cache = new multimodal.ImageUploadCache(3, 100); // max 3, 100ms TTL

    assert.equal(cache.get('k1'), null);
    assert.equal(cache.stats.misses, 1);

    cache.set('k1', 'file-1');
    cache.set('k2', 'file-2');
    cache.set('k3', 'file-3');

    assert.equal(cache.size, 3);
    assert.equal(cache.has('k1'), true);
    assert.equal(cache.get('k1'), 'file-1');
    assert.equal(cache.stats.hits, 2); // has() + get()

    // Eviction: adding k4 must evict least recently used (k2, because k1 was refreshed above)
    cache.set('k4', 'file-4');
    assert.equal(cache.stats.evictions, 1);
    assert.equal(cache.get('k2'), null); // evicted
    assert.equal(cache.get('k1'), 'file-1'); // kept
    assert.equal(cache.get('k3'), 'file-3');
    assert.equal(cache.get('k4'), 'file-4');

    // TTL expiration
    await new Promise(r => setTimeout(r, 110));
    assert.equal(cache.get('k1'), null);
    assert.equal(cache.size, 0);

    // Map methods
    cache.set('temp', 'val');
    assert.equal(cache.delete('temp'), true);
    assert.equal(cache.delete('nonexistent'), false);
    cache.set('a', '1');
    cache.set('b', '2');
    assert.deepEqual(Array.from(cache.entries()), [['a', '1'], ['b', '2']]);
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.stats.hits, 0);
});

test('multimodal: decodeImagePart handles data URLs and enforces image bounds gracefully', () => {
    const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const openaiPart = { type: 'image_url', image_url: { url: `data:image/png;base64,${tinyPng}` } };

    const decoded = multimodal.decodeImagePart(openaiPart);
    assert.ok(decoded);
    assert.equal(decoded.mime, 'image/png');
    assert.equal(decoded.data.length, 70);
    assert.equal(decoded.filename.startsWith('image-'), true);

    const anthropicPart = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: tinyPng } };
    const decodedAnthropic = multimodal.decodeImagePart(anthropicPart);
    assert.ok(decodedAnthropic);
    assert.equal(decodedAnthropic.mime, 'image/png');

    // Oversized image handling: gracefully skipped without throwing or crashing
    const largePart = { type: 'image_url', image_url: { url: `data:image/png;base64,${tinyPng}` } };
    const skipped = multimodal.decodeImagePart(largePart, 10); // max 10 bytes
    assert.equal(skipped, null, 'image exceeding maxBytes must be skipped gracefully');
});

test('multimodal: fetchRemoteImage downloads remote images, detects MIME and protects against SSRF', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const server = http.createServer((req, res) => {
        if (req.url === '/cat.png') {
            res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': pngBytes.length });
            res.end(pngBytes);
        } else if (req.url === '/octet-stream.bin') {
            res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
            res.end(pngBytes);
        } else if (req.url === '/huge.png') {
            res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': '5000' });
            res.end(Buffer.alloc(5000));
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
        // 1. SSRF: blocked by default on 127.0.0.1
        const ssrfBlocked = await multimodal.fetchRemoteImage(`http://127.0.0.1:${port}/cat.png`);
        assert.equal(ssrfBlocked, null);

        // 2. Allowed with allowPrivate: true
        const fetched = await multimodal.fetchRemoteImage(`http://127.0.0.1:${port}/cat.png`, { allowPrivate: true });
        assert.ok(fetched);
        assert.equal(fetched.mime, 'image/png');
        assert.deepEqual(fetched.data, pngBytes);
        assert.ok(fetched.filename.endsWith('.png'));

        // 3. MIME sniffing from magic bytes when header is application/octet-stream
        const sniffed = await multimodal.fetchRemoteImage(`http://127.0.0.1:${port}/octet-stream.bin`, { allowPrivate: true });
        assert.ok(sniffed);
        assert.equal(sniffed.mime, 'image/png');

        // 4. Oversized remote image skipped gracefully
        const oversized = await multimodal.fetchRemoteImage(`http://127.0.0.1:${port}/huge.png`, { allowPrivate: true, maxBytes: 100 });
        assert.equal(oversized, null);

        // 5. 404 returns null gracefully
        const missing = await multimodal.fetchRemoteImage(`http://127.0.0.1:${port}/missing.png`, { allowPrivate: true });
        assert.equal(missing, null);
    } finally {
        server.close();
    }
});

test('multimodal: collectImagesAsync resolves remote URLs and deduplicates images', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const server = http.createServer((req, res) => {
        if (req.url === '/img.png') {
            res.writeHead(200, { 'Content-Type': 'image/png' });
            res.end(pngBytes);
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
        const messages = [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'Analyze this photo:' },
                    { type: 'image_url', image_url: { url: `http://127.0.0.1:${port}/img.png` } },
                ],
            },
        ];

        const collected = await multimodal.collectImagesAsync(messages, 4, { allowPrivate: true });
        assert.equal(collected.length, 1);
        assert.equal(collected[0].mime, 'image/png');
        assert.deepEqual(collected[0].data, pngBytes);
    } finally {
        server.close();
    }
});

test('multimodal: uploadImagesForAccount executes concurrent uploads with Promise.all and LRU cache', async () => {
    const powChallengeCalls = [];
    const uploadCalls = [];
    let powCounter = 0;

    const mockAccount = {
        id: 'account_concurrent_test',
        headers: { Authorization: 'Bearer test-token' },
    };

    // Substituted client dependencies for testing concurrent uploads
    const clientModule = require('../src/deepseek/client');
    const originalCreatePow = clientModule.createPowHeader;
    const originalDsFetch = clientModule.dsFetch;
    const originalSleep = clientModule.sleepWithSignal;

    clientModule.createPowHeader = async (account, signal, path) => {
        powChallengeCalls.push({ path, time: Date.now() });
        return `pow_solution_${++powCounter}`;
    };

    clientModule.sleepWithSignal = async () => {};

    clientModule.dsFetch = async (url, opts) => {
        if (url.includes('/api/v0/file/upload_file')) {
            uploadCalls.push({ time: Date.now(), pow: opts.headers['X-DS-PoW-Response'] });
            const id = `ds_file_${uploadCalls.length}`;
            return {
                ok: true,
                status: 200,
                headers: new Headers(),
                text: async () => JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: { id, status: 'SUCCESS' } } }),
            };
        }
        if (url.includes('/api/v0/file/fetch_files')) {
            const match = url.match(/file_ids=([^&]+)/);
            const id = match ? decodeURIComponent(match[1]) : 'unknown';
            return {
                ok: true,
                status: 200,
                headers: new Headers(),
                text: async () => JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: { files: [{ id, status: 'SUCCESS' }] } } }),
            };
        }
        throw new Error(`Unexpected URL: ${url}`);
    };

    try {
        const images = [
            { mime: 'image/png', data: Buffer.from('img-data-1'), hash: 'hash1', filename: 'img-1.png' },
            { mime: 'image/png', data: Buffer.from('img-data-2'), hash: 'hash2', filename: 'img-2.png' },
            { mime: 'image/jpeg', data: Buffer.from('img-data-3'), hash: 'hash3', filename: 'img-3.jpg' },
        ];

        // 1. First upload: uploads all 3 images concurrently
        const fileIds = await multimodal.uploadImagesForAccount(mockAccount, images, null, '[concurrent-test]');
        assert.equal(fileIds.length, 3);
        assert.deepEqual(fileIds, ['ds_file_1', 'ds_file_2', 'ds_file_3']);
        assert.equal(uploadCalls.length, 3);
        assert.equal(powChallengeCalls.length, 3, 'each file upload requires its own separate PoW challenge');

        // 2. Second upload with identical images: should all be served from LRU cache
        const cachedFileIds = await multimodal.uploadImagesForAccount(mockAccount, images, null, '[concurrent-test]');
        assert.deepEqual(cachedFileIds, fileIds);
        assert.equal(uploadCalls.length, 3, 'no additional network uploads should occur on cache hits');
    } finally {
        clientModule.createPowHeader = originalCreatePow;
        clientModule.dsFetch = originalDsFetch;
        clientModule.sleepWithSignal = originalSleep;
    }
});
