// Typed harness API client tests (R2).
//
// THE CONTRACT UNDER TEST is the PROJECTION, not the HTTP: the harness package
// owns the fetch, the error envelope and the paging helpers, and this module is
// forbidden from duplicating them — so a `fetch` double is installed only to
// (a) answer the harness WIRE shapes exactly as the generated contract spells
// them and (b) record the URL + method + parsed body of every call, which is how
// "the client sent the right request" is proved rather than assumed.
//
// Every assertion is an exact value: the projected record, the request log, and
// the derived title. Where the harness contract splits a read (session + thread
// + transcript + usage), the test pins the ORDER of the calls too, because a
// re-ordered assembly is how a UI ends up showing a stale transcript.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    configureHarnessApiRoot,
    createHarnessConversation,
    entryAgentId,
    harnessApiRoot,
    harnessApiRootSetting,
    listHarnessConversations,
    messagesFromTranscript,
    readHarnessConversation,
    readHarnessSystemPrompt,
    readHarnessTurnText,
    selectConversationThread,
    setHarnessConversationModel,
    statusFromSession,
    submitHarnessTask,
    summaryFromSession,
    textOfTurnDisplay,
    usageFromHarness,
    writeHarnessTranscript
} from './harness';

const ROOT = '/v1/harness';

type Call = { url: string; method: string; body: unknown };

const calls: Call[] = [];

const jsonResponse = (status: number, body: unknown): Response =>
    ({
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => body
    }) as Response;

/** A route-matched fetch double; an unrouted request THROWS (no silent pass-through). */
const installFetch = (routes: Array<{ match: (url: string, method: string) => boolean; reply: () => Response }>): void => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown, init?: RequestInit) => {
            const url = String(input);
            const method = (init?.method ?? 'GET').toUpperCase();
            const raw = init?.body;

            calls.push({ url, method, body: typeof raw === 'string' ? JSON.parse(raw) : raw ?? null });

            for (const route of routes) {
                if (route.match(url, method)) return route.reply();
            }

            throw new Error(`Unrouted test request: ${method} ${url}`);
        })
    );
};

// ---------------------------------------------------------------------------
// Fixtures: the harness wire, spelled exactly as the generated contract does
// ---------------------------------------------------------------------------

const SESSION = {
    id: 'sess-1',
    title: 'Two and two',
    harness: 'chat',
    status: 'idle' as const,
    model: 'local/basalt',
    created_at: 1_780_000_000_000,
    updated_at: 1_780_000_060_000,
    turn_count: 2,
    thread_count: 1,
    revision: 4
};

const SESSION_RESOURCE = {
    ...SESSION,
    definition_revision: 0,
    agent_models: { instruct: 'local/basalt' },
    endpoint: { base_url: 'http://provider.test/v1', model: 'local/basalt', has_api_key: true },
    runtime_execution: 'inline',
    pending_action_count: 0,
    created_tool_count: 0,
    created_tool_limit: 24
};

const THREAD = {
    id: 'thread-1',
    agent: 'instruct',
    origin: 'host' as const,
    status: 'idle' as const,
    sequence: 2,
    transcript_state: 'ok' as const,
    message_count: 3,
    has_transcript: true,
    preview: 'what is two and two?'
};

const TRANSCRIPT_ITEMS = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'what is two and two?' },
    { role: 'assistant', content: 'Four.' }
];

const page = <T>(items: T[], extra: Record<string, unknown> = {}) => ({
    items,
    next_cursor: null,
    revision: 1,
    limit: 100,
    ...extra
});

