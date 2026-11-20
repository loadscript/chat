// Public barrel for the @loadscript/chat UI package.
//
// SURFACE NOTE (the harness rebuild, R1/R2): `App` and `ChatAssistantApp` keep
// their pre-rebuild names, and `ChatAssistantApp` keeps its prop NAMES
// ({ baseUrl?, providerUrl? }) — but both props changed MEANING, and the jsdoc on
// ChatAssistantAppProps is the contract: `baseUrl` is the harness API root ('' =
// same origin), `providerUrl` is the OFFLINE provider base.
//
// What this barrel no longer exports: the `/v1/chat-assistant/*` REST client
// (`fetchConversation`, `listConversations`, `addToConversation`,
// `replaceConversationMessages`, `deleteConversation`,
// `DEFAULT_CHAT_ASSISTANT_URL`) and the LAN host/port constants
// (`DATABASE_API_*`, `INFERENCE_PROVIDER_*`, `DEFAULT_SERVER_URL`). The gateway
// API they spoke is gone; the harness API is the API now, and it is reached
// through the same-origin client below.
//
// The SERVER is not exported from this package: it lives in `@underload/chat`
// (`startChatAssistantServer` and the injected `chat` preset).
export { App } from './App';
export { ChatAssistantApp } from './dashboard/ChatAssistantApp';
export type { ChatAssistantAppProps } from './dashboard/ChatAssistantApp';
// Version + branded title (package.json `version`, injected as __APP_VERSION__ by
// vite.config.ts / vitest.config.ts) so a host page can label the build without
// parsing the bundle.
export { APP_VERSION, PRODUCT_TITLE } from './version';
// Shared stroke-based SVG icon family, exported for reuse by embedders.
export * from './icons';

// ——— the transport the UI speaks ————————————————————————─────────────────────────
// The transport-neutral conversation model (the shapes the workstation renders),
// the typed harness client, this package's own stream client, and the offline
// store + SSE provider client that survived the rebuild unchanged.
export {
    CONVERSATION_POLL_INTERVAL_MS,
    TRACKED_CONVERSATIONS_KEY,
    DEFAULT_CONVERSATION_TITLE,
    deriveConversationTitle,
    readTrackedConversationIds,
    storeTrackedConversationIds,
    trackConversationId,
    untrackConversationId
} from './api/conversation';
export type {
    ChatMessage,
    ConversationDeleteResponse,
    ConversationGetResponse,
    ConversationListResponse,
    ConversationPostRequest,
    ConversationPostResponse,
    ConversationPutRequest,
    ConversationRecord,
    ConversationStatus,
    ConversationSummary
} from './api/conversation';
export {
    HARNESS_CHAT_PRESET,
    harnessApiRoot,
    harnessApiRootSetting,
    harnessApiUrl,
    configureHarnessApiRoot,
    streamSocketUrl,
    listHarnessConversations,
    readHarnessConversation,
    createHarnessConversation,
    deleteHarnessConversation,
    submitHarnessTask,
    cancelHarnessRun,
    readHarnessModels,
    readHarnessSystemPrompt,
    writeHarnessSystemPrompt
} from './api/harness';
export {
    createHarnessStream,
    HARNESS_WS_SUBPROTOCOL,
    isTerminalTurnStatus
} from './api/harness-stream';
export type {
    HarnessStreamHandle,
    HarnessStreamOptions,
    StreamSocket,
    StreamSocketFactory,
    StreamStatus
} from './api/harness-stream';
export {
    loadAssistantSettings,
    saveAssistantSettings,
    createLocalConversation,
    getLocalConversation,
    listLocalConversations,
    appendToLocalConversation,
    replaceLocalConversationMessages,
    deleteLocalConversation
} from './api/offline';
export type { AssistantMode, AssistantSettings } from './api/offline';

// ——— the workstation itself ————————————————————————————──────────────────────────
export * from './dashboard';
