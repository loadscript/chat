/**
 * INTEGRATION suite: the assembled chat graph, end to end.
 *
 * WHAT THIS FILE IS FOR (T6): every other test in src/dashboard pins ONE plugin or
 * ONE component against its own local graph. This file composes the real thing —
 * `createChatDashboard` with the full add-on set (plugins/extras.ts) — and asserts
 * the behaviour the rebuild was specified to reproduce, so a plugin that is
 * individually correct but wrong in combination fails HERE.
 *
 * THE SUBSTITUTES (and why each is honest):
 *   fetch        - plugins/harness.ts's route-matching double; an unrouted request
 *                  THROWS, so a flow that suddenly starts calling something else is
 *                  a failure rather than a silent pass.
 *   storage      - jsdom's real localStorage (cleared per test by resetStorage).
 *   the wire API - `makeServer` below. It installs the harness mini-server of
 *                  plugins/harness.ts (its session table IS the server state: a
 *                  create/append/replace is what the NEXT canonical read answers) and
 *                  passes the provider routes straight through, because the scenarios
 *                  in this file drive the OFFLINE namespace, where the browser still
 *                  streams the completion itself and persists the pair - the transport
 *                  that can be paced, held open, and failed on purpose. The online
 *                  namespace is present as the other half of every mode switch: the
 *                  harness double answers its listing, catalog and task flow, and the
 *                  harness task wire end to end is pinned in plugins/source.test.ts and
 *                  against the real listener in @underload/chat/src/server/main.test.ts.
 *                  Writing it as a table rather than mocking each response is what makes
 *                  the persistence assertions mean something: the values asserted below
 *                  are what the NEXT read returns, not what the plugin echoed.
 *   timing       - real timers, and `pollIntervalMs: 60_000` everywhere except the
 *                  R14 test. The send pipeline arms the R14 poller for the whole
 *                  duration of a request (plugins/source.ts:506-512), so a 5ms cadence
 *                  would interleave extra GETs into every other scenario's fetch log;
 *                  the poller is pinned on its own clock in its own test instead.
 *
 * NO REACT: the surfaces are covered by WorkstationShell.test.tsx, the components by
 * their own files, and src/App.test.tsx. What is under test here is the graph.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readLocalConversations, upsertLocalConversation } from '../api/offline';
import type { ConversationRecord } from '../api/conversation';
import type { Dashboard } from '@underload/dashboard';
import {
    CHAT_AGENT_CREATE_COMMAND,
    CHAT_AGENT_SET_COMMAND,
    CHAT_DRAFT_SET_COMMAND,
    CHAT_MESSAGE_CANCEL_COMMAND,
    CHAT_MESSAGE_DELETE_COMMAND,
    CHAT_MESSAGE_FORK_COMMAND,
    CHAT_MESSAGE_ROLE_COMMAND,
    CHAT_MESSAGE_SEND_COMMAND,
    CHAT_MESSAGE_UPDATE_COMMAND,
    CHAT_MODE_SET_COMMAND,
    CHAT_MODEL_SET_COMMAND,
    CHAT_SESSION_CREATE_COMMAND,
    CHAT_SESSION_SELECT_COMMAND,
    CHAT_SYSTEM_BEGIN_COMMAND,
    CHAT_SYSTEM_SAVE_COMMAND,
    CHAT_TOOL_CREATE_COMMAND,
    CHAT_AGENT_STATE,
    CHAT_DRAFT_STATE,
    CHAT_ERROR_STATE,
    CHAT_MODEL_STATE,
    CHAT_MODE_STATE,
    CHAT_MODELS_STATE,
    CHAT_PENDING_STATE,
    CHAT_SESSIONS_STATE,
    CHAT_ACTIVE_SESSION_STATE,
    CHAT_STATUS_STATE,
    CHAT_STREAMING_STATE,
    CHAT_SYSTEM_DRAFT_STATE,
    CHAT_TOOL_STORE_SERVICE,
    CHAT_TRANSCRIPT_STATE,
    CHAT_TURNS_STATE,
    CHAT_USAGE_STATE,
    CHAT_STREAM_COMPLETED_EVENT,
    CHAT_STREAM_CANCELLED_EVENT,
    CHAT_STREAM_DELTA_EVENT,
    CHAT_STREAM_STARTED_EVENT,
    CHAT_TRANSCRIPT_UPDATED_EVENT,
    type ChatMode,
    type ChatPendingTurn,
    type ChatSession,
    type ChatStatus,
    type ChatTranscript,
    type ChatTurn,
    type ChatUsage
} from './contract';
import {
    AGENTS_STORAGE_KEY,
    MODEL_STORAGE_KEY,
    OFFLINE_STORAGE_KEY,
    SETTINGS_STORAGE_KEY,
    TEST_BASE_URL,
    TEST_HARNESS_ROOT,
    TEST_OFFLINE_BASE,
    TEST_PROVIDER_URL,
    TOOLS_STORAGE_KEY,
    TRACKED_STORAGE_KEY,
    createTestChat,
    installHarness,
    jsonResponse,
    payloadsOf,
    readTrackedIds,
    recordEvents,
    recordFixture,
    resetStorage,
    seedAgents,
    seedModel,
    seedSettings,
    seedTrackedIds,
    sseDelta,
    sseResponse,
    sseUsage,
    SSE_DONE,
    type FetchDouble,
    type RecordedEvent
} from './plugins/harness';

// ——— the wire double —————————————————————————————————————————————————————————————

const MODELS_URL = `${TEST_PROVIDER_URL}/models`;
const COMPLETIONS_URL = `${TEST_PROVIDER_URL}/chat/completions`;
/** One conversation resource, exactly as api/chat-assistant.ts addresses it. */
const conversationUrl = (id: string): string => `${TEST_BASE_URL}/${encodeURIComponent(id)}`;
/** The scoped collection read every mode runs on mount (empty tracked cache = `?ids=`). */
const LIST_URL = `${TEST_BASE_URL}?ids=`;

type Role = 'system' | 'user' | 'assistant';
type StoredMessage = { role: Role; content: string; model?: string };
type StoredRecord = ReturnType<typeof recordFixture>;

/**
 * The server's title rule, verbatim (endpoints/chat-assistant/chat-assistant.ts:88-95):
 * the trimmed FIRST LINE of the first user turn, 'New conversation' when none
 * contributes one, capped at 80 characters.
 */
const deriveTitle = (messages: readonly StoredMessage[]): string => {
    const firstUser = messages.find((message) => message.role === 'user');
    const firstLine = (firstUser?.content.trim().split('\n', 1)[0] ?? '').trim();
    const title = firstLine || 'New conversation';
    return title.length > 80 ? `${title.slice(0, 77)}...` : title;
};

