// Chat TRANSCRIPT plugin tests: the per-turn flows.
//
// Headless, no render: `createTestChat()` builds the real composition, `fetch` is the
// harness mini-server in ./harness.ts, and that server behaves like the contract: a
// transcript-document PUT persists the sent history verbatim and the following canonical
// multi-read (session + thread roster + transcript + usage) answers it. That is what
// makes the assertions exact: the transcript a test sees is the record the STORE read
// back, so the sent body is the only place a rewrite rule can be pinned.
//
// WHAT THE NEW WIRE CHANGES FOR THESE CASES: a harness transcript message is
// `{role, content}` only (src/api/harness.ts:217-220), so the per-message producing-model
// attribution the OLD storage row carried does not survive an online round-trip; the
// online assertions below state that explicitly instead of asserting the offline shape.
// Forking has no harness route at all (parity issue 0005), so the three fork cases run
// the OFFLINE store, where the feature is preserved, and one extra case pins the online
// refusal. See ../../../../MISSING-FEATURES.md.
//
// Every expectation comes from the ported oracle (components/ChatAssistantApp.tsx):
//   copy   :3649-3678   fork   :3680-3737   role :1966-1980, :3603-3647
//   delete :3559-3601   update :3818-3853   turn :4272-4280
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { upsertLocalConversation } from '../../api/offline';
import type { Dashboard } from '@underload/dashboard';
import {
    CHAT_ACTIVE_SESSION_STATE,
    CHAT_AUTOSCROLL_STATE,
    CHAT_AUTOSCROLL_TOGGLE_COMMAND,
    CHAT_CELLS_SERVICE,
    CHAT_COLLAPSED_TURNS_STATE,
    CHAT_COMPOSER_FOCUS_COMMAND,
    CHAT_EDITING_INDEX_STATE,
    CHAT_ERROR_EVENT,
    CHAT_ERROR_STATE,
    CHAT_MESSAGE_COPY_COMMAND,
    CHAT_MESSAGE_DELETE_COMMAND,
    CHAT_MESSAGE_FORK_COMMAND,
    CHAT_MESSAGE_ROLE_COMMAND,
    CHAT_MESSAGE_UPDATE_COMMAND,
    CHAT_MODEL_STATE,
    CHAT_NOTICE_EVENT,
    CHAT_SESSION_CREATED_EVENT,
    CHAT_SESSION_SELECTED_EVENT,
    CHAT_SESSIONS_STATE,
    CHAT_SESSION_SELECT_COMMAND,
    CHAT_STATUS_STATE,
    CHAT_SYSTEM_DRAFT_STATE,
    CHAT_TRANSCRIPT_STATE,
    CHAT_TRANSCRIPT_UPDATED_EVENT,
    CHAT_TURN_TOGGLE_COMMAND,
    CHAT_TURNS_STATE,
    type ChatCells,
    type ChatSession,
    type ChatTranscript,
    type ChatTurn,
    type NoticeEvent,
    type SessionCreatedEvent,
    type SessionSelectedEvent,
    type TranscriptUpdatedEvent
} from '../contract';
import {
    jsonResponse,
    installHarness,
    seedSettings,
    payloadsOf,
    recordEvents,
    recordFixture,
    readTrackedIds,
    resetStorage,
    createTestChat,
    OFFLINE_STORAGE_KEY,
    seedTrackedIds,
    summaryFixture,
    TEST_BASE_URL,
    TEST_HARNESS_ROOT,
    TEST_PROVIDER_URL,
    type FetchCall,
    type FetchDouble
} from './harness';

const PROVIDER_MODELS = `${TEST_PROVIDER_URL}/models`;

/** The catalog every case answers, so the model cell is never empty by accident. */
const catalogRoute = {
    match: (url: string) => url === PROVIDER_MODELS,
    reply: () =>
        jsonResponse(200, { object: 'list', data: [{ id: 'alpha/flash' }, { id: 'zeta/turbo' }] })
};

/**
 * The open conversation, with a leading system block so the "system turns are
 * immutable through these controls" guards are reachable.
 */
const SOURCE_RECORD = recordFixture('conv-1', {
    title: 'Hello assistant',
    model: 'alpha/flash',
    messages: [
        { role: 'system', content: 'Answer briefly' },
        { role: 'user', content: 'Hello assistant' },
        { role: 'assistant', content: 'Hello user', model: 'test/model' }
    ]
});

/** What the server derives from a replaced history: the sent messages, verbatim. */
type PutBody = { messages?: Array<{ role: string; content: string; model?: string }> };

