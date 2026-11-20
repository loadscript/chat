// Typed harness API client — the ONLY place this package touches
// `@loadscript/harness`.
//
// WHAT THIS FILE IS (R1/R2): a thin wrapper around the harness package's public
// browser client. Every request goes through that package's own exported REST
// functions (`createSession`, `submitTask`, `listTranscriptMessages`, ...);
// nothing here re-implements a fetch, a URL join, an error envelope or a paging
// helper — the harness client owns all of those (its `requestResource` sends
// `X-Harness-Client: ui`, parses the `{error:{message}}` envelope, and stamps
// the epoch/revision headers). What THIS layer adds is exactly two things:
//
//   1. the projection from the harness WIRE vocabulary (snake_case resources:
//      `SessionSummary`, `TaskReceipt`, `HarnessMessage`, `HarnessUsage`) onto
//      this package's transport-neutral VIEW MODEL (`ConversationRecord`,
//      `ConversationSummary`, `ChatMessage`, `usage.prompt_tokens`, ... in
//      ./conversation.ts), and
//   2. the small multi-read assemblies the UI needs and the REST contract
//      deliberately splits apart (a record = session + the conversation's own
//      thread + paged transcript + usage fold; a model change = one entry-agent
//      resolve + one `agent_models` PATCH).
//
// API ROOT (R2 "same origin"): the harness client resolves its own root once at
// module load — saved setting, injected config, build-time env, else the
// canonical relative `/v1/harness` on THIS page's origin. Served by our own
// server (`@underload/chat/src/server/main.ts`) or by the Vite dev proxy (`vite.config.ts`), the
// relative root is exactly what we want, so no configuration is required for the
// normal deployment. `configureHarnessApiRoot` below is the documented override
// path (it writes the harness client's own persisted setting).
//
// CONTRACT TYPES: the wire types are NOT re-declared here (that is how drift is
// born). They are derived from the exported functions themselves with
// `Parameters<typeof fn>[0]` / `Awaited<ReturnType<typeof fn>>`, so this module
// is pinned to the published contract by construction. The only hand-written
// types in this package's API layer are the WebSocket FRAMES, in
// ./harness-stream.ts, because the harness package publishes no subpath for its
// generated stream module (`src/shared/harness-stream.ts` is not reachable from
// `@underload/harness/shared`, whose barrel re-exports origin/attachments/
// agent-results only).
import {
    API_ROOT,
    cancelSession,
    createSession,
    createSessionAgent,
    createSessionTool,
    deleteSession,
    deleteSessionTool,
    getGlobalConfig,
    getSessionAgentInstruction,
    getSession,
    // The frozen definition read: the ONLY row that states the session's entry agent
    // (see `entryAgentId` below for why the roster cannot answer it).
    getSessionDefinition,
    getSessionUsage,
    getTurnDisplay,
    listAgents,
    listProviderModels,
    listSessionAgents,
    listSessions,
    listSessionTools,
    listThreads,
    listTools,
    listTranscriptMessages,
    putTranscriptDocument,
    saveApiRootSetting,
    storedApiRoot,
    submitTask,
    apiUrl,
    updateSession,
    updateSessionAgent,
    updateSessionTool
} from '@loadscript/harness';
import type { Page } from '@loadscript/harness';

import {
    deriveConversationTitle,
    type ChatMessage,
    type ConversationRecord,
    type ConversationStatus,
    type ConversationSummary
} from './conversation';

// ---------------------------------------------------------------------------
// Contract type aliases (derived, never duplicated — see the header note)
// ---------------------------------------------------------------------------

export type HarnessSessionRow = Awaited<ReturnType<typeof listSessions>>['items'][number];
export type HarnessSessionResource = Awaited<ReturnType<typeof getSession>>;
export type HarnessCreateSessionInput = Parameters<typeof createSession>[0];
export type HarnessTranscriptMessage = Awaited<ReturnType<typeof listTranscriptMessages>>['items'][number];
export type HarnessThreadRow = Awaited<ReturnType<typeof listThreads>>['items'][number];
export type HarnessTaskReceipt = Awaited<ReturnType<typeof submitTask>>;
export type HarnessTurnDisplay = Awaited<ReturnType<typeof getTurnDisplay>>;
export type HarnessSessionUsage = Awaited<ReturnType<typeof getSessionUsage>>;
export type HarnessSessionAgent = Awaited<ReturnType<typeof listSessionAgents>>['agents'][number];
export type HarnessGlobalAgent = Awaited<ReturnType<typeof listAgents>>['items'][number];
export type HarnessGlobalTool = Awaited<ReturnType<typeof listTools>>['items'][number];
export type HarnessSessionTool = Awaited<ReturnType<typeof listSessionTools>>['items'][number];
export type HarnessGlobalConfig = Awaited<ReturnType<typeof getGlobalConfig>>;

