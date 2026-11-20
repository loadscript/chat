// Chat TOOLS plugin: the tool registry (native runtime tools + persisted coded tools).
//
// WHAT THIS IS (behavior oracle: src/components/ChatAssistantApp.tsx):
//   the Tool tab's registry rows        :4621-4648  -> `chat.tools` (this plugin's cell write)
//   `ToolWorkspace` (the tool panel)    :4784-4801  -> components/ToolInspector.tsx
//   `ToolCodeBlock` (the source panel)  :531-549
//   `toolKindLabel` (native vs JS/TS)   :551-555    -> ToolInspector keeps that copy
//
// The oracle's registry is the hard-coded `AVAILABLE_TOOLS` seed (src/agents/index.ts
// :79-82): it has NO create/save/delete UI for tools, because it has no tool
// persistence at all. The contract pins the three command ids anyway
// (contract.ts:457-459) and `services/registries.ts` supplies the durable layer the
// agents module is missing (localStorage key `chat-assistant:tools`, header note
// :9-19), so the surface this plugin backs is the oracle's panel PLUS the minimum
// affordance those commands need: a coded tool's name / language / source become
// editable, a fresh create allocates one, and a delete drops the persisted entry.
//
// THE ONE SEMANTIC WORTH READING TWICE — native rows are not deletable.
// `ToolStore.remove` only ever rewrites the PERSISTED list (registries.ts:43-50,
// :171-173), and `list()` merges the seed with it "deduplicated by id with the
// NATIVE SEED winning" (:152-165). So removing `web-search` is a no-op: the runtime
// still provides it and it stays listed. This plugin therefore clears
// `chat.activeToolId` after a delete ONLY when the id actually left the registry —
// clearing the selection of a row that is still on screen would be the lie. The
// tool panel mirrors the rule by not drawing the delete control for a native entry.
//
// NO EPOCH GUARD, NO ACTIVITY SLOT, NO STATE CELLS REGISTERED — same reasoning as
// plugins/agents.ts (synchronous localStorage flows, and the core owns every
// `chat.*` cell). `chat.tools` is seeded by the core from its OWN throwaway
// `createToolStore()` (plugins/core.ts:413-421); this plugin republishes the cell
// from the store it registers, which is the same read through the facade.
import type { DashboardPlugin } from '@underload/dashboard';
import type { ToolDefinition, ToolLanguage } from '../../agents';
import {
    deleteHarnessSessionTool,
    putHarnessSessionTool,
    readHarnessSessionTools,
    readHarnessToolCatalogue
} from '../../api/harness';
import { createToolStore, type AgentStore, type ToolStore } from '../services/registries';
import {
    CHAT_AGENT_STORE_SERVICE,
    CHAT_CELLS_SERVICE,
    CHAT_ERROR_EVENT,
    CHAT_NOTICE_EVENT,
    CHAT_TOOL_CREATE_COMMAND,
    CHAT_TOOL_DELETE_COMMAND,
    CHAT_TOOL_SAVE_COMMAND,
    CHAT_TOOL_STORE_SERVICE,
    PLUGIN_IDS,
    type ChatCells,
    type NoticeEvent
} from '../contract';

/** Plugin id — see the note on AGENTS_PLUGIN_ID for why this is not in PLUGIN_IDS. */
export const TOOLS_PLUGIN_ID = 'chat.tools';

/**
 * Id prefix for a created tool, mirroring `createAgentDefinition`'s sequential ids
 * (src/agents/index.ts:138-146): the LOWEST free `tool-N`, so testids stay stable
 * across deletions and a reloaded registry reproduces the same row identities.
 */
export const TOOL_ID_PREFIX = 'tool-';

/** Default name of a freshly created tool (the agent registry's is "New agent"). */
export const DEFAULT_TOOL_NAME = 'New tool';

