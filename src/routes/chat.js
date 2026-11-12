const events = require('events');
const {
    accounts,
    hasOtherReadyAccount,
    isAccountLevelError,
    markAccountFailure,
    RATE_LIMIT_COOLDOWN_MS,
} = require('../accounts/pool');
const {
    sessions,
    createSession,
    getOrCreateAgentSession,
    resetRemoteSession,
    prepareSessionForPrompt,
    storeHistory,
} = require('../sessions/manager');
const {
    IMAGE_UPLOAD_ENABLED,
    collectImages,
    normalizeMessageContent,
    extractScreenshotPaths,
} = require('../deepseek/multimodal');
const {
    askDeepSeekStream,
    readDeepSeekResponse,
    isKnownModel,
    isSupportedModel,
    resolveModelConfig,
    SUPPORTED_MODEL_IDS,
    createUpstreamHttpError,
    isContextTooLongError,
    normalizeRetryResponse,
    isRateLimitError,
    classifyRecoveryFailure,
    isTimeoutError,
    isContinuationRecoverySafe,
    STREAM_KEEPALIVE_MS,
    throwIfAborted,
} = require('../deepseek/client');
const {
    formatMessages,
    buildBoundedPrompt,
    buildRetryPrompt,
    appendPromptInstruction,
    hashText,
    hasExplicitConversationHistory,
    buildRecoveryHistoryPrefix,
    planSessionTurn,
    buildDeltaPrompt,
    MIN_UPSTREAM_PROMPT_CHARS,
    MAX_UPSTREAM_PROMPT_CHARS,
} = require('../deepseek/prompt');
const {
    parseToolCall,
    looksLikeToolCallMarkup,
    TOOL_CALL_FORMAT,
} = require('../tools/parser');
const {
    normalizeApiParams,
    sendJsonError,
    createStreamWriter,
    buildTextResponse,
    buildToolCallResponse,
    estimateTokens,
    sanitizeContent,
    sendCompletion,
} = require('../utils/streaming');
const {
    markContextCompacted,
} = require('../utils/auth');

function envNumber(name, fallback, min = 0) {
    const val = Number(process.env[name]);
    return Number.isFinite(val) && val >= min ? val : fallback;
}

const REQUEST_DEADLINE_MS = Number(process.env.DEEPSEEK_REQUEST_DEADLINE_MS || 120000);
const MAX_CONCURRENT = Number(process.env.DEEPSEEK_MAX_CONCURRENT || 24);
const configuredEmptyRetries = Number(process.env.DEEPSEEK_MAX_RETRIES);
const MAX_EMPTY_RETRIES = Number.isFinite(configuredEmptyRetries)
    ? Math.max(0, Math.min(10, Math.floor(configuredEmptyRetries)))
    : 2;

