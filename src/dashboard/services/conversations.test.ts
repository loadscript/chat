// Deterministic tests for the mode-aware conversation SERVICE facade
// (src/dashboard/services/conversations.ts). The facade must delegate: ONLINE
// cases assert the EXACT requests the harness client issues (`/v1/harness/sessions`
// CRUD, the thread transcript document, the agent-instruction write) plus the
// follow-up canonical multi-read, and OFFLINE cases assert the EXACT records
// api/offline.ts persists (the local store stamps its own instants, so a clock-owned
// field is read from the row rather than asserted as a literal). `fetch` is stubbed
// with the same Response substitute the api tests use — including the response
// HEADERS the harness frontend client reads — and jsdom's real localStorage backs
// the tracked-id cache (key unchanged).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DEFAULT_CONVERSATION_TITLE,
    TRACKED_CONVERSATIONS_KEY,
    trackConversationId,
    type ConversationRecord,
    type ConversationSummary
} from '../../api/conversation';
import { LOCAL_CONVERSATIONS_KEY, upsertLocalConversation } from '../../api/offline';
import { configureHarnessApiRoot } from '../../api/harness';
import { createConversationStore } from './conversations';

// JSON-envelope Response substitute (the pattern api/conversation.test.ts and
// api/harness.test.ts both use).
// The harness frontend client reads its metadata off the RESPONSE HEADERS
// (x-harness-epoch / x-harness-revision, packages/underload/harness/src/frontend/
// api.ts:609-611), so the substitute answers `get` for every header name.
const response = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    ({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
        json: async () => body
    }) as Response;

// A successful harness envelope: the epoch + revision the client requires.
const ok = (body: unknown, revision = 1): Response =>
    response(200, body, { 'x-harness-epoch': EPOCH, 'x-harness-revision': String(revision) });

// A harness failure envelope: `{error:{message}}` is what the client unwraps.
const error = (status: number, message: string): Response =>
    response(status, { error: { message } }, { 'x-harness-epoch': EPOCH });

// Every call the double served, in order (url, method, parsed body).
type Call = { url: string; method: string; body: unknown };
const calls: Call[] = [];

// Fixed instants for the wire's millisecond timestamps.
const TS_A = 1_780_000_000_000;
const TS_B = 1_780_000_060_000;

/** Seed the browser-owned tracked-id cache (the same key the app uses). */
const seedTracked = (ids: readonly string[]): void => {
    for (const id of ids) trackConversationId(id);
};

/** The sidebar row one `sessionRow` projects to — spelled out, not derived. */
const harnessSummary = (id: string): ConversationSummary => ({
    conversationId: id,
    title: 'Hello assistant',
    model: 'test/model',
    status: 'complete',
    // A list row counts TURNS; a listing never downloads transcripts.
    messageCount: 2,
    createdAt: new Date(TS_A).toISOString(),
    updatedAt: new Date(TS_B).toISOString()
});

// The harness API ROOT. The client resolves the root ONCE per page load (see
// src/api/harness.ts), so the tests assert against the automatic same-origin
// root the packaged server serves, and pass it as the declared value too.
const BASE_URL = '/v1/harness';
// The registry epoch the doubles hand back on every response.
const EPOCH = 'epoch-test';

// Exact persisted record the online GET/PUT envelopes carry.
const record = (conversationId: string): ConversationRecord => ({
    conversationId,
    title: 'Hello assistant',
    model: 'test/model',
    status: 'complete',
    messageCount: 2,
    messages: [
        { role: 'user', content: 'Hello assistant' },
        { role: 'assistant', content: 'Hello user', model: 'test/model' }
    ],
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:01.000Z'
});

// Compact summary derived from `record`, spelled field-by-field so it stays the
// exact 7-key shape the collection GET returns (no message bodies, no usage).
// `updatedAt` is overridable because the local fixtures re-date rows to make
// the newest-first ordering deterministic.
const summary = (conversationId: string, updatedAt?: string): ConversationSummary => {
    const source = record(conversationId);
    return {
        conversationId,
        title: source.title,
        model: source.model,
        status: source.status,
        messageCount: source.messageCount,
        createdAt: source.createdAt,
        updatedAt: updatedAt ?? source.updatedAt
    };
};