/** The compact row the list endpoint answers with. */
const toSummary = (record: StoredRecord) => ({
    conversationId: record.conversationId,
    title: record.title,
    model: record.model,
    status: record.status,
    messageCount: record.messageCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
});

/**
 * One scripted completion answer. A Response is returned straight away; a function
 * lets a test hold the request open (the cancel and mid-flight-switch scenarios) and
 * decide when the stream actually starts.
 */
type CompletionAnswer = Response | (() => Response | Promise<Response>);

type ServerScript = {
    /**
     * The namespace the scenario runs in. DEFAULT 'online': the harness plane, whose
     * session table is the persistence the tests check and whose clock is fixed (so the
     * fixture timestamps stay assertable). 'offline' for the scenarios that are about the
     * browser's OWN provider connection — the scripted SSE completions, the paced/cancelled
     * stream, the agent-prefixed payload — where the browser map is the persistence.
     */
    mode?: 'online' | 'offline';
    /** The GET {provider}/models catalog (offline) and the harness discovery catalog. */
    models?: readonly string[];
    /** The text a submitted ONLINE turn streams and commits. */
    reply?: string;
    /** The usage an ONLINE turn reports on its terminal frame. */
    usage?: { input: number; output: number; total: number };
    /** Records the table starts with (the "already on the server" state). */
    records?: readonly StoredRecord[];
    /** Ids handed to successive ONLINE (harness) creates, in order. */
    createdIds?: readonly string[];
    /**
     * Ids handed to successive OFFLINE (browser-map) creates, in order. A scenario that
     * starts online and switches writes to BOTH planes, and each plane mints its own ids,
     * so the two queues are separate. Absent it, the offline seam reuses `createdIds`.
     */
    offlineIds?: readonly string[];
    /** One entry per POST {provider}/chat/completions, in order. */
    completions?: readonly CompletionAnswer[];
};

type Server = {
    fetch: FetchDouble;
    /**
     * The conversation requests the harness plane saw, as `METHOD path` strings. Offline
     * scenarios assert this is EMPTY (their writes are the browser's own map), online
     * scenarios assert it exactly, and either way it is a real request log rather than an
     * echo of what the plugin thinks it sent.
     */
    wire: () => string[];
    /** Index of the first `METHOD path` in the harness request log, -1 when absent. */
    wireIndex: (method: string, path: string) => number;
    /**
     * Live table: the OFFLINE namespace's persisted map, which is where the scenarios'
     * creates, appends and replaces actually land. Mutating it (R14's "finished in another
     * tab") changes what the next read answers.
     */
    table: {
        get: (id: string) => StoredRecord | undefined;
        set: (id: string, record: StoredRecord) => void;
        keys: () => string[];
    };
    /** The namespace this backend serves, so a scenario can say which plane it asserts. */
    mode: 'online' | 'offline';
    /** The harness plane's session rows, whatever namespace is active. */
    online: {
        /** One session as the record the next canonical read answers. */
        record: (id: string) => StoredRecord | undefined;
        /** Every id the harness table holds. */
        keys: () => string[];
    };
    /** Parsed bodies of the completion POSTs, in order. */
    completionBodies: () => Record<string, unknown>[];
    /** Every conversation request on the wire (method + path + parsed body), in order. */
    storageCalls: () => Array<{ method: string; url: string; body: unknown }>;
};

/**
 * Build the fake backend.
 *
 * The harness double owns the ONLINE namespace (records, ids and catalog come from the
 * script), the provider routes own the OFFLINE transport the scenarios stream on, and the
 * table the tests poke is the browser's own conversation map — because post-rebuild that
 * is what an offline create/append/replace writes.
 */
function makeServer(script: ServerScript = {}): Server {
    const createdIds = [...(script.createdIds ?? [])];
    const completions = [...(script.completions ?? [])];

    // The OFFLINE store hands out uuids (api/offline.ts `generateLocalId`), so the
    // script's `createdIds` — the names the scenarios address their records by — are fed
    // to that same seam instead of to an online create response. A script that names fewer
    // ids than it creates gets deterministic `conv-n` fallbacks.
    let minted = 0;

    // The declared return type is a uuid TEMPLATE literal, so the readable fallback ids
    // are widened once, here, rather than at every call site.
    type MintedId = ReturnType<typeof globalThis.crypto.randomUUID>;

    const offlineQueue = [...(script.offlineIds ?? script.createdIds ?? [])];

    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
        () => (offlineQueue.shift() ?? `local-${(minted += 1)}`) as MintedId
    );
    const completionBodies: Record<string, unknown>[] = [];

    const answers = (index: number): CompletionAnswer | undefined =>
        index < completions.length ? completions[index] : completions[completions.length - 1];

    const mode = script.mode ?? 'online';

    if (mode === 'offline') {
        // The offline namespace: its records go into localStorage, and its provider base
        // is the URL the scripted completions answer.
        seedSettings('offline', TEST_PROVIDER_URL);
    } else {
        // The online namespace: the harness double's session table IS the store, and the
        // provider routes stay mounted only so an accidental offline call would surface.
        seedSettings('online', '');
    }
    for (const record of script.records ?? []) {
        if (mode === 'offline') upsertLocalConversation(record);
    }

    const transport = installHarness({
        records: script.records ?? [],
        models: script.models ?? [],
        ...(script.reply === undefined ? {} : { reply: script.reply }),
        ...(script.usage === undefined ? {} : { usage: script.usage }),
        ...(createdIds.length === 0 ? {} : { createdIds }),
        passthrough: [
            {
                match: (url: string) => url === MODELS_URL,
                reply: () =>
                    jsonResponse(
                        200,
                        // The relay's envelope: entries are objects with an `id`.
                        { object: 'list', data: (script.models ?? []).map((id) => ({ id })) }
                    )
            },
            {
                match: (url: string) => url === COMPLETIONS_URL,
                reply: async (_url: string, init?: RequestInit) => {
                    const index = completionBodies.length;

                    completionBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);

                    const answer = answers(index);

                    return typeof answer === 'function'
                        ? await answer()
                        : (answer ?? jsonResponse(500, { error: 'No scripted completion' }));
                }
            }
        ]
    });

    // The table the scenarios poke: the browser map in the offline namespace, the
    // harness session table online (via the double's `recordOf`, so the value asserted is
    // what the NEXT canonical read answers rather than what the plugin echoed).
    const offlineTable = {
        get: (id: string) => readLocalConversations()[id] as StoredRecord | undefined,
        set: (_id: string, record: StoredRecord) => {
            upsertLocalConversation(record as ConversationRecord);
        },
        keys: () => Object.keys(readLocalConversations())
    };
    const onlineTable = {
        get: (id: string) => transport.recordOf(id) as StoredRecord | undefined,
        set: (id: string, record: StoredRecord) => {
            // An out-of-band settle in the online namespace is a write to the session
            // table: replace the row and its transcript wholesale.
            transport.dropSession(id);
            transport.putConversation(record);
        },
        keys: () => transport.sessions().map((row: { id: string }) => row.id)
    };

    const wirePaths = () =>
        transport
            .calls()
            .filter((call) => call.url.startsWith(`${TEST_HARNESS_ROOT}/sessions`))
            .map((call) => `${call.method} ${call.url.split('?')[0]}`);

    return {
        fetch: transport,
        wire: wirePaths,
        wireIndex: (method: string, path: string) =>
            wirePaths().findIndex((entry) => entry === `${method} ${path}`),
        mode,
        table: mode === 'offline' ? offlineTable : onlineTable,
        online: {
            record: (id: string) => transport.recordOf(id) as StoredRecord | undefined,
            keys: () => transport.sessions().map((row: { id: string }) => row.id)
        },
        completionBodies: () => completionBodies,
        // "Storage calls" on the new wire are the harness conversation requests: same
        // shape (method, url, parsed body), one namespace over.
        storageCalls: () =>
            transport
                .calls()
                .filter((call) => call.url.startsWith(`${TEST_HARNESS_ROOT}/sessions`))
                .map((call) => ({ method: call.method, url: call.url.split('?')[0], body: call.body }))
    };
}

