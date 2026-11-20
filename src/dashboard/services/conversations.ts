// Conversation-storage SERVICE facade for the dashboard plugins.
//
// WHAT THIS IS: one mode-agnostic `ConversationStore` over the two transports, so
// a chat plugin never branches on the assistant mode:
//
//   - 'online'  -> the HARNESS session surface (../../api/harness.ts): a session
//                  IS the conversation, a thread's transcript IS the history, and
//                  `POST /sessions/{id}/tasks` IS the write that adds a turn. The
//                  projection back onto `ConversationRecord` lives in
//                  ../../api/harness.ts, not here; this file only wires the calls.
//   - 'offline' -> the durable browser-local store in ../../api/offline.ts,
//                  unchanged (R3), which already mirrors the pre-rebuild server's
//                  semantics with identical Promise shapes.
//
// This module ADAPTS; it duplicates no HTTP, no fetch, no localStorage and no
// server semantics.
//
// THE THREE SEMANTIC BRIDGES WORTH READING (each is a place the harness contract
// is shaped differently from the old storage API, and the seam is here rather
// than in a plugin):
//
//   1. LIST SCOPING. The old server accepted `?ids=`; the harness has no id
//      filter on `GET /sessions` (parity issue 0005), so
//      ../../api/harness.ts pages the collection and applies the SAME filter
//      after the read. Observable behavior is unchanged: the sidebar lists
//      exactly the conversations this browser created, and ids the server no
//      longer holds are pruned from the cache below.
//   2. APPEND. Online there is no "append a message" request at all: the RUN
//      appended the turn server-side. `append` therefore means "the turn
//      happened — give me the canonical record", and it carries one extra duty
//      the old server did for free: deriving the title. A harness session's
//      title is set at creation and never derived from the transcript, so the
//      first completed turn renames a still-untitled conversation with the same
//      rule the old server used (`deriveConversationTitle`, client-side by
//      decision).
//   3. REPLACE. The whole-history PUT became a PER-THREAD transcript document
//      PUT with an optimistic-lock revision, plus a separate title PATCH. Both
//      happen here, and the canonical record is re-read afterwards, because the
//      harness answers a write with a RECEIPT rather than the document (the
//      stream is its update plane).
//
// TRACKED IDS: the browser-owned cache in ../../api/conversation.ts (key
// `chat-assistant:tracked-conversations`, unchanged from the pre-rebuild build).
// Online it is the sidebar's authority: `create` tracks the new id BEFORE the
// follow-up read, `remove` untracks only AFTER the store confirms, and `list`
// prunes requested ids the server no longer returns — exactly the three rules of
// the pre-rebuild component (:2485-2502, :2810-2817). The same cache backs
// offline mode, while offline `list` keeps ignoring the id filter because the
// local store is already browser-scoped.
//
// THE OPTIONAL METHODS (`systemPrompt` / `setSystemPrompt`): the leading system
// prompt is a TRANSCRIPT MESSAGE offline (a leading `system` entry, as always)
// and a HARNESS AGENT INSTRUCTION online (`PATCH /sessions/{id}/agents/{id}`).
// A record field cannot express both without inventing a fake transcript entry
// online, so the capability is an explicit optional pair on the interface, and
// plugins/system-prompt.ts is the only caller: it branches on the mode it already
// branches on and never on the presence of a method.
import {
    appendToLocalConversation,
    createLocalConversation,
    deleteLocalConversation,
    getLocalConversation,
    listLocalConversations,
    replaceLocalConversationMessages
} from '../../api/offline';
import {
    deriveConversationTitle,
    DEFAULT_CONVERSATION_TITLE,
    readTrackedConversationIds,
    trackConversationId,
    untrackConversationId
} from '../../api/conversation';
import type {
    ConversationPostRequest,
    ConversationPutRequest,
    ConversationRecord,
    ConversationSummary
} from '../../api/conversation';
import {
    configureHarnessApiRoot,
    createHarnessConversation,
    deleteHarnessConversation,
    forgetHarnessSession,
    listHarnessConversations,
    listHarnessThreads,
    entryAgentId,
    readHarnessConversation,
    readHarnessSystemPrompt,
    renameHarnessConversation,
    selectConversationThread,
    setHarnessConversationModel,
    writeHarnessSystemPrompt,
    writeHarnessTranscript,
    readHarnessTranscriptRevision
} from '../../api/harness';