// ---------------------------------------------------------------------------
// Constants this package owns
// ---------------------------------------------------------------------------

// The harness preset every chat conversation is created from. Injected by our
// own server (@underload/chat/src/server/presets.ts: one entry agent, no preset tools), so a
// chat session gets the clean toolbox the old assistant had rather than a
// coder/research preset with a dozen tools (parity issue 0005: no tool-less
// chat preset ships with the harness package).
export const HARNESS_CHAT_PRESET = 'chat';

// The REST root, for log lines and for a host that wants to point a tool at the
// same API this UI dials. `API_ROOT` is a LIVE binding of the harness client
// (it moves to the winning candidate only on a static Pages deployment), so this
// is read through a function rather than captured at import.
export const harnessApiRoot = (): string => API_ROOT;

// A readable absolute form of the same root (for the settings surface).
export const harnessApiUrl = (route = ''): string => apiUrl(route);

// The socket URL the stream client dials (re-exported so the stream module and
// any diagnostics panel build it from one place).
export { streamSocketUrl } from '@loadscript/harness';

/**
 * Point this browser at a different harness API root (the `ChatAssistantApp`
 * `baseUrl` prop, and the settings surface's advanced override).
 *
 * The harness client resolves its root ONCE per page load (its `API_ROOT` live
 * binding), because every request URL and the socket URL are built from it — so
 * a newly written value takes effect on the next load, which is why the result
 * says so instead of pretending the switch is instant. `null`/blank clears the
 * setting and returns the page to the automatic same-origin root.
 */
export const configureHarnessApiRoot = (value: string | null | undefined): {
    /** The root persisted by this call (normalized), or '' when cleared. */
    saved: string;
    /** The root the CURRENT page dials until it reloads. */
    effective: string;
    /** True when `saved` and `effective` differ, i.e. a reload is required. */
    reloadRequired: boolean;
} => {
    const saved = saveApiRootSetting(value) ?? '';

    return { saved, effective: API_ROOT, reloadRequired: saved.length > 0 && saved !== API_ROOT };
};

/** The persisted override exactly as this browser stored it ('' = automatic). */
export const harnessApiRootSetting = (): string => storedApiRoot() ?? '';

// ---------------------------------------------------------------------------
// Projections: harness wire rows -> this package's view model
// ---------------------------------------------------------------------------

/** Harness session status -> the UI's conversation status vocabulary. */
export const statusFromSession = (status: HarnessSessionRow['status']): ConversationStatus => {
    if (status === 'running') return 'pending';
    if (status === 'error') return 'error';

    return 'complete';
};

/** Harness ms timestamps -> the ISO strings the sidebar's time formatter expects. */
const isoOf = (millis: number): string => new Date(millis).toISOString();

/** One session row -> one sidebar row. */
export const summaryFromSession = (session: HarnessSessionRow): ConversationSummary =>
    Object.freeze({
        conversationId: session.id,
        // The harness leaves a title unset when the creator supplied nothing;
        // the UI always creates with a derived title, and this keeps an older or
        // externally created session renderable.
        title: session.title ?? deriveConversationTitle([]),
        model: session.model,
        status: statusFromSession(session.status),
        // The row's `turn_count` is the server-computed turn count, which is the
        // closest figure to the old `messageCount` on a list read (a list never
        // downloads transcripts — that is the whole point of the split).
        messageCount: session.turn_count,
        createdAt: isoOf(session.created_at),
        updatedAt: isoOf(session.updated_at)
    });

