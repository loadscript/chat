// ComposerDeck: the keyboard rules, the height contract, and the command payloads.
//
// Every expectation is derived from the pre-rebuild oracle
// (src/components/ChatAssistantApp.tsx): the Enter/Shift+Enter/IME gate
// (5179-5192 + the header rule at 123-126), the border-box autogrow math
// (2421-2439), the focus-gated send arrow (5081-5090, 5222-5241), the always
// visible mic (5205-5221) and the token counter (5169-5171 — now the right-hand tail
// of the picker line, `<count> Tokens`, instead of its own `Total tokens: N` row).
//
// ONE THING IS NOT FROM THE ORACLE: below the 900px seam that same counter is the
// inspector drawer's control (`chat.asideOpen`), because the aside's corner chevron was
// removed. The `describe` at the end of this file pins it, cell and ARIA wiring
// included, on both sides of the seam.
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentDefinition } from '../../agents';
import {
    CHAT_ASIDE_OPEN_STATE,
    CHAT_AGENT_SET_COMMAND,
    CHAT_AUTOSCROLL_STATE,
    CHAT_DRAFT_SET_COMMAND,
    CHAT_DRAFT_STATE,
    CHAT_LISTENING_STATE,
    CHAT_MESSAGE_CANCEL_COMMAND,
    CHAT_MESSAGE_SEND_COMMAND,
    CHAT_MODEL_SET_COMMAND,
    CHAT_USAGE_STATE
} from '../contract';
import { ComposerDeck, resizeComposerField } from './ComposerDeck';
import { renderWithHarness, stubViewport, type HarnessSeed } from './test-harness';

afterEach(() => {
    cleanup();
});

const CATALOG = ['vultr/coder', 'modal/glm-5.3-flash'];
const PROVIDER_SEED: HarnessSeed = {
    models: CATALOG,
    providerCatalog: CATALOG,
    providerLabels: ['coder (vultr)', 'glm-5.3-flash (modal)'],
    model: 'vultr/coder'
};

const AGENTS: AgentDefinition[] = [
    { id: 'pirate', name: 'Pirate', systemPrompt: 'Arr', messages: [], tools: ['web-search'] }
];

/** The one-row outer height jsdom measures: fallback line box + no padding + 1px frame x2. */
const ONE_ROW_HEIGHT = '24.4px';

describe('draft typing', () => {
    it('publishes every keystroke through chat.draft.set verbatim', () => {
        const view = renderWithHarness(<ComposerDeck />, PROVIDER_SEED);
        fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'Hello\nthere' } });
        expect(view.callsOf(CHAT_DRAFT_SET_COMMAND)).toEqual(['Hello\nthere']);
    });

    it('grows from the state, not from the browser default (rows=1 + border-box math)', () => {
        renderWithHarness(<ComposerDeck />, PROVIDER_SEED);
        const field = screen.getByTestId('composer-input') as HTMLTextAreaElement;
        // `rows="1"` is present, and the first measurement floors at the one-row
        // OUTER height (22.4 line box + 0 measured padding + the 2px frame), which
        // is exactly what keeps an empty composer from locking at two rows.
        expect(field.getAttribute('rows')).toBe('1');
        expect(field.style.height).toBe(ONE_ROW_HEIGHT);
    });

    it('keeps the field in sync when the draft changes without a keystroke', () => {
        const view = renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, draft: 'restored draft' });
        const field = screen.getByTestId('composer-input') as HTMLTextAreaElement;
        expect(field.value).toBe('restored draft');
        expect(field.style.height).toBe(ONE_ROW_HEIGHT);
        act(() => {
            view.write<string>(CHAT_DRAFT_STATE, '');
        });
        expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('');
    });
});

describe('resizeComposerField (the height contract, measured geometry)', () => {
    const field = () => {
        const element = document.createElement('textarea');
        document.body.append(element);
        return element;
    };

    it('counts the 1px frame back onto scrollHeight, so the box is never 2px short', () => {
        const element = field();
        Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 100 });
        resizeComposerField(element);
        expect(element.style.height).toBe('102px');
        element.remove();
    });

    it('caps the visible editor at eight rows', () => {
        const element = field();
        Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 5000 });
        resizeComposerField(element);
        // 22.4 * 8 rows + 0 padding + the 2px frame.
        expect(element.style.height).toBe('181.2px');
        element.remove();
    });

    it('shrinks back to exactly one row after a deletion', () => {
        const element = field();
        element.style.height = '400px';
        Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 0 });
        resizeComposerField(element);
        expect(element.style.height).toBe(ONE_ROW_HEIGHT);
        element.remove();
    });
});