let instance: Dashboard | null = null;
let double: FetchDouble | null = null;

beforeEach(() => {
    resetStorage();
});

afterEach(() => {
    instance?.dispose();
    instance = null;
    double = null;
    // the clipboard seams are stubbed per-case; never leak them into the next one
    delete (document as any).execCommand;
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
});

/**
 * Boot the composition with a live store for SOURCE_RECORD and open it.
 *
 * `onPut` lets a case answer the write with something other than the echo (a rejection,
 * a re-derived record); by default the store behaves exactly like the server: the sent
 * history becomes the canonical record, so the following GET proves what landed.
 */
async function openConversation(
    options: {
        /** The record the server (online) or the browser (offline) already holds. */
        record?: ReturnType<typeof recordFixture>;
        /** Refuse the transcript-document PUT for this conversation. */
        writeError?: { status: number; message: string };
        /** Hold the transcript-document PUT open until the returned promise settles. */
        writeGate?: () => Promise<void>;
        /** 'online' is the default; 'offline' runs the browser-local store. */
        mode?: 'online' | 'offline';
        select?: boolean;
    } = {}
): Promise<{ instance: Dashboard; double: FetchDouble; cells: ChatCells }> {
    const base = options.record ?? SOURCE_RECORD;
    const mode = options.mode ?? 'online';

    seedTrackedIds([base.conversationId]);

    let fetchDouble: FetchDouble;

    if (mode === 'offline') {
        // The fork cases need the browser-local store, which has NO network seam, so
        // a no-op double keeps the call assertions meaningful ('nothing was sent')
        // instead of undefined.
        seedSettings('offline');
        upsertLocalConversation(base);
        fetchDouble = installHarness({ records: [] });
    } else {
        fetchDouble = installHarness({
            records: [base],
            ...(options.writeError === undefined
                ? {}
                : { writeErrors: { [base.conversationId]: options.writeError } }),
            ...(options.writeGate === undefined ? {} : { writeGate: () => options.writeGate!() })
        });
    }

    const chat = createTestChat();

    // the module-level handle is what the cases reset/assert on, so keep them in step
    double = fetchDouble;
    if (options.select !== false) {
        await chat.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, base.conversationId);
    }
    return { instance: chat, double: fetchDouble, cells: chat.service<ChatCells>(CHAT_CELLS_SERVICE) };
}

// ——— the new wire, in the words these cases need ——————————————————————————————————————

/** One history write: the transcript document of the conversation's single thread. */
const TRANSCRIPT_WRITE = `${TEST_HARNESS_ROOT}/sessions/conv-1/threads/thread-1/transcript`;

/** The transcript-document PUTs the client issued since the last reset. */
const historyWrites = (): FetchCall[] =>
    double!.callsFor(TRANSCRIPT_WRITE).filter((call) => call.method === 'PUT');

/**
 * Assert the ONE history rewrite the client put on the wire: `{role, content}` pairs
 * (a harness transcript message has no other field) plus the optimistic `if_revision`
 * the client read from the same document (src/api/harness.ts:642-655). The document the
 * double serves carries revision 1, so that number is part of every expectation below.
 */
const expectHistoryWrite = (messages: Array<{ role: string; content: string }>): void => {
    expect(historyWrites()).toEqual([
        { url: TRANSCRIPT_WRITE, method: 'PUT', body: { messages, if_revision: 1 } }
    ]);
};

/**
 * The full call sequence ONE online history rewrite makes: read the thread roster and
 * the document revision, replace the document, then re-read canonically (session,
 * roster, transcript, usage). A re-ordered or missing leg of that sequence is a real
 * regression, so the cases pin it by name.
 */
const REWRITE_SEQUENCE = [
    'GET /v1/harness/sessions/conv-1/threads',
    'GET /v1/harness/sessions/conv-1/threads/thread-1/transcript/messages',
    'PUT /v1/harness/sessions/conv-1/threads/thread-1/transcript',
    'GET /v1/harness/sessions/conv-1',
    'GET /v1/harness/sessions/conv-1/threads',
    'GET /v1/harness/sessions/conv-1/threads/thread-1/transcript/messages',
    'GET /v1/harness/sessions/conv-1/usage'
];

/**
 * The sequence WITHOUT the per-session tool read.
 *
 * The tools plugin refreshes the open conversation's registrations as the record moves
 * (src/dashboard/plugins/tools.ts:198 `readHarnessSessionTools`), and that refresh is a
 * CONCURRENT read: it is not part of the store's write contract, and its position in the
 * log depends on which promise the microtask queue settles first. Pinning it by position
 * would make the case flaky without pinning anything true, so the sequence below filters
 * it out and the cases that care about it assert its count separately.
 */
