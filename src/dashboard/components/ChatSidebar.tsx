// ChatSidebar — the whole sidebar column of the workstation skin.
//
// It is the sidebar region's single owner (one component per region, see
// `pickRegionOwner` in src/dashboard/WorkstationShell.tsx), and it carries ONE
// registry: Chat (conversations). The Agent / Tool / Settings tabs are gone, so the
// rail paints no tab strip and reads nothing off `chat.sidebarTab` any more — that
// cell still drives the ASIDE column (components/ChatInspector.tsx), which
// `chat.agent.create` / `chat.tool.create` keep moving (plugins/agents.ts:177,
// plugins/tools.ts:279).
//
// BEHAVIOR ORACLE (read-only): src/components/ChatAssistantApp.tsx
//   - sidebar entries + overlaid delete sibling      4282-4317
//   - scrim BEFORE the rail so the drawer paints above it  4510-4512
//   - the drawer is static on md+ and fixed below md (the
//     `Sidebar` styledComponent, 406-427, and its z-index trap)
//   (the oracle's tab strip + tab content, 4508-4620, is the half this rail dropped)
//
// STATE / COMMAND USAGE — `chat.drawerOpen` is written DIRECTLY, and that is
// deliberate: contract.ts registers it as state but publishes NO `chat.drawer.set`
// command id, and the core throws `unknown-command` for anything unregistered (see
// packages/underload/dashboard/src/extensions/registries.ts:77). Every other
// mutation in this file goes through `instance.execute(...)` with a contract id.
// The `writeCell` helper below is the single place to change when the core worker
// adds that command id.
//
// The list chrome is shared with the registries the board still serves, so it stays
// one presentational board (./SessionsBoard) rather than a copy per registry.
import type { DashboardState } from '@underload/dashboard';
import {
    CHAT_ACTIVE_SESSION_STATE,
    CHAT_DRAWER_OPEN_STATE,
    CHAT_SESSION_CREATE_COMMAND,
    CHAT_SESSION_DELETE_COMMAND,
    CHAT_SESSION_RENAME_COMMAND,
    CHAT_SESSION_SELECT_COMMAND,
    CHAT_SESSIONS_STATE,
    CHAT_STATUS_STATE,
    type ChatSession,
    type ChatStatus
} from '../contract';
import { useDashboardValue } from '../state-hooks';
import { useWorkbench } from '../workbench';
import { SessionsBoard, type BoardEntry } from './SessionsBoard';
// The viewport seam is owned by the chat core (src/dashboard/viewport.ts): it
// reports 'mobile' below the 900px md gate AND retracts `chat.drawerOpen` on the
// crossing back to desktop, which is exactly what the rail needs.
import { useViewport } from '../viewport';
import { MenuIcon } from '../../icons';

/** Sidebar chrome labels — kept together so the copy stays consistent. */
const COPY = {
    conversations: 'Conversations',
    emptyChats: 'No chats yet.',
    newChat: 'New chat',
    deleteConversation: 'Delete conversation'
} as const;

/**
 * One-line summary for a conversation row: "12 messages · complete" — exactly
 * the metadata the oracle puts under each sidebar title
 * (ChatAssistantApp.tsx:4300).
 */
const sessionMeta = (session: ChatSession): string => `${session.messageCount} messages · ${session.status}`;

/**
 * Write a view-owned state cell directly. See the header note: only the cell with
 * no command id uses this.
 */
function writeCell<T>(setter: DashboardState<T>, value: T): void {
    setter.set(value);
}