// Full record seeded straight into the browser-local store (the offline module's
// deterministic fixture seam, api/offline.ts:214-221).
const seedLocal = (conversationId: string, updatedAt: string): ConversationRecord =>
    upsertLocalConversation({ ...record(conversationId), updatedAt });

const onlineStore = () => createConversationStore('online', { baseUrl: BASE_URL });
const offlineStore = () => createConversationStore('offline', {});

describe('conversation store — online mode', () => {
    // The harness wire, spelled exactly as `src/api/harness.test.ts` spells it
    // (that file owns the projection contract; this one owns the FACADE: which
    // requests a facade call produces, in which order, and what it returns).
    const sessionRow = (id: string, overrides: Record<string, unknown> = {}) => ({
        id,
        title: 'Hello assistant',
        harness: 'chat',
        status: 'idle',
        model: 'test/model',
        created_at: TS_A,
        updated_at: TS_B,
        turn_count: 2,
        thread_count: 1,
        revision: 4,
        definition_revision: 0,
        agent_models: { instruct: 'test/model' },
        ...overrides
    });

    const threadRow = (id = 'thread-1') => ({
        id,
        agent: 'instruct',
        origin: 'host',
        status: 'idle',
        sequence: 2,
        transcript_state: 'ok',
        message_count: 2,
        has_transcript: true,
        preview: 'Hello assistant'
    });

    const TRANSCRIPT = {
        items: [
            { role: 'user', content: 'Hello assistant' },
            { role: 'assistant', content: 'Hello user' }
        ],
        next_cursor: null,
        revision: 4,
        limit: 100
    };

    const pageOf = (items: unknown[]) => ({ items, next_cursor: null, revision: 1, limit: 100 });

    // The canonical record this wire projects to, spelled in full. `usage` is
    // absent because the routes below answer it with a 500: the lazy-read rule in
    // src/api/harness.ts:358-370 keeps the conversation and clears the counters.
    const harnessRecord = (id: string, title = 'Hello assistant'): ConversationRecord => ({
        conversationId: id,
        title,
        model: 'test/model',
        status: 'complete',
        messageCount: 2,
        messages: [
            { role: 'user', content: 'Hello assistant' },
            { role: 'assistant', content: 'Hello user' }
        ],
        createdAt: new Date(TS_A).toISOString(),
        updatedAt: new Date(TS_B).toISOString()
    });

    /** Route-matched harness double; an unrouted request THROWS, and every call is logged. */
    const installHarnessRoutes = (
        routes: Array<{ path: string; method: string; reply: () => Response }>,
        fallback?: () => Response
    ): void => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: unknown, init?: RequestInit) => {
                const full = String(input);
                const method = (init?.method ?? 'GET').toUpperCase();
                const raw = init?.body;
                const path = full.split('?')[0];

                calls.push({ url: full, method, body: typeof raw === 'string' ? JSON.parse(raw) : raw ?? null });

                for (const route of routes) {
                    if (route.method === method && route.path === path) return route.reply();
                }

                if (fallback !== undefined) return fallback();

                throw new Error(`Unrouted test request: ${method} ${full}`);
            })
        );
    };

    /** The default healthy server: every resource the store reads has an answer. */
    const installHealthy = (id = 'conversation-1'): void =>
        installHarnessRoutes([
            // `POST /sessions` answers an ENVELOPE: `{session: {...}}` (the same shape
            // src/api/harness.test.ts:377 pins against the live contract).
            // `title: null` is what a session created WITHOUT one answers with — the
            // client is what turns it into the default title (src/api/harness.ts:415).
            { path: `${BASE_URL}/sessions`, method: 'POST', reply: () => ok({ session: sessionRow(id, { title: null, turn_count: 1 }) }) },
            { path: `${BASE_URL}/sessions`, method: 'GET', reply: () => ok(pageOf([sessionRow(id)])) },
            // Reads answer envelopes too: `{session: {...}}` on both GET and PATCH
            // (the shapes src/api/harness.test.ts:243-244 and :461-462 pin).
            { path: `${BASE_URL}/sessions/${id}`, method: 'GET', reply: () => ok({ session: sessionRow(id) }) },
            { path: `${BASE_URL}/sessions/${id}/threads`, method: 'GET', reply: () => ok(pageOf([threadRow()])) },
            // The transcript document is READ as a paged log and WRITTEN as one
            // document: two URLs, and the facade walks both (src/api/harness.ts:318-326).
            { path: `${BASE_URL}/sessions/${id}/threads/thread-1/transcript/messages`, method: 'GET', reply: () => ok(TRANSCRIPT) },
            { path: `${BASE_URL}/sessions/${id}/usage`, method: 'GET', reply: () => error(500, 'usage is down') },
            {
                path: `${BASE_URL}/sessions/${id}/threads/thread-1/transcript`,
                method: 'PUT',
                reply: () => ok({ session_id: id, thread_id: 'thread-1', accepted_as: 'transcript', message_count: 2, revision: 5 })
            },
            { path: `${BASE_URL}/sessions/${id}`, method: 'PATCH', reply: () => ok({ session: sessionRow(id) }) },
            { path: `${BASE_URL}/sessions/${id}`, method: 'DELETE', reply: () => ok({ session_id: id, aborted_runs: 0 }) },
            { path: `${BASE_URL}/sessions/${id}/turns`, method: 'POST', reply: () => ok({ task_id: 'task-1', status: 'queued' }) }
        ]);

    const store = () => (installHealthy(), onlineStore());

    beforeEach(() => {
        calls.length = 0;
        window.localStorage.clear();
        // A declared root from a previous case would outlive the storage clear, so
        // every case starts from the automatic same-origin root.
        configureHarnessApiRoot('');
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        window.localStorage.clear();
        configureHarnessApiRoot('');
    });

    it('exposes the mode it was built with', () => {
        expect(onlineStore().mode).toBe('online');
        expect(offlineStore().mode).toBe('offline');
    });

    it('creates through a preset session POST, tracks the id, and reads back the empty session', async () => {
        installHarnessRoutes([
            {
                path: `${BASE_URL}/sessions`,
                method: 'POST',
                reply: () => ok({ session: sessionRow('conversation-9', { title: 'Hello assistant' }) })
            }
        ]);

        const created = await onlineStore().create({
            messages: [{ role: 'user', content: 'Hello assistant' }],
            model: 'test/model'
        });

        // A harness session opens WITHOUT a transcript, so the record the create
        // answers with is empty — the title is derived here, in the browser.
        expect(created).toEqual({
            conversationId: 'conversation-9',
            title: 'Hello assistant',
            model: 'test/model',
            status: 'complete',
            messageCount: 0,
            messages: [],
            createdAt: new Date(TS_A).toISOString(),
            updatedAt: new Date(TS_B).toISOString()
        });
        expect(calls).toEqual([
            {
                url: `${BASE_URL}/sessions`,
                method: 'POST',
                body: {
                    harness: 'chat',
                    title: 'Hello assistant',
                    settings: { model: 'test/model' }
                }
            }
        ]);
        expect(window.localStorage.getItem(TRACKED_CONVERSATIONS_KEY)).toBe('["conversation-9"]');
    });

    it('appends as a re-read, then renames only when the conversation is still untitled', async () => {
        installHarnessRoutes([
            // `title: 'New conversation'` is the placeholder this UI writes, and the
            // only title a first-turn rename may overwrite (untitled() in
            // src/dashboard/services/conversations.ts:162-163) — so the PATCH below fires.
            { path: `${BASE_URL}/sessions/conversation-1`, method: 'GET', reply: () => ok({ session: sessionRow('conversation-1', { title: DEFAULT_CONVERSATION_TITLE }) }) },
            { path: `${BASE_URL}/sessions/conversation-1/threads`, method: 'GET', reply: () => ok(pageOf([threadRow()])) },
            { path: `${BASE_URL}/sessions/conversation-1/threads/thread-1/transcript/messages`, method: 'GET', reply: () => ok(TRANSCRIPT) },
            { path: `${BASE_URL}/sessions/conversation-1/usage`, method: 'GET', reply: () => error(500, 'usage is down') },
            { path: `${BASE_URL}/sessions/conversation-1`, method: 'PATCH', reply: () => ok({ session: sessionRow('conversation-1') }) }
        ]);

        const appended = await onlineStore().append('conversation-1', {
            messages: [{ role: 'user', content: 'Hello assistant' }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
        });

        expect(appended).toEqual(harnessRecord('conversation-1'));
        expect(calls).toEqual([
            { url: `${BASE_URL}/sessions/conversation-1`, method: 'GET', body: null },
            { url: `${BASE_URL}/sessions/conversation-1/threads?limit=100`, method: 'GET', body: null },
            { url: `${BASE_URL}/sessions/conversation-1/threads/thread-1/transcript/messages?limit=100`, method: 'GET', body: null },
            { url: `${BASE_URL}/sessions/conversation-1/usage`, method: 'GET', body: null },
            {
                url: `${BASE_URL}/sessions/conversation-1`,
                method: 'PATCH',
                body: { title: 'Hello assistant' }
            }
        ]);
    });

    it('replaces through a title PATCH plus one transcript PUT, then re-reads', async () => {
        installHealthy();

        const replaced = await onlineStore().replace('conversation-1', {
            title: 'Renamed chat',
            messages: [
                { role: 'user', content: 'Hello assistant' },
                { role: 'assistant', content: 'Hello user' }
            ]
        });

        expect(replaced).toEqual(harnessRecord('conversation-1', 'Renamed chat'));
        expect(calls.map((call) => `${call.method} ${call.url.split('?')[0].slice(BASE_URL.length)}`)).toEqual([
            'PATCH /sessions/conversation-1',
            'GET /sessions/conversation-1/threads',
            'GET /sessions/conversation-1/threads/thread-1/transcript/messages',
            'PUT /sessions/conversation-1/threads/thread-1/transcript',
            'GET /sessions/conversation-1',
            'GET /sessions/conversation-1/threads',
            'GET /sessions/conversation-1/threads/thread-1/transcript/messages',
            'GET /sessions/conversation-1/usage'
        ]);
        expect(calls[0].body).toEqual({ title: 'Renamed chat' });
        expect(calls[3].body).toEqual({
            messages: [
                { role: 'user', content: 'Hello assistant' },
                { role: 'assistant', content: 'Hello user' }
            ],
            if_revision: 4
        });
    });

    it('reads one record through the session, thread, transcript and usage reads', async () => {
        installHealthy();

        const read = await onlineStore().read('conversation-1');

        expect(read).toEqual(harnessRecord('conversation-1'));
        expect(calls.map((call) => `${call.method} ${call.url.split('?')[0].slice(BASE_URL.length)}`)).toEqual([
            'GET /sessions/conversation-1',
            'GET /sessions/conversation-1/threads',
            'GET /sessions/conversation-1/threads/thread-1/transcript/messages',
            'GET /sessions/conversation-1/usage'
        ]);
    });

    it('lists the tracked ids only, and prunes ids the server dropped', async () => {
        installHarnessRoutes([
            {
                path: `${BASE_URL}/sessions`,
                method: 'GET',
                reply: () => ok(pageOf([sessionRow('conversation-1')]))
            }
        ]);
        seedTracked(['conversation-1', 'gone']);

        const rows = await onlineStore().list(['conversation-1', 'gone']);

        expect(rows).toEqual([harnessSummary('conversation-1')]);
        // The server no longer holds `gone`, so the cache lets it go.
        expect(window.localStorage.getItem(TRACKED_CONVERSATIONS_KEY)).toBe('["conversation-1"]');
        expect(calls).toEqual([{ url: `${BASE_URL}/sessions?limit=100`, method: 'GET', body: null }]);
    });

    it('never prunes tracked ids a scoped query did not ask about', async () => {
        installHarnessRoutes([
            { path: `${BASE_URL}/sessions`, method: 'GET', reply: () => ok(pageOf([sessionRow('conversation-1')])) }
        ]);
        seedTracked(['conversation-1', 'other']);

        const rows = await onlineStore().list(['conversation-1']);

        expect(rows).toEqual([harnessSummary('conversation-1')]);
        expect(window.localStorage.getItem(TRACKED_CONVERSATIONS_KEY)).toBe('["conversation-1","other"]');
    });

    it('deletes through the session DELETE and untracks only after the server confirms', async () => {
        installHealthy();
        seedTracked(['conversation-1']);

        await onlineStore().remove('conversation-1');

        expect(calls).toEqual([{ url: `${BASE_URL}/sessions/conversation-1`, method: 'DELETE', body: null }]);
        expect(window.localStorage.getItem(TRACKED_CONVERSATIONS_KEY)).toBe('[]');
    });

    it('keeps the conversation tracked when the DELETE fails', async () => {
        installHarnessRoutes([
            {
                path: `${BASE_URL}/sessions/conversation-1`,
                method: 'DELETE',
                reply: () => error(500, 'store unwritable')
            }
        ]);
        seedTracked(['conversation-1']);

        await expect(onlineStore().remove('conversation-1')).rejects.toThrow('store unwritable');
        expect(window.localStorage.getItem(TRACKED_CONVERSATIONS_KEY)).toBe('["conversation-1"]');
    });

    it('dials the automatic same-origin harness root when no base url is declared', async () => {
        installHealthy();

        const created = await createConversationStore('online', {}).create({ model: '' });

        expect(created.conversationId).toBe('conversation-1');
        expect(created.title).toBe(DEFAULT_CONVERSATION_TITLE);
        // An empty declaration leaves the client on its documented default root.
        expect(calls).toEqual([
            // No title key: a create that names no messages sends no title, and no
            // `settings` either, so the SERVER's provider model stands.
            { url: '/v1/harness/sessions', method: 'POST', body: { harness: 'chat' } }
        ]);
    });

    it('surfaces the server error message for a failed canonical read', async () => {
        installHarnessRoutes([
            {
                path: `${BASE_URL}/sessions/gone`,
                method: 'GET',
                reply: () => error(404, "Session 'gone' not found.")
            }
        ]);

        await expect(onlineStore().read('gone')).rejects.toThrow("Session 'gone' not found.");
    });
});

