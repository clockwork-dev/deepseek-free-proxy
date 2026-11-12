const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' };

/**
 * Strip surrogate characters and other problematic Unicode from text
 * to prevent httpx/urlencode crashes when the gateway sends to Telegram.
 */
function sanitizeContent(text) {
    // Only lone (unpaired) surrogates are invalid. Valid pairs are emoji and
    // other astral characters and must survive.
    return String(text || '').replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');
}

function estimateTokens(text) {
    return text ? Math.ceil(String(text).length / 4) : 0;
}

function buildUsage(prompt, content, reasoningContent = '') {
    const promptTokens = estimateTokens(prompt);
    const contentTokens = estimateTokens(content);
    const reasoningTokens = estimateTokens(reasoningContent);
    const completionTokens = contentTokens + reasoningTokens;
    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        completion_tokens_details: {
            reasoning_tokens: reasoningTokens
        }
    };
}

function buildToolCallResponse(toolCall, model = 'deepseek-default', prompt = '', reasoningContent = '') {
    const id = 'call_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const message = {
        role: 'assistant',
        content: null,
        tool_calls: [{
            id: id,
            type: 'function',
            function: { name: toolCall.name, arguments: toolCall.arguments }
        }]
    };
    // Do not attach reasoning to tool-call turns. Some agent clients treat any
    // reasoning/text payload as a final assistant answer and stop their tool loop.
    return {
        id: 'ds-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            message,
            finish_reason: 'tool_calls'
        }],
        usage: buildUsage(prompt, '', reasoningContent)
    };
}

function buildTextResponse(content, prompt, model = 'deepseek-default', reasoningContent = '', finishReason = null) {
    const message = { role: 'assistant', content };
    if (reasoningContent) message.reasoning_content = reasoningContent;
    return {
        id: 'ds-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            message,
            // Surface truncation: a 'length' finish lets length-aware clients re-request
            // instead of silently treating a cut-off answer as a clean stop.
            finish_reason: finishReason === 'length' ? 'length' : 'stop'
        }],
        usage: buildUsage(prompt, content, reasoningContent)
    };
}

function normalizeAnthropicTools(tools = []) {
    return (tools || []).map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.input_schema || tool.parameters || { type: 'object', properties: {} }
        }
    })).filter(tool => tool.function.name);
}

function normalizeResponsesTools(tools = []) {
    return (tools || []).map(tool => {
        if (tool.type === 'function' && tool.function) return tool;
        if (tool.type === 'function' && tool.name) {
            return { type: 'function', function: { name: tool.name, description: tool.description || '', parameters: tool.parameters || { type: 'object', properties: {} } } };
        }
        return null;
    }).filter(Boolean);
}

function normalizeResponsesInput(input) {
    if (typeof input === 'string') return [{ role: 'user', content: input }];
    if (!Array.isArray(input)) return [];
    const messages = [];
    for (const item of input) {
        if (!item || typeof item !== 'object') continue;
        // Content parts stay raw (images included); formatting normalizes them.
        if (item.type === 'message') {
            messages.push({ role: item.role || 'user', content: item.content });
        } else if (item.role) {
            messages.push({ role: item.role, content: item.content });
        } else if (item.type === 'function_call') {
            // The assistant's earlier tool request. Without it the following
            // function_call_output has no visible cause in the prompt.
            messages.push({ role: 'assistant', content: null, tool_calls: [{
                id: item.call_id || item.id,
                type: 'function',
                function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}) },
            }] });
        } else if (item.type === 'function_call_output') {
            messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output });
        } else if (item.type === 'input_text') {
            messages.push({ role: 'user', content: item.text || '' });
        }
    }
    return messages;
}