beforeEach(() => {
    calls.length = 0;
    window.localStorage.clear();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('projections (wire -> view model)', () => {
    it('maps every session status onto the UI vocabulary', () => {
        expect(statusFromSession('idle')).toBe('complete');
        expect(statusFromSession('running')).toBe('pending');
        expect(statusFromSession('error')).toBe('error');
    });

    it('projects one session row into one sidebar row', () => {
        expect(summaryFromSession(SESSION as never)).toEqual({
            conversationId: 'sess-1',
            title: 'Two and two',
            model: 'local/basalt',
            status: 'complete',
            // The list row carries TURN counts; a list never downloads transcripts.
            messageCount: 2,
            createdAt: new Date(1_780_000_000_000).toISOString(),
            updatedAt: new Date(1_780_000_060_000).toISOString()
        });
    });

    it('falls back to the default title when the server has none', () => {
        const row = { ...SESSION, title: undefined };

        expect(summaryFromSession(row as never).title).toBe('New conversation');
    });

    it('renames the harness usage counters into the OpenAI-style names the inspector reads', () => {
        // A wire usage fold may carry figures this projection deliberately drops (the
        // stream's own `onUsage` payload does declare `cached`, api/harness-stream.ts:215).
        // The typed binding says so, instead of loosening the projection's parameter.
        const wireUsage: Parameters<typeof usageFromHarness>[0] & { cached: number } = {
            input: 12,
            output: 8,
            total: 20,
            cached: 4
        };

        expect(usageFromHarness(wireUsage)).toEqual({
            prompt_tokens: 12,
            completion_tokens: 8,
            total_tokens: 20
        });
        // "not reported" is not zero: an absent usage fold stays absent.
        expect(usageFromHarness(undefined)).toBeUndefined();
    });

    it('drops tool entries and keeps the three roles the surface renders', () => {
        const messages = messagesFromTranscript([
            { role: 'system', content: 'prompt' },
            { role: 'user', content: 'question' },
            { role: 'tool', content: '{"ok":true}', toolCallId: 'call-1', name: 'timeNow' },
            { role: 'assistant', content: 'answer' },
            // A blank content row cannot be edited or rendered as a turn, so it
            // never reaches the transcript cell.
            { role: 'assistant', content: '' }
        ] as never);

        expect(messages).toEqual([
            { role: 'system', content: 'prompt' },
            { role: 'user', content: 'question' },
            { role: 'assistant', content: 'answer' }
        ]);
    });

    it('reads the answer text out of a turn display, ignoring reasoning and delegated child sections', () => {
        const display = {
            turnId: 'turn-1',
            revision: 3,
            sections: [
                {
                    id: 's-entry',
                    // The entry agent's own flow: NO `parentSectionId` AND the entry
                    // agent (`'instruct'`, passed to `textOfTurnDisplay`). `rank` is the
                    // letter its agent holds (authority) and selects nothing.
                    rank: 'A',
                    agent: 'instruct',
                    agentLabel: 'Instruct',
                    state: 'done',
                    nodes: [
                        { id: 'n-1', kind: 'reasoning', text: 'thinking out loud' },
                        { id: 'n-2', kind: 'text', text: 'Two and two ' },
                        { id: 'n-3', kind: 'notice', text: 'retry' },
                        { id: 'n-4', kind: 'text', text: 'make four.' }
                    ]
                },
                {
                    id: 's-child',
                    // A delegated child: the server resolved its nesting, and that link
                    // excludes it on its own — a nested flow is not the answer even when
                    // its agent IS the entry agent. (Rank never decides, and the
                    // entry-identity half is what excludes a NESTED-free foreign lane.)
                    rank: 'B',
                    parentSectionId: 's-entry',
                    agent: 'summarizer',
                    agentLabel: 'Summarizer',
                    state: 'done',
                    nodes: [{ id: 'n-5', kind: 'text', text: 'a delegated answer' }]
                }
            ]
        };

        expect(textOfTurnDisplay(display as never, 'instruct')).toBe('Two and two make four.');
    });

    it('excludes a PARENTLESS section that belongs to a NON-entry agent', () => {
        // R85, reviewer case B on the REST read: a delegated lane whose recorded
        // frames carry NO lineage is root-shaped (`parentSectionId` absent), so the
        // nesting-only fold printed 'HELPER PROSE. ' inside the assistant answer. The
        // projector itself documents that shape (harness turn-projector.ts:1395-1407,
        // and a post-restart journal carrying only `thread.id` at :1595-1610), and the
        // app's own dashboard makes it reachable (`plugins/agents.ts` binds a second
        // agent, and a runtime binding lands one rank below the lowest stated rank).
        // IDENTITY is what excludes it — and the identity test, not the section's
        // position: the second assertion below flips the entry and the fold follows.
        const display = {
            turnId: 'turn-3',
            revision: 1,
            sections: [
                {
                    id: 's-root',
                    rank: 'A',
                    agent: 'instruct',
                    agentLabel: 'Instruct',
                    state: 'done',
                    nodes: [{ id: 'n-1', kind: 'text', text: 'ROOT ANSWER. ' }]
                },
                {
                    id: 's-lane',
                    // Root-shaped, delegated, and a DIFFERENT agent: its prose belongs
                    // to the lane's own pane.
                    rank: 'B',
                    agent: 'helper',
                    agentLabel: 'Helper',
                    state: 'done',
                    nodes: [{ id: 'n-2', kind: 'text', text: 'HELPER PROSE. ' }]
                }
            ]
        };

        expect(textOfTurnDisplay(display as never, 'instruct')).toBe('ROOT ANSWER. ');
        expect(textOfTurnDisplay(display as never, 'helper')).toBe('HELPER PROSE. ');
    });

    it('folds the entry agent even when a PARENTLESS foreign lane holds a HIGHER rank', () => {
        // The rank-blindness half, for the shape the old `role` stamp could not express:
        // the entry at Rank B beside a root-shaped Rank A lane. A rank filter picks the
        // FOREIGN prose here; the entry identity picks the answer. (The nested-Rank-A
        // variant stays pinned by 'folds the answer by NESTING…' below.)
        const display = {
            turnId: 'turn-4',
            revision: 1,
            sections: [
                {
                    id: 's-entry',
                    rank: 'B',
                    agent: 'instruct',
                    agentLabel: 'Instruct',
                    state: 'done',
                    nodes: [{ id: 'n-1', kind: 'text', text: 'ENTRY ANSWER. ' }]
                },
                {
                    id: 's-lane',
                    rank: 'A',
                    agent: 'helper',
                    agentLabel: 'Helper',
                    state: 'done',
                    nodes: [{ id: 'n-2', kind: 'text', text: 'FOREIGN PROSE. ' }]
                }
            ]
        };

        expect(textOfTurnDisplay(display as never, 'instruct')).toBe('ENTRY ANSWER. ');
    });

    it('folds the answer by NESTING, whatever rank those flows carry', () => {
        // R83, the REST twin of the stream fold's test: this read is what a resync
        // re-applies, so the two must agree under BOTH shapes the rank model allows.
        //   - the ENTRY agent may hold ANY rank: the flow that owns the answer here is
        //     Rank B, and its text must still be the answer;
        //   - ranks are not singletons and a branch/fork PROPAGATES its source agent's
        //     rank, so a nested flow can legitimately carry Rank A — and a rank filter
        //     would then print a delegated child's prose as the assistant's reply.
        const display = {
            turnId: 'turn-2',
            revision: 1,
            sections: [
                {
                    id: 's-entry',
                    rank: 'B',
                    agent: 'instruct',
                    agentLabel: 'Instruct',
                    state: 'done',
                    nodes: [{ id: 'n-1', kind: 'text', text: 'the entry answer' }]
                },
                {
                    id: 's-nested',
                    rank: 'A',
                    parentSectionId: 's-entry',
                    agent: 'reviewer',
                    agentLabel: 'Reviewer',
                    state: 'done',
                    nodes: [{ id: 'n-2', kind: 'text', text: ' — delegated' }]
                }
            ]
        };

        expect(textOfTurnDisplay(display as never, 'instruct')).toBe('the entry answer');
    });

    it('selects the thread that holds the conversation, deterministically', () => {
        const empty = { ...THREAD, id: 'thread-empty', has_transcript: false, message_count: 0 };
        const older = { ...THREAD, id: 'thread-old', message_count: 3, sequence: 1 };
        const current = { ...THREAD, id: 'thread-new', message_count: 5, sequence: 4 };
        const delegated = {
            ...THREAD,
            id: 'thread-sub',
            origin: 'agent' as const,
            message_count: 9,
            sequence: 9
        };

        // A delegated agent thread has MORE messages but is not the conversation:
        // a host-owned thread wins first, then recency.
        expect(selectConversationThread([empty, delegated, older, current] as never)?.id).toBe('thread-new');
        expect(selectConversationThread([] as never)).toBeNull();
        // With no populated thread at all, the pool falls back to the roster and
        // the tie-break keeps the choice total.
        expect(selectConversationThread([{ ...empty, id: 'b' }, { ...empty, id: 'a' }] as never)?.id).toBe('a');
    });
});

describe('the conversation reads and writes', () => {
    const conversationRoutes = [
        {
            match: (url: string) => url === `${ROOT}/sessions/sess-1`,
            reply: () => jsonResponse(200, { session: SESSION_RESOURCE })
        },
        {
            match: (url: string) => url === `${ROOT}/sessions/sess-1/threads?limit=100`,
            reply: () => jsonResponse(200, page([THREAD]))
        },
        {
            match: (url: string) => url === `${ROOT}/sessions/sess-1/threads/thread-1/transcript/messages?limit=100`,
            reply: () => jsonResponse(200, page(TRANSCRIPT_ITEMS, { thread_id: 'thread-1', agent: 'instruct', transcript_state: 'ok', total: 3 }))
        },
        {
            match: (url: string) => url === `${ROOT}/sessions/sess-1/usage`,
            reply: () =>
                jsonResponse(200, {
                    session_id: 'sess-1',
                    turn_count: 2,
                    reported_turns: 2,
                    usage: { input: 120, output: 34, total: 154 },
                    by_thread: [],
                    truncated: false,
                    revision: 2
                })
        }
    ];

    it('assembles the canonical record from session + thread + transcript + usage, in that order', async () => {
        installFetch(conversationRoutes);

        const record = await readHarnessConversation('sess-1');

        expect(record).toEqual({
            conversationId: 'sess-1',
            title: 'Two and two',
            model: 'local/basalt',
            status: 'complete',
            messageCount: 3,
            messages: [
                { role: 'system', content: 'You are a helpful assistant.' },
                { role: 'user', content: 'what is two and two?' },
                { role: 'assistant', content: 'Four.' }
            ],
            createdAt: new Date(1_780_000_000_000).toISOString(),
            updatedAt: new Date(1_780_000_060_000).toISOString(),
            usage: { prompt_tokens: 120, completion_tokens: 34, total_tokens: 154 }
        });

        // The order is the contract's own (an identified read, then the roster,
        // then the paged document, then the lazy usage fold).
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            `GET ${ROOT}/sessions/sess-1`,
            `GET ${ROOT}/sessions/sess-1/threads?limit=100`,
            `GET ${ROOT}/sessions/sess-1/threads/thread-1/transcript/messages?limit=100`,
            `GET ${ROOT}/sessions/sess-1/usage`
        ]);
    });

    it('survives a failed usage read: the transcript is the chat, the counters are a detail', async () => {
        installFetch([
            ...conversationRoutes.slice(0, 3),
            { match: (url: string) => url === `${ROOT}/sessions/sess-1/usage`, reply: () => jsonResponse(500, { error: { message: 'usage is down' } }) }
        ]);

        const record = await readHarnessConversation('sess-1');

        expect(record.messageCount).toBe(3);
        expect('usage' in record).toBe(false);
    });

    it('lists the collection and scopes it to the ids this browser tracks', async () => {
        installFetch([
            {
                match: (url: string) => url === `${ROOT}/sessions?limit=100`,
                reply: () =>
                    jsonResponse(200, page([SESSION, { ...SESSION, id: 'sess-other', title: 'Elsewhere' }]))
            }
        ]);

        const rows = await listHarnessConversations(['sess-1']);

        expect(rows).toEqual([
            {
                conversationId: 'sess-1',
                title: 'Two and two',
                model: 'local/basalt',
                status: 'complete',
                messageCount: 2,
                createdAt: new Date(1_780_000_000_000).toISOString(),
                updatedAt: new Date(1_780_000_060_000).toISOString()
            }
        ]);
        // The contract has no `?ids=`, so the scope is applied after the page read.
        expect(calls).toEqual([{ url: `${ROOT}/sessions?limit=100`, method: 'GET', body: null }]);
    });

    it('walks the cursors until the cap, and never past it', async () => {
        const row = (id: string) => ({ ...SESSION, id });

        installFetch([
            {
                match: (url: string) => url === `${ROOT}/sessions?limit=100`,
                reply: () => ({
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: new Headers({ 'Content-Type': 'application/json' }),
                    json: async () => ({ items: [row('a'), row('b')], next_cursor: 'c1', revision: 1, limit: 100 })
                }) as Response
            },
            {
                match: (url: string) => url === `${ROOT}/sessions?limit=100&cursor=c1`,
                reply: () => ({
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: new Headers({ 'Content-Type': 'application/json' }),
                    json: async () => ({ items: [row('c')], next_cursor: null, revision: 1, limit: 100 })
                }) as Response
            }
        ]);

        const rows = await listHarnessConversations();

        expect(rows.map((entry) => entry.conversationId)).toEqual(['a', 'b', 'c']);
        expect(calls.map((call) => call.url)).toEqual([
            `${ROOT}/sessions?limit=100`,
            `${ROOT}/sessions?limit=100&cursor=c1`
        ]);
    });

    it('creates from the chat preset with the client title and the selected model', async () => {
        installFetch([
            {
                match: (url: string, method: string) => url === `${ROOT}/sessions` && method === 'POST',
                reply: () => jsonResponse(201, { session: SESSION_RESOURCE })
            }
        ]);

        await createHarnessConversation({ model: 'local/basalt', title: 'Two and two' });

        expect(calls).toEqual([
            {
                url: `${ROOT}/sessions`,
                method: 'POST',
                body: { harness: 'chat', title: 'Two and two', settings: { model: 'local/basalt' } }
            }
        ]);
    });

    it('omits the settings block entirely when no model is selected', async () => {
        installFetch([
            {
                match: (url: string, method: string) => url === `${ROOT}/sessions` && method === 'POST',
                reply: () => jsonResponse(201, { session: { ...SESSION_RESOURCE, title: null } })
            }
        ]);

        const record = await createHarnessConversation({});

        expect(calls[0].body).toEqual({ harness: 'chat' });
        // A session created without a title still renders, through the shared rule.
        expect(record.title).toBe('New conversation');
    });

    it('submits into the remembered thread, and omits the field when there is none', async () => {
        installFetch([
            {
                match: (url: string, method: string) => method === 'POST' && url.endsWith('/tasks'),
                reply: () =>
                    jsonResponse(202, {
                        session_id: 'sess-1',
                        turn_id: 'turn-9',
                        status: 'queued',
                        thread_id: 'thread-1',
                        session_revision: 5,
                        accepted_at: 1,
                        links: { turn: 't', turns: 'ts', thread: 'th', stream: 's' }
                    })
            }
        ]);

        await submitHarnessTask('sess-1', 'what is two and two?');
        await submitHarnessTask('sess-1', 'and three?', 'thread-1');

        expect(calls.map((call) => call.body)).toEqual([
            { input: 'what is two and two?' },
            { input: 'and three?', thread_id: 'thread-1' }
        ]);
    });

    it('changes the model through the entry agent, resolved once per session', async () => {
        installFetch([
            {
                // `GET /sessions/{id}/definition` — the frozen definition, and the
                // only row that states WHICH member is the entry (routing). The
                // roster cannot answer that: its rows carry `rank` (authority), any
                // number of members share a letter, and the entry may hold any letter.
                match: (url: string) => url === `${ROOT}/sessions/sess-model/definition`,
                reply: () =>
                    jsonResponse(200, {
                        definition: {
                            session_id: 'sess-model',
                            name: 'chat',
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
                            frozen_at: 1_780_000_000_000,
                            source_revision: 0,
                            current_revision: 0,
                            current: true
                        }
                    })
            },
            {
                match: (url: string, method: string) => url === `${ROOT}/sessions/sess-model` && method === 'PATCH',
                reply: () => jsonResponse(200, { session: { ...SESSION_RESOURCE, model: 'local/other' } })
            }
        ]);

        await setHarnessConversationModel('sess-model', 'local/other');
        await setHarnessConversationModel('sess-model', 'local/other');

        // The definition is frozen at creation, so the entry agent is resolved ONCE
        // and cached; a second model change costs one PATCH, not two definition reads.
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            `GET ${ROOT}/sessions/sess-model/definition`,
            `PATCH ${ROOT}/sessions/sess-model`,
            `PATCH ${ROOT}/sessions/sess-model`
        ]);
        expect(calls[1].body).toEqual({ agent_models: { instruct: 'local/other' } });
    });

    it('writes the whole transcript document with the optimistic-lock revision', async () => {
        installFetch([
            {
                match: (url: string, method: string) => url === `${ROOT}/sessions/sess-1/threads/thread-1/transcript` && method === 'PUT',
                reply: () =>
                    jsonResponse(200, {
                        session_id: 'sess-1',
                        thread_id: 'thread-1',
                        accepted_as: 'transcript',
                        message_count: 2,
                        revision: 6
                    })
            }
        ]);

        await writeHarnessTranscript(
            'sess-1',
            'thread-1',
            [
                { role: 'system', content: 'prompt', model: 'ignored-by-the-wire' },
                { role: 'user', content: 'edited question' }
            ],
            5
        );

        // The wire document carries the roles and content only: `model` is a
        // client-side attribution the harness transcript has no field for.
        expect(calls[0].body).toEqual({
            messages: [
                { role: 'system', content: 'prompt' },
                { role: 'user', content: 'edited question' }
            ],
            if_revision: 5
        });
    });

    it('reads no system prompt until the member actually carries an override', async () => {
        const definition = {
            session_id: 'sess-prompt',
            name: 'chat',
            title: 'Chat',
            description: 'Plain one-on-one chat.',
            requires_endpoint: true,
            // The entry agent, named by the frozen definition — the read
            // `entryAgentId` performs before it asks the roster for that member's row.
            entry: 'instruct',
            ranks: { instruct: 'A' },
            agents: ['instruct'],
            tools: [],
            builtin: true,
            definition_revision: 0,
            revision: 0,
            frozen_at: 1_780_000_000_000,
            source_revision: 0,
            current_revision: 0,
            current: true
        };

        const roster = (override: boolean) => ({
            session_id: 'sess-prompt',
            total: 1,
            agents: [
                {
                    agent_id: 'instruct',
                    profile: 'instruct',
                    // Authority, as a rank LETTER — and NOT the field that says
                    // "I am the entry": the prompt editor names the member the
                    // definition pointed at and matches it by `agent_id`.
                    rank: 'A',
                    origin: 'definition',
                    model: 'local/basalt',
                    inherited_model: 'local/basalt',
                    instruction_source: override ? 'harness' : 'catalogue',
                    instruction_chars: 24,
                    ...(override ? { has_instruction_override: true } : {}),
                    editable: true,
                    // Detachability is the ENTRY rule the server enforces (a 409 on an
                    // entry detach); rank never gates a detach.
                    deletable: false,
                    restorable: false,
                    revision: override ? 1 : 0
                }
            ],
            revision: override ? 1 : 0
        });

        installFetch([
            { match: (url: string) => url === `${ROOT}/sessions/sess-prompt/definition`, reply: () => jsonResponse(200, { definition }) },
            {
                match: (url: string) => url === `${ROOT}/sessions/sess-prompt/agents`,
                reply: () => jsonResponse(200, roster(false))
            }
        ]);

        // An un-overridden member runs the SHIPPED prompt; reporting that text as
        // the chat's draft would let a plain Enter silently copy the preset prompt
        // into an override, so the draft is empty.
        expect(await readHarnessSystemPrompt('sess-prompt')).toBe('');
        // Exactly the entry resolve and the provenance row — no instruction read.
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            `GET ${ROOT}/sessions/sess-prompt/definition`,
            `GET ${ROOT}/sessions/sess-prompt/agents`
        ]);

        vi.unstubAllGlobals();
        calls.length = 0;
        installFetch([
            { match: (url: string) => url === `${ROOT}/sessions/sess-prompt/definition`, reply: () => jsonResponse(200, { definition }) },
            { match: (url: string) => url === `${ROOT}/sessions/sess-prompt/agents`, reply: () => jsonResponse(200, roster(true)) },
            {
                match: (url: string) => url === `${ROOT}/sessions/sess-prompt/agents/instruct/instruction`,
                reply: () =>
                    jsonResponse(200, {
                        session_id: 'sess-prompt',
                        agent_id: 'instruct',
                        source: 'harness',
                        instruction: 'Answer in exactly one word.',
                        guidelines: [],
                        chars: 26
                    })
            }
        ]);

        expect(await readHarnessSystemPrompt('sess-prompt')).toBe('Answer in exactly one word.');
        // The entry agent is cached per session, so the second read does NOT re-dial
        // the definition: roster row, then the text of the member it names.
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            `GET ${ROOT}/sessions/sess-prompt/agents`,
            `GET ${ROOT}/sessions/sess-prompt/agents/instruct/instruction`
        ]);
    });

    it('names the entry agent among TWO Rank A members: neither rank nor roster position picks it', async () => {
        // R83, the multi-rank scenario the old code could not express: a harness may
        // hold ANY number of Rank A agents, and the entry — the member the prompt
        // editor addresses — may be any of them. Here BOTH members are Rank A and the
        // entry is the SECOND roster row, so every shortcut the retired model allowed
        // gives the wrong member:
        //   - `roster.agents.find(a => a.role === 'primary')` (the field is gone);
        //   - "the Rank A member" (both are);
        //   - "the first member of the roster" (that is `instruct`, and the entry is
        //     `reviewer` because the definition SAYS so).
        // Only the frozen definition's `entry` answers, so the instruction read must
        // address `reviewer` — the member that actually carries the override.
        const definition = {
            session_id: 'sess-two-a',
            name: 'chat',
            title: 'Chat',
            description: 'Plain one-on-one chat.',
            requires_endpoint: true,
            entry: 'reviewer',
            ranks: { instruct: 'A', reviewer: 'A' },
            agents: ['instruct', 'reviewer'],
            tools: [],
            builtin: true,
            definition_revision: 0,
            revision: 0,
            frozen_at: 1_780_000_000_000,
            source_revision: 0,
            current_revision: 0,
            current: true
        };

        const row = (agentId: string, override: boolean) => ({
            agent_id: agentId,
            profile: agentId,
            rank: 'A',
            origin: 'definition',
            model: 'local/basalt',
            inherited_model: 'local/basalt',
            instruction_source: override ? 'harness' : 'catalogue',
            instruction_chars: override ? 26 : 11,
            ...(override ? { has_instruction_override: true } : {}),
            editable: true,
            // The entry row is the non-detachable one (the server 409s an entry
            // detach) — an ENTRY rule, identical for a Rank A member either way.
            deletable: agentId !== 'reviewer',
            restorable: override,
            revision: override ? 1 : 0
        });

        installFetch([
            { match: (url: string) => url === `${ROOT}/sessions/sess-two-a/definition`, reply: () => jsonResponse(200, { definition }) },
            {
                match: (url: string) => url === `${ROOT}/sessions/sess-two-a/agents`,
                reply: () =>
                    jsonResponse(200, {
                        session_id: 'sess-two-a',
                        total: 2,
                        agents: [row('instruct', false), row('reviewer', true)],
                        revision: 1
                    })
            },
            {
                match: (url: string) => url === `${ROOT}/sessions/sess-two-a/agents/reviewer/instruction`,
                reply: () =>
                    jsonResponse(200, {
                        session_id: 'sess-two-a',
                        agent_id: 'reviewer',
                        source: 'harness',
                        instruction: 'Review in one sentence.',
                        guidelines: [],
                        chars: 21
                    })
            }
        ]);

        expect(await readHarnessSystemPrompt('sess-two-a')).toBe('Review in one sentence.');
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            `GET ${ROOT}/sessions/sess-two-a/definition`,
            `GET ${ROOT}/sessions/sess-two-a/agents`,
            `GET ${ROOT}/sessions/sess-two-a/agents/reviewer/instruction`
        ]);
    });

    // The frozen-definition row, spelled the way the contract spells it: `entry` is
    // the ROUTING member (any rank, any roster position) and the only field that
    // answers "which agent is this conversation's entry" — the id the answer fold
    // compares against `TurnSection.agent`.
    const definitionOf = (
        sessionId: string,
        entry: string,
        agents: string[],
        ranks: Record<string, string>
    ) => ({
        session_id: sessionId,
        name: 'chat',
        title: 'Chat',
        description: 'Plain one-on-one chat.',
        requires_endpoint: true,
        entry,
        ranks,
        agents,
        tools: [],
        builtin: true,
        definition_revision: 0,
        revision: 0,
        frozen_at: 1_780_000_000_000,
        source_revision: 0,
        current_revision: 0,
        current: true
    });

    it('persists ONLY the entry agent\'s prose: a parentless foreign lane never reaches the turn record', async () => {
        // R86: `readHarnessTurnText` is the PERSISTED-TEXT path — the stream's resync
        // target (`recoverTurn`) and the terminal settle of a receipt that is already
        // over (`services/provider.ts`), whose result is what the send flow writes into
        // the answer. It shares the fold with `textOfTurnDisplay`, so reviewer case B
        // used to be stored, not merely shown: the resync replaced the answer with
        // 'ROOT ANSWER. HELPER PROSE. '.
        const display = {
            turnId: 'turn-9',
            revision: 1,
            sections: [
                {
                    id: 's-root',
                    rank: 'A',
                    agent: 'instruct',
                    agentLabel: 'Instruct',
                    state: 'done',
                    nodes: [
                        { id: 'n-0', kind: 'reasoning', text: 'thinking' },
                        { id: 'n-1', kind: 'text', text: 'ROOT ANSWER. ' }
                    ]
                },
                {
                    // The lineage-less delegated lane (reviewer case B): root-shaped.
                    id: 's-lane',
                    rank: 'B',
                    agent: 'helper',
                    agentLabel: 'Helper',
                    state: 'done',
                    nodes: [{ id: 'n-2', kind: 'text', text: 'HELPER PROSE. ' }]
                },
                {
                    // A threadless `inline:<agent>` flow (reviewer case C): also
                    // parentless, also not the entry agent's prose.
                    id: 'inline:summarizer',
                    rank: 'B',
                    agent: 'summarizer',
                    agentLabel: 'Summarizer',
                    state: 'done',
                    nodes: [{ id: 'n-3', kind: 'text', text: 'INLINE PROSE. ' }]
                }
            ]
        };

        installFetch([
            {
                match: (url: string) => url === `${ROOT}/sessions/sess-fold/turns/turn-9/display`,
                reply: () => jsonResponse(200, { display })
            },
            {
                match: (url: string) => url === `${ROOT}/sessions/sess-fold/definition`,
                reply: () =>
                    jsonResponse(200, { definition: definitionOf('sess-fold', 'instruct', ['instruct', 'helper'], { instruct: 'A', helper: 'B' }) })
            }
        ]);

        expect(await readHarnessTurnText('sess-fold', 'turn-9')).toBe('ROOT ANSWER. ');
        // The DISPLAY first (it is the resource the turn scope streams), then the
        // cached entry resolve that interprets it.
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            `GET ${ROOT}/sessions/sess-fold/turns/turn-9/display`,
            `GET ${ROOT}/sessions/sess-fold/definition`
        ]);
    });

    it('folds from the entry agent when TWO members hold Rank A and the entry is the SECOND roster member', async () => {
        // R87, on the read that feeds both the answer and the persisted record: the
        // roster declares `instruct` FIRST and the frozen definition names
        // `reviewer` as the entry, and BOTH hold Rank A. A rank filter folds both
        // lanes; a "first member" rule folds `instruct`'s prose; only the stated entry
        // identity folds `reviewer`'s own flow — which is the whole point of resolving
        // the entry from the definition instead of guessing it.
        const display = {
            turnId: 'turn-10',
            revision: 1,
            sections: [
                {
                    id: 's-root',
                    rank: 'A',
                    agent: 'reviewer',
                    agentLabel: 'Reviewer',
                    state: 'done',
                    nodes: [{ id: 'n-1', kind: 'text', text: 'ENTRY ANSWER. ' }]
                },
                {
                    id: 's-lane',
                    rank: 'A',
                    agent: 'instruct',
                    agentLabel: 'Instruct',
                    state: 'done',
                    nodes: [{ id: 'n-2', kind: 'text', text: 'PEER PROSE. ' }]
                }
            ]
        };

        installFetch([
            {
                match: (url: string) => url === `${ROOT}/sessions/sess-two-a-fold/turns/turn-10/display`,
                reply: () => jsonResponse(200, { display })
            },
            {
                match: (url: string) => url === `${ROOT}/sessions/sess-two-a-fold/definition`,
                reply: () =>
                    jsonResponse(200, {
                        definition: definitionOf('sess-two-a-fold', 'reviewer', ['instruct', 'reviewer'], { instruct: 'A', reviewer: 'A' })
                    })
            }
        ]);

        expect(await readHarnessTurnText('sess-two-a-fold', 'turn-10')).toBe('ENTRY ANSWER. ');
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            `GET ${ROOT}/sessions/sess-two-a-fold/turns/turn-10/display`,
            `GET ${ROOT}/sessions/sess-two-a-fold/definition`
        ]);
    });

    it('treats a WHITESPACE-only entry as omitted, the way the harness accessor does', async () => {
        // R88: the harness's own browser accessor tests the declared entry with
        // `entry.trim().length > 0` (packages/underload/harness/src/frontend/contract.ts
        // :189-195 `entryOf`), so `entry: '   '` means "omitted — the first declared
        // agent". A bare `length > 0` here read the same row as a stated entry, so the
        // two accessors resolved DIFFERENT members for one session — and the answer
        // fold compares this id against `TurnSection.agent`, so the whitespace id would
        // have excluded the entry agent's own prose from the answer entirely.
        installFetch([
            {
                match: (url: string) => url === `${ROOT}/sessions/sess-blank-entry/definition`,
                reply: () =>
                    jsonResponse(200, { definition: definitionOf('sess-blank-entry', '   ', ['instruct', 'helper'], { instruct: 'A', helper: 'B' }) })
            }
        ]);

        expect(await entryAgentId('sess-blank-entry')).toBe('instruct');
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([`GET ${ROOT}/sessions/sess-blank-entry/definition`]);
    });
});

