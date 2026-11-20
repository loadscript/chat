// Chat SOURCE plugin tests: services, the streaming send pipeline, the epoch
// guard (R7) and the R14 poller.
//
// The send assertions are the heart of T3: they pin the payload the transport
// receives, the namespace every write lands in, and the exact cell/event sequence
// a user sees. `fetch` is the harness double (./harness.ts), so the ONLINE half runs
// the real task submit, the real `harness.v1` frame reader in api/harness-stream.ts
// and the real canonical re-read; the OFFLINE half runs the real SSE reader loop,
// usage frame and abort path in api/provider.ts. Only the network itself is faked,
// and each case says which namespace it exercises.
//
// TWO THINGS THE NEW WIRE CHANGES FOR THE ONLINE CASES, BOTH STATED WHERE THEY APPLY:
//   - a turn's answer arrives as `display.ops` deltas and a terminal `turn.upsert`,
//     so the answer text is what the double's transcript table holds afterwards, not
//     what the provider response body carried;
//   - the canonical record has no per-message model attribution (a harness transcript
//     message is `{role, content}`), so the online transcript assertions spell that.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dashboard } from '@underload/dashboard';
import {
    CHAT_ACTIVE_SESSION_STATE,
    CHAT_CELLS_SERVICE,
    CHAT_CONVERSATIONS_SERVICE,
    CHAT_DRAFT_STATE,
    CHAT_ERROR_EVENT,
    CHAT_ERROR_STATE,
    CHAT_MESSAGE_CANCEL_COMMAND,
    CHAT_MESSAGE_SEND_COMMAND,
    CHAT_MODE_STATE,
    CHAT_MODELS_STATE,
    CHAT_MODEL_STATE,
    CHAT_PENDING_STATE,
    CHAT_PROVIDER_BASE_STATE,
    CHAT_PROVIDER_SERVICE,
    CHAT_SESSION_CREATED_EVENT,
    CHAT_SESSION_SELECT_COMMAND,
    CHAT_SESSIONS_STATE,
    CHAT_STATUS_STATE,
    CHAT_STREAMING_STATE,
    CHAT_STREAM_CANCELLED_EVENT,
    CHAT_STREAM_COMPLETED_EVENT,
    CHAT_STREAM_DELTA_EVENT,
    CHAT_STREAM_STARTED_EVENT,
    CHAT_SYSTEM_DRAFT_STATE,
    CHAT_TRANSCRIPT_STATE,
    CHAT_TRANSCRIPT_UPDATED_EVENT,
    CHAT_USAGE_STATE,
    type ChatCells,
    type ChatMode,
    type ChatPendingTurn,
    type ChatSession,
    type NoticeEvent
} from '../contract';
import type { ConversationStore } from '../services/conversations';
import type { ProviderClient } from '../services/provider';
import {
    getLocalConversation,
    LOCAL_CONVERSATIONS_KEY,
    readLocalConversations,
    upsertLocalConversation
} from '../../api/offline';
import {
    jsonResponse,
    installFetch,
    payloadsOf,
    recordEvents,
    readTrackedIds,
    readRememberedModel,
    resetStorage,
    createTestChat,
    seedModel,
    seedSettings,
    seedTrackedIds,
    sseDelta,
    sseUsage,
    sseResponse,
    SSE_DONE,
    TEST_BASE_URL,
    TEST_HARNESS_ROOT,
    TEST_OFFLINE_BASE,
    TEST_PROVIDER_URL,
    installHarness,
    recordFixture,
    summaryFixture,
    type FetchCall,
    type FetchDouble
} from './harness';

/**
 * The mutating requests the client made, harness URLs only.
 *
 * Model discovery is `POST /v1/harness/models` on the new wire (it takes a settings
 * body), so it is a background read, not a mutation of a conversation: the cases that
 * assert "the send wrote exactly these things" filter it out and say so.
 */
const harnessMutations = (double: FetchDouble): Array<[string, string]> =>
    double
        .calls()
        .filter((call) => call.method !== 'GET' && call.url !== `${TEST_HARNESS_ROOT}/models`)
        .map((call) => [call.method, call.url.split('?')[0]] as [string, string]);

/** The body of the one request that matches, spelled exactly. */
const bodyOfCall = (
    double: FetchDouble,
    method: string,
    path: string
): { body: unknown }[] =>
    double.calls().filter((call) => call.method === method && call.url.split('?')[0] === path);

const PROVIDER_MODELS = `${TEST_PROVIDER_URL}/models`;
const PROVIDER_COMPLETIONS = `${TEST_PROVIDER_URL}/chat/completions`;
const OFFLINE_MODELS = `${TEST_OFFLINE_BASE}/models`;

/** The catalog every case answers: three ids, deliberately unsorted by prefix. */
const catalogRoute = (url = PROVIDER_MODELS) => ({
    match: (candidate: string) => candidate === url,
    reply: () =>
        jsonResponse(200, {
            object: 'list',
            data: [{ id: 'zeta/turbo' }, { id: 'alpha/flash' }, { id: 'prefixless' }]
        })
});

/** A streamed completion answering with the given content deltas. */
const completionRoute = (deltas: readonly string[], usage?: Record<string, number>) => ({
    match: (url: string) => url === PROVIDER_COMPLETIONS,
    reply: () => {
        const frames = deltas.map(sseDelta);
        if (usage) frames.push(sseUsage(usage));
        frames.push(SSE_DONE);
        return sseResponse(frames);
    }
});

/**
 * A streamed completion that waits between frames AND honours the caller's abort
 * signal, the way undici does: the test can therefore observe a delta, cancel (or
 * switch the mode) BETWEEN frames, and the partial text that reached the surface is
 * exactly what the abort path reports.
 */
const pacedCompletionRoute = (
    deltas: readonly string[],
    usage?: Record<string, number>
) => ({
    match: (url: string) => url === PROVIDER_COMPLETIONS,
    reply: (_url: string, init?: RequestInit) => {
        const frames = deltas.map(sseDelta);
        if (usage) frames.push(sseUsage(usage));
        frames.push(SSE_DONE);
        return pacedStream(frames, init?.signal ?? null);
    }
});

const emptyListRoute = {
    match: (url: string) => url.startsWith(TEST_BASE_URL),
    reply: () => jsonResponse(200, { conversations: [] })
};

const callsOf = (double: FetchDouble) =>
    double.calls().map((call: FetchCall) => [call.method, call.url]);

