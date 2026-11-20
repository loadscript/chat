// ChatInspector — the ASIDE region's slot contribution (T6, the real surface).
//
// WHAT IT IS: the workstation's inspector column. One owner per region (see
// pickRegionOwner in ../WorkstationShell.tsx), and this column's content follows
// whichever registry the rail is showing, so the operator edits in one place what
// they picked in the other. The tab is read from `chat.sidebarTab` (registered by
// plugins/core.ts, written by ChatSidebar's tab strip and by `chat.agent.create` /
// `chat.tool.create` — plugins/agents.ts:94, plugins/tools.ts:134 — which is how
// creating an agent or a tool moves the aside onto it without any cross-plugin
// call).
//
// THE FOUR CASES (contract.ts's `SidebarTab` vocabulary, exhaustive):
//   'agent'    -> AgentWorkspace   (registry list + prompt editor + tool toggles)
//   'tool'     -> ToolInspector    (registry grid + source editor)
//   'settings' -> StationSettings  (mode + offline base + skin switches)
//   'chat'     -> the quiet panel below: a conversation has no inspector. The
//                 transcript's own details (usage, model, tokens) already live in
//                 the composer's `token-usage` row and the rail's Settings tab, so
//                 inventing a fourth conversation panel here would duplicate a
//                 surface that already exists — the oracle's own aside equivalent
//                 renders nothing for the Chat tab (its aside tabs are Agent /
//                 Tool / Settings only).
//
// WHY A WRAPPER RATHER THAN THREE CONTRIBUTIONS: the shell keeps the LAST
// contribution of a channel, so three contributions in `layout.aside` would leave
// three owners and two invisible. One wrapper also gives the column its contract
// testid (`aside-panel`, see the grammar in ../contract.ts:46) and the
// `.inspector` flex column (styles/base.css, "Region owners") that lets each
// feature surface keep its own root class (`.agents` / `.tools` / `.settings`),
// which those files' rules already size.
//
// THE PHONE DRAWER (R3, added with the mobile shell redesign): at or below 899px
// this column is the station's SECOND off-canvas panel — the right-hand twin of the
// rail's drawer — because a phone has no third column to give it. The open flag is
// the core's `chat.asideOpen` cell (default false, and retracted on the crossing
// back to desktop by the effect below, exactly as viewport.ts does for
// `chat.drawerOpen`); the control, the scrim and the panel are emitted as a
// fragment for the containing-block reason documented at the render site. Desktop
// renders the same three lines it always did: the control is `display: none` there
// and the scrim is never in the tree.
import { useEffect } from 'react';
import {
    CHAT_ASIDE_OPEN_STATE,
    CHAT_SIDEBAR_TAB_STATE,
    type SidebarTab
} from '../contract';import { useDashboardValue } from '../state-hooks';
import { useWorkbench } from '../workbench';
import { AgentWorkspace } from './AgentWorkspace';
import { StationSettings } from './StationSettings';
import { ToolInspector } from './ToolInspector';
// The SAME seam the rail's drawer uses: 'mobile' below `(min-width: 900px)`, which
// is exactly where styles/base.css turns this column into an off-canvas panel
// (base.css:397 and the `.inspector` block inside it) and where the aside's
// auto-close gate lives.
import { useViewport } from '../viewport';
import { ChevronRightIcon } from '../../icons';

/** The idle panel's copy — one place, so the wording stays consistent. */
const IDLE = {
    title: 'Inspector',
    hint: 'chat',
    body: 'This column follows the rail. Pick Agent, Tool or Settings to edit that registry here.'
} as const;

/**
 * The surface for one rail tab. Total by construction: `SidebarTab` is a closed
 * union, so a new tab value is a compile error here instead of a blank column.
 */
