// ChatInspector: the aside column's tab-following surface AND its phone drawer.
//
// WHAT THIS FILE PINS (R3, the phone shell): below the 900px seam the inspector is
// the station's SECOND off-canvas panel, mirrored from the rail. The assertions are
// structural and cell-exact, never CSS — no test in this suite can see a stylesheet
// (vitest stubs CSS requests), so the two things that CAN be pinned are the cell the
// control writes and the DOM shape the CSS depends on:
//
//   1. the toggle and the scrim are SIBLINGS of `.inspector`, not descendants. That
//      is not cosmetic: the panel carries `transform: translateX(105%)`
//      (styles/base.css, `max-width: 899px`), and a transformed box is the
//      containing block of every fixed descendant, so a control nested inside it
//      would ride the panel off-screen instead of staying on the bar's corner;
//   2. `chat.asideOpen` is the single source of truth — the control writes the cell
//      directly (contract.ts publishes no `chat.aside.set` command id), the scrim
//      clears it, and the viewport seam clears it on the crossing back to desktop.
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
 *  `hint` field: the hint line is the rail tab the column is following, so it is one
 *  of 'chat' / 'settings' depending on the cell, and the body no longer offers
 *  "Settings" as something to edit here (T3 moved configuration to the header). */
const IDLE = {
    title: 'Inspector',
    body: "This column follows the rail. Pick Agent or Tool to edit that registry here; configuration is in the header's Settings dialog."
} as const;

const SEED: HarnessSeed = {};

describe('the surface the rail selects', () => {
    it('renders the idle panel for the chat tab, with the drawer shut', () => {
        const view = renderWithHarness(<ChatInspector />, SEED);
        const panel = screen.getByTestId('aside-panel');
        expect(panel.className).toBe('inspector');
        // Both drawer flags are cell-driven and default closed.
        expect(panel.getAttribute('data-open')).toBe('false');
        // jsdom ships no matchMedia, which the seam documents as DESKTOP.
        expect(panel.getAttribute('data-mobile')).toBe('false');
        expect(view.read<boolean>(CHAT_ASIDE_OPEN_STATE)).toBe(false);

        // The quiet panel keeps the shell's descriptor chrome, exactly.
        expect(screen.getByTestId('inspector-idle').getAttribute('aria-label')).toBe('Inspector');
        expect(screen.getByTestId('inspector-idle').querySelector('.panel__title')?.textContent).toBe(
            IDLE.title
        );
        expect(screen.getByTestId('inspector-idle').querySelector('.panel__hint')?.textContent).toBe(
            'chat'
        );
        expect(screen.getByTestId('inspector-idle').querySelector('.panel__empty')?.textContent).toBe(
            IDLE.body
        );
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
            // The idle panel belongs to the two tabs with nothing to edit here.
            expect(screen.queryByTestId('inspector-idle')).toBeNull();
        }
        act(() => view.write<SidebarTab>(CHAT_SIDEBAR_TAB_STATE, 'chat'));
        expect(screen.getByTestId('inspector-idle')).toBeTruthy();
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
    it('opens and closes chat.asideOpen through the top-right control', () => {
        const restore = stubViewport('mobile');
        try {
            const view = renderWithHarness(<ChatInspector />, SEED);
            const panel = screen.getByTestId('aside-panel');
            const toggle = screen.getByTestId('aside-toggle');

            // THE CONTROL LIVES OUTSIDE THE PANEL (see the header note): it is a
            // sibling, and the panel's own tree is unchanged by the drawer chrome.
            expect(toggle.closest('.inspector')).toBeNull();
            expect(toggle.className).toBe('inspector__menu btn btn--ghost btn--icon');
            expect(toggle.getAttribute('aria-expanded')).toBe('false');
            expect(toggle.getAttribute('aria-controls')).toBe('aside-panel');
            expect(toggle.getAttribute('aria-label')).toBe('Toggle inspector');

            fireEvent.click(toggle);
            expect(view.read<boolean>(CHAT_ASIDE_OPEN_STATE)).toBe(true);
            expect(panel.getAttribute('data-open')).toBe('true');
            expect(toggle.getAttribute('aria-expanded')).toBe('true');
            // The scrim is the only dismiss target, and it too is a sibling.
            const scrim = screen.getByTestId('aside-scrim');
            expect(scrim.closest('.inspector')).toBeNull();
            expect(scrim.getAttribute('aria-label')).toBe('Close inspector');

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

        // A click still lands on desktop (the control is CSS-hidden there, but the
        // test cannot see CSS), and the seam's auto-close clears the flag again.
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