/** Harness usage (`input/output/total`) -> the UI's OpenAI-style counters. */
export const usageFromHarness = (
    usage: { input?: number; output?: number; total?: number } | undefined
): ConversationRecord['usage'] | undefined => {
    if (usage === undefined) return undefined;

    const prompt = Number(usage.input ?? 0);
    const completion = Number(usage.output ?? 0);
    const total = Number(usage.total ?? prompt + completion);

    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
};

/**
 * Transcript entries -> chat messages.
 *
 * `tool` entries are DROPPED: the surface renders three roles only, and the
 * `chat` preset ships no preset tools, so a tool row can only come from a core
 * harness tool. Dropping keeps the transcript and the editor's index space
 * consistent with what the user can see and edit.
 */
export const messagesFromTranscript = (entries: readonly HarnessTranscriptMessage[]): ChatMessage[] => {
    const messages: ChatMessage[] = [];

    for (const entry of entries) {
        const role = entry.role;

        if (role !== 'system' && role !== 'user' && role !== 'assistant') continue;
        const content = typeof entry.content === 'string' ? entry.content : '';
        if (content.length === 0) continue;
        messages.push({ role, content });
    }

    return messages;
};

/** The chat messages the model will see, back in harness transcript form. */
export const transcriptFromMessages = (
    messages: readonly ChatMessage[]
): Array<{ role: ChatMessage['role']; content: string }> =>
    messages.map((message) => ({ role: message.role, content: message.content }));

/** The structural shape `isAnswerSection` reads: shared by the wire `TurnSection`
 *  and ./harness-stream.ts's re-declared `section:open` payload, so ONE rule rules
 *  both the REST read and the live fold. */
export type AnswerFlowSection = { parentSectionId?: string; agent?: string };

/**
 * The ONE answer-folding rule: does this section's prose belong to the assistant
 * answer the chat pane prints (and persists)?
 *
 * ANSWER = THE ENTRY AGENT'S ROOT FLOW ONLY (2026-11-18 repair of the rank-model
 * port). Two halves, and BOTH are load-bearing:
 *   1. `parentSectionId === undefined` — the section is root-shaped, i.e. the
 *      server did not resolve it as a delegated/branch child of another flow;
 *   2. `agent === entryAgent` — the flow belongs to the conversation's ENTRY
 *      agent, the member the user is actually talking to.
 *
 * WHY THE IDENTITY HALF CANNOT BE DROPPED (the defect this replaces): the first
 * rank-model port folded on nesting alone, which is STRICTLY MORE INCLUSIVE than
 * the rule the retired `role === 'primary'` stamp enforced — the old projector
 * minted a non-root row 'primary' only when that row's OWN agent was the primary
 * (`turn-projector.ts` inline/child paths stamped `agent === primary`). A
 * DELEGATED lane can be perfectly parentless: the projector documents that the
 * runtime records some delegated lanes with no parent/call/kind/branch on their
 * frames (`turn-projector.ts:1395-1407`), and a post-restart journal carries only
 * `thread.id` (`:1595-1610`), and a threadless stream from a non-entry agent mints
 * an `inline:<agent>` row (`:1420`). Every one of those is root-shaped and NONE of
 * them is the entry agent's prose, so nesting alone prints another agent's words
 * inside the answer — and `readHarnessTurnText` shares this predicate, so the
 * contamination is also PERSISTED into the turn record on resync.
 *
 * WHY IDENTITY IS THE ENTRY AGENT AND NOT A RANK (the half that must NOT come
 * back): `rank` ('A'–'Z') is the authority the agent holds
 * (`DisplayProjectContext.ranks`); any number of members may share Rank A, a
 * branch/fork PROPAGATES its source agent's rank, and the entry may hold ANY
 * letter — so a rank filter breaks both ways. Entry identity comes from the
 * frozen definition's `entry` (`entryAgentId` below), never from roster position.
 *
 * `agent` is optional on the STRUCTURAL signature because this predicate is
 * shared with ./harness-stream.ts, whose re-declared `section:open` payload keeps
 * the field optional (a producer that omits it gets the CHILD side: prose whose
 * owner is unknown is never silently folded into the answer).
 */
export const isAnswerSection = (section: AnswerFlowSection, entryAgent: string): boolean =>
    section.parentSectionId === undefined && section.agent === entryAgent;