function normalizeApiParams(params, apiMode, normalizeMessageContent) {
    if (apiMode === 'anthropic') {
        const normMsg = normalizeMessageContent || require('../deepseek/multimodal').normalizeMessageContent;
        const messages = [];
        if (params.system) messages.push({ role: 'system', content: normMsg(params.system) });
        for (const msg of params.messages || []) {
            if (msg.role === 'assistant' && Array.isArray(msg.content)) {
                const toolUses = msg.content.filter(part => part && part.type === 'tool_use');
                const text = normMsg(msg.content.filter(part => !part || part.type !== 'tool_use'));
                if (text) messages.push({ role: 'assistant', content: text });
                for (const tu of toolUses) {
                    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: tu.id, type: 'function', function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) } }] });
                }
            } else if (msg.role === 'user' && Array.isArray(msg.content) && msg.content.some(part => part && part.type === 'tool_result')) {
                for (const part of msg.content) {
                    if (part && part.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: part.tool_use_id, content: part.content });
                    else messages.push({ role: 'user', content: [part] });
                }
            } else {
                messages.push({ role: msg.role || 'user', content: msg.content });
            }
        }
        return {
            ...params,
            model: params.model || 'deepseek-chat',
            messages,
            tools: normalizeAnthropicTools(params.tools || []),
            stream: params.stream === true,
            user: params.metadata?.user_id || params.user,
        };
    }
    if (apiMode === 'responses') {
        const messages = normalizeResponsesInput(params.input);
        if (params.instructions) messages.unshift({ role: 'system', content: params.instructions });
        return {
            ...params,
            model: params.model || 'deepseek-chat',
            messages,
            tools: normalizeResponsesTools(params.tools || []),
            stream: params.stream === true,
            user: params.user,
        };
    }
    return params;
}

function safeJsonParseObject(text, fallback = {}) {
    try {
        const parsed = JSON.parse(text || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch (e) {
        return fallback;
    }
}

function toAnthropicResponse(openaiResp) {
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const content = [];
    if (hasToolCalls) {
        for (const tc of msg.tool_calls) {
            content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: safeJsonParseObject(tc.function.arguments) });
        }
    } else {
        content.push({ type: 'text', text: msg.content || '' });
    }
    const response = {
        id: 'msg_' + openaiResp.id,
        type: 'message',
        role: 'assistant',
        model: openaiResp.model,
        content,
        stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : (choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn'),
        stop_sequence: null,
        usage: {
            input_tokens: openaiResp.usage?.prompt_tokens || 0,
            output_tokens: openaiResp.usage?.completion_tokens || 0,
        },
    };
    if (!hasToolCalls && msg.reasoning_content) response.reasoning_content = msg.reasoning_content;
    return response;
}

// Splits text into stream deltas by code point. Cutting by UTF-16 units would
// split an emoji into lone surrogates, which strict UTF-8 clients (Python
// httpx, Telegram gateways) reject.
function chunkText(text, size) {
    return String(text || '').match(new RegExp(`[\\s\\S]{1,${size}}`, 'gu')) || [];
}

function toResponsesResponse(openaiResp, ids = {}) {
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const output = [];
    if (!hasToolCalls && msg.reasoning_content) {
        output.push({ id: ids.reasoning || 'rs_' + Date.now(), type: 'reasoning', summary: [{ type: 'summary_text', text: msg.reasoning_content }], status: 'completed' });
    }
    if (hasToolCalls) {
        for (const tc of msg.tool_calls) {
            output.push({ type: 'function_call', id: 'fc_' + tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}' });
        }
    } else {
        output.push({ id: ids.message || 'msg_' + Date.now(), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: msg.content || '', annotations: [] }] });
    }
    return {
        id: ids.response || openaiResp.id.replace(/^ds-/, 'resp_'),
        object: 'response',
        created_at: openaiResp.created,
        status: 'completed',
        model: openaiResp.model,
        output,
        output_text: msg.content || '',
        usage: {
            input_tokens: openaiResp.usage?.prompt_tokens || 0,
            output_tokens: openaiResp.usage?.completion_tokens || 0,
            total_tokens: openaiResp.usage?.total_tokens || 0,
            output_tokens_details: { reasoning_tokens: openaiResp.usage?.completion_tokens_details?.reasoning_tokens || 0 },
        },
    };
}

function sendJsonError(res, status, message, type, extra = {}, headers = {}) {
    if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify({ error: { message, type, ...extra } }));
}