// The two assistant modes, narrowed to the storage concern. Same discriminator
// as `AssistantMode` in ../../api/offline.ts.
export type ConversationStoreMode = 'online' | 'offline';

// The unified storage contract every chat plugin consumes. Both modes resolve
// the same shapes, so a mode switch is a re-created store, never new call sites.
export interface ConversationStore {
    // The mode this instance was built for (mirrors `ConversationStoreMode`).
    readonly mode: ConversationStoreMode;
    // Compact summaries, most recent activity first (both implementations
    // already order by recency — the UI re-sorts nothing).
    list(ids: string[]): Promise<ConversationSummary[]>;
    create(input: ConversationPostRequest): Promise<ConversationRecord>;
    read(id: string): Promise<ConversationRecord>;
    append(id: string, input: ConversationPostRequest): Promise<ConversationRecord>;
    replace(id: string, input: ConversationPutRequest): Promise<ConversationRecord>;
    remove(id: string): Promise<void>;
    // The browser's own tracked-id cache (see the header comment).
    tracked(): string[];
    track(id: string): void;
    untrack(id: string): void;
    // Online (harness) only: the editable system prompt, which is the ENTRY
    // agent's instruction override ('' = the preset's shipped prompt). Offline
    // leaves these undefined and keeps its leading transcript message.
    systemPrompt?(id: string): Promise<string>;
    setSystemPrompt?(id: string, instruction: string): Promise<void>;
}

// Factory options. `baseUrl` is the DECLARED harness API root (online mode; see
// plugins/options.ts for why it is a declared root rather than a per-request
// URL). `providerBase` is the user-configured OpenAI-compatible base used by the
// STREAMING service, accepted here so a plugin can pass one options object to
// both factories; conversation storage never sends it anywhere.
export interface ConversationStoreOptions {
    baseUrl?: string;
    providerBase?: string;
}

