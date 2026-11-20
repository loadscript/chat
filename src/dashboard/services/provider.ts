// Provider SERVICE facade for the dashboard plugins — the streaming half of the
// transport seam.
//
// TWO IMPLEMENTATIONS OF ONE INTERFACE, chosen by the mode the flow started in:
//
//   - `createProviderClient(base)`      OFFLINE mode: the OpenAI-compatible SSE
//     client in ../../api/provider.ts (`GET {base}/models`,
//     `POST {base}/chat/completions` with a streamed body). Unchanged behavior
//     (R3): every request still goes through that module — the reader loop, the
//     `[DONE]`/usage frames, the mid-stream error rejection and the usage opt-in
//     are NOT reimplemented here. This facade only pins one base per client,
//     projects the catalog into the picker shapes the UI needs, and adds abort
//     semantics.
//
//   - `createHarnessProviderClient()`   ONLINE mode: the harness conversation
//     plane. `catalog()` is `POST /models` (discovery is a POST because it takes
//     a settings body), and `stream()` is `POST /sessions/{id}/tasks` plus the
//     `harness.v1` update stream — the deltas arrive as `display.ops`
//     `node:append` on the TURN scope, and the turn ends on the session scope's
//     terminal `turn.upsert`.
//
// WHY ONE INTERFACE SURVIVES TWO VERY DIFFERENT PROTOCOLS: the send pipeline
// (plugins/source.ts) needs exactly three things from a transport — a catalog,
// "answer this text and show me the deltas", and "stop". Handing the harness
// session id to that contract (the new optional `sessionId`) is what makes the
// online transport express itself through it, instead of forking the send flow in
// two. A harness stream is NOT a request-scoped pipe like an SSE response: the
// RUN belongs to the session and keeps executing when the socket drops, which is
// why `abort` maps to `POST /sessions/{id}/cancel` rather than to closing a
// socket, and why the partial text survives a cancelled run.
//
// MODEL LABELS — WHY THE ID AND THE LABEL ARE SEPARATE LISTS
// The provider registry routes by the FULL id (`openai/gpt-5.6-sol`), so
// `catalog()` keeps the complete ids as its VALUES — stripping the prefix from
// the values would both break routing and collapse the gateways that serve the
// same base model through different prefixes (`modal/glm-5.3-flash` vs
// `vultr/glm-5.3-flash`). Only the LABELS are shortened, exactly as the shipped
// UI does (components/ChatAssistantApp.tsx:1744-1783): a prefixed id displays
// "base (provider)" and a prefixless id displays the bare name. `labels()` is
// index-aligned with `catalog()`, which is the array form of the component's
// id → label Map (`uniqueModelLabels`).
//
// SORTING follows the shipped rule too: by the STRIPPED model name, so the
// dropdown order and a fresh browser's default model follow model names rather
// than organisation prefixes (components/ChatAssistantApp.tsx:2770-2774).
import { isString } from '@presource/core';
import { fetchProviderModels, streamProviderChatCompletion } from '../../api/provider';
import {
    cancelHarnessRun,
    entryAgentId,
    listHarnessThreads,
    readHarnessModels,
    readHarnessTurnText,
    selectConversationThread,
    setHarnessConversationModel,
    streamSocketUrl,
    submitHarnessTask,
    usageFromHarness
} from '../../api/harness';
import {
    createHarnessStream,
    isTerminalTurnStatus,
    type HarnessStreamHandle,
    type HarnessTurnFrame,
    type StreamScheduler,
    type StreamSocketFactory
} from '../../api/harness-stream';
import type { ChatMessage, ConversationRecord } from '../../api/conversation';

// Token accounting reported by a completion. Derived from the wire type rather
// than redeclared, so it can never drift from what storage persists
// (`ConversationRecord['usage']` in ../../api/conversation.ts).
export type ChatUsage = NonNullable<ConversationRecord['usage']>;