/**
 * The answer text of one turn display: the text nodes of the ENTRY agent's
 * root-shaped flows, in document order (see `isAnswerSection` for the rule).
 *
 * `entryAgent` is REQUIRED on purpose: without the entry identity this read
 * cannot tell the conversation's own prose from a parentless delegated lane, and
 * a fold that guesses is exactly how the defect above shipped.
 * `readHarnessTurnText` resolves it from the frozen definition; the caller that
 * already resolved it passes the same id.
 *
 * Reasoning nodes are excluded — they are a separate surface, and the old
 * assistant persisted only the answer.
 */
export const textOfTurnDisplay = (display: HarnessTurnDisplay, entryAgent: string): string => {
    const answerFlows = display.sections.filter((section) => isAnswerSection(section, entryAgent));
    const parts: string[] = [];

    for (const section of answerFlows) {
        for (const node of section.nodes ?? []) {
            if (node.kind !== 'text') continue;
            if (typeof node.text !== 'string' || node.text.length === 0) continue;
            parts.push(node.text);
        }
    }

    return parts.join('');
};

// ---------------------------------------------------------------------------
// Paging helper
// ---------------------------------------------------------------------------

/** The largest page the contract allows (`HARNESS_PAGE_LIMIT.max`). */
export const HARNESS_PAGE_SIZE = 100;

/**
 * Walk a paged collection to a bounded number of items.
 *
 * The contract's pages are cursor-based and capped at 100 rows, and a harness
 * deployment can hold thousands of sessions, so "list everything" is never a
 * single read. `cap` keeps the walk bounded: the sidebar scope is this
 * browser's tracked ids, and one page beyond that would be history the UI has
 * already forgotten.
 */
export const collectPage = async <T>(
    first: (query: { limit?: number }) => Promise<Page<T>>,
    next: (cursor: string) => Promise<Page<T>>,
    cap = HARNESS_PAGE_SIZE
): Promise<T[]> => {
    const items: T[] = [];
    let page = await first({ limit: HARNESS_PAGE_SIZE });

    for (;;) {
        items.push(...page.items);
        if (items.length >= cap || page.nextCursor === null) break;
        page = await next(page.nextCursor);
    }

    return items.slice(0, cap);
};

// ---------------------------------------------------------------------------
// The conversation's own thread (the one that holds its history)
// ---------------------------------------------------------------------------

/**
 * Pick the thread that HOLDS this conversation, from the roster.
 *
 * Why a rule is needed at all: `POST /sessions/{id}/tasks` WITHOUT a thread id
 * opens a NEW standalone host thread every time (packages/underload/harness/
 * src/server/sessions.ts:88-95), so a chat that wants one continuous
 * conversation must address one thread explicitly. The send flow remembers the
 * id from its own receipt; a re-opened session has no receipt, and this function
 * is the deterministic stand-in.
 *
 * Preference order (each step is a real signal, and the last two make the
 * choice total so the same roster always selects the same thread):
 *   1. a host-owned thread that actually has messages (our own chat turns),
 *   2. the most messages, then the highest sequence (most recently active),
 *   3. id ascending as the tie-break.
 */
export const selectConversationThread = (threads: readonly HarnessThreadRow[]): HarnessThreadRow | null => {
    const candidates = threads.filter((thread) => thread.has_transcript || thread.message_count > 0);
    const pool = candidates.length > 0 ? candidates : threads;
    if (pool.length === 0) return null;

    const hostPool = pool.filter((thread) => thread.origin === 'host');
    const ranked = (hostPool.length > 0 ? hostPool : pool).slice();

    ranked.sort((left, right) => {
        if (left.message_count !== right.message_count) return right.message_count - left.message_count;
        if (left.sequence !== right.sequence) return right.sequence - left.sequence;

        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });

    return ranked[0] ?? null;
};

/** The roster of a session's threads (bounded first page). */
export const listHarnessThreads = (sessionId: string): Promise<Page<HarnessThreadRow>> =>
    listThreads(sessionId, { limit: HARNESS_PAGE_SIZE });

/** The whole transcript of one thread (paged walk, bounded at 1000 entries). */
export const readHarnessTranscript = async (sessionId: string, threadId: string): Promise<ChatMessage[]> => {
    const entries = await collectPage<HarnessTranscriptMessage>(
        ({ limit }) => listTranscriptMessages(sessionId, threadId, { limit }),
        (cursor) => listTranscriptMessages(sessionId, threadId, { limit: HARNESS_PAGE_SIZE, cursor }),
        1000
    );

    return messagesFromTranscript(entries);
};

