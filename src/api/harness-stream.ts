// The live update stream: THIS package's WebSocket client for the harness
// realtime plane (R2 — send -> streamed reply -> stop).
//
// WHY THIS FILE EXISTS: the harness package ships a browser stream client
// (`src/frontend/stream.ts`) but does NOT publish it — the `@underload/harness/
// frontend` barrel exports the REST surface only, and `createHarnessStream` is
// shell-private. So the client is re-implemented here, against the PUBLISHED
// contract: the frame vocabulary lives in `src/shared/harness-stream.ts` in the
// harness package and has no exports subpath of its own (`@underload/harness/
// shared` re-exports origin/attachments/agent-results only), so the frames this
// client consumes are re-declared below, each with a source-path comment.
//
// WHAT THIS CLIENT IS, precisely: ONE socket per observation, opened with the
// `harness.v1` subprotocol against `streamSocketUrl()` (the same origin, the same
// `/v1/harness` root, and `/stream` on the end — no second port, no SSE). It
// subscribes to the SCOPES a caller cares about:
//
//   session scope  -> `turn.upsert` (one whole TurnSummary row, sent when the
//                     turn starts and at EVERY terminal transition),
//                     `session.updated`, `usage.updated`, `transcript.updated`
//   turn scope     -> `display.ops` — the token-level deltas. They ride ONLY the
//                     turn scope (spec: <=32 ops per frame, `node:append` capped
//                     at 2000 chars), which is why a streaming answer needs a
//                     turn subscription and not just the session one.
//
// THE FOUR RULES THAT MAKE IT CORRECT (each one is a bug the naive version has):
//   1. `sequence` is monotonic per subscription. A frame with `sequence > want`
//      is a GAP: this client re-subscribes that subscription from its last
//      cursor AND reports a `frames_dropped` resync, because quietly continuing
//      renders a wrong answer.
//   2. `resync_required` (reason cursor_expired | epoch_mismatch |
//      frames_dropped) converges through a BOUNDED REST re-read of exactly the
//      resource named — here `readHarnessTurnText`, i.e. `GET
//      .../turns/{id}/display` — never a history snapshot boot.
//   3. A dropped socket NEVER cancels the server-side run. Execution is
//      server-owned; this closes and re-opens an OBSERVATION, and reconnects
//      with capped exponential backoff plus jitter, resuming with a `hello`
//      {epoch, cursor} sent as the FIRST frame (a late `hello` is refused).
//   4. Liveness is the contract's own heartbeat budget: three intervals of
//      silence closes this side with 4408 and dials again. A browser gives no
//      timeout for a half-open socket, so without this a stalled stream would
//      hang the composer's Stop button forever.
//
// The accumulated answer is rebuilt from the ops (not from a per-frame string):
// `node:insert` records each node's KIND and initial text, `node:append` adds a
// delta to one node, `node:remove`/`attempt:discard` drop exactly the nodes they
// name, and only TEXT nodes of the ENTRY agent's ROOT-SHAPED flows (a section with
// NO `parentSectionId` whose `agent` is the entry — the same rule
// `isAnswerSection` applies to the REST read) reach `onText`. Reasoning
// deltas go to a separate buffer so a future surface can show them without the
// answer mixing them in.
import type { AgentRank } from '@underload/harness';

import { isAnswerSection, readHarnessTurnText } from './harness';

// ---------------------------------------------------------------------------
// Re-declared frame vocabulary (source: packages/underload/harness/src/shared/
// harness-stream.ts — GENERATED from src/server/harness.swagger.yaml)
// ---------------------------------------------------------------------------

/** The negotiated subprotocol. Source: src/shared/harness-api.ts:42. */
export const HARNESS_WS_SUBPROTOCOL = 'harness.v1';

/** `WsSubscriptionScope` — the four addressable scopes. Source: harness-stream.ts:201. */
export type WsScope = 'global' | 'session' | 'thread' | 'turn';

/**
 * `WsStreamLimits` (the subset this client ACTS on), re-stated at the contract's
 * defaults so a `welcome` frame only has to OVERRIDE them. A deployment that
 * tunes a value inside its declared bounds is therefore followed without a
 * rebuild. Source: harness-stream.ts:28-49.
 */
export const HARNESS_WS_LIMITS = {
    heartbeat_interval_ms: 15000,
    heartbeat_timeout_intervals: 3,
    heartbeat_timeout_close_code: 4408,
    ops_per_update_frame: 32,
    delta_chars_per_append_op: 2000
} as const;

/** `WsWelcome` (harness-stream.ts:470) — the first server frame. */
type WsWelcome = {
    type: 'welcome';
    protocol: string;
    epoch: string;
    at: number;
    // `WsStreamLimits` in full; only the heartbeat triple is read here, and the
    // index signature is what lets a future bound arrive without a type break.
    limits?: Record<string, number>;
};