describe('conversation store — offline mode', () => {
    beforeEach(() => {
        window.localStorage.clear();
        vi.stubGlobal('fetch', vi.fn());
        // Pin every timestamp the local store writes (createdAt/updatedAt), so
        // the created record can be asserted exactly like the server would.
        vi.useFakeTimers({ now: new Date('2026-08-06T00:00:00.000Z') });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        window.localStorage.clear();
    });

    it('lists the browser-local summaries newest first and never touches the network', async () => {
        seedLocal('conversation-old', '2026-08-06T00:00:00.000Z');
        seedLocal('conversation-new', '2026-08-06T12:00:00.000Z');

        // The id filter is ignored offline: every local record already belongs
        // to this browser.
        expect(offlineStore().list(['conversation-old'])).resolves.toEqual([
            summary('conversation-new', '2026-08-06T12:00:00.000Z'),
            summary('conversation-old', '2026-08-06T00:00:00.000Z')
        ]);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('creates locally, persists the derived record, and tracks the new id', async () => {
        const store = offlineStore();
        const { conversationId, ...created } = await store.create({
            messages: [{ role: 'user', content: 'Hello assistant' }],
            model: 'test/model'
        });

        expect(created).toEqual({
            title: 'Hello assistant',
            model: 'test/model',
            status: 'complete',
            messageCount: 1,
            messages: [{ role: 'user', content: 'Hello assistant' }],
            createdAt: '2026-08-06T00:00:00.000Z',
            updatedAt: '2026-08-06T00:00:00.000Z'
        });
        // The id is provider-generated, so it is the only non-deterministic field.
        expect(typeof conversationId).toBe('string');
        expect(store.tracked()).toEqual([conversationId]);
        // The same canonical record comes back through read().
        expect(await store.read(conversationId)).toEqual({ ...created, conversationId });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('apends and replaces locally against the same store semantics', async () => {
        const store = offlineStore();
        // A prompt-only start: the appended user turn is what gives the
        // conversation its derived title (the mirrored server rule).
        const created = await store.create({ systemPrompt: 'Be brief', model: 'test/model' });
        expect(created.messages).toEqual([{ role: 'system', content: 'Be brief' }]);

        const appended = await store.append(created.conversationId, {
            message: 'Hello assistant',
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
        });
        expect(appended).toEqual({
            conversationId: created.conversationId,
            title: 'Hello assistant',
            model: 'test/model',
            status: 'complete',
            messageCount: 2,
            messages: [
                { role: 'system', content: 'Be brief' },
                { role: 'user', content: 'Hello assistant' }
            ],
            createdAt: '2026-08-06T00:00:00.000Z',
            updatedAt: '2026-08-06T00:00:00.000Z',
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
        });

        // A history rewrite keeps the stored model and the lifetime usage
        // aggregate when neither is resupplied.
        const replaced = await store.replace(created.conversationId, {
            messages: [{ role: 'user', content: 'Edited question' }]
        });
        expect(replaced).toEqual({
            conversationId: created.conversationId,
            title: 'Edited question',
            model: 'test/model',
            status: 'complete',
            messageCount: 1,
            messages: [{ role: 'user', content: 'Edited question' }],
            createdAt: '2026-08-06T00:00:00.000Z',
            updatedAt: '2026-08-06T00:00:00.000Z',
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
        });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('deletes locally, untracks, and reports the server 404 message for a missing id', async () => {
        const store = offlineStore();
        seedLocal('conversation-1', '2026-08-06T00:00:00.000Z');
        trackConversationId('conversation-1');

        await store.remove('conversation-1');
        expect(store.tracked()).toEqual([]);
        expect(JSON.parse(window.localStorage.getItem(LOCAL_CONVERSATIONS_KEY) as string)).toEqual({});

        await expect(store.remove('conversation-1')).rejects.toThrow("Conversation 'conversation-1' not found");
        await expect(store.read('conversation-1')).rejects.toThrow("Conversation 'conversation-1' not found");
    });

    it('switching mode switches the namespace without mixing records', async () => {
        seedLocal('conversation-local', '2026-08-06T00:00:00.000Z');
        seedTracked(['conversation-server']);
        calls.length = 0;

        // The online half of the switch is a harness listing; the offline half
        // never touches the network, so one routed response is all the server does.
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: unknown, init?: RequestInit) => {
                const full = String(input);

                calls.push({ url: full, method: (init?.method ?? 'GET').toUpperCase(), body: null });

                if (full.split('?')[0] === '/v1/harness/sessions') {
                    return ok({
                        items: [
                            {
                                id: 'conversation-server',
                                title: 'Hello assistant',
                                harness: 'chat',
                                status: 'idle',
                                model: 'test/model',
                                created_at: TS_A,
                                updated_at: TS_B,
                                turn_count: 2,
                                thread_count: 1,
                                revision: 4
                            }
                        ],
                        next_cursor: null,
                        revision: 1,
                        limit: 100
                    });
                }

                throw new Error(`Unrouted test request: ${full}`);
            })
        );

        // Offline reads the browser-local map only; online reads the harness only.
        expect(await offlineStore().list([])).toEqual([summary('conversation-local', '2026-08-06T00:00:00.000Z')]);
        expect(await onlineStore().list(['conversation-server'])).toEqual([harnessSummary('conversation-server')]);

        // One request, and it is the harness listing — the two namespaces never mix.
        expect(calls).toEqual([{ url: '/v1/harness/sessions?limit=100', method: 'GET', body: null }]);
    });
});

describe('conversation store — tracked id cache', () => {
    beforeEach(() => window.localStorage.clear());
    afterEach(() => window.localStorage.clear());

    it('round-trips tracked ids and never duplicates a re-tracked id', () => {
        const store = onlineStore();
        expect(store.tracked()).toEqual([]);

        store.track('conversation-1');
        store.track('conversation-1');
        store.track('conversation-2');
        expect(store.tracked()).toEqual(['conversation-1', 'conversation-2']);
        expect(window.localStorage.getItem(TRACKED_CONVERSATIONS_KEY)).toBe('["conversation-1","conversation-2"]');

        store.untrack('conversation-1');
        expect(store.tracked()).toEqual(['conversation-2']);
        store.untrack('missing');
        expect(store.tracked()).toEqual(['conversation-2']);
    });

    it('shares one cache between both stores and degrades a hand-edited cache to clean ids', () => {
        window.localStorage.setItem(TRACKED_CONVERSATIONS_KEY, JSON.stringify(['a', '', 3, null, 'a', 'b']));

        const online = onlineStore();
        const offline = offlineStore();
        expect(online.tracked()).toEqual(['a', 'b']);
        expect(offline.tracked()).toEqual(['a', 'b']);

        offline.untrack('a');
        expect(online.tracked()).toEqual(['b']);
    });
});