// ——— scenario helpers —————————————————————————————————————————————————————————————

/** A composed instance with the poller parked (see the timing note in the header). */
const owned: Dashboard[] = [];
const composed = (): Dashboard => {
    const instance = createTestChat({ pollIntervalMs: 60_000 });
    owned.push(instance);
    return instance;
};
/** Registers an instance built with non-default options so afterEach still reaps it. */
const track = (instance: Dashboard): Dashboard => {
    owned.push(instance);
    return instance;
};

const readTranscript = (instance: Dashboard): ChatTranscript =>
    instance.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get();
const readTurns = (instance: Dashboard): readonly ChatTurn[] =>
    instance.state<readonly ChatTurn[]>(CHAT_TURNS_STATE).get();
const readSessions = (instance: Dashboard): readonly ChatSession[] =>
    instance.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get();
const readCell = <T,>(instance: Dashboard, id: string): T => instance.state<T>(id).get();

const send = async (instance: Dashboard): Promise<void> =>
    instance.execute<void, Promise<void>>(CHAT_MESSAGE_SEND_COMMAND);

/**
 * Every storage request a scenario produced, as `METHOD url`, SORTED. The mount-time
 * history read is queued one microtask after setup while the flow's first write is
 * issued synchronously by `execute`, so the two can land in either order; the sorted
 * set is still an EXACT assertion, and the causal order (create before rollback) is
 * pinned where it is the actual contract.
 */
const storageRequests = (backend: Server): string[] =>
    backend
        .storageCalls()
        .map((call) => `${call.method} ${call.url}`)
        .sort();

/** Position of one call in the wire order; -1 when it never happened. */
const callIndex = (backend: Server, method: string, url: string): number =>
    backend.storageCalls().findIndex((call) => call.method === method && call.url === url);

/**
 * The conversation WRITES on the harness plane (`METHOD path`, wire order). A rollback or a
 * cancelled turn must leave this empty in either namespace: an offline write never reaches
 * the wire, and an online abandoned turn never replaces a transcript.
 */
/**
 * The history the ACTIVE namespace holds for one conversation: the browser map offline,
 * the harness session table online (both reached through `server.table`, which is why the
 * scenarios below never have to know which plane they are asserting.
 */
const historyOf = (backend: Server, id: string): StoredMessage[] | undefined =>
    backend.table.get(id)?.messages;

const writesOf = (backend: Server): string[] =>
    backend
        .storageCalls()
        .filter((call) => call.method !== 'GET')
        .map((call) => `${call.method} ${call.url}`);

// ——— lifecycle ————————————————————————————————————————————————————————————————————

beforeEach(() => {
    resetStorage();
    // The returning-browser defaults: online, no custom base, one remembered model.
    // Seeding the model keeps every payload assertion below independent of the
    // catalog's adoption order (plugins/source.ts:777-783 prefers the remembered one).
    seedSettings('online', '');
    seedModel('alpha/flash');
});

afterEach(() => {
    // Every instance this file built is reaped, so no dashboard's subscriptions or
    // R14 interval outlive the scenario that created it.
    for (const chat of owned.splice(0)) chat.dispose();
    vi.unstubAllGlobals();
});

