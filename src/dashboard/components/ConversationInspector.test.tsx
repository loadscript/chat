// ConversationInspector: the aside column's Chat-tab readout, pinned from cells.
//
// WHAT THIS FILE PINS, and why nothing else does: the column used to render a
// sentence about following the rail, which no test could contradict because it asserted
// nothing about the conversation. The surface now prints TWELVE cell projections, so
// the assertions are exact per row — a projection that silently switches to another
// cell (the `chat.agent` / `chat.activeAgentId` pair is the standing temptation, and
// `chat.transcript` / `chat.sessions[].messageCount` the second) has to fail here
// naming the row.
//
// THE RULES THIS SURFACE IS BUILT ON, pinned below:
//   1. READ-ONLY. No control in the panel: model and agent have their editor in the
//      composer's strip, mode and provider base in the header's dialog, follow-output
//      in the stage. Two editors of one cell is the bug this column already removed
//      once (ChatInspector.tsx's header note for the 'settings' tab).
//   2. THE COMPOSER'S LABEL, not a second one. The model row goes through
//      ./ModelPicker's `useModelLabels`, so the provider-aligned label appears here
//      exactly when it appears in the picker, and the stripped-name fallback covers an
//      id outside the live catalog.
//   3. THE PHASE IS A WORD. `chat.status` renders as a label plus `data-status` /
//      `data-busy`; the tinted in-flight block appears only while a TURN is in flight
//      — queued user text or streamed reply text — so the column never paints a panel
//      whose only content is the phase word the head already printed.
//   4. NO CLOCK. `chat.pending.at` is unread here on purpose: an elapsed line needs a
//      timer, and the char count of `chat.streaming` says "progress is happening"
//      without one.
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
    CHAT_AUTOSCROLL_STATE,
    CHAT_PENDING_STATE,
    CHAT_STATUS_STATE,
    CHAT_STREAMING_STATE,
    CHAT_TRANSCRIPT_STATE,
    CHAT_USAGE_STATE
} from '../contract';
import { ConversationInspector } from './ConversationInspector';
import { makeSession, renderWithHarness, type HarnessSeed } from './test-harness';

afterEach(() => {
    cleanup();
});

/** The value line of one readout row. */
const rowValue = (key: string): string =>
    screen.getByTestId(`inspector-row-${key}`).querySelector('dd')?.textContent ?? '';

/** The label line of one readout row. */
const rowLabel = (key: string): string =>
    screen.getByTestId(`inspector-row-${key}`).querySelector('dt')?.textContent ?? '';

/** An open conversation with the provider catalog, an agent, tools and usage. */
const RICH: HarnessSeed = {
    sessions: [makeSession('c-1', 'Refactor the loader', { messageCount: 6 })],
    activeSessionId: 'c-1',
    transcript: [
        { role: 'user', content: 'Split the loader' },
        { role: 'assistant', content: 'Here is the split.' }
    ],
    models: ['modal/glm-5.3-flash', 'vultr/glm-5.3-flash'],
    providerCatalog: ['modal/glm-5.3-flash', 'vultr/glm-5.3-flash'],
    providerLabels: ['glm-5.3-flash (modal)', 'glm-5.3-flash (vultr)'],
    model: 'vultr/glm-5.3-flash',
    agents: [
        {
            id: 'scout',
            name: 'Scout',
            systemPrompt: 'Sweep first',
            messages: [],
            tools: ['web_search', 'interpret_code']
        }
    ],
    // The composer's prefix choice — NOT `chat.activeAgentId`, which is the row open
    // in the Agents tab and must not show up here.
    agent: 'scout',
    activeAgentId: null,
    usage: { prompt_tokens: 120, completion_tokens: 42, total_tokens: 162 },
    mode: 'offline',
    autoscroll: false,
    listening: true
};

