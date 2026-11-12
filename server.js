#!/usr/bin/env node
/**
 * FreeDeepseekAPI - Entrypoint and Backward-Compatible Runner
 */

const path = require('path');
const { loadDotEnv } = require('./lib/env');
if (require.main === module) loadDotEnv(path.join(__dirname, '.env'));

const {
    server,
    main,
    setupProcessHandlers,
    printBanner,
    prompt,
    runAuthScript,
    printStatus,
    showStartupMenu,
} = require('./src/server');

const {
    isAssistantOutputFragment,
    isReasoningFragment,
    isDeepSeekModelErrorEvent,
    createUpstreamHttpError,
    rebuildFragmentText,
    applyResponsePatchOperations,
    MODEL_CONFIGS,
    SUPPORTED_MODEL_IDS,
    resolveModelConfig,
    isContinuationRecoverySafe,
    isContextTooLongError,
    normalizeRetryResponse,
    isRateLimitError,
    classifyRecoveryFailure,
    isTimeoutError,
} = require('./src/deepseek/client');

const {
    imageUploadEnabled,
    uploadedFileCache,
    ImageUploadCache,
    collectImages,
    collectImagesAsync,
    fetchRemoteImage,
    detectMimeType,
    normalizeMessageContent,
    extractScreenshotPaths,
} = require('./src/deepseek/multimodal');

const {
    accounts,
    selectAccountForSession,
    loadDeepSeekConfig,
} = require('./src/accounts/pool');

const {
    compactToolSchema,
    formatToolDefinitions,
    formatToolReminder,
    parseToolCall,
    parseDsmlToolCall,
    looksLikeToolCallMarkup,
    repairJsonText,
    parseJsonLenient,
} = require('./src/tools/parser');

const {
    truncatePromptMiddle,
    hasExplicitConversationHistory,
    buildRecoveryHistoryPrefix,
    buildBoundedPrompt,
    buildRetryPrompt,
    formatMessages,
    formatConversation,
    conversationMessageKey,
    planSessionTurn,
    buildDeltaPrompt,
    hashText,
} = require('./src/deepseek/prompt');

const {
    sessions,
    createSession,
    resetRemoteSession,
    prepareSessionForPrompt,
    sweepIdleSessions,
} = require('./src/sessions/manager');

const {
    isProxyAuthorized,
    loadProxyApiKey,
    requireProxyApiKey,
    isLoopbackHost,
    normalizeOrigin,
    isBrowserOriginAllowed,
    setCorsResponseHeaders,
    markContextCompacted,
    CONTEXT_COMPACTED_HEADER,
} = require('./src/utils/auth');

const {
    sanitizeContent,
    normalizeApiParams,
    sendAnthropicStream,
    sendResponsesStream,
    sendOpenAIStream,
} = require('./src/utils/streaming');

const serverInternals = {
    isAssistantOutputFragment,
    isReasoningFragment,
    isDeepSeekModelErrorEvent,
    createUpstreamHttpError,
    rebuildFragmentText,
    applyResponsePatchOperations,
    compactToolSchema,
    formatToolDefinitions,
    parseToolCall,
    parseDsmlToolCall,
    looksLikeToolCallMarkup,
    truncatePromptMiddle,
    hasExplicitConversationHistory,
    buildRecoveryHistoryPrefix,
    buildBoundedPrompt,
    buildRetryPrompt,
    isContinuationRecoverySafe,
    isContextTooLongError,
    normalizeRetryResponse,
    classifyRecoveryFailure,
    isTimeoutError,
    formatMessages,
    formatConversation,
    formatToolReminder,
    conversationMessageKey,
    planSessionTurn,
    buildDeltaPrompt,
    hashText,
    repairJsonText,
    parseJsonLenient,
    sanitizeContent,
    normalizeMessageContent,
    normalizeApiParams,
    extractScreenshotPaths,
    collectImages,
    collectImagesAsync,
    fetchRemoteImage,
    detectMimeType,
    ImageUploadCache,
    uploadedFileCache,
    isRateLimitError,
    imageUploadEnabled,
    loadDotEnv,
    MODEL_CONFIGS,
    SUPPORTED_MODEL_IDS,
    resolveModelConfig,
    server,
    createSession,
    resetRemoteSession,
    prepareSessionForPrompt,
    sweepIdleSessions,
    sessions,
    accounts,
    selectAccountForSession,
    isProxyAuthorized,
    loadProxyApiKey,
    requireProxyApiKey,
    isLoopbackHost,
    normalizeOrigin,
    isBrowserOriginAllowed,
    setCorsResponseHeaders,
    markContextCompacted,
    CONTEXT_COMPACTED_HEADER,
    sendAnthropicStream,
    sendResponsesStream,
    sendOpenAIStream,
};

if (require.main === module) {
    loadDeepSeekConfig({ fatal: false });
    setupProcessHandlers();
    main().catch(err => {
        console.error('[DS-API] FATAL:', err);
        process.exit(1);
    });
}

module.exports = {
    server,
    main,
    setupProcessHandlers,
    printBanner,
    prompt,
    runAuthScript,
    printStatus,
    showStartupMenu,
    serverInternals,
    __test: serverInternals,
};
