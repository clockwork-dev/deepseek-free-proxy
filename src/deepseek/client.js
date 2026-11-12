const pow = require('../../lib/pow');
const {
    selectAccountForSession,
    markAccountFailure,
    hasOtherReadyAccount,
    isAccountLevelError,
    readDeepSeekJsonResponse,
    throwIfRateLimited,
    RATE_LIMIT_COOLDOWN_MS,
} = require('../accounts/pool');
const {
    IMAGE_UPLOAD_ENABLED,
    uploadImagesForAccount,
} = require('./multimodal');
const {
    getOrCreateAgentSession,
    resetRemoteSession,
    prepareSessionForPrompt,
} = require('../sessions/manager');

function envNumber(name, fallback, min = 0) {
    const val = Number(process.env[name]);
    return Number.isFinite(val) && val >= min ? val : fallback;
}

const DS_FETCH_TIMEOUT_MS = envNumber('DEEPSEEK_FETCH_TIMEOUT_MS', 60000, 1000);
const DS_STREAM_IDLE_TIMEOUT_MS = envNumber('DEEPSEEK_STREAM_IDLE_TIMEOUT_MS', DS_FETCH_TIMEOUT_MS, 500);
const DS_STREAM_MAX_MS = envNumber('DEEPSEEK_STREAM_MAX_MS', 10 * 60 * 1000, 1000);
const STREAM_KEEPALIVE_MS = envNumber('DEEPSEEK_STREAM_KEEPALIVE_MS', 10000, 1000);

const COMPLETION_PATH = '/api/v0/chat/completion';

function getDsBaseUrl() {
    return String(process.env.DEEPSEEK_BASE_URL || 'https://chat.deepseek.com');
}

function dsUrl(pathname) {
    return `${getDsBaseUrl()}${pathname}`;
}

function timeoutError(message) {
    const error = new Error(message);
    error.name = 'TimeoutError';
    return error;
}

// Makes `controller` follow an outer signal (the inbound request being
// cancelled). Works on Node 18, which lacks AbortSignal.any.
function followSignal(controller, signal) {
    if (!signal) return;
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw signal.reason || new Error('request aborted');
}

