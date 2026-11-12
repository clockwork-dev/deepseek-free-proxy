const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadDotEnv } = require('../../lib/env');
const { resetRemoteSession } = require('../sessions/manager');

const ROOT_DIR = path.resolve(__dirname, '..', '..');

function envNumber(name, fallback, min = 0) {
    const val = Number(process.env[name]);
    return Number.isFinite(val) && val >= min ? val : fallback;
}

const DS_CONFIG_PATH = process.env.DEEPSEEK_AUTH_PATH || path.join(ROOT_DIR, 'deepseek-auth.json');
const DEFAULT_ACCOUNT_COOLDOWN_MS = Number(process.env.DEEPSEEK_ACCOUNT_COOLDOWN_MS || 10 * 60 * 1000);
let DS_CONFIG = {};
let dsHeaders = {};
const accounts = [];
let accountRoundRobin = 0;

const RATE_LIMIT_COOLDOWN_MS = envNumber('DEEPSEEK_RATE_LIMIT_COOLDOWN_MS', 60 * 1000, 1000);
const DS_CLIENT_VERSION = process.env.DEEPSEEK_CLIENT_VERSION || '2.0.0';

function buildBaseHeaders(config = DS_CONFIG) {
    return {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        "x-client-platform": "web",
        "x-client-version": DS_CLIENT_VERSION,
        "x-client-locale": "ru",
        "x-client-timezone-offset": "14400",
        "x-app-version": DS_CLIENT_VERSION,
        "Authorization": `Bearer ${config.token || ''}`,
        "x-hif-dliq": config.hif_dliq || '',
        "x-hif-leim": config.hif_leim || '',
        "Origin": "https://chat.deepseek.com",
        "Referer": "https://chat.deepseek.com/",
        "Cookie": config.cookie || '',
        "Content-Type": "application/json",
    };
}

function discoverAuthPaths() {
    if (process.env.DEEPSEEK_AUTH_DIR) {
        try {
            return fs.readdirSync(process.env.DEEPSEEK_AUTH_DIR)
                .filter(f => f.endsWith('.json'))
                .sort()
                .map(f => path.join(process.env.DEEPSEEK_AUTH_DIR, f));
        } catch (e) {
            console.error(`[DS-API] Could not read DEEPSEEK_AUTH_DIR: ${e.message}`);
            return [];
        }
    }
    if (process.env.DEEPSEEK_AUTH_PATH && process.env.DEEPSEEK_AUTH_PATH.includes(',')) {
        return process.env.DEEPSEEK_AUTH_PATH.split(',').map(s => s.trim()).filter(Boolean);
    }
    return [DS_CONFIG_PATH];
}

function loadDeepSeekConfig({ fatal = true } = {}) {
    loadDotEnv();
    accounts.length = 0;
    const paths = discoverAuthPaths();
    for (const file of paths) {
        try {
            const raw = fs.readFileSync(file, 'utf8');
            const config = JSON.parse(raw);
            const id = `account_${accounts.length + 1}`;
            accounts.push({ id, file, config, headers: buildBaseHeaders(config), cooldownUntil: 0, failures: 0, lastUsedAt: 0 });
        } catch (e) {
            console.error(`[DS-API] Could not load auth config ${file}: ${e.message}`);
        }
    }
    DS_CONFIG = accounts[0]?.config || {};
    dsHeaders = accounts[0]?.headers || buildBaseHeaders({});
    if (accounts.length > 0) {
        console.log(`[DS-API] Loaded ${accounts.length} auth account(s): ${accounts.map(a => a.id).join(', ')}`);
        return true;
    }
    if (fatal) {
        console.error(`[DS-API] FATAL: Could not load any auth config. Expected ${paths.join(', ') || DS_CONFIG_PATH}`);
        process.exit(1);
    }
    return false;
}

function hasAuthConfig() { return accounts.some(a => a.config.token && a.config.cookie); }

function accountStatus(account) {
    return {
        id: account.id,
        ready: !!(account.config.token && account.config.cookie),
        cooldown: account.cooldownUntil > Date.now(),
        cooldown_remaining_sec: Math.max(0, Math.ceil((account.cooldownUntil - Date.now()) / 1000)),
        failures: account.failures,
        last_used_at: account.lastUsedAt || null,
    };
}

