// ChatSidebar: the conversation registry, the row structure rule, and the drawer.
//
// The row structure rule is the one this file exists to pin (behavior oracle
// ChatAssistantApp.tsx:4282-4317): every entry is a positioning context holding
// the SELECT control and the DELETE control as SIBLINGS — nesting them would be
// invalid HTML and a delete click would bubble into a chat selection.
//
// The rail carries ONE registry now: the conversations board. The Agent / Tool /
// Settings tabs (and the tab strip that held them) are gone, so this file also pins
// that nothing else renders in the column and that `chat.sidebarTab` — which only the
// aside still reads — cannot pull another surface into the rail.
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentDefinition, ToolDefinition } from '../../agents';
import {
    CHAT_DRAWER_OPEN_STATE,
    CHAT_SESSIONS_STATE,
    CHAT_SIDEBAR_TAB_STATE,
    type ChatSession
} from '../contract';
import { ChatSidebar } from './ChatSidebar';
import { makeSession, renderWithHarness, stubViewport, type HarnessSeed } from './test-harness';

afterEach(() => {
    cleanup();
});

const SESSIONS: ChatSession[] = [
    makeSession('conv-1', 'Release notes', { messageCount: 4, status: 'complete' }),
    makeSession('conv-2', 'Draft ideas', { messageCount: 1, status: 'pending' })
];

const AGENTS: AgentDefinition[] = [
    {
        id: 'pirate',
        name: 'Pirate',
        systemPrompt: 'Arr, speak like a pirate.',
        messages: [
            { role: 'user', content: 'Ahoy' },
            { role: 'assistant', content: 'Arr' }
        ],
        tools: ['web-search', 'interpreter']
    }
];

const TOOLS: ToolDefinition[] = [
    { id: 'web-search', name: 'Web search', native: true },
    { id: 'chart', name: 'Chart', native: false, language: 'typescript', code: 'export const run = () => 1;' }
];

const SEED: HarnessSeed = { sessions: SESSIONS, activeSessionId: 'conv-1', agents: AGENTS, tools: TOOLS };

describe('the rail shell', () => {
    it('renders the conversation registry as the rail\'s only surface', () => {
        renderWithHarness(<ChatSidebar />, SEED);
        const rail = screen.getByTestId('sidebar');
        expect(rail.className).toBe('rail');
        // The board is there, and nothing else: no agent grid, no tool grid, no
        // settings readout.
        expect(screen.getByTestId('session-entry-conv-1')).not.toBeNull();
        expect(screen.queryByTestId('agent-entry-pirate')).toBeNull();
        expect(screen.queryByTestId('tool-entry-web-search')).toBeNull();
        expect(screen.queryByTestId('sidebar-settings')).toBeNull();
    });

    it('drops the tab strip with the dropped registries', () => {
        renderWithHarness(<ChatSidebar />, SEED);
        // The `sidebar-tab-{tab}` grammar (contract.ts) has no producer any more.
        expect(document.querySelectorAll('[data-testid^="sidebar-tab-"]')).toHaveLength(0);
    });

    it('ignores the tab cell, which the aside owns and the rail no longer reads', () => {
        const view = renderWithHarness(<ChatSidebar />, SEED);
        for (const tab of ['agent', 'tool', 'settings'] as const) {
            act(() => view.write<unknown>(CHAT_SIDEBAR_TAB_STATE, tab));
            // The conversations board stays put whatever the aside is showing, and it
            // mutates through no command the rail invented.
            expect(screen.getByTestId('session-entry-conv-1')).not.toBeNull();
            expect(screen.queryByTestId('agent-entry-pirate')).toBeNull();
            expect(screen.queryByTestId('tool-entry-web-search')).toBeNull();
            expect(screen.queryByTestId('sidebar-settings')).toBeNull();
            expect([...view.calls.keys()]).toEqual([]);
        }
    });
});