/** `WsSubscriptionState` (harness-stream.ts:502) — one subscription's baseline. */
type WsSubscriptionState = {
    type: 'subscription_state';
    subscription_id: string;
    scope: WsScope;
    epoch: string;
    sequence: number;
    cursor: string;
    revisions?: unknown[];
    publishes?: string[];
    replayed_frames?: number;
};

/**
 * `TurnDisplayOp` (harness-stream.ts:141) — one addressed display mutation.
 * Only the fields this client reads are declared; an unknown `op` is data to
 * tolerate, never a failure.
 */
type WsDisplayOp = {
    op: string;
    turnId?: string;
    sectionId?: string;
    nodeId?: string;
    nodeIds?: string[];
    delta?: string;
    index?: number;
    section?: {
        id?: string;
        /**
         * The RANK of this section's agent ('A'–'Z', A highest; `TurnSection.rank`,
         * harness turn-display.ts:1050). It REPLACED the old `role: 'primary' |
         * 'subagent'`, and this client reads it WITHOUT grouping by it: rank is the
         * authority an agent holds, several sections may carry the same letter, and
         * the entry agent may hold any letter — a rank filter would fold the wrong
         * flows in BOTH directions. Display data only; the answer predicate is
         * `agent` + nesting (see `isAnswerSection` in ./harness.ts).
         */
        rank?: AgentRank;
        /** Server-resolved nesting (`TurnSection.parentSectionId`, turn-display.ts:1046): absent = root-shaped. */
        parentSectionId?: string;
        /** The agent this flow belongs to (`TurnSection.agent`) — the field the answer
         *  predicate tests against the conversation's ENTRY agent, because a DELEGATED
         *  lane can be root-shaped: the runtime records some of them with no lineage
         *  (turn-projector.ts:1395-1407, :1595-1610) and a threadless stream mints an
         *  `inline:<agent>` row. Optional here only because this module re-declares the
         *  frame; a section that names no agent is the CHILD side. */
        agent?: string;
    };
    node?: { id?: string; kind?: string; text?: string };
};

/** The subset of `TurnSummary` (harness-api.ts:1872) a consumer reads. camelCase by contract. */
export type HarnessTurnFrame = {
    id: string;
    index: number;
    status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
    state?: string;
    threadId?: string;
    updatedAt: number;
    usage?: { input: number; output: number; total: number; cached?: number };
    detail?: string;
};

/** `WsUpdate` variants this client routes (harness-stream.ts:530/561/577/590). */
type WsUpdate = {
    type: 'update';
    subscription_id: string;
    sequence: number;
    cursor: string;
    kind: string;
    at: number;
    turn?: HarnessTurnFrame;
    turn_id?: string;
    ops?: WsDisplayOp[];
    usage_patch?: { input?: number; output?: number; total?: number; cached?: number };
    session?: Record<string, unknown>;
};

/** `WsResyncRequired` (harness-stream.ts:778). */
type WsResyncRequired = {
    type: 'resync_required';
    subscription_id: string;
    reason: 'cursor_expired' | 'epoch_mismatch' | 'frames_dropped';
    epoch: string;
    cursor: string;
    lost_frames?: number;
    resources?: Array<{ resource: string; id: string | null; revision: number; epoch: string; link: string }>;
};

/** `WsProtocolError` (harness-stream.ts:796). */
type WsProtocolError = {
    type: 'error';
    code: string;
    message: string;
    subscription_id?: string;
    retryable: boolean;
    close_code?: number;
};

type WsServerFrame = WsWelcome | WsSubscriptionState | WsUpdate | WsResyncRequired | WsProtocolError | { type: string; at?: number };

/** The client frames this module ever sends (harness-stream.ts:310/457/479/541). */
type WsClientFrame =
    | { type: 'hello'; protocol: string; epoch: string; cursor: string }
    | {
          type: 'subscribe';
          subscription_id: string;
          scope: WsScope;
          session_id?: string;
          turn_id?: string;
          pace?: 'ordered' | 'ack';
          cursor?: string;
      }
    | { type: 'unsubscribe'; subscription_id: string }
    | { type: 'bye'; reason?: string };

// ---------------------------------------------------------------------------
// The socket seam (structural, so a test double satisfies it without pretending
// to be a browser — the same discipline the harness client documents)
// ---------------------------------------------------------------------------

