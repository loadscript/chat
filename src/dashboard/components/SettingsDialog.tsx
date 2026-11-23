// SettingsDialog — the station bar's configuration popup: ONE icon-only control that
// opens an accessible modal hosting `StationSettings`.
//
// WHY A DIALOG AND NOT A PANEL (R3): the configuration surface used to live in the
// inspector column (`chat.sidebarTab === 'settings'`, ChatInspector.tsx), i.e. in a
// region whose width the operator does not control and which the phone shell turns
// into an off-canvas drawer. The dialog is host-independent: it floats over whatever
// column is open, on desktop and on a phone, and it is the ONLY place configuration
// is edited, so the mode/base controls can never be duplicated across surfaces.
//
// TWO EXPORTS, ONE FILE: `SettingsDialog` is the accessible chrome (backdrop, panel,
// labelled title, close control) with NO opinion about its content and NO state of
// its own; `SettingsDialogButton` is the bar affordance that owns the open flag and
// puts `StationSettings` inside it. The split is what keeps the presentational half
// testable and reusable without pulling the command wiring in.
//
// THE OPEN FLAG IS LOCAL `useState`, deliberately: `chat.drawerOpen` / `chat.asideOpen`
// exist because those drawers are viewport state that the seam in ../viewport.ts has
// to retract on a layout crossing. Nothing outside this component reads "is the
// settings popup open", so it does not belong in the shared `chat.*` cell namespace
// (contract.ts:378-386), and a cell would also outlive the shell that renders it.
//
// STATE / COMMAND USAGE: none here. Every mutation the dialog contains is
// `StationSettings` dispatching `chat.mode.set` / `chat.providerBase.set`
// (./StationSettings.tsx), which is why a change takes effect the moment it is made —
// the dialog is mounted inside the same WorkbenchProvider subtree and its content
// re-renders from the cells like any other surface.
//
// ACCESSIBILITY CONTRACT (the pattern the rest of this package's overlays follow —
// ChatSidebar's rail and ChatInspector's aside):
//   trigger  `aria-haspopup="dialog"` + `aria-expanded` (live, so the control reads
//            as the thing that opened the popup) and an explicit `aria-label`, since
//            an icon-only button has no text to name it;
//   panel    `role="dialog"` + `aria-modal="true"` + `aria-labelledby` pointing at the
//            rendered heading, `tabIndex={-1}` so the container itself can take focus
//            and a screen reader announces the dialog's name on open;
//   dismiss  close button, `Escape`, and backdrop click — all three route through the
//            SAME owner-supplied `onClose`, so there is exactly one teardown path;
//   cycle    Tab / Shift+Tab are contained by the panel (see `onPanelKeyDown`), so the
//            controls behind the backdrop are not keyboard-reachable while the popup is
//            up — the promise `aria-modal` makes. The backdrop button sits OUTSIDE the
//            cycle on purpose: it duplicates the close control.
// Focus returns to the trigger (see `SettingsDialogButton.close`): closing must leave
// the caret where the operator's hand already is, and doing it in the OWNER rather
// than by capturing `document.activeElement` inside the dialog keeps the restore
// deterministic (a programmatic `click()` in a test never focuses the button, so an
// activeElement snapshot would restore the wrong node there).
//
// FOCUS CONTAINMENT (T5): `aria-modal="true"` tells an assistive technology the rest of
// the page is inert, but it does nothing to the KEYBOARD — without a handler, a Tab from
// the last control walks straight through the scrim into the surfaces behind it. So the
// panel owns Tab/Shift+Tab and cycles its own tab sequence: forward from the last control
// wraps to the first, reverse from the first wraps to the last, and an interior Tab is
// left to the browser. Dependency-free and dialog-local on purpose — no package, and no
// drawer elsewhere in this package (ChatSidebar's rail, ChatInspector's aside) is
// modal, so none of them should inherit a trap.
import {
    useEffect,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type ReactNode
} from 'react';
import { CloseIcon, SettingsIcon } from '../../icons';
import { StationSettings } from './StationSettings';

// The nodes a Tab press can land on, in DOM order — the browser's own default tab
// sequence, narrowed to the elements this dialog can actually contain. The
// `:not([tabindex="-1"])` clause is what keeps deliberately un-tabbable nodes out of the
// cycle (including the panel itself, which is focusable only programmatically — see
// `tabIndex={-1}` below), and the `:not([disabled])` clauses match the browser's rule
// that a disabled control is skipped.
const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
].join(',');

/**
 * The panel's tab sequence, in the order Tab walks it. `[hidden]`/`[inert]` subtrees are
 * dropped because those are the only visibility signals a test environment and a real
 * browser agree on — a layout probe (`offsetParent`) would report every node as hidden
 * under jsdom and silently empty the cycle.
 */
const collectFocusable = (panel: HTMLElement): HTMLElement[] =>
    Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (node) => node.closest('[hidden], [inert]') === null
    );

export type SettingsDialogProps = {
    /** The rendered heading; also the panel's accessible name via `aria-labelledby`. */
    title: string;
    /** Every dismissal route calls this: close button, Escape, and backdrop click. */
    onClose: () => void;
    /** The dialog's content — rendered inside the panel's scrollable body. */
    children: ReactNode;
    /** Testid prefix; the panel is `testId`, its parts `testId-close` / `testId-backdrop`. */
    testId?: string;
};

/**
 * The modal chrome. It is MOUNTED-WHILE-OPEN (the caller renders it conditionally),
 * which is what makes "closed" mean "not in the tree": no hidden dialog still holding a
 * focus trap, no inert overlay above the seam, and the effects below run exactly once
 * per open.
 */
