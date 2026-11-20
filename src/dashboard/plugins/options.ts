// Chat plugin options — the ONE place the deployment configuration enters the
// chat graph.
//
// WHY THIS FILE EXISTS: `chatPlugins` is a module-level array (the composition
// seam other code reads), so per-dashboard values cannot be threaded through the
// array itself. They are threaded through the option object instead: every chat
// plugin factory takes this same resolved shape, and `createChatPlugins()` builds
// the array from it. That keeps `chat.ts` a fixed export while still letting a
// test point the transport at its own doubles.
//
// WHAT CHANGED IN THE HARNESS REBUILD (R1/R2): the two absolute LAN endpoints
// this file used to resolve are gone.
//
//   old `baseUrl`    -> `{lan}/v1/chat-assistant/conversation`  (deleted API)
//   old `providerUrl`-> `{lan}:8800/providers/private/v1`       (online relay)
//
// Online mode now dials ONE same-origin root — `/v1/harness` on whatever host
// served this page — and the harness client resolves it at module load (saved
// setting -> injected config -> build-time env -> the canonical relative root).
// So `baseUrl` is no longer a per-request string: it is the DECLARED root, which
// this package persists through the harness client's own setting
// (`configureHarnessApiRoot` in ../api/harness.ts) and reports to the settings
// surface. A reload makes a changed root take effect, because every request URL
// and the socket URL are built from the single resolved value — that is a
// property of the harness client, and this file states it rather than fighting
// it with a second URL join.
//
// `providerUrl` keeps its OLD meaning but its scope shrank to what it is now:
// the base OFFLINE mode streams through when the operator has configured
// nothing. Online inference is the server's provider, never a browser default.
//
// `stream` is the new seam that matters for tests: the WebSocket client is
// injected rather than discovered, so a suite can drive `welcome` /
// `subscription_state` / `update` frames deterministically instead of dialing a
// port. `pollIntervalMs` survives for OFFLINE only — the online in-flight
// conversation is followed by the stream, not by a timer.
import { DEFAULT_PROVIDER_URL } from '../../api/provider';
import { CONVERSATION_POLL_INTERVAL_MS } from '../../api/conversation';
import type { StreamScheduler, StreamSocketFactory } from '../../api/harness-stream';

export type ChatPluginOptions = {
    /** The declared harness API root (default: the harness client's own resolution). */
    baseUrl?: string;
    /** Provider base OFFLINE mode streams through (default DEFAULT_PROVIDER_URL). */
    providerUrl?: string;
    /**
     * Poll cadence for an in-flight ('pending') conversation. OFFLINE mode only
     * (online settles through the stream). Defaults to
     * `CONVERSATION_POLL_INTERVAL_MS`; overridable so a test drives the poller on
     * a 5ms clock instead of waiting two real seconds.
     */
    pollIntervalMs?: number;
    /** The WebSocket seam (factory + clock). Omitted = the platform WebSocket + setTimeout. */
    stream?: { socketFactory?: StreamSocketFactory; schedule?: StreamScheduler };
};

export type ChatConfig = {
    baseUrl: string;
    providerUrl: string;
    pollIntervalMs: number;
    stream: { socketFactory?: StreamSocketFactory; schedule?: StreamScheduler };
};

/** Fill every option with its documented default. */
export const describeChatOptions = (options: ChatPluginOptions = {}): ChatConfig => ({
    // A blank/whitespace override means "not configured" and falls back to the
    // automatic same-origin root, expressed as the empty string: the caller
    // (ChatAssistantApp / the settings surface) distinguishes "declared" from
    // "automatic" and never writes an empty override into storage.
    baseUrl: (options.baseUrl ?? '').trim(),
    providerUrl: (options.providerUrl ?? '').trim() || DEFAULT_PROVIDER_URL,
    pollIntervalMs:
        options.pollIntervalMs !== undefined && options.pollIntervalMs > 0
            ? options.pollIntervalMs
            : CONVERSATION_POLL_INTERVAL_MS,
    stream: options.stream ?? {}
});