export type StreamSocket = {
    send(data: string): void;
    close(code?: number, reason?: string): void;
    onopen: (() => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onerror: (() => void) | null;
    onclose: ((event: { code?: number; reason?: string }) => void) | null;
};

export type StreamSocketFactory = (url: string, protocol: string) => StreamSocket;

/** `(fn, ms) => cancel` — injectable clock, so a test fires a deadline on demand. */
export type StreamScheduler = (fn: () => void, ms: number) => () => void;

export type StreamStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** The reason an observation asked the caller to re-read. */
export type StreamResyncReason = 'cursor_expired' | 'epoch_mismatch' | 'frames_dropped' | 'reconnected';

export type HarnessStreamEvents = {
    /** The ACCUMULATED answer after every delta — the TEXT of the ENTRY agent's root-shaped flows only (the same snapshot contract the old SSE client gave the UI). */
    onText?: (text: string, turnId: string) => void;
    /** The accumulated reasoning text, kept apart from the answer. */
    onReasoning?: (text: string, turnId: string) => void;
    /** One whole turn row (start + every terminal transition). */
    onTurn?: (turn: HarnessTurnFrame) => void;
    /** A usage patch (per-turn or per-session figure). */
    onUsage?: (usage: { input?: number; output?: number; total?: number; cached?: number }, turnId?: string) => void;
    /** A session metadata patch (`session.updated`) — the sidebar follows the status here. */
    onSession?: (patch: Record<string, unknown>) => void;
    /** The transcript of a thread changed (counts only) — a reader re-reads the record. */
    onTranscript?: (payload: unknown) => void;
    /** Connection lifecycle, for the composer's "reconnecting" affordance and for tests. */
    onStatus?: (status: StreamStatus) => void;
    /** This client asked for (or the server demanded) a bounded re-read. */
    onResync?: (reason: StreamResyncReason, turnId: string | undefined) => void;
    /** A protocol error naming one of this client's subscriptions. */
    onError?: (error: WsProtocolError) => void;
};

export type HarnessStreamOptions = {
    /** The conversation whose scopes this observation follows. */
    sessionId: string;
    /**
     * The id of this conversation's ENTRY agent (api/harness.ts `entryAgentId`,
     * resolved from the frozen definition BEFORE the socket opens and cached per
     * session). REQUIRED because the answer fold is keyed on ENTRY IDENTITY: only
     * the entry agent's root-shaped flows are the answer the chat pane prints
     * (`isAnswerSection` in ./harness.ts), and the fold must know that before the
     * FIRST delta, not after a REST round trip — the tolerant alternatives (fold
     * whatever is parentless, or fold whatever it cannot classify) are exactly how
     * another agent's prose gets in.
     */
    entryAgentId: string;
    /** Turn scopes to open immediately (a token delta needs one; the session scope alone never carries text). */
    turnIds?: readonly string[];
    events?: HarnessStreamEvents;
    /** Defaults to `new globalThis.WebSocket(url, [subprotocol])`. */
    socketFactory?: StreamSocketFactory;
    /** Defaults to setTimeout/clearTimeout. */
    schedule?: StreamScheduler;
    /** Override the resume state (a host that persisted {epoch, cursor} across reloads). */
    resume?: { epoch: string; cursor: string };
    /**
     * Re-read the canonical answer of one turn. Defaults to the harness display
     * read; injectable so a test asserts the re-read happens without a server.
     */
    readText?: (sessionId: string, turnId: string) => Promise<string>;
    /** Closes the reconnect loop after this many attempts (0 = forever, the default). */
    maxReconnectAttempts?: number;
};

export type HarnessStreamHandle = {
    /** Open the connection (idempotent while connecting/open). */
    connect(): void;
    /** Add one turn scope (a submit learns its turn id after the socket is up). */
    followTurn(turnId: string): void;
    /**
     * Ask for the bounded REST re-read of one turn NOW (the same path a sequence
     * gap takes). A late-joining turn scope uses it to close the window between
     * the submit and the subscription, and a caller can use it after a reconnect.
     */
    requestResync(turnId?: string): void;
    /** The epoch/cursor this client last APPLIED — the resume token, and the figure a caller compares against. */
    resumeState(): { epoch: string | null; cursor: string | null };
    status(): StreamStatus;
    /** The accumulated answer of one turn — the entry agent's root-shaped flows only (what the caller renders on a late mount). */
    textOf(turnId?: string): string;
    /** Clean goodbye: `bye` then close 1000. Subscriptions are released; the RUN is not touched. */
    close(reason?: string): void;
};

// Reconnect backoff: capped exponential with jitter (500ms base, 10s cap) so a
// server restart does not turn every open tab into a thundering redial.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

/** True for the turn states that end a streamed answer. */
export const isTerminalTurnStatus = (status: HarnessTurnFrame['status'] | string): boolean =>
    status === 'done' || status === 'error' || status === 'cancelled';

const defaultSchedule: StreamScheduler = (fn, ms) => {
    const timer = globalThis.setTimeout(fn, ms);

    return () => globalThis.clearTimeout(timer);
};

/** The default factory: the platform WebSocket, or nothing when the host has none. */
const defaultFactory = (): StreamSocketFactory | undefined => {
    const ctor = (globalThis as unknown as {
        WebSocket?: new (url: string, protocols: readonly string[]) => StreamSocket;
    }).WebSocket;

    return typeof ctor === 'function' ? (url, protocol) => new ctor(url, [protocol]) : undefined;
};

// A root-relative socket URL (`/v1/harness/stream`) must be upgraded against
// THIS page's origin; an absolute one already names its host. `streamSocketUrl`
// from the harness client does the same join for the REST root, so the two can
// never disagree — but it needs `location`, which a bare-Node host lacks, hence
// the defensive origin below.
const socketUrlOf = (root: string): string => {
    if (/^wss?:\/\//i.test(root)) return root;
    if (/^https:\/\//i.test(root)) return `wss://${root.slice('https://'.length)}`;
    if (/^http:\/\//i.test(root)) return `ws://${root.slice('http://'.length)}`;

    const origin = globalThis.location?.origin ?? 'http://localhost';

    return `${origin.startsWith('https:') ? 'wss' : 'ws'}://${origin.slice(origin.indexOf('//') + 2)}${root}`;
};

/**
 * Open one stream observation.
 *
 * `socketUrl` is passed in (not read from the module) so the caller owns the
 * root resolution: services/provider.ts hands it `streamSocketUrl()`, and a test
 * hands it anything.
 */
export const createHarnessStream = (
    options: HarnessStreamOptions & { socketUrl: string }
): HarnessStreamHandle => {
    const events = options.events ?? {};
    const schedule = options.schedule ?? defaultSchedule;
    const factory = options.socketFactory ?? defaultFactory();
    const readText = options.readText ?? readHarnessTurnText;
    const maxAttempts = options.maxReconnectAttempts ?? 0;
    // The identity the answer fold keys on (see `HarnessStreamOptions.entryAgentId`):
    // the entry agent's OWN root-shaped flows are the answer, every other agent's
    // prose belongs to its own section. Captured once, because the definition is
    // frozen and this value must be stable for the whole observation.
    const entryAgent = options.entryAgentId;

    // The contract's tunables, re-adopted from the `welcome` frame when it
    // carries them (a deployment may tune inside the declared bounds). The
    // `number` annotations matter: the defaults come from an `as const` object,
    // whose literal types would otherwise refuse the re-adopted value.
    let heartbeatIntervalMs: number = HARNESS_WS_LIMITS.heartbeat_interval_ms;
    let heartbeatTimeoutIntervals: number = HARNESS_WS_LIMITS.heartbeat_timeout_intervals;
    let heartbeatCloseCode: number = HARNESS_WS_LIMITS.heartbeat_timeout_close_code;

    let socket: StreamSocket | undefined;
    let status: StreamStatus = 'idle';
    let attempts = 0;
    let manualClose = false;
    let reconnectCancel: (() => void) | undefined;
    let heartbeatCancel: (() => void) | undefined;

    // Resume state: the epoch of the server this client last spoke to, and the
    // highest cursor it APPLIED. A cursor from an OLD epoch is refused with
    // `epoch_mismatch`, which is the honest answer — and the reason this client
    // then re-reads rather than replays.
    let epoch: string | null = options.resume?.epoch ?? null;
    let cursor: string | null = options.resume?.cursor ?? null;

    // One entry per subscription, keyed by the id THIS client chose.
    type Subscription = {
        id: string;
        scope: WsScope;
        turnId?: string;
        cursor: string | null;
        /** The sequence the NEXT frame must carry, or null when nothing has been seen yet (a fresh baseline cannot "gap"). */
        want: number | null;
    };

    const subscriptions = new Map<string, Subscription>();
    let nextSubscriptionId = 0;

    // The display fold. Everything is keyed by TURN, because one connection can
    // follow several turns (a steer, or a reconnect that re-opens an older one)
    // and a shared fold would interleave two answers.
    //   sectionOwns  — `turn::section` -> does this section's text belong to THE
    //                  ANSWER the chat pane prints? ONE rule, shared with the REST
    //                  read: `isAnswerSection(section, entryAgent)` — the section is
    //                  ROOT-SHAPED (`parentSectionId` absent) AND its `agent` IS the
    //                  conversation's entry agent. Written from `section:open`, whose
    //                  ordering contract guarantees it precedes every op naming that
    //                  section, so a node always knows its section before its first
    //                  delta.
    //                  WHY IDENTITY IS BACK (2026-11-18 repair): the first rank-model
    //                  port folded on NESTING ALONE, and that is strictly more
    //                  inclusive than the retired `role === 'primary'` stamp, which
    //                  also tested `agent === primary` on every non-root row
    //                  (turn-projector.ts inline/child paths). A delegated lane can
    //                  legitimately be parentless — the projector documents lanes
    //                  recorded with no parent/call/kind/branch (:1395-1407), a
    //                  post-restart journal carries only `thread.id` (:1595-1610), and
    //                  a threadless stream from a non-entry agent mints
    //                  `inline:<agent>` — so nesting alone folded that prose into the
    //                  answer. Nesting is still half the rule (a nested flow's text
    //                  belongs to its own pane whatever its agent); identity is the
    //                  other half, and it is the ENTRY agent, never a rank letter: any
    //                  number of members share Rank A, a branch/fork PROPAGATES its
    //                  source agent's rank, and the entry may hold any letter. The
    //                  rank still rides the frame (see `WsDisplayOp`) for display; it
    //                  decides nothing here.
    //   nodes        — `turn::node` -> {kind, text, answer}; the answer is the sum
    //                  of the ANSWER-SIDE `text` nodes in insertion order, which is
    //                  why a `node:remove` or an `attempt:discard` between appends
    //                  can never leave a stale fragment in the text.
    type NodeFold = { kind: string; text: string; answer: boolean; order: number };
    const foldKey = (turnId: string, id: string): string => `${turnId}::${id}`;
    const sectionOwns = new Map<string, boolean>();
    const nodes = new Map<string, NodeFold>();
    const textByTurn = new Map<string, string>();
    const reasoningByTurn = new Map<string, string>();
    let insertOrder = 0;
    // The turn this observation treats as "the answer being streamed" when the
    // caller follows exactly one turn — the fallback key for an op that names no
    // turn of its own.
    let focusTurnId: string | undefined = options.turnIds?.[0];

    const setStatus = (next: StreamStatus): void => {
        if (status === next) return;
        status = next;
        events.onStatus?.(next);
    };

    const send = (frame: WsClientFrame): boolean => {
        if (socket === undefined || status !== 'open') return false;

        try {
            socket.send(JSON.stringify(frame));

            return true;
        } catch {
            // A socket that throws on send is a dead one; the close handler and
            // the reconnect path own the recovery.
            return false;
        }
    };

    const sendSubscribe = (sub: Subscription): void => {
        send({
            type: 'subscribe',
            subscription_id: sub.id,
            scope: sub.scope,
            session_id: options.sessionId,
            ...(sub.scope === 'turn' && sub.turnId !== undefined ? { turn_id: sub.turnId } : {}),
            pace: 'ordered',
            ...(sub.cursor === null || sub.cursor === '' ? {} : { cursor: sub.cursor })
        });
    };

    const openSubscription = (scope: WsScope, turnId?: string): Subscription => {
        nextSubscriptionId += 1;

        const sub: Subscription = {
            id: `ca-${nextSubscriptionId}`,
            scope,
            ...(turnId === undefined ? {} : { turnId }),
            cursor: null,
            want: null
        };

        subscriptions.set(sub.id, sub);
        if (status === 'open') sendSubscribe(sub);
        else connect();

        return sub;
    };

    const clearHeartbeat = (): void => {
        if (heartbeatCancel !== undefined) {
            heartbeatCancel();
            heartbeatCancel = undefined;
        }
    };

    // Every inbound frame is liveness; the DEADLINE is always
    // `interval * intervals`, so a busy publisher does not buy itself immunity
    // and a silent one is still caught.
    const armHeartbeat = (): void => {
        clearHeartbeat();
        heartbeatCancel = schedule(() => {
            if (status !== 'open') return;
            socket?.close(heartbeatCloseCode, 'heartbeat timeout');
        }, heartbeatIntervalMs * heartbeatTimeoutIntervals);
    };

    const scheduleReconnect = (): void => {
        if (manualClose || reconnectCancel !== undefined) return;
        if (maxAttempts > 0 && attempts >= maxAttempts) {
            setStatus('closed');

            return;
        }

        const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempts);
        const jitter = Math.floor(backoff * 0.25 * Math.random());

        attempts += 1;
        reconnectCancel = schedule(() => {
            reconnectCancel = undefined;
            connect();
        }, backoff + jitter);
    };

    /**
     * The bounded recovery for one turn: ask the REST contract for the canonical
     * answer instead of guessing what the dropped frames contained. The fold is
     * replaced (not appended) so a late delta on top of a re-read cannot
     * double-print a sentence.
     */
    const recoverTurn = (turnId: string | undefined, reason: StreamResyncReason): void => {
        events.onResync?.(reason, turnId);
        const target = turnId ?? focusTurnId;
        if (target === undefined) return;

        void readText(options.sessionId, target).then(
            (text) => {
                textByTurn.set(target, text);
                events.onText?.(text, target);
            },
            () => {
                // A failed re-read stays honest: nothing is invented, and the
                // terminal `turn.upsert` (or the send flow's own canonical read)
                // still ends the turn.
            }
        );
    };

    /** Whether a node addressed to `sectionId` folds into THE ANSWER. ONE place, so
     *  an insert and a provisional append can never disagree:
     *    - no `sectionId` at all  — the turn's own root flow (the projector always
     *      addresses its nodes explicitly, so an unaddressed node is `ROOT_KEY`, the
     *      entry agent's conversation);
     *    - a section seen from `section:open` — whatever `isAnswerSection` decided
     *      when it opened (root-shaped AND the entry agent's flow);
     *    - a section NEVER seen opened — the CHILD side. Identity is the test, and an
     *      unclassified flow cannot claim the answer; the gap that dropped its
     *      `section:open` triggers `recoverTurn`, whose canonical display re-read
     *      replaces this fold. */
    const answersAsFlow = (turnId: string, sectionId: string | undefined): boolean =>
        sectionId === undefined ? true : sectionOwns.get(foldKey(turnId, sectionId)) === true;

    /** Apply one display op to the fold. Painting happens through the callbacks. */
    const applyOp = (op: WsDisplayOp, frameTurnId: string | undefined): void => {
        const turnId = op.turnId ?? frameTurnId ?? focusTurnId;

        switch (op.op) {
            case 'section:open': {
                if (turnId === undefined || op.section?.id === undefined) return;
                // THE rule, shared with the REST read: root-shaped AND the entry agent's
                // own flow. A parentless section whose agent is NOT the entry is a
                // delegated lane recorded without lineage (or an `inline:<agent>`
                // threadless flow), and its prose belongs to that section's pane, not to
                // the answer. The rank the frame carries is display data, never this
                // predicate.
                sectionOwns.set(foldKey(turnId, op.section.id), isAnswerSection(op.section, entryAgent));

                return;
            }
            case 'node:insert': {
                if (turnId === undefined || op.node?.id === undefined || op.node.kind === undefined) return;
                insertOrder += 1;

                const kind = op.node.kind;
                const text = typeof op.node.text === 'string' ? op.node.text : '';
                // Classification lives in `answersAsFlow` (shared with the provisional
                // append below): root-shaped + entry agent, and an unclassified section
                // is the CHILD side, never a silent participant in the answer.
                const answer = answersAsFlow(turnId, op.sectionId);

                nodes.set(foldKey(turnId, op.node.id), { kind, text, answer, order: insertOrder });

                // A node can arrive WITH text (a replayed or committed node, or the
                // first chunk an attempt publishes), and that text is already part
                // of the answer. Waiting for the next `node:append` would leave the
                // surface showing nothing for a turn that already has content.
                if (kind === 'text' && answer && text.length > 0) {
                    const next = foldAnswerText(turnId);

                    textByTurn.set(turnId, next);
                    events.onText?.(next, turnId);
                }

                return;
            }
            case 'node:append': {
                if (turnId === undefined || op.nodeId === undefined || typeof op.delta !== 'string') return;
                const key = foldKey(turnId, op.nodeId);
                const node = nodes.get(key);
                const delta = op.delta;

                // A delta for a node whose `node:insert` was the frame that got
                // dropped is NOT discarded: it folds into a provisional text node
                // so the answer keeps growing, and the gap resync's REST re-read
                // replaces the fold with the canonical text a moment later. The
                // provisional node is classified by the SAME rule as an insert
                // (`answersAsFlow`) — it is the missing `section:open`/`node:insert`
                // pair that this path exists for, so defaulting it to the answer side
                // is precisely how a foreign agent's prose used to leak in.
                const resolved: NodeFold = node ?? {
                    kind: 'text',
                    text: '',
                    answer: answersAsFlow(turnId, op.sectionId),
                    order: ++insertOrder
                };

                resolved.text += delta;
                if (node === undefined) nodes.set(key, resolved);

                if (resolved.kind === 'reasoning') {
                    const next = `${reasoningByTurn.get(turnId) ?? ''}${delta}`;

                    reasoningByTurn.set(turnId, next);
                    events.onReasoning?.(next, turnId);

                    return;
                }
                if (resolved.kind !== 'text') return;

                const next = foldAnswerText(turnId);

                textByTurn.set(turnId, next);
                events.onText?.(next, turnId);

                return;
            }
            case 'node:set': {
                if (turnId === undefined || op.nodeId === undefined) return;
                const node = nodes.get(foldKey(turnId, op.nodeId));
                const patch = (op as { patch?: { text?: string } }).patch;

                if (node !== undefined && typeof patch?.text === 'string') node.text = patch.text;

                return;
            }
            case 'node:remove': {
                if (turnId === undefined || op.nodeId === undefined) return;
                nodes.delete(foldKey(turnId, op.nodeId));

                return;
            }
            case 'attempt:discard': {
                if (turnId === undefined) return;
                // A retry names the EXACT nodes to drop, so the fold never has to
                // track an attempt window itself.
                for (const id of op.nodeIds ?? []) nodes.delete(foldKey(turnId, id));

                return;
            }
            default:
                // Every other op (`turn`, `section:set`, `step:set`, `context:*`,
                // `tail:*`, `pending:set`, `usage`, `attempt:commit`) is display
                // detail this surface does not fold, and an unknown op is data to
                // tolerate, never a failure.
                return;
        }
    };

    /** The answer of one turn: the TEXT nodes classified answer-side by `answersAsFlow` (root-shaped AND the entry agent's flow), in insertion order. */
    const foldAnswerText = (turnId: string): string => {
        const parts: Array<{ order: number; text: string }> = [];

        for (const [key, fold] of nodes) {
            if (!key.startsWith(`${turnId}::`)) continue;
            if (fold.kind !== 'text' || !fold.answer) continue;
            parts.push({ order: fold.order, text: fold.text });
        }

        return parts
            .sort((left, right) => left.order - right.order)
            .map((part) => part.text)
            .join('');
    };

    const handleFrame = (raw: unknown): void => {
        if (typeof raw !== 'object' || raw === null || typeof (raw as { type?: unknown }).type !== 'string') return;
        const frame = raw as WsServerFrame;

        if (frame.type === 'welcome') {
            const welcome = frame as WsWelcome;

            attempts = 0;
            epoch = welcome.epoch;

            // Re-adopt the numbers IN FORCE on this connection (a deployment may
            // tune within the declared bounds; a client that treats them as
            // advisory mis-times its heartbeat).
            const limits = welcome.limits as Record<string, number> | undefined;

            if (typeof limits?.heartbeat_interval_ms === 'number') heartbeatIntervalMs = limits.heartbeat_interval_ms;
            if (typeof limits?.heartbeat_timeout_intervals === 'number') {
                heartbeatTimeoutIntervals = limits.heartbeat_timeout_intervals;
            }
            if (typeof limits?.heartbeat_timeout_close_code === 'number') {
                heartbeatCloseCode = limits.heartbeat_timeout_close_code;
            }

            // Re-arm with the numbers JUST adopted: the deadline this client set
            // before the handshake used the shipped defaults, and a deployment that
            // tuned them inside the declared bounds would otherwise be watched (or
            // abandoned) on the wrong clock.
            if (status === 'open') armHeartbeat();

            return;
        }

        if (frame.type === 'subscription_state') {
            const state = frame as WsSubscriptionState;
            const sub = subscriptions.get(state.subscription_id);

            epoch = state.epoch;
            cursor = state.cursor;
            if (sub === undefined) return;
            sub.cursor = state.cursor;
            sub.want = state.sequence + 1;

            return;
        }

        if (frame.type === 'update') {
            const update = frame as WsUpdate;
            const sub = subscriptions.get(update.subscription_id);
            const want = sub?.want ?? null;

            // GAP by arithmetic: a server that dropped frames must say so, and a
            // client that can count notices when it did not.
            if (sub !== undefined && want !== null && update.sequence > want) {
                sub.want = null;
                send({ type: 'unsubscribe', subscription_id: sub.id });
                sendSubscribe(sub);
                recoverTurn(sub.turnId, 'frames_dropped');
            }

            if (sub !== undefined) {
                sub.want = update.sequence + 1;
                sub.cursor = update.cursor;
                cursor = update.cursor;
            } else {
                // A frame for a subscription this client released (or never
                // opened) names a resource no pane is showing. The reference client
                // applies the same rule, and it is what makes "one shared session
                // scope is cheap for several panes" true instead of lucky.
                return;
            }

            if (update.kind === 'turn.upsert' && update.turn !== undefined) {
                events.onTurn?.(update.turn);

                return;
            }

            if (update.kind === 'display.ops') {
                const turnId = update.turn_id ?? sub?.turnId;

                if (turnId !== undefined) focusTurnId = turnId;
                for (const op of update.ops ?? []) applyOp(op, turnId);

                return;
            }

            if (update.kind === 'usage.updated') {
                events.onUsage?.(update.usage_patch ?? {}, update.turn_id ?? sub?.turnId);

                return;
            }

            if (update.kind === 'session.updated') {
                events.onSession?.(update.session ?? {});

                return;
            }

            if (update.kind === 'transcript.updated') {
                events.onTranscript?.(update);

                return;
            }

            return;
        }

        if (frame.type === 'resync_required') {
            const resync = frame as WsResyncRequired;
            const sub = subscriptions.get(resync.subscription_id);

            epoch = resync.epoch;
            cursor = resync.cursor;
            if (sub === undefined) return;
            sub.cursor = resync.cursor;
            sub.want = null;
            recoverTurn(sub.turnId, resync.reason);

            return;
        }

        if (frame.type === 'error') {
            events.onError?.(frame as WsProtocolError);

            return;
        }

        // `heartbeat` / `pong`: the peer is alive, so the deadline moves.
        armHeartbeat();
    };

    const connect = (): void => {
        if (factory === undefined) {
            // No socket in this host at all (a bare-node test, a locked-down
            // browser). Degraded observation, never a failed task: the caller
            // still gets the terminal state from its own canonical read.
            setStatus('closed');

            return;
        }

        if (status === 'connecting' || status === 'open') return;

        setStatus(attempts === 0 ? 'connecting' : 'reconnecting');
        manualClose = false;

        let created: StreamSocket;

        try {
            created = factory(socketUrlOf(options.socketUrl), HARNESS_WS_SUBPROTOCOL);
        } catch {
            scheduleReconnect();

            return;
        }

        socket = created;
        armHeartbeat();

        created.onopen = () => {
            if (socket !== created) return;

            setStatus('open');
            armHeartbeat();

            // `hello` is the ONLY resume input, and only as the FIRST frame — so
            // it is sent exactly when there is a position to resume from.
            if (epoch !== null && cursor !== null) {
                send({ type: 'hello', protocol: HARNESS_WS_SUBPROTOCOL, epoch, cursor });
            }

            for (const sub of subscriptions.values()) sendSubscribe(sub);

            // A reconnect can silently miss deltas (the run kept going while the
            // socket was down), so the fold of every followed turn is re-read
            // once, bounded — this is what makes "dropped socket, still correct"
            // true rather than merely "still running".
            if (attempts > 0) {
                for (const sub of subscriptions.values()) {
                    if (sub.scope === 'turn' && sub.turnId !== undefined) recoverTurn(sub.turnId, 'reconnected');
                }
            }
        };

        created.onmessage = (messageEvent) => {
            if (socket !== created) return;
            armHeartbeat();

            let parsed: unknown;

            try {
                parsed = JSON.parse(String(messageEvent.data));
            } catch {
                return;
            }

            handleFrame(parsed);
        };

        created.onerror = () => {
            if (socket !== created) return;
            armHeartbeat();
        };

        created.onclose = () => {
            if (socket !== created) return;

            clearHeartbeat();
            socket = undefined;

            if (manualClose) {
                setStatus('closed');

                return;
            }

            // Every subscription re-registers after a reconnect, and the sequence
            // bookkeeping restarts so a fresh `subscription_state` baseline is not
            // compared against the old sequence space.
            for (const sub of subscriptions.values()) sub.want = null;
            setStatus('reconnecting');
            scheduleReconnect();
        };
    };

    // The session scope always exists: it carries `turn.upsert`, which is what
    // ends a streamed answer.
    openSubscription('session');
    for (const turnId of options.turnIds ?? []) openSubscription('turn', turnId);

    return {
        connect,

        followTurn: (turnId: string): void => {
            for (const sub of subscriptions.values()) {
                if (sub.scope === 'turn' && sub.turnId === turnId) return;
            }

            focusTurnId = turnId;
            openSubscription('turn', turnId);
        },

        requestResync: (turnId?: string): void => {
            recoverTurn(turnId ?? focusTurnId, 'frames_dropped');
        },

        resumeState: () => ({ epoch, cursor }),

        status: () => status,

        // The accumulated answer of one turn (or of the focused turn), so a
        // surface that mounts mid-stream can paint what already arrived.
        textOf: (turnId?: string): string => {
            const key = turnId ?? focusTurnId ?? '';

            if (textByTurn.has(key)) return textByTurn.get(key) as string;

            // No key match: the single followed turn, when there is exactly one.
            if (textByTurn.size === 1) return [...textByTurn.values()][0] as string;

            return '';
        },

        close: (reason?: string): void => {
            manualClose = true;
            clearHeartbeat();

            if (reconnectCancel !== undefined) {
                reconnectCancel();
                reconnectCancel = undefined;
            }

            if (status === 'open') send({ type: 'bye', ...(reason === undefined ? {} : { reason }) });
            socket?.close(1000, reason ?? 'client bye');

            socket = undefined;
            subscriptions.clear();
            setStatus('closed');
        }
    };
};