describe('Enter to send (desktop) and the newline rules', () => {
    it('submits on Enter at the md breakpoint and suppresses the newline', () => {
        const restore = stubViewport('desktop');
        const view = renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, draft: 'ship it' });
        const field = screen.getByTestId('composer-input');
        try {
            expect(fireEvent.keyDown(field, { key: 'Enter', shiftKey: false })).toBe(false);
            expect(view.callsOf(CHAT_MESSAGE_SEND_COMMAND)).toEqual([undefined]);
        } finally {
            restore();
        }
    });

    it('leaves Shift+Enter as a newline', () => {
        const restore = stubViewport('desktop');
        const view = renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, draft: 'ship it' });
        try {
            expect(fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter', shiftKey: true })).toBe(
                true
            );
            expect(view.callsOf(CHAT_MESSAGE_SEND_COMMAND)).toEqual([]);
        } finally {
            restore();
        }
    });

    it('never submits while an IME composition is confirming a candidate', () => {
        const restore = stubViewport('desktop');
        const view = renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, draft: 'にほん' });
        try {
            fireEvent.keyDown(screen.getByTestId('composer-input'), {
                key: 'Enter',
                shiftKey: false,
                isComposing: true
            });
            expect(view.callsOf(CHAT_MESSAGE_SEND_COMMAND)).toEqual([]);
        } finally {
            restore();
        }
    });

    it('leaves Enter as a newline below the md breakpoint, where the button submits', () => {
        const restore = stubViewport('mobile');
        const view = renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, draft: 'ship it' });
        try {
            expect(fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter', shiftKey: false })).toBe(
                true
            );
            expect(view.callsOf(CHAT_MESSAGE_SEND_COMMAND)).toEqual([]);
        } finally {
            restore();
        }
    });

    it('refuses to send an empty draft, even on Enter', () => {
        const restore = stubViewport('desktop');
        const view = renderWithHarness(<ComposerDeck />, PROVIDER_SEED);
        try {
            fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter', shiftKey: false });
            expect(view.callsOf(CHAT_MESSAGE_SEND_COMMAND)).toEqual([]);
        } finally {
            restore();
        }
    });

    it('submits through the form as well, without navigating', () => {
        const view = renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, draft: 'via form' });
        expect(fireEvent.submit(screen.getByTestId('composer'))).toBe(false);
        expect(view.callsOf(CHAT_MESSAGE_SEND_COMMAND)).toEqual([undefined]);
    });
});

describe('the focus-gated send arrow', () => {
    it('does not exist until focus enters the composer', () => {
        renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, draft: 'typed' });
        expect(screen.queryByTestId('send-button')).toBeNull();
    });

    it('appears on focus, disabled while the draft is blank', () => {
        renderWithHarness(<ComposerDeck />, PROVIDER_SEED);
        fireEvent.focus(screen.getByTestId('composer-input'));
        const send = screen.getByTestId('send-button') as HTMLButtonElement;
        expect(send.type).toBe('submit');
        expect(send.disabled).toBe(true);
    });

    it('arms itself once there is content, and clicking it sends', () => {
        const view = renderWithHarness(<ComposerDeck />, PROVIDER_SEED);
        const field = screen.getByTestId('composer-input');
        fireEvent.focus(field);
        fireEvent.change(field, { target: { value: 'ready' } });
        const send = screen.getByTestId('send-button') as HTMLButtonElement;
        expect(send.disabled).toBe(false);
        fireEvent.click(send);
        expect(view.callsOf(CHAT_MESSAGE_SEND_COMMAND)).toEqual([undefined]);
    });

    it('stays mounted while focus moves between the field, the arrow and the select', () => {
        renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, draft: 'typed' });
        const field = screen.getByTestId('composer-input');
        fireEvent.focus(field);
        // focus moves field -> model select: relatedTarget is still inside the form
        fireEvent.blur(field, { relatedTarget: screen.getByTestId('model-select') });
        expect(screen.getByTestId('send-button')).not.toBeNull();
        // focus leaves the composer entirely
        fireEvent.blur(screen.getByTestId('model-select'), { relatedTarget: null });
        expect(screen.queryByTestId('send-button')).toBeNull();
    });
});