describe('integration: the send pipeline end to end', () => {
    it('creates a session, streams a reply, persists the pair and the usage', async () => {
        // The OFFLINE namespace: this scenario is about the browser's own provider
        // connection (the scripted SSE deltas, the usage frame) and about what the
        // browser's map persists afterwards. Online the same send is the task/stream
        // contract, pinned end to end in plugins/source.test.ts and against the real
        // listener in @underload/chat/src/server/main.test.ts.
        const server = makeServer({
            mode: 'offline',
            models: ['alpha/flash', 'zeta/turbo'],
            createdIds: ['conv-1'],
            completions: [
                () =>
                    sseResponse([
                        sseDelta('Hel'),
                        sseDelta('lo'),
                        sseUsage({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }),
                        SSE_DONE
                    ])
            ]
        });
        const instance = composed();
        const events: RecordedEvent[] = recordEvents(instance, [
            CHAT_STREAM_STARTED_EVENT,
            CHAT_STREAM_DELTA_EVENT,
            CHAT_STREAM_COMPLETED_EVENT,
            CHAT_TRANSCRIPT_UPDATED_EVENT
        ]);

        // 1. New chat: POST the collection, then read the empty record back.
        const created = await instance.execute<void, string | null>(CHAT_SESSION_CREATE_COMMAND);
        expect(created).toBe('conv-1');
        expect(readCell<string | null>(instance, CHAT_ACTIVE_SESSION_STATE)).toBe('conv-1');
        // The row lands immediately, before any turn exists. The offline store stamps its
        // own instants (api/offline.ts `upsertLocalConversation`), so the two clock fields
        // are read from the row rather than asserted as literals; every other field is
        // pinned, including the empty history the create leaves behind.
        const createdRow = readSessions(instance);

        expect(createdRow.map((row) => [row.conversationId, row.title, row.model, row.status, row.messageCount])).toEqual([
            ['conv-1', 'New conversation', 'alpha/flash', 'complete', 0]
        ]);
        expect(typeof createdRow[0].createdAt).toBe('string');
        expect(createdRow[0].updatedAt >= createdRow[0].createdAt).toBe(true);

        // 2. The composer writes the draft through the command (T6: chat.draft.set).
        instance.execute<string, void>(CHAT_DRAFT_SET_COMMAND, 'Hello assistant');
        expect(readCell<string>(instance, CHAT_DRAFT_STATE)).toBe('Hello assistant');

        // 3. Send.
        await send(instance);

        // The provider payload is the OpenAI-compatible pair, with the remembered
        // model and the composer text as the only history (an empty chat).
        expect(server.completionBodies()).toEqual([
            {
                model: 'alpha/flash',
                stream: true,
                stream_options: { include_usage: true },
                messages: [{ role: 'user', content: 'Hello assistant' }]
            }
        ]);

        // The completed pair is the transcript, with the producing model attributed.
        expect([...readTranscript(instance)]).toEqual([
            { role: 'user', content: 'Hello assistant' },
            { role: 'assistant', content: 'Hello', model: 'alpha/flash' }
        ]);
        // `chat.turns` is the derived list the log paints: every row unfolded except
        // the newest assistant turn (the default-collapse rule, plugins/core.ts:181).
        expect(readTurns(instance).map((turn) => [turn.index, turn.role, turn.collapsed, turn.model])).toEqual([
            [0, 'user', true, ''],
            [1, 'assistant', false, 'alpha/flash']
        ]);

        // The usage frame reached the cell the composer's token line reads.
        expect(readCell<ChatUsage | null>(instance, CHAT_USAGE_STATE)).toEqual({
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18
        });

        // Every in-flight buffer is released, and the label is back to idle.
        expect(readCell<ChatPendingTurn | null>(instance, CHAT_PENDING_STATE)).toBeNull();
        expect(readCell<string>(instance, CHAT_STREAMING_STATE)).toBe('');
        expect(readCell<string>(instance, CHAT_DRAFT_STATE)).toBe('');
        expect(readCell<ChatStatus>(instance, CHAT_STATUS_STATE)).toBe('idle');
        expect(readCell<string>(instance, CHAT_ERROR_STATE)).toBe('');

        // The sidebar row settled to the canonical record, with the title the CLIENT
        // derives from the first user turn (the harness never derives one, and the offline
        // store mirrors the old server's rule - src/api/conversation.ts `deriveTitle`).
        // The two clock fields are the offline store's own stamps, so they are pinned as
        // "the create's instants, moved forward by the append", not as literals.
        const settledRow = readSessions(instance);

        expect(settledRow.map((row) => [
            row.conversationId,
            row.title,
            row.model,
            row.status,
            row.messageCount
        ])).toEqual([['conv-1', 'Hello assistant', 'alpha/flash', 'complete', 2]]);
        expect(settledRow[0].createdAt).toBe(createdRow[0].createdAt);
        expect(
            Date.parse(settledRow[0].updatedAt) > Date.parse(settledRow[0].createdAt) ||
                settledRow[0].updatedAt === settledRow[0].createdAt
        ).toBe(true);

        // The stream's event trail, in order, with the ACCUMULATED snapshot per delta.
        expect(payloadsOf(events, CHAT_STREAM_STARTED_EVENT)).toEqual([
            { sessionId: 'conv-1', requestId: 'request-1' }
        ]);
        expect(payloadsOf(events, CHAT_STREAM_DELTA_EVENT)).toEqual([
            { sessionId: 'conv-1', requestId: 'request-1', text: 'Hel' },
            { sessionId: 'conv-1', requestId: 'request-1', text: 'Hello' }
        ]);
        expect(payloadsOf(events, CHAT_STREAM_COMPLETED_EVENT)).toEqual([
            { sessionId: 'conv-1', requestId: 'request-1', text: 'Hello' }
        ]);
        expect(payloadsOf(events, CHAT_TRANSCRIPT_UPDATED_EVENT)).toEqual([
            // The create's empty record (turnCount 0), then the completed turn.
            { sessionId: 'conv-1', turnCount: 0 },
            { sessionId: 'conv-1', turnCount: 2 }
        ]);

        // Persistence: the append carried the pair AND the usage, and the browser
        // remembers both the model and the conversation. Offline the append is a write to
        // the browser's own map, so the map — not a request body — is the evidence, and
        // nothing at all went to the harness plane.
        expect(server.table.get('conv-1')).toMatchObject({
            messages: [
                { role: 'user', content: 'Hello assistant' },
                { role: 'assistant', content: 'Hello', model: 'alpha/flash' }
            ],
            model: 'alpha/flash',
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
        });
        expect(server.wire()).toEqual([]);
        expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBe('alpha/flash');
        expect(readTrackedIds()).toEqual(['conv-1']);
        // What the fake server actually holds is the real check that it persisted.
        expect(server.table.get('conv-1')?.messages).toEqual([
            { role: 'user', content: 'Hello assistant' },
            { role: 'assistant', content: 'Hello', model: 'alpha/flash' }
        ]);
    });

    it('rolls the pending record back and restores the draft when the provider fails', async () => {
        const server = makeServer({
            mode: 'offline',
            models: ['alpha/flash'],
            createdIds: ['conv-2'],
            // A non-2xx BEFORE streaming starts: api/provider.ts reads `error` from
            // the body and re-throws it verbatim (api/provider.ts:69-77).
            completions: [jsonResponse(500, { error: 'Provider exploded' })]
        });
        const instance = composed();

        instance.execute<string, void>(CHAT_DRAFT_SET_COMMAND, 'Hello assistant');
        await send(instance);

        // The failure is the stage's banner, verbatim.
        expect(readCell<string>(instance, CHAT_ERROR_STATE)).toBe('Provider exploded');
        // The text is back in the composer for a retry, and nothing is in flight.
        expect(readCell<string>(instance, CHAT_DRAFT_STATE)).toBe('Hello assistant');
        expect(readCell<ChatPendingTurn | null>(instance, CHAT_PENDING_STATE)).toBeNull();
        expect(readCell<string>(instance, CHAT_STREAMING_STATE)).toBe('');
        expect(readCell<ChatStatus>(instance, CHAT_STATUS_STATE)).toBe('idle');
        // The up-front 'pending' record is gone from BOTH the surface and the store:
        // a generation that never answered leaves no phantom chat behind.
        expect(readSessions(instance)).toEqual([]);
        expect(readCell<string | null>(instance, CHAT_ACTIVE_SESSION_STATE)).toBeNull();
        expect([...server.table.keys()]).toEqual([]);
        // The rollback contract on the new wire: the failed generation wrote NOTHING to
        // either plane — the create, the read-back and the rollback are all local-map
        // operations (so the harness plane saw no conversation traffic at all), and the
        // only wire request in the scenario is the one provider completion that failed.
        expect(server.wire()).toEqual([]);
        expect(
            server.fetch
                .calls()
                .map((call) => `${call.method} ${call.url.split('?')[0]}`)
                .sort()
        ).toEqual(
            [
                `GET ${MODELS_URL}`,
                `POST ${COMPLETIONS_URL}`
            ].sort()
        );
        expect(writesOf(server)).toEqual([]);
        // The tracked cache is un-dirtied by the rollback, and nothing was appended.
        expect(readTrackedIds()).toEqual([]);
        expect(server.completionBodies()).toHaveLength(1);
    });

    it('cancels mid-stream: the partial is kept, the draft returns, nothing persists', async () => {
        // The completion is gated so the cancel genuinely lands WHILE the request is
        // open, and only then does the first (and only) token arrive.
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const server = makeServer({
            mode: 'offline',
            models: ['alpha/flash'],
            createdIds: ['conv-3'],
            completions: [
                async () => {
                    await gate;
                    return sseResponse([sseDelta('Half'), sseDelta(' a reply'), SSE_DONE]);
                }
            ]
        });
        const instance = composed();
        const events: RecordedEvent[] = recordEvents(instance, [
            CHAT_STREAM_CANCELLED_EVENT,
            CHAT_STREAM_COMPLETED_EVENT
        ]);

        instance.execute<string, void>(CHAT_DRAFT_SET_COMMAND, 'Hello assistant');
        const sending = send(instance);
        await vi.waitFor(() => {
            expect(readCell<ChatPendingTurn | null>(instance, CHAT_PENDING_STATE)).not.toBeNull();
        });

        // The stop control while 'sending': it reports that something was in flight.
        expect(instance.execute<void, boolean>(CHAT_MESSAGE_CANCEL_COMMAND)).toBe(true);
        // A second stop is not a second cancellation.
        expect(instance.execute<void, boolean>(CHAT_MESSAGE_CANCEL_COMMAND)).toBe(false);
        release();
        await sending;

        // `sessionId: ''` is the OFFLINE new-chat rule, not a defect: the browser has no
        // id for the turn until the completed pair is persisted, so the stream events carry
        // the request id only (src/dashboard/plugins/source.ts:541-544). The online twin of
        // this event carries a real session id (plugins/source.test.ts). The `text` is
        // what the stream had delivered when the abort was observed: the response is held
        // open, so both frames arrive in the same burst once the gate releases, and the
        // cancelled event reports that text rather than an empty string — the scenario's
        // own title, "the partial is kept", in its new spelling.
        expect(payloadsOf(events, CHAT_STREAM_CANCELLED_EVENT)).toEqual([
            { sessionId: '', requestId: 'request-1', text: 'Half a reply' }
        ]);
        expect(payloadsOf(events, CHAT_STREAM_COMPLETED_EVENT)).toEqual([]);
        // The retry text is back, and the stopped turn was never persisted.
        expect(readCell<string>(instance, CHAT_DRAFT_STATE)).toBe('Hello assistant');
        expect(readCell<ChatPendingTurn | null>(instance, CHAT_PENDING_STATE)).toBeNull();
        expect(readTranscript(instance)).toEqual([]);
        // Nothing persisted: the sending (offline) map holds no record at all.
        expect([...server.table.keys()]).toEqual([]);
        // Nothing was appended and nothing was replaced: the stopped turn wrote to neither
        // plane, and the only requests are the catalog and the held-open completion.
        expect(server.wire()).toEqual([]);
        expect(writesOf(server)).toEqual([]);
        expect(
            server.fetch
                .calls()
                .map((call) => `${call.method} ${call.url.split('?')[0]}`)
                .sort()
        ).toEqual(
            [
                `GET ${MODELS_URL}`,
                `POST ${COMPLETIONS_URL}`
            ].sort()
        );
    });

    // The direction is OFFLINE->ONLINE: only the browser's own provider connection can be
    // held open across a namespace switch (an online turn is answered by the harness stream
    // in one burst of frames, see plugins/source.test.ts). The property under test is
    // direction-independent: the stale settle writes into the NAMESPACE THAT SENT IT and
    // never into the one on screen.
    it('R7: an offline->online switch mid-flight keeps its writes in the sending namespace', async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const server = makeServer({
            mode: 'offline',
            models: ['alpha/flash'],
            createdIds: ['conv-4'],
            completions: [
                async () => {
                    await gate;
                    return sseResponse([sseDelta('Late reply'), SSE_DONE]);
                }
            ]
        });
        // One conversation already exists OFFLINE, so the new namespace has a surface
        // of its own to keep (and the stale settle has something it must NOT touch).
        const instance = composed();

        instance.execute<string, void>(CHAT_DRAFT_SET_COMMAND, 'Hello assistant');
        const sending = send(instance);
        await vi.waitFor(() => {
            expect(readCell<ChatPendingTurn | null>(instance, CHAT_PENDING_STATE)).not.toBeNull();
        });

        // The switch is the whole scenario: chat.mode.set bumps the namespace epoch
        // and resets the surface (plugins/settings.ts:138-177 -> plugins/core.ts:533).
        instance.execute<ChatMode, void>(CHAT_MODE_SET_COMMAND, 'online');
        expect(readCell<ChatMode>(instance, CHAT_MODE_STATE)).toBe('online');
        // The composer in the NEW namespace is the one the send left behind (it
        // cleared the draft before generating, and a switch never rewrites it), and
        // the old namespace's completion is not allowed to fill it back in.
        expect(readCell<string>(instance, CHAT_DRAFT_STATE)).toBe('');
        release();
        await sending;

        // The NEW namespace owns every surface cell: the late reply painted nothing.
        expect(readTranscript(instance)).toEqual([]);
        expect(readCell<ChatPendingTurn | null>(instance, CHAT_PENDING_STATE)).toBeNull();
        expect(readCell<string>(instance, CHAT_STREAMING_STATE)).toBe('');
        expect(readCell<string | null>(instance, CHAT_ACTIVE_SESSION_STATE)).toBeNull();
        expect(readCell<ChatUsage | null>(instance, CHAT_USAGE_STATE)).toBeNull();
        expect(readCell<ChatStatus>(instance, CHAT_STATUS_STATE)).toBe('idle');
        // The ONLINE sidebar lists the harness table, which this send never touched.
        expect(readSessions(instance)).toEqual([]);
        expect(server.online.keys()).toEqual([]);
        // The write still landed where it started: the SENDING (offline) namespace's own
        // record holds the turn, with its per-message attribution intact — the offline
        // store is the plane that keeps it (MISSING-FEATURES.md entry 6).
        const sendingId = server.table.keys().find((id) => id !== 'conv-4') ?? 'conv-4';

        expect(server.table.get(sendingId)?.messages).toEqual([
            { role: 'user', content: 'Hello assistant' },
            { role: 'assistant', content: 'Late reply', model: 'alpha/flash' }
        ]);
        expect(readTrackedIds()).toEqual(['conv-4']);
        // The offline namespace is the one that was written: its map holds the record.
        expect(JSON.parse(String(window.localStorage.getItem(OFFLINE_STORAGE_KEY)))[sendingId]).toBeDefined();
        expect(server.completionBodies()).toEqual([
            {
                model: 'alpha/flash',
                stream: true,
                stream_options: { include_usage: true },
                messages: [{ role: 'user', content: 'Hello assistant' }]
            }
        ]);
    });

    it('R14: polls a pending conversation, merges the settle, then stops watching', async () => {
        const pending = recordFixture('conv-p', { status: 'pending', messages: [{ role: 'user', content: 'Hello assistant' }] });
        const settled = recordFixture('conv-p', {
            title: 'Finished elsewhere',
            status: 'complete',
            messages: [
                { role: 'user', content: 'Hello assistant' },
                { role: 'assistant', content: 'Hello user', model: 'alpha/flash' }
            ],
            usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
        });
        // R14 polling is the OFFLINE completion path since the rebuild: online a turn is
        // settled by the `harness.v1` stream this browser opened (MISSING-FEATURES.md
        // entry 4), and the poller only runs against the browser's own store.
        const server = makeServer({ mode: 'offline', models: ['alpha/flash'], records: [pending] });
        seedTrackedIds(['conv-p']);
        // The only scenario that wants the real cadence.
        const instance = track(createTestChat());

        await vi.waitFor(() => {
            expect(readSessions(instance)).toHaveLength(1);
        });
        await instance.execute<string, void>(CHAT_SESSION_SELECT_COMMAND, 'conv-p');
        expect([...readTranscript(instance)]).toEqual([{ role: 'user', content: 'Hello assistant' }]);

        // A row that is still 'pending' while this browser is looking at it is the watch
        // target (plugins/source.ts:315-337). Offline the watch re-reads the browser's own
        // map on its cadence, so there is no request count to watch — the proof that the
        // conversation is being followed is that an out-of-band map write is adopted below
        // without any further user action.

        // The server finishes the turn out-of-band (another tab / a retried send).
        server.table.set('conv-p', settled);
        await vi.waitFor(() => {
            expect([...readTranscript(instance)]).toEqual(settled.messages);
        });
        expect(readCell<ChatUsage | null>(instance, CHAT_USAGE_STATE)).toEqual({
            prompt_tokens: 5,
            completion_tokens: 4,
            total_tokens: 9
        });
        expect(readSessions(instance)[0].status).toBe('complete');

        // Settled = watched no more: the timer is cleared, so a LATER write to the same
        // record is not adopted (the behavioral equivalent of a frozen request count, and
        // offline the only thing a test can observe).
        server.table.set('conv-p', { ...settled, title: 'Written after the settle' });
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect([...readTranscript(instance)]).toEqual(settled.messages);
        expect(readSessions(instance)[0].title).toBe('Finished elsewhere');
        // The offline watch issues no requests at all: the only wire traffic in the whole
        // scenario is the mount's catalog read.
        expect(
            server.fetch.calls().map((call) => `${call.method} ${call.url.split('?')[0]}`)
        ).toEqual([`GET ${MODELS_URL}`]);
    });
});

