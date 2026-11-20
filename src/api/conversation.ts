// The UI-side conversation model — the shape the WHOLE workstation speaks.
//
// WHY THIS MODULE EXISTS: before the rebuild this vocabulary lived in
// `api/chat-assistant.ts`, which was also the REST client for the old
// `/v1/chat-assistant/conversation` gateway API. That API is gone (R1: the
// package now hosts its own `@underload/harness` server, and the UI talks
// same-origin to `/v1/harness`), but the record/summary/message shapes the
// dashboard is built on are NOT gone — they are the transport-neutral view
// model every plugin, component and BOTH transports speak:
//
//   - offline mode  -> the durable browser-local store (api/offline.ts), whose
//                      semantics are unchanged (R3), and
//   - online mode   -> the harness session mapping (api/harness.ts +
//                      dashboard/services/conversations.ts).
//
// Keeping the vocabulary separate from either transport is what lets the plugin
// graph (cells, commands, events) stay exactly as it was while the wire beneath
// it is replaced.
//
// WIRE vs VIEW MODEL: the harness wire is snake_case (`SessionSummary`,
// `TurnSummary`, `HarnessMessage`); `ConversationRecord`/`ConversationSummary`
// below are the camelCase view model the UI renders. The projection lives in
// api/harness.ts — never in a plugin or component — so the surface code has one
// shape to know.

// The only roles the UI stores and renders. The harness transcript also carries
// `tool` entries; a tool-less chat preset produces none, and api/harness.ts
// drops any that appear (the surface has no renderer for a tool result row).
//
// `model` is the storage-only per-message attribution: the UI records which
// provider model produced an assistant turn so the turn caption can name it. It
// is a CLIENT-side field — the harness attributes models per turn section
// (`TurnSection.model` on `GET .../turns/{id}/display`), not per transcript
// entry, so online records leave it unset (see MISSING-FEATURES.md).
export type ChatMessage = {
    role: 'system' | 'user' | 'assistant';
    content: string;
    model?: string;
};

// 'pending'  -> a turn is still in flight (the R14 poller follows it; OFFLINE only),
// 'complete' -> settled with no error,
// 'error'    -> the transport reported a failure.
// The online projection maps the harness session status onto this vocabulary:
// `running` -> 'pending', `error` -> 'error', `idle` -> 'complete'
// (api/harness.ts `statusFromSession`).
export type ConversationStatus = 'pending' | 'complete' | 'error';

// One full conversation: the sidebar row's fields plus the message list and the
// aggregate token counters.
export type ConversationRecord = {
    conversationId: string;
    title: string;
    model: string;
    status: ConversationStatus;
    messageCount: number;
    messages: ChatMessage[];
    createdAt: string;
    updatedAt: string;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
    error?: string;
};

// Body of a create/append request. `message` is the single-turn shorthand,
// `messages` the explicit history (the fork flow). Online (harness) a create
// carries only `model` + a client-derived `title`: the harness mints its own
// conversation from the model's output, so a seeded history has no route
// (MISSING-FEATURES.md: transcript seeding, parity issue 0005).
export type ConversationPostRequest = {
    message?: string;
    messages?: ChatMessage[];
    model?: string;
    systemPrompt?: string;
    status?: 'pending' | 'complete';
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
};

// Identifier-only answer of a create/append (the canonical record is read back
// separately — that IS the documented protocol of both transports).
export type ConversationPostResponse = {
    conversationId: string;
};

// Body of a whole-history replacement. Online this becomes the PER-THREAD
// transcript document PUT (`PUT /sessions/{id}/threads/{tid}/transcript`, with a
// `title` PATCH alongside it); offline it stays the local record rewrite.
export type ConversationPutRequest = {
    messages: ChatMessage[];
    model?: string;
    title?: string;
    status?: 'pending' | 'complete';
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
};

export type ConversationGetResponse = {
    conversationId: string;
    conversation: ConversationRecord;
};

// Compact sidebar row (message bodies deliberately excluded, so restoring the
// history stays cheap on both transports).
export type ConversationSummary = Pick<
    ConversationRecord,
    'conversationId' | 'title' | 'model' | 'status' | 'messageCount' | 'createdAt' | 'updatedAt'
>;

export type ConversationListResponse = {
    conversations: ConversationSummary[];
};

export type ConversationDeleteResponse = {
    conversationId: string;
};