describe('the stop control while a reply is generating', () => {
    it('replaces the arrow with a cancel control that dispatches chat.message.cancel', () => {
        const view = renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, status: 'sending', draft: 'asked' });
        const stop = screen.getByTestId('cancel-button') as HTMLButtonElement;
        expect(stop.disabled).toBe(false);
        expect(stop.getAttribute('aria-label')).toBe('Stop generating reply');
        fireEvent.click(stop);
        expect(view.callsOf(CHAT_MESSAGE_CANCEL_COMMAND)).toEqual([undefined]);
        expect(view.callsOf(CHAT_MESSAGE_SEND_COMMAND)).toEqual([]);
    });

    it('ignores Enter while a reply is in flight (one send at a time)', () => {
        const restore = stubViewport('desktop');
        const view = renderWithHarness(<ComposerDeck />, {
            ...PROVIDER_SEED,
            status: 'sending',
            streaming: 'partial',
            draft: 'another question'
        });
        try {
            fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter', shiftKey: false });
            expect(view.callsOf(CHAT_MESSAGE_SEND_COMMAND)).toEqual([]);
        } finally {
            restore();
        }
    });
});

describe('token usage and pickers', () => {
    it('prints the session token counter, and zero when the session has none', () => {
        const view = renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, usage: { total_tokens: 1234 } });
        expect(screen.getByTestId('token-usage').textContent).toBe('1234 Tokens');
        act(() => view.write(CHAT_USAGE_STATE, null));
        expect(screen.getByTestId('token-usage').textContent).toBe('0 Tokens');
    });

    it('tracks the counter with the usage cell instead of freezing a number', () => {
        // The number is `chat.usage.total_tokens`, live: a usage frame arriving
        // mid-session repaints the line, which is what a hardcoded value would not.
        const view = renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, usage: { total_tokens: 7925 } });
        expect(screen.getByTestId('token-usage').textContent).toBe('7925 Tokens');
        act(() => view.write(CHAT_USAGE_STATE, { total_tokens: 8412 }));
        expect(screen.getByTestId('token-usage').textContent).toBe('8412 Tokens');
    });

    it('sits on the picker line as its right-hand track, with no label row of its own', () => {
        // R2's structural half: the counter is the LAST track of `.composer__meta`,
        // the same flex row as the pickers, and composer.css gives that last track
        // `margin-left: auto` (asserted in styles/skin.test.ts) — so it reads flush
        // right on the metadata line rather than as a `TOTAL TOKENS:` row.
        renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, usage: { total_tokens: 7925 } });
        const usage = screen.getByTestId('token-usage');
        const meta = usage.parentElement as HTMLElement;
        expect(meta.className).toBe('composer__meta');
        expect(Array.from(meta.children).map((child) => child.getAttribute('data-testid'))).toEqual([
            'model-picker',
            'token-usage'
        ]);
        // The count carries its own unit and no label, in that exact order. It is a
        // <button> (the phone drawer's control, see the describe below) — and it is still
        // the LAST track of the metadata row, which is the half this case pins.
        expect(usage.tagName).toBe('BUTTON');
        expect(usage.textContent).toBe('7925 Tokens');
    });

    it('aligns each option label with its catalog id and keeps the full id as the value', async () => {
        const view = renderWithHarness(<ComposerDeck />, {
            ...PROVIDER_SEED,
            models: [...CATALOG],
            providerCatalog: [...CATALOG],
            providerLabels: ['coder (vultr)', 'glm-5.3-flash (modal)'],
            model: 'modal/glm-5.3-flash'
        });
        const select = screen.getByTestId('model-select') as HTMLSelectElement;
        await waitFor(() => expect(select.value).toBe('modal/glm-5.3-flash'));
        expect(Array.from(select.options).map((option) => [option.value, option.text])).toEqual([
            ['vultr/coder', 'coder (vultr)'],
            ['modal/glm-5.3-flash', 'glm-5.3-flash (modal)']
        ]);
        expect(screen.getByTestId('model-label').textContent).toBe('glm-5.3-flash (modal)');

        fireEvent.change(select, { target: { value: 'vultr/coder' } });
        expect(view.callsOf(CHAT_MODEL_SET_COMMAND)).toEqual(['vultr/coder']);
    });

    it('lists the agent registry beside the default "None" and dispatches chat.agent.set', () => {
        const view = renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, agents: AGENTS, agent: '' });
        const select = screen.getByTestId('agent-select') as HTMLSelectElement;
        expect(Array.from(select.options).map((option) => [option.value, option.text])).toEqual([
            ['', 'None'],
            ['pirate', 'Pirate']
        ]);
        expect(screen.getByTestId('agent-label').textContent).toBe('None');
        fireEvent.change(select, { target: { value: 'pirate' } });
        expect(view.callsOf(CHAT_AGENT_SET_COMMAND)).toEqual(['pirate']);
    });

    it('shows the applied agent name as the picker text', () => {
        // The composer strip mirrors `chat.agent` — the cell `chat.agent.set` writes and
        // the one the send pipeline resolves the leading block from. `chat.activeAgentId`
        // is the Agents-tab editor's selection and is deliberately NOT what this line
        // reads, or the strip would advertise an agent the next send never applies.
        renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, agents: AGENTS, agent: 'pirate' });
        expect(screen.getByTestId('agent-label').textContent).toBe('Pirate');
        expect((screen.getByTestId('agent-select') as HTMLSelectElement).value).toBe('pirate');
    });

    it('explains an empty catalog instead of defaulting to a phantom model', () => {
        renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, models: [], providerLabels: [], model: '' });
        expect(screen.getByTestId('model-label').textContent).toBe('No models available');
        expect((screen.getByTestId('model-select') as HTMLSelectElement).disabled).toBe(true);
    });

    it('keeps a selected model that left the catalog selectable', () => {
        renderWithHarness(<ComposerDeck />, {
            ...PROVIDER_SEED,
            models: [CATALOG[1] as string],
            providerCatalog: [CATALOG[1] as string],
            providerLabels: ['glm-5.3-flash (modal)'],
            model: 'legacy/old-model'
        });
        const select = screen.getByTestId('model-select') as HTMLSelectElement;
        expect(Array.from(select.options).map((option) => option.value)).toEqual([
            'legacy/old-model',
            'modal/glm-5.3-flash'
        ]);
        expect(screen.getByTestId('model-label').textContent).toBe('old-model');
    });
});