describe('integration: the agent prefix reaches the outgoing payload', () => {
    it('opens a new chat with the agent system prompt plus its example turns', async () => {
        seedAgents([
            {
                id: 'agent-1',
                name: 'Scout',
                systemPrompt: 'Answer briefly',
                messages: [
                    { role: 'user', content: 'Hi' },
                    { role: 'assistant', content: 'Hey' }
                ],
                tools: []
            }
        ]);
        const server = makeServer({
            mode: 'offline',
            models: ['alpha/flash'],
            createdIds: ['conv-5'],
            completions: [() => sseResponse([sseDelta('Brief.'), SSE_DONE])]
        });
        const instance = composed();

        // chat.agent.set is owned by chat.agents (plugins/agents.ts:140).
        instance.execute<string, void>(CHAT_AGENT_SET_COMMAND, 'agent-1');
        expect(readCell<string>(instance, CHAT_AGENT_STATE)).toBe('agent-1');
        instance.execute<string, void>(CHAT_DRAFT_SET_COMMAND, 'Go');
        await send(instance);

        expect(server.completionBodies()).toEqual([
            {
                model: 'alpha/flash',
                stream: true,
                stream_options: { include_usage: true },
                messages: [
                    { role: 'system', content: 'Answer briefly' },
                    { role: 'user', content: 'Hi' },
                    { role: 'assistant', content: 'Hey' },
                    { role: 'user', content: 'Go' }
                ]
            }
        ]);
        // The persisted record keeps the WHOLE block, not just its system line —
        // exactly the oracle's append payload (monolith :4027
        // `[...systemPrefix, user, assistant]`, where systemPrefix is the agent block).
        // The map is where the whole agent block persists offline (a POST body on the
        // deleted storage endpoint is no longer the evidence).
        expect(server.table.get('conv-5')).toMatchObject({
            messages: [
                { role: 'system', content: 'Answer briefly' },
                { role: 'user', content: 'Hi' },
                { role: 'assistant', content: 'Hey' },
                { role: 'user', content: 'Go' },
                { role: 'assistant', content: 'Brief.', model: 'alpha/flash' }
            ],
            model: 'alpha/flash'
        });
        // ...and the surface shows exactly that history.
        expect([...readTranscript(instance)]).toEqual([
            { role: 'system', content: 'Answer briefly' },
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hey' },
            { role: 'user', content: 'Go' },
            { role: 'assistant', content: 'Brief.', model: 'alpha/flash' }
        ]);
    });
});