/**
 * The source a freshly created tool carries.
 *
 * It cannot be EMPTY, and that is a storage constraint rather than a style choice:
 * `ToolStore`'s persisted-entry guard rejects `code: ''` (services/registries.ts:69
 * — an empty source is read as a partial write), so a blank tool would be listed for
 * the session and then silently disappear on reload. One comment line is the
 * smallest non-empty value that is also a useful starting point, and it keeps the
 * fresh row a genuine coded tool under `isCodedTool` (src/agents/index.ts:66-68).
 */
export const DEFAULT_TOOL_SOURCE = '// New tool implementation\n';

/**
 * The language a fresh coded tool starts with. `javascript` because the source is
 * what the runtime executes verbatim and `ToolDefinition` accepts exactly the two
 * tags in src/agents/index.ts:52; the panel lets the operator switch to TypeScript.
 */
export const DEFAULT_TOOL_LANGUAGE: ToolLanguage = 'javascript';

/**
 * A fresh, empty coded tool with the lowest free id.
 *
 * A created tool is CODED by definition: a native entry is provided by the runtime
 * (src/agents/index.ts:73-78) and cannot be manufactured here. The source starts at
 * `DEFAULT_TOOL_SOURCE` for the storage reason documented on that constant (an empty
 * code would drop the row on the next read), and the panel selects it so the operator
 * types over a placeholder rather than into nothing.
 */
export const createToolDefinition = (
    existing: readonly ToolDefinition[],
    name: string = DEFAULT_TOOL_NAME,
    code: string = DEFAULT_TOOL_SOURCE
): ToolDefinition => {
    const used = new Set(existing.map((tool) => tool.id));
    let counter = 1;
    while (used.has(`${TOOL_ID_PREFIX}${counter}`)) counter += 1;
    return {
        id: `${TOOL_ID_PREFIX}${counter}`,
        name,
        native: false,
        language: DEFAULT_TOOL_LANGUAGE,
        code
    };
};

/**
 * Build the tools plugin for one dashboard.
 * No options: like agents, the tool registry has no endpoint (localStorage only).
 */
/**
 * A coded tool's harness registration NAME, derived from its registry id.
 *
 * The harness wants a wire-safe identifier (`/^[A-Za-z][A-Za-z0-9_-]{0,63}$/`,
 * packages/underload/harness/src/core/creation.ts:51-53) while the UI's display
 * name is free text ("My Helper"). `tool-N`/`custom-N` ids already satisfy the
 * pattern, so the id is the registration key and the display name travels as the
 * tool's DESCRIPTION (the one free-text field both sides have). The mapping is
 * reversible from either side, which is what lets the rail show a server-registered
 * row it did not create in this browser.
 */
export const harnessToolNameOf = (tool: ToolDefinition): string => {
    const slug = tool.id.replace(/[^A-Za-z0-9_-]/g, '_');

    return /^[A-Za-z]/.test(slug) ? slug.slice(0, 64) : `t-${slug}`.slice(0, 64);
};

/** One catalogue row as a native tool row the existing panel renders unchanged. */
export const toolDefinitionFromCatalogue = (row: {
    name: string;
    description?: string;
    group?: string;
}): ToolDefinition => ({
    id: row.name,
    name: row.group && row.group.length > 0 ? `${row.name} (${row.group})` : row.name,
    // A catalogue tool is provided by the HOST, so it is the native kind: no code
    // panel, no delete affordance (the browser cannot define or remove one).
    native: true
});

/** One session-registered coded tool as a row this surface can edit. */
export const toolDefinitionFromSessionRow = (row: {
    name: string;
    description?: string;
    source?: string;
}): ToolDefinition => ({
    id: row.name,
    name: row.description && row.description.length > 0 ? row.description : row.name,
    native: false,
    language: 'typescript',
    // The source is a separate lazy read by contract (a list row never carries
    // it), so an unknown source renders as an empty editor the next save fills.
    code: row.source ?? ''
});

