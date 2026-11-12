const fs = require('fs');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 9655);
const HOST = process.env.HOST || '127.0.0.1';

function loadProxyApiKey(env = process.env) {
    if (env.PROXY_API_KEY) return String(env.PROXY_API_KEY);
    const secretPath = String(env.PROXY_API_KEY_FILE || '').trim();
    if (!secretPath) return '';
    try {
        return fs.readFileSync(secretPath, 'utf8').trim();
    } catch (error) {
        // A missing optional secret is equivalent to an unset key. Container
        // deployments set REQUIRE_PROXY_API_KEY=1 and fail closed in main().
        if (error.code === 'ENOENT') return '';
        throw new Error(`Could not read PROXY_API_KEY_FILE (${secretPath}): ${error.message}`);
    }
}

function requireProxyApiKey(key, required) {
    if (required && !key) {
        throw new Error('PROXY_API_KEY is required. Set PROXY_API_KEY or mount a secret and set PROXY_API_KEY_FILE.');
    }
}

const PROXY_API_KEY = loadProxyApiKey();
const PROXY_CORS_ORIGINS = new Set(String(process.env.PROXY_CORS_ORIGINS || '')
    .split(',')
    .map(value => normalizeOrigin(value))
    .filter(Boolean));

function isTruthy(value) { return typeof value === 'string' && ['1','true','yes','on'].includes(value.trim().toLowerCase()); }

function isProxyKeyMatch(suppliedKey, expectedKey) {
    if (typeof suppliedKey !== 'string') return false;
    const supplied = Buffer.from(suppliedKey, 'utf8');
    const expected = Buffer.from(String(expectedKey), 'utf8');
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

// Accepts the proxy key as `Authorization: Bearer <key>` (OpenAI clients,
// Claude Code's ANTHROPIC_AUTH_TOKEN) or as `x-api-key: <key>` (Anthropic
// SDKs and ANTHROPIC_API_KEY).
function isProxyAuthorized(authorization, expectedKey = PROXY_API_KEY, apiKeyHeader = undefined) {
    if (!expectedKey) return true;
    if (typeof authorization === 'string' && authorization.startsWith('Bearer ')
        && isProxyKeyMatch(authorization.slice('Bearer '.length), expectedKey)) {
        return true;
    }
    return isProxyKeyMatch(apiKeyHeader, expectedKey);
}

function isLoopbackHost(host) {
    const normalized = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    return normalized === '127.0.0.1'
        || normalized === '::1'
        || normalized === '::ffff:127.0.0.1'
        || normalized === 'localhost';
}

function normalizeOrigin(origin) {
    const value = String(origin || '').trim().replace(/\/+$/, '');
    if (!value) return '';
    try {
        const parsed = new URL(value);
        return parsed.origin === 'null' ? value : parsed.origin;
    } catch (e) {
        return value;
    }
}

function isBrowserOriginAllowed(origin, allowedOrigins = PROXY_CORS_ORIGINS) {
    if (!origin) return true; // curl, SDKs, and other non-browser clients
    const normalized = normalizeOrigin(origin);
    if (allowedOrigins.has(normalized)) return true;
    try {
        const parsed = new URL(normalized);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
            && isLoopbackHost(parsed.hostname);
    } catch (e) {
        return false;
    }
}

const CONTEXT_COMPACTED_HEADER = 'X-FreeDeepseek-Context-Compacted';

function setCorsResponseHeaders(res) {
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, x-agent-session');
    res.setHeader('Access-Control-Expose-Headers', CONTEXT_COMPACTED_HEADER);
}

function markContextCompacted(res) {
    // A live stream may already have sent its headers.
    if (!res.headersSent) res.setHeader(CONTEXT_COMPACTED_HEADER, 'true');
}

module.exports = {
    PORT,
    HOST,
    loadProxyApiKey,
    requireProxyApiKey,
    PROXY_API_KEY,
    PROXY_CORS_ORIGINS,
    isTruthy,
    isProxyKeyMatch,
    isProxyAuthorized,
    isLoopbackHost,
    normalizeOrigin,
    isBrowserOriginAllowed,
    CONTEXT_COMPACTED_HEADER,
    setCorsResponseHeaders,
    markContextCompacted,
};
