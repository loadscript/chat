// SettingsDialog: the bar's configuration popup — trigger semantics, dismissal paths,
// focus return, and the command contract of the content it hosts.
//
// WHY ITS OWN FILE (T3): the dialog is a NEW kind of surface in this package — an
// overlay whose content is another component's command wiring. The two halves need
// separate evidence:
//
//   1. `SettingsDialog` alone (plain children): the accessibility contract the brief
//      asks for — `role="dialog"`, `aria-modal`, a labelled title, a close control,
//      Escape, and backdrop dismissal — pinned without a chat graph in sight;
//   2. `SettingsDialogButton` against the local harness (./test-harness.tsx): the
//      trigger's `aria-haspopup` / `aria-expanded` state, the toggle, the focus return,
//      and the fact that the dialog's content is the SAME `StationSettings` surface —
//      same testids, same `chat.mode.set` / `chat.providerBase.set` payloads, same
//      offline-only field rule — i.e. moving configuration into a popup changed
//      nothing about how configuration works (R6).
//
// WHY FOCUS IS ASSERTED AND NOT MERELY PRESENCE: the acceptance criterion names the
// focus return explicitly, and it is the one behaviour a screenshot cannot show. The
// implementation restores focus through the OWNER's ref (SettingsDialog.tsx), which is
// why the assertion holds even though `fireEvent.click` never moves focus in jsdom.
//
// WHY THE CYCLE TESTS READ THE EVENT'S RETURN VALUE (T5): containment is a Tab that the
// DIALOG consumed, and jsdom has no tab sequencer of its own — so `fireEvent.keyDown`
// returning `false` (its native `dispatchEvent` was prevented) is the only way to tell
// "the panel took the key" from "the key is the browser's to walk", and the
// `activeElement` change is the way to tell WHERE it went. Without the panel's Tab
// handler both halves fail: the key is not prevented and focus never moves.
//
// CSS is invisible to this suite (vitest stubs every stylesheet request), so the
// overlay's geometry is pinned as text in styles/skin.test.ts instead.
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_MODE_STATE, CHAT_PROVIDER_BASE_STATE, type ChatMode } from '../contract';
import { SettingsDialog, SettingsDialogButton } from './SettingsDialog';
import { renderWithHarness, type HarnessSeed } from './test-harness';

afterEach(() => {
    cleanup();
});

const ONLINE: HarnessSeed = { mode: 'online', providerBase: '' };
const OFFLINE: HarnessSeed = { mode: 'offline', providerBase: 'http://lan.test/v1' };