// The title used to name the endpoint verb. Online that verb is gone: a history rewrite
// is one thread's transcript DOCUMENT (`PUT /sessions/{id}/threads/{tid}/transcript` with
// an optimistic `if_revision`) plus a canonical re-read, and a harness transcript message
// is `{role, content}` only, so the per-message model these scenarios pin survives only in
// the OFFLINE store (MISSING-FEATURES.md entry 6) - which is also the only plane where
// forking still works (entry 1). The online transcript-document wire is pinned in
// plugins/transcript.test.ts, and the whole online send in plugins/source.test.ts.
describe('integration: history rewrites persist through the identified replace', () => {
    /** The shared starting state: one 3-turn record, already tracked and open. */
    const seeded = (): { server: Server; instance: Dashboard } => {
        const server = makeServer({
            mode: 'offline',
            models: ['alpha/flash'],
            createdIds: ['conv-fork'],
            records: [
                recordFixture('conv-1', {
                    // The row's recorded model is what a fork inherits
                    // (plugins/transcript.ts:322-325), so it is part of the scenario.
                    model: 'zeta/turbo',
                    messages: [
                        { role: 'system', content: 'Answer briefly' },
                        { role: 'user', content: 'One' },
                        { role: 'assistant', content: 'Two', model: 'zeta/turbo' }
                    ]
                })
            ]
        });
        seedTrackedIds(['conv-1']);
        return { server, instance: composed() };
    };

    it('switches a turn role, deletes a turn, commits an inline edit and refuses a user-less fork', async () => {
        const { server, instance } = seeded();
        await vi.waitFor(() => expect(readSessions(instance)).toHaveLength(1));
        await instance.execute<string, void>(CHAT_SESSION_SELECT_COMMAND, 'conv-1');
        expect(readTranscript(instance)).toHaveLength(3);

        // ——— role switch: user -> assistant, with the producing model attributed ——
        await instance.execute<{ index: number; role: 'assistant' }, Promise<void>>(CHAT_MESSAGE_ROLE_COMMAND, {
            index: 1,
            role: 'assistant'
        });
        // The replace persisted exactly the rewritten history: read the store back rather
        // than trusting what the plugin believes it sent.
        expect(historyOf(server, 'conv-1')).toEqual([
            { role: 'system', content: 'Answer briefly' },
            { role: 'assistant', content: 'One', model: 'alpha/flash' },
            { role: 'assistant', content: 'Two', model: 'zeta/turbo' }
        ]);
        expect([...readTranscript(instance)][1]).toEqual({ role: 'assistant', content: 'One', model: 'alpha/flash' });

        // ——— delete the middle turn ————————————————————————————————————————————
        await instance.execute<number, Promise<void>>(CHAT_MESSAGE_DELETE_COMMAND, 1);
        // A delete is a replace of the remaining history (there is no per-message DELETE).
        expect(historyOf(server, 'conv-1')).toEqual([
            { role: 'system', content: 'Answer briefly' },
            { role: 'assistant', content: 'Two', model: 'zeta/turbo' }
        ]);
        expect([...readTranscript(instance)]).toEqual([
            { role: 'system', content: 'Answer briefly' },
            { role: 'assistant', content: 'Two', model: 'zeta/turbo' }
        ]);

        // ——— inline edit commit (the contentEditable blur) ——————————————————————
        await instance.execute<{ index: number; content: string }, Promise<void>>(CHAT_MESSAGE_UPDATE_COMMAND, {
            index: 1,
            content: '  Rewritten reply  '
        });
        // The inline edit is the third replace of the same document; the store holds the
        // trimmed text with the turn's own attribution intact.
        expect(historyOf(server, 'conv-1')).toEqual([
            { role: 'system', content: 'Answer briefly' },
            { role: 'assistant', content: 'Rewritten reply', model: 'zeta/turbo' }
        ]);
        // The commit trims and keeps the turn's own attribution (plugins/transcript.ts:271-285).
        expect([...readTranscript(instance)][1].content).toBe('Rewritten reply');

        // ——— fork: a branch with NO user turn is refused, and nothing is written —————
        // Both planes refuse this prefix, for different documented reasons: ONLINE the
        // affordance is gone (a harness session cannot be seeded with a history,
        // MISSING-FEATURES.md entry 1); OFFLINE the store requires at least one user turn
        // in a created history (src/api/offline.ts:368-372, "a system-prompt-only history
        // cannot be continued"). The pre-rebuild endpoint accepted it, so the claim here is
        // re-scoped from "the branch exists" to "the refusal leaves the source intact" —
        // a forked prefix WITH a user turn is pinned in plugins/transcript.test.ts.
        const forked = await instance.execute<number, Promise<string | null>>(CHAT_MESSAGE_FORK_COMMAND, 1);

        expect(forked).toBeNull();
        expect(server.table.keys()).toEqual(['conv-1']);
        expect(historyOf(server, 'conv-1')).toEqual([
            { role: 'system', content: 'Answer briefly' },
            { role: 'assistant', content: 'Rewritten reply', model: 'zeta/turbo' }
        ]);
        expect(readCell<string | null>(instance, CHAT_ACTIVE_SESSION_STATE)).toBe('conv-1');
        expect([...readTranscript(instance)]).toEqual([
            { role: 'system', content: 'Answer briefly' },
            { role: 'assistant', content: 'Rewritten reply', model: 'zeta/turbo' }
        ]);
        // The refused branch tracked nothing, so a reload shows exactly this browser's one
        // conversation.
        expect(readTrackedIds()).toEqual(['conv-1']);
    });

    it('saves a system-prompt draft onto an existing chat as a leading system message', async () => {
        const { server, instance } = seeded();
        await vi.waitFor(() => expect(readSessions(instance)).toHaveLength(1));
        await instance.execute<string, void>(CHAT_SESSION_SELECT_COMMAND, 'conv-1');

        instance.execute<void, void>(CHAT_SYSTEM_BEGIN_COMMAND);
        instance.state<string>(CHAT_SYSTEM_DRAFT_STATE).set('Think first');
        await instance.execute<void, Promise<void>>(CHAT_SYSTEM_SAVE_COMMAND);

        // OFFLINE the prompt is a leading message, so the save replaces the history with
        // the block at index 0; the store is the evidence (online it is an agent
        // instruction instead, and that path is pinned in plugins/system-prompt.test.ts).
        expect(historyOf(server, 'conv-1')).toEqual([
            { role: 'system', content: 'Think first' },
            { role: 'system', content: 'Answer briefly' },
            { role: 'user', content: 'One' },
            { role: 'assistant', content: 'Two', model: 'zeta/turbo' }
        ]);
        expect([...readTranscript(instance)][0]).toEqual({ role: 'system', content: 'Think first' });
        // The draft is consumed once persisted (plugins/system-prompt.ts:153).
        expect(readCell<string>(instance, CHAT_SYSTEM_DRAFT_STATE)).toBe('');
    });

    it('creates its own record when the prompt is saved on a new chat', async () => {
        const server = makeServer({
            mode: 'offline',
            models: ['alpha/flash'],
            createdIds: ['conv-prompt']
        });
        const instance = composed();

        instance.execute<void, void>(CHAT_SYSTEM_BEGIN_COMMAND);
        instance.state<string>(CHAT_SYSTEM_DRAFT_STATE).set('Answer briefly');
        await instance.execute<void, Promise<void>>(CHAT_SYSTEM_SAVE_COMMAND);

        // The prompt-only record exists in the browser's map, and the wire stayed silent
        // apart from the mount's catalog read: an offline create is not a request.
        expect(storageRequests(server!)).toEqual([]);
        expect(
            server.fetch.calls().map((call) => `${call.method} ${call.url.split('?')[0]}`)
        ).toEqual([`GET ${MODELS_URL}`]);
        // The create carries the selected model + the prompt (no provider round trip).
        expect(server.table.get('conv-prompt')).toMatchObject({
            model: 'alpha/flash',
            status: 'complete',
            messages: [{ role: 'system', content: 'Answer briefly' }]
        });
        expect(readCell<string | null>(instance, CHAT_ACTIVE_SESSION_STATE)).toBe('conv-prompt');
        expect([...readTranscript(instance)]).toEqual([{ role: 'system', content: 'Answer briefly' }]);
    });
});

