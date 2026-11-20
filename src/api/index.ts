// API barrel — keeps browser callers independent from the wire-format module path.
//
// The rebuild (R1/R2) replaced the two absolute-LAN REST clients
// (`chat-assistant.ts` for conversation storage, `server-url.ts` + `config.ts`
// for the pinned backend origins) with:
//
//   conversation    - the TRANSPORT-NEUTRAL conversation model (message/record/
//                     summary shapes, the tracked-id cache, the title rule, the
//                     poll cadence). Both transports speak it; neither owns it.
//   harness         - the typed wrapper over `@loadscript/harness`: same
//                     origin by default, plus the wire -> view-model projections.
//   harness-stream  - this package's own `harness.v1` WebSocket client (live
//                     deltas, turn rows, gap resync, heartbeat-aware reconnect).
//   offline         - the no-server mode: AssistantSettings + the durable
//                     browser-local store (unchanged behavior, R3).
//   provider        - the OpenAI-compatible SSE client OFFLINE mode streams
//                     through (unchanged behavior, R3).
//   speech          - the Web Speech wrapper for the composer's voice toggle.
export * from './conversation';
export * from './harness';
export * from './harness-stream';
export * from './offline';
export * from './provider';
export * from './speech';