// ---------------------------------------------------------------------------
// Sessions: the conversation CRUD the store facade needs
// ---------------------------------------------------------------------------

/**
 * The sidebar list, scoped to THIS browser's tracked ids.
 *
 * The harness contract has no `?ids=` filter on `GET /sessions` (parity issue
 * 0005), so the scoping the old server did is applied here after the page read.
 * The result keeps the SERVER's order (most recently updated first) — the UI
 * re-sorts nothing, exactly as before.
 */
export const listHarnessConversations = async (ids?: readonly string[]): Promise<ConversationSummary[]> => {
    const rows = await collectPage<HarnessSessionRow>(
        ({ limit }) => listSessions({ limit }),
        (cursor) => listSessions({ limit: HARNESS_PAGE_SIZE, cursor })
    );

    const scoped = ids === undefined ? rows : rows.filter((row) => ids.includes(row.id));

    return scoped.map(summaryFromSession);
};

/** One canonical record: session + own-thread transcript + usage fold. */
export const readHarnessConversation = async (sessionId: string): Promise<ConversationRecord> => {
    const session = await getSession(sessionId);
    const threads = await listHarnessThreads(sessionId);
    const thread = selectConversationThread(threads.items);
    const messages = thread === null ? [] : await readHarnessTranscript(sessionId, thread.id);

    // The usage fold is a LAZY read by contract, and a failure to read it must
    // not fail the conversation itself: the counters are a detail panel, the
    // transcript is the chat. `undefined` keeps the cell cleared rather than
    // inventing zeros.
    let usage: ConversationRecord['usage'];

    try {
        usage = usageFromHarness((await getSessionUsage(sessionId)).usage);
    } catch {
        usage = undefined;
    }

    return {
        conversationId: session.id,
        title: session.title ?? deriveConversationTitle(messages),
        model: session.model,
        status: statusFromSession(session.status),
        messageCount: messages.length,
        messages,
        createdAt: isoOf(session.created_at),
        updatedAt: isoOf(session.updated_at),
        ...(usage === undefined ? {} : { usage }),
        ...(session.last_error === undefined || session.last_error.length === 0
            ? {}
            : { error: session.last_error })
    };
};

/**
 * Create a conversation.
 *
 * `POST /sessions` needs a harness PRESET name (the definition is frozen after
 * creation) and takes the model in `settings.model`. The title is derived
 * client-side (see `deriveConversationTitle`) because the harness never derives
 * one from the transcript, and `settings.base_url`/`api_key` are deliberately
 * omitted: the server's own provider configuration wins, and the API key never
 * travels to the browser.
 *
 * `systemPrompt` / seeded `messages` have no route at creation (a harness
 * session opens with no transcript — parity issue 0005), so a create that asks
 * for them silently gets an empty conversation; the callers that used to rely on
 * it are documented in MISSING-FEATURES.md.
 */
export const createHarnessConversation = async (input: {
    model?: string;
    title?: string;
}): Promise<ConversationRecord> => {
    const session = await createSession({
        harness: HARNESS_CHAT_PRESET,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.model === undefined || input.model.length === 0
            ? {}
            : { settings: { model: input.model } })
    });

    return {
        conversationId: session.id,
        title: session.title ?? deriveConversationTitle([]),
        model: session.model,
        status: statusFromSession(session.status),
        messageCount: 0,
        // A harness session is created WITHOUT a transcript (spec 0005), so an
        // empty message list here is the truth, not a lazy fallback.
        messages: [],
        createdAt: isoOf(session.created_at),
        updatedAt: isoOf(session.updated_at)
    };
};

/** Rename (the harness title REPLACES, and null clears it). */
export const renameHarnessConversation = (sessionId: string, title: string): Promise<unknown> =>
    updateSession(sessionId, { title });

/**
 * Point the conversation's ENTRY agent at another model.
 *
 * `PATCH /sessions/{id}` merges `agent_models`, so one field changes the model
 * of one member and leaves the rest of the (single-agent) chat definition alone.
 * The member id comes from the FROZEN DEFINITION's `entry` (see `entryAgentId`),
 * because `entry` is the member an unfocused turn actually runs and the key
 * `PATCH` addresses — never a rank (any number of members may share Rank A, and
 * the entry may hold any letter) and never a literal name.
 */