describe('integration: the model catalog, the picker command and persistence', () => {
    it('loads the catalog on mount and persists an explicit pick', async () => {
        // OFFLINE discovery is the provider's `GET {base}/models`; the online catalog is
        // the harness discovery POST (a different request shape, pinned in
        // plugins/sessions.test.ts and plugins/settings.test.ts).
        const server = makeServer({
            mode: 'offline',
            models: ['alpha/flash', 'zeta/turbo']
        });
        const instance = composed();

        await vi.waitFor(() => {
            expect(readCell<readonly string[]>(instance, CHAT_MODELS_STATE)).toEqual(['alpha/flash', 'zeta/turbo']);
        });
        expect(server.fetch.callsFor(MODELS_URL)).toHaveLength(1);
        // The remembered model wins over the catalog's first entry.
        expect(readCell<string>(instance, CHAT_MODEL_STATE)).toBe('alpha/flash');

        instance.execute<string, void>(CHAT_MODEL_SET_COMMAND, 'zeta/turbo');
        expect(readCell<string>(instance, CHAT_MODEL_STATE)).toBe('zeta/turbo');
        expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBe('zeta/turbo');
    });

    it('does not persist the catalog default it adopts itself', async () => {
        // A first-run browser (no remembered model) keeps following the catalog's
        // order until the operator actually chooses (monolith :2776-2782).
        resetStorage();
        seedSettings('online', '');
        const server = makeServer({ models: ['alpha/flash'] });
        const instance = composed();

        await vi.waitFor(() => {
            expect(readCell<string>(instance, CHAT_MODEL_STATE)).toBe('alpha/flash');
        });
        expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBeNull();
    });
});