export function createToolsPlugin(): DashboardPlugin {
    return {
        id: TOOLS_PLUGIN_ID,
        requires: [PLUGIN_IDS.chatCore],
        setup(api) {
            const cells = api.getService<ChatCells>(CHAT_CELLS_SERVICE);
            const store = createToolStore();

            api.service<ToolStore>(CHAT_TOOL_STORE_SERVICE, store);
            cells.tools.set(Object.freeze(store.list()));

            /** Project seed + persisted tools into the cell the views read. */
            const publishTools = (): void => {
                cells.tools.set(Object.freeze([...store.list()]));
            };

            // ─── ONLINE: the Tool tab lists the server, not this browser ─────────
            // The harness toolbox is per CONVERSATION: the global catalogue is
            // read-only over HTTP (the browser may execute a shipped tool, never
            // define one) and a user-coded tool belongs to ONE session
            // (`POST /sessions/{id}/tools`, `tags` required). So the online list is
            // the catalogue plus whatever this conversation registered, and the
            // native/coded split the panel already renders carries over exactly.
            let alive = true;

            const publishServerTools = async (): Promise<void> => {
                if (cells.mode.get() !== 'online') {
                    publishTools();

                    return;
                }

                const sessionId = cells.activeSessionId.get();

                try {
                    const catalogue = await readHarnessToolCatalogue();
                    const sessionTools = sessionId === null ? [] : await readHarnessSessionTools(sessionId);

                    if (!alive || cells.mode.get() !== 'online') return;
                    cells.tools.set(
                        Object.freeze([
                            ...catalogue.map((row) => toolDefinitionFromCatalogue(row)),
                            ...sessionTools.map((row) => toolDefinitionFromSessionRow(row as { name: string; description?: string; source?: string }))
                        ])
                    );
                } catch (reason) {
                    if (!alive) return;
                    const message = reason instanceof Error ? reason.message : String(reason);

                    cells.error.set(message);
                    api.emit(CHAT_ERROR_EVENT, { message } satisfies NoticeEvent);
                }
            };

            const onModeChange = cells.mode.subscribe(() => {
                void publishServerTools();
            });
            // The coded half is per conversation, so opening another one re-lists.
            const onSessionChange = cells.activeSessionId.subscribe(() => {
                void publishServerTools();
            });

            void publishServerTools();

            /**
             * Best-effort registration of one coded tool on the OPEN conversation.
             *
             * The localStorage write is what the editor owns (it must stay instant
             * and it survives a mode switch); the harness registration is the
             * online effect that makes the tool callable. A failure is a NOTICE with
             * the server's own sentence (an invalid name, a full tool budget, a busy
             * conversation), never a lost edit, and with no conversation open there
             * is nothing to register against.
             */
            const registerOnSession = (tool: ToolDefinition): void => {
                if (cells.mode.get() !== 'online') return;
                const sessionId = cells.activeSessionId.get();

                if (sessionId === null) {
                    api.emit(CHAT_NOTICE_EVENT, {
                        message:
                            'Open a conversation to register this coded tool: harness tools belong to one conversation.'
                    } satisfies NoticeEvent);

                    return;
                }

                void putHarnessSessionTool(sessionId, {
                    name: harnessToolNameOf(tool),
                    description: tool.name,
                    source: tool.code ?? '',
                    replace: true
                }).then(
                    () => {
                        if (!alive) return;
                        void publishServerTools();
                    },
                    (reason: unknown) => {
                        if (!alive) return;
                        const message = reason instanceof Error ? reason.message : String(reason);

                        api.emit(CHAT_ERROR_EVENT, { message } satisfies NoticeEvent);
                    }
                );
            };

            /**
             * chat.tool.create — the agent-create flow applied to tools: fresh record,
             * persisted, opened in the panel, rail switched to the Tool tab. Ordering
             * matters: the id is allocated from the registry BEFORE the save, so a
             * second click while the first row is still open lands on `tool-2`.
             */
            api.command<void, string>(CHAT_TOOL_CREATE_COMMAND, () => {
                const tool = createToolDefinition(store.list());
                store.save(tool);
                publishTools();
                cells.activeToolId.set(tool.id);
                cells.sidebarTab.set('tool');
                return tool.id;
            });

            /**
             * chat.tool.save — the whole definition, same no-draft rule as the agent
             * editor (oracle :488-492: "Every change writes into the definition and
             * re-persists immediately"). `id` and `native` are identity fields the
             * panel never patches: making a runtime tool "custom" (or the reverse)
             * would move it across the seed/persisted boundary mid-edit.
             */
            api.command<ToolDefinition, void>(CHAT_TOOL_SAVE_COMMAND, (tool) => {
                if (!tool || typeof tool.id !== 'string' || tool.id.length === 0) return;
                store.save(tool);
                publishTools();
                // Online, the same edit also installs the source on the open
                // conversation (compile-checked at registration, never executed).
                registerOnSession(tool);
            });

            /**
             * Prune one tool id out of every SAVED agent's `tools` list.
             *
             * WHY THIS EXISTS: `AgentDefinition.tools` holds tool IDS
             * (src/agents/index.ts:25-36) and the rail renders one row's metadata as
             * "`N` turns · `N` tools" straight from `chat.agents`
             * (components/ChatSidebar.tsx:94 `agentMeta`). Deleting the tool therefore
             * left a dangling id being COUNTED as a tool the registry no longer has.
             * The write goes through the agent store this dashboard publishes
             * (`chat.agentStore`, plugins/agents.ts:72) so the SAME facade that owns the
             * persisted shape does the rewriting; the registries stay independent in
             * every other direction (an agent write never touches tools, and nothing
             * here re-orders or re-validates the agent rows).
             *
             * A composition without the agents plugin has no agent registry to prune, so
             * the `unknown-service` miss is simply "nothing to do".
             */
            const pruneAgentReferences = (toolId: string): void => {
                let agentStore: AgentStore;
                try {
                    agentStore = api.getService<AgentStore>(CHAT_AGENT_STORE_SERVICE);
                } catch {
                    return;
                }
                let changed = false;
                for (const agent of agentStore.list()) {
                    if (!Array.isArray(agent.tools) || !agent.tools.includes(toolId)) continue;
                    agentStore.save({
                        ...agent,
                        tools: agent.tools.filter((reference) => reference !== toolId)
                    });
                    changed = true;
                }
                if (!changed) return;
                // Re-publish the cell the rail reads: pruning the persisted rows alone
                // would keep showing the stale count until the page is reloaded.
                cells.agents.set(Object.freeze(agentStore.list()));
            };

            /**
             * chat.tool.delete — removes the PERSISTED entry, then re-reads the
             * registry. A native id survives the removal (see the header note), so
             * the selection is cleared only once the row is genuinely gone.
             */
            api.command<string, void>(CHAT_TOOL_DELETE_COMMAND, (id) => {
                if (!id) return;
                // Online, a catalogue row cannot be removed at all (the host owns
                // it), so only a coded row's own id reaches the server delete.
                if (cells.mode.get() === 'online') {
                    const sessionId = cells.activeSessionId.get();

                    if (sessionId !== null) {
                        void deleteHarnessSessionTool(sessionId, id).then(
                            () => {
                                if (alive) void publishServerTools();
                            },
                            (reason: unknown) => {
                                if (!alive) return;
                                const message = reason instanceof Error ? reason.message : String(reason);

                                api.emit(CHAT_ERROR_EVENT, { message } satisfies NoticeEvent);
                            }
                        );
                    }
                }
                store.remove(id);
                publishTools();
                const stillListed = store.list().some((tool) => tool.id === id);
                if (cells.activeToolId.get() === id && !stillListed) cells.activeToolId.set(null);
                // Only a row that actually LEFT the registry may be pruned from the
                // agents: a native tool is still provided by the runtime, so the id is
                // still resolvable and the reference is not stale.
                if (!stillListed) pruneAgentReferences(id);
            });

            return () => {
                alive = false;
                onModeChange();
                onSessionChange();
            };
        }
    };
}

/** The default-configured tools plugin. */
export const toolsPlugin: DashboardPlugin = createToolsPlugin();