// One streamed completion request. Offline `messages` is the full conversation
// history; ONLINE the harness owns the history, so only the LAST user turn is
// sent and `sessionId` names the conversation that must exist already (the send
// flow creates it first — see plugins/source.ts). `signal` cancels the request:
// offline it aborts the fetch, online it issues the session cancel.
export interface ProviderStreamRequest {
    model: string;
    messages: ChatMessage[];
    sessionId?: string;
    signal?: AbortSignal;
    // Receives the ACCUMULATED assistant text after every content delta — the
    // exact snapshot contract of api/provider.ts's `onSnapshot`.
    onDelta: (accumulated: string) => void;
}

// Settled stream outcome. `aborted` is true when the caller's signal cancelled
// the request; `content` then holds whatever arrived before the cancellation
// (possibly an empty string) and `usage` is absent, because a cancelled stream
// never delivered its final usage frame.
export interface ProviderStreamResult {
    content: string;
    usage?: ChatUsage;
    aborted: boolean;
}

// The provider contract every chat plugin consumes.
export interface ProviderClient {
    catalog(): Promise<string[]>;
    labels(): Promise<string[]>;
    stream(request: ProviderStreamRequest): Promise<ProviderStreamResult>;
}

// Readable, actionable failure for a blank provider base. The shipped UI never
// calls the default app server when the configured offline base is empty
// (components/ChatAssistantApp.tsx:4003-4008); the facade keeps that guard so a
// misconfigured plugin cannot issue a silent request to the wrong origin.
export const PROVIDER_BASE_REQUIRED =
    'Configure the provider base URL (for example, http://192.168.50.109:8800/providers/private/v1) to load the model catalog and stream replies — the catalog lives under its /models route and replies stream from /chat/completions; no request is sent while the base is blank.';

// The online equivalent of the same guard: a harness turn runs INSIDE a
// conversation, so a send that reaches the transport without one is a plumbing
// bug rather than a configuration problem, and it says so.
export const SESSION_REQUIRED =
    'This conversation was not created before the reply was requested, so the harness server has nothing to run the turn in.';

// Canonical base form: trimmed and stripped of trailing slashes (the same
// normalization api/offline.ts and api/provider.ts apply, so the derived routes
// can never double-slash).
const normalizeBaseUrl = (value: string): string => value.trim().replace(/\/+$/, '');

// Strip the organisation/provider prefix: "zai-org/GLM-5.2-NVFP4" reads
// "GLM-5.2-NVFP4". Mirrors `modelLabel` (components/ChatAssistantApp.tsx:1748
// -1751) — the split point is the FINAL slash.
const strippedModelId = (id: string): string => {
    const slash = id.lastIndexOf('/');

    return slash >= 0 ? id.slice(slash + 1) : id;
};

// Display label for one id: "base (provider)" for a prefixed id, the bare name
// otherwise (prefixless ids have no provider to show). Mirrors
// `uniqueModelLabels` (components/ChatAssistantApp.tsx:1772-1783).
const modelDisplayLabel = (id: string): string => {
    const slash = id.lastIndexOf('/');

    return slash >= 0 ? `${strippedModelId(id)} (${id.slice(0, slash)})` : strippedModelId(id);
};

/**
 * The picker projection of ANY raw catalog: drop blank ids, dedupe (a repeated
 * id would duplicate a `<select>` option key), and sort by the STRIPPED name so
 * the order follows model names rather than organisation prefixes. Shared by
 * both transports, because the rule is a UI rule, not a wire rule.
 */
export const projectCatalog = (ids: readonly unknown[]): string[] => {
    const unique: string[] = [];

    for (const candidate of ids) {
        if (!isString(candidate) || candidate.length === 0) continue;
        if (unique.includes(candidate)) continue;
        unique.push(candidate);
    }

    // Stable sort: rows with an identical stripped name keep the order the
    // provider returned them in, which is what keeps the list deterministic.
    return unique.sort((left, right) => strippedModelId(left).localeCompare(strippedModelId(right)));
};

// True when a rejection is the platform's abort signal rather than a provider
// failure. undici/jsdom surface a cancelled fetch as a DOMException named
// 'AbortError' (some engines use 'TimeoutError' for a timed abort), and
// DOMException does NOT extend Error — so the name is read structurally. The
// api client rethrows the reason untouched, so the name survives to here.
// (A plain `typeof === 'object'` guard, not @presource/core's `isObject`, which
// accepts ONLY plain objects and would reject both Error and DOMException.)
const isAbortError = (reason: unknown): boolean => {
    if (typeof reason !== 'object' || reason === null) return false;
    const name = (reason as { name?: unknown }).name;

    return name === 'AbortError' || name === 'TimeoutError';
};