const surfaceFor = (tab: SidebarTab) => {
    if (tab === 'agent') return <AgentWorkspace />;
    if (tab === 'tool') return <ToolInspector />;
    if (tab === 'settings') return <StationSettings />;
    // 'chat': the quiet panel. Reuses the shell's descriptor chrome classes
    // (`.panel*`, styles/base.css:218-258) because that is exactly the state they
    // were built for — a column with a title and nothing registered in it.
    return (
        <section className="panel" data-testid="inspector-idle" aria-label="Inspector">
            <header className="panel__head">
                <h2 className="panel__title">{IDLE.title}</h2>
                <span className="panel__hint">{IDLE.hint}</span>
            </header>
            <div className="panel__body">
                <p className="panel__empty">{IDLE.body}</p>
            </div>
        </section>
    );
};

export function ChatInspector() {
    const instance = useWorkbench();
    const tab = useDashboardValue<SidebarTab>(CHAT_SIDEBAR_TAB_STATE);
    // The phone drawer's flag. Written DIRECTLY, exactly like ChatSidebar writes
    // `chat.drawerOpen` (see the header note there): contract.ts publishes no
    // `chat.aside.set` command id, and the core throws `unknown-command` for an
    // unregistered id.
    const asideOpen = useDashboardValue<boolean>(CHAT_ASIDE_OPEN_STATE);
    const viewport = useViewport();
    const mobile = viewport === 'mobile';

    // AUTO-CLOSE ON THE CROSSING TO DESKTOP — the same contract viewport.ts:92-103
    // holds for `chat.drawerOpen`: a flag that stays true while the column is a
    // static grid track latches an invisible overlay on the widened window. The
    // write is by id inside a try/catch because a dashboard disposed mid-effect
    // (Fast Refresh, StrictMode's double setup) throws `disposed` on any cell
    // access, and SameValueZero makes the repeat write a no-op, so the effect needs
    // no extra guard beyond the flag itself.
    useEffect(() => {
        if (mobile || !asideOpen) return;
        try {
            instance.state<boolean>(CHAT_ASIDE_OPEN_STATE).set(false);
        } catch {
            // Ignored: the instance is gone.
        }
    }, [instance, mobile, asideOpen]);

    /** Closes the drawer; a no-op when it is already shut. */
    const closeAside = () => {
        if (!asideOpen) return;
        instance.state<boolean>(CHAT_ASIDE_OPEN_STATE).set(false);
    };

    return (
        /* THE MOBILE SHAPE, identical in kind to the rail's (see ChatSidebar): a
           FRAGMENT of control, scrim, panel. The control and the scrim must be
           SIBLINGS of `.inspector`, never children — the panel carries
           `transform: translateX(105%)` (styles/base.css), and a transformed box is
           the containing block of its fixed descendants, which would slide the
           control off-screen with the panel. Above the 900px seam the control is
           `display: none`, the scrim is never rendered, and the fragment's only
           box is the static column the desktop grid always rendered. */
        <>
            <button
                type="button"
                className="inspector__menu btn btn--ghost btn--icon"
                aria-expanded={asideOpen}
                aria-controls="aside-panel"
                aria-label="Toggle inspector"
                data-testid="aside-toggle"
                onClick={() =>
                    instance.state<boolean>(CHAT_ASIDE_OPEN_STATE).set(!asideOpen)
                }
            >
                {/* The right-hand twin of the rail's MenuIcon: a chevron pointing at
                    the edge the panel slides out of. */}
                <ChevronRightIcon size={16} />
            </button>

            {/* Scrim BEFORE the panel in DOM order, like the rail's: the drawer
                paints above its own dismiss target (z 20 over z 10 in base.css), and
                the scrim only exists to close it. */}
            {mobile && asideOpen ? (
                <button
                    type="button"
                    className="inspector__scrim"
                    aria-label="Close inspector"
                    data-testid="aside-scrim"
                    onClick={closeAside}
                />
            ) : null}

            <div
                className="inspector"
                // `id` backs the toggle's `aria-controls` above — the reference has
                // to resolve to a real element or the ARIA relationship is dead.
                id="aside-panel"
                // `data-open` is inert above the seam (the panel is a static column
                // there), exactly like the rail's.
                data-open={asideOpen}
                data-mobile={mobile}
                data-testid="aside-panel"
            >
                {surfaceFor(tab)}
            </div>
        </>
    );
}