export const setHarnessConversationModel = async (sessionId: string, model: string): Promise<void> => {
    const agentId = await entryAgentId(sessionId);

    await updateSession(sessionId, { agent_models: { [agentId]: model } });
};

/** Delete a conversation (the receipt says what it aborted, the UI ignores it). */
export const deleteHarnessConversation = (sessionId: string): Promise<unknown> =>
    deleteSession(sessionId);

// ---------------------------------------------------------------------------
// Turns: submit / cancel / re-read
// ---------------------------------------------------------------------------

/**
 * Hand the model one user turn.
 *
 * `threadId` is what keeps a chat continuous: without it every submit opens a
 * NEW standalone thread (see `selectConversationThread`), which would give each
 * message a fresh, context-free conversation.
 */
export const submitHarnessTask = (
    sessionId: string,
    input: string,
    threadId?: string
): Promise<HarnessTaskReceipt> => submitTask(sessionId, { input, ...(threadId ? { threadId } : {}) });

/** Stop the running turn (a queued backlog is left alone — `all` stays false). */
export const cancelHarnessRun = (sessionId: string): Promise<unknown> => cancelSession(sessionId, false);

/**
 * The recorded answer of one turn (the stream's resync target).
 *
 * The fold needs the conversation's ENTRY agent (see `isAnswerSection`), so this
 * read is display + definition, and the definition leg is CACHED per session by
 * `entryAgentId` — on the send flow the entry was already resolved by the model
 * PATCH, so this costs no extra request there. The DISPLAY is read FIRST because
 * it is the resource the turn scope streams (the entry resolve is only the key
 * that interprets it), which keeps the request order the surfaces pin.
 */
export const readHarnessTurnText = async (sessionId: string, turnId: string): Promise<string> => {
    const display = await getTurnDisplay(sessionId, turnId);
    const entryAgent = await entryAgentId(sessionId);

    return textOfTurnDisplay(display, entryAgent);
};

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

/**
 * The provider's model ids, as the server sees them.
 *
 * `POST /models` (not GET — discovery takes a settings body) with an EMPTY
 * settings object means "use this deployment's configured provider": the
 * browser never learns the API key, and the harness merges the server credential
 * for its own base URL (packages/underload/harness/src/server/config.ts, the
 * `mergeSettings` credential rule). A foreign base URL would therefore need an
 * explicit key, which this UI never sends.
 */
export const readHarnessModels = (): Promise<string[]> => listProviderModels({});

/** The key-free provider defaults this deployment advertises. */
export const readHarnessConfig = (): Promise<HarnessGlobalConfig> => getGlobalConfig();

// ---------------------------------------------------------------------------
// The session roster (agents) and the system prompt
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THE ENTRY AGENT — the member this conversation routes to
// ---------------------------------------------------------------------------

// WHAT "entry" IS (RANK MODEL, 2026-11-18): every session has exactly ONE entry
// agent — the member an unfocused submit opens a conversation for, the member the
// default conversation is seeded from, and the member a session refuses to detach
// (`SessionAgentBinding.deletable` is false for it, and the write 409s). It is a
// ROUTING fact, NOT an authority fact: it holds whatever letter the roster's
// `ranks` map gives it, and a roster may hold any number of Rank A members. So
// this resolver asks the contract where the entry is instead of guessing from
// rank, from roster position, or from a hard-coded name.
//
// WHY THE DEFINITION READ (and not the roster): `GET /sessions/{id}/agents` states
// each member's `rank`, `origin` and `deletable`, but NO row says "I am the entry"
// — `api-reads.ts` `sessionAgentRowsOf` maps `[...definition.agents]` in
// DECLARATION order, so `agents[0]` is the entry only when the definition omits
// `entry` (the documented default), and `deletable: false` also fits a member that
// merely owns a conversation. The frozen definition IS the authority: it carries
// `entry` as a stated string, and it is what `PATCH …{agent_models}` addresses
// (its keys must name a member of the frozen definition plus anything bound since).
// The harness's own browser client resolves a session's entry the same way —
// `frontend/main.ts:7752` `agentEntryOf = entryOf(instance.frozen ?? instance.descriptor)`.
//
// The id is cached per session: the definition is frozen at creation, so it
// cannot move while this page lives, and every model/instruction write needs it —
// AND so does the answer fold (`isAnswerSection` / ./harness-stream.ts), which keys
// on this identity rather than on a rank letter.
const entryCache = new Map<string, string>();

