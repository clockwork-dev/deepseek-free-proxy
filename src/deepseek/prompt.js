const crypto = require('crypto');
const { formatToolDefinitions, formatToolReminder } = require('../tools/parser');
const { normalizeMessageContent } = require('./multimodal');

const MIN_UPSTREAM_PROMPT_CHARS = 16000;
const configuredPromptChars = Number(process.env.DEEPSEEK_MAX_PROMPT_CHARS);
const MAX_UPSTREAM_PROMPT_CHARS = Number.isFinite(configuredPromptChars)
    ? Math.max(MIN_UPSTREAM_PROMPT_CHARS, Math.floor(configuredPromptChars))
    : 80000;

const PROMPT_COMPACTION_MARKER = '\n\n[Earlier context compacted by FreeDeepseekAPI]\n\n';

function truncatePromptMiddle(text, maxChars, headRatio = 0.35) {
    const value = String(text || '');
    if (value.length <= maxChars) return value;
    if (maxChars <= 0) return '';
    if (maxChars <= PROMPT_COMPACTION_MARKER.length) return value.substring(value.length - maxChars);
    const payloadChars = maxChars - PROMPT_COMPACTION_MARKER.length;
    const headChars = Math.max(0, Math.min(payloadChars, Math.floor(payloadChars * headRatio)));
    const tailChars = payloadChars - headChars;
    return value.substring(0, headChars) + PROMPT_COMPACTION_MARKER + value.substring(value.length - tailChars);
}

// A client sends its own history when it replays earlier assistant turns.
// Requests with only new input (one user message, or just a tool result for
// a previous answer) rely on the proxy's remote chat and local history.
function hasExplicitConversationHistory(messages) {
    return (messages || []).some(msg => msg && msg.role === 'assistant');
}

function buildRecoveryHistoryPrefix(history) {
    if (!Array.isArray(history) || history.length === 0) return '';
    let prefix = '[Previous conversation]\n';
    for (const exchange of history) {
        prefix += `User: ${String(exchange?.user || '')}\nAssistant: ${String(exchange?.assistant || '')}\n\n`;
    }
    return prefix + '[Continue from here]\n\n';
}

function buildBoundedPrompt(systemPrompt, historyPrefix, conversationPrompt, maxChars = MAX_UPSTREAM_PROMPT_CHARS) {
    const system = String(systemPrompt || '').trim();
    const history = String(historyPrefix || '');
    const conversation = String(conversationPrompt || '').trim();
    const original = system ? `${system}\n\n${history}${conversation}` : `${history}${conversation}`;
    const safeMax = Math.max(1, Math.floor(Number(maxChars) || MAX_UPSTREAM_PROMPT_CHARS));
    if (original.length <= safeMax) {
        return { prompt: original, compacted: false, historyDropped: false, originalChars: original.length, promptChars: original.length };
    }

    // Server-side history is only a recovery hint. Drop it before truncating
    // client-provided messages, which may already contain the same turns.
    const historyDropped = history.length > 0;
    const currentConversation = conversation;
    const separatorLength = system && currentConversation ? 2 : 0;
    let systemBudget = system ? Math.floor((safeMax - separatorLength) * 0.5) : 0;
    let conversationBudget = Math.max(0, safeMax - separatorLength - systemBudget);

    // Give unused capacity from a short side to the other side.
    if (system.length < systemBudget) {
        systemBudget = system.length;
        conversationBudget = Math.max(0, safeMax - separatorLength - systemBudget);
    } else if (currentConversation.length < conversationBudget) {
        conversationBudget = currentConversation.length;
        systemBudget = Math.max(0, safeMax - separatorLength - conversationBudget);
    }

    // Preserve the start of the task/system instructions and the most recent
    // tool loop. The injected tool adapter lives at the end of systemPrompt.
    const boundedSystem = truncatePromptMiddle(system, systemBudget, 0.35);
    const boundedConversation = truncatePromptMiddle(currentConversation, conversationBudget, 0.25);
    let bounded = boundedSystem && boundedConversation
        ? `${boundedSystem}\n\n${boundedConversation}`
        : (boundedSystem || boundedConversation);
    if (bounded.length > safeMax) bounded = bounded.substring(0, safeMax);
    return {
        prompt: bounded,
        compacted: true,
        historyDropped,
        originalChars: original.length,
        promptChars: bounded.length,
    };
}