describe('chat source — the published services', () => {
    let instance: Dashboard | null = null;

    beforeEach(() => resetStorage());

    afterEach(() => {
        instance?.dispose();
        instance = null;
        vi.unstubAllGlobals();
    });

    it('registers chat.conversations and chat.provider', () => {
        installFetch([catalogRoute(), emptyListRoute]);
        instance = createTestChat();
        const conversations = instance.service<ConversationStore>(CHAT_CONVERSATIONS_SERVICE);
        const provider = instance.service<ProviderClient>(CHAT_PROVIDER_SERVICE);
        expect(typeof conversations.list).toBe('function');
        expect(typeof provider.stream).toBe('function');
        expect(conversations.mode).toBe('online');
    });

    it('routes the conversations facade by the LIVE cells, not by setup values', async () => {
        // THE reason the facade resolves per call: services are frozen at setup, so
        // a captured store would keep writing into the namespace that happened to be
        // active when the dashboard was built.
        // The harness listing is `GET /v1/harness/sessions`; the offline namespace is
        // the browser's own map, which issues nothing.
        const double = installHarness({ records: [], models: ['alpha/flash'] });
        instance = createTestChat();
        const conversations = instance.service<ConversationStore>(CHAT_CONVERSATIONS_SERVICE);
        // Let the mount listing land first, so the call counts below are this
        // test's own requests only.
        await vi.waitFor(() => {
            expect(double.callsFor(`${TEST_HARNESS_ROOT}/sessions`).length).toBeGreaterThan(0);
        });
        double.reset();

        await conversations.list(['anything']);
        expect(double.callsFor(`${TEST_HARNESS_ROOT}/sessions`)).toHaveLength(1);

        instance.state<ChatMode>(CHAT_MODE_STATE).set('offline');
        // The switch re-runs the mount listing for the new namespace, so the settle
        // (idle, and no online listing left in flight) is established BEFORE the log is
        // cleared; otherwise a late online read would be attributed to the offline call.
        await vi.waitFor(() => {
            expect(instance?.state<ChatMode>(CHAT_MODE_STATE).get()).toBe('offline');
            expect(instance?.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
        });
        expect(conversations.mode).toBe('offline');
        double.reset();

        // OFFLINE storage is browser-local: the endpoint sees no request at all.
        await conversations.list(['anything']);
        expect(double.calls()).toEqual([]);
    });

    it('loads the catalog sorted by STRIPPED model name and adopts the remembered model', async () => {
        seedModel('zeta/turbo');
        // The catalog is the harness discovery POST; the double answers with the same
        // three unsorted ids the provider-shaped route used to hand back.
        installHarness({ records: [], models: ['zeta/turbo', 'alpha/flash', 'prefixless'] });
        instance = createTestChat();
        await vi.waitFor(() => {
            expect(instance?.state<readonly string[]>(CHAT_MODELS_STATE).get()).toEqual([
                'alpha/flash',
                'prefixless',
                'zeta/turbo'
            ]);
        });
        // Priority: remembered last-used model, else the first sorted entry — and
        // the catalog DEFAULT is never persisted, only an explicit pick or a model
        // that produced a turn.
        expect(instance.state<string>(CHAT_MODEL_STATE).get()).toBe('zeta/turbo');
        expect(readRememberedModel()).toBe('zeta/turbo');
    });

    it('adopts the first sorted entry when nothing is remembered, without persisting it', async () => {
        installHarness({ records: [], models: ['zeta/turbo', 'alpha/flash', 'prefixless'] });
        instance = createTestChat();
        await vi.waitFor(() => {
            expect(instance?.state<string>(CHAT_MODEL_STATE).get()).toBe('alpha/flash');
        });
        expect(readRememberedModel()).toBeNull();
    });

    it('persists chat-assistant:model on every model change', async () => {
        installFetch([catalogRoute(), emptyListRoute]);
        instance = createTestChat();
        instance.state<string>(CHAT_MODEL_STATE).set('prefixless');
        await vi.waitFor(() => {
            expect(readRememberedModel()).toBe('prefixless');
        });
    });

    it('issues NO offline catalog request while the base is blank', async () => {
        seedSettings('offline', '');
        seedModel('alpha/flash');
        const double = installFetch([catalogRoute(), emptyListRoute]);
        instance = createTestChat();
        await vi.waitFor(() => {
            expect(instance?.state<string>(CHAT_MODEL_STATE).get()).toBe('alpha/flash');
        });
        expect(double.calls()).toEqual([]);
        expect(instance.state<readonly string[]>(CHAT_MODELS_STATE).get()).toEqual([]);
        // The remembered model still unblocks the composer: no manual-model
        // fallback was ever invented.
        expect(instance.state<string>(CHAT_ERROR_STATE).get()).toBe('');
    });

    it('re-reads the catalog from the configured offline base', async () => {
        seedSettings('offline', TEST_OFFLINE_BASE);
        const double = installFetch([catalogRoute(OFFLINE_MODELS), emptyListRoute]);
        instance = createTestChat();
        await vi.waitFor(() => {
            expect(instance?.state<readonly string[]>(CHAT_MODELS_STATE).get()).toHaveLength(3);
        });
        expect(double.callsFor(OFFLINE_MODELS)).toHaveLength(1);
        expect(double.callsFor(PROVIDER_MODELS)).toEqual([]);

        // A settings edit re-runs the catalog for the new configuration (:2790-2794).
        instance.state<string>(CHAT_PROVIDER_BASE_STATE).set(TEST_PROVIDER_URL);
        await vi.waitFor(() => {
            expect(double.callsFor(PROVIDER_MODELS)).toHaveLength(1);
        });
    });

    it('reports a catalog answer that is not the harness contract shape', async () => {
        // THE reported symptom, pinned at the seam. A 200 whose body is not the
        // contract's `{models: [...]}` — here, the provider envelope a stale deployed
        // server answers with — used to resolve to an EMPTY catalogue
        // (`Array.isArray(body.models) ? body.models : []`), so the picker kept only
        // the remembered model and nothing explained it. The client now throws
        // (packages/underload/harness/src/frontend/api.ts `listProviderModels`) and the
        // catalog catch reports it (./source.ts:878-887).
        seedModel('alpha/flash');
        const double = installHarness({
            records: [],
            passthrough: [
                {
                    match: (url: string, method?: string) =>
                        method === 'POST' && url.split('?')[0] === `${TEST_HARNESS_ROOT}/models`,
                    reply: () =>
                        jsonResponse(200, {
                            object: 'list',
                            data: [{ id: 'alpha/flash' }, { id: 'zeta/turbo' }]
                        })
                }
            ]
        });
        instance = createTestChat();

        await vi.waitFor(() => {
            expect(instance?.state<string>(CHAT_ERROR_STATE).get()).toBe(
                "The harness server returned an unexpected response for /models (expected the contract's {models: string[]} object, received an object with fields object, data)."
            );
        });
        // The catalogue cell stays empty — that is the one-option picker — while the
        // remembered model still unblocks the composer.
        expect(instance.state<readonly string[]>(CHAT_MODELS_STATE).get()).toEqual([]);
        expect(instance.state<string>(CHAT_MODEL_STATE).get()).toBe('alpha/flash');
        // One discovery request: a malformed answer is reported, not silently re-dialled.
        expect(double.callsFor(`${TEST_HARNESS_ROOT}/models`)).toHaveLength(1);
    });

    it('a mode flip mid-catalog never leaves the picker on the remembered model', async () => {
        // R2b: the epoch/sequence guards in `refreshModels` (./source.ts:859-861) can
        // drop a SUCCESSFUL answer, and the drop must never leave `chat.models` blank
        // with nothing in flight — that is precisely the stuck-on-preset picker
        // (components/ModelPicker.tsx:221-226). The online discovery is parked, the
        // switch re-reads through the offline base, and the late online answer is
        // dropped WITHOUT touching the cell or the banner.
        seedSettings('online', TEST_OFFLINE_BASE);
        let releaseOnlineCatalog: () => void = () => undefined;
        const parked = new Promise<void>((resolve) => {
            releaseOnlineCatalog = resolve;
        });
        let onlineCalls = 0;
        const double = installHarness({
            records: [],
            passthrough: [
                {
                    match: (url: string, method?: string) =>
                        method === 'POST' && url.split('?')[0] === `${TEST_HARNESS_ROOT}/models`,
                    reply: async () => {
                        onlineCalls += 1;
                        await parked;

                        return jsonResponse(200, { models: ['online/stale'], observed_at: 1 });
                    }
                },
                catalogRoute(OFFLINE_MODELS)
            ]
        });
        instance = createTestChat();

        // The online discovery is genuinely in flight before the switch.
        await vi.waitFor(() => {
            expect(onlineCalls).toBe(1);
        });
        instance.state<ChatMode>(CHAT_MODE_STATE).set('offline');

        await vi.waitFor(() => {
            expect(instance?.state<readonly string[]>(CHAT_MODELS_STATE).get()).toEqual([
                'alpha/flash',
                'prefixless',
                'zeta/turbo'
            ]);
        });

        // Settle the superseded online answer. It owns nothing: the newest attempt
        // already wrote the offline catalogue, so the cell must not move again. The
        // drop is not observable as a state change, so the settle is given real time
        // (the same hand-settled timing the busy-label case in ./sessions.test.ts
        // uses) before the invariance is asserted.
        releaseOnlineCatalog();
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 30);
        });
        expect(double.callsFor(`${TEST_HARNESS_ROOT}/models`)).toHaveLength(1);
        expect(instance.state<readonly string[]>(CHAT_MODELS_STATE).get()).toEqual([
            'alpha/flash',
            'prefixless',
            'zeta/turbo'
        ]);
        expect(instance.state<string>(CHAT_ERROR_STATE).get()).toBe('');
        // And the picker is not stuck on a remembered id: the adopted model came from
        // the catalogue that actually landed.
        expect(instance.state<string>(CHAT_MODEL_STATE).get()).toBe('alpha/flash');
    });
});