describe('the idle column', () => {
    it('names the phase, the missing conversation and every zero counter', () => {
        const view = renderWithHarness(<ConversationInspector />, {});
        const panel = screen.getByTestId('inspector-chat');

        expect(panel.getAttribute('aria-label')).toBe('Conversation inspector');
        expect(panel.querySelector('.panel__title')?.textContent).toBe('Conversation');

        // THE HEAD: the contract's status word, plus the two attributes the skin reads
        // the colour off. Idle is not busy, so the dot does not pulse.
        const activity = screen.getByTestId('inspector-activity');
        expect(activity.textContent).toBe('Idle');
        expect(activity.getAttribute('data-status')).toBe('idle');
        expect(activity.getAttribute('data-busy')).toBe('false');

        // Nothing running, nothing failed: no accent block, no danger line.
        expect(screen.queryByTestId('inspector-live')).toBeNull();
        expect(screen.queryByTestId('inspector-error')).toBeNull();

        // Every row prints its empty-surface value, and the label is the copy the
        // column promises (CSS uppercases it; the DOM keeps it readable).
        expect(rowLabel('session')).toBe('Conversation');
        expect(rowValue('session')).toBe('No conversation');
        expect(rowValue('messages')).toBe('0');
        expect(rowValue('model')).toBe('None');
        expect(rowValue('agent')).toBe('None');
        expect(rowValue('tools')).toBe('None');
        expect(rowValue('mode')).toBe('online');
        expect(rowValue('prompt-tokens')).toBe('0');
        expect(rowValue('reply-tokens')).toBe('0');
        expect(rowValue('total-tokens')).toBe('0');
        expect(rowValue('follow')).toBe('on');
        expect(rowValue('voice')).toBe('off');

        // A conversation that does not exist gets no id row: 'None' under 'No
        // conversation' would state one fact twice.
        expect(screen.queryByTestId('inspector-row-id')).toBeNull();

        // A readout dispatches nothing.
        expect([...view.calls.keys()]).toEqual([]);
    });

    it('renders no control anywhere, because every value has its own editor', () => {
        renderWithHarness(<ConversationInspector />, RICH);
        const panel = screen.getByTestId('inspector-chat');
        expect(panel.querySelectorAll('button, input, select, textarea')).toHaveLength(0);
    });
});

describe('the open conversation', () => {
    it('reads title, id, counts, model label, agent and tokens off their own cells', async () => {
        renderWithHarness(<ConversationInspector />, RICH);

        // The provider labels resolve asynchronously (chat.provider.labels()), so the
        // model row starts on the locally stripped name and lands on the catalog-aligned
        // label — the same two steps the composer's picker goes through. Waiting for it
        // is the point: the column must follow that resolution, never invent its own.
        await waitFor(() => expect(rowValue('model')).toBe('glm-5.3-flash (vultr)'));

        expect(rowValue('session')).toBe('Refactor the loader');
        expect(rowValue('id')).toBe('c-1');
        // `chat.transcript`, NOT the sidebar row's `messageCount`: the row says 6 and
        // the open conversation holds 2, and the transcript is what the stage renders.
        expect(rowValue('messages')).toBe('2');
        expect(rowValue('model')).toBe('glm-5.3-flash (vultr)');
        expect(rowValue('agent')).toBe('Scout');
        expect(rowValue('tools')).toBe('2 attached');
        expect(rowValue('mode')).toBe('offline');
        expect(rowValue('prompt-tokens')).toBe('120');
        expect(rowValue('reply-tokens')).toBe('42');
        expect(rowValue('total-tokens')).toBe('162');
        expect(rowValue('follow')).toBe('off');
        expect(rowValue('voice')).toBe('on');
    });

    it('follows the usage and counters cells instead of freezing its numbers', () => {
        const view = renderWithHarness(<ConversationInspector />, RICH);

        // The same live-subscription rule the composer's counter is pinned by: a usage
        // frame arriving mid-session repaints the column.
        act(() => view.write(CHAT_USAGE_STATE, { prompt_tokens: 900, completion_tokens: 90, total_tokens: 990 }));
        expect(rowValue('total-tokens')).toBe('990');

        act(() => view.write(CHAT_USAGE_STATE, null));
        expect(rowValue('total-tokens')).toBe('0');

        act(() => view.write(CHAT_TRANSCRIPT_STATE, [{ role: 'user', content: 'one' }]));
        expect(rowValue('messages')).toBe('1');

        act(() => view.write(CHAT_AUTOSCROLL_STATE, true));
        expect(rowValue('follow')).toBe('on');
    });

    it('keeps the id of a registry row that vanished under the surface', () => {
        // An agent id the registry no longer holds is still the choice the next send
        // honours, so the row prints the id rather than claiming 'None'.
        renderWithHarness(<ConversationInspector />, { ...RICH, agent: 'gone', agents: [] });
        expect(rowValue('agent')).toBe('gone');
        expect(rowValue('tools')).toBe('None');
    });

    it('strips the provider prefix for an id outside the live catalog', () => {
        // `useModelLabels` falls back to the stripped name for any id missing from the
        // catalog — a historical conversation's model still names itself.
        renderWithHarness(<ConversationInspector />, {
            ...RICH,
            models: [],
            providerCatalog: [],
            providerLabels: [],
            model: 'zai-org/GLM-5.2-NVFP4'
        });
        expect(rowValue('model')).toBe('GLM-5.2-NVFP4');
    });
});

