const { PROXY_API_KEY, isProxyAuthorized } = require('../utils/auth');
const { SUPPORTED_MODEL_IDS, MODEL_CONFIGS } = require('../deepseek/client');
const { accounts, accountStatus, hasAuthConfig } = require('../accounts/pool');
const { sessions, SESSION_TTL_MS, MAX_MESSAGE_DEPTH } = require('../sessions/manager');

function handleHealth(req, res, url, { inFlight = 0 } = {}) {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
        const includePrivateStatus = !PROXY_API_KEY || isProxyAuthorized(req.headers.authorization, PROXY_API_KEY, req.headers['x-api-key']);
        const health = { status: 'ok', service: 'FreeDeepseekAPI' };
        if (includePrivateStatus) Object.assign(health, {
            models: SUPPORTED_MODEL_IDS,
            unsupported_models: Object.keys(MODEL_CONFIGS).filter(id => !MODEL_CONFIGS[id].supported),
            agents: sessions.size,
            in_flight: inFlight,
            accounts: accounts.map(accountStatus),
            config_ready: hasAuthConfig(),
            session_reuse: { strategy: 'sticky per x-agent-session/user', ttl_minutes: Math.round(SESSION_TTL_MS / 60000), max_messages: MAX_MESSAGE_DEPTH, reset_all: 'POST /reset-session?agent=all' },
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health));
        return true;
    }

    if (req.method === 'GET' && url.pathname === '/readyz') {
        const now = Date.now();
        const ready = accounts.filter(a => a.config.token && a.config.cookie && a.cooldownUntil <= now).length;
        res.writeHead(ready > 0 ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ready: ready > 0, ready_accounts: ready, total_accounts: accounts.length }));
        return true;
    }

    return false;
}

module.exports = {
    handleHealth,
};