// Build the store for one mode. Plain object + closures (no class, no React):
// every method is a stable reference and can be passed to a plugin `services`
// registry directly.
export function createConversationStore(
    mode: ConversationStoreMode,
    options: ConversationStoreOptions = {}
): ConversationStore {
    // Anything that is not explicitly 'offline' is online: the shipped settings
    // loader degrades corrupt/absent settings to 'online' (api/offline.ts), so
    // the storage layer must not invent a third behavior.
    const offline = mode === 'offline';

    // A DECLARED root is persisted through the harness client's own setting so
    // the next load dials it (the client resolves once per page). Written here,
    // at store construction, because the store is what the mode-routing facade
    // rebuilds on a settings edit — and an empty declaration means "automatic,
    // same origin", which is the correct default for the packaged server.
    if (!offline) {
        const declared = (options.baseUrl ?? '').trim();

        if (declared.length > 0) configureHarnessApiRoot(declared);
    }

    // True when a conversation has no meaningful title yet, i.e. it is exactly
    // what the harness answers for a session created without one, or the default
    // this package writes. Those are the only states the first-turn rename may
    // overwrite — an operator's rename is never clobbered.
    const untitled = (title: string | undefined): boolean =>
        title === undefined || title.trim().length === 0 || title === DEFAULT_CONVERSATION_TITLE;

    // Canonical record read, shared by `read()` and the post-write follow-up
    // reads of create/append/replace. Online it is the multi-read assembly
    // (session + thread + transcript + usage); offline it unwraps the local
    // envelope. Both answer the SAME shape.
    const readRecord = async (id: string): Promise<ConversationRecord> => {
        if (offline) return (await getLocalConversation(id)).conversation;

        return readHarnessConversation(id);
    };

    return {
        mode,

        list: async (ids: string[]): Promise<ConversationSummary[]> => {
            if (offline) {
                // No id filter locally: every persisted record belongs to THIS
                // browser, so the tracked cache would only hide its own chats.
                const response = await listLocalConversations();

                return response.conversations;
            }

            const rows = await listHarnessConversations(ids);
            const returned = new Set(rows.map((entry) => entry.conversationId));

            // Prune the requested ids the server no longer holds (deleted in
            // another tab/device) so the cache never accumulates dead entries.
            // Pruning `ids` rather than the whole cache keeps an explicitly
            // scoped query from dropping conversations this call never asked
            // about.
            for (const id of ids) {
                if (!returned.has(id)) untrackConversationId(id);
            }

            return rows;
        },

        create: async (input: ConversationPostRequest): Promise<ConversationRecord> => {
            if (offline) {
                const created = await createLocalConversation(input);
                const conversationId = created.conversationId;

                trackConversationId(conversationId);

                return (await getLocalConversation(conversationId)).conversation;
            }

            // A harness session is created from the `chat` preset with a
            // CLIENT-derived title (the server never derives one) and, when a
            // model is selected, that model as the session's provider model.
            const derived = deriveConversationTitle(
                input.messages ?? (input.message === undefined ? [] : [{ role: 'user', content: input.message }])
            );

            const record = await createHarnessConversation({
                model: input.model,
                title: input.systemPrompt !== undefined || input.messages !== undefined ? derived : undefined
            });

            // Track BEFORE the follow-up read so a reload mid-flow still restores
            // the conversation that was just created.
            trackConversationId(record.conversationId);

            // A create that asked for a system prompt gets it as the agent
            // instruction rather than as a transcript entry: the harness has no
            // transcript at creation time (parity issue 0005).
            if (input.systemPrompt !== undefined && input.systemPrompt.trim().length > 0) {
                await writeHarnessSystemPrompt(record.conversationId, input.systemPrompt.trim());
            }

            return record;
        },

        read: readRecord,

        append: async (id: string, input: ConversationPostRequest): Promise<ConversationRecord> => {
            if (offline) {
                await appendToLocalConversation(id, input);

                return (await getLocalConversation(id)).conversation;
            }

            // The turn is ALREADY on the server: an online "append" is the
            // receipt-following read the rest of the graph expects. The one real
            // duty left is the title, which the old server derived and the
            // harness never does.
            const record = await readHarnessConversation(id);
            const messages = input.messages ?? (input.message === undefined ? [] : [{ role: 'user', content: input.message }]);

            if (messages.length > 0 && untitled(record.title)) {
                const title = deriveConversationTitle(messages);

                if (title !== record.title) {
                    await renameHarnessConversation(id, title);

                    return { ...record, title };
                }
            }

            return record;
        },

        replace: async (id: string, input: ConversationPutRequest): Promise<ConversationRecord> => {
            if (offline) {
                const response = await replaceLocalConversationMessages(id, input);

                return response.conversation;
            }

            // Title and history are two different resources online: the title is
            // a session PATCH, the history is one thread's transcript document.
            if (input.title !== undefined && input.title.trim().length > 0) {
                await renameHarnessConversation(id, input.title.trim());
            }

            const threads = await listHarnessThreads(id);
            const thread = selectConversationThread(threads.items);

            if (thread !== null) {
                // The optimistic lock is read from the same transcript the PUT
                // replaces, so a concurrent writer's newer document is REFUSED
                // rather than silently overwritten (the contract's own rule).
                const revision = await readHarnessTranscriptRevision(id, thread.id);

                await writeHarnessTranscript(id, thread.id, input.messages, revision);
            }

            // The canonical re-read: the harness answers a write with a receipt,
            // and the graph consumes a record.
            const record = await readHarnessConversation(id);

            return input.title !== undefined && input.title.trim().length > 0
                ? { ...record, title: input.title.trim() }
                : record;
        },

        remove: async (id: string): Promise<void> => {
            if (offline) await deleteLocalConversation(id);
            else await deleteHarnessConversation(id);

            // The entry-agent cache is per session, so a deleted conversation's
            // entry would otherwise outlive it forever.
            if (!offline) forgetHarnessSession(id);

            // Untrack only AFTER the store confirmed the removal, so a failed
            // delete keeps the conversation tracked and restorable.
            untrackConversationId(id);
        },

        tracked: readTrackedConversationIds,
        track: trackConversationId,
        untrack: untrackConversationId,

        // Online only. Offline keeps its leading transcript message, which the
        // record read already carries.
        ...(offline
            ? {}
            : {
                  systemPrompt: (id: string): Promise<string> => readHarnessSystemPrompt(id),
                  setSystemPrompt: async (id: string, instruction: string): Promise<void> => {
                      // The entry-agent resolve is folded into the writer (it reads
                      // the frozen definition to name the member itself), and the
                      // promise rejects with the harness's 409 sentence when the run
                      // is busy — the caller surfaces it as a notice.
                      await entryAgentId(id);
                      await writeHarnessSystemPrompt(id, instruction);
                  }
              })
    };
}

// Re-exported for the send pipeline, which needs the model of a session to stay
// in step with the picker (the harness routes by the session's agent model, not
// by a per-request field).
export { setHarnessConversationModel };