// Normalize any thrown value into a readable Error. The api client already
// rejects with server-provided text ("Model 'x' not found", the mid-stream
// error frame's message), so an Error passes through untouched; a DOMException
// keeps its own `message`, and only a value with no message at all is
// stringified.
const readableError = (reason: unknown): Error => {
    if (reason instanceof Error) return reason;
    const message = typeof reason === 'object' && reason !== null
        ? (reason as { message?: unknown }).message
        : undefined;

    return new Error(isString(message) && message.length > 0 ? message : String(reason));
};

// ---------------------------------------------------------------------------
// OFFLINE: the OpenAI-compatible SSE client
// ---------------------------------------------------------------------------

// Build a provider client bound to one base URL. Pass the offline Settings
// `providerBase` — the standard routes derive from it identically to the way
// they derived from the old online relay base.
export function createProviderClient(baseUrl: string): ProviderClient {
    const base = normalizeBaseUrl(baseUrl);

    // Every request needs a base; failing loudly beats a relative call that
    // lands on the hosting origin (the static-host 404 trap the pre-rebuild
    // build documented in api/server-url.ts).
    const requireBase = (): void => {
        if (base.length === 0) throw new Error(PROVIDER_BASE_REQUIRED);
    };

    // Routing ids of the catalog, deduplicated and sorted by stripped name. The
    // envelope parsing lives in api/provider.ts (`fetchProviderModels`), which
    // also owns the error surface for a failed catalog request.
    const fetchCatalog = async (): Promise<string[]> => {
        requireBase();
        const models = await fetchProviderModels(base);

        return projectCatalog(models.map((entry) => (entry as { id?: unknown })?.id));
    };

    return {
        catalog: fetchCatalog,

        labels: async (): Promise<string[]> => (await fetchCatalog()).map(modelDisplayLabel),

        stream: async (request: ProviderStreamRequest): Promise<ProviderStreamResult> => {
            // An already-cancelled signal never reaches the network at all.
            if (request.signal?.aborted) return { content: '', aborted: true };
            requireBase();

            // The api client hands out ACCUMULATED snapshots; keeping the last
            // one locally is what lets an aborted stream still return the text
            // the user watched arrive instead of discarding it.
            let accumulated = '';

            try {
                const result = await streamProviderChatCompletion(
                    base,
                    request.model,
                    request.messages,
                    (content: string) => {
                        accumulated = content;
                        request.onDelta(content);
                    },
                    request.signal
                );

                // `usage` is only spread when present so the resolved object
                // never carries an explicit undefined (providers that emit no
                // usage frame resolve as `{ content, aborted: false }`).
                return {
                    content: result.content,
                    ...(result.usage ? { usage: result.usage } : {}),
                    aborted: false
                };
            } catch (reason) {
                // Abort is a normal outcome, not a failure: resolve with the
                // partial text and let the caller keep it in the composer.
                if (request.signal?.aborted || isAbortError(reason)) {
                    return { content: accumulated, aborted: true };
                }
                // Pre-stream non-2xx and mid-stream error frames keep rejecting
                // with the provider's own readable message.
                throw readableError(reason);
            }
        }
    };
}

// ---------------------------------------------------------------------------
// ONLINE: the harness conversation client
// ---------------------------------------------------------------------------

export type HarnessProviderOptions = {
    /** The WebSocket seam (a test injects a double; production uses the platform socket). */
    socketFactory?: StreamSocketFactory;
    /** Injectable clock for the stream's reconnect/heartbeat timing. */
    schedule?: StreamScheduler;
    /**
     * Open one stream observation. Overridable so a test can hand back a fake
     * handle and drive `onText`/`onTurn` on purpose.
     */
    openStream?: (input: {
        sessionId: string;
        /** The conversation's ENTRY agent id — the identity the stream's answer fold keys on (api/harness.ts `entryAgentId`). */
        entryAgentId: string;
        events: Parameters<typeof createHarnessStream>[0]['events'];
        socketUrl: string;
        socketFactory?: StreamSocketFactory;
        schedule?: StreamScheduler;
    }) => HarnessStreamHandle;
};