export function ChatSidebar() {
    const instance = useWorkbench();

    // ——— state ————————————————————————————————————————————————————————————
    const sessions = useDashboardValue<readonly ChatSession[]>(CHAT_SESSIONS_STATE);
    const activeSessionId = useDashboardValue<string | null>(CHAT_ACTIVE_SESSION_STATE);
    const drawerOpen = useDashboardValue<boolean>(CHAT_DRAWER_OPEN_STATE);
    const status = useDashboardValue<ChatStatus>(CHAT_STATUS_STATE);

    // ——— derived ——————————————————————————————————————————————————————————
    const viewport = useViewport();
    const mobile = viewport === 'mobile';
    // Deletion owns its own guard so a second delete cannot race the active one,
    // but provider waiting/streaming must NOT grey the rail
    // (oracle 4305-4308: only `deleting()` disables the "x").
    const busy = status === 'saving';

    const sessionEntries: BoardEntry[] = sessions.map((session) => ({
        id: session.conversationId,
        title: session.title,
        meta: sessionMeta(session),
        selected: session.conversationId === activeSessionId,
        disabled: busy
    }));

    // ——— mutations ————————————————————————————————————————————————————————
    const closeDrawer = () => {
        if (!drawerOpen) return;
        writeCell(instance.state<boolean>(CHAT_DRAWER_OPEN_STATE), false);
    };

    const selectSession = (sessionId: string) => {
        instance.execute<string>(CHAT_SESSION_SELECT_COMMAND, sessionId);
        // Selecting a conversation on a phone dismisses the drawer (oracle
        // 3325: selectChat closes `sidebarOpen`), so the transcript is what the
        // tap lands on.
        closeDrawer();
    };

    return (
        /* THE MOBILE SHAPE (this column owns the sidebar region): the owner is a
           FRAGMENT — control, scrim, drawer — and that order is load-bearing. The
           toggle and the scrim are SIBLINGS of `.rail`, never children of it: the
           drawer carries `transform: translateX(-105%)` (sessions.css:353-378), and
           a transformed box is the containing block of every fixed descendant, so a
           control nested inside it would slide off-screen with the panel instead of
           staying pinned to the phone bar's corner. Below the 900px seam
           styles/base.css takes the whole region out of the grid flow, which is what
           anchors these three fixed boxes to the viewport. Above the seam the toggle
           is `display: none`, the scrim is never rendered, and the rail is a static
           column whose `data-open` is inert — the desktop tree is unchanged. */
        <>
            {/* The drawer toggle only appears below the md breakpoint
                (sessions.css hides it on desktop, where the rail is a static
                column and `data-open` is ignored). It is the top-left corner
                control of the one-line phone bar. */}
            <button
                type="button"
                className="rail__menu btn btn--ghost btn--icon"
                aria-expanded={drawerOpen}
                aria-controls="sidebar"
                aria-label="Toggle conversations"
                data-testid="sidebar-toggle"
                onClick={() => writeCell(instance.state<boolean>(CHAT_DRAWER_OPEN_STATE), !drawerOpen)}
            >
                <MenuIcon size={16} />
            </button>

            {/* Scrim BEFORE the rail in DOM order, exactly like the oracle
                (4510-4512): the drawer paints above its own scrim, and the
                scrim only exists to dismiss it. */}
            {mobile && drawerOpen ? (
                <button
                    type="button"
                    className="rail__scrim"
                    aria-label="Close conversations"
                    data-testid="sidebar-scrim"
                    onClick={closeDrawer}
                />
            ) : null}

            {/* `id="sidebar"` backs the toggle's `aria-controls` above; the testid
                stays the selector the suite uses. */}
            <div
                className="rail"
                id="sidebar"
                data-open={drawerOpen}
                data-mobile={mobile}
                data-testid="sidebar"
            >
                {/* NO HEAD LINE. The column used to open with a "Rail" caption — a label
                    naming the layout slot, not the content — above the board's own
                    "Conversations" heading; the caption and its `.rail__bar` row are gone
                    (sessions.css dropped both rules with it), so the panel starts at that
                    heading.
                    One registry, so no tab strip: the body below is the conversations
                    board plus its footer control. `role="region"` replaces the
                    `tabpanel` role the dropped strip used to make meaningful, and it is
                    what still names the panel now that no caption element is left. */}
                <div className="rail__body" role="region" aria-label="Conversations">
                    <SessionsBoard
                        heading={COPY.conversations}
                        entries={sessionEntries}
                        emptyLabel={COPY.emptyChats}
                        emptyTestId="empty-chat-list"
                        listTestId="sidebar-list-chat"
                        deleteLabel={COPY.deleteConversation}
                        entryTestId={(entry) => `session-entry-${entry.id}`}
                        deleteTestId={(entry) => `session-delete-${entry.id}`}
                        renameTestId={(entry) => `session-rename-${entry.id}`}
                        selectLabel={(entry) => `Open ${entry.title}`}
                        onSelect={selectSession}
                        onDelete={(sessionId) => instance.execute<string>(CHAT_SESSION_DELETE_COMMAND, sessionId)}
                        onRename={(sessionId, title) =>
                            instance.execute(CHAT_SESSION_RENAME_COMMAND, { sessionId, title })
                        }
                    />
                    <div className="rail__footer">
                        <button
                            type="button"
                            className="btn btn--accent"
                            aria-label={COPY.newChat}
                            data-testid="new-chat-button"
                            onClick={() => {
                                instance.execute<void, string>(CHAT_SESSION_CREATE_COMMAND);
                                closeDrawer();
                            }}
                        >
                            {COPY.newChat}
                        </button>
                    </div>
                </div>
            </div>
        </>
    );
}