function buildRetryPrompt(systemPrompt, historyPrefix, conversationPrompt, currentPrompt, maxChars) {
    const retryBuild = buildBoundedPrompt(systemPrompt, historyPrefix, conversationPrompt, maxChars);
    const current = String(currentPrompt || '');
    return {
        ...retryBuild,
        compacted: retryBuild.compacted || retryBuild.prompt.length < current.length,
        originalChars: retryBuild.originalChars,
        promptChars: retryBuild.prompt.length,
        previousPromptChars: current.length,
    };
}

function appendPromptInstruction(promptText, instruction, maxChars = MAX_UPSTREAM_PROMPT_CHARS) {
    const suffix = `\n\n${String(instruction || '').trim()}`;
    const baseBudget = Math.max(0, maxChars - suffix.length);
    return truncatePromptMiddle(promptText, baseBudget, 0.35) + suffix;
}

function isSystemRole(role) {
    // OpenAI's newer "developer" role carries system instructions.
    return role === 'system' || role === 'developer';
}

// Earlier tool requests are replayed in the same JSON envelope the model is
// asked to produce, so the transcript never teaches it a second format.
function toolCallAsPromptText(toolCall) {
    const name = toolCall?.function?.name || toolCall?.name || '';
    let args = toolCall?.function?.arguments ?? toolCall?.arguments ?? {};
    if (typeof args === 'string') {
        try { args = JSON.parse(args || '{}'); } catch (e) { /* keep the raw string */ }
    }
    return JSON.stringify({ tool_call: { name, arguments: args } });
}

function buildToolNameIndex(messages) {
    const names = new Map();
    for (const msg of messages || []) {
        if (msg?.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue;
        for (const tc of msg.tool_calls) {
            if (tc?.id && tc.function?.name) names.set(tc.id, tc.function.name);
        }
    }
    return names;
}

function formatConversation(messages, toolNames = buildToolNameIndex(messages)) {
    let conversation = '';
    for (const msg of messages || []) {
        if (!msg || isSystemRole(msg.role)) continue;
        if (msg.role === 'user') {
            const text = normalizeMessageContent(msg.content);
            if (text) conversation += `User: ${text}\n\n`;
        } else if (msg.role === 'assistant') {
            const text = normalizeMessageContent(msg.content);
            if (text) conversation += `Assistant: ${text}\n\n`;
            for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
                conversation += `Assistant: ${toolCallAsPromptText(tc)}\n\n`;
            }
        } else if (msg.role === 'tool' || msg.role === 'function') {
            // Tool execution result. Do not impose a per-result limit: one
            // large result may be the essential input. buildBoundedPrompt
            // applies the single global cap while preserving the latest tail.
            const name = msg.name || toolNames.get(msg.tool_call_id) || '';
            conversation += `[Tool Result${name ? `: ${name}` : ''}]\n${normalizeMessageContent(msg.content)}\n\n`;
        }
    }
    return conversation.trim();
}

function formatMessages(messages, tools) {
    let systemPrompt = '';
    for (const msg of messages || []) {
        if (msg && isSystemRole(msg.role) && msg.content) {
            systemPrompt += normalizeMessageContent(msg.content) + '\n';
        }
    }
    systemPrompt += formatToolDefinitions(tools);
    return {
        prompt: formatConversation(messages),
        systemPrompt: systemPrompt.trim(),
        toolReminder: formatToolReminder(tools),
    };
}

function hashText(value) {
    return crypto.createHash('sha256').update(String(value)).digest('base64');
}