function sleepWithSignal(ms, signal) {
    return new Promise((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(signal.reason || new Error('request aborted')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

// Short JSON request (PoW, session create): bounded by DS_FETCH_TIMEOUT_MS
// including the body, and cancelled together with the inbound request.
function dsFetch(url, options = {}, timeoutMs = DS_FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    followSignal(controller, options.signal);
    followSignal(controller, AbortSignal.timeout(timeoutMs));
    return fetch(url, { ...options, signal: controller.signal });
}

// Starts a streaming completion request. The returned controller lets the SSE
// reader enforce an idle timeout; options.signal (the inbound request) cancels
// the upstream generation when the client disconnects.
async function dsFetchStream(url, options = {}) {
    const controller = new AbortController();
    followSignal(controller, options.signal);
    const connectTimer = setTimeout(() => controller.abort(timeoutError(`DeepSeek did not respond within ${DS_FETCH_TIMEOUT_MS}ms`)), DS_FETCH_TIMEOUT_MS);
    try {
        const resp = await fetch(url, { ...options, signal: controller.signal });
        resp.abortController = controller;
        return resp;
    } finally {
        clearTimeout(connectTimer);
    }
}

// Reads a (non-streaming) error body without trusting the upstream to finish
// it: a stalled body must not pin the request, its session lock and its
// concurrency slot forever.
async function readUpstreamText(resp, timeoutMs = DS_FETCH_TIMEOUT_MS) {
    const timer = setTimeout(() => resp.abortController?.abort(timeoutError(`DeepSeek error body not received within ${timeoutMs}ms`)), timeoutMs);
    try {
        return await resp.text();
    } catch (error) {
        return '';
    } finally {
        clearTimeout(timer);
    }
}

// Iterates a response body, aborting it after DS_STREAM_IDLE_TIMEOUT_MS without
// data or DS_STREAM_MAX_MS overall.
async function* readStreamWithTimeouts(resp) {
    const controller = resp.abortController;
    const body = resp.body;
    if (!body) return;
    if (!controller) { yield* body; return; }
    let idleTimer = null;
    const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(timeoutError(`DeepSeek stream was idle for ${DS_STREAM_IDLE_TIMEOUT_MS}ms`)), DS_STREAM_IDLE_TIMEOUT_MS);
    };
    const maxTimer = setTimeout(() => controller.abort(timeoutError(`DeepSeek stream exceeded ${DS_STREAM_MAX_MS}ms`)), DS_STREAM_MAX_MS);
    armIdle();
    try {
        for await (const chunk of body) {
            armIdle();
            yield chunk;
        }
    } catch (error) {
        throw controller.signal.aborted && controller.signal.reason ? controller.signal.reason : error;
    } finally {
        clearTimeout(idleTimer);
        clearTimeout(maxTimer);
    }
}

const DEEPSEEK_MODEL_TYPE = String(process.env.DEEPSEEK_MODEL_TYPE ?? 'default').trim();
const UNIFIED_REAL_MODEL = 'DeepSeek-V4.1-Flash (DeepSeek Web unified mode)';

function unifiedModel({ thinking = false, search = false, legacy = null } = {}) {
    let realModel = UNIFIED_REAL_MODEL;
    if (thinking) realModel += ' + DeepThink';
    if (search) realModel += ' + web search';
    if (legacy) realModel += `; legacy alias: ${legacy}`;
    return {
        model_type: DEEPSEEK_MODEL_TYPE,
        thinking_enabled: thinking,
        search_enabled: search,
        real_model: realModel,
        capabilities: { reasoning: thinking, web_search: search, files: true },
        supported: true,
        deprecated: Boolean(legacy),
    };
}

const MODEL_CONFIGS = {
    'deepseek-chat': unifiedModel(),
    'deepseek-default': unifiedModel(),
    'deepseek-v4-flash': unifiedModel(),
    'deepseek-v4.1-flash': unifiedModel(),
    'deepseek-v3': unifiedModel({ legacy: 'V3 is no longer served by DeepSeek Web' }),
    'deepseek-reasoner': unifiedModel({ thinking: true }),
    'deepseek-r1': unifiedModel({ thinking: true, legacy: 'R1-compatible name for DeepThink' }),
    'deepseek-chat-search': unifiedModel({ search: true }),
    'deepseek-default-search': unifiedModel({ search: true }),
    'deepseek-reasoner-search': unifiedModel({ thinking: true, search: true }),
    'deepseek-r1-search': unifiedModel({ thinking: true, search: true, legacy: 'R1-compatible name for DeepThink' }),
    'deepseek-expert': unifiedModel({ thinking: true, legacy: 'Expert mode was merged into the unified mode' }),
    'deepseek-v4-pro': unifiedModel({ thinking: true, legacy: 'V4 Pro was retired; served by V4.1 Flash' }),
    'deepseek-expert-search': unifiedModel({ thinking: true, search: true, legacy: 'Expert mode was merged into the unified mode' }),
    'deepseek-vision': {
        ...unifiedModel({ legacy: 'Vision mode was merged into the unified mode' }),
        capabilities: { reasoning: false, web_search: false, files: true, vision: true },
        supported: IMAGE_UPLOAD_ENABLED,
        unavailable_reason: IMAGE_UPLOAD_ENABLED
            ? undefined
            : 'Image upload is disabled. Set DEEPSEEK_IMAGE_UPLOAD=1 to send images to the DeepSeek Web unified mode.',
    },
};

const SUPPORTED_MODEL_IDS = Object.keys(MODEL_CONFIGS).filter(id => MODEL_CONFIGS[id].supported);
const ALL_MODEL_CAPABILITIES = Object.fromEntries(Object.entries(MODEL_CONFIGS).map(([id, cfg]) => [id, {
    id,
    real_model: cfg.real_model,
    model_type: cfg.model_type,
    thinking_enabled: cfg.thinking_enabled,
    search_enabled: cfg.search_enabled,
    capabilities: cfg.capabilities,
    supported: cfg.supported,
    deprecated: cfg.deprecated === true,
    unavailable_reason: cfg.unavailable_reason || null,
}]));

function resolveModelConfig(model) {
    const requested = String(model || 'deepseek-chat').toLowerCase();
    return MODEL_CONFIGS[requested] || MODEL_CONFIGS['deepseek-chat'];
}
function isKnownModel(model) { return Object.prototype.hasOwnProperty.call(MODEL_CONFIGS, String(model || '').toLowerCase()); }
function isSupportedModel(model) { return resolveModelConfig(model).supported === true; }

function isAssistantOutputFragment(fragment) {
    return fragment
        && (fragment.type === 'RESPONSE' || fragment.type === 'SEARCH')
        && typeof fragment.content === 'string';
}

function isReasoningFragment(fragment) {
    return fragment
        && (fragment.type === 'THINK' || fragment.type === 'REASONING')
        && typeof fragment.content === 'string';
}

function isDeepSeekModelErrorEvent(event) {
    return event && event.type === 'error';
}

function createUpstreamHttpError(status, body = '', retryAfter = null) {
    const code = Number(status) || 502;
    const detail = String(body || '').replace(/\s+/g, ' ').trim().substring(0, 300);
    const type = code === 429
        ? 'rate_limit_error'
        : ((code === 401 || code === 403) ? 'authentication_error' : 'upstream_http_error');
    const error = new Error(`DeepSeek upstream HTTP ${code}${detail ? `: ${detail}` : ''}`);
    error.status = code;
    error.type = type;
    if (retryAfter) error.retryAfter = retryAfter;
    return error;
}

function rebuildFragmentText(fragments) {
    const responseText = fragments
        .filter(isAssistantOutputFragment)
        .map(f => f.content)
        .join('');
    const thinkText = fragments
        .filter(isReasoningFragment)
        .map(f => f.content)
        .join('');
    return { responseText, thinkText };
}

function applyResponsePatchOperations(ops, appendFragments) {
    if (!Array.isArray(ops)) return false;
    let applied = false;
    for (const op of ops) {
        if (!op || typeof op !== 'object') continue;
        if (op.p === 'fragments' && op.o === 'APPEND' && op.v !== undefined) {
            appendFragments(op.v);
            applied = true;
        }
    }
    return applied;
}

async function createPowHeader(account, signal, targetPath = COMPLETION_PATH) {
    const cr = await dsFetch(dsUrl('/api/v0/chat/create_pow_challenge'), {
        method: 'POST', headers: account.headers, signal,
        body: JSON.stringify({ target_path: targetPath })
    });
    const chalText = await cr.text();
    if (!cr.ok) {
        markAccountFailure(account, cr.status, 'pow challenge', cr.headers.get('retry-after'));
        const error = createUpstreamHttpError(cr.status, chalText, cr.headers.get('retry-after'));
        error.message = `DeepSeek auth/network error while creating PoW challenge: HTTP ${cr.status}. Run npm run doctor. If auth expired, run npm run auth or npm run auth:import.`;
        throw error;
    }
    let chalJson;
    try { chalJson = JSON.parse(chalText); }
    catch (e) { throw new Error(`DeepSeek returned non-JSON PoW response. Run npm run doctor. First chars: ${chalText.substring(0, 120)}`); }
    const challenge = chalJson?.data?.biz_data?.challenge;
    if (!challenge) {
        throw new Error('DeepSeek PoW response has no data.biz_data.challenge. Auth may be expired, captcha may be required, or DeepSeek changed Web API. Run npm run doctor, then npm run auth.');
    }
    const answer = await pow.solvePOW(challenge, account.config.wasmUrl);
    return Buffer.from(JSON.stringify({
        algorithm: challenge.algorithm, challenge: challenge.challenge,
        salt: challenge.salt, answer: answer,
        signature: challenge.signature, target_path: targetPath
    })).toString('base64');
}

async function createRemoteChat(session, account, agentTag, label = 'session create', signal) {
    const sr = await dsFetch(dsUrl('/api/v0/chat_session/create'), {
        method: 'POST', headers: account.headers, body: '{}', signal,
    });
    const { json: sessionData, text: sessionText } = await readDeepSeekJsonResponse(sr, label, account);
    const createdSessionId = sessionData?.data?.biz_data?.chat_session?.id || sessionData?.data?.biz_data?.id;
    if (!sr.ok || !createdSessionId) {
        const error = sr.ok ? new Error('') : createUpstreamHttpError(sr.status, sessionText, sr.headers.get('retry-after'));
        error.message = `Could not create DeepSeek chat session (HTTP ${sr.status}). Auth may be expired/captcha-blocked. Run npm run doctor, then npm run auth. First chars: ${String(sessionText || '').substring(0, 120)}`;
        throw error;
    }
    session.id = createdSessionId;
    session.accountId = account.id;
    session.parentMessageId = null;
    session.createdAt = Date.now();
    session.messageCount = 0;
    session.sentMessageKeys = [];
    session.contextKey = null;
    session.remoteChars = 0;
    console.log(`${agentTag} Created new session: ${session.id}`);
}

async function postCompletion(session, account, modelCfg, promptText, signal, refFileIds = []) {
    const powB64 = await createPowHeader(account, signal);
    throwIfAborted(signal);
    const payload = {
        chat_session_id: session.id,
        parent_message_id: session.parentMessageId,
        prompt: promptText, ref_file_ids: refFileIds,
        thinking_enabled: modelCfg.thinking_enabled, search_enabled: modelCfg.search_enabled,
        action: null, preempt: false,
    };
    if (modelCfg.model_type) payload.model_type = modelCfg.model_type;
    return dsFetchStream(dsUrl('/api/v0/chat/completion'), {
        method: 'POST',
        headers: { ...account.headers, 'X-DS-PoW-Response': powB64 },
        body: JSON.stringify(payload),
        signal,
    });
}

async function askDeepSeekStream(prompt, agentId, model = 'deepseek-default', freshSessionPrompt = prompt, session = getOrCreateAgentSession(agentId), signal = null, attachments = null) {
    const modelCfg = resolveModelConfig(model);
    const hadRemoteSession = Boolean(session.id);
    const account = selectAccountForSession(session);
    account.lastUsedAt = Date.now();
    const agentTag = `[${agentId}/acct:${account.id}]`;

    // Normally this rollover is performed before the prompt is built, so local
    // recovery history can be injected. Keep this guard for direct callers and
    // concurrent requests that may have advanced the same session meanwhile.
    const rollover = prepareSessionForPrompt(session);
    const accountRotationReset = hadRemoteSession && !session.id && !rollover;
    // A brand-new remote chat has no memory of earlier turns, so it always
    // receives the self-contained prompt.
    const startsFreshChat = !session.id;
    let effectivePrompt = startsFreshChat ? freshSessionPrompt : prompt;
    if (accountRotationReset) {
        console.log(`${agentTag} Account rotation reset the previous remote session; using recovery prompt.`);
    }
    if (rollover) {
        console.log(`${agentTag} Session ${rollover.failedSessionId} reset before upstream call (${rollover.reason}).`);
    }

    // Upload images first: a failed upload must not leave an empty chat.
    const images = attachments ? (startsFreshChat ? attachments.full : attachments.delta) : [];
    const refFileIds = await uploadImagesForAccount(account, images, signal, agentTag, attachments?.deadlineAt);

    if (!session.id) {
        await createRemoteChat(session, account, agentTag, 'session create', signal);
    } else {
        console.log(`${agentTag} Reusing session: ${session.id} (parent: ${session.parentMessageId}, msg#${session.messageCount})`);
    }

    const resp = await postCompletion(session, account, modelCfg, effectivePrompt, signal, refFileIds);

    if (resp.status !== 200) {
        // Pass Retry-After so a 429 honors the server-requested cooldown (#16).
        const retryAfter = resp.headers.get('retry-after');
        markAccountFailure(account, resp.status, 'completion', retryAfter);
        const errText = await readUpstreamText(resp);
        throwIfAborted(signal);
        console.log(`${agentTag} Session error (${resp.status}): ${errText.substring(0, 100)}`);
        throwIfRateLimited(account, resp.status, errText, retryAfter);
        // The remote chat may have expired or overflowed: start a new one with
        // the full prompt once. Auth and rate-limit statuses are surfaced as is.
        if (resp.status === 400 || resp.status === 404 || resp.status === 500) {
            console.log(`${agentTag} Session ${session.id} expired. Creating new session...`);
            resetRemoteSession(session);
            await createRemoteChat(session, account, agentTag, 'session recreate', signal);
            effectivePrompt = freshSessionPrompt;
            const fullRefFileIds = attachments
                ? await uploadImagesForAccount(account, attachments.full, signal, agentTag, attachments.deadlineAt)
                : [];
            const resp2 = await postCompletion(session, account, modelCfg, effectivePrompt, signal, fullRefFileIds);
            if (!resp2.ok) {
                const retryAfter2 = resp2.headers.get('retry-after');
                markAccountFailure(account, resp2.status, 'completion after session recreate', retryAfter2);
                const errText2 = await readUpstreamText(resp2);
                resetRemoteSession(session);
                throwIfAborted(signal);
                throwIfRateLimited(account, resp2.status, errText2, retryAfter2);
                throw createUpstreamHttpError(resp2.status, errText2, retryAfter2);
            }
            session.remoteChars += effectivePrompt.length;
            return { resp: resp2, agentId, account, promptUsed: effectivePrompt, freshSessionReset: true };
        }
        // The body was consumed for diagnostics, so returning this Response
        // would hand a locked stream to readDeepSeekResponse. Surface a typed
        // error instead and retain the real upstream status/Retry-After.
        throw createUpstreamHttpError(resp.status, errText, retryAfter);
    }

    session.remoteChars += effectivePrompt.length;
    return { resp, agentId, account, promptUsed: effectivePrompt, freshSessionReset: startsFreshChat };
}

// Reads the DeepSeek SSE stream — returns { content, reasoningContent, messageId, finishReason, modelError }
async function readDeepSeekResponse(call, onProgress = null, session = null) {
    let buffer = '';
    let lastPath = null;
    const fragments = [];
    let fullContent = '';
    let reasoningContent = '';
    let newMessageId = null;
    let finishReason = null;
    let responseStatus = null;
    let modelError = null;

    const rebuildFragmentState = () => {
        const { responseText, thinkText } = rebuildFragmentText(fragments);
        if (responseText) fullContent = responseText;
        reasoningContent = thinkText;
    };

    const appendFragments = (value) => {
        const incoming = Array.isArray(value) ? value : [value];
        for (const fragment of incoming) {
            if (fragment && typeof fragment === 'object') fragments.push({ ...fragment });
        }
        rebuildFragmentState();
    };

    const handleLine = (rawLine) => {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trimStart();
        if (!payload || payload === '[DONE]') return;
        let d;
        try { d = JSON.parse(payload); } catch (e) { return; }
        if (!d || typeof d !== 'object') return;
        if (d.response_message_id !== undefined && !newMessageId) newMessageId = d.response_message_id;
        if (isDeepSeekModelErrorEvent(d)) {
            modelError = { type: d.type || 'error', content: d.content || '', finish_reason: d.finish_reason || null };
        }
        if (d.finish_reason) {
            finishReason = d.finish_reason;
        }
        if (d.p !== undefined) lastPath = d.p;
        if (d.v && typeof d.v === 'object' && d.v.response) {
            if (d.v.response.message_id !== undefined) {
                newMessageId = d.v.response.message_id;
            }
            if (d.v.response.content !== undefined) {
                fullContent = d.v.response.content;
            }
            if (Array.isArray(d.v.response.fragments)) {
                fragments.length = 0;
                appendFragments(d.v.response.fragments);
            }
            if (d.v.response.finish_reason !== undefined) {
                finishReason = d.v.response.finish_reason;
            }
            if (typeof d.v.response.status === 'string') responseStatus = d.v.response.status;
        }
        if (lastPath === 'response/fragments' && d.v !== undefined) {
            appendFragments(d.v);
        }
        if (lastPath === 'response' && d.v !== undefined) {
            applyResponsePatchOperations(d.v, appendFragments);
        }
        if (lastPath === 'response/fragments/-1/content' && d.v !== undefined && typeof d.v !== 'object') {
            if (fragments.length > 0) {
                const lastFragment = fragments[fragments.length - 1];
                lastFragment.content = `${lastFragment.content || ''}${d.v}`;
                rebuildFragmentState();
            }
        }
        if (lastPath === 'response/content' && d.v !== undefined && typeof d.v !== 'object') {
            fullContent += d.v;
        }
        if (lastPath === 'response/finish_reason' && d.v !== undefined) {
            finishReason = d.v;
        }
        if (lastPath === 'response/status' && typeof d.v === 'string') {
            responseStatus = d.v;
        }
    };

    const decoder = new TextDecoder();  // one instance: preserves multi-byte (Cyrillic/emoji) split across chunks
    for await (const chunk of readStreamWithTimeouts(call.resp)) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) handleLine(line);
        if (onProgress) onProgress(fullContent, reasoningContent);
    }
    buffer += decoder.decode();
    if (buffer) handleLine(buffer);
    if (onProgress) onProgress(fullContent, reasoningContent);

    // DeepSeek marks an answer cut off at its output limit as
    // INCOMPLETE; expose it as 'length' so continuation kicks in.
    if (!finishReason && /^INCOMPLETE$/i.test(String(responseStatus || ''))) finishReason = 'length';

    if (session) {
        if (newMessageId) {
            session.parentMessageId = newMessageId;
            session.messageCount++;
        } else {
            console.log(`[${call.agentId || 'session'}] WARNING: could not extract message_id`);
        }
        session.remoteChars = (session.remoteChars || 0) + fullContent.length + reasoningContent.length;
    }

    if (fullContent.trim() && isRateLimitError(modelError)) {
        const retryAfter = String(Math.ceil(RATE_LIMIT_COOLDOWN_MS / 1000));
        markAccountFailure(call.account, 429, 'rate limited in stream', retryAfter, RATE_LIMIT_COOLDOWN_MS);
        throw createUpstreamHttpError(429, modelError.content, retryAfter);
    }

    return { content: fullContent, reasoningContent, messageId: newMessageId, finishReason, modelError };
}