describe('integration: every persisted key the UI owns', () => {
    it('writes the documented keys and nothing else', async () => {
        const server = makeServer({
            models: ['alpha/flash'],
            // Two names: the online create's id, then the OFFLINE prompt-save create's id.
            // The seam that mints both is `createdIds`, so the tracked-cache assertion below
            // can name each namespace's entry instead of a uuid.
            createdIds: ['conv-6'],
            offlineIds: ['conv-local-prompt'],
            completions: [() => sseResponse([sseDelta('Answer'), SSE_DONE])]
        });
        const instance = composed();

        // model + tracked ids + the completed turn's record.
        instance.execute<string, void>(CHAT_DRAFT_SET_COMMAND, 'Hello assistant');
        await send(instance);
        const conversationId = readCell<string | null>(instance, CHAT_ACTIVE_SESSION_STATE);
        expect(conversationId).toBe('conv-6');

        // settings + the OFFLINE namespace, exercised through a local (provider-free)
        // write so no extra route is needed for the offline relay.
        //
        // The two registries are created AFTER the switch on purpose: online the harness
        // agent registry is read-only from the browser and a chat session's toolbox is
        // deliberately empty, so an agent/tool create is refused with a notice and returns
        // no id (MISSING-FEATURES.md entries 7 and 8). Offline they are the browser's own
        // keyed registries, which is the persistence this scenario pins.
        instance.execute<ChatMode, void>(CHAT_MODE_SET_COMMAND, 'offline');
        const agentId = instance.execute<void, string>(CHAT_AGENT_CREATE_COMMAND);
        expect(agentId).toBe('agent-1');
        const toolId = instance.execute<void, string>(CHAT_TOOL_CREATE_COMMAND);
        expect(toolId).toBe('tool-1');
        expect(instance.service<{ list: () => unknown[] }>(CHAT_TOOL_STORE_SERVICE).list()).toContainEqual({
            id: 'tool-1',
            name: 'New tool',
            native: false,
            language: 'javascript',
            code: '// New tool implementation\n'
        });
        instance.state<string>(CHAT_SYSTEM_DRAFT_STATE).set('Be terse');
        await instance.execute<void, Promise<void>>(CHAT_SYSTEM_SAVE_COMMAND);

        expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBe('alpha/flash');

        // R13's accepted new key: the OFFLINE namespace holds the prompt record. Its
        // id comes from the local allocator (crypto.randomUUID when the environment
        // has one), so the entry is addressed by its own key rather than a literal.
        const local = JSON.parse(String(window.localStorage.getItem(OFFLINE_STORAGE_KEY))) as Record<
            string,
            { conversationId: string; model: string; messages: StoredMessage[]; status: string }
        >;
        const localIds = Object.keys(local);
        expect(localIds).toHaveLength(1);
        expect(local[localIds[0]]).toMatchObject({
            conversationId: localIds[0],
            model: 'alpha/flash',
            status: 'complete',
            messages: [{ role: 'system', content: 'Be terse' }]
        });

        // The tracked cache holds the ONLINE id and, by documented design, the local
        // one too: services/conversations.ts:23-32 keeps the same cache helpers across
        // a mode switch ("a later online `list` prunes any local-only id the server has
        // never seen"), which is what makes the interface total. The pre-rebuild
        // component tracked online creates only (monolith :2485-2502); the difference
        // self-heals on the next online read and is pinned by the facade's own suite
        // (services/conversations.test.ts:270-288).
        expect(readTrackedIds()).toEqual(['conv-6', localIds[0]]);
        expect(window.localStorage.getItem(TRACKED_STORAGE_KEY)).toBe(
            JSON.stringify(['conv-6', localIds[0]])
        );
        expect(JSON.parse(String(window.localStorage.getItem(SETTINGS_STORAGE_KEY)))).toEqual({
            mode: 'offline',
            providerBase: ''
        });
        expect(JSON.parse(String(window.localStorage.getItem(AGENTS_STORAGE_KEY)))).toEqual([
            { id: 'agent-1', name: 'New agent', systemPrompt: '', messages: [], tools: [] }
        ]);
        expect(JSON.parse(String(window.localStorage.getItem(TOOLS_STORAGE_KEY)))).toEqual([
            {
                id: 'tool-1',
                name: 'New tool',
                native: false,
                language: 'javascript',
                code: '// New tool implementation\n'
            }
        ]);
        // Nothing else lives under the app's prefix.
        expect(
            Object.keys(window.localStorage)
                .filter((key) => key.startsWith('chat-assistant:'))
                .sort()
        ).toEqual([
            AGENTS_STORAGE_KEY,
            MODEL_STORAGE_KEY,
            OFFLINE_STORAGE_KEY,
            SETTINGS_STORAGE_KEY,
            TOOLS_STORAGE_KEY,
            TRACKED_STORAGE_KEY
        ].sort());
        expect(readCell<ChatMode>(instance, CHAT_MODE_STATE)).toBe('offline');
    });
});