describe('the API root declaration', () => {
    it('defaults to the canonical relative root on this origin', () => {
        // No saved setting, no query, no Pages host: the harness client's own
        // fallback, which is what makes the packaged server and the dev proxy work
        // with zero configuration.
        expect(harnessApiRoot()).toBe(ROOT);
        expect(harnessApiRootSetting()).toBe('');
    });

    it('persists a declared root and says whether a reload is required', () => {
        expect(configureHarnessApiRoot('http://other.test:5181/v1/harness')).toEqual({
            saved: 'http://other.test:5181/v1/harness',
            effective: ROOT,
            reloadRequired: true
        });
        expect(harnessApiRootSetting()).toBe('http://other.test:5181/v1/harness');
        expect(window.localStorage.getItem('underload-harness-app:api-root')).toBe(
            'http://other.test:5181/v1/harness'
        );

        // Clearing returns the page to the automatic root, and the CURRENT page
        // already dials it, so no reload is claimed.
        expect(configureHarnessApiRoot('')).toEqual({ saved: '', effective: ROOT, reloadRequired: false });
        expect(harnessApiRootSetting()).toBe('');
    });

    it('normalizes a trailing slash before storing it', () => {
        configureHarnessApiRoot('/v1/harness/');

        expect(harnessApiRootSetting()).toBe(ROOT);
    });
});