const rewriteSequence = (): string[] => callSequence().filter((call) => !call.endsWith('/tools'));

/** `METHOD path` for every call since the last reset, query string dropped. */
const callSequence = (): string[] =>
    double!.calls().map(
        (call) => `${call.method} ${call.url.split('?')[0]}`
    );

/**
 * The transcript the ONLINE store reports for SOURCE_RECORD: the same turns minus the
 * per-message model attribution the harness transcript document has no field for.
 */
const onlineMessages = (record: ReturnType<typeof recordFixture>) =>
    record.messages.map(({ role, content }) => ({ role, content }));

// ——— copy ————————————————————————————————————————————————————————————————————————————

describe('chat.transcript — copy', () => {
    /**
     * jsdom has no clipboard, so the textarea + `execCommand('copy')` fallback is what
     * runs. The stub reads the scratch textarea while it is still mounted: the value in
     * it IS the copy payload, so an off-by-one in the turn lookup fails loudly.
     */
    const stubFallbackCopy = (reply = true): string[] => {
        const copied: string[] = [];
        Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
        (document as any).execCommand = (command: string) => {
            if (command !== 'copy') return false;
            const scratch = document.querySelector('textarea');
            if (!reply) throw new Error('Copy blocked');
            copied.push(scratch?.value ?? '');
            return true;
        };
        return copied;
    };

    it('copies the raw text of one turn and removes the scratch node', async () => {
        const copied = stubFallbackCopy();
        const { instance: chat } = await openConversation();

        chat.execute<number, void>(CHAT_MESSAGE_COPY_COMMAND, 2);

        await vi.waitFor(() => expect(copied).toEqual(['Hello user']));
        // the fallback cleans its scratch element up on the same tick it copies
        expect(document.querySelector('textarea')).toBeNull();
        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe('');
    });

    it('copies the system-prompt draft at the -1 sentinel', async () => {
        const copied = stubFallbackCopy();
        const { instance: chat, cells } = await openConversation();
        // the draft turn is not part of `chat.turns`; its text lives in chat.systemDraft
        expect(chat.state<readonly unknown[]>(CHAT_TURNS_STATE).get()).toHaveLength(3);

        cells.systemDraft.set('Speak like a pirate');
        chat.execute<number, void>(CHAT_MESSAGE_COPY_COMMAND, -1);

        await vi.waitFor(() => expect(copied).toEqual(['Speak like a pirate']));
    });

    it('reports a rejected copy in chat.error and emits chat.error', async () => {
        const copied = stubFallbackCopy(false);
        const chat = (await openConversation()).instance;
        const events = recordEvents(chat, [CHAT_ERROR_EVENT]);

        chat.execute<number, void>(CHAT_MESSAGE_COPY_COMMAND, 1);

        await vi.waitFor(() =>
            expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe('Copy blocked')
        );
        expect(payloadsOf(events, CHAT_ERROR_EVENT)).toEqual([
            { message: 'Copy blocked' } satisfies NoticeEvent
        ]);
        expect(copied).toEqual([]);
    });

    it('copies an out-of-range turn as empty text instead of throwing', async () => {
        const copied = stubFallbackCopy();
        const { instance: chat } = await openConversation();

        chat.execute<number, void>(CHAT_MESSAGE_COPY_COMMAND, 9);

        await vi.waitFor(() => expect(copied).toEqual(['']));
        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe('');
    });
});

// ——— role switch —————————————————————————————————————————————————————————————————————

