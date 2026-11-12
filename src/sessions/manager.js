const sessions = new Map();  // keyed by agent ID (from `user` field)
const MAX_HISTORY_LENGTH = 15;
const MAX_HISTORY_CHARS = 10000;
const MAX_HISTORY_ENTRY_CHARS = 2000;  // per stored assistant answer
const MAX_MESSAGE_DEPTH = 100;  // auto-reset after this many messages
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;  // 2 hours

const MIN_UPSTREAM_PROMPT_CHARS = 16000;
const configuredPromptChars = Number(process.env.DEEPSEEK_MAX_PROMPT_CHARS);
const MAX_UPSTREAM_PROMPT_CHARS = Number.isFinite(configuredPromptChars)
    ? Math.max(MIN_UPSTREAM_PROMPT_CHARS, Math.floor(configuredPromptChars))
    : 80000;
const MAX_SESSION_CONTEXT_CHARS = Math.max(
    100000,
    Math.min(500000, MAX_UPSTREAM_PROMPT_CHARS * 3)
);

function createSession() {
    return {
        id: null,
        parentMessageId: null,
        createdAt: null,
        messageCount: 0,
        accountId: null,
        history: [],
        lastActivityAt: Date.now(),
        // Fingerprints of the client messages already present in the remote
        // chat and of the system prompt/tools it was started with. They let a
        // follow-up request send only its new messages (see planSessionTurn).
        sentMessageKeys: [],
        contextKey: null,
        // Approximate size of everything the remote chat holds.
        remoteChars: 0,
        busy: false,
    };
}

function resetRemoteSession(session) {
    const failed = {
        failedSessionId: session.id,
        failedMessageCount: session.messageCount,
        accountId: session.accountId,
    };
    session.id = null;
    session.parentMessageId = null;
    session.createdAt = null;
    session.messageCount = 0;
    session.sentMessageKeys = [];
    session.contextKey = null;
    session.remoteChars = 0;
    // Keep local recovery history and the sticky account assignment. A remote
    // chat can be unhealthy without invalidating either of those local hints.
    return failed;
}

function prepareSessionForPrompt(session, now = Date.now()) {
    if (!session || !session.id) return null;
    let reason = null;
    if (session.messageCount >= MAX_MESSAGE_DEPTH) reason = 'max_message_depth';
    else if (session.createdAt && now - session.createdAt > SESSION_TTL_MS) reason = 'session_ttl';
    else if ((session.remoteChars || 0) >= MAX_SESSION_CONTEXT_CHARS) reason = 'max_context_chars';
    if (!reason) return null;
    return { reason, ...resetRemoteSession(session) };
}

function getOrCreateAgentSession(agentId) {
    if (!sessions.has(agentId)) {
        sessions.set(agentId, createSession());
    }
    const session = sessions.get(agentId);
    session.lastActivityAt = Date.now();
    return session;
}

// Evict idle sessions so the Map (keyed by client IP / user id) can't grow without
// bound on a long-running process. Drops entries untouched for 2× the session TTL.
function sweepIdleSessions(maxIdleMs = SESSION_TTL_MS * 2) {
    const now = Date.now();
    let removed = 0;
    for (const [agentId, session] of sessions) {
        if (now - (session.lastActivityAt || 0) > maxIdleMs) { sessions.delete(agentId); removed++; }
    }
    if (removed) console.log(`[DS-API] swept ${removed} idle session(s); ${sessions.size} remain`);
    return removed;
}

function storeHistory(session, prompt, content, toolCall) {
    const { toolCallAsPromptText, truncatePromptMiddle } = require('../deepseek/prompt');
    const assistantResponse = toolCall
        ? toolCallAsPromptText({ function: toolCall })
        : content;
    // Save last 500 chars of the prompt for history context
    const shortPrompt = prompt.length > 500 ? '...' + prompt.substring(prompt.length - 500) : prompt;
    // One huge answer must not crowd every earlier turn out of the bounded
    // recovery history (or get the whole history dropped as too long).
    const shortAnswer = truncatePromptMiddle(assistantResponse, MAX_HISTORY_ENTRY_CHARS, 0.6);
    session.history.push({ user: shortPrompt, assistant: shortAnswer });
    while (session.history.length > MAX_HISTORY_LENGTH) session.history.shift();
    let historyChars = session.history.reduce((sum, e) => sum + e.user.length + e.assistant.length, 0);
    while (historyChars > MAX_HISTORY_CHARS && session.history.length > 1) {
        const removed = session.history.shift();
        historyChars -= removed.user.length + removed.assistant.length;
    }
}

module.exports = {
    sessions,
    MAX_HISTORY_LENGTH,
    MAX_HISTORY_CHARS,
    MAX_HISTORY_ENTRY_CHARS,
    MAX_MESSAGE_DEPTH,
    SESSION_TTL_MS,
    MAX_SESSION_CONTEXT_CHARS,
    createSession,
    resetRemoteSession,
    prepareSessionForPrompt,
    getOrCreateAgentSession,
    sweepIdleSessions,
    storeHistory,
};