/** The text the model is asked to answer: the LAST user turn of the history. */
const lastUserInput = (messages: readonly ChatMessage[]): string => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role === 'user') return message.content;
    }

    return '';
};

/**
 * Build the online provider client.
 *
 * It is stateful in exactly two caches, both keyed by session and both
 * per-client-instance (a mode switch rebuilds the facade):
 *   - the model last APPLIED to a session, so a picker that did not move costs
 *     no PATCH, and
 *   - the thread that holds the conversation, because a harness submit without a
 *     thread id opens a NEW standalone thread every time, which would give every
 *     message a fresh, context-free conversation.
 */
export function createHarnessProviderClient(options: HarnessProviderOptions = {}): ProviderClient {
    const models = new Map<string, string>();
    const threads = new Map<string, string>();

    const fetchCatalog = async (): Promise<string[]> => projectCatalog(await readHarnessModels());

    return {
        catalog: fetchCatalog,

        labels: async (): Promise<string[]> => (await fetchCatalog()).map(modelDisplayLabel),

        stream: async (request: ProviderStreamRequest): Promise<ProviderStreamResult> => {
            if (request.signal?.aborted) return { content: '', aborted: true };

            const sessionId = request.sessionId ?? '';

            if (sessionId.length === 0) throw new Error(SESSION_REQUIRED);

            const input = lastUserInput(request.messages);

            if (input.trim().length === 0) throw new Error('There is no user turn to send.');

            // ---- the model pick is a SESSION setting online -------------------
            // The old transport carried `model` in every request body. The
            // harness routes by the session's agent model, so a changed pick is
            // one PATCH; an unchanged pick costs nothing. A failed PATCH rejects
            // before the submit, which is what keeps a stale pick from silently
            // answering with another model.
            if (request.model.length > 0 && models.get(sessionId) !== request.model) {
                await setHarnessConversationModel(sessionId, request.model);
                models.set(sessionId, request.model);
            }

            // ---- the thread keeps the conversation continuous ------------------
            // Unknown on the first send of a REOPENED session: resolve it from
            // the roster once, then remember it.
            let threadId = threads.get(sessionId);

            if (threadId === undefined) {
                const roster = await listHarnessThreads(sessionId);
                const thread = selectConversationThread(roster.items);

                if (thread !== null) threadId = thread.id;
            }

            // ---- the ENTRY agent, before the first delta -----------------------
            // The stream decides "is this delta part of the answer" by IDENTITY
            // (api/harness.ts `isAnswerSection`: root-shaped AND the entry agent's
            // flow), because a delegated lane can be recorded parentless. It therefore
            // needs the entry id BEFORE the first `section:open` arrives, so the
            // definition read happens here rather than inside the fold. It is cached
            // per session (`entryAgentId`), and the model PATCH above already resolved
            // it on a normal send, so this normally costs no extra request.
            const entryAgent = await entryAgentId(sessionId);

            // ---- open the observation BEFORE the submit ------------------------
            // The session scope carries `turn.upsert` (which ends the answer);
            // the deltas ride the turn scope, whose id only the receipt names —
            // so the turn scope is added the moment the receipt lands. Opening
            // the socket first is what makes the start-of-run frame impossible to
            // miss.
            let accumulated = '';
            let cancelled = false;
            let usage: ChatUsage | undefined;
            let turnId = '';

            const events: NonNullable<Parameters<typeof createHarnessStream>[0]['events']> = {
                onText: (text: string): void => {
                    accumulated = text;
                    request.onDelta(text);
                },
                onTurn: (turn: HarnessTurnFrame): void => {
                    // Only THIS turn ends this request: a steer or a sibling
                    // thread can publish other rows on the same session scope.
                    if (turnId !== '' && turn.id !== turnId) return;
                    if (turnId === '') turnId = turn.id;
                    if (turn.usage !== undefined) usage = usageFromHarness(turn.usage);
                    if (!isTerminalTurnStatus(turn.status)) return;

                    if (turn.status === 'error') {
                        settle(() => reject(new Error(turn.detail ?? 'The harness run failed.')));

                        return;
                    }

                    settle(() => resolveResult(turn.status === 'cancelled'));
                }
            };

            const handle = (options.openStream ?? defaultOpenStream)({
                sessionId,
                entryAgentId: entryAgent,
                events,
                socketUrl: streamSocketUrl(),
                ...(options.socketFactory === undefined ? {} : { socketFactory: options.socketFactory }),
                ...(options.schedule === undefined ? {} : { schedule: options.schedule })
            });

            // The promise is wired after the handle exists because the cancel
            // path and the error path both have to close the socket.
            let settle: (run: () => void) => void = (): void => undefined;
            let resolveResult: (aborted: boolean) => void = (): void => undefined;
            let reject: (reason: unknown) => void = (): void => undefined;

            const result = new Promise<ProviderStreamResult>((resolve, rejectReason) => {
                resolveResult = (aborted: boolean): void => {
                    handle.close('turn complete');
                    resolve({
                        content: accumulated,
                        ...(usage === undefined ? {} : { usage }),
                        aborted
                    });
                };
                reject = rejectReason;
                settle = (run: () => void): void => {
                    if (settled) return;
                    settled = true;
                    run();
                };
            });

            let settled = false;

            // The Stop button: the RUN is cancelled server-side (a dropped
            // socket never cancels, and neither should closing an observation
            // here), and whatever arrived before the stop is KEPT — the same
            // partial-text contract the SSE client has.
            const onAbort = (): void => {
                if (settled) return;
                cancelled = true;
                void cancelHarnessRun(sessionId).then(
                    () => undefined,
                    () => undefined
                );
                settle(() => resolveResult(true));
            };

            if (request.signal !== undefined) {
                if (request.signal.aborted) onAbort();
                else request.signal.addEventListener('abort', onAbort, { once: true });
            }

            try {
                const receipt = await submitHarnessTask(sessionId, input, threadId);

                turnId = receipt.turn_id;
                threads.set(sessionId, receipt.thread_id);
                handle.followTurn(receipt.turn_id);

                // The receipt already says the turn is OVER (a scripted preset
                // that finishes before this socket upgrades, or a folded steer
                // that settled instantly): no future frame will end the request,
                // so settle from the canonical display instead of waiting for a
                // terminal frame that has already been published.
                if (isTerminalTurnStatus(receipt.status)) {
                    const text = await readHarnessTurnText(sessionId, turnId).catch(() => '');

                    settle(() => {
                        if (accumulated.length === 0 && text.length > 0) {
                            accumulated = text;
                            request.onDelta(text);
                        }
                        resolveResult(receipt.status === 'cancelled' || cancelled);
                    });

                    return result;
                }

                // A turn that was ALREADY streaming when this observation opened
                // (a re-opened conversation, or a socket that connected after the
                // first deltas were published) missed the ops that ran before its
                // turn scope existed. One bounded display re-read closes that
                // window, and the stream's own gap handling covers the rest.
                if (accumulated.length === 0) handle.requestResync(receipt.turn_id);
            } catch (reason) {
                settle(() => {
                    handle.close('submit failed');
                    reject(readableError(reason));
                });

                return result;
            }

            return result;
        }
    };
}

// The production stream opener: this package's own client (api/harness-stream),
// dialed at the harness stream URL the REST layer resolves.
const defaultOpenStream: NonNullable<HarnessProviderOptions['openStream']> = (input) =>
    createHarnessStream({
        sessionId: input.sessionId,
        entryAgentId: input.entryAgentId,
        socketUrl: input.socketUrl,
        events: input.events,
        ...(input.socketFactory === undefined ? {} : { socketFactory: input.socketFactory }),
        ...(input.schedule === undefined ? {} : { schedule: input.schedule })
    });

// Re-exported for the surfaces that label a provider row.
export { modelDisplayLabel, strippedModelId };