function selectAccountForSession(session) {
    const now = Date.now();
    if (session.accountId) {
        const sticky = accounts.find(a => a.id === session.accountId);
        if (sticky && sticky.config.token && sticky.config.cookie && sticky.cooldownUntil <= now) return sticky;
    }
    const ready = accounts.filter(a => a.config.token && a.config.cookie && a.cooldownUntil <= now);
    if (ready.length > 0 && session.accountId) {
        // A DeepSeek chat_session belongs to the auth account that created it.
        // If that account disappeared, lost credentials, or is cooling down,
        // never reuse its session id under a different account. While no
        // other account is ready the chat is kept for when its account returns.
        resetRemoteSession(session);
        session.accountId = null;
    }
    if (ready.length === 0) {
        const waiting = accounts.filter(a => a.config.token && a.config.cookie).sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0];
        if (waiting) {
            const waitSec = Math.max(1, Math.ceil((waiting.cooldownUntil - now) / 1000));
            // Tagged so the request handler returns 429 + Retry-After instead of a
            // generic 500 (integrator backoff keys on the status code, not the text).
            const err = new Error(`All DeepSeek auth accounts are cooling down. Retry in ~${waitSec}s or import a fresh account with npm run auth:import.`);
            err.status = 429; err.retryAfter = waitSec; err.type = 'rate_limit';
            throw err;
        }
        const noAuth = new Error('No valid DeepSeek auth accounts. Run npm run auth or npm run auth:import.');
        noAuth.status = 503; noAuth.type = 'no_auth';
        throw noAuth;
    }
    const account = ready[accountRoundRobin % ready.length];
    accountRoundRobin++;
    session.accountId = account.id;
    return account;
}

// Parse a Retry-After header value into a cooldown duration in ms, or null if
// absent/unparseable. Supports both forms: delta-seconds (e.g. "120") and an
// HTTP-date (e.g. "Wed, 21 Oct 2025 07:28:00 GMT"). Clamped to >= 1s.
function parseRetryAfterMs(retryAfterRaw) {
    if (!retryAfterRaw) return null;
    const raw = String(retryAfterRaw).trim();
    if (/^\d+$/.test(raw)) return Math.max(1000, Number(raw) * 1000);
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) return Math.max(1000, t - Date.now());
    return null;
}

function markAccountFailure(account, status, reason = '', retryAfterRaw = null, fallbackCooldownMs = DEFAULT_ACCOUNT_COOLDOWN_MS) {
    if (!account) return;
    account.failures++;
    if ([401, 403, 429].includes(Number(status))) {
        // On 429, honor a valid Retry-After header (seconds or HTTP-date) when present;
        // otherwise fall back to the fixed env-configured cooldown.
        const retryMs = Number(status) === 429 ? parseRetryAfterMs(retryAfterRaw) : null;
        const cooldownMs = retryMs != null ? retryMs : fallbackCooldownMs;
        account.cooldownUntil = Date.now() + cooldownMs;
        console.log(`[account:${account.id}] cooldown for ${Math.round(cooldownMs / 1000)}s after HTTP ${status}${reason ? ` (${reason})` : ''}${retryMs != null ? ' (Retry-After)' : ''}`);
    }
}

function hasOtherReadyAccount(accountId, now = Date.now()) {
    return accounts.some(a => a.id !== accountId && a.config.token && a.config.cookie && a.cooldownUntil <= now);
}

// Errors after which the same request can be replayed on another account.
function isAccountLevelError(error) {
    return [401, 403, 429].includes(Number(error?.status));
}

async function readDeepSeekJsonResponse(resp, label, account) {
    const text = await resp.text();
    let json = null;
    if (text) {
        try { json = JSON.parse(text); }
        catch (e) {
            markAccountFailure(account, resp.status, label);
            throw new Error(`DeepSeek returned non-JSON ${label} response (HTTP ${resp.status}). Run npm run doctor. First chars: ${text.substring(0, 120)}`);
        }
    }
    if (!resp.ok) markAccountFailure(account, resp.status, label);
    return { json, text };
}

// DeepSeek answers "too many messages" with HTTP 400 (not 429). Recreating the
// chat would only burn another request: cool this account down briefly so the
// caller can fail over or return 429. Auth failures keep their own handling.
function throwIfRateLimited(account, status, errText, retryAfter) {
    const { isRateLimitError, createUpstreamHttpError } = require('../deepseek/client');
    if ([401, 403, 429].includes(Number(status)) || !isRateLimitError(errText)) return;
    markAccountFailure(account, 429, 'rate limited', retryAfter, RATE_LIMIT_COOLDOWN_MS);
    throw createUpstreamHttpError(429, errText, retryAfter || String(Math.ceil(RATE_LIMIT_COOLDOWN_MS / 1000)));
}

module.exports = {
    ROOT_DIR,
    DS_CONFIG_PATH,
    DEFAULT_ACCOUNT_COOLDOWN_MS,
    RATE_LIMIT_COOLDOWN_MS,
    DS_CLIENT_VERSION,
    get DS_CONFIG() { return DS_CONFIG; },
    get dsHeaders() { return dsHeaders; },
    accounts,
    buildBaseHeaders,
    discoverAuthPaths,
    loadDeepSeekConfig,
    hasAuthConfig,
    accountStatus,
    selectAccountForSession,
    parseRetryAfterMs,
    markAccountFailure,
    hasOtherReadyAccount,
    isAccountLevelError,
    readDeepSeekJsonResponse,
    throwIfRateLimited,
};