describe('the dialog chrome (content-agnostic)', () => {
    it('labels the panel with its own heading and names every dismissal target', () => {
        renderWithHarness(
            <SettingsDialog title="Settings" onClose={() => undefined}>
                <p data-testid="dialog-child">content</p>
            </SettingsDialog>,
            ONLINE
        );

        const panel = screen.getByTestId('settings-dialog');
        expect(panel.getAttribute('role')).toBe('dialog');
        expect(panel.getAttribute('aria-modal')).toBe('true');
        // `tabIndex={-1}` is what lets the panel itself take focus on open.
        expect(panel.getAttribute('tabindex')).toBe('-1');

        const titleId = panel.getAttribute('aria-labelledby');
        expect(titleId).toBe('settings-dialog-title');
        const title = document.getElementById(titleId ?? '');
        expect(title?.textContent).toBe('Settings');
        // The label lives INSIDE the panel: an aria-labelledby that resolves to a node
        // outside the dialog is a broken relationship, not a name.
        expect(title !== null && panel.contains(title)).toBe(true);

        const close = screen.getByTestId('settings-dialog-close');
        expect(close.getAttribute('aria-label')).toBe('Close settings');
        const backdrop = screen.getByTestId('settings-dialog-backdrop');
        expect(backdrop.getAttribute('aria-label')).toBe('Close settings');
        // The backdrop is a SIBLING of the panel, never its wrapper: it has to cover the
        // viewport while the panel floats above it (styles/settings.css).
        expect(backdrop.parentElement).toBe(panel.parentElement);
        expect(within(panel).getByTestId('dialog-child').textContent).toBe('content');
    });

    it('closes on Escape, on the close control, and on the backdrop', () => {
        // One owner callback, three routes — each is asserted separately so a dismissal
        // path that silently stops working names itself in the failure.
        const closings: number[] = [];
        const onClose = () => {
            closings.push(1);
        };

        renderWithHarness(
            <SettingsDialog title="Settings" onClose={onClose}>
                <p>content</p>
            </SettingsDialog>,
            ONLINE
        );

        fireEvent.click(screen.getByTestId('settings-dialog-close'));
        expect(closings).toEqual([1]);

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(closings).toEqual([1, 1]);

        // Escape is bound to a DOCUMENT listener, so it reaches the dialog from anywhere
        // — including a keystroke that starts on a node outside it.
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(closings).toEqual([1, 1, 1]);

        fireEvent.click(screen.getByTestId('settings-dialog-backdrop'));
        expect(closings).toEqual([1, 1, 1, 1]);

        // An unrelated key does nothing: the listener must not eat the operator's typing.
        fireEvent.keyDown(document, { key: 'a' });
        expect(closings).toEqual([1, 1, 1, 1]);
    });

    it('takes focus on open and drops its key handler when it closes', () => {
        const closings: number[] = [];
        const view = renderWithHarness(
            <SettingsDialog
                title="Settings"
                onClose={() => {
                    closings.push(1);
                }}
            >
                <p>content</p>
            </SettingsDialog>,
            ONLINE
        );

        expect(document.activeElement).toBe(screen.getByTestId('settings-dialog'));

        // Unmounting IS this dialog's close (it is mounted-while-open), and the Escape
        // listener has to leave with it: a stale document listener would fire a dead
        // owner's onClose on every keystroke for the rest of the page's life. The panel
        // also leaves the focus tree, which is the OWNER's cue to restore focus.
        view.unmount();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(closings).toEqual([]);
        expect(document.activeElement).toBe(document.body);
    });
});