// ---------------------------------------------------------------------------
// Tracked conversation ids (THIS browser's own sidebar scope)
// ---------------------------------------------------------------------------
//
// The sidebar lists only the conversations this browser created: every id
// returned by a successful create is cached here, and a list read is scoped to
// that cache. The old gateway API accepted the filter on the server
// (`GET ...?ids=a,b`); the harness contract has no id filter on `GET /sessions`
// (spec 0005), so api/harness.ts pages the collection and applies the SAME
// filter client-side. Observable behaviour is unchanged: a chat another browser
// created never appears here, and ids the server no longer holds are pruned.
export const TRACKED_CONVERSATIONS_KEY = 'chat-assistant:tracked-conversations';

// Read the cached ids. Corrupt/absent storage degrades to an empty cache (the
// sidebar then restores nothing) instead of throwing; non-string entries and
// duplicates are dropped so a hand-edited cache cannot break the query.
export const readTrackedConversationIds = (): string[] => {
    try {
        const raw = window.localStorage.getItem(TRACKED_CONVERSATIONS_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const ids: string[] = [];
        for (const candidate of parsed) {
            if (typeof candidate === 'string' && candidate.length > 0 && !ids.includes(candidate)) {
                ids.push(candidate);
            }
        }
        return ids;
    } catch {
        return [];
    }
};

// Persist the cached ids. Best-effort like the other browser caches: a
// locked-down storage keeps the session working, it only loses the restore.
export const storeTrackedConversationIds = (ids: string[]): string[] => {
    const unique: string[] = [];
    for (const id of ids) {
        if (typeof id === 'string' && id.length > 0 && !unique.includes(id)) unique.push(id);
    }
    try {
        window.localStorage.setItem(TRACKED_CONVERSATIONS_KEY, JSON.stringify(unique));
    } catch {
        // Best-effort: the in-memory list still drives the current session.
    }
    return unique;
};

// Track ONE id (called after a successful creation) and return the new cache.
// Re-tracking an existing id is a no-op, so repeated sends on a restored
// conversation never duplicate it.
export const trackConversationId = (conversationId: string): string[] =>
    storeTrackedConversationIds([...readTrackedConversationIds(), conversationId]);

// Stop tracking one id (after a successful DELETE, and for ids the server no
// longer returns) so the cache never accumulates dead entries.
export const untrackConversationId = (conversationId: string): string[] =>
    storeTrackedConversationIds(readTrackedConversationIds().filter((id) => id !== conversationId));

// True when a conversation still needs polling: its turn is in flight. ONLINE
// this is now informational — the WebSocket stream (`api/harness-stream.ts`)
// tells the send flow when a turn settles, so the poller runs in OFFLINE mode
// only (plugins/source.ts) — and OFFLINE it is never true in practice, because
// the local store writes settled records.
export const isConversationPending = (status: ConversationStatus): boolean => status === 'pending';

// Polling cadence for an in-flight ('pending') conversation, kept for OFFLINE
// parity with the pre-rebuild UI.
export const CONVERSATION_POLL_INTERVAL_MS = 2000;

// ---------------------------------------------------------------------------
// Title derivation
// ---------------------------------------------------------------------------
//
// The rule BOTH the old gateway server and the offline store use: the first
// LINE (trimmed) of the first user turn, capped at 80 characters (77 + "..."),
// and "New conversation" when nothing contributes a title.
//
// It lives here because ONLINE mode now needs it too: a harness session's title
// is supplied at creation (`POST /sessions {title}`) — the server never derives
// one from the transcript — so the client derives it from the first user turn
// before creating the session (decision: "create on first send with title
// derivation unchanged client-side"). The offline store keeps its own private
// copy (api/offline.ts `localTitleFromMessages`) so its behavior stays
// byte-identical to the pre-rebuild build (R3).
export const DEFAULT_CONVERSATION_TITLE = 'New conversation';
export const CONVERSATION_TITLE_MAX_CHARS = 80;

export const deriveConversationTitle = (messages: readonly ChatMessage[]): string => {
    const firstUser = messages.find((message) => message.role === 'user');
    const firstLine = (firstUser?.content.trim().split('\n', 1)[0] ?? '').trim();
    const title = firstLine || DEFAULT_CONVERSATION_TITLE;

    // The harness caps a session title at 200 chars; the UI's own cap of 80 is
    // the tighter bound, so the value is always acceptable on both transports.
    return title.length > CONVERSATION_TITLE_MAX_CHARS
        ? `${title.slice(0, CONVERSATION_TITLE_MAX_CHARS - 3)}...`
        : title;
};