describe('chat.transcript — role switch', () => {
    it('assistant -> user drops the storage-only model attribution', async () => {
        const { instance: chat } = await openConversation();
        double!.reset();
        const events = recordEvents(chat, [CHAT_TRANSCRIPT_UPDATED_EVENT]);

        await chat.execute<{ index: number; role: 'user' }, Promise<void>>(
            CHAT_MESSAGE_ROLE_COMMAND,
            { index: 2, role: 'user' }
        );

        // The whole history round-trips through the thread's transcript DOCUMENT, and the
        // reply's producing-model label is assistant metadata: it is dropped, not carried.
        // Online the document has no per-message model field at all (header note), so the
        // sent messages are `{role, content}` pairs and nothing else.
        expectHistoryWrite([
            { role: 'system', content: 'Answer briefly' },
            { role: 'user', content: 'Hello assistant' },
            { role: 'user', content: 'Hello user' }
        ]);
        // One rewrite is one documented call sequence: roster, revision read, document PUT,
        // then the canonical multi-read. Anything else re-orders the contract.
        expect(rewriteSequence()).toEqual(REWRITE_SEQUENCE);
        // The concurrent tool refresh is a leg of its own flow, not of this one: exactly
        // one read of THIS session's registrations, however it interleaves.
        expect(double!.callsFor('/sessions/conv-1/tools')).toHaveLength(1);
        // the surface adopts the CANONICAL record, and the collapse defaults re-seed:
        // with no assistant reply left, every turn folds
        expect(chat.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get()).toEqual([
            { role: 'system', content: 'Answer briefly' },
            { role: 'user', content: 'Hello assistant' },
            { role: 'user', content: 'Hello user' }
        ]);
        expect(chat.state<readonly number[]>(CHAT_COLLAPSED_TURNS_STATE).get()).toEqual([0, 1, 2]);
        expect(chat.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
        expect(payloadsOf(events, CHAT_TRANSCRIPT_UPDATED_EVENT)).toEqual([
            { sessionId: 'conv-1', turnCount: 3 } satisfies TranscriptUpdatedEvent
        ]);
    });

    it('user -> assistant stamps the currently selected model', async () => {
        const { instance: chat, cells } = await openConversation();
        // the label a hand-swapped turn carries is the live selection, exactly like the
        // model a streamed reply would record
        cells.model.set('zeta/turbo');
        double!.reset();

        await chat.execute<{ index: number; role: 'assistant' }, Promise<void>>(
            CHAT_MESSAGE_ROLE_COMMAND,
            { index: 1, role: 'assistant' }
        );

        // The role switch is on the wire; the model is NOT, because the harness transcript
        // document carries no per-message attribution. The live selection survives the
        // canonical re-read untouched, which is the part that still matters online.
        expectHistoryWrite([
            { role: 'system', content: 'Answer briefly' },
            { role: 'assistant', content: 'Hello assistant' },
            { role: 'assistant', content: 'Hello user' }
        ]);
        expect(chat.state<string>(CHAT_MODEL_STATE).get()).toBe('zeta/turbo');
        // Online the turn labels come from the document, so no turn carries the swapped-in
        // model; the sidebar row's model is the SESSION model, which a role switch leaves
        // alone (src/api/harness.ts:217-220).
        expect(chat.state<readonly ChatTurn[]>(CHAT_TURNS_STATE).get().map((turn) => turn.model)).toEqual([
            '',
            '',
            ''
        ]);
    });

    it('sends nothing for a system turn, an unknown row or the role it already has', async () => {
        const { instance: chat } = await openConversation();
        double!.reset();

        await chat.execute<{ index: number; role: 'user' }, Promise<void>>(
            CHAT_MESSAGE_ROLE_COMMAND,
            { index: 0, role: 'user' }
        );
        await chat.execute<{ index: number; role: 'user' }, Promise<void>>(
            CHAT_MESSAGE_ROLE_COMMAND,
            { index: 9, role: 'user' }
        );
        await chat.execute<{ index: number; role: 'assistant' }, Promise<void>>(
            CHAT_MESSAGE_ROLE_COMMAND,
            { index: 2, role: 'assistant' }
        );

        expect(double!.calls()).toEqual([]);
        // The online projection of the same record: no per-message model (header note).
        expect(chat.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get()).toEqual(
            onlineMessages(SOURCE_RECORD)
        );
        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe('');
    });

    it('leaves the surface untouched when the store rejects the rewrite', async () => {
        // The refusal is the harness envelope: `{error:{message}}` (src/api/harness.ts
        // reads `error.message` and the plugin reports it verbatim).
        const { instance: chat } = await openConversation({
            writeError: { status: 500, message: 'Storage is down' }
        });
        double!.reset();
        const events = recordEvents(chat, [CHAT_ERROR_EVENT]);

        await chat.execute<{ index: number; role: 'user' }, Promise<void>>(
            CHAT_MESSAGE_ROLE_COMMAND,
            { index: 2, role: 'user' }
        );

        expect(payloadsOf(events, CHAT_ERROR_EVENT)).toEqual([
            { message: 'Storage is down' }
        ]);
        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe('Storage is down');
        expect(chat.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get()).toEqual(
            onlineMessages(SOURCE_RECORD)
        );
        // The PUT was attempted and refused — the write legs of the sequence, nothing after.
        expect(rewriteSequence()).toEqual(REWRITE_SEQUENCE.slice(0, 3));
        expect(chat.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
    });

    it('drops the switch while another save owns the surface', async () => {
        // `savingEdit` in the oracle: a second history write never overlaps the first
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { instance: chat } = await openConversation({
            // The document PUT is held open by the double, so the second command really
            // does arrive while the first write owns the surface.
            writeGate: () => gate
        });
        double!.reset();

        const first = chat.execute<{ index: number; role: 'user' }, Promise<void>>(
            CHAT_MESSAGE_ROLE_COMMAND,
            { index: 2, role: 'user' }
        );
        expect(chat.state<string>(CHAT_STATUS_STATE).get()).toBe('saving');
        const second = chat.execute<number, Promise<void>>(CHAT_MESSAGE_DELETE_COMMAND, 1);

        await second;
        release();
        await first;

        expect(historyWrites()).toHaveLength(1);
        expect(chat.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
        expect(chat.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get()).toEqual([
            { role: 'system', content: 'Answer briefly' },
            { role: 'user', content: 'Hello assistant' },
            { role: 'user', content: 'Hello user' }
        ]);
    });
});

// ——— delete ————————————————————————————————————————————————————————————————————————————

describe('chat.transcript — delete', () => {
    it('removes one turn and re-derives the collapse defaults', async () => {
        const { instance: chat } = await openConversation();
        double!.reset();
        const events = recordEvents(chat, [CHAT_TRANSCRIPT_UPDATED_EVENT]);

        await chat.execute<number, Promise<void>>(CHAT_MESSAGE_DELETE_COMMAND, 1);

        expectHistoryWrite([
            { role: 'system', content: 'Answer briefly' },
            { role: 'assistant', content: 'Hello user' }
        ]);
        // The surviving reply's attribution is gone online: the turn label falls back to
        // the role because the transcript document has no model field (header note).
        const turns = chat.state<readonly ChatTurn[]>(CHAT_TURNS_STATE).get();
        expect(turns.map((turn) => [turn.index, turn.role, turn.collapsed, turn.model])).toEqual([
            [0, 'system', true, ''],
            [1, 'assistant', false, '']
        ]);
        expect(payloadsOf(events, CHAT_TRANSCRIPT_UPDATED_EVENT)).toEqual([
            { sessionId: 'conv-1', turnCount: 2 }
        ]);
    });

    it('never issues a request for a system turn', async () => {
        const { instance: chat } = await openConversation();
        double!.reset();

        await chat.execute<number, Promise<void>>(CHAT_MESSAGE_DELETE_COMMAND, 0);

        expect(double!.calls()).toEqual([]);
        expect(chat.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get()).toEqual(
            onlineMessages(SOURCE_RECORD)
        );
    });
});

// ——— inline edit commit —————————————————————————————————————————————————————————————————

describe('chat.transcript — update', () => {
    it('commits edited content through the whole-history PUT and closes the editor', async () => {
        const { instance: chat, cells } = await openConversation();
        cells.editingIndex.set(2);
        double!.reset();
        const events = recordEvents(chat, [CHAT_TRANSCRIPT_UPDATED_EVENT]);

        await chat.execute<{ index: number; content: string }, Promise<void>>(
            CHAT_MESSAGE_UPDATE_COMMAND,
            { index: 2, content: '  Goodbye user  ' }
        );

        // Only `content` changes: the roles survive. The producing-model attribution is
        // not on the online wire at all, which is why the body below has no model field.
        expectHistoryWrite([
            { role: 'system', content: 'Answer briefly' },
            { role: 'user', content: 'Hello assistant' },
            { role: 'assistant', content: 'Goodbye user' }
        ]);
        expect(rewriteSequence()).toEqual(REWRITE_SEQUENCE);
        expect(chat.state<number | null>(CHAT_EDITING_INDEX_STATE).get()).toBeNull();
        expect(payloadsOf(events, CHAT_TRANSCRIPT_UPDATED_EVENT)).toEqual([
            { sessionId: 'conv-1', turnCount: 3 }
        ]);
    });

    it('closes the editor without a request for unchanged or blank text', async () => {
        const { instance: chat, cells } = await openConversation();

        cells.editingIndex.set(2);
        await chat.execute<{ index: number; content: string }, Promise<void>>(
            CHAT_MESSAGE_UPDATE_COMMAND,
            { index: 2, content: 'Hello user' }
        );
        cells.editingIndex.set(2);
        await chat.execute<{ index: number; content: string }, Promise<void>>(
            CHAT_MESSAGE_UPDATE_COMMAND,
            { index: 2, content: '   ' }
        );

        // empty messages are forbidden server-side, so a blank close is client-only
        expect(historyWrites()).toEqual([]);
        expect(chat.state<number | null>(CHAT_EDITING_INDEX_STATE).get()).toBeNull();
        expect(chat.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get()).toEqual(
            onlineMessages(SOURCE_RECORD)
        );
    });

    it('ignores an update addressed to a row that is not there', async () => {
        const { instance: chat } = await openConversation();
        double!.reset();

        await chat.execute<{ index: number; content: string }, Promise<void>>(
            CHAT_MESSAGE_UPDATE_COMMAND,
            { index: 9, content: 'Changed' }
        );

        expect(double!.calls()).toEqual([]);
    });

    it('closes the editor even when the commit fails', async () => {
        const { instance: chat, cells } = await openConversation({
            writeError: { status: 409, message: 'Read-only transcript' }
        });
        cells.editingIndex.set(2);

        await chat.execute<{ index: number; content: string }, Promise<void>>(
            CHAT_MESSAGE_UPDATE_COMMAND,
            { index: 2, content: 'Goodbye user' }
        );

        // the commit belongs to the surface that made it, so the editor closes first
        expect(chat.state<number | null>(CHAT_EDITING_INDEX_STATE).get()).toBeNull();
        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe('Read-only transcript');
        expect(chat.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get()).toEqual(
            onlineMessages(SOURCE_RECORD)
        );
    });

    it('needs no conversation on the new-chat surface', async () => {
        const { instance: chat } = await openConversation({ select: false });
        expect(chat.state<string | null>(CHAT_ACTIVE_SESSION_STATE).get()).toBeNull();
        double!.reset();

        await chat.execute<{ index: number; content: string }, Promise<void>>(
            CHAT_MESSAGE_UPDATE_COMMAND,
            { index: 0, content: 'Changed' }
        );

        expect(double!.calls()).toEqual([]);
    });
});

// ——— fork ————————————————————————————————————————————————————————————————————————————————

describe('chat.transcript — fork', () => {
    const FORK_RECORD = recordFixture('conv-fork', {
        title: 'Hello assistant',
        model: 'alpha/flash',
        messages: [
            { role: 'system', content: 'Answer briefly' },
            { role: 'user', content: 'Hello assistant' }
        ]
    });

    /**
     * Boot a store that can own the fork branch and open the source conversation.
     *
     * FORK IS AN OFFLINE FEATURE (src/dashboard/plugins/transcript.ts:299-315): a harness
     * session is created empty and the contract has no route to seed a history into a new
     * one, so the branch cases run the browser-local store — the feature these assertions
     * describe still exists there — while one case pins the ONLINE refusal. The offline
     * store hands out uuids, so `crypto.randomUUID` is pinned to the readable id the
     * expectations use.
     */
    async function openForkable(options: { mode?: 'online' | 'offline' } = {}) {
        const mode = options.mode ?? 'offline';

        seedTrackedIds(['conv-1']);

        if (mode === 'offline') {
            seedSettings('offline');
            upsertLocalConversation(SOURCE_RECORD);
            // The declared type of the seam is a uuid TEMPLATE literal; the readable id
            // is what the assertions use, so it is widened through the seam's own return
            // type rather than through `any` (same shape as integration.test.tsx).
            vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
                () => 'conv-fork' as ReturnType<typeof globalThis.crypto.randomUUID>
            );
        }

        const fetchDouble = installHarness({
            records: mode === 'offline' ? [] : [SOURCE_RECORD, FORK_RECORD]
        });
        const chat = createTestChat();

        await chat.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, 'conv-1');

        return { instance: chat, double: fetchDouble };
    }

    /** The ids the browser-local store holds, in the order the sidebar lists them. */
    const localRecordIds = (): string[] => {
        const raw = window.localStorage.getItem(OFFLINE_STORAGE_KEY);

        return raw === null ? [] : Object.keys(JSON.parse(raw) as Record<string, unknown>);
    };

    it('copies an inclusive branch, tracks it and selects the new conversation', async () => {
        const { instance: chat, double: fetchDouble } = await openForkable();
        fetchDouble.reset();
        const events = recordEvents(chat, [
            CHAT_SESSION_CREATED_EVENT,
            CHAT_SESSION_SELECTED_EVENT,
            CHAT_TRANSCRIPT_UPDATED_EVENT,
            CHAT_NOTICE_EVENT
        ]);

        const forkedId = await chat.execute<number, Promise<string | null>>(
            CHAT_MESSAGE_FORK_COMMAND,
            1
        );

        expect(forkedId).toBe('conv-fork');
        // The selected index is INCLUSIVE: the fork carries the prompt and the question,
        // and the source record is never rewritten. Offline the branch is written straight
        // into the browser's map, so the evidence is the map plus an EMPTY request log —
        // "nothing went to the server" is the assertion that replaces the old POST body.
        expect(fetchDouble.calls()).toEqual([]);
        expect(localRecordIds()).toEqual(['conv-1', 'conv-fork']);
        const branch = JSON.parse(
            String(window.localStorage.getItem(OFFLINE_STORAGE_KEY))
        ) as Record<string, { messages: unknown[]; model: string }>;

        expect(branch['conv-fork'].messages).toEqual(FORK_RECORD.messages);
        expect(branch['conv-fork'].model).toBe('alpha/flash');
        // the branch is tracked before the read-back, so a reload mid-flow keeps it
        expect(readTrackedIds()).toEqual(['conv-1', 'conv-fork']);
        expect(chat.state<string | null>(CHAT_ACTIVE_SESSION_STATE).get()).toBe('conv-fork');
        expect(chat.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get()).toEqual(
            FORK_RECORD.messages
        );
        expect(chat.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get().map((row) => row.conversationId)).toEqual([
            'conv-fork',
            'conv-1'
        ]);
        expect(chat.state<readonly number[]>(CHAT_COLLAPSED_TURNS_STATE).get()).toEqual([0, 1]);
        expect(chat.state<string>(CHAT_MODEL_STATE).get()).toBe('alpha/flash');
        expect(chat.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
        expect(payloadsOf(events, CHAT_SESSION_CREATED_EVENT)).toEqual([
            { sessionId: 'conv-fork', title: 'Hello assistant' } satisfies SessionCreatedEvent
        ]);
        expect(payloadsOf(events, CHAT_SESSION_SELECTED_EVENT)).toEqual([
            { sessionId: 'conv-fork' } satisfies SessionSelectedEvent
        ]);
        expect(payloadsOf(events, CHAT_TRANSCRIPT_UPDATED_EVENT)).toEqual([
            { sessionId: 'conv-fork', turnCount: 2 }
        ]);
        expect(payloadsOf(events, CHAT_NOTICE_EVENT)).toEqual([
            { message: 'Forked 2 messages into a new conversation.' }
        ]);
    });

    it('refuses to fork a system turn', async () => {
        const { instance: chat, double: fetchDouble } = await openForkable();
        fetchDouble.reset();

        const refused = await chat.execute<number, Promise<string | null>>(
            CHAT_MESSAGE_FORK_COMMAND,
            0
        );

        // the leading prompt block comes with the prefix anyway (:3695)
        expect(refused).toBeNull();
        expect(fetchDouble.calls()).toEqual([]);
        expect(chat.state<string | null>(CHAT_ACTIVE_SESSION_STATE).get()).toBe('conv-1');
        expect(chat.state<readonly unknown[]>(CHAT_TRANSCRIPT_STATE).get()).toHaveLength(3);
    });

    it('forks nothing on the new-chat surface', async () => {
        // no open conversation means no branch to copy, and nothing is written anywhere
        seedSettings('offline');
        seedTrackedIds([]);
        const fetchDouble = installHarness({ records: [] });
        const chat = createTestChat();

        // The offline boot issues no request at all (the listing is a localStorage read).
        // The listing IS still deferred one microtask (plugins/sessions.ts), so the case
        // waits for that settle before clearing the log: 'idle' is the settle signal.
        await vi.waitFor(() => expect(chat.state<string>(CHAT_STATUS_STATE).get()).toBe('idle'));
        expect(chat.state<string | null>(CHAT_ACTIVE_SESSION_STATE).get()).toBeNull();
        fetchDouble.reset();

        const forked = await chat.execute<number, Promise<string | null>>(
            CHAT_MESSAGE_FORK_COMMAND,
            1
        );

        expect(forked).toBeNull();
        expect(fetchDouble.calls()).toEqual([]);
        expect(localRecordIds()).toEqual([]);
        // The refused fork changed nothing. The busy label is the sessions plugin's
        // listing label, and that listing is deferred one microtask AFTER setup, so the
        // first 'idle' a test sees can be the pre-flight one: waiting here is waiting for
        // the boot listing to FINISH (it settles to 'idle' and stays there), which is the
        // honest form of "a no-op fork left the surface alone".
        await vi.waitFor(() => expect(chat.state<string>(CHAT_STATUS_STATE).get()).toBe('idle'));
        expect(chat.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get()).toEqual([]);
    });

    it('refuses to fork online, says why, and keeps the source conversation open', async () => {
        // The removed capability (see the header note and ../../../../MISSING-FEATURES.md)
        // is pinned rather than dropped: an online fork must NOT quietly create an empty
        // session, and the reason belongs on the notice strip, not in the error banner.
        const { instance: chat, double: fetchDouble } = await openForkable({ mode: 'online' });
        fetchDouble.reset();
        const events = recordEvents(chat, [CHAT_NOTICE_EVENT, CHAT_ERROR_EVENT, CHAT_SESSION_CREATED_EVENT]);

        const forked = await chat.execute<number, Promise<string | null>>(
            CHAT_MESSAGE_FORK_COMMAND,
            1
        );

        expect(forked).toBeNull();
        expect(payloadsOf(events, CHAT_NOTICE_EVENT)).toEqual([
            {
                message:
                    'Fork is not available online: the harness server cannot seed a new conversation from an existing history.'
            } satisfies NoticeEvent
        ]);
        // A capability gap is not a failed request: no error banner, and no session POST.
        expect(payloadsOf(events, CHAT_ERROR_EVENT)).toEqual([]);
        expect(payloadsOf(events, CHAT_SESSION_CREATED_EVENT)).toEqual([]);
        expect(fetchDouble.calls()).toEqual([]);
        expect(chat.state<string | null>(CHAT_ACTIVE_SESSION_STATE).get()).toBe('conv-1');
        expect(chat.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get().map((row) => row.conversationId)).toEqual([
            'conv-1'
        ]);
        expect(chat.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
        // the refused branch was never tracked, so a reload does not resurrect it
        expect(readTrackedIds()).toEqual(['conv-1']);
    });
});


// ——— pure view-state commands ——————————————————————————————————————————————————————————

describe('chat.transcript — collapse, autoscroll and focus', () => {
    it('folds and unfolds one turn without mutating the previous set', async () => {
        const { instance: chat } = await openConversation();
        const before = chat.state<readonly number[]>(CHAT_COLLAPSED_TURNS_STATE).get();
        expect(before).toEqual([0, 1]);

        chat.execute<number, void>(CHAT_TURN_TOGGLE_COMMAND, 1);
        expect(chat.state<readonly number[]>(CHAT_COLLAPSED_TURNS_STATE).get()).toEqual([0]);
        // the old snapshot is untouched: `chat.turns` is reference-compared, so an
        // in-place mutation would silently skip a re-render
        expect(before).toEqual([0, 1]);

        chat.execute<number, void>(CHAT_TURN_TOGGLE_COMMAND, 2);
        expect(chat.state<readonly number[]>(CHAT_COLLAPSED_TURNS_STATE).get()).toEqual([0, 2]);

        chat.execute<number, void>(CHAT_TURN_TOGGLE_COMMAND, 0);
        expect(chat.state<readonly number[]>(CHAT_COLLAPSED_TURNS_STATE).get()).toEqual([2]);

        // -1 is the system-prompt DRAFT row's sentinel and sorts first
        chat.execute<number, void>(CHAT_TURN_TOGGLE_COMMAND, -1);
        expect(chat.state<readonly number[]>(CHAT_COLLAPSED_TURNS_STATE).get()).toEqual([-1, 2]);

        chat.execute<number, void>(CHAT_TURN_TOGGLE_COMMAND, Number.NaN);
        expect(chat.state<readonly number[]>(CHAT_COLLAPSED_TURNS_STATE).get()).toEqual([-1, 2]);

        expect(double!.calls().filter((call) => call.method === 'PUT')).toEqual([]);
    });

    it('toggles autoscroll and hands the new value back', async () => {
        const chat = createTestChat();
        const initial = chat.state<boolean>(CHAT_AUTOSCROLL_STATE).get();

        const first = chat.execute<void, boolean>(CHAT_AUTOSCROLL_TOGGLE_COMMAND);
        expect(first).toBe(!initial);
        expect(chat.state<boolean>(CHAT_AUTOSCROLL_STATE).get()).toBe(!initial);

        const second = chat.execute<void, boolean>(CHAT_AUTOSCROLL_TOGGLE_COMMAND);
        expect(second).toBe(initial);
    });

    it('focuses the composer input when its owner has rendered it', () => {
        const chat = createTestChat();
        const input = document.createElement('textarea');
        input.setAttribute('data-testid', 'composer-input');
        document.body.appendChild(input);

        chat.execute<void, void>(CHAT_COMPOSER_FOCUS_COMMAND);
        expect(document.activeElement).toBe(input);
    });

    it('does nothing when no composer input exists', () => {
        const chat = createTestChat();
        const before = document.activeElement;

        chat.execute<void, void>(CHAT_COMPOSER_FOCUS_COMMAND);
        expect(document.activeElement).toBe(before);
    });
});