describe('the counter doubles as the inspector drawer control below the seam', () => {
    // The aside column used to pin a chevron to the phone bar's top-right corner; that
    // glyph is gone (./ChatInspector.tsx), and the count is what opens the drawer. Both
    // sides are pinned: on a phone the element is a live disclosure writing the cell, and
    // above the seam it is the readout it always was, with nothing to open.
    it('opens and closes chat.asideOpen on a phone, writing the cell directly', () => {
        const restore = stubViewport('mobile');
        try {
            const view = renderWithHarness(<ComposerDeck />, {
                ...PROVIDER_SEED,
                usage: { total_tokens: 7925 }
            });
            const usage = screen.getByTestId('token-usage') as HTMLButtonElement;

            // ONE element, two jobs: the count is both the readout and the accessible
            // name, so an `aria-label` would have hidden the number rather than naming
            // the control, and `type="button"` keeps it out of the form's submit path.
            expect(usage.tagName).toBe('BUTTON');
            expect(usage.type).toBe('button');
            expect(usage.disabled).toBe(false);
            expect(usage.textContent).toBe('7925 Tokens');
            expect(usage.getAttribute('aria-expanded')).toBe('false');
            // The panel lives in the other region; ids are document-global, so the
            // reference resolves to the `aside-panel` ChatInspector renders.
            expect(usage.getAttribute('aria-controls')).toBe('aside-panel');
            expect(usage.getAttribute('title')).toBe('Toggle inspector');

            fireEvent.click(usage);
            expect(view.read<boolean>(CHAT_ASIDE_OPEN_STATE)).toBe(true);
            expect(usage.getAttribute('aria-expanded')).toBe('true');

            fireEvent.click(usage);
            expect(view.read<boolean>(CHAT_ASIDE_OPEN_STATE)).toBe(false);
            expect(usage.getAttribute('aria-expanded')).toBe('false');

            // A cell write, never a dispatch: contract.ts registers `chat.asideOpen` as
            // state and publishes no command id for it, so anything executed here would
            // throw `unknown-command`.
            expect([...view.calls.keys()]).toEqual([]);
        } finally {
            restore();
        }
    });

    it('stays a readout above the seam, where the column is a static grid track', () => {
        // jsdom ships no `matchMedia`, and the seam documents that as DESKTOP.
        const view = renderWithHarness(<ComposerDeck />, PROVIDER_SEED);
        const usage = screen.getByTestId('token-usage') as HTMLButtonElement;

        expect(usage.disabled).toBe(true);
        // No disclosure semantics on an element that cannot disclose anything.
        expect(usage.getAttribute('aria-expanded')).toBeNull();
        expect(usage.getAttribute('aria-controls')).toBeNull();
        expect(usage.getAttribute('title')).toBeNull();
        // The number still reads, which is the whole point of the line.
        expect(usage.textContent).toBe('0 Tokens');

        // A click that somehow lands (scripted, not user) opens nothing: the drawer flag
        // is inert above the seam, and a set flag would latch an invisible overlay.
        fireEvent.click(usage);
        expect(view.read<boolean>(CHAT_ASIDE_OPEN_STATE)).toBe(false);
        expect([...view.calls.keys()]).toEqual([]);
    });
});