describe('chat source — the send pipeline', () => {
    let instance: Dashboard | null = null;
    let double: FetchDouble | null = null;

    beforeEach(() => {
        resetStorage();
    });

    afterEach(() => {
        instance?.dispose();
        instance = null;
        double = null;
        vi.unstubAllGlobals();
    });

    /** The online new-chat backend: pending create, canonical reads, append. */
    const newChatRoutes = (deltas: readonly string[], usage?: Record<string, number>) => {
        const created = recordFixture('conv-1', {
            title: 'New conversation',
            messages: [],
            model: 'alpha/flash',
            status: 'pending',
            createdAt: '2026-11-07T00:00:00.000Z',
            updatedAt: '2026-11-07T00:00:00.000Z'
        });
        const settled = recordFixture('conv-1', {
            title: 'Hello there',
            model: 'alpha/flash',
            status: 'complete',
            messages: [
                { role: 'user', content: 'Hello there' },
                { role: 'assistant', content: deltas.join(''), model: 'alpha/flash' }
            ],
            createdAt: '2026-11-07T00:00:00.000Z',
            updatedAt: '2026-11-07T00:00:02.000Z',
            ...(usage ? { usage } : {})
        });
        let reads = 0;
        return [
            catalogRoute(),
            completionRoute(deltas, usage),
            {
                match: (url: string) => url === TEST_BASE_URL,
                reply: () => jsonResponse(201, { conversationId: 'conv-1' })
            },
            {
                match: (url: string) => url === `${TEST_BASE_URL}/conv-1`,
                reply: (url: string, init?: RequestInit) =>
                    (init?.method ?? 'GET') === 'POST'
                        ? jsonResponse(201, { conversationId: 'conv-1' })
                        : jsonResponse(200, {
                            conversationId: 'conv-1',
                            conversation: reads++ === 0 ? created : settled
                        })
            },
            {
                match: (url: string) => url.startsWith(TEST_BASE_URL),
                reply: () => jsonResponse(200, { conversations: [] })
            }
        ];
    };

    it('streams a new chat: pending row, deltas, usage, persistence, exact requests', async () => {
        // THE ONLINE CONTRACT, end to end: `POST /v1/harness/sessions` (create + track),
        // `POST /sessions/{id}/tasks` (the turn), the `harness.v1` stream (deltas on the
        // turn scope, the terminal `turn.upsert` on the session scope), then the canonical
        // multi-read that settles the surface.
        double = installHarness({
            records: [],
            createdIds: ['conv-1'],
            models: ['alpha/flash'],
            reply: 'Hello there',
            usage: { input: 11, output: 7, total: 18 }
        });
        instance = createTestChat({ pollIntervalMs: 5_000 });
        const cells = instance.service<ChatCells>(CHAT_CELLS_SERVICE);
        await vi.waitFor(() => {
            expect(cells.model.get()).toBe('alpha/flash');
        });
        double.reset();
        const events = recordEvents(instance, [
            CHAT_STREAM_STARTED_EVENT,
            CHAT_STREAM_DELTA_EVENT,
            CHAT_STREAM_COMPLETED_EVENT,
            CHAT_TRANSCRIPT_UPDATED_EVENT,
            CHAT_SESSION_CREATED_EVENT
        ]);

        cells.draft.set('Hello there');
        const send = instance.execute<void, Promise<void>>(CHAT_MESSAGE_SEND_COMMAND);

        // The pending bubble appears BEFORE the stream produces anything, and the
        // composer clears — the in-flight turn renders live, before persistence.
        await vi.waitFor(() => {
            expect(cells.pending.get()).not.toBeNull();
        });
        const pending = cells.pending.get() as ChatPendingTurn;
        expect(pending.text).toBe('Hello there');
        expect(typeof pending.at).toBe('number');
        expect(cells.draft.get()).toBe('');
        expect(cells.status.get()).toBe('sending');
        expect(cells.streaming.get()).toBe('');

        await send;

        // The whole exchange, exactly as the harness transcript table answered it. The
        // assistant row carries no model attribution: a harness transcript message is
        // `{role, content}` (src/api/harness.ts:217-220), so the label falls back to the
        // role and the SESSION's model is what the sidebar row reports.
        expect(cells.transcript.get()).toEqual([
            { role: 'user', content: 'Hello there' },
            { role: 'assistant', content: 'Hello there' }
        ]);
        // The token figures ride the terminal `turn.upsert` / `usage.updated` frames and
        // are projected back into the cell's OpenAI spelling (src/api/harness.ts
        // `usageFromHarness`).
        expect(cells.usage.get()).toEqual({
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18
        });
        expect(cells.pending.get()).toBeNull();
        expect(cells.streaming.get()).toBe('');
        expect(cells.status.get()).toBe('idle');
        expect(cells.error.get()).toBe('');
        expect(cells.activeSessionId.get()).toBe('conv-1');
        // The row the create inserted is settled by the same conversation, in place (the
        // sidebar order never jitters), and the CLIENT derives the title the old server
        // used to derive (src/dashboard/services/conversations.ts `append`).
        expect(cells.sessions.get()).toEqual([
            {
                conversationId: 'conv-1',
                title: 'Hello there',
                model: 'alpha/flash',
                status: 'complete',
                messageCount: 2,
                createdAt: CREATED_ISO,
                updatedAt: CREATED_ISO_PLUS_1S
            }
        ]);

        // The ONLINE new-chat contract: the session is created (and tracked) before
        // generation, the selected model is pinned to the ENTRY agent of the brand-new
        // session (`PATCH {agent_models}` — the create's `settings.model` is the preset
        // default's, src/api/harness.ts:448-456), then the turn is submitted.
        expect(harnessMutations(double!)).toEqual([
            ['POST', '/v1/harness/sessions'],
            ['PATCH', '/v1/harness/sessions/conv-1'],
            ['POST', '/v1/harness/sessions/conv-1/tasks']
        ]);
        expect(bodyOfCall(double!, 'PATCH', '/v1/harness/sessions/conv-1')[0].body).toEqual({
            agent_models: { instruct: 'alpha/flash' }
        });
        // The create names the PRESET and the selected provider model (`settings.model`,
        // src/api/harness.ts:406-420). No title is sent: a new-chat send has no messages
        // in its create payload, and the harness derives no title of its own — which is
        // exactly the gap MISSING-FEATURES.md entry 18 records. The model is then pinned
        // to the entry agent by the `agent_models` PATCH above, because a session
        // created against a preset resolves its model server-side first (entry 15).
        expect(bodyOfCall(double!, 'POST', '/v1/harness/sessions')[0].body).toEqual({
            harness: 'chat',
            settings: { model: 'alpha/flash' }
        });
        // The prompt the harness receives is the draft the composer held — not the whole
        // history, which the SERVER owns online (src/api/harness.ts `submitHarnessTask`).
        expect(bodyOfCall(double!, 'POST', '/v1/harness/sessions/conv-1/tasks')[0].body).toEqual({
            input: 'Hello there'
        });
        // Every read the send makes, in the order the transport walks it: the FROZEN
        // DEFINITION (to name the ENTRY agent the model PATCH addresses — the roster
        // states `rank`, which is authority and is shared by any number of members, so
        // it cannot answer which member the session routes to), the thread
        // resolution the submit reuses, the committed turn DISPLAY (the online answer
        // text is read from the display document, api/harness.ts `readHarnessTurnText`),
        // then the canonical record read — session, thread roster, transcript document,
        // usage fold. The tools plugin's own refresh is a concurrent read of a different
        // resource, so it is filtered out by position (its position in the log depends on
        // the microtask queue) and asserted by count instead.
        const readLegs = double!.calls()
            .filter(
                (call) =>
                    call.method === 'GET' &&
                    // the tools plugin's own refresh, which rides the same tick and is
                    // asserted by count below (`?limit=100` is part of the url, hence the
                    // split rather than an `endsWith` on the whole url)
                    call.url.split('?')[0] !== '/v1/harness/tools'
            )
            .map((call) => [call.method, call.url] as [string, string]);

        expect(readLegs).toEqual([
            ['GET', '/v1/harness/sessions/conv-1/definition'],
            ['GET', '/v1/harness/sessions/conv-1/threads?limit=100'],
            ['GET', '/v1/harness/sessions/conv-1/turns/turn-1/display'],
            ['GET', '/v1/harness/sessions/conv-1'],
            ['GET', '/v1/harness/sessions/conv-1/threads?limit=100'],
            ['GET', '/v1/harness/sessions/conv-1/threads/thread-1/transcript/messages?limit=100'],
            ['GET', '/v1/harness/sessions/conv-1/usage']
        ]);
        expect(double!.callsFor('/v1/harness/tools')).toHaveLength(1);
        expect(readTrackedIds()).toEqual(['conv-1']);
        // A completed turn makes its model the remembered one.
        expect(readRememberedModel()).toBe('alpha/flash');

        // Events: one started, one per accumulated delta, one completed, one
        // transcript update — each with the exact payload.
        expect(payloadsOf(events, CHAT_STREAM_STARTED_EVENT)).toEqual([
            { sessionId: 'conv-1', requestId: 'request-1' }
        ]);
        // The deltas are ACCUMULATED text, chunked where the stream cuts them: the double
        // splits the committed answer in half (plugins/harness.ts `deliverTurn`), so the
        // first frame carries 'Hello ' — trailing space and all — and the second the
        // whole answer.
        expect(payloadsOf(events, CHAT_STREAM_DELTA_EVENT)).toEqual([
            { sessionId: 'conv-1', requestId: 'request-1', text: 'Hello ' },
            { sessionId: 'conv-1', requestId: 'request-1', text: 'Hello there' }
        ]);
        expect(payloadsOf(events, CHAT_STREAM_COMPLETED_EVENT)).toEqual([
            { sessionId: 'conv-1', requestId: 'request-1', text: 'Hello there' }
        ]);
        expect(payloadsOf(events, CHAT_TRANSCRIPT_UPDATED_EVENT)).toEqual([
            { sessionId: 'conv-1', turnCount: 2 }
        ]);
    });

    /** The fixed clock the harness double stamps a new session with. */
    const CREATED_ISO = new Date(Date.parse('2026-11-07T00:00:00.000Z')).toISOString();
    const CREATED_ISO_PLUS_1S = new Date(Date.parse('2026-11-07T00:00:01.000Z')).toISOString();

    function settledFixture() {
        return recordFixture('conv-1', {
            title: 'Hello there',
            model: 'alpha/flash',
            status: 'complete',
            messages: [
                { role: 'user', content: 'Hello there' },
                { role: 'assistant', content: 'Hello there', model: 'alpha/flash' }
            ],
            createdAt: '2026-11-07T00:00:00.000Z',
            updatedAt: '2026-11-07T00:00:02.000Z',
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
        });
    }

    it('refuses a blank draft or a missing model without touching the network', async () => {
        // OFFLINE namespace: the provider transport is the one a rejected draft would
        // otherwise reach, so the case runs where a request would actually be issued.
        seedSettings('offline', TEST_PROVIDER_URL);
        double = installFetch([catalogRoute(), emptyListRoute]);
        instance = createTestChat({ pollIntervalMs: 5_000 });
        const cells = instance.service<ChatCells>(CHAT_CELLS_SERVICE);
        await vi.waitFor(() => {
            expect(cells.model.get()).toBe('alpha/flash');
        });
        double.reset();

        cells.draft.set('   ');
        await instance.execute<void, Promise<void>>(CHAT_MESSAGE_SEND_COMMAND);
        expect(cells.pending.get()).toBeNull();
        expect(cells.status.get()).toBe('idle');
        expect(double.calls()).toEqual([]);

        // A model-less surface is just as blocked, and the draft survives both tries.
        cells.draft.set('Hello');
        cells.model.set('');
        await instance.execute<void, Promise<void>>(CHAT_MESSAGE_SEND_COMMAND);
        expect(double.calls()).toEqual([]);
        expect(cells.draft.get()).toBe('Hello');
    });

    it('rolls the pending record back and restores the draft when the provider fails', async () => {
        // A provider FAILURE is the offline transport's shape (the harness refuses a turn
        // with a 4xx on the task POST, covered by the cancel case below), so this case
        // pins the rollback where the failure actually happens.
        seedSettings('offline', TEST_PROVIDER_URL);
        installFetch([
            catalogRoute(),
            {
                match: (url: string) => url === PROVIDER_COMPLETIONS,
                reply: () => jsonResponse(500, { error: "Model 'alpha/flash' not found" })
            },
            {
                match: (url: string) => url === TEST_BASE_URL,
                reply: () => jsonResponse(201, { conversationId: 'conv-1' })
            },
            {
                match: (url: string) => url === `${TEST_BASE_URL}/conv-1`,
                reply: (url: string, init?: RequestInit) =>
                    (init?.method ?? 'GET') === 'DELETE'
                        ? jsonResponse(200, { conversationId: 'conv-1' })
                        : jsonResponse(200, {
                            conversationId: 'conv-1',
                            conversation: recordFixture('conv-1', {
                                title: 'New conversation',
                                messages: [],
                                model: 'alpha/flash',
                                status: 'pending'
                            })
                        })
            },
            emptyListRoute
        ]);
        instance = createTestChat({ pollIntervalMs: 5_000 });
        const cells = instance.service<ChatCells>(CHAT_CELLS_SERVICE);
        await vi.waitFor(() => {
            expect(cells.model.get()).toBe('alpha/flash');
        });
        const events = recordEvents(instance, [CHAT_ERROR_EVENT]);

        cells.draft.set('Hello there');
        await instance.execute<void, Promise<void>>(CHAT_MESSAGE_SEND_COMMAND);

        // A generation that never produced a reply saves nothing: the record is
        // deleted, the row disappears, the tracked cache is clean, the draft is back
        // for a retry, and the banner carries the provider's own message.
        expect(cells.error.get()).toBe("Model 'alpha/flash' not found");
        expect(payloadsOf(events, CHAT_ERROR_EVENT)).toEqual([
            { message: "Model 'alpha/flash' not found" } satisfies NoticeEvent
        ]);
        expect(cells.draft.get()).toBe('Hello there');
        expect(cells.pending.get()).toBeNull();
        expect(cells.streaming.get()).toBe('');
        expect(cells.status.get()).toBe('idle');
        expect(cells.sessions.get()).toEqual([]);
        expect(cells.transcript.get()).toEqual([]);
        expect(readTrackedIds()).toEqual([]);
    });

    it('cancels mid-stream: nothing is persisted, the draft comes back', async () => {
        // The PACED SSE stream is what makes "cancel between two deltas" observable, and
        // pacing is a property of the offline provider connection (the online run is
        // cancelled through POST /sessions/{id}/cancel, pinned in server/main.test.ts).
        seedSettings('offline', TEST_PROVIDER_URL);
        // The stream is paced so a cancel can land between two deltas: the reader
        // loop awaits each chunk, and the abort rejects the in-flight read.
        installFetch([
            catalogRoute(),
            pacedCompletionRoute(['One', 'Two']),
            {
                match: (url: string) => url === TEST_BASE_URL,
                reply: () => jsonResponse(201, { conversationId: 'conv-1' })
            },
            {
                match: (url: string) => url === `${TEST_BASE_URL}/conv-1`,
                reply: (url: string, init?: RequestInit) =>
                    (init?.method ?? 'GET') === 'DELETE'
                        ? jsonResponse(200, { conversationId: 'conv-1' })
                        : jsonResponse(200, {
                            conversationId: 'conv-1',
                            conversation: recordFixture('conv-1', {
                                title: 'New conversation',
                                messages: [],
                                model: 'alpha/flash',
                                status: 'pending'
                            })
                        })
            },
            emptyListRoute
        ]);
        instance = createTestChat({ pollIntervalMs: 5_000 });
        const cells = instance.service<ChatCells>(CHAT_CELLS_SERVICE);
        await vi.waitFor(() => {
            expect(cells.model.get()).toBe('alpha/flash');
        });
        const events = recordEvents(instance, [
            CHAT_STREAM_CANCELLED_EVENT,
            CHAT_STREAM_COMPLETED_EVENT
        ]);

        cells.draft.set('Hello there');
        const send = instance.execute<void, Promise<void>>(CHAT_MESSAGE_SEND_COMMAND);
        await vi.waitFor(() => {
            expect(cells.streaming.get()).toBe('One');
        }, { interval: 1, timeout: 5_000 });

        expect(instance.execute<void, boolean>(CHAT_MESSAGE_CANCEL_COMMAND)).toBe(true);
        // Nothing in flight any more: a second stop is an honest false, not a throw.
        expect(instance.execute<void, boolean>(CHAT_MESSAGE_CANCEL_COMMAND)).toBe(false);

        await send;

        // `sessionId: ''` is the OFFLINE new-chat rule, not a defect: the browser has no
        // id for the turn until the completed pair is persisted, so the stream events
        // carry the request id only (src/dashboard/plugins/source.ts:541-544, and the
        // online flagship case above shows a real id because the session POST answers one).
        expect(payloadsOf(events, CHAT_STREAM_CANCELLED_EVENT)).toEqual([
            { sessionId: '', requestId: 'request-1', text: 'One' }
        ]);
        expect(payloadsOf(events, CHAT_STREAM_COMPLETED_EVENT)).toEqual([]);
        // The partial reply is DISCARDED (nothing is persisted), the draft returns.
        expect(cells.draft.get()).toBe('Hello there');
        expect(cells.transcript.get()).toEqual([]);
        expect(cells.pending.get()).toBeNull();
        expect(cells.streaming.get()).toBe('');
        expect(cells.status.get()).toBe('idle');
        expect(cells.sessions.get()).toEqual([]);
        expect(readTrackedIds()).toEqual([]);
    });

    it('attaches the system-prompt draft as the leading block and rewrites by PUT', async () => {
        const existing = recordFixture('conv-9', {
            title: 'Existing',
            model: 'alpha/flash',
            messages: [{ role: 'user', content: 'Earlier question' }],
            createdAt: '2026-11-07T00:00:00.000Z',
            updatedAt: '2026-11-07T00:00:01.000Z'
        });
        const rewritten = recordFixture('conv-9', {
            title: 'Existing',
            model: 'alpha/flash',
            messages: [
                { role: 'system', content: 'Answer briefly' },
                { role: 'user', content: 'Earlier question' },
                { role: 'user', content: 'Hello there' },
                { role: 'assistant', content: 'Hello there', model: 'alpha/flash' }
            ],
            createdAt: '2026-11-07T00:00:00.000Z',
            updatedAt: '2026-11-07T00:00:03.000Z',
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
        });
        seedTrackedIds(['conv-9']);
        // OFFLINE: the leading system block is a TRANSCRIPT entry there, and a first
        // leading block can only arrive through a whole-history replace (a POST append
        // attaches at the END), which is what the local store is checked against below.
        seedSettings('offline', TEST_PROVIDER_URL);
        upsertLocalConversation(existing);
        double = installFetch([
            catalogRoute(),
            completionRoute(['Hello', ' there'], {
                prompt_tokens: 3,
                completion_tokens: 4,
                total_tokens: 7
            }),
            {
                match: (url: string) => url === `${TEST_BASE_URL}/conv-9`,
                reply: (url: string, init?: RequestInit) =>
                    (init?.method ?? 'GET') === 'PUT'
                        ? jsonResponse(200, { conversationId: 'conv-9', conversation: rewritten })
                        : jsonResponse(200, { conversationId: 'conv-9', conversation: existing })
            },
            {
                match: (url: string) => url.startsWith(TEST_BASE_URL),
                reply: () => jsonResponse(200, { conversations: [summaryFixture(existing)] })
            }
        ]);
        instance = createTestChat({ pollIntervalMs: 5_000 });
        const cells = instance.service<ChatCells>(CHAT_CELLS_SERVICE);
        await vi.waitFor(() => {
            expect(cells.model.get()).toBe('alpha/flash');
        });
        await instance.execute<string, Promise<void>>('chat.session.select', 'conv-9');
        double.reset();

        cells.systemDraft.set('Answer briefly');
        cells.draft.set('Hello there');
        await instance.execute<void, Promise<void>>(CHAT_MESSAGE_SEND_COMMAND);

        // OFFLINE replace: the evidence is the persisted map (the local store issues no
        // request), which is what the block below now reads.
        const persistedAfterSend = await getLocalConversation('conv-9');

        expect(persistedAfterSend.conversation.messages).toEqual([
            { role: 'system', content: 'Answer briefly' },
            { role: 'user', content: 'Earlier question' },
            { role: 'user', content: 'Hello there' },
            { role: 'assistant', content: 'Hello there', model: 'alpha/flash' }
        ]);
        // An existing chat gaining its FIRST leading block cannot append it (a POST
        // attaches at the END), so the whole history is replaced through the
        // identified replace with the block at index 0 (:4032-4042). Offline that replace
        // is the browser's own map, so the only request on the wire is the completion.
        expect(double!.calls().map((call) => [call.method, call.url.split('?')[0]])).toEqual([
            ['POST', PROVIDER_COMPLETIONS]
        ]);
        expect(double!.callsFor(PROVIDER_COMPLETIONS)[0].body).toEqual({
            model: 'alpha/flash',
            stream: true,
            stream_options: { include_usage: true },
            messages: [
                { role: 'system', content: 'Answer briefly' },
                { role: 'user', content: 'Earlier question' },
                { role: 'user', content: 'Hello there' }
            ]
        });
        expect(cells.transcript.get()).toEqual(rewritten.messages);
        expect(cells.usage.get()).toEqual({
            prompt_tokens: 3,
            completion_tokens: 4,
            total_tokens: 7
        });
        // The draft prompt is now persisted, so it and its editor clear.
        expect(cells.systemDraft.get()).toBe('');
        expect(cells.activeSessionId.get()).toBe('conv-9');
    });

    it('rejects an offline send with a blank provider base and sends nothing', async () => {
        seedSettings('offline', '');
        seedModel('alpha/flash');
        const double = installFetch([emptyListRoute]);
        instance = createTestChat({ pollIntervalMs: 5_000 });
        const cells = instance.service<ChatCells>(CHAT_CELLS_SERVICE);
        // The mount listing is a real flow, so the busy tracker legitimately shows
        // 'loading' until it lands; settle it before judging what the SEND left
        // behind.
        await vi.waitFor(() => {
            expect(cells.status.get()).toBe('idle');
        });

        cells.draft.set('Hello there');
        await instance.execute<void, Promise<void>>(CHAT_MESSAGE_SEND_COMMAND);
        // The mount listing is still settling in the background, so the tracker may
        // legitimately show 'loading' for one tick; wait for the quiet state before
        // asserting the label the SEND left behind.
        await vi.waitFor(() => {
            expect(cells.status.get()).toBe('idle');
        });

        // No silent call to the default app server: the banner explains the
        // configuration need instead (:4003-4008).
        expect(cells.error.get()).toContain('Configure the offline provider base URL');
        expect(double.calls()).toEqual([]);
        expect(cells.draft.get()).toBe('Hello there');
        expect(cells.status.get()).toBe('idle');
    });
});