function isContinuationRecoverySafe(previousAccountId, continuationCall) {
    const nextAccountId = continuationCall?.account?.id;
    return !previousAccountId
        || !nextAccountId
        || nextAccountId === previousAccountId
        || continuationCall?.freshSessionReset === true;
}

function isContextTooLongError(error) {
    const message = typeof error === 'string'
        ? error
        : `${error?.content || ''} ${error?.message || ''} ${error?.finish_reason || ''} ${error?.type || ''}`;
    return /(?:content|prompt|context).{0,40}(?:too\s+long|too\s+large|length|limit|maximum)|maximum.{0,30}(?:context|token)|too\s+many\s+tokens|содержани[ея]\s+слишком\s+длин|контекст.{0,30}(?:длин|лимит)|内容.{0,12}(?:过长|太长)|上下文.{0,12}(?:过长|超出)/i.test(message);
}

function normalizeRetryResponse(result) {
    const { sanitizeContent } = require('../utils/streaming');
    return {
        content: result?.content ? sanitizeContent(result.content) : '',
        reasoningContent: result?.reasoningContent ? sanitizeContent(result.reasoningContent) : '',
        finishReason: result?.finishReason ?? null,
        modelError: result?.modelError || null,
    };
}

function isRateLimitError(error) {
    const message = typeof error === 'string'
        ? error
        : `${error?.content || ''} ${error?.message || ''} ${error?.type || ''}`;
    return /too\s+many\s+(?:messages|requests)|rate[\s_-]?limit|过于频繁|слишком\s+(?:много\s+(?:сообщений|запросов)|частые\s+сообщения)/i.test(message);
}