describe('the keyboard hint line is gone', () => {
    it('renders no help line beside the input', () => {
        renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, draft: 'typed' });
        // R1: the copy, the element and its class are ALL absent. The strongest form
        // of the assertion is the composer's own child list: metadata line, then the
        // input box, and nothing under it.
        expect(screen.queryByText('Enter sends, Shift+Enter adds a newline')).toBeNull();
        expect(document.querySelector('.composer__help')).toBeNull();
        const form = screen.getByTestId('composer');
        expect(Array.from(form.children).map((child) => child.className)).toEqual([
            'composer__meta',
            'composer__field'
        ]);
    });

    it('keeps it out while a reply generates, where the stop control carries the copy', () => {
        // The old help line doubled as a "Generating —" notice. That copy went with
        // the hint: the cancel control states it through its own accessible name.
        renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, status: 'sending', draft: 'asked' });
        expect(document.querySelector('.composer__help')).toBeNull();
        expect(screen.queryByText(/Generating/)).toBeNull();
        expect(screen.getByTestId('cancel-button').getAttribute('title')).toBe('Stop generating reply');
    });
});

describe('voice control', () => {
    it('starts recognition when idle', () => {
        const view = renderWithHarness(<ComposerDeck />, PROVIDER_SEED);
        const button = screen.getByTestId('voice-button') as HTMLButtonElement;
        expect(button.getAttribute('aria-pressed')).toBe('false');
        expect(button.getAttribute('aria-label')).toBe('Start voice input');
        // The mic is NOT focus-gated: it exists before the composer has focus.
        expect(screen.queryByTestId('send-button')).toBeNull();
        fireEvent.click(button);
        expect(view.callsOf('chat.voice.start')).toEqual([undefined]);
        expect(view.callsOf('chat.voice.stop')).toEqual([]);
    });

    it('stops recognition while listening, keeping the partial transcript', () => {
        const view = renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, listening: true, draft: 'spoken words' });
        const button = screen.getByTestId('voice-button') as HTMLButtonElement;
        expect(button.getAttribute('aria-pressed')).toBe('true');
        expect(button.getAttribute('aria-label')).toBe('Stop voice input');
        fireEvent.click(button);
        expect(view.callsOf('chat.voice.stop')).toEqual([undefined]);
        // Stopping never touches the draft: the words stay for review/send.
        expect(view.read<string>(CHAT_LISTENING_STATE)).toBe(true);
        expect(view.callsOf(CHAT_DRAFT_SET_COMMAND)).toEqual([]);
    });
});

describe('the composer mutates nothing but the draft, the send and the voice session', () => {
    it('leaves the follow-output cell for the stage to own', () => {
        const view = renderWithHarness(<ComposerDeck />, { ...PROVIDER_SEED, autoscroll: false, draft: 'typed' });
        fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'typed more' } });
        fireEvent.click(screen.getByTestId('voice-button'));
        expect(view.read<boolean>(CHAT_AUTOSCROLL_STATE)).toBe(false);
        expect(view.callsOf('chat.autoscroll.toggle')).toEqual([]);
        expect(view.callsOf('chat.composer.focus')).toEqual([]);
        // Exactly the two dispatches the composer is allowed to make.
        expect([...view.calls.keys()]).toEqual([CHAT_DRAFT_SET_COMMAND, 'chat.voice.start']);
    });
});