describe('chat source — the epoch guard mid-flight (R7)', () => {
    let instance: Dashboard | null = null;
    let double: FetchDouble | null = null;

    beforeEach(() => resetStorage());

    afterEach(() => {
        instance?.dispose();
        instance = null;
        double = null;
        vi.unstubAllGlobals();
    });

    it('an offline->online switch mid-stream never touches the new namespace', async () => {
        // THE regression, on the transport that can be paced: the sending namespace keeps
        // running and keeps being written, and every surface cell belongs to the OTHER
        // namespace now. The direction is flipped from the pre-rebuild case because only
        // the offline provider connection can be observed BETWEEN two deltas — a harness
        // run is settled by one burst of `display.ops` + `turn.upsert` frames (the online
        // cancel path is `POST /sessions/{id}/cancel`, pinned against the real listener in
        // @underload/chat/src/server/main.test.ts, and cross-tab completion is entry 4 of
        // ../../../../MISSING-FEATURES.md).
        seedSettings('offline', TEST_PROVIDER_URL);
        // Both namespaces get a server: the provider routes answer the OFFLINE transport,
        // and the harness double behind them answers the online listing the switch asks
        // for — so "no banner" below means the switch really resolved.
        const transport = installHarness({
            records: [],
            passthrough: [
                catalogRoute(),
                pacedCompletionRoute(['One', 'Two'], {
                    prompt_tokens: 5,
                    completion_tokens: 6,
                    total_tokens: 11
                })
            ]
        });
        double = transport;
        instance = createTestChat({ pollIntervalMs: 5_000 });
        const cells = instance.service<ChatCells>(CHAT_CELLS_SERVICE);
        await vi.waitFor(() => {
            expect(cells.model.get()).toBe('alpha/flash');
        });

        cells.draft.set('Hello there');
        const send = instance.execute<void, Promise<void>>(CHAT_MESSAGE_SEND_COMMAND);
        await vi.waitFor(() => {
            expect(cells.streaming.get()).toBe('One');
        }, { interval: 1, timeout: 5_000 });

        // Flip the namespace while the stream is between two deltas.
        instance.state<ChatMode>(CHAT_MODE_STATE).set('online');
        expect(cells.streaming.get()).toBe('');
        expect(cells.pending.get()).toBeNull();
        expect(cells.sessions.get()).toEqual([]);
        expect(cells.activeSessionId.get()).toBeNull();

        await send;

        // The ONLINE surface never saw the offline turn: no transcript, no streaming
        // buffer, no row, no banner from the other namespace.
        expect(cells.transcript.get()).toEqual([]);
        expect(cells.streaming.get()).toBe('');
        expect(cells.pending.get()).toBeNull();
        expect(cells.sessions.get()).toEqual([]);
        expect(cells.usage.get()).toBeNull();
        expect(cells.error.get()).toBe('');
        expect(cells.activeSessionId.get()).toBeNull();
        expect(cells.status.get()).toBe('idle');

        // ...while the OFFLINE namespace got the whole turn: the completed pair and its
        // usage are in the browser's own map (offline mints the id, so the map key is
        // read rather than assumed), and NOTHING was written online: the harness table is
        // still empty, and the only conversation write on the wire was the provider call.
        const offlineIds = Object.keys(readLocalConversations());

        expect(offlineIds).toHaveLength(1);
        const settledOffline = await getLocalConversation(offlineIds[0]);

        expect(settledOffline.conversation.messages).toEqual([
            { role: 'user', content: 'Hello there' },
            { role: 'assistant', content: 'OneTwo', model: 'alpha/flash' }
        ]);
        expect(settledOffline.conversation.usage).toEqual({
            prompt_tokens: 5,
            completion_tokens: 6,
            total_tokens: 11
        });
        expect(transport.sessions()).toEqual([]);
        // The online namespace answered its OWN boot reads when the switch moved the
        // surface to it — discovery, listing, and the two catalogues — and not one of them
        // is a write: the offline turn left no session, no task and no transcript behind.
        expect(
            callsOf(transport).filter(([, url]) => url.includes('/harness/'))
        ).toEqual([
            ['POST', '/v1/harness/models'],
            ['GET', '/v1/harness/sessions?limit=100'],
            ['GET', '/v1/harness/agents?limit=100'],
            ['GET', '/v1/harness/tools?limit=100']
        ]);
        // The draft the ONLINE surface owns was never overwritten by the offline send.
        expect(cells.draft.get()).toBe('');
    });

    it('a session switch mid-stream stops the deltas from landing on the new chat', async () => {
        // OFFLINE transport (paced deltas, same reason as the case above): the reported
        // bug is the abandoned stream's tokens flooding the chat the operator opened
        // mid-flight, and that is namespace-independent.
        const record = recordFixture('conv-2', {
            title: 'Other chat',
            messages: [{ role: 'user', content: 'Something else' }],
            model: 'alpha/flash',
            createdAt: '2026-11-07T00:00:00.000Z',
            updatedAt: '2026-11-07T00:00:01.000Z'
        });

        seedSettings('offline', TEST_PROVIDER_URL);
        upsertLocalConversation(record);
        double = installFetch([catalogRoute(), pacedCompletionRoute(['One', 'Two'])]);
        instance = createTestChat({ pollIntervalMs: 5_000 });
        const cells = instance.service<ChatCells>(CHAT_CELLS_SERVICE);
        await vi.waitFor(() => {
            expect(cells.model.get()).toBe('alpha/flash');
        });

        cells.draft.set('Hello there');
        void instance.execute<void, Promise<void>>(CHAT_MESSAGE_SEND_COMMAND);
        await vi.waitFor(() => {
            expect(cells.streaming.get()).toBe('One');
        }, { interval: 1, timeout: 5_000 });

        await instance.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, 'conv-2');
        await vi.waitFor(() => {
            expect(cells.transcript.get()).toEqual(record.messages);
        });
        // The abandoned stream's tokens no longer write into the surface the operator
        // is reading (the reported bug: the bubbles flooded the newly opened chat).
        expect(cells.streaming.get()).toBe('');
        expect(cells.pending.get()).toBeNull();
        expect(cells.activeSessionId.get()).toBe('conv-2');
        // The abandoned turn wrote nothing into the map either: an OFFLINE new chat has no
        // id while the stream runs (source.ts:541-544), so its record is created at
        // completion — inside the surface guard the switch just invalidated. That is the
        // offline namespace's own pre-rebuild rule (unchanged by the rebuild), and the
        // mirror image of the online case above, where the session already exists and the
        // append therefore survives the switch.
        expect(Object.keys(readLocalConversations())).toEqual(['conv-2']);
        expect(cells.transcript.get()).toEqual(record.messages);
        // Two requests, exactly: the catalog the mount read, and the one provider
        // completion the send issued. The abandoned stream opened no second request.
        expect(
            double!.calls().map((call) => [call.method, call.url] as [string, string])
        ).toEqual([
            ['GET', PROVIDER_MODELS],
            ['POST', PROVIDER_COMPLETIONS]
        ]);
    });
});

