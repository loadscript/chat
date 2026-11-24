// ChatInspector: the aside column's tab-following surface AND its phone drawer.
//
// WHAT THIS FILE PINS (R3, the phone shell): below the 900px seam the inspector is
// the station's SECOND off-canvas panel, mirrored from the rail. The assertions are
// structural and cell-exact, never CSS — no test in this suite can see a stylesheet
// (vitest stubs CSS requests), so the two things that CAN be pinned are the cell the
// drawer reads and the DOM shape the CSS depends on:
//
//   1. the column contributes the PANEL and the SCRIM only, and the scrim is a
//      SIBLING of `.inspector`, never a descendant. That is not cosmetic: the panel
//      carries `transform: translateX(-105%)` (styles/base.css, `max-width: 899px`),
//      and a transformed box is the containing block of every fixed descendant, so a
//      scrim nested inside it would ride the panel off-screen instead of covering the
//      viewport;
//   2. the column owns NO control. Its corner chevron (`aside-toggle`) is gone by
//      request, and the composer's token counter is what opens the drawer — that
//      control is pinned in ./ComposerDeck.test.tsx, and both halves agree on the
//      `aside-panel` id and on `chat.asideOpen`;
//   3. `chat.asideOpen` is the single source of truth — the scrim clears it, the
//      viewport seam clears it on the crossing back to desktop, and nothing is ever
//      dispatched (contract.ts publishes no `chat.aside.set` command id).
//
// The tab->surface switch is pinned here too because nothing else in the suite
// renders ChatInspector through its own file (App.test.tsx only proves the column
// exists in the assembled graph).
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
    CHAT_ASIDE_OPEN_STATE,
    CHAT_SIDEBAR_TAB_STATE,
    type SidebarTab
} from '../contract';
import { ChatInspector } from './ChatInspector';
import { renderWithHarness, stubViewport, type HarnessSeed } from './test-harness';

afterEach(() => {
    cleanup();
});

/** The idle panel's copy, verbatim from ChatInspector.tsx — note the ABSENCE of a
 *  `hint` field: the hint line is the rail tab the column is following, and 'settings'
 *  is the only tab left that renders this panel (the Chat tab got
 *  ./ConversationInspector.tsx), so the body no longer offers "Settings" as something
 *  to edit here (T3 moved configuration to the header). */
const IDLE = {
    title: 'Inspector',
    body: "This column follows the rail. Pick Agent or Tool to edit that registry here; configuration is in the header's Settings dialog."
} as const;

const SEED: HarnessSeed = {};

describe('the surface the rail selects', () => {
    it('renders the conversation readout for the chat tab, with the drawer shut', () => {
        const view = renderWithHarness(<ChatInspector />, SEED);
        const panel = screen.getByTestId('aside-panel');
        expect(panel.className).toBe('inspector');
        // Both drawer flags are cell-driven and default closed.
        expect(panel.getAttribute('data-open')).toBe('false');
        // jsdom ships no matchMedia, which the seam documents as DESKTOP.
        expect(panel.getAttribute('data-mobile')).toBe('false');
        expect(view.read<boolean>(CHAT_ASIDE_OPEN_STATE)).toBe(false);

        // The rail's DEFAULT tab has a surface of its own now, so the column shows the
        // conversation (activity, the turn in flight, model / tools / tokens) instead of
        // explaining its own rule: see ./ConversationInspector.tsx.
        expect(screen.getByTestId('inspector-chat')).toBeTruthy();
        // ...and the quiet panel belongs to the one tab with nothing to show here.
        expect(screen.queryByTestId('inspector-idle')).toBeNull();
    });

    it('switches to the agent and tool surface the rail tab names', () => {
        const view = renderWithHarness(<ChatInspector />, SEED);
        const cases: readonly [SidebarTab, string][] = [
            ['agent', 'agent-surface'],
            ['tool', 'tool-surface']
        ];
        for (const [tab, testId] of cases) {
            act(() => view.write<SidebarTab>(CHAT_SIDEBAR_TAB_STATE, tab));
            expect(screen.getByTestId(testId)).toBeTruthy();
            // The quiet panel belongs to the one tab with nothing to edit here.
            expect(screen.queryByTestId('inspector-idle')).toBeNull();
            // Switching away from the conversation takes its readout with it: one
            // surface per column, never two stacked in the drawer.
            expect(screen.queryByTestId('inspector-chat')).toBeNull();
        }
        act(() => view.write<SidebarTab>(CHAT_SIDEBAR_TAB_STATE, 'chat'));
        expect(screen.getByTestId('inspector-chat')).toBeTruthy();
    });

    it('hands configuration over to the header: the settings tab renders no editor', () => {
        // R5: this column stopped hosting StationSettings, because the dialog in the
        // bar is the one configuration editor. The tab itself is untouched — the rail's
        // readout (`sidebar-settings`, ChatSidebar.tsx) is the rail's own tree and this
        // component never renders it — so what is pinned here is that the aside shows
        // the quiet panel for that tab and no `settings-workspace` anywhere.
        const view = renderWithHarness(<ChatInspector />, SEED);

        act(() => view.write<SidebarTab>(CHAT_SIDEBAR_TAB_STATE, 'settings'));

        expect(screen.queryByTestId('settings-workspace')).toBeNull();
        expect(screen.getByTestId('inspector-idle')).toBeTruthy();
        expect(screen.getByTestId('inspector-idle').querySelector('.panel__hint')?.textContent).toBe(
            'settings'
        );
    });
});