function sendCompletion(res, apiMode, stream, openaiResponse) {
    if (stream) {
        if (apiMode === 'anthropic') sendAnthropicStream(res, openaiResponse);
        else if (apiMode === 'responses') sendResponsesStream(res, openaiResponse);
        else sendOpenAIStream(res, openaiResponse);
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (apiMode === 'anthropic') res.end(JSON.stringify(toAnthropicResponse(openaiResponse)));
    else if (apiMode === 'responses') res.end(JSON.stringify(toResponsesResponse(openaiResponse)));
    else res.end(JSON.stringify(openaiResponse));
}

function writeSse(res, event, data) {
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function anthropicErrorType(type, status) {
    if (status === 429 || /rate/i.test(String(type))) return 'rate_limit_error';
    if (status === 401 || status === 403) return 'authentication_error';
    if (status === 400 || status === 413) return 'invalid_request_error';
    if (status === 503) return 'overloaded_error';
    return 'api_error';
}

function createStreamWriter(res, apiMode, { model = 'deepseek-chat', promptTokens = 0, id = 'ds-' + Date.now(), created = Math.floor(Date.now() / 1000) } = {}) {
    const state = { started: false, ended: false, lastWriteAt: 0, reasoning: '', content: '', section: null, reasoningSource: null, pendingWhitespace: '', sources: 0 };
    const itemIds = { response: id.replace(/^ds-/, 'resp_'), reasoning: `rs_${id}`, message: `msg_${id}` };
    let roleSent = false;
    let blockIndex = -1;
    let outputIndex = -1;

    const sse = (event, data) => { writeSse(res, event, data); state.lastWriteAt = Date.now(); };
    const chunk = (delta, finishReason = null) => sse(null, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] });
    const responseSkeleton = () => ({ id: itemIds.response, object: 'response', created_at: created, status: 'in_progress', model, output: [] });

    function start() {
        if (state.started) return;
        state.started = true;
        res.writeHead(200, SSE_HEADERS);
        state.lastWriteAt = Date.now();
        if (apiMode === 'anthropic') {
            sse('message_start', { type: 'message_start', message: { id: 'msg_' + id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: promptTokens, output_tokens: 0 } } });
        } else if (apiMode === 'responses') {
            sse('response.created', { type: 'response.created', response: responseSkeleton() });
            sse('response.in_progress', { type: 'response.in_progress', response: responseSkeleton() });
        }
    }

    // The first OpenAI chunk announces the role, as OpenAI streams do.
    function openaiRole(toolTurn) {
        if (roleSent) return;
        roleSent = true;
        chunk({ role: 'assistant', content: toolTurn ? null : '' });
    }

    function openSection(kind) {
        if (state.section === kind) return;
        closeSection();
        state.section = kind;
        if (apiMode === 'openai') {
            openaiRole(false);
        } else if (apiMode === 'anthropic') {
            blockIndex++;
            sse('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
            if (kind === 'reasoning') sse('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: '[reasoning]\n' } });
        } else {
            outputIndex++;
            if (kind === 'reasoning') {
                sse('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { id: itemIds.reasoning, type: 'reasoning', summary: [], status: 'in_progress' } });
                sse('response.reasoning_summary_part.added', { type: 'response.reasoning_summary_part.added', item_id: itemIds.reasoning, output_index: outputIndex, summary_index: 0, part: { type: 'summary_text', text: '' } });
            } else {
                sse('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { id: itemIds.message, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
                sse('response.content_part.added', { type: 'response.content_part.added', item_id: itemIds.message, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
            }
        }
    }

    function closeSection() {
        const kind = state.section;
        if (!kind) return;
        state.section = null;
        if (apiMode === 'openai') return;
        if (apiMode === 'anthropic') {
            if (kind === 'reasoning') sse('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: '\n[/reasoning]\n' } });
            sse('content_block_stop', { type: 'content_block_stop', index: blockIndex });
            return;
        }
        if (kind === 'reasoning') {
            const part = { type: 'summary_text', text: state.reasoning };
            sse('response.reasoning_summary_text.done', { type: 'response.reasoning_summary_text.done', item_id: itemIds.reasoning, output_index: outputIndex, summary_index: 0, text: state.reasoning });
            sse('response.reasoning_summary_part.done', { type: 'response.reasoning_summary_part.done', item_id: itemIds.reasoning, output_index: outputIndex, summary_index: 0, part });
            sse('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: { id: itemIds.reasoning, type: 'reasoning', summary: [part], status: 'completed' } });
        } else {
            const part = { type: 'output_text', text: state.content, annotations: [] };
            sse('response.output_text.done', { type: 'response.output_text.done', item_id: itemIds.message, output_index: outputIndex, content_index: 0, text: state.content });
            sse('response.content_part.done', { type: 'response.content_part.done', item_id: itemIds.message, output_index: outputIndex, content_index: 0, part });
            sse('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: { id: itemIds.message, type: 'message', role: 'assistant', status: 'completed', content: [part] } });
        }
    }

    function emit(kind, text) {
        if (!text) return;
        start();
        openSection(kind);
        for (const piece of chunkText(text, apiMode === 'openai' ? 50 : 80)) {
            if (apiMode === 'openai') chunk(kind === 'reasoning' ? { reasoning_content: piece } : { content: piece });
            else if (apiMode === 'anthropic') sse('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: piece } });
            else if (kind === 'reasoning') sse('response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', item_id: itemIds.reasoning, output_index: outputIndex, summary_index: 0, delta: piece });
            else sse('response.output_text.delta', { type: 'response.output_text.delta', item_id: itemIds.message, output_index: outputIndex, content_index: 0, delta: piece });
        }
        state[kind] += text;
    }

    function pushReasoning(text, sourceId = null) {
        // Reasoning belongs before the answer and comes from one DeepSeek
        // call; reasoning of retries and continuations is not streamed.
        if (state.ended || state.content || state.section === 'content') return;
        if (sourceId !== null) {
            if (state.reasoningSource !== null && state.reasoningSource !== sourceId) return;
            if (text) state.reasoningSource = sourceId;
        }
        emit('reasoning', text);
    }

    function pushContent(text) {
        if (state.ended) return;
        // Do not open the answer on leading whitespace: an all-whitespace
        // answer counts as empty and is retried.
        if (!state.content) {
            const combined = state.pendingWhitespace + text;
            if (!combined.trim()) { state.pendingWhitespace = combined; return; }
            state.pendingWhitespace = '';
            text = combined;
        }
        emit('content', text);
    }

    return {
        get started() { return state.started; },
        get lastWriteAt() { return state.lastWriteAt; },
        get streamedContent() { return state.content; },
        source(kind) {
            const sourceId = ++state.sources;
            // Whitespace held back from an earlier (empty, retried) call
            // must not be prepended to this call's answer.
            if (kind === 'content' && !state.content) state.pendingWhitespace = '';
            let consumed = 0;
            let carry = '';
            return (cumulative) => {
                const raw = String(cumulative || '');
                if (raw.length <= consumed) return;
                let piece = carry + raw.slice(consumed);
                consumed = raw.length;
                carry = '';
                // Keep a trailing high surrogate until its pair arrives.
                if (/[\ud800-\udbff]$/.test(piece)) { carry = piece.slice(-1); piece = piece.slice(0, -1); }
                piece = sanitizeContent(piece);
                if (kind === 'reasoning') pushReasoning(piece, sourceId);
                else pushContent(piece);
            };
        },
        keepAlive() {
            if (state.ended) return;
            start();
            res.write(': keep-alive\n\n');
            state.lastWriteAt = Date.now();
        },
        finish(openaiResp) {
            if (state.ended) return;
            const choice = openaiResp.choices[0];
            const msg = choice.message || {};
            const toolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0 ? msg.tool_calls : null;
            const usage = { input_tokens: openaiResp.usage?.prompt_tokens || 0, output_tokens: openaiResp.usage?.completion_tokens || 0 };
            start();
            if (toolCalls) {
                // Agent clients expect a tool turn to contain only the tool
                // call: no reasoning or text that could read as a final answer.
                closeSection();
                if (apiMode === 'openai') {
                    openaiRole(true);
                    // Streaming tool-call deltas must carry their position:
                    // SDKs accumulate arguments by `index`.
                    chunk({ tool_calls: toolCalls.map((tc, index) => ({ index, ...tc })) });
                    chunk({}, 'tool_calls');
                } else if (apiMode === 'anthropic') {
                    for (const tc of toolCalls) {
                        blockIndex++;
                        sse('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} } });
                        sse('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: tc.function.arguments || '{}' } });
                        sse('content_block_stop', { type: 'content_block_stop', index: blockIndex });
                    }
                    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage });
                } else {
                    for (const tc of toolCalls) {
                        outputIndex++;
                        const item = { type: 'function_call', id: 'fc_' + tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}', status: 'completed' };
                        sse('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { ...item, arguments: '', status: 'in_progress' } });
                        sse('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: outputIndex, item_id: item.id, delta: item.arguments });
                        sse('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', output_index: outputIndex, item_id: item.id, arguments: item.arguments });
                        sse('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
                    }
                }
            } else {
                const reasoning = String(msg.reasoning_content || '');
                if (reasoning && !state.content && reasoning.startsWith(state.reasoning)) pushReasoning(reasoning.slice(state.reasoning.length));
                const content = String(msg.content || '');
                let rest = content;
                if (state.content) {
                    if (content.startsWith(state.content)) {
                        rest = content.slice(state.content.length);
                    } else {
                        let common = 0;
                        while (common < state.content.length && content[common] === state.content[common]) common++;
                        console.log(`[stream] final answer diverged from the streamed text after ${common} chars`);
                        rest = content.slice(common);
                    }
                }
                start();
                openSection('content');
                if (rest) emit('content', rest);
                closeSection();
                if (apiMode === 'openai') {
                    chunk({}, choice.finish_reason === 'length' ? 'length' : 'stop');
                } else if (apiMode === 'anthropic') {
                    sse('message_delta', { type: 'message_delta', delta: { stop_reason: choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null }, usage });
                }
            }
            if (apiMode === 'anthropic') {
                sse('message_stop', { type: 'message_stop' });
            } else if (apiMode === 'responses') {
                // Describe exactly the items that were streamed.
                const streamed = toolCalls ? openaiResp : {
                    ...openaiResp,
                    choices: [{ ...choice, message: { ...msg, reasoning_content: state.reasoning || undefined, content: state.content } }],
                };
                sse('response.completed', { type: 'response.completed', response: toResponsesResponse(streamed, itemIds) });
                res.write('data: [DONE]\n\n');
            } else {
                res.write('data: [DONE]\n\n');
            }
            state.ended = true;
            res.end();
        },
        fail(status, error, headers = {}) {
            if (state.ended) return;
            state.ended = true;
            if (!state.started) {
                if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
                res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
                res.end(JSON.stringify({ error }));
                return;
            }
            const message = error?.message || 'DeepSeek request failed';
            if (apiMode === 'anthropic') {
                writeSse(res, 'error', { type: 'error', error: { type: anthropicErrorType(error?.type, status), message } });
            } else if (apiMode === 'responses') {
                writeSse(res, 'error', { type: 'error', code: error?.type || 'server_error', message, param: null, error: { ...error, status } });
            } else {
                writeSse(res, null, { error: { ...error, code: status } });
                res.write('data: [DONE]\n\n');
            }
            res.end();
        },
    };
}

function sendStreamedCompletion(res, apiMode, openaiResp) {
    createStreamWriter(res, apiMode, { model: openaiResp.model, promptTokens: openaiResp.usage?.prompt_tokens || 0, id: openaiResp.id, created: openaiResp.created }).finish(openaiResp);
}

function sendAnthropicStream(res, openaiResp) { sendStreamedCompletion(res, 'anthropic', openaiResp); }
function sendResponsesStream(res, openaiResp) { sendStreamedCompletion(res, 'responses', openaiResp); }
function sendOpenAIStream(res, openaiResp) { sendStreamedCompletion(res, 'openai', openaiResp); }

module.exports = {
    SSE_HEADERS,
    sanitizeContent,
    estimateTokens,
    buildUsage,
    buildToolCallResponse,
    buildTextResponse,
    normalizeAnthropicTools,
    normalizeResponsesTools,
    normalizeResponsesInput,
    normalizeApiParams,
    safeJsonParseObject,
    toAnthropicResponse,
    chunkText,
    toResponsesResponse,
    sendJsonError,
    sendCompletion,
    writeSse,
    anthropicErrorType,
    createStreamWriter,
    sendStreamedCompletion,
    sendAnthropicStream,
    sendResponsesStream,
    sendOpenAIStream,
};