describe('the bar control that owns the dialog', () => {
    it('is an icon-only trigger that reports the popup and its open state', () => {
        renderWithHarness(<SettingsDialogButton />, ONLINE);

        const trigger = screen.getByTestId('settings-button');
        expect(trigger.tagName).toBe('BUTTON');
        expect(trigger.getAttribute('aria-label')).toBe('Settings');
        expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        // Icon-only: the gear carries no text, and its own a11y is decorative.
        expect(trigger.textContent).toBe('');
        expect(trigger.querySelector('svg[data-icon="settings"]')?.getAttribute('aria-hidden')).toBe(
            'true'
        );

        // Closed means absent: no dialog, no configuration surface in the tree.
        expect(screen.queryByTestId('settings-dialog')).toBeNull();
        expect(screen.queryByTestId('settings-workspace')).toBeNull();
    });

    it('opens the configuration surface in a modal dialog, and toggles shut', () => {
        renderWithHarness(<SettingsDialogButton />, ONLINE);
        const trigger = screen.getByTestId('settings-button');

        fireEvent.click(trigger);

        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        const panel = screen.getByTestId('settings-dialog');
        expect(panel.getAttribute('role')).toBe('dialog');
        expect(document.getElementById('settings-dialog-title')?.textContent).toBe('Settings');

        // The content is the one StationSettings surface, mounted INSIDE the panel, so
        // the dialog is a host rather than a second editor implementation.
        const workspace = within(panel).getByTestId('settings-workspace');
        expect(within(workspace).getByTestId('mode-select')).toBeTruthy();
        expect(screen.getAllByTestId('settings-workspace')).toHaveLength(1);

        fireEvent.click(trigger);
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(screen.queryByTestId('settings-dialog')).toBeNull();
    });

    it('returns focus to the trigger on every dismissal path', () => {
        // Closing must leave the caret where the operator's hand already is.
        for (const dismiss of ['close', 'escape', 'backdrop'] as const) {
            renderWithHarness(<SettingsDialogButton />, ONLINE);
            const trigger = screen.getByTestId('settings-button');

            fireEvent.click(trigger);
            expect(document.activeElement).toBe(screen.getByTestId('settings-dialog'));

            if (dismiss === 'close') {
                fireEvent.click(screen.getByTestId('settings-dialog-close'));
            } else if (dismiss === 'escape') {
                fireEvent.keyDown(document, { key: 'Escape' });
            } else {
                fireEvent.click(screen.getByTestId('settings-dialog-backdrop'));
            }

            expect(screen.queryByTestId('settings-dialog')).toBeNull();
            expect(document.activeElement).toBe(trigger);
            expect(trigger.getAttribute('aria-expanded')).toBe('false');
            cleanup();
        }
    });

    it('keeps the mode and base contract intact inside the popup', () => {
        // R6: nothing about the provider mode moved. The dispatches, the coercion, the
        // raw typed value and the offline-only rule all behave through the dialog.
        const view = renderWithHarness(<SettingsDialogButton />, ONLINE);
        fireEvent.click(screen.getByTestId('settings-button'));
        const panel = screen.getByTestId('settings-dialog');

        // Online: no base field.
        expect(within(panel).queryByTestId('provider-base-field')).toBeNull();

        fireEvent.change(within(panel).getByTestId('mode-select'), { target: { value: 'offline' } });
        expect(view.callsOf('chat.mode.set')).toEqual(['offline']);
        expect(view.read<ChatMode>(CHAT_MODE_STATE)).toBe('offline');

        const input = within(panel).getByTestId('provider-base-input') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'http:' } });
        fireEvent.change(input, { target: { value: ' http://lan.test/v1/ ' } });
        expect(view.callsOf('chat.providerBase.set')).toEqual(['http:', ' http://lan.test/v1/ ']);
        expect(view.read<string>(CHAT_PROVIDER_BASE_STATE)).toBe(' http://lan.test/v1/ ');

        // Back to online and the field is withdrawn again, without closing the popup.
        fireEvent.change(within(panel).getByTestId('mode-select'), { target: { value: 'online' } });
        expect(view.callsOf('chat.mode.set')).toEqual(['offline', 'online']);
        expect(within(panel).queryByTestId('provider-base-field')).toBeNull();
        expect(screen.getByTestId('settings-dialog')).toBeTruthy();
    });

    it('re-renders while it is open, so a change from anywhere is live', () => {
        // The dialog is not a snapshot: it subscribes to the same cells as every other
        // surface, so a base configured elsewhere shows up without reopening.
        const view = renderWithHarness(<SettingsDialogButton />, OFFLINE);
        fireEvent.click(screen.getByTestId('settings-button'));
        const panel = screen.getByTestId('settings-dialog');

        expect((within(panel).getByTestId('provider-base-input') as HTMLInputElement).value).toBe(
            'http://lan.test/v1'
        );

        act(() => view.write<string>(CHAT_PROVIDER_BASE_STATE, 'http://elsewhere.test/v2'));

        expect((within(panel).getByTestId('provider-base-input') as HTMLInputElement).value).toBe(
            'http://elsewhere.test/v2'
        );
        // No command ran for an external write: the popup follows state, it does not
        // echo its own field.
        expect(view.callsOf('chat.providerBase.set')).toEqual([]);
    });
});

