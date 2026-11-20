// Headless test harness for the chat plugins (rewired for the harness transport).
//
// Everything a chat plugin test needs, with NO React and NO rendering:
//
//   installHarness  - a MINI HARNESS SERVER: a route-matched `fetch` double that
//                     answers the real `/v1/harness` routes with the real wire
//                     shapes (snake_case rows, paged collections, the `{error:
//                     {message}}` envelope) over an in-memory session table, plus
//                     the matching WebSocket double. It is a TEST DOUBLE of the
//                     contract, not a re-implementation of the server: the shapes
//                     are copied from the generated contract modules
//                     (packages/underload/harness/src/shared/{harness-api,harness-stream}.ts)
//                     and the real listener is exercised by @underload/chat/src/server/main.test.ts.
//   installFetch    - the raw route-matching double (unchanged), for a test that
//                     wants to answer ONE route by hand.
//   sseResponse     - a streamed Response for the OFFLINE transport (api/provider.ts
//                     consumes it verbatim, so the SSE parser under test is real).
//   storage         - the browser seam: reset + seed + read for the persisted keys.
//   createTestChat  - the real composition, pointed at the double above, created
//                     AFTER the fakes are installed (both plugins kick one async
//                     load a microtask after setup).
//   recordEvents    - subscribes to event ids and returns the live log.
//
// WHY A MINI SERVER RATHER THAN PER-TEST ROUTE LISTS: one online conversation is
// a HALF DOZEN contract reads (session, thread roster, paged transcript, usage
// fold, agent roster, model discovery), and the OLD tests each hand-wrote two
// routes for a storage API that no longer exists. Seeding a RECORD and letting the
// double render it keeps every existing cell-level assertion true — the fixtures
// are the same records, the sidebar rows are the same summaries — while the wire
// underneath is honestly the harness's.
//
// THE STREAM DOUBLE IS A PROTOCOL DOUBLE, NOT A SHORT-CIRCUIT: it sends
// `welcome`, one `subscription_state` per subscription, `turn.upsert` frames on
// the SESSION scope and `display.ops` token deltas on the TURN scope, with
// monotonic per-subscription sequences. That is what makes `api/harness-stream.ts`
// (and the gap arithmetic in it) part of the tested path instead of a mock that
// resolves a promise.
import { vi } from 'vitest';
import { createChatDashboard, type ChatDashboardOptions } from '../composition';
import type { Dashboard } from '@underload/dashboard';
import type { StreamSocket } from '../../api/harness-stream';

// ——— origins every test points the composition at ———————————————————————————————

/** The harness REST root the rebuilt client dials (same origin, relative). */
export const TEST_HARNESS_ROOT = '/v1/harness';
/**
 * The PRE-REBUILD conversation endpoint, kept as a name so an existing test's
 * route matchers (`url.startsWith(TEST_BASE_URL)`, `${TEST_BASE_URL}/conv-1`)
 * keep interpolating the URLs they were written against — `installHarnessFrom`
 * is what translates those routes into the harness double's seed table.
 */
export const TEST_BASE_URL = 'http://storage.test/v1/chat-assistant/conversation';
/** The OFFLINE provider base (the SSE transport), never used online any more. */
export const TEST_PROVIDER_URL = 'http://provider.test/providers/private/v1';
/** The OFFLINE-mode provider base the settings surface would persist. */
export const TEST_OFFLINE_BASE = 'http://offline.test/providers/private/v1';

// A fixed clock, so a created conversation's timestamps are reproducible across
// runs (the pre-rebuild fixtures pinned ISO strings for exactly this reason).
const EPOCH_MS = Date.parse('2026-11-07T00:00:00.000Z');

// ---------------------------------------------------------------------------
// The record fixture: the shape a test seeds, in the UI's own vocabulary
// ---------------------------------------------------------------------------

export type SeedMessage = { role: 'system' | 'user' | 'assistant'; content: string; model?: string };

export type SeedRecord = {
    conversationId: string;
    title: string;
    model: string;
    status: 'pending' | 'complete' | 'error';
    messageCount: number;
    messages: SeedMessage[];
    createdAt: string;
    updatedAt: string;
    usage?: Record<string, number>;
};

/** One complete record, exactly as a plugin test has always described one. */
export const recordFixture = (
    conversationId: string,
    overrides: Partial<Omit<SeedRecord, 'conversationId'>> = {}
): SeedRecord => {
    const messages: SeedMessage[] = overrides.messages ?? [
        { role: 'user', content: 'Hello assistant' },
        { role: 'assistant', content: 'Hello user', model: 'test/model' }
    ];

    return {
        conversationId,
        title: overrides.title ?? 'Hello assistant',
        model: overrides.model ?? 'test/model',
        status: overrides.status ?? 'complete',
        messageCount: overrides.messageCount ?? messages.length,
        messages,
        createdAt: overrides.createdAt ?? '2026-11-07T00:00:00.000Z',
        updatedAt: overrides.updatedAt ?? '2026-11-07T00:00:01.000Z',
        ...(overrides.usage ? { usage: overrides.usage } : {})
    };
};

/** The compact sidebar row the same record projects to (unchanged from before). */
export const summaryFixture = (record: SeedRecord) => ({
    conversationId: record.conversationId,
    title: record.title,
    model: record.model,
    status: record.status,
    messageCount: record.messageCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
});

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * A JSON envelope Response, the substitute every api test in this repo uses.
 *
 * `__body` is the fixture, kept readable SYNCHRONOUSLY so `installHarnessFrom`
 * can derive a seed table from a test's existing route list. It is a property of
 * the DOUBLE, never of the wire: the client under test only ever calls `json()`.
 */
export const jsonResponse = (status: number, body: unknown): Response =>
    ({
        ok: status >= 200 && status < 300,
        status,
        statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
        headers: new Headers(JSON_HEADERS),
        json: async () => body,
        __body: body
    }) as unknown as Response;

/** The contract's error envelope, which is what a plugin surfaces verbatim. */
export const errorResponse = (status: number, message: string): Response =>
    jsonResponse(status, { error: { message } });

/**
 * A streamed Response: `body.getReader()` hands back one Uint8Array per frame, in
 * order, then `done`. `TextEncoder` produces the bytes so the production decoder
 * path is what runs.
 */
export const sseResponse = (frames: readonly string[]): Response => {
    const bytes = frames.map((frame) => new TextEncoder().encode(frame));
    let cursor = 0;
    let cancelled = false;

    return {
        ok: true,
        status: 200,
        headers: new Headers(JSON_HEADERS),
        body: {
            getReader: () => ({
                read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
                    if (cancelled || cursor >= bytes.length) return { done: true };
                    const value = bytes[cursor];

                    cursor += 1;

                    return { done: false, value };
                },
                cancel: async (): Promise<void> => {
                    cancelled = true;
                }
            })
        }
    } as unknown as Response;
};