/**
 * The id of the conversation's ENTRY agent (frozen-definition read, cached).
 *
 * The fallback (`agents[0]`) is the contract's own documented default for a
 * definition that omits `entry` (../shared/harness-api.ts `HarnessCard.entry`:
 * "an omitted `entry` is the first name of `agents`"), not a promotion of the
 * first roster member to an authority it was never given.
 */
export const entryAgentId = async (sessionId: string): Promise<string> => {
    const cached = entryCache.get(sessionId);
    if (cached !== undefined) return cached;

    const definition = await getSessionDefinition(sessionId);
    const declared = definition.entry;
    // WHITESPACE IS NOT AN IDENTITY (R88): the harness's own browser accessor tests
    // the declared entry with `entry.trim().length > 0`
    // (packages/underload/harness/src/frontend/contract.ts:189-195 `entryOf`), so a
    // definition stating `entry: '   '` means "omitted — use the first declared
    // agent" THERE. A bare `declared.length > 0` here read the same row as a stated
    // entry, so the two accessors resolved DIFFERENT members for one session (and
    // the answer fold compares this id against `TurnSection.agent`, so a
    // whitespace id would silently exclude the entry's own prose). The VALUE stays
    // untrimmed, exactly like `entryOf` returns it verbatim: the projector's
    // `DisplayProjectContext.entry` carries the same untrimmed string the
    // definition states, so trimming the value would move the identity test.
    const entry = typeof declared === 'string' && declared.trim().length > 0 ? declared : definition.agents[0];

    // Same rule for the fallback row: a definition that declares an empty name has
    // no entry at all, and an empty id can never match a section's agent.
    if (entry === undefined || entry.trim().length === 0) throw new Error('This conversation has no agent to configure.');
    entryCache.set(sessionId, entry);

    return entry;
};

/** Forget a session's cached entry-agent identity (delete). */
export const forgetHarnessSession = (sessionId: string): void => {
    entryCache.delete(sessionId);
};

/**
 * The conversation's own system prompt ('' = the preset's shipped instruction).
 *
 * The prompt lives on the ENTRY agent (the member the user actually talks to),
 * so the roster row read here is only the PROVENANCE read — it is matched by the
 * id `entryAgentId` resolved, never by `rank` (two members can share a letter) and
 * never by position. `roster.agents[0]` stays the fallback for a roster that no
 * longer names the frozen entry (a definition whose entry was bound away), exactly
 * as the pre-rank code fell back to the first member.
 */
export const readHarnessSystemPrompt = async (sessionId: string): Promise<string> => {
    const entryId = await entryAgentId(sessionId);
    const roster = await listSessionAgents(sessionId);
    const member = roster.agents.find((agent) => agent.agent_id === entryId) ?? roster.agents[0];

    if (member === undefined) return '';
    // An un-overridden member runs the trusted catalogue/harness prompt, which is
    // not this chat's editable text; reporting it as the draft would let a plain
    // Enter overwrite the shipped prompt with a copy of itself.
    if (member.has_instruction_override !== true) return '';

    const text = await getSessionAgentInstruction(sessionId, member.agent_id);

    return typeof text.instruction === 'string' ? text.instruction : '';
};

/**
 * Set the conversation's system prompt.
 *
 * `PATCH .../agents/{id}` with `instruction: null` restores the shipped prompt;
 * a busy conversation answers 409, which the caller surfaces as a notice
 * (decision 5).
 */
export const writeHarnessSystemPrompt = (
    sessionId: string,
    instruction: string | null
): Promise<unknown> =>
    entryAgentId(sessionId).then((agentId) => updateSessionAgent(sessionId, agentId, { instruction }));

/** The global (trusted) agent catalogue. */
export const readHarnessAgents = (): Promise<HarnessGlobalAgent[]> =>
    collectPage<HarnessGlobalAgent>(
        ({ limit }) => listAgents({ limit }),
        (cursor) => listAgents({ limit: HARNESS_PAGE_SIZE, cursor })
    );