// Identity of one client message as it is replayed in later requests. The
// assistant's reasoning is excluded: clients often drop it when echoing.
function conversationMessageKey(msg) {
    const toolCalls = Array.isArray(msg?.tool_calls)
        ? msg.tool_calls.map(tc => [tc?.function?.name || '', String(tc?.function?.arguments ?? ''), tc?.id || ''])
        : [];
    return hashText(JSON.stringify([
        msg?.role || '',
        normalizeMessageContent(msg?.content),
        toolCalls,
        msg?.tool_call_id || '',
    ]));
}

// Decides what a request must send to DeepSeek.
//  - 'delta': the remote chat already holds the earlier turns of this
//    conversation, so only the new messages go up (plus a tool reminder).
//  - 'full':  a fresh remote chat receives the complete (bounded) prompt.
// Re-sending the whole history into an existing chat made the remote context
// grow quadratically until DeepSeek returned empty answers or "content too
// long" and lost the tool protocol (#23, #30).
function planSessionTurn(session, messages, contextKey) {
    const conversation = (messages || []).filter(msg => msg && !isSystemRole(msg.role));
    const keys = conversation.map(conversationMessageKey);
    if (!session?.id) return { mode: 'full', reason: null, keys };
    // contextKey is recorded after the first successful turn. Without it the
    // remote chat is empty (its first request failed), so it must receive the
    // self-contained prompt, including local recovery history.
    if (!session.contextKey) return { mode: 'full', reason: 'remote chat has no completed turn yet', keys };
    const sent = Array.isArray(session.sentMessageKeys) ? session.sentMessageKeys : [];
    // Clients without explicit history send only their new input (a user
    // message, or a tool result for the previous answer) and rely on the
    // remote chat to remember earlier turns. A changed system prompt (e.g. a
    // timestamp) is sent along instead of discarding that memory.
    if (!conversation.some(msg => msg.role === 'assistant')) {
        return { mode: 'delta', messages: conversation, keys, includeSystem: session.contextKey !== contextKey };
    }
    if (session.contextKey !== contextKey) return { mode: 'full', reason: 'system prompt or tools changed', keys };
    if (sent.length > 0 && sent.length < keys.length && sent.every((key, index) => keys[index] === key)) {
        // The client echoes the assistant turn DeepSeek just produced; the
        // remote chat already contains it.
        let start = sent.length;
        while (start < conversation.length && conversation[start].role === 'assistant') start++;
        const delta = conversation.slice(start);
        if (delta.some(msg => msg.role !== 'assistant')) return { mode: 'delta', messages: delta, keys };
        return { mode: 'full', reason: 'no new input after the last answer', keys };
    }
    return { mode: 'full', reason: 'conversation history diverged', keys };
}

function buildDeltaPrompt(deltaMessages, allMessages, toolReminder, maxChars = MAX_UPSTREAM_PROMPT_CHARS, systemPrompt = '') {
    const body = formatConversation(deltaMessages, buildToolNameIndex(allMessages));
    const suffix = toolReminder ? `\n\n${toolReminder}` : '';
    const budget = Math.max(0, maxChars - suffix.length);
    if (systemPrompt) {
        const bounded = buildBoundedPrompt(systemPrompt, '', body, budget);
        return { prompt: bounded.prompt + suffix, compacted: bounded.compacted };
    }
    const bounded = truncatePromptMiddle(body, budget, 0.25);
    return { prompt: bounded + suffix, compacted: bounded.length < body.length };
}

module.exports = {
    MIN_UPSTREAM_PROMPT_CHARS,
    MAX_UPSTREAM_PROMPT_CHARS,
    PROMPT_COMPACTION_MARKER,
    truncatePromptMiddle,
    hasExplicitConversationHistory,
    buildRecoveryHistoryPrefix,
    buildBoundedPrompt,
    buildRetryPrompt,
    appendPromptInstruction,
    isSystemRole,
    toolCallAsPromptText,
    buildToolNameIndex,
    formatConversation,
    formatMessages,
    hashText,
    conversationMessageKey,
    planSessionTurn,
    buildDeltaPrompt,
};