// ——— focus containment (T5) —————————————————————————————————————————————————————
// `aria-modal="true"` is a promise to an assistive technology, not to the keyboard: until
// the panel owned Tab, a forward Tab from the last control walked through the scrim into
// the surfaces behind the dialog. These are the containment assertions — the forward
// wrap, the reverse wrap, the pull-in from the panel's own initial focus, and the proof
// that the trap is scoped to Tab inside the panel so every other key (typing, Escape) and
// every dismissal path keeps working.
describe('the dialog contains keyboard focus', () => {
    /**
     * Opens the REAL popup in offline mode, so the panel carries its full three-stop tab
     * sequence in DOM order: the header's close button, then the body's mode select, then
     * the base-URL input (the offline-only field is what makes the sequence longer than
     * two — with two stops a wrap and a step are indistinguishable).
     */
    const openDialog = () => {
        renderWithHarness(<SettingsDialogButton />, OFFLINE);
        fireEvent.click(screen.getByTestId('settings-button'));

        const panel = screen.getByTestId('settings-dialog');
        return {
            panel,
            close: within(panel).getByTestId('settings-dialog-close'),
            mode: within(panel).getByTestId('mode-select'),
            base: within(panel).getByTestId('provider-base-input')
        };
    };

    it('pulls the first Tab out of the panel and into its controls', () => {
        const { base, close, panel } = openDialog();

        // The resting point after open is the PANEL, which is deliberately not a tab stop
        // (`tabIndex={-1}`); the browser's own next stop after the panel element is a node
        // behind the backdrop, so this Tab has to be the dialog's.
        expect(document.activeElement).toBe(panel);
        expect(fireEvent.keyDown(panel, { key: 'Tab' })).toBe(false);
        expect(document.activeElement).toBe(close);

        // The reverse gesture from the same resting point enters at the far end, which is
        // what makes the sequence circular rather than one-way.
        panel.focus();
        expect(fireEvent.keyDown(panel, { key: 'Tab', shiftKey: true })).toBe(false);
        expect(document.activeElement).toBe(base);
    });

    it('wraps forward from the last control to the first', () => {
        const { base, close, mode } = openDialog();

        base.focus();
        // Without containment this key is NOT prevented and focus stays put: the leak is
        // the browser stepping past the panel, which no jsdom assertion can show — so the
        // consumed key plus the moved focus are the pair that pins the wrap.
        expect(fireEvent.keyDown(base, { key: 'Tab' })).toBe(false);
        expect(document.activeElement).toBe(close);

        // An interior Tab belongs to the browser: consuming it would make the middle
        // stops unreachable by key.
        mode.focus();
        expect(fireEvent.keyDown(mode, { key: 'Tab' })).toBe(true);
        expect(document.activeElement).toBe(mode);
    });

    it('wraps backward from the first control to the last', () => {
        const { base, close, mode } = openDialog();

        close.focus();
        expect(fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })).toBe(false);
        expect(document.activeElement).toBe(base);

        mode.focus();
        expect(fireEvent.keyDown(mode, { key: 'Tab', shiftKey: true })).toBe(true);
        expect(document.activeElement).toBe(mode);
    });

    it('holds the cycle when the dialog has a single control', () => {
        // The presentational chrome with non-focusable content: the close button is the
        // whole sequence, so BOTH directions have to land back on it — and containing the
        // key must not dismiss anything.
        const closings: number[] = [];
        renderWithHarness(
            <SettingsDialog
                title="Settings"
                onClose={() => {
                    closings.push(1);
                }}
            >
                <p data-testid="dialog-child">content</p>
            </SettingsDialog>,
            ONLINE
        );

        const close = screen.getByTestId('settings-dialog-close');
        close.focus();
        expect(fireEvent.keyDown(close, { key: 'Tab' })).toBe(false);
        expect(document.activeElement).toBe(close);
        expect(fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })).toBe(false);
        expect(document.activeElement).toBe(close);
        expect(closings).toEqual([]);
    });

    it('confines the trap to Tab inside the panel, so typing and dismissal are intact', () => {
        const { base, panel } = openDialog();

        // A printable key inside the panel is the field's, never the trap's.
        base.focus();
        expect(fireEvent.keyDown(base, { key: 'a' })).toBe(true);
        expect(document.activeElement).toBe(base);

        // A key that starts OUTSIDE the panel never reaches the panel's handler: the bar's
        // trigger is the one focus stop left outside the cycle (the scrim duplicates the
        // close control and clicking either one dismisses), and it keeps its default
        // behaviour while the popup is up.
        const trigger = screen.getByTestId('settings-button');
        trigger.focus();
        expect(fireEvent.keyDown(trigger, { key: 'Tab' })).toBe(true);
        expect(document.activeElement).toBe(trigger);
        expect(screen.getByTestId('settings-dialog')).toBeTruthy();

        // Escape still dismisses from a control inside the panel — that is the document
        // listener's job, not this handler's — and the owner's teardown hands focus back.
        base.focus();
        expect(fireEvent.keyDown(base, { key: 'Escape' })).toBe(true);
        expect(screen.queryByTestId('settings-dialog')).toBeNull();
        expect(document.activeElement).toBe(trigger);
        expect(panel.isConnected).toBe(false);
    });
});