describe('the chat registry', () => {
    it('lists every conversation with its title and "N messages · status" metadata', () => {
        renderWithHarness(<ChatSidebar />, SEED);
        const first = screen.getByTestId('session-entry-conv-1');
        expect(first.querySelector('.rail__title')?.textContent).toBe('Release notes');
        expect(first.querySelector('.rail__meta')?.textContent).toBe('4 messages · complete');
        expect(screen.getByTestId('session-entry-conv-2').querySelector('.rail__meta')?.textContent).toBe(
            '1 messages · pending'
        );
        // The open conversation is marked for assistive tech, not just coloured.
        expect(first.querySelector('.rail__item')?.getAttribute('aria-current')).toBe('true');
        expect(
            screen.getByTestId('session-entry-conv-2').querySelector('.rail__item')?.getAttribute('aria-current')
        ).toBeNull();
    });

    it('selects a conversation through chat.session.select', () => {
        const view = renderWithHarness(<ChatSidebar />, SEED);
        fireEvent.click(screen.getByTestId('session-entry-conv-2').querySelector('.rail__item') as Element);
        expect(view.callsOf('chat.session.select')).toEqual(['conv-2']);
    });

    it('puts the delete affordance BESIDE the select control, never inside it', () => {
        renderWithHarness(<ChatSidebar />, SEED);
        const entry = screen.getByTestId('session-entry-conv-1');
        const select = entry.querySelector('.rail__item') as Element;
        const remove = screen.getByTestId('session-delete-conv-1');
        // A nested <button> would both be invalid HTML and bubble the click into a
        // selection, so nothing but the row's own label lives inside the select.
        expect(select.contains(remove)).toBe(false);
        expect(select.querySelector('button')).toBeNull();
        // The controls sit in a group that is a SIBLING of the select control, both
        // children of the positioned row.
        const group = entry.querySelector('.rail__actions') as Element;
        expect(group.parentElement).toBe(entry);
        expect(select.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(remove.parentElement).toBe(group);
        expect(entry.querySelectorAll('button')).toHaveLength(3); // select + rename + delete
    });

    it('deletes through chat.session.delete with the conversation id', () => {
        const view = renderWithHarness(<ChatSidebar />, SEED);
        fireEvent.click(screen.getByTestId('session-delete-conv-2'));
        expect(view.callsOf('chat.session.delete')).toEqual(['conv-2']);
        // Deleting never selects the row it deletes.
        expect(view.callsOf('chat.session.select')).toEqual([]);
    });

    it('renames inline: the row editor commits on Enter through chat.session.rename', () => {
        const view = renderWithHarness(<ChatSidebar />, SEED);
        fireEvent.click(screen.getByTestId('session-rename-conv-1'));
        const editor = screen.getByTestId('rename-entry-conv-1');
        expect(editor.getAttribute('contenteditable')).toBe('true');
        expect(editor.getAttribute('aria-multiline')).toBe('false');
        expect(editor.textContent).toBe('Release notes');
        editor.textContent = 'Ship notes';
        fireEvent.keyDown(editor, { key: 'Enter' });
        expect(view.callsOf('chat.session.rename')).toEqual([{ sessionId: 'conv-1', title: 'Ship notes' }]);
        // The row is a select control again once the rename finished.
        expect(screen.getByTestId('session-entry-conv-1').querySelector('.rail__item')).not.toBeNull();
    });

    it('aborts a rename on Escape without touching storage', () => {
        const view = renderWithHarness(<ChatSidebar />, SEED);
        fireEvent.click(screen.getByTestId('session-rename-conv-2'));
        const editor = screen.getByTestId('rename-entry-conv-2');
        editor.textContent = 'thrown away';
        fireEvent.keyDown(editor, { key: 'Escape' });
        expect(view.callsOf('chat.session.rename')).toEqual([]);
        expect(screen.getByTestId('session-entry-conv-2').querySelector('.rail__title')?.textContent).toBe(
            'Draft ideas'
        );
    });

    it('creates a chat through chat.session.create', () => {
        const view = renderWithHarness(<ChatSidebar />, SEED);
        fireEvent.click(screen.getByTestId('new-chat-button'));
        expect(view.callsOf('chat.session.create')).toEqual([undefined]);
    });

    it('says so when the registry is empty', () => {
        renderWithHarness(<ChatSidebar />, { ...SEED, sessions: [] });
        expect(screen.getByTestId('empty-chat-list').textContent).toBe('No chats yet.');
        expect(document.querySelectorAll('[data-testid^="session-entry-"]')).toHaveLength(0);
    });

    it('drops the list rows when the store list changes', () => {
        const view = renderWithHarness(<ChatSidebar />, SEED);
        act(() => view.write<readonly ChatSession[]>(CHAT_SESSIONS_STATE, [SESSIONS[1] as ChatSession]));
        expect(screen.queryByTestId('session-entry-conv-1')).toBeNull();
        expect(screen.getByTestId('session-entry-conv-2')).not.toBeNull();
    });

    it('disables the row controls while a save owns the record', () => {
        renderWithHarness(<ChatSidebar />, { ...SEED, status: 'saving' });
        expect((screen.getByTestId('session-delete-conv-1') as HTMLButtonElement).disabled).toBe(true);
        expect(
            (screen.getByTestId('session-entry-conv-1').querySelector('.rail__item') as HTMLButtonElement).disabled
        ).toBe(true);
    });

    it('leaves the rows live while a reply is merely generating', () => {
        renderWithHarness(<ChatSidebar />, { ...SEED, status: 'sending' });
        expect((screen.getByTestId('session-delete-conv-1') as HTMLButtonElement).disabled).toBe(false);
    });
});

describe('the registries the rail no longer carries', () => {
    it('renders no agent, tool or settings surface even when the seed is full', () => {
        renderWithHarness(<ChatSidebar />, {
            ...SEED,
            sidebarTab: 'agent',
            usage: { total_tokens: 991 }
        });
        expect(screen.queryByTestId(/^agent-entry-/)).toBeNull();
        expect(screen.queryByTestId(/^tool-entry-/)).toBeNull();
        expect(screen.queryByTestId('empty-agent-list')).toBeNull();
        expect(screen.queryByTestId('empty-tool-list')).toBeNull();
        expect(screen.queryByTestId('sidebar-settings')).toBeNull();
        expect(screen.queryByTestId('autoscroll-toggle')).toBeNull();
    });
});

describe('the mobile drawer', () => {
    it('pins the control and the scrim OUTSIDE the drawer box, on the bar line', () => {
        // WHY STRUCTURE, NOT CSS: `.rail` carries `transform: translateX(-105%)`
        // below the seam (styles/sessions.css), and a transformed box is the
        // containing block of every fixed descendant — a control nested inside the
        // panel would slide off-screen with it instead of staying in the bar's
        // top-left corner. The stylesheet is invisible to this suite, so the DOM
        // shape the stylesheet depends on is what gets pinned.
        const restore = stubViewport('mobile');
        try {
            renderWithHarness(<ChatSidebar />, { ...SEED, drawerOpen: true });
            const rail = screen.getByTestId('sidebar');
            const toggle = screen.getByTestId('sidebar-toggle');
            const scrim = screen.getByTestId('sidebar-scrim');

            expect(toggle.closest('.rail')).toBeNull();
            expect(scrim.closest('.rail')).toBeNull();
            // DOM order is control, scrim, panel: the drawer paints above its own
            // dismiss target (the oracle's rule, ChatAssistantApp.tsx:4510-4512).
            expect(toggle.compareDocumentPosition(scrim)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
            expect(scrim.compareDocumentPosition(rail)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
            // The control addresses the panel it gates.
            expect(toggle.getAttribute('aria-controls')).toBe('sidebar');
            expect(toggle.getAttribute('aria-expanded')).toBe('true');
            // NO HEAD LINE: the "Rail" caption and its `.rail__bar` row are gone, so the
            // panel opens on the board's own heading. `role="region"` on `.rail__body` is
            // what names the panel now, and it is the rail's accessible name, not a caption.
            expect(rail.querySelector('.rail__bar')).toBeNull();
            expect(rail.querySelector('.rail__label')).toBeNull();
            expect(screen.queryByText('Rail')).toBeNull();
            expect(rail.querySelector('.rail__body')?.getAttribute('aria-label')).toBe(
                'Conversations'
            );
            expect(
                rail.querySelector('.rail__body > .rail__heading .rail__heading-text')?.textContent
            ).toBe('Conversations');
            // The heading is the panel's FIRST box, i.e. the line the caption used to sit above.
            expect(rail.firstElementChild?.className).toBe('rail__body');
        } finally {
            restore();
        }
    });

    it('slides the rail in and out through chat.drawerOpen', () => {
        const restore = stubViewport('mobile');
        try {
            const view = renderWithHarness(<ChatSidebar />, SEED);
            const rail = screen.getByTestId('sidebar');
            expect(rail.getAttribute('data-open')).toBe('false');
            fireEvent.click(screen.getByTestId('sidebar-toggle'));
            expect(view.read<boolean>(CHAT_DRAWER_OPEN_STATE)).toBe(true);
            expect(rail.getAttribute('data-open')).toBe('true');
            const scrim = screen.getByTestId('sidebar-scrim');
            fireEvent.click(scrim);
            expect(view.read<boolean>(CHAT_DRAWER_OPEN_STATE)).toBe(false);
            expect(screen.queryByTestId('sidebar-scrim')).toBeNull();
        } finally {
            restore();
        }
    });

    it('retracts an open drawer when the viewport crosses back to desktop', () => {
        // The seam's own contract (viewport.ts:92-103): a widened window must not
        // keep an invisible overlay latched on. Restoring the stub removes
        // `matchMedia`, which the seam reports as DESKTOP; the write below is the
        // re-render that lets `useSyncExternalStore` observe the new snapshot.
        let restore = stubViewport('mobile');
        try {
            const view = renderWithHarness(<ChatSidebar />, { ...SEED, drawerOpen: true });
            expect(screen.getByTestId('sidebar-scrim')).toBeTruthy();
            expect(screen.getByTestId('sidebar').getAttribute('data-open')).toBe('true');

            restore();
            act(() => view.write<readonly ChatSession[]>(CHAT_SESSIONS_STATE, [...SESSIONS]));

            expect(view.read<boolean>(CHAT_DRAWER_OPEN_STATE)).toBe(false);
            expect(screen.getByTestId('sidebar').getAttribute('data-open')).toBe('false');
            expect(screen.queryByTestId('sidebar-scrim')).toBeNull();
            // The column itself keeps rendering — only the overlay went away.
            expect(screen.getByTestId('sidebar-list-chat')).toBeTruthy();

            restore = stubViewport('mobile');
        } finally {
            restore();
        }
    });

    it('dismisses itself when the tap picked a conversation or started a chat', () => {
        const restore = stubViewport('mobile');
        try {
            const view = renderWithHarness(<ChatSidebar />, { ...SEED, drawerOpen: true });
            fireEvent.click(screen.getByTestId('session-entry-conv-2').querySelector('.rail__item') as Element);
            expect(view.read<boolean>(CHAT_DRAWER_OPEN_STATE)).toBe(false);
            expect(view.callsOf('chat.session.select')).toEqual(['conv-2']);

            act(() => view.write<boolean>(CHAT_DRAWER_OPEN_STATE, true));
            fireEvent.click(screen.getByTestId('new-chat-button'));
            expect(view.read<boolean>(CHAT_DRAWER_OPEN_STATE)).toBe(false);
            expect(view.callsOf('chat.session.create')).toEqual([undefined]);
        } finally {
            restore();
        }
    });

    it('has no scrim and no toggle above the grid breakpoint, where the rail is a static column', () => {
        const restore = stubViewport('desktop');
        try {
            const view = renderWithHarness(<ChatSidebar />, SEED);
            expect(screen.queryByTestId('sidebar-scrim')).toBeNull();
            // The open cell is inert on desktop: CSS ignores it, so nothing renders.
            act(() => view.write<boolean>(CHAT_DRAWER_OPEN_STATE, true));
            expect(screen.queryByTestId('sidebar-scrim')).toBeNull();
            expect(screen.getByTestId('sidebar').getAttribute('data-open')).toBe('true');
            // Selecting a conversation never dispatches a drawer command either.
            fireEvent.click(screen.getByTestId('session-entry-conv-2').querySelector('.rail__item') as Element);
            expect([...view.calls.keys()]).toEqual(['chat.session.select']);
        } finally {
            restore();
        }
    });
});