/** One OpenAI-compatible `data:` frame (the OFFLINE relay's exact wire shape). */
export const sseDelta = (content: string): string =>
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`;

/** The final usage frame a GPT-style client appends (stream_options opt-in). */
export const sseUsage = (usage: Record<string, number>): string => `data: ${JSON.stringify({ usage })}\n\n`;

/** The terminator the reader loop stops on. */
export const SSE_DONE = 'data: [DONE]\n\n';

// ---------------------------------------------------------------------------
// The raw fetch double (unchanged), for a test that answers routes by hand
// ---------------------------------------------------------------------------

export type FetchCall = { url: string; method: string; body: unknown };
export type FetchRoute = (url: string, init?: RequestInit) => Response | Promise<Response>;

export type FetchDouble = {
    routes: () => void;
    calls: () => FetchCall[];
    callsFor: (fragment: string) => FetchCall[];
    reset: () => void;
};

/**
 * Install the `fetch` double. Routes are matched in order by `match`; the first
 * hit answers, and an unmatched request THROWS (a silent pass-through would let a
 * typo in a route assertion look like a passing test).
 */
export function installFetch(
    routes: Array<{ match: (url: string, method: string) => boolean; reply: FetchRoute }>
): FetchDouble {
    const log: FetchCall[] = [];
    const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        const raw = init?.body;

        log.push({ url, method, body: typeof raw === 'string' ? JSON.parse(raw) : raw ?? null });

        for (const route of routes) {
            if (route.match(url, method)) return await route.reply(url, init);
        }

        throw new Error(`Unrouted test request: ${method} ${url}`);
    });

    vi.stubGlobal('fetch', mock);

    return {
        routes: () => undefined,
        calls: () => log,
        callsFor: (fragment: string) => log.filter((call) => call.url.includes(fragment)),
        reset: () => {
            log.length = 0;
            mock.mockClear();
        }
    };
}

// ---------------------------------------------------------------------------
// The mini harness server + its stream double
// ---------------------------------------------------------------------------

export type HarnessTransportOptions = {
    /** Conversations the server already holds, in `recordFixture` shape. */
    records?: readonly SeedRecord[];
    /**
     * Legacy route objects (`match(url, method)`) the caller still needs answered:
     * a provider stream that hangs until it is aborted, a catalog that errors on
     * purpose. They are consulted BEFORE the transport's own provider defaults, but
     * after nothing harness-shaped, because `installFetch` takes the first match and
     * these matchers only ever describe URLs the storage-era client used.
     */
    passthrough?: Array<{
        match: (url: string, method?: string) => boolean;
        reply: (url: string, init?: RequestInit) => Response | Promise<Response>;
    }>
    /** The model catalog `POST /models` answers with. */
    models?: readonly string[];
    /** Status the catalog read answers with (a failing catalog is a real case). */
    modelsStatus?: number;
    /** The sentence a failing catalog read reports. */
    modelsMessage?: string;
    /** The trusted agent rows `GET /agents` answers with. */
    agents?: Array<{ name: string; title: string; description: string }>;
    /** The catalogue tool rows `GET /tools` answers with. */
    tools?: Array<{ name: string; group: string; description: string; tags: string[] }>;
    /** The text a submitted turn streams and commits. */
    reply?: string;
    /** Token figures the usage fold reports after a turn. */
    usage?: { input: number; output: number; total: number };
    /** Answer `PATCH .../agents/{id}` with 409 (the busy conversation case). */
    instructionBusy?: boolean;
    /** A canned sentence for the 409, so the banner text is assertable. */
    instructionBusyMessage?: string;
    /**
     * Refuse the agent-instruction PATCH (`/sessions/{id}/agents/{agentId}`) for one
     * id — the rejected system-prompt save, which is a plain store failure rather than
     * the busy conversation the 409 above models.
     */
    instructionErrors?: Record<string, { status: number; message: string }>;
    /**
     * Hold the agent-instruction PATCH open until the returned value settles. The
     * prompt-persist owns the conversation until it settles (:3230), and only a request
     * that is genuinely in flight proves the SECOND save was dropped rather than queued.
     */
    instructionGate?: (session: { id: string; instruction: string | null }) => unknown;
    /** Answer the session LIST with this status (a failing listing is a real case). */
    sessionsStatus?: number;
    /** The sentence the failing session list reports. */
    sessionsMessage?: string;
    /** Answer the identified READ of one id with this status/message. */
    readErrors?: Record<string, { status: number; message: string }>;
    /** Refuse `DELETE /sessions/{id}` for one id with this status/message. */
    deleteErrors?: Record<string, { status: number; message: string }>;
    /**
     * Refuse the transcript-document PUT (`/sessions/{id}/threads/{thread}/transcript`)
     * for one id — the rejected-history cases the transcript plugin pins.
     */
    writeErrors?: Record<string, { status: number; message: string }>;
    /**
     * Hold the transcript-document PUT open until this promise settles (Response or
     * Promise<Response>). The overlap test needs a write that is genuinely in flight:
     * `savingEdit`/`deleting` are busy slots, and only a pending request proves the
     * second write was dropped rather than serialized.
     */
    writeGate?: (session: { id: string; messages: readonly SeedMessage[] }) => unknown;
    /**
     * Ids the fake POST /sessions hands out, in order.
     *
     * A real harness session id is a server-generated uuid, so a test asserting an
     * id is asserting the double's counter unless it says which id it wants. This
     * queue is how a test keeps its readable names (`conv-new`) without the double
     * pretending uuids are predictable.
     */
    createdIds?: readonly string[];
};

export type HarnessTransport = {
    fetch: FetchDouble;
    /** The FetchDouble surface, promoted: a test may use the transport exactly as
     *  it used the value `installFetch` returned (`callsFor`, `calls`, `reset`). */
    calls: () => FetchCall[];
    callsFor: (fragment: string) => FetchCall[];
    reset: () => void;
    routes: () => void;
    /** The stream seam to hand `createChatDashboard({ stream })`. */
    socketFactory: (url: string, protocol: string) => StreamSocket;
    /** Every WS frame the client sent, across every connection. */
    clientFrames: () => any[];
    /** Connections the UI opened, in order (one per in-flight send). */
    connections: () => number;
    /** The sessions the double holds now (wire rows), for a follow-up assertion. */
    sessions: () => any[];
    /**
     * One session as the RECORD the next canonical read answers (messages, title, model,
     * status, counts, timestamps, usage). `sessions()` shows the LIST row; this shows the
     * identified read, which is what an integration test means by "what the server holds".
     * `undefined` when the session does not exist — a deleted conversation reads as
     * nothing, exactly as the wire answers it.
     */
    recordOf: (sessionId: string) => SeedRecord | undefined;
    /** Replace (or create) one session wholesale — an out-of-band settle. */
    putConversation: (record: SeedRecord) => void;
    /** Remove one session from the table. */
    dropSession: (sessionId: string) => void;
    /** Force a turn's deltas + terminal row without a submit (a scripted case). */
    pushText: (sessionId: string, text: string) => void;
};

type WireSession = {
    id: string;
    title: string | null;
    harness: string;
    /** The UI-side status, mapped to the wire spelling on every render. */
    status: 'pending' | 'complete' | 'error';
    model: string;
    created_ms: number;
    updated_ms: number;
    revision: number;
    /**
     * The row's `turn_count`, which the projection renders as `messageCount`.
     * It is kept SEPARATE from the transcript length on purpose: a collection row
     * from a test that only described the sidebar (no messages) must still report
     * the count the fixture gave it, while an identified read answers with the
     * transcript it actually holds.
     */
    turn_count?: number;
    usage?: Record<string, number>;
    messages: SeedMessage[];
    agent_models: Record<string, string>;
    instruction: string | null;
    tools: Array<{ name: string; description: string; tags: string[] }>;
};

type PendingTurn = {
    turnId: string;
    sessionId: string;
    threadId: string;
    input: string;
    reply: string;
    /** Ops buffered for a turn scope that subscribed after the deltas were produced. */
    ops: any[];
    delivered: boolean;
};

const sessionIdCounter = { value: 0 };

const newSessionId = (queue?: string[]): string => {
    const declared = queue === undefined || queue.length === 0 ? undefined : queue.shift();

    sessionIdCounter.value += 1;

    return declared ?? `harness-sess-${sessionIdCounter.value}`;
};

const statusToWire = (status: 'pending' | 'complete' | 'error'): 'running' | 'idle' | 'error' =>
    status === 'pending' ? 'running' : status === 'error' ? 'error' : 'idle';

const sessionRow = (session: WireSession) => ({
    id: session.id,
    title: session.title,
    harness: session.harness,
    status: statusToWire(session.status),
    model: session.model,
    created_at: session.created_ms,
    updated_at: session.updated_ms,
    turn_count: session.turn_count ?? session.messages.length,
    thread_count: session.messages.length > 0 ? 1 : 0,
    revision: session.revision
});

const threadRow = (session: WireSession) => ({
    id: 'thread-1',
    agent: 'instruct',
    origin: 'host',
    status: 'idle',
    sequence: session.messages.length,
    transcript_state: 'ok',
    message_count: session.messages.length,
    has_transcript: session.messages.length > 0
});

const pageOf = <T>(items: T[], extra: Record<string, unknown> = {}) => ({
    items,
    next_cursor: null,
    revision: 1,
    limit: 100,
    ...extra
});

const splitQuery = (url: string): { path: string; query: URLSearchParams } => {
    const index = url.indexOf('?');

    return index === -1
        ? { path: url, query: new URLSearchParams() }
        : { path: url.slice(0, index), query: new URLSearchParams(url.slice(index + 1)) };
};

/**
 * Build and install the double. Call it BEFORE `createTestChat`, and once per
 * test (it replaces the global `fetch` and owns the in-memory table).
 */
/** The doubles installed LAST (see `createTestChat`'s default transport). */
let currentTransport: HarnessTransport | undefined;

export function installHarness(options: HarnessTransportOptions = {}): HarnessTransport {
    const reply = options.reply ?? 'Hello user';
    const usage = options.usage ?? { input: 10, output: 5, total: 15 };
    const models = options.models ?? ['alpha/flash', 'zeta/turbo'];
    const sessions = new Map<string, WireSession>();

    for (const record of options.records ?? []) {
        sessions.set(record.conversationId, {
            id: record.conversationId,
            title: record.title,
            harness: 'chat',
            status: record.status,
            model: record.model,
            created_ms: Date.parse(record.createdAt),
            updated_ms: Date.parse(record.updatedAt),
            revision: 1,
            turn_count: record.messageCount,
            ...(record.usage ? { usage: record.usage } : {}),
            messages: record.messages.map((message) => ({ ...message })),
            agent_models: { instruct: record.model },
            instruction: null,
            tools: []
        });
    }

    const turns: PendingTurn[] = [];
    // A COPY of the declared id queue: the handler drains it, the caller's array
    // stays intact for a second test that re-uses the same option object.
    const createdQueue: string[] = [...(options.createdIds ?? [])];
    const clientFrameLog: any[] = [];
    const connections: FakeConnection[] = [];
    let turnCounter = 0;

    const find = (id: string): WireSession | undefined => sessions.get(id);

    // ——— the stream double ————————————————————————————————————————————————————
    type FakeConnection = StreamSocket & {
        frames: any[];
        receive: (frame: unknown) => void;
        open: () => void;
        shut: (code?: number) => void;
        subscriptions: Array<{ id: string; scope: string; sessionId?: string; turnId?: string; sequence: number; cursor: string }>;
        /** Emit one `update` frame on the subscription matching the scope/ids. */
        emit: (scope: 'session' | 'turn', payload: Record<string, unknown>, ids?: { sessionId?: string; turnId?: string }) => void;
    };

    const makeConnection = (): FakeConnection => {
        const socket = {
            frames: [] as any[],
            subscriptions: [] as FakeConnection['subscriptions'],
            onopen: null,
            onmessage: null,
            onerror: null,
            onclose: null,
            send: (data: string) => {
                const frame = JSON.parse(data);

                socket.frames.push(frame);
                clientFrameLog.push(frame);
                handleClientFrame(frame);
            },
            close: () => undefined,
            receive: (frame: unknown) => {
                socket.onmessage?.({ data: JSON.stringify(frame) });
            },
            open: () => {
                socket.onopen?.();
                socket.receive({
                    type: 'welcome',
                    protocol: 'harness.v1',
                    epoch: 'test-epoch',
                    at: 1,
                    limits: { heartbeat_interval_ms: 15000, heartbeat_timeout_intervals: 3 }
                });
            },
            shut: (code?: number) => {
                socket.onclose?.({ code });
            },
            emit: (scope: 'session' | 'turn', payload: Record<string, unknown>, ids?: { sessionId?: string; turnId?: string }) => {
                const matches = socket.subscriptions.filter(
                    (sub) =>
                        sub.scope === scope &&
                        (scope === 'session'
                            ? sub.sessionId === (ids?.sessionId ?? sub.sessionId)
                            : sub.turnId === ids?.turnId)
                );

                for (const sub of matches) {
                    sub.sequence += 1;
                    sub.cursor = `${sub.id}-${sub.sequence}`;
                    socket.receive({
                        type: 'update',
                        subscription_id: sub.id,
                        sequence: sub.sequence,
                        cursor: sub.cursor,
                        at: Date.now(),
                        ...payload
                    });
                }
            }
        } as unknown as FakeConnection;

        const handleClientFrame = (frame: any): void => {
            if (frame.type === 'subscribe') {
                const existing = socket.subscriptions.find((sub) => sub.id === frame.subscription_id);

                if (existing === undefined) {
                    socket.subscriptions.push({
                        id: frame.subscription_id,
                        scope: frame.scope,
                        ...(frame.session_id === undefined ? {} : { sessionId: frame.session_id }),
                        ...(frame.turn_id === undefined ? {} : { turnId: frame.turn_id }),
                        sequence: 0,
                        cursor: `${frame.subscription_id}-0`
                    });
                }

                socket.receive({
                    type: 'subscription_state',
                    subscription_id: frame.subscription_id,
                    scope: frame.scope,
                    epoch: 'test-epoch',
                    sequence: 0,
                    cursor: `${frame.subscription_id}-0`,
                    revisions: [],
                    publishes: []
                });

                // A turn scope opened AFTER the deltas were produced replays them,
                // which is the late-subscribe case the send flow handles.
                if (frame.scope === 'turn' && frame.turn_id !== undefined) {
                    const pending = turns.find((turn) => turn.turnId === frame.turn_id);

                    if (pending !== undefined) {
                        for (const op of pending.ops) {
                            socket.emit('turn', { kind: 'display.ops', turn_id: pending.turnId, ops: [op] }, { turnId: pending.turnId });
                        }
                    }
                }

                return;
            }

            if (frame.type === 'unsubscribe' || frame.type === 'bye') {
                socket.subscriptions = socket.subscriptions.filter((sub) => sub.id !== frame.subscription_id);
            }
        };

        connections.push(socket);

        return socket;
    };

    /** Wait (briefly) for a session-scope subscription, then stream the turn. */
    const scheduleDelivery = (turn: PendingTurn, attempts = 60): void => {
        setTimeout(() => {
            const listening = connections.some(
                (connection) =>
                    connection.subscriptions.some(
                        (sub) => sub.scope === 'session' && sub.sessionId === turn.sessionId
                    ) &&
                    connection.subscriptions.some((sub) => sub.scope === 'turn' && sub.turnId === turn.turnId)
            );

            if (listening || attempts <= 0) {
                deliverTurn(turn);

                return;
            }

            scheduleDelivery(turn, attempts - 1);
        }, 0);
    };

    /** Stream one turn: deltas on the turn scope, the rows on the session scope. */
    const deliverTurn = (turn: PendingTurn): void => {
        if (turn.delivered) return;
        turn.delivered = true;

        const chunks = turn.reply.length > 0 ? [turn.reply.slice(0, Math.ceil(turn.reply.length / 2)), turn.reply.slice(Math.ceil(turn.reply.length / 2))] : [];

        // Every op this turn produces is RECORDED (for a turn scope that subscribes
        // late — see the replay in the `subscribe` handler) AND SENT on the turn scope
        // the moment it exists. The send matters: the stream's ordering contract is
        // "`section:open` precedes every op naming that section"
        // (packages/underload/harness/src/shared/harness-stream.ts:148), and the client
        // fold classifies a node by the section it was opened with — a double that
        // streamed only the appends would exercise a shape the real projector never
        // produces (an insert whose `section:open` was never seen).
        const emitOp = (op: any): void => {
            turn.ops.push(op);

            for (const connection of connections) {
                connection.emit('turn', { kind: 'display.ops', turn_id: turn.turnId, ops: [op] }, { turnId: turn.turnId });
            }
        };

        // The entry agent's own flow: NO `parentSectionId` AND `agent` is the session's
        // entry (`'instruct'`, the `entry` the frozen definition below states), which is
        // what marks its text as the answer — the stream fold and `textOfTurnDisplay`
        // both read that rule, never `rank`. `rank: 'A'` is the rank the `instruct`
        // agent holds in this harness — display data, shared by any number of members.
        emitOp({ op: 'section:open', turnId: turn.turnId, section: { id: 'sec-1', rank: 'A', agent: 'instruct' } });
        emitOp({ op: 'node:insert', turnId: turn.turnId, sectionId: 'sec-1', node: { id: 'node-1', kind: 'text', text: '' } });

        for (const connection of connections) {
            connection.emit('session', {
                kind: 'turn.upsert',
                turn: {
                    id: turn.turnId,
                    index: 1,
                    promptPreview: turn.input,
                    promptChars: turn.input.length,
                    status: 'running',
                    state: 'streaming',
                    threadId: turn.threadId,
                    updatedAt: Date.now(),
                    sectionCount: 1,
                    stepCount: 0,
                    activeAgents: ['instruct'],
                    blocks: []
                }
            }, { sessionId: turn.sessionId });
        }

        for (const chunk of chunks) {
            emitOp({ op: 'node:append', turnId: turn.turnId, sectionId: 'sec-1', nodeId: 'node-1', delta: chunk });
        }

        for (const connection of connections) {
            connection.emit('session', {
                kind: 'turn.upsert',
                turn: {
                    id: turn.turnId,
                    index: 1,
                    promptPreview: turn.input,
                    promptChars: turn.input.length,
                    status: 'done',
                    state: 'complete',
                    threadId: turn.threadId,
                    updatedAt: Date.now(),
                    usage,
                    sectionCount: 1,
                    stepCount: 0,
                    activeAgents: ['instruct'],
                    blocks: []
                }
            }, { sessionId: turn.sessionId });
            connection.emit('session', { kind: 'usage.updated', turn_id: turn.turnId, usage_patch: usage }, { sessionId: turn.sessionId });
        }
    };

    const socketFactory = (): StreamSocket => makeConnection();

    // ——— the REST double —————————————————————————————————————————————————————
    let routes: Array<{
        match: (url: string, method: string) => boolean;
        reply: (url: string, init?: RequestInit) => Response | Promise<Response>;
    }>;
    const root = TEST_HARNESS_ROOT;

    const respond = (init?: RequestInit): Record<string, unknown> => {
        const raw = init?.body;

        return typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : {};
    };

    routes = [
        // ——— sessions ————————————————————————————————————————————————————————
        {
            match: (url, method) => method === 'GET' && splitQuery(url).path === `${root}/sessions`,
            reply: () =>
                options.sessionsStatus !== undefined && options.sessionsStatus >= 400
                    ? errorResponse(options.sessionsStatus, options.sessionsMessage ?? 'The harness server is unreachable')
                    : jsonResponse(200, pageOf([...sessions.values()].map(sessionRow)))
        },
        {
            match: (url, method) => method === 'POST' && splitQuery(url).path === `${root}/sessions`,
            reply: (_url, init) => {
                const body = respond(init);
                const model = typeof body?.settings === 'object' && body.settings !== null
                    ? String((body.settings as Record<string, unknown>).model ?? 'test/model')
                    : 'test/model';
                // A test that pre-seeded the record its create would return (the
                // old doubles answered the follow-up GET with a fixture) keeps that
                // fixture's timestamps and status: the double's job is to answer what
                // the test described, and a fabricated timestamp would turn the row
                // assertion into a test of the double's clock.
                const id = newSessionId(createdQueue);
                const seeded = sessions.get(id);
                const session: WireSession = {
                    id,
                    title:
                        typeof body.title === 'string'
                            ? body.title
                            : (seeded?.title ?? null),
                    harness: String(body.harness ?? 'chat'),
                    status: seeded?.status ?? 'complete',
                    model,
                    created_ms: seeded?.created_ms ?? EPOCH_MS + sessions.size * 1000,
                    updated_ms: seeded?.updated_ms ?? EPOCH_MS + sessions.size * 1000,
                    revision: 1,
                    turn_count: seeded?.turn_count ?? 0,
                    messages: seeded?.messages ?? [],
                    ...(seeded?.usage === undefined ? {} : { usage: seeded.usage }),
                    agent_models: { instruct: model },
                    instruction: null,
                    tools: []
                };

                sessions.set(session.id, session);

                return jsonResponse(201, { session: { ...sessionRow(session), definition_revision: 0, agent_models: session.agent_models, endpoint: { base_url: 'http://provider.test/v1', model, has_api_key: true }, runtime_execution: 'inline', pending_action_count: 0, created_tool_count: 0, created_tool_limit: 24 } });
            }
        },
        {
            match: (url, method) => splitQuery(url).path.startsWith(`${root}/sessions/`),
            reply: (url, init) => {
                const method = (init?.method ?? 'GET').toUpperCase();
                const path = splitQuery(url).path.slice(`${root}/sessions/`.length);
                const [id, ...rest] = path.split('/');
                const decoded = decodeURIComponent(id ?? '');
                const declared = options.readErrors?.[decoded];

                if (declared !== undefined) return errorResponse(declared.status, declared.message);

                const session = find(decoded);

                if (session === undefined) return errorResponse(404, `Unknown session "${id}".`);

                const suffix = rest.join('/');

                if (rest.length === 0) {
                    if (method === 'DELETE') {
                        const refused = options.deleteErrors?.[session.id];

                        if (refused !== undefined) return errorResponse(refused.status, refused.message);

                        sessions.delete(session.id);

                        return jsonResponse(200, { deleted: true, session_id: session.id, aborted_turns: 0, dropped_queued_tasks: 0 });
                    }

                    if (method === 'PATCH') {
                        const body = respond(init);

                        if (typeof body.title === 'string') session.title = body.title;
                        if (body.title === null) session.title = null;
                        if (typeof body.agent_models === 'object' && body.agent_models !== null) {
                            const models = body.agent_models as Record<string, string>;

                            Object.assign(session.agent_models, models);
                            // The session row's displayed model is the ENTRY member's
                            // model (`instruct` is this double's only member), because the
                            // contract's `model` field means exactly that — "the model the
                            // entry agent runs now".
                            const entryModel = models.instruct;

                            if (typeof entryModel === 'string') session.model = entryModel;
                        }
                        session.revision += 1;

                        return jsonResponse(200, { session: { ...sessionRow(session), definition_revision: 0, agent_models: session.agent_models, endpoint: { base_url: 'http://provider.test/v1', model: session.model, has_api_key: true }, runtime_execution: 'inline', pending_action_count: 0, created_tool_count: 0, created_tool_limit: 24 } });
                    }

                    return jsonResponse(200, {
                        session: {
                            ...sessionRow(session),
                            definition_revision: 0,
                            agent_models: session.agent_models,
                            endpoint: { base_url: 'http://provider.test/v1', model: session.model, has_api_key: true },
                            runtime_execution: 'inline',
                            pending_action_count: 0,
                            created_tool_count: session.tools.length,
                            created_tool_limit: 24
                        }
                    });
                }

                if (suffix === 'threads' && method === 'GET') {
                    return jsonResponse(200, pageOf(session.messages.length > 0 ? [threadRow(session)] : []));
                }

                if (suffix.startsWith('threads/')) {
                    const [, threadId, ...tail] = suffix.split('/');
                    const action = tail.join('/');

                    if (action === 'transcript/messages') {
                        return jsonResponse(
                            200,
                            pageOf(session.messages.map(({ role, content }) => ({ role, content })), {
                                thread_id: threadId,
                                agent: 'instruct',
                                transcript_state: 'ok',
                                total: session.messages.length
                            })
                        );
                    }

                    if (action === 'transcript' && method === 'PUT') {
                        const refused = options.writeErrors?.[decoded];

                        if (refused !== undefined) return errorResponse(refused.status, refused.message);

                        const body = respond(init);
                        const messages = Array.isArray(body.messages) ? (body.messages as SeedMessage[]) : [];

                        session.messages = messages.map((message) => ({ role: message.role, content: message.content }));
                        session.revision += 1;

                        const receipt = jsonResponse(200, {
                            session_id: session.id,
                            thread_id: threadId,
                            accepted_as: 'transcript',
                            message_count: session.messages.length,
                            revision: session.revision
                        });

                        // A gated write answers LATER; the table above is already
                        // updated, exactly as a real server commits then responds.
                        if (options.writeGate === undefined) return receipt;

                        return Promise.resolve(options.writeGate({ id: session.id, messages: session.messages })).then(
                            () => receipt
                        );
                    }
                }

                if (suffix === 'usage' && method === 'GET') {
                    return jsonResponse(200, {
                        session_id: session.id,
                        turn_count: session.messages.length,
                        reported_turns: session.messages.length,
                        ...(session.usage
                            ? {
                                  usage: {
                                      input: Number(session.usage.prompt_tokens ?? 0),
                                      output: Number(session.usage.completion_tokens ?? 0),
                                      total: Number(session.usage.total_tokens ?? 0)
                                  }
                              }
                            : {}),
                        by_thread: [],
                        truncated: false,
                        revision: session.revision
                    });
                }

                // `GET /sessions/{id}/definition` — the FROZEN definition. This is the
                // only row that states the session's ENTRY agent (a routing fact: the
                // member an unfocused turn runs and the member no session may detach).
                // The roster below cannot answer it: its rows carry `rank` (authority),
                // and neither rank nor roster position says which member is the entry.
                // Spell the row the way the contract does, so `entryAgentId` resolves the
                // same id here that the real server would hand the UI.
                if (suffix === 'definition' && method === 'GET') {
                    return jsonResponse(200, {
                        definition: {
                            session_id: session.id,
                            name: session.harness,
                            title: 'Chat',
                            description: 'Plain one-on-one chat.',
                            requires_endpoint: true,
                            entry: 'instruct',
                            ranks: { instruct: 'A' },
                            agents: ['instruct'],
                            tools: [],
                            builtin: true,
                            definition_revision: 0,
                            revision: 0,
                            frozen_at: session.created_ms,
                            source_revision: 0,
                            current_revision: 0,
                            current: true
                        }
                    });
                }

                if (suffix === 'agents') {
                    const roster = {
                        session_id: session.id,
                        total: 1,
                        agents: [
                            {
                                agent_id: 'instruct',
                                profile: 'instruct',
                                // The RANK this session runs the member at ('A' highest).
                                // It replaced `role`, and it is NOT what marks the entry:
                                // the entry is `deletable: false` plus the frozen
                                // definition's `entry`, and any number of members may
                                // legitimately report the same letter.
                                rank: 'A',
                                origin: 'definition',
                                model: session.model,
                                inherited_model: session.model,
                                instruction_source: session.instruction === null ? 'catalogue' : 'harness',
                                instruction_chars: session.instruction ?? 0,
                                ...(session.instruction === null ? {} : { has_instruction_override: true }),
                                editable: true,
                                deletable: false,
                                restorable: false,
                                revision: 0
                            }
                        ],
                        revision: 0
                    };

                    if (method === 'POST') {
                        const body = respond(init);
                        const name = String(body.name ?? 'instruct');

                        return jsonResponse(201, {
                            agent: {
                                agent_id: name,
                                profile: name,
                                // A member bound at runtime takes ONE RANK BELOW the
                                // lowest rank the roster states (here 'A' is stated, so
                                // 'B'), and it is not the entry — the session keeps its
                                // own entry agent whatever this row's rank is.
                                rank: 'B',
                                origin: 'definition',
                                model: session.model,
                                inherited_model: session.model,
                                instruction_source: 'catalogue',
                                instruction_chars: 0,
                                editable: true,
                                deletable: true,
                                restorable: false,
                                revision: 0
                            }
                        });
                    }

                    return jsonResponse(200, roster);
                }

                if (suffix.startsWith('agents/')) {
                    const [, agentId, ...tail] = suffix.split('/');

                    if (tail.length === 1 && tail[0] === 'instruction' && method === 'GET') {
                        return jsonResponse(200, {
                            session_id: session.id,
                            agent_id: decodeURIComponent(agentId),
                            source: session.instruction === null ? 'catalogue' : 'harness',
                            instruction: session.instruction ?? 'You are the Instruct agent.',
                            guidelines: [],
                            chars: (session.instruction ?? '').length
                        });
                    }

                    if (tail.length === 0 && method === 'PATCH') {
                        const refused = options.instructionErrors?.[decoded];

                        if (refused !== undefined) return errorResponse(refused.status, refused.message);

                        if (options.instructionBusy === true) {
                            return errorResponse(
                                409,
                                options.instructionBusyMessage ??
                                    'This conversation is generating, so its instruction cannot be changed right now.'
                            );
                        }

                        const body = respond(init);

                        session.instruction = typeof body.instruction === 'string' ? body.instruction : null;

                        const binding = jsonResponse(200, {
                            agent: {
                                agent_id: decodeURIComponent(agentId),
                                profile: decodeURIComponent(agentId),
                                // Same rank as the roster row this receipt restates: the
                                // member whose instruction was just written is the
                                // session's entry agent, and the entry's rank is whatever
                                // the rank map states — here 'A'.
                                rank: 'A',
                                origin: 'definition',
                                model: session.model,
                                inherited_model: session.model,
                                instruction_source: session.instruction === null ? 'catalogue' : 'harness',
                                instruction_chars: session.instruction ?? 0,
                                ...(session.instruction === null ? {} : { has_instruction_override: true }),
                                editable: true,
                                deletable: false,
                                restorable: true,
                                revision: 1
                            }
                        });

                        // A gated PATCH commits the instruction (as a real server does)
                        // and answers LATER, which is what lets a test observe the busy
                        // slot while the write is still outstanding.
                        if (options.instructionGate === undefined) return binding;

                        return Promise.resolve(
                            options.instructionGate({ id: session.id, instruction: session.instruction })
                        ).then(() => binding);
                    }
                }

                if (suffix === 'tasks' && method === 'POST') {
                    const body = respond(init);
                    const input = String(body.input ?? '');

                    turnCounter += 1;
                    const turnId = `turn-${turnCounter}`;

                    // The run commits BOTH sides of the exchange server-side, which
                    // is the semantic the store's `append` (a canonical re-read)
                    // depends on.
                    session.messages = [...session.messages, { role: 'user', content: input }, { role: 'assistant', content: reply }];
                    // A completed turn moves the ROW count too: the sidebar row the
                    // send flow merges is the projection of this field.
                    session.turn_count = session.messages.filter((message) => message.role !== 'system').length;
                    session.usage = usageRecord(usage, session.usage);
                    session.updated_ms += 1000;
                    session.revision += 1;

                    const turn: PendingTurn = { turnId, sessionId: session.id, threadId: 'thread-1', input, reply, ops: [], delivered: false };

                    turns.push(turn);

                    // The stream settles the turn once the client is LISTENING on this
                    // session's scope: the subscribe frame travels over a socket that
                    // opens asynchronously, and a terminal row emitted before the
                    // subscription is a row nobody receives (the real server has the same
                    // ordering, it simply has a connection already). Bounded, so a test
                    // that never subscribes still gets its answer.
                    scheduleDelivery(turn);

                    return jsonResponse(202, {
                        session_id: session.id,
                        turn_id: turnId,
                        status: 'queued',
                        thread_id: 'thread-1',
                        session_revision: session.revision,
                        accepted_at: session.updated_ms,
                        links: { turn: 't', turns: 'ts', thread: 'th', stream: 's' }
                    });
                }

                if (suffix === 'cancel' && method === 'POST') {
                    const matching = turns.filter((turn) => turn.sessionId === session.id);
                    const running = matching.length > 0 ? matching[matching.length - 1] : undefined;

                    return jsonResponse(200, {
                        cancelled: running !== undefined,
                        session_id: session.id,
                        dropped_queued_tasks: 0,
                        ...(running === undefined ? {} : { active_turn_id: running.turnId }),
                        revision: session.revision + 1
                    });
                }

                if (suffix === 'tools') {
                    if (method === 'POST') {
                        const body = respond(init);
                        const tool = {
                            name: String(body.name ?? 'tool'),
                            description: String(body.description ?? ''),
                            tags: Array.isArray(body.tags) ? (body.tags as string[]) : []
                        };
                        const existing = session.tools.findIndex((candidate) => candidate.name === tool.name);

                        if (existing >= 0) session.tools[existing] = tool;
                        else session.tools.push(tool);

                        return jsonResponse(201, {
                            registration: {
                                name: tool.name,
                                source_revision: 'rev-1',
                                created: existing < 0,
                                replaced: existing >= 0,
                                checks: [],
                                budget: { used: session.tools.length, limit: 24 }
                            }
                        });
                    }

                    return jsonResponse(200, pageOf(session.tools, { budget: { used: session.tools.length, limit: 24 } }));
                }

                if (suffix.startsWith('tools/') && method === 'DELETE') {
                    const name = decodeURIComponent(suffix.slice('tools/'.length));

                    session.tools = session.tools.filter((tool) => tool.name !== name);

                    return jsonResponse(200, { deleted: true, session_id: session.id, name });
                }

                return errorResponse(404, `No harness route for ${method} /${suffix}.`);
            }
        },

        // ——— catalogues and discovery —————————————————————————————————————————
        {
            match: (url, method) => method === 'POST' && splitQuery(url).path === `${root}/models`,
            reply: () =>
                options.modelsStatus !== undefined && options.modelsStatus !== 200
                    ? errorResponse(options.modelsStatus, options.modelsMessage ?? 'provider discovery failed')
                    : jsonResponse(200, { models, observed_at: EPOCH_MS })
        },
        {
            match: (url, method) => method === 'GET' && splitQuery(url).path === `${root}/agents`,
            reply: () =>
                jsonResponse(
                    200,
                    pageOf(
                        (options.agents ?? [
                            { name: 'instruct', title: 'Instruct', description: 'General instruction-following agent.' },
                            { name: 'research', title: 'Research', description: 'Delegates and summarizes.' }
                        ]).map((agent) => ({
                            name: agent.name,
                            title: agent.title,
                            description: agent.description,
                            has_instruction_override: false,
                            has_global_override: false
                        }))
                    )
                )
        },
        {
            match: (url, method) => method === 'GET' && splitQuery(url).path === `${root}/tools`,
            reply: () =>
                jsonResponse(
                    200,
                    pageOf(
                        (options.tools ?? [
                            { name: 'timeNow', group: 'Package presets', description: 'The current time.', tags: ['time'] },
                            { name: 'search', group: 'Web search', description: 'Search the web.', tags: ['web'] }
                        ]).map((tool) => ({
                            name: tool.name,
                            group: tool.group,
                            description: tool.description,
                            tags: tool.tags,
                            visibility: 'searchable',
                            session_bound: false
                        }))
                    )
                )
        },

        // ——— the OFFLINE provider routes (the SSE transport) —————————————————
        {
            match: (url, method) => method === 'GET' && url === `${TEST_PROVIDER_URL}/models`,
            reply: () =>
                options.modelsStatus !== undefined && options.modelsStatus >= 400
                    ? errorResponse(options.modelsStatus, options.modelsMessage ?? 'provider discovery failed')
                    : jsonResponse(200, { object: 'list', data: models.map((id) => ({ id })) })
        },
        {
            match: (url, method) => method === 'POST' && url === `${TEST_PROVIDER_URL}/chat/completions`,
            reply: () => sseResponse([sseDelta(reply), sseUsage(usageAsOpenAi(usage)), SSE_DONE])
        },
        {
            // SUFFIX matchers on purpose: the provider base is a live cell (a test
            // or the settings plugin may repoint it), and the transport answers the
            // provider wherever it currently points.
            match: (url, method) => method === 'GET' && url.endsWith('/models'),
            reply: () => jsonResponse(200, { object: 'list', data: models.map((id) => ({ id })) })
        },
        {
            match: (url, method) => method === 'POST' && url.endsWith('/chat/completions'),
            reply: () => sseResponse([sseDelta(reply), sseUsage(usageAsOpenAi(usage)), SSE_DONE])
        }
    ];

    // The caller's legacy routes go in front: `installFetch` answers with the first
    // match, and a hand-written provider route is more specific than the default.
    const fetchDouble = installFetch(
        options.passthrough === undefined
            ? routes
            : [
                  ...options.passthrough.map((route) => ({
                      match: (url: string, method: string) => route.match(url, method),
                      reply: (url?: string, init?: RequestInit) => route.reply(url ?? '', init)
                  })),
                  ...routes
              ]
    );
    const transport: HarnessTransport = {
        fetch: fetchDouble,
        calls: fetchDouble.calls,
        callsFor: fetchDouble.callsFor,
        reset: fetchDouble.reset,
        routes: fetchDouble.routes,
        // A real WebSocket fires `open` some time AFTER the constructor returns, and the
        // stream client installs its handlers in that same tick (api/harness-stream.ts:770),
        // so the double defers the event to the next macrotask: firing it synchronously
        // would deliver it into a socket with no listener and leave the send hanging.
        socketFactory: () => {
            const connection = makeConnection();

            setTimeout(() => connection.open(), 0);

            return connection;
        },
        clientFrames: () => [...clientFrameLog],
        connections: () => connections.length,
        sessions: () => [...sessions.values()].map(sessionRow),
        putConversation: (record: SeedRecord) => {
            sessions.set(record.conversationId, {
                id: record.conversationId,
                title: record.title,
                harness: 'chat',
                status: record.status,
                model: record.model,
                created_ms: Date.parse(record.createdAt),
                updated_ms: Date.parse(record.updatedAt),
                revision: 1,
                turn_count: record.messageCount,
                ...(record.usage === undefined ? {} : { usage: record.usage }),
                messages: [...record.messages],
                agent_models: { instruct: record.model },
                instruction: null,
                tools: []
            });
        },
        dropSession: (sessionId: string) => {
            sessions.delete(sessionId);
        },
        recordOf: (sessionId: string) => {
            const session = sessions.get(sessionId);

            if (session === undefined) return undefined;

            return {
                conversationId: session.id,
                title: session.title ?? '',
                model: session.model,
                status: session.status,
                messageCount: session.messages.length,
                messages: session.messages.map(({ role, content, model }) => ({
                    role,
                    content,
                    ...(model === undefined ? {} : { model })
                })),
                createdAt: new Date(session.created_ms).toISOString(),
                updatedAt: new Date(session.updated_ms).toISOString(),
                ...(session.usage === undefined ? {} : { usage: session.usage })
            };
        },
        pushText: (sessionId: string, text: string) => {
            const session = find(sessionId);

            if (session === undefined) return;
            session.messages = [...session.messages, { role: 'assistant', content: text }];
        }
    };

    currentTransport = transport;

    return transport;
}

/** Forget the ambient transport (a test that wants NO stream double). */
export const resetHarnessTransport = (): void => {
    currentTransport = undefined;
};

const usageAsOpenAi = (usage: { input: number; output: number; total: number }): Record<string, number> => ({
    prompt_tokens: usage.input,
    completion_tokens: usage.output,
    total_tokens: usage.total
});

/** Aggregate a turn's usage into the record's running totals (both spellings). */
const usageRecord = (
    usage: { input: number; output: number; total: number },
    previous: Record<string, number> | undefined
): Record<string, number> => ({
    prompt_tokens: Number(previous?.prompt_tokens ?? 0) + usage.input,
    completion_tokens: Number(previous?.completion_tokens ?? 0) + usage.output,
    total_tokens: Number(previous?.total_tokens ?? 0) + usage.total
});

// ——— localStorage seams ———————————————————————————————————————————————————————————

export const MODEL_STORAGE_KEY = 'chat-assistant:model';
export const SETTINGS_STORAGE_KEY = 'chat-assistant:settings';
export const TRACKED_STORAGE_KEY = 'chat-assistant:tracked-conversations';
export const AGENTS_STORAGE_KEY = 'chat-assistant:agents';
export const TOOLS_STORAGE_KEY = 'chat-assistant:tools';
export const OFFLINE_STORAGE_KEY = 'chat-assistant:offline-conversations';

const ALL_KEYS = [
    MODEL_STORAGE_KEY,
    SETTINGS_STORAGE_KEY,
    TRACKED_STORAGE_KEY,
    AGENTS_STORAGE_KEY,
    TOOLS_STORAGE_KEY,
    OFFLINE_STORAGE_KEY
];

/** Clear every persisted key, so a test never inherits another's settings. */
export const resetStorage = (): void => {
    for (const key of ALL_KEYS) window.localStorage.removeItem(key);
};

/** Seed the assistant settings exactly as api/offline.ts persists them. */
export const seedSettings = (mode: 'online' | 'offline', providerBase = ''): void => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ mode, providerBase }));
};

/** Seed the online tracked-id cache (the sidebar's authority). */
export const seedTrackedIds = (ids: readonly string[]): void => {
    window.localStorage.setItem(TRACKED_STORAGE_KEY, JSON.stringify([...ids]));
};

export const readTrackedIds = (): string[] => {
    const raw = window.localStorage.getItem(TRACKED_STORAGE_KEY);

    return raw === null ? [] : (JSON.parse(raw) as string[]);
};

/** Seed the remembered model (the last one actually used). */
export const seedModel = (id: string): void => {
    window.localStorage.setItem(MODEL_STORAGE_KEY, id);
};

export const readRememberedModel = (): string | null => window.localStorage.getItem(MODEL_STORAGE_KEY);

/** Seed the client-side agent registry (src/agents persistence shape). */
export const seedAgents = (agents: readonly unknown[]): void => {
    window.localStorage.setItem(AGENTS_STORAGE_KEY, JSON.stringify([...agents]));
};

/** Seed the client-side tool registry (src/agents persistence shape). */
export const seedTools = (tools: readonly unknown[]): void => {
    window.localStorage.setItem(TOOLS_STORAGE_KEY, JSON.stringify([...tools]));
};

// ——— dashboard construction ———————————————————————————————————————————————————————

/**
 * Build a chat dashboard for a test.
 *
 * Pass the `installHarness()` result as `transport` (the online half) so the send
 * pipeline dials the doubles rather than the platform WebSocket, and call this
 * AFTER the doubles are installed: the sessions and source plugins both start
 * their first async load one microtask after setup.
 */
export function createTestChat(
    options: Partial<ChatDashboardOptions> & { transport?: HarnessTransport } = {}
): Dashboard {
    // The transport `installHarness`/`installHarnessFrom` installed LAST, so a test
    // that only rewrites its arrange block still gets a dashboard wired to its own
    // doubles (the stream factory in particular: without it the online send would
    // dial the platform WebSocket at a port nothing is listening on). An explicit
    // `transport` still wins, and an explicit `stream` below it still overrides.
    const { transport = currentTransport, ...rest } = options;

    return createChatDashboard({
        baseUrl: '',
        providerUrl: TEST_PROVIDER_URL,
        pollIntervalMs: 5,
        ...(transport === undefined ? {} : { stream: { socketFactory: transport.socketFactory } }),
        ...rest
    });
}

// ——— event capture ————————————————————————————————————————————————————————————————

export type RecordedEvent = { event: string; payload: unknown };

/** Subscribe to `events` on a live instance and return the append-only log. */
export function recordEvents(instance: Dashboard, events: readonly string[]): RecordedEvent[] {
    const log: RecordedEvent[] = [];

    for (const event of events) {
        instance.on(event, (payload: unknown) => {
            log.push({ event, payload });
        });
    }

    return log;
}

/** The payloads of one event id, in emission order. */
export const payloadsOf = (log: readonly RecordedEvent[], event: string): unknown[] =>
    log.filter((entry) => entry.event === event).map((entry) => entry.payload);

// ---------------------------------------------------------------------------
// installHarnessFrom — the bridge from a pre-rebuild route list to the double
// ---------------------------------------------------------------------------

/**
 * Derive a harness seed table from a test's EXISTING `installFetch` route list.
 *
 * Why this exists rather than a mass rewrite: the pre-rebuild plugin tests each
 * hand-wrote the routes of the deleted storage API, and the bodies of those
 * routes ARE the fixtures (a `{conversations: [...]}` collection, a
 * `{conversation: record}` identified read, a `{error}` failure). Reading them
 * back through `jsonResponse.__body` converts the arrange-block of an old test
 * into a seeded harness table with no change to the test's assertions about
 * cells, events or records.
 *
 * The mapping is deliberately faithful to the harness contract, not to the old
 * API:
 *   - every identified record is seeded AND its id is queued as a created id, so
 *     a test whose "POST create" used to answer `{conversationId:'conv-new'}`
 *     still finds `conv-new` afterwards;
 *   - a collection failure becomes `sessionsStatus/Message` (the harness error
 *     envelope), because a 500 from the fake is what the plugin surfaces;
 *   - a `{conversation: renamed}` PUT answer is IGNORED as a stub: the double
 *     derives the renamed row from the PATCH body, which is stronger — the test
 *     then proves the client sent the new title instead of proving the fake could
 *     echo one.
 */
export function installHarnessFrom(
    routes: Array<{
        match: (url: string, ...rest: unknown[]) => boolean;
        reply: (url: string, init?: RequestInit) => Response | Promise<Response>;
    }>,
    options: HarnessTransportOptions = {}
): HarnessTransport {
    const records: SeedRecord[] = [];
    const createdIds: string[] = [];
    let sessionsError: { status: number; message: string } | undefined;
    let derivedModels: string[] | undefined;
    let derivedModelsStatus: number | undefined;
    let derivedModelsMessage: string | undefined;
    const readErrors: Record<string, { status: number; message: string }> = {};
    const deleteErrors: Record<string, { status: number; message: string }> = {};
    const seen = new Set<string>();

    const bodyOf = (route: (typeof routes)[number]): any => {
        // A test's `reply` may read `url`/`init` (the old doubles branched on the
        // method), so it is called with the probe URL and a GET — the shape whose
        // body describes the fixture rather than a mutation result.
        const response = route.reply(TEST_BASE_URL, { method: 'GET' }) as any;

        // An ASYNC reply describes a stream (the caller's own route keeps answering
        // it), not a fixture, so it carries nothing to derive.
        if (response instanceof Promise) return { body: undefined, status: 200 };

        return { body: response?.__body, status: Number(response?.status ?? 200) };
    };

    const messageOf = (body: any, status: number): string => {
        const raw = body?.error;

        if (typeof raw === 'string') return raw;
        if (typeof raw?.message === 'string') return raw.message;

        return `HTTP ${status}`;
    };

    for (const route of routes) {
        const isCollection = route.match(`${TEST_BASE_URL}?ids=x`) || route.match(TEST_BASE_URL);
        const { body, status } = bodyOf(route);

        if (Array.isArray(body?.conversations)) {
            for (const summary of body.conversations as Array<Record<string, unknown>>) {
                const id = String(summary.conversationId ?? '');

                if (id.length === 0 || seen.has(id)) continue;
                seen.add(id);
                records.push(
                    recordFixture(id, {
                        title: String(summary.title ?? ''),
                        model: String(summary.model ?? ''),
                        status: (summary.status as SeedRecord['status']) ?? 'complete',
                        messageCount: Number(summary.messageCount ?? 0),
                        // A collection row carries no messages; the identified read
                        // of the same id supplies them when the test wrote one.
                        messages: [],
                        createdAt: String(summary.createdAt ?? '2026-11-07T00:00:00.000Z'),
                        updatedAt: String(summary.updatedAt ?? '2026-11-07T00:00:01.000Z')
                    })
                );
            }

            if (status >= 400) {
                sessionsError = { status, message: messageOf(body, status) };
            }
        }

        // A failure route carries no `conversations` array at all — the old tests
        // answered a listing error with `{ error: 'Storage is down' }` — so the
        // matcher and the status are what identify it.
        if (!Array.isArray(body?.conversations) && body?.conversation === undefined && status >= 400 && isCollection) {
            sessionsError = { status, message: messageOf(body, status) };
        }

        // An OpenAI-compatible catalog envelope (`{object:'list', data:[{id}]}`) is
        // the OTHER thing a pre-rebuild route answered, and the harness catalog is
        // the online equivalent — so the fixture's ids become the transport's models.
        if (Array.isArray(body?.data)) {
            derivedModels = (body.data as Array<Record<string, unknown>>)
                .map((entry) => entry?.id)
                .filter((id): id is string => typeof id === 'string' && id.length > 0);

            if (status >= 400) {
                derivedModelsStatus = status;
                derivedModelsMessage = messageOf(body, status);
            }
        }

        if (body?.conversation !== undefined || typeof body?.conversationId === 'string') {
            const record = (body.conversation ?? {}) as SeedRecord;
            const id = String(record.conversationId ?? body.conversationId ?? '');

            if (status >= 400 && id.length > 0) {
                readErrors[id] = { status, message: messageOf(body, status) };
            }

            // A test that stubbed a FAILING DELETE expressed it as a method branch
            // on the identified route (`(init?.method ?? 'GET') === 'DELETE' ? 500 :
            // record`). Probing that branch is what turns the stub into the double's
            // own behavior, so the banner assertion still means "the server refused".
            if (id.length > 0) {
                const deleteProbe = route.reply(`${TEST_BASE_URL}/${id}`, { method: 'DELETE' }) as any;

                if (Number(deleteProbe?.status ?? 200) >= 400) {
                    deleteErrors[id] = {
                        status: Number(deleteProbe.status),
                        message: messageOf(deleteProbe?.__body, Number(deleteProbe.status))
                    };
                }
            }

            if (id.length > 0 && status < 400) {
                const seeded = recordFixture(id, record);

                seeded.conversationId = id;

                if (!seen.has(id)) {
                    seen.add(id);
                    records.push(seeded);
                    createdIds.push(id);
                } else {
                    // The collection row described the SAME conversation with no
                    // messages: the identified read is the richer source, so it
                    // wins field by field.
                    const index = records.findIndex((candidate) => candidate.conversationId === id);

                    if (index >= 0) {
                        const previous = records[index];

                        records[index] = {
                            ...previous,
                            ...seeded,
                            messages: seeded.messages.length > 0 ? seeded.messages : previous.messages,
                            usage: seeded.usage ?? previous.usage,
                            messageCount: seeded.messageCount || previous.messageCount
                        };
                    }
                }
            }
        }
    }

    // The merge is order-sensitive on purpose: a record a collection row already
    // described keeps its messages ONLY if an identified route also described it,
    // and `recordFixture` defaults fill the rest.
    const merged = records.map((record) => {
        const existing = (options.records ?? []).find((seed) => seed.conversationId === record.conversationId);

        return existing === undefined
            ? record
            : {
                  ...record,
                  messages: existing.messages.length > 0 ? existing.messages : record.messages,
                  usage: existing.usage ?? record.usage,
                  title: existing.title.length > 0 ? existing.title : record.title,
                  model: existing.model.length > 0 ? existing.model : record.model
              };
    });

    // Routes that would shadow the harness protocol are dropped: their fixtures are
    // already derived into the table above, and the URLs they matched no longer
    // exist. Anything else (a provider stream, a provider catalog on another base)
    // keeps answering, so a test that arranges a hanging stream still sees its own
    // route run.
    const shadowsHarness = (route: (typeof routes)[number]): boolean =>
        route.match('sessions', 'GET') ||
        route.match(`${TEST_HARNESS_ROOT}/sessions`, 'GET') ||
        route.match(`${TEST_HARNESS_ROOT}/models`, 'POST');
    const passthrough = routes
        .filter((route) => !shadowsHarness(route))
        .map((route) => ({ match: route.match, reply: route.reply as FetchRoute }));

    const transport = installHarness({
        records: merged,
        ...(passthrough.length === 0 || options.passthrough !== undefined ? {} : { passthrough }),
        createdIds: options.createdIds ?? createdIds,
        ...(options.models === undefined && derivedModels === undefined
            ? {}
            : { models: options.models ?? derivedModels }),
        ...(options.modelsStatus === undefined && derivedModelsStatus === undefined
            ? {}
            : { modelsStatus: options.modelsStatus ?? derivedModelsStatus }),
        ...(derivedModelsMessage === undefined || options.modelsMessage !== undefined
            ? {}
            : { modelsMessage: derivedModelsMessage }),
        ...(sessionsError === undefined || options.sessionsStatus !== undefined
            ? {}
            : { sessionsStatus: sessionsError.status, sessionsMessage: sessionsError.message }),
        ...(Object.keys(readErrors).length === 0 || options.readErrors !== undefined
            ? {}
            : { readErrors }),
        ...(Object.keys(deleteErrors).length === 0 || options.deleteErrors !== undefined
            ? {}
            : { deleteErrors }),
        ...options
    });

    return transport;
}