function classifyRecoveryFailure(modelError, timedOut = false) {
    if (isContextTooLongError(modelError)) return { status: 400, type: 'context_length_exceeded' };
    if (isRateLimitError(modelError)) return { status: 429, type: 'rate_limit_error' };
    if (timedOut) return { status: 504, type: 'request_timeout' };
    return { status: 502, type: modelError?.type || 'empty_response' };
}

function isTimeoutError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || '');
    return name === 'TimeoutError' || name === 'AbortError' || /(?:timed?\s*out|timeout)/i.test(message);
}

module.exports = {
    getDsBaseUrl,
    dsUrl,
    timeoutError,
    followSignal,
    throwIfAborted,
    sleepWithSignal,
    dsFetch,
    dsFetchStream,
    readUpstreamText,
    readStreamWithTimeouts,
    createPowHeader,
    createRemoteChat,
    postCompletion,
    askDeepSeekStream,
    readDeepSeekResponse,
    isAssistantOutputFragment,
    isReasoningFragment,
    isDeepSeekModelErrorEvent,
    createUpstreamHttpError,
    rebuildFragmentText,
    applyResponsePatchOperations,
    MODEL_CONFIGS,
    SUPPORTED_MODEL_IDS,
    ALL_MODEL_CAPABILITIES,
    resolveModelConfig,
    isKnownModel,
    isSupportedModel,
    isContinuationRecoverySafe,
    isContextTooLongError,
    normalizeRetryResponse,
    isRateLimitError,
    classifyRecoveryFailure,
    isTimeoutError,
    DS_FETCH_TIMEOUT_MS,
    DS_STREAM_IDLE_TIMEOUT_MS,
    DS_STREAM_MAX_MS,
    STREAM_KEEPALIVE_MS,
    COMPLETION_PATH,
};