describe('the mobile drawer', () => {
    it('contributes no control of its own — the composer counter gates the drawer', () => {
        const restore = stubViewport('mobile');
        try {
            const view = renderWithHarness(<ChatInspector />, SEED);
            const panel = screen.getByTestId('aside-panel');

            // THE CHEVRON IS GONE. This column renders the panel and the dismiss target
            // only; the control that opens the drawer is the composer's `token-usage`
            // (pinned in ./ComposerDeck.test.tsx), and the id below is what its
            // `aria-controls` resolves against.
            expect(screen.queryByTestId('aside-toggle')).toBeNull();
            expect(document.querySelector('.inspector__menu')).toBeNull();
            expect(panel.id).toBe('aside-panel');
            expect(panel.getAttribute('data-open')).toBe('false');
            expect(panel.getAttribute('data-mobile')).toBe('true');

            // OPEN — the state the composer's click leaves the cell in. The scrim is the
            // ONLY dismiss target, and it is a SIBLING of the panel (header note 1).
            act(() => view.write<boolean>(CHAT_ASIDE_OPEN_STATE, true));
            const scrim = screen.getByTestId('aside-scrim');
            expect(scrim.closest('.inspector')).toBeNull();
            expect(scrim.getAttribute('aria-label')).toBe('Close inspector');
            expect(panel.getAttribute('data-open')).toBe('true');

            fireEvent.click(scrim);
            expect(view.read<boolean>(CHAT_ASIDE_OPEN_STATE)).toBe(false);
            expect(panel.getAttribute('data-open')).toBe('false');
            expect(screen.queryByTestId('aside-scrim')).toBeNull();

            // The cell is written directly: contract.ts has no command id for it, so
            // NOTHING may be dispatched (an unregistered id would throw).
            expect([...view.calls.keys()]).toEqual([]);
        } finally {
            restore();
        }
    });

    it('renders no scrim above the seam, where the column is a static grid track', () => {
        // jsdom ships no matchMedia, and the seam documents that as DESKTOP.
        const view = renderWithHarness(<ChatInspector />, SEED);
        expect(screen.queryByTestId('aside-scrim')).toBeNull();
        expect(screen.getByTestId('aside-panel').getAttribute('data-mobile')).toBe('false');

        // A flag set from elsewhere (the composer's counter, say) still gets cleared by
        // the seam's auto-close, so no invisible overlay can latch on the widened window.
        act(() => view.write<boolean>(CHAT_ASIDE_OPEN_STATE, true));
        expect(screen.queryByTestId('aside-scrim')).toBeNull();
        expect(view.read<boolean>(CHAT_ASIDE_OPEN_STATE)).toBe(false);
        expect(screen.getByTestId('aside-panel').getAttribute('data-open')).toBe('false');
    });

    it('retracts an open drawer when the viewport crosses back to desktop', () => {
        let restore = stubViewport('mobile');
        try {
            const view = renderWithHarness(<ChatInspector />, { asideOpen: true });
            expect(screen.getByTestId('aside-scrim')).toBeTruthy();
            expect(screen.getByTestId('aside-panel').getAttribute('data-open')).toBe('true');

            // Restoring the stub removes `matchMedia` entirely, which the seam
            // reports as desktop; the write below is the re-render that lets
            // `useSyncExternalStore` observe the new snapshot.
            restore();
            act(() => view.write<SidebarTab>(CHAT_SIDEBAR_TAB_STATE, 'settings'));

            expect(view.read<boolean>(CHAT_ASIDE_OPEN_STATE)).toBe(false);
            expect(screen.getByTestId('aside-panel').getAttribute('data-open')).toBe('false');
            expect(screen.queryByTestId('aside-scrim')).toBeNull();
            // The column itself kept rendering — only the overlay went away. (The
            // settings tab's aside content is the quiet panel; see the case above.)
            expect(screen.getByTestId('inspector-idle')).toBeTruthy();

            restore = stubViewport('mobile');
        } finally {
            restore();
        }
    });
});