/** The conversation's own agent roster. */
export const readHarnessSessionAgents = (sessionId: string): Promise<HarnessSessionAgent[]> =>
    listSessionAgents(sessionId).then((body) => body.agents);

/** Bind a catalogue agent into the conversation (the online `chat.agent.set`). */
export const addHarnessSessionAgent = (
    sessionId: string,
    name: string,
    model?: string
): Promise<HarnessSessionAgent> =>
    createSessionAgent(sessionId, {
        name,
        ...(model === undefined || model.length === 0 ? {} : { model })
    });

// ---------------------------------------------------------------------------
// Tools: the read-only catalogue plus this conversation's coded tools
// ---------------------------------------------------------------------------

/** The host's tool catalogue (read-only over HTTP: the browser may EXECUTE, never define, a shipped tool). */
export const readHarnessToolCatalogue = (): Promise<HarnessGlobalTool[]> =>
    collectPage<HarnessGlobalTool>(
        ({ limit }) => listTools({ limit }),
        (cursor) => listTools({ limit: HARNESS_PAGE_SIZE, cursor })
    );

/** The coded tools registered on THIS conversation. */
export const readHarnessSessionTools = (sessionId: string): Promise<HarnessSessionTool[]> =>
    collectPage<HarnessSessionTool>(
        ({ limit }) => listSessionTools(sessionId, { limit }),
        (cursor) => listSessionTools(sessionId, { limit: HARNESS_PAGE_SIZE, cursor })
    );

/**
 * Register (or replace) one coded tool on THIS conversation.
 *
 * `tags` is REQUIRED by the contract (`POST /sessions/{id}/tools`), which is the
 * one field the UI's tool definition has no equivalent of; 'chat-assistant' is
 * the fixed tag this package registers under, so a later revision can list
 * exactly the tools it created. Registration is COMPILE-CHECKED and never runs
 * the tool.
 */
export const putHarnessSessionTool = (
    sessionId: string,
    tool: { name: string; description: string; source: string; replace?: boolean }
): Promise<unknown> =>
    createSessionTool(sessionId, {
        name: tool.name,
        description: tool.description,
        tags: [HARNESS_SESSION_TOOL_TAG],
        ...(tool.source.length === 0 ? {} : { module_text: tool.source }),
        ...(tool.replace === undefined ? {} : { replace: tool.replace })
    });

/** The same tool, patched in place (name is the key, so it never changes). */
export const patchHarnessSessionTool = (
    sessionId: string,
    name: string,
    tool: { description?: string; source?: string }
): Promise<unknown> =>
    updateSessionTool(sessionId, name, {
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.source === undefined ? {} : { module_text: tool.source })
    });

/** Remove one coded tool from this conversation. */
export const deleteHarnessSessionTool = (sessionId: string, name: string): Promise<unknown> =>
    deleteSessionTool(sessionId, name);

/** The tag every tool this UI registers carries (see `putHarnessSessionTool`). */
export const HARNESS_SESSION_TOOL_TAG = 'chat-assistant';

// ---------------------------------------------------------------------------
// Transcript rewrite (the message editor's write path)
// ---------------------------------------------------------------------------

/**
 * Replace one thread's whole transcript, with the optimistic-lock revision.
 *
 * The old gateway answered the whole-history PUT with the canonical record;
 * the harness answers with a RECEIPT (what it accepted and at which revision),
 * because the stream is the update plane. The caller therefore re-reads the
 * record — the shape the plugin graph already expects (`store.replace` returns a
 * record), so no plugin had to change for this.
 */
export const writeHarnessTranscript = (
    sessionId: string,
    threadId: string,
    messages: readonly ChatMessage[],
    ifRevision?: number
): Promise<unknown> =>
    putTranscriptDocument(sessionId, threadId, transcriptFromMessages(messages), ifRevision);

/** The transcript document's current revision (the `if_revision` guard's input). */
export const readHarnessTranscriptRevision = async (sessionId: string, threadId: string): Promise<number | undefined> => {
    const page = await listTranscriptMessages(sessionId, threadId, { limit: HARNESS_PAGE_SIZE });

    return page.revision;
};