function handleChat(req, res, url, state = {}) {
    const apiMode = url.pathname === '/v1/messages'
        ? 'anthropic'
        : (url.pathname === '/v1/responses' ? 'responses' : 'openai');
    const acceptedPostPaths = ['/v1/chat/completions', '/v1/messages', '/v1/responses'];
    if (req.method !== 'POST' || !acceptedPostPaths.includes(url.pathname)) {
        res.writeHead(404); res.end('Not found'); return true;
    }

    const inFlight = state.inFlight || 0;
    // Backpressure: reject rather than fan out unbounded concurrent upstream work.
    if (inFlight >= MAX_CONCURRENT) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' });
        res.end(JSON.stringify({ error: { message: `Server busy (${inFlight}/${MAX_CONCURRENT} requests in flight). Retry shortly.`, type: 'overloaded' } }));
        return true;
    }

    const MAX_BODY_BYTES = 10 * 1024 * 1024;  // chat payloads are small; cap memory before JSON.parse
    // Collect raw bytes and decode once: decoding chunk by chunk corrupts any
    // multi-byte character (Cyrillic, CJK, emoji) split across TCP chunks.
    const bodyChunks = [];
    let bodyBytes = 0;
    let bodyTooLarge = false;
    req.on('data', chunk => {
        if (bodyTooLarge) return;
        bodyBytes += chunk.length;
        if (bodyBytes > MAX_BODY_BYTES) {
            bodyTooLarge = true;
            bodyChunks.length = 0;
            sendJsonError(res, 413, 'Request body too large', 'payload_too_large', {}, { 'Connection': 'close' });
            return;
        }
        bodyChunks.push(chunk);
    });
    req.on('end', async () => {
        if (bodyTooLarge) return;
        const body = Buffer.concat(bodyChunks).toString('utf8');
        if (state.incrementInFlight) state.incrementInFlight();
        let clientGone = false;
        // Cancels every upstream call of this request (PoW, chat creation,
        // the answer stream) once nobody is waiting for the result.
        const requestAbort = new AbortController();
        // Every upstream call of this request listens to this signal; retries
        // can exceed the default EventTarget listener warning threshold.
        events.setMaxListeners(0, requestAbort.signal);
        res.on('close', () => {
            if (res.writableFinished) return;
            clientGone = true;
            requestAbort.abort(new Error('client disconnected'));
        });
        const requestStartedAt = Date.now();
        const deadlineHit = () => Date.now() - requestStartedAt > REQUEST_DEADLINE_MS;
        let activeSession = null;
        let activeAgentId = null;
        let lockedSession = null;
        let live = null;
        let keepAliveTimer = null;
        // Error response in the client's protocol: a JSON error while nothing
        // was streamed, an in-stream error event once the stream has started.
        const respondError = (status, error, headers = {}) => {
            if (live) { live.fail(status, error, headers); return; }
            if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
            res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
            res.end(JSON.stringify({ error }));
        };
        // Set once DeepSeek accepted a completion in this request; only then
        // can the remote chat contain turns the client does not know about.
        let remoteTouched = false;
        try {
            let rawParams;
            try { rawParams = JSON.parse(body || '{}'); }
            catch (e) {
                sendJsonError(res, 400, `Request body is not valid JSON: ${e.message}`, 'invalid_request_error');
                return;
            }
            if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
                sendJsonError(res, 400, 'Request body must be a JSON object', 'invalid_request_error');
                return;
            }
            const params = normalizeApiParams(rawParams, apiMode, normalizeMessageContent);
            const messages = Array.isArray(params.messages)
                ? params.messages.filter(m => m && typeof m === 'object')
                : [];
            if (messages.length === 0) {
                sendJsonError(res, 400, 'messages must be a non-empty array', 'invalid_request_error');
                return;
            }
            const tools = Array.isArray(params.tools) ? params.tools : [];
            const stream = params.stream === true;
            const requestedModel = String(params.model || 'deepseek-chat').toLowerCase();
            if (!isKnownModel(requestedModel)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `Unknown model: ${requestedModel}`, type: 'invalid_model', supported_models: SUPPORTED_MODEL_IDS, model_capabilities_url: '/v1/model-capabilities' } }));
                return;
            }
            if (!isSupportedModel(requestedModel)) {
                const cfg = resolveModelConfig(requestedModel);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `${requestedModel} is not currently supported through this DeepSeek Web API path`, type: 'unsupported_model', model: requestedModel, real_model: cfg.real_model, reason: cfg.unavailable_reason, capabilities: cfg.capabilities, supported_models: SUPPORTED_MODEL_IDS } }));
                return;
            }
            // Use remote IP for session isolation (local gets 'dev-agent', external per-IP)
            const remoteAddr = req.socket.remoteAddress || 'unknown';
            const requestedSession = req.headers['x-agent-session'] || params.session || params.user;
            const agentId = requestedSession
                ? String(requestedSession)
                : ((remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1') ? 'dev-agent' : remoteAddr);
            const agentTag = `[${agentId}]`;
            activeAgentId = agentId;

            // "/new" command: if the latest user message is exactly "/new" (whitespace-insensitive),
            // reset this agent's DeepSeek session/history instead of forwarding anything to DeepSeek.
            const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
            const lastUserText = lastUserMessage ? normalizeMessageContent(lastUserMessage.content).trim() : '';
            if (lastUserText === '/new') {
                const existing = sessions.get(agentId);
                const historyCount = existing ? existing.history.length : 0;
                sessions.set(agentId, createSession());
                console.log(`${agentTag} /new received — session reset (history cleared: ${historyCount})`);
                const confirmation = buildTextResponse('Started a new chat. Session and history have been reset.', '/new', requestedModel);
                sendCompletion(res, apiMode, stream, confirmation);
                return;
            }

            const { prompt, systemPrompt, toolReminder } = formatMessages(messages, tools);
            // For usage accounting, count the CLIENT's original input — not the
            // proxy-expanded fullPrompt (system + injected tools + history) — so
            // prompt_tokens reflects what the caller actually sent.
            const clientPromptText = messages.map(m => normalizeMessageContent(m.content)).join('\n');
            const allowedToolNames = new Set(tools
                .filter(tool => tool?.type === 'function' && tool.function?.name)
                .map(tool => tool.function.name));

            // stream=true: plain answers go to the client while DeepSeek is
            // still writing them. With tools the answer may turn out to be a
            // tool call, so it is buffered and only keep-alives are sent.
            if (stream) {
                live = createStreamWriter(res, apiMode, { model: requestedModel, promptTokens: estimateTokens(clientPromptText) });
                keepAliveTimer = setInterval(() => {
                    if (Date.now() - Math.max(requestStartedAt, live.lastWriteAt) >= STREAM_KEEPALIVE_MS) live.keepAlive();
                }, 1000);
                keepAliveTimer.unref();
            }
            const liveProgress = () => {
                if (!live || allowedToolNames.size > 0) return null;
                const pushReasoning = live.source('reasoning');
                const pushContent = live.source('content');
                return (content, reasoning) => { pushReasoning(reasoning); pushContent(content); };
            };

            // One DeepSeek chat generates one answer at a time, and a second
            // turn sent meanwhile would land on the wrong parent message. The
            // first request owns the agent's chat; overlapping requests (e.g.
            // Hermes background reviews from the same host) run in a private,
            // throwaway chat instead of corrupting it (#23).
            const agentSession = getOrCreateAgentSession(agentId);
            const ephemeral = agentSession.busy === true;
            const session = ephemeral ? createSession() : agentSession;
            if (ephemeral) {
                console.log(`${agentTag} Agent session is busy; serving this concurrent request in a separate DeepSeek chat.`);
            } else {
                agentSession.busy = true;
                lockedSession = agentSession;
            }
            activeSession = session;

            // Roll over TTL/depth/size-limited sessions before deciding what to
            // send, so a replacement chat receives the complete prompt.
            const promptRollover = prepareSessionForPrompt(session);
            if (promptRollover) {
                console.log(`${agentTag} Session ${promptRollover.failedSessionId} reset before prompt build (${promptRollover.reason}); recovery history preserved.`);
            }

            // Clients that send only their latest message rely on local
            // recovery history whenever a new remote chat has to be started.
            const recoveryHistoryPrefix = hasExplicitConversationHistory(messages)
                ? ''
                : buildRecoveryHistoryPrefix(agentSession.history);
            const freshPromptBuild = buildBoundedPrompt(systemPrompt, recoveryHistoryPrefix, prompt);
            const contextKey = hashText(systemPrompt);
            const plan = planSessionTurn(session, messages, contextKey);
            let fullPrompt;
            let promptCompacted;
            if (plan.mode === 'delta') {
                const delta = buildDeltaPrompt(plan.messages, messages, toolReminder, MAX_UPSTREAM_PROMPT_CHARS, plan.includeSystem ? systemPrompt : '');
                fullPrompt = delta.prompt;
                promptCompacted = delta.compacted;
                console.log(`${agentTag} Sending ${plan.messages.length} new message(s) to the existing DeepSeek chat (${fullPrompt.length} chars${delta.compacted ? ', compacted' : ''})`);
            } else {
                if (session.id) {
                    console.log(`${agentTag} Starting a fresh DeepSeek chat: ${plan.reason}.`);
                    resetRemoteSession(session);
                }
                fullPrompt = freshPromptBuild.prompt;
                promptCompacted = freshPromptBuild.compacted;
                if (freshPromptBuild.compacted) {
                    console.log(`${agentTag} Compacted upstream prompt ${freshPromptBuild.originalChars} -> ${freshPromptBuild.promptChars} chars${freshPromptBuild.historyDropped ? ' (recovery history dropped)' : ''}`);
                }
            }
            if (promptCompacted) markContextCompacted(res);

            // Images: the new messages' images go into a reused chat, the
            // conversation's most recent images into a new chat.
            const attachments = IMAGE_UPLOAD_ENABLED ? {
                delta: plan.mode === 'delta' ? collectImages(plan.messages) : [],
                full: collectImages(messages),
                deadlineAt: requestStartedAt + REQUEST_DEADLINE_MS,
            } : null;

            let lastAccount = null;
            // Calls DeepSeek, replaying the request on another account when the
            // current one is rejected (401/403) or throttled (429). A replay
            // always starts a fresh chat, so it gets the self-contained prompt.
            const callDeepSeek = async (promptText, freshPrompt = promptText, callAttachments = attachments) => {
                for (let attempt = 0; ; attempt++) {
                    throwIfAborted(requestAbort.signal);
                    try {
                        const call = await askDeepSeekStream(promptText, agentId, requestedModel, freshPrompt, session, requestAbort.signal, callAttachments);
                        remoteTouched = true;
                        lastAccount = call.account;
                        return call;
                    } catch (error) {
                        const failedAccountId = session.accountId;
                        if (!isAccountLevelError(error) || attempt + 1 >= accounts.length
                            || !hasOtherReadyAccount(failedAccountId) || requestAbort.signal.aborted || deadlineHit()) {
                            throw error;
                        }
                        console.log(`${agentTag} Account ${failedAccountId} failed (HTTP ${error.status}); retrying on another account.`);
                        resetRemoteSession(session);
                        promptText = freshPrompt;
                    }
                }
            };

            const startTime = Date.now();
            let firstResult;
            try {
                const initialCall = await callDeepSeek(fullPrompt, freshPromptBuild.prompt);
                if (initialCall.promptUsed !== fullPrompt) {
                    // The planned delta could not be used (account rotation or
                    // session rollover): the new chat got the full prompt.
                    fullPrompt = initialCall.promptUsed;
                    if (freshPromptBuild.compacted) {
                        promptCompacted = true;
                        markContextCompacted(res);
                    }
                }
                firstResult = await readDeepSeekResponse(initialCall, liveProgress(), session);
            } catch (error) {
                // A remote chat that overflowed is rejected with HTTP 400 even
                // after one fresh-chat attempt. Let the compaction loop below
                // retry with smaller prompts instead of failing immediately.
                if (!isContextTooLongError(error)) throw error;
                console.log(`${agentTag} DeepSeek rejected the prompt as too long; retrying with a compacted prompt.`);
                resetRemoteSession(session);
                firstResult = { content: '', reasoningContent: '', finishReason: null, modelError: { type: 'error', content: error.message } };
            }
            let fullContent = sanitizeContent(firstResult.content || '');
            let reasoningContent = sanitizeContent(firstResult.reasoningContent || '');
            let { finishReason, modelError } = firstResult;
            const elapsed = Date.now() - startTime;
            console.log(`${agentTag} Got ${fullContent.length} chars (+${reasoningContent.length} reasoning chars) in ${elapsed}ms (msg#${session.messageCount})`);

            // Empty/context-overflow/rate-limit recovery. Each retry gets a
            // fresh remote session and, for overflows, a smaller prompt;
            // bounded attempts prevent retry storms.
            let retryAttempt = 0;
            while (!fullContent || fullContent.trim().length === 0) {
                // Stop early if the client hung up or we've blown the request budget —
                // no point burning more PoW solves + account quota for a dead socket.
                if (clientGone) {
                    console.log(`${agentTag} client disconnected; abandoning empty-retry loop`);
                    resetRemoteSession(session);
                    return;
                }
                if (deadlineHit()) { console.log(`${agentTag} request deadline hit; stopping empty-retry loop`); break; }
                const contextTooLong = isContextTooLongError(modelError);
                if (!contextTooLong && isRateLimitError(modelError)) {
                    markAccountFailure(lastAccount, 429, 'rate limited in stream', null, RATE_LIMIT_COOLDOWN_MS);
                    if (!hasOtherReadyAccount(lastAccount?.id)) break;
                } else if (modelError && !contextTooLong) {
                    break;
                }
                if (retryAttempt >= MAX_EMPTY_RETRIES) break;
                retryAttempt++;

                const retryRatio = contextTooLong
                    ? Math.max(0.35, 0.8 - retryAttempt * 0.2)
                    : Math.max(0.5, 1 - retryAttempt * 0.2);
                const retryBudget = Math.max(MIN_UPSTREAM_PROMPT_CHARS, Math.floor(MAX_UPSTREAM_PROMPT_CHARS * retryRatio));
                const retryBuild = buildRetryPrompt(systemPrompt, recoveryHistoryPrefix, prompt, freshPromptBuild.prompt, retryBudget);
                const retryPrompt = retryBuild.prompt;
                if (retryBuild.compacted) {
                    promptCompacted = true;
                    markContextCompacted(res);
                }
                const reason = contextTooLong ? 'context-too-long response' : (modelError ? 'rate-limited response' : 'empty response');
                console.log(`${agentTag} ${reason} (msg#${session.messageCount}, retry ${retryAttempt}/${MAX_EMPTY_RETRIES}, prompt=${retryPrompt.length} chars). Resetting session...`);
                resetRemoteSession(session);
                // Brief delay before retry to let DeepSeek breathe
                await new Promise(r => setTimeout(r, Math.min(500 * retryAttempt, 1500)));
                const retryCall = await callDeepSeek(retryPrompt);
                const retryState = normalizeRetryResponse(await readDeepSeekResponse(retryCall, liveProgress(), session));
                fullPrompt = retryPrompt;
                modelError = retryState.modelError;
                // A previous empty response may have carried finish_reason=length.
                // Never leak it into a successful retry that supplied no reason.
                finishReason = retryState.finishReason;
                if (retryState.content && retryState.content.trim().length > 0) {
                    console.log(`${agentTag} Retry ${retryAttempt} succeeded`);
                    fullContent = retryState.content;
                    reasoningContent = retryState.reasoningContent;
                }
            }

            if (!fullContent || fullContent.trim().length === 0) {
                const timedOut = deadlineHit();
                const failureClass = classifyRecoveryFailure(modelError, timedOut);
                const failure = resetRemoteSession(session);
                const errorType = failureClass.type;
                const errorMessage = modelError?.content
                    || (timedOut
                        ? 'DeepSeek request deadline reached while recovering an empty response'
                        : `DeepSeek returned empty content after ${retryAttempt} retr${retryAttempt === 1 ? 'y' : 'ies'}`);
                console.log(`${agentTag} ${errorType} after ${retryAttempt} retr${retryAttempt === 1 ? 'y' : 'ies'}. Giving up.`);
                const headers = {};
                if (failureClass.status === 429) headers['Retry-After'] = String(Math.ceil(RATE_LIMIT_COOLDOWN_MS / 1000));
                respondError(failureClass.status, {
                        message: errorMessage,
                        type: errorType,
                        agent: agentId,
                        failed_session_id: failure.failedSessionId,
                        message_count: failure.failedMessageCount,
                        history_length: agentSession.history.length,
                        account: failure.accountId,
                        retry_attempts: retryAttempt,
                        upstream_prompt_chars: fullPrompt.length,
                        prompt_compacted: promptCompacted,
                        model: requestedModel,
                        real_model: resolveModelConfig(requestedModel).real_model,
                }, headers);
                return;
            }

            // Auto-continuation: DeepSeek stopped at its output limit
            // (finish_reason 'length' / status INCOMPLETE), so ask for the rest.
            // Complete answers are never "continued", however long they are:
            // appending extra text would corrupt large tool-call arguments.
            let continuationRounds = 0;
            const MAX_CONTINUATION = 2;
            while (finishReason === 'length' && continuationRounds < MAX_CONTINUATION) {
                if (clientGone || deadlineHit()) break;
                continuationRounds++;
                console.log(`${agentTag} Response ${fullContent.length} chars (finish=${finishReason}). Auto-continuing (${continuationRounds}/${MAX_CONTINUATION})...`);
                await new Promise(r => setTimeout(r, 500));
                const contBeforeId = session.accountId;
                const continuationRecoveryPrompt = appendPromptInstruction(
                    `${freshPromptBuild.prompt}\n\n[Assistant response so far]\n${fullContent}`,
                    'Continue the assistant response from exactly where it stopped. Do not restart or repeat completed sections.'
                );
                let continuationCall;
                try {
                    // The reused chat already has this turn's images.
                    continuationCall = await callDeepSeek('continue', continuationRecoveryPrompt, attachments && { ...attachments, delta: [] });
                } catch (error) {
                    // The answer so far is still useful: return it as truncated
                    // (finish_reason 'length') instead of failing the request.
                    if (requestAbort.signal.aborted) throw error;
                    console.log(`${agentTag} Continuation failed (${error.message}); returning the partial answer`);
                    // The call may have left an empty replacement chat behind.
                    resetRemoteSession(session);
                    break;
                }
                const { account: contAccount } = continuationCall;
                // A cross-account continuation is valid only when the call
                // detected that reset and sent the full recovery prompt. If an
                // unexpected rotation ever bypasses that guard, discard the new
                // remote session before returning to the client (#20).
                if (!isContinuationRecoverySafe(contBeforeId, continuationCall)) {
                    console.log(`${agentTag} continuation rotated to ${contAccount.id} ≠ ${contBeforeId} — skipping (foreign session)`);
                    continuationCall.resp.abortController?.abort(new Error('foreign session'));
                    resetRemoteSession(session);
                    break;
                }
                let contResult;
                try {
                    // Not streamed live: the continuation is only kept if it
                    // passes the checks below; finish() sends the kept part.
                    contResult = await readDeepSeekResponse(continuationCall, null, session);
                    if (isRateLimitError(contResult.modelError)) {
                        const retryAfter = String(Math.ceil(RATE_LIMIT_COOLDOWN_MS / 1000));
                        markAccountFailure(continuationCall.account, 429, 'rate limited in continuation', retryAfter, RATE_LIMIT_COOLDOWN_MS);
                        throw createUpstreamHttpError(429, contResult.modelError.content, retryAfter);
                    }
                } catch (error) {
                    if (requestAbort.signal.aborted || (Number(error?.status) === 429 && error?.type === 'rate_limit_error')) throw error;
                    console.log(`${agentTag} Continuation stream failed (${error.message}); returning the partial answer`);
                    resetRemoteSession(session);
                    break;
                }
                const contContent = contResult && contResult.content ? sanitizeContent(contResult.content) : '';
                const contReasoning = contResult && contResult.reasoningContent ? sanitizeContent(contResult.reasoningContent) : '';
                if (contContent && contContent.trim().length > 0 && !contContent.includes('I am an AI')) {
                    fullContent += contContent;
                    if (contReasoning) reasoningContent += (reasoningContent ? '\n' : '') + contReasoning;
                    finishReason = contResult.finishReason;
                    console.log(`${agentTag} Continuation added ${contContent.length} chars (total: ${fullContent.length})`);
                } else {
                    console.log(`${agentTag} Continuation returned nothing useful, stopping`);
                    break;
                }
            }

            let toolCall = allowedToolNames.size > 0 ? parseToolCall(fullContent) : null;
            if (toolCall && !allowedToolNames.has(toolCall.name)) {
                console.log(`${agentTag} Model requested unknown tool ${toolCall.name}; attempting format repair.`);
                toolCall = null;
            }

            // Retry once if legacy, XML, or DSML tool markup was truncated or
            // malformed. Never pass raw DSML through as a normal assistant turn.
            if (allowedToolNames.size > 0 && !toolCall && looksLikeToolCallMarkup(fullContent) && !clientGone && !deadlineHit()) {
                console.log(`${agentTag} Tool-call markup detected but invalid/truncated (${fullContent.length} chars). Retrying with stricter prompt...`);
                resetRemoteSession(session);
                await new Promise(r => setTimeout(r, 1000));
                const strictPrompt = appendPromptInstruction(
                    freshPromptBuild.prompt,
                    `[STRICT INSTRUCTION] Your previous response contained incomplete or invalid tool-call markup. Keep arguments short and output ONLY strict JSON: ${TOOL_CALL_FORMAT} (escape backslashes and newlines inside strings). Available tools: ${[...allowedToolNames].join(', ').substring(0, 1500)}`
                );
                const retryCall2 = await callDeepSeek(strictPrompt);
                const retryResult2 = await readDeepSeekResponse(retryCall2, null, session);
                const retryContent2 = retryResult2 && retryResult2.content ? sanitizeContent(retryResult2.content) : '';
                if (retryContent2 && retryContent2.trim()) {
                    const retryTc = parseToolCall(retryContent2);
                    if (retryTc && allowedToolNames.has(retryTc.name)) {
                        console.log(`${agentTag} Retry with strict prompt succeeded: ${retryTc.name}`);
                        fullContent = retryContent2;
                        reasoningContent = retryResult2.reasoningContent ? sanitizeContent(retryResult2.reasoningContent) : '';
                        toolCall = retryTc;
                    } else if (!looksLikeToolCallMarkup(retryContent2)) {
                        // The model chose to answer in plain text this time.
                        console.log(`${agentTag} Strict retry returned a plain answer instead of tool markup.`);
                        fullContent = retryContent2;
                        reasoningContent = retryResult2.reasoningContent ? sanitizeContent(retryResult2.reasoningContent) : '';
                        finishReason = retryResult2.finishReason;
                    } else {
                        console.log(`${agentTag} Retry still has broken tool markup. Returning a safe error instead of leaking it as text.`);
                        reasoningContent = retryResult2.reasoningContent ? sanitizeContent(retryResult2.reasoningContent) : reasoningContent;
                    }
                }
            }

            if (allowedToolNames.size > 0 && !toolCall && looksLikeToolCallMarkup(fullContent)) {
                const failure = resetRemoteSession(session);
                respondError(502, {
                    message: 'DeepSeek returned malformed tool-call markup after one repair attempt',
                    type: 'malformed_tool_call',
                    agent: agentId,
                    failed_session_id: failure.failedSessionId,
                    message_count: failure.failedMessageCount,
                    history_length: agentSession.history.length,
                    account: failure.accountId,
                    prompt_compacted: promptCompacted,
                    model: requestedModel,
                    real_model: resolveModelConfig(requestedModel).real_model,
                });
                return;
            }

            // Check if tool results of the current turn contained a screenshot path.
            // If so, and the response doesn't already have MEDIA:, inject it so the gateway
            // delivers the file to Telegram.
            if (!toolCall && !fullContent.includes('MEDIA:')) {
                const screenshotPaths = extractScreenshotPaths(messages);
                if (screenshotPaths.length > 0) {
                    fullContent += '\n\n' + screenshotPaths.join('\n');
                    console.log(`${agentTag} Injected MEDIA paths into response: ${screenshotPaths.join(', ')}`);
                }
            }

            if (clientGone) {
                // The answer will never reach the client, so the remote chat
                // now holds a turn the client does not know about.
                resetRemoteSession(session);
                console.log(`${agentTag} client disconnected before the answer was sent; discarding it`);
                return;
            }
            if (!ephemeral) storeHistory(agentSession, prompt, fullContent, toolCall);
            // Remember what the remote chat now holds, so the next request of
            // this conversation sends only its new messages.
            if (session.id) {
                session.sentMessageKeys = plan.keys;
                session.contextKey = contextKey;
            }

            const openaiResponse = toolCall
                ? buildToolCallResponse(toolCall, requestedModel, clientPromptText, reasoningContent)
                : buildTextResponse(fullContent, clientPromptText, requestedModel, reasoningContent, finishReason);

            if (live) live.finish(openaiResponse);
            else sendCompletion(res, apiMode, false, openaiResponse);
            console.log(`${agentTag} ${stream ? 'Streamed' : 'Response'} ${apiMode} (tool=${!!toolCall}, ${Date.now() - startTime}ms, ${fullContent.length} chars)`);
        } catch (e) {
            console.log('[DS-API] Error:', e.message);
            // If DeepSeek accepted a completion, the remote chat may now hold a
            // turn the client never saw. Errors before that (PoW, chat
            // creation, throttling) leave the chat intact for the next request.
            const failure = remoteTouched && activeSession && activeSession.id ? resetRemoteSession(activeSession) : null;
            if (clientGone) return;
            // Pool exhaustion / no-auth carry an explicit status so integrators see
            // 429/503 (not a generic 500) and can honor Retry-After.
            const timedOut = isTimeoutError(e);
            const status = e.status || (timedOut ? 504 : 500);
            const headers = {};
            if (status === 429 && e.retryAfter) headers['Retry-After'] = String(e.retryAfter);
            respondError(status, {
                message: e.message,
                type: e.type || (timedOut ? 'request_timeout' : 'server_error'),
                ...(failure ? {
                    agent: activeAgentId,
                    failed_session_id: failure.failedSessionId,
                    message_count: failure.failedMessageCount,
                    history_length: activeSession.history.length,
                    account: failure.accountId,
                } : {}),
            }, headers);
        } finally {
            if (keepAliveTimer) clearInterval(keepAliveTimer);
            if (lockedSession) lockedSession.busy = false;
            if (state.decrementInFlight) state.decrementInFlight();
        }
    });
    return true;
}

module.exports = {
    handleChat,
    REQUEST_DEADLINE_MS,
    MAX_CONCURRENT,
    MAX_EMPTY_RETRIES,
};