export function SettingsDialog({
    title,
    onClose,
    children,
    testId = 'settings-dialog'
}: SettingsDialogProps) {
    const panelRef = useRef<HTMLDivElement>(null);
    // The heading is the panel's label, and the id must be unique enough to resolve
    // inside a host page that mounts several stations.
    const titleId = `${testId}-title`;

    // ESCAPE. A DOCUMENT listener, not a key handler on the panel: focus can be on the
    // panel, on a field inside it, or (in a host that steals focus) nowhere inside it,
    // and a keydown on the panel would miss the last two. Only one dialog of this kind
    // can be mounted at a time, so the listener cannot double-fire, and it unmounts
    // with the panel.
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [onClose]);

    // MOVE focus INTO the dialog on open, so the first thing a keyboard user can act
    // on is the popup rather than whatever sat behind the backdrop. The panel itself
    // takes focus (`tabIndex={-1}`, see the JSX): the accessible name is announced and
    // the first Tab continues into the body. Restoring is the OWNER's job (see the
    // header note), not this component's.
    useEffect(() => {
        panelRef.current?.focus();
    }, []);

    // THE CYCLE. A React key handler on the PANEL (not a document listener like Escape):
    // containment only ever has to act on keystrokes inside the dialog, and a panel
    // handler cannot interfere with the surfaces behind the scrim. `event.key === 'Tab'`
    // is the whole filter — every other key, including Escape, is left to bubble
    // untouched so typing in the base-URL field still works.
    const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Tab') return;

        const panel = panelRef.current;
        if (!panel) return;

        const focusable = collectFocusable(panel);
        // A dialog with nothing to tab through still owns the key: without this the caret
        // would walk out of a panel that has no controls at all.
        if (focusable.length === 0) {
            event.preventDefault();
            panel.focus();
            return;
        }

        // Where the tab sequence currently is. -1 means "not on a control of this
        // dialog", which covers both real cases: focus resting on the panel itself
        // right after open, and a host that moved focus outside the overlay.
        const active = document.activeElement;
        const index = focusable.indexOf(active as HTMLElement);
        if (index >= 0) {
            // An interior Tab is the browser's job — it already walks inside the panel.
            // Only the edges need wrapping, and which edge matters depends on direction.
            const atEdge = event.shiftKey ? index === 0 : index === focusable.length - 1;
            if (!atEdge) return;
        }

        // Either an edge control or focus the tab sequence skips. Pull it back to the far
        // end of the dialog's own cycle, which is what keeps the tab order circular and
        // stops the scrim from hiding a control the operator can still reach by key.
        // (Deliberate simplification: a non-control node inside the panel restarts the
        // cycle from its start rather than resuming from the nearest neighbour — the only
        // such node today is the panel itself.)
        event.preventDefault();
        (event.shiftKey ? focusable[focusable.length - 1] : focusable[0]).focus();
    };

    return (
        /* BACKDROP BEFORE PANEL, in that order — the same reason the rail's and the
           inspector's scrims precede their panels (ChatSidebar.tsx:209-217): the panel
           paints above its own dismiss target, and the scrim exists only to close it.
           They are SIBLINGS because the panel is the fixed, centred box; a scrim nested
           inside it could not cover the viewport. */
        <>
            <button
                type="button"
                className="settings-dialog__backdrop"
                // The backdrop is a real button so it is keyboard-reachable and has an
                // accessible name; it carries no content.
                aria-label="Close settings"
                data-testid={`${testId}-backdrop`}
                onClick={onClose}
            />

            <div
                ref={panelRef}
                className="settings-dialog"
                data-testid={testId}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                // The cycle lives here so it only ever sees keystrokes inside the panel.
                onKeyDown={onPanelKeyDown}
            >
                <header className="settings-dialog__head">
                    <h2 className="settings-dialog__title" id={titleId}>
                        {title}
                    </h2>
                    <button
                        type="button"
                        className="btn btn--ghost btn--icon settings-dialog__close"
                        aria-label="Close settings"
                        data-testid={`${testId}-close`}
                        onClick={onClose}
                    >
                        <CloseIcon size={16} />
                    </button>
                </header>

                <div className="settings-dialog__body">{children}</div>
            </div>
        </>
    );
}

/**
 * The bar's right-side affordance: the icon-only trigger plus the dialog it owns.
 * It is rendered by `ShellFrame` (../WorkstationShell.tsx) inside `.station__actions`,
 * and it needs no props because the configuration state it shows comes from the cells
 * `StationSettings` reads.
 */
export function SettingsDialogButton() {
    const [open, setOpen] = useState(false);
    // The focus target on close: the trigger itself, resolved by ref rather than by
    // whatever element happens to hold focus when the dialog leaves the tree.
    const triggerRef = useRef<HTMLButtonElement>(null);

    /** The one teardown path: close the popup and hand focus back to the control. */
    const close = () => {
        setOpen(false);
        triggerRef.current?.focus();
    };

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                className="btn btn--ghost btn--icon"
                // Icon-only, so the name is explicit; the gear glyph stays decorative
                // (icons.tsx ships `aria-hidden="true"` by default).
                aria-label="Settings"
                aria-haspopup="dialog"
                aria-expanded={open}
                data-testid="settings-button"
                // A second click toggles the popup shut. The backdrop covers the bar
                // while it is open, so in a real click path that is what lands first;
                // the toggle keeps the control honest either way.
                onClick={() => setOpen((current) => !current)}
            >
                <SettingsIcon size={16} />
            </button>

            {open ? (
                <SettingsDialog title="Settings" onClose={close}>
                    <StationSettings />
                </SettingsDialog>
            ) : null}
        </>
    );
}