describe('chat source — R14 pending-conversation polling', () => {
    let instance: Dashboard | null = null;
    let double: FetchDouble | null = null;

    beforeEach(() => resetStorage());

    afterEach(() => {
        instance?.dispose();
        instance = null;
        double = null;
        vi.unstubAllGlobals();
    });

    it('merges a settled record into the open chat and then stops polling', async () => {
        const pending = recordFixture('conv-p', {
            title: 'New conversation',
            messages: [],
            model: 'alpha/flash',
            status: 'pending',
            createdAt: '2026-11-07T00:00:00.000Z',
            updatedAt: '2026-11-07T00:00:01.000Z'
        });
        const settled = recordFixture('conv-p', {
            title: 'Finished elsewhere',
            model: 'alpha/flash',
            status: 'complete',
            messages: [
                { role: 'user', content: 'Finished elsewhere' },
                { role: 'assistant', content: 'Answered in another tab', model: 'alpha/flash' }
            ],
            createdAt: '2026-11-07T00:00:00.000Z',
            updatedAt: '2026-11-07T00:00:05.000Z'
        });

        // R14 polling is the OFFLINE completion path since the rebuild: online a turn is
        // settled by the `harness.v1` stream (MISSING-FEATURES.md entry 4), so the watch
        // this case pins reads the browser's own map. "Another tab finished it" is
        // therefore modelled by rewriting that map behind the poller's back.
        seedSettings('offline', TEST_PROVIDER_URL);
        seedTrackedIds(['conv-p']);
        upsertLocalConversation(pending);
        double = installFetch([catalogRoute()]);
        // The R14 cadence is the subject here, so this pair keeps the harness's
        // 5ms override instead of the 5s one the other cases use to keep their
        // request logs free of poll traffic.
        instance = createTestChat();
        const cells = instance.service<ChatCells>(CHAT_CELLS_SERVICE);
        await vi.waitFor(() => {
            expect(cells.sessions.get()).toHaveLength(1);
        });
        expect(cells.sessions.get()[0].status).toBe('pending');

        await instance.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, 'conv-p');
        expect(cells.transcript.get()).toEqual([]);

        // The other tab's write is what settles it: the 5ms poll adopts the finished turn
        // into the open chat and re-derives nothing locally.
        upsertLocalConversation(settled);

        await vi.waitFor(() => {
            expect(cells.transcript.get()).toEqual(settled.messages);
        });
        expect(cells.sessions.get()).toEqual([summaryFixture(settled)]);
        // The adopted record carries no usage fold, so the counter cell is cleared rather
        // than invented (`usage ?? null`, the same rule the online canonical read uses).
        expect(cells.usage.get()).toBeNull();

        // Polling stopped: the conversation is no longer pending, so a further write to
        // the same record is NOT adopted (a settled record is never polled forever).
        upsertLocalConversation({ ...settled, title: 'Written after the settle' });
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(cells.sessions.get()).toEqual([summaryFixture(settled)]);
        expect(cells.transcript.get()).toEqual(settled.messages);
        // The offline watch issues no request at all: the only call on the wire is the
        // catalog read the mount made.
        expect(double!.calls()).toEqual([
            { url: PROVIDER_MODELS, method: 'GET', body: null }
        ]);
    });

    it('untracks and drops a conversation that vanished', async () => {
        const doomed = recordFixture('conv-gone', {
            title: 'Doomed',
            model: 'alpha/flash',
            messages: [{ role: 'user', content: 'Doomed' }],
            status: 'pending',
            createdAt: '2026-11-07T00:00:00.000Z',
            updatedAt: '2026-11-07T00:00:01.000Z'
        });

        seedSettings('offline', TEST_PROVIDER_URL);
        seedTrackedIds(['conv-gone']);
        upsertLocalConversation(doomed);
        double = installFetch([catalogRoute()]);
        instance = createTestChat();
        const cells = instance.service<ChatCells>(CHAT_CELLS_SERVICE);
        await vi.waitFor(() => {
            expect(cells.sessions.get()).toHaveLength(1);
        });
        await instance.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, 'conv-gone');
        // The pending row is what arms the watch (the oracle's `pendingConversationId`).
        expect(cells.activeSessionId.get()).toBe('conv-gone');
        expect(cells.transcript.get()).toEqual(doomed.messages);

        // The record disappears mid-watch (another tab deleted it): the offline store
        // answers its own `Conversation 'conv-gone' not found`, which is the message the
        // poller's vanished branch matches (plugins/source.ts:288-292).
        window.localStorage.setItem(LOCAL_CONVERSATIONS_KEY, '{}');

        await vi.waitFor(() => {
            expect(cells.sessions.get()).toEqual([]);
        });
        // untrack + drop, and NOTHING else: the surface keeps the record it is showing
        // (:2874-2884 never clears `selected`), and the failure is not a banner
        expect(readTrackedIds()).toEqual([]);
        expect(cells.transcript.get()).toEqual(doomed.messages);
        expect(cells.activeSessionId.get()).toBe('conv-gone');
    });
});

// ——— helpers local to this file —————————————————————————————————————————————————

/**
 * A streamed Response that waits one macrotask per frame, so a test can observe a
 * delta and cancel (or switch the mode) BETWEEN frames — the window the shipped
 * UI has and a synchronous fake stream would hide. An aborted signal makes the
 * next read reject with the platform AbortError, exactly like undici.
 */
function pacedStream(frames: readonly string[], signal: AbortSignal | null): Response {
    const bytes = frames.map((frame) => new TextEncoder().encode(frame));
    let cursor = 0;
    let cancelled = false;
    const aborted = () => cancelled || signal?.aborted === true;
    return {
        ok: true,
        status: 200,
        json: async () => ({}),
        body: {
            getReader: () => ({
                read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
                    if (aborted()) throw abortError();
                    await new Promise((resolve) => setTimeout(resolve, 25));
                    if (aborted()) throw abortError();
                    if (cursor >= bytes.length) return { done: true };
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
}

/** The platform abort shape undici/jsdom surface: a DOMException named AbortError. */
function abortError(): Error & { name: string } {
    const error = new Error('The operation was aborted.') as Error & { name: string };
    error.name = 'AbortError';
    return error;
}
