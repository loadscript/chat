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
//   'agent'    -> AgentWorkspace     (registry list + prompt editor + tool toggles)
//   'tool'     -> ToolInspector      (registry grid + source editor)
//   'chat'     -> ConversationInspector (the rail's DEFAULT tab): the live phase of the
//                 agentic run behind the transcript — `chat.status`, the queued user
//                 turn, the partial reply — and the conversation's own detail (model,
//                 agent, attached tools, token counters, transport, follow-output).
//                 It replaced a quiet placeholder panel here: that panel assumed the
//                 rail still had Settings-tab readouts to defer to, and the rail lost
//                 its tabs, so the column was explaining itself instead of informing.
//   'settings' -> the quiet panel below. It used to render StationSettings, and that
//                 is exactly why it does not any more: the header's Settings dialog
//                 (./SettingsDialog.tsx) is now the one configuration editor, and an
//                 editable copy of the same mode/base controls here would put two
//                 editors of one cell on screen at the same time. The rail's Settings
//                 TAB is untouched — its read-only status readout (activity, turns,
//                 model, tokens, follow-output) is what ConversationInspector carries
//                 for the Chat tab now.
//
// WHY A WRAPPER RATHER THAN THREE CONTRIBUTIONS: the shell keeps the LAST
// contribution of a channel, so three contributions in `layout.aside` would leave
// three owners and two invisible. One wrapper also gives the column its contract
// testid (`aside-panel`, see the grammar in ../contract.ts:46) and the
// `.inspector` flex column (styles/base.css, "Region owners") that lets each
// feature surface keep its own root class (`.agents` / `.tools`), which those
// files' rules already size.
//
// THE PHONE DRAWER (R3, added with the mobile shell redesign): at or below 899px
// this column is the station's SECOND off-canvas panel — the twin of the rail's
// drawer, and it opens off the SAME (left) edge, by request — because a phone has no
// third column to give it. It no longer hangs from the right edge: `left: 0` +
// `translateX(-105%)` (styles/base.css, `max-width: 899px`), and it starts BELOW the
// one-line bar (`inset-block: var(--mobile-bar) 0`) rather than running under it
// behind a run of empty `padding-top`, so the readout's head sits flush on the bar's
// hairline instead of under a padding band. The open flag is the core's
// `chat.asideOpen` cell (default false, and retracted on the crossing back
// to desktop by the effect below, exactly as viewport.ts does for `chat.drawerOpen`).
// ITS CONTROL IS NOT IN THIS FILE: the corner chevron the column used to pin to the
// phone bar's top-right corner is gone by request, and the composer's token counter
// (`token-usage`, ./ComposerDeck.tsx) is what opens the drawer — one line of copy doing
// two jobs, instead of a bare glyph floating over the column. What is left here is the
// scrim and the panel, as a FRAGMENT for the containing-block reason documented at the
// render site; `aside-panel`'s id backs the composer's `aria-controls`, and ids are
// document-global, so that reference crosses the region boundary legally. Desktop
// renders the same static column it always did — the drawer flag is inert above the seam.
import { useEffect } from 'react';
import {
    CHAT_ASIDE_OPEN_STATE,
    CHAT_SIDEBAR_TAB_STATE,
    type SidebarTab
} from '../contract';import { useDashboardValue } from '../state-hooks';
import { useWorkbench } from '../workbench';
import { AgentWorkspace } from './AgentWorkspace';
import { ConversationInspector } from './ConversationInspector';
import { ToolInspector } from './ToolInspector';
// The SAME seam the rail's drawer uses: 'mobile' below `(min-width: 900px)`, which
// is exactly where styles/base.css turns this column into an off-canvas panel
// (base.css:397 and the `.inspector` block inside it) and where the aside's
// auto-close gate lives.
import { useViewport } from '../viewport';

/**
 * The idle panel's copy — one place, so the wording stays consistent. `hint` is NOT
 * part of it: the hint line names the rail tab the column is following, and since the
 * Chat tab grew a real surface (./ConversationInspector.tsx), the only tab left that
 * lands here is 'settings' — the hint stays the cell value rather than a literal so a
 * future tab that also has nothing to edit here prints its own name.
 */
const IDLE = {
    title: 'Inspector',
    body: "This column follows the rail. Pick Agent or Tool to edit that registry here; configuration is in the header's Settings dialog."
} as const;

/**
 * The surface for one rail tab. Total by construction: `SidebarTab` is a closed
 * union, so a new tab value is a compile error here instead of a blank column.
 */
const surfaceFor = (tab: SidebarTab) => {
    if (tab === 'agent') return <AgentWorkspace />;
    if (tab === 'tool') return <ToolInspector />;
    // 'chat' is the conversation readout (./ConversationInspector): the live phase of
    // the agentic run behind the transcript plus the session's model / agent / tool /
    // token detail. It is the rail's DEFAULT tab, so it is what the column shows on
    // every normal visit, and the numbers it prints are the ones the rail's Settings
    // tab used to carry before the rail lost its tabs.
    if (tab === 'chat') return <ConversationInspector />;
    // 'settings' lands here: a deliberate hand-off to the header's dialog (see the
    // header note). It reuses the shell's descriptor chrome classes (`.panel*`,
    // styles/base.css:218-258) because that is exactly the state they were built for —
    // a column with a title and nothing registered in it.
    return (
        <section className="panel" data-testid="inspector-idle" aria-label="Inspector">
            <header className="panel__head">
                <h2 className="panel__title">{IDLE.title}</h2>
                <span className="panel__hint">{tab}</span>
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
           FRAGMENT of scrim, panel. The scrim has to be a SIBLING of `.inspector`,
           never a child — the panel carries `transform: translateX(-105%)`
           (styles/base.css), and a transformed box is the containing block of its
           fixed descendants, which would slide the scrim off-screen with the panel.
           Above the 900px seam the scrim is never rendered at all, and the fragment's
           only box is the static column the desktop grid always rendered.
           NO TOGGLE IN THIS TREE. The drawer's control is the composer's token counter
           (`token-usage`, ./ComposerDeck.tsx): it lives in the stage region, writes the
           same `chat.asideOpen` cell, and `aria-controls` this panel's id. The corner
           chevron that used to be pinned above the column is gone. The scrim is
           therefore the dismiss target: while the drawer is open it covers the viewport
           — the counter included — so a tap anywhere off the panel shuts it. */
        <>
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
                // `id` backs the composer counter's `aria-controls` (./ComposerDeck.tsx) —
                // the reference has to resolve to a real element, or the ARIA relationship
                // across the two regions is dead.
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