describe('the work in flight', () => {
    it('shows the phase, the queued turn and the partial reply of a running send', () => {
        renderWithHarness(<ConversationInspector />, {
            status: 'sending',
            pending: { text: 'Summarise this log', at: 1_700_000_000_000 },
            streaming: 'Par'
        });

        const activity = screen.getByTestId('inspector-activity');
        expect(activity.textContent).toBe('Streaming reply');
        expect(activity.getAttribute('data-status')).toBe('sending');
        expect(activity.getAttribute('data-busy')).toBe('true');

        const live = screen.getByTestId('inspector-live');
        expect(live.getAttribute('data-status')).toBe('sending');
        expect(live.querySelector('.inspector__live-label')?.textContent).toBe('Streaming reply');
        // The queued text is verbatim — the operator reads WHICH send is in flight.
        expect(screen.getByTestId('inspector-pending').textContent).toBe('Summarise this log');
        // The only progress signal: a length, not an elapsed clock.
        expect(screen.getByTestId('inspector-streaming').textContent).toBe('Partial reply: 3 chars');
    });

    it('names a background read in the head alone, with no block repeating it', () => {
        // A session read has no queued user text and no streamed answer, so the phase
        // word in the head is the whole signal. The tinted block is for a TURN in
        // flight — the duplicate "Reading session" under "Reading session" is what the
        // browser showed and this pins cannot come back.
        renderWithHarness(<ConversationInspector />, { status: 'loading' });

        const activity = screen.getByTestId('inspector-activity');
        expect(activity.textContent).toBe('Reading session');
        expect(activity.getAttribute('data-busy')).toBe('true');
        expect(screen.queryByTestId('inspector-live')).toBeNull();
    });

    it('keeps the phase honest when streamed text outlives the status', () => {
        // `chat.streaming` is the truth about the buffer; the head may already be back
        // to 'idle' while an aborted partial answer is still on screen.
        renderWithHarness(<ConversationInspector />, { status: 'idle', streaming: 'half an answer' });

        expect(screen.getByTestId('inspector-activity').textContent).toBe('Idle');
        expect(screen.getByTestId('inspector-activity').getAttribute('data-busy')).toBe('false');
        expect(screen.getByTestId('inspector-live')).toBeTruthy();
        expect(screen.getByTestId('inspector-streaming').textContent).toBe('Partial reply: 14 chars');
    });

    it('calls a queued turn with a settled status "In flight", never "Idle"', () => {
        // The gap between the send and the first status write: the block is visible
        // because user text is queued, so a phase word of 'Idle' would contradict the
        // very text under it.
        renderWithHarness(<ConversationInspector />, {
            status: 'idle',
            pending: { text: 'still queued', at: 1 }
        });

        expect(screen.getByTestId('inspector-activity').textContent).toBe('Idle');
        expect(screen.getByTestId('inspector-live').querySelector('.inspector__live-label')?.textContent).toBe(
            'In flight'
        );
        expect(screen.getByTestId('inspector-pending').textContent).toBe('still queued');
    });

    it('prints the surfaced failure without calling it busy', () => {
        renderWithHarness(<ConversationInspector />, { status: 'error', error: 'Provider timeout' });

        const activity = screen.getByTestId('inspector-activity');
        expect(activity.textContent).toBe('Failed');
        expect(activity.getAttribute('data-status')).toBe('error');
        expect(activity.getAttribute('data-busy')).toBe('false');
        expect(screen.getByTestId('inspector-error').textContent).toBe('Provider timeout');
    });

    it('drops the block the moment the run settles back to an idle column', () => {
        const view = renderWithHarness(<ConversationInspector />, {
            status: 'sending',
            pending: { text: 'hello', at: 1 },
            streaming: 'hi'
        });
        expect(screen.getByTestId('inspector-live')).toBeTruthy();

        act(() => view.write(CHAT_STATUS_STATE, 'idle'));
        act(() => view.write(CHAT_PENDING_STATE, null));
        act(() => view.write(CHAT_STREAMING_STATE, ''));

        expect(screen.queryByTestId('inspector-live')).toBeNull();
        expect(screen.queryByTestId('inspector-pending')).toBeNull();
    });
});
