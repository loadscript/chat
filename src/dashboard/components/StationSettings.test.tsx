// StationSettings: the configuration surface's render and dispatch contract (T3 shape).
//
// WHAT THIS FILE PINNED BEFORE T3 and what changed: the theme / spacing / motion
// groups, the palette swatch list and the two long notes (mode scope + blank-base
// guidance) are GONE from the product, so their assertions are gone with them — this
// file now pins a surface of exactly two controls and no prose. The half that did NOT
// change is the part that matters most: every mutation goes through a command
// (`chat.mode.set`, `chat.providerBase.set`) and never through a cell write, the mode
// value is coerced the way the oracle's `switchMode` coerces it, and the provider base
// keeps the RAW typed value in the cell (fluid typing, oracle 3360-3362) while the
// command owns normalization and persistence.
//
// The harness publishes each command's input into the cell the way the real plugins do
// (./test-harness.tsx), so every "dispatch then re-render" assertion below also proves
// the control is driven by STATE rather than by its own DOM value.
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
    CHAT_MODE_STATE,
    CHAT_PROVIDER_BASE_STATE,
    type ChatMode
} from '../contract';
import { StationSettings } from './StationSettings';
import { renderWithHarness, type HarnessSeed } from './test-harness';

afterEach(() => {
    cleanup();
});

const ONLINE: HarnessSeed = { mode: 'online', providerBase: '' };
const OFFLINE_BLANK: HarnessSeed = { mode: 'offline', providerBase: '' };
const OFFLINE_SET: HarnessSeed = {
    mode: 'offline',
    providerBase: 'http://192.168.50.109:8800/providers/private/v1'
};

describe('the mode selector', () => {
    it('renders the two modes with their exact command values and bare labels', () => {
        renderWithHarness(<StationSettings />, ONLINE);
        const select = screen.getByTestId('mode-select') as HTMLSelectElement;

        // The option VALUES are the `chat.mode` vocabulary; the labels lost the
        // parenthetical explanations the product no longer prints.
        expect(Array.from(select.options).map((option) => [option.value, option.text])).toEqual([
            ['online', 'Online'],
            ['offline', 'Offline']
        ]);
        expect(select.value).toBe('online');
        expect(select.getAttribute('aria-label')).toBe('Assistant mode');
        // The <label> wrapper is the field: caption + control, oracle 4818-4829.
        const field = screen.getByTestId('mode-field');
        expect(field.tagName).toBe('LABEL');
        expect(within(field).getByText('Mode').textContent).toBe('Mode');
        expect(within(field).getByTestId('mode-select')).toBeTruthy();
    });

    it('renders no description in either mode', () => {
        // R2 removed the notes, not just their wording: neither testid may exist while
        // online OR while offline, so a re-added paragraph fails here by name.
        for (const seed of [ONLINE, OFFLINE_BLANK]) {
            const { container, unmount } = renderWithHarness(<StationSettings />, seed);
            expect(screen.queryByTestId('mode-note')).toBeNull();
            expect(screen.queryByTestId('offline-endpoint-hint')).toBeNull();
            expect(container.querySelectorAll('.settings__note')).toHaveLength(0);
            unmount();
        }
    });

    it('switching the mode dispatches chat.mode.set and the offline field appears', () => {
        const view = renderWithHarness(<StationSettings />, ONLINE);
        expect(screen.queryByTestId('provider-base-field')).toBeNull();

        fireEvent.change(screen.getByTestId('mode-select'), { target: { value: 'offline' } });

        // One dispatch with the coerced mode, and the cell — not the DOM — decides what
        // renders next.
        expect(view.callsOf('chat.mode.set')).toEqual(['offline']);
        expect(view.read<ChatMode>(CHAT_MODE_STATE)).toBe('offline');
        expect(screen.getByTestId('provider-base-field')).toBeTruthy();
        expect((screen.getByTestId('mode-select') as HTMLSelectElement).value).toBe('offline');
    });

    it('coerces any other value to online, the way switchMode does', () => {
        const view = renderWithHarness(<StationSettings />, OFFLINE_BLANK);

        fireEvent.change(screen.getByTestId('mode-select'), { target: { value: 'nonsense' } });

        expect(view.callsOf('chat.mode.set')).toEqual(['online']);
    });
});

describe('the offline provider base', () => {
    it('is absent while the app is online, so a field the transport ignores is never offered', () => {
        renderWithHarness(<StationSettings />, { ...ONLINE, providerBase: 'http://ignored.test/v1' });

        expect(screen.queryByTestId('provider-base-field')).toBeNull();
        expect(screen.queryByTestId('provider-base-input')).toBeNull();
    });

    it('names the field, keeps the LAN base as its placeholder, and adds no prose', () => {
        const view = renderWithHarness(<StationSettings />, OFFLINE_BLANK);
        const field = screen.getByTestId('provider-base-field');
        const input = screen.getByTestId('provider-base-input') as HTMLInputElement;

        // The caption is the field NAME; the derived routes it used to spell out are
        // documented in api/offline.ts, where they are built.
        expect(within(field).getByText(/Provider base URL/).textContent).toBe('Provider base URL');
        expect(input.value).toBe('');
        expect(input.placeholder).toBe('http://192.168.50.109:8800/providers/private/v1');
        expect(input.getAttribute('aria-label')).toBe('Offline provider base URL');
        expect(view.read<string>(CHAT_PROVIDER_BASE_STATE)).toBe('');
    });

    it('dispatches the RAW typed value, mid-edit included, with no trimming', () => {
        const view = renderWithHarness(<StationSettings />, OFFLINE_BLANK);
        const input = screen.getByTestId('provider-base-input');

        fireEvent.change(input, { target: { value: 'http:' } });
        expect(view.callsOf('chat.providerBase.set')).toEqual(['http:']);

        fireEvent.change(input, { target: { value: ' http://lan.test/v1/ ' } });

        // Half a URL is still what the operator typed: the command persists the
        // canonical form, the cell keeps the raw one.
        expect(view.callsOf('chat.providerBase.set')).toEqual(['http:', ' http://lan.test/v1/ ']);
        expect(view.read<string>(CHAT_PROVIDER_BASE_STATE)).toBe(' http://lan.test/v1/ ');
        expect((screen.getByTestId('provider-base-input') as HTMLInputElement).value).toBe(
            ' http://lan.test/v1/ '
        );
    });

    it('re-reads a base that was configured outside the surface', () => {
        // The dialog can open over a station whose base arrived from localStorage, so
        // the field renders the CELL, not a cached default.
        const view = renderWithHarness(<StationSettings />, OFFLINE_BLANK);

        act(() =>
            view.write<string>(
                CHAT_PROVIDER_BASE_STATE,
                'http://192.168.50.109:8800/providers/private/v1'
            )
        );

        expect((screen.getByTestId('provider-base-input') as HTMLInputElement).value).toBe(
            OFFLINE_SET.providerBase
        );
        expect(view.callsOf('chat.providerBase.set')).toEqual([]);
    });
});

describe('the two controls are the whole surface (R2)', () => {
    it('renders nothing but the mode field while online', () => {
        const view = renderWithHarness(<StationSettings />, ONLINE);
        const workspace = screen.getByTestId('settings-workspace');

        expect(
            Array.from(workspace.children).map((child) => child.getAttribute('data-testid'))
        ).toEqual(['mode-field']);
        // No command has run for a surface that has not been touched.
        expect([...view.calls.keys()]).toEqual([]);
    });

    it('renders nothing but the mode and base fields while offline', () => {
        renderWithHarness(<StationSettings />, OFFLINE_SET);
        const workspace = screen.getByTestId('settings-workspace');

        expect(
            Array.from(workspace.children).map((child) => child.getAttribute('data-testid'))
        ).toEqual(['mode-field', 'provider-base-field']);
    });

    it('ships no skin or palette control in either mode', () => {
        // R2 removed the theme / spacing / motion groups and the palette list, and R4
        // keeps those cells INTERNAL — so the surface must not read or write them.
        for (const seed of [ONLINE, OFFLINE_SET]) {
            const { container } = renderWithHarness(<StationSettings />, seed);

            expect(screen.queryByTestId('settings-theme-group')).toBeNull();
            expect(screen.queryByTestId('settings-density-group')).toBeNull();
            expect(screen.queryByTestId('settings-motion-group')).toBeNull();
            expect(screen.queryByTestId('settings-palette')).toBeNull();
            expect(container.querySelectorAll('.settings__group')).toHaveLength(0);
            expect(container.querySelectorAll('.swatches')).toHaveLength(0);

            cleanup();
        }
    });
});

describe('the surface itself', () => {
    it('owns one workspace root, no heading, and never borrows another surface\'s testid', () => {
        renderWithHarness(<StationSettings />, OFFLINE_BLANK);

        const workspace = screen.getByTestId('settings-workspace');
        expect(workspace.tagName).toBe('SECTION');
        expect(workspace.className).toBe('settings');
        // The dialog that hosts this panel supplies the labelled title
        // (SettingsDialog.tsx), so a second "Settings" heading here would be read twice.
        expect(screen.queryByTestId('settings-heading')).toBeNull();
        // The strip/banner testids belong to NoticeStrip.tsx and ChatStage.tsx, and
        // this surface uses neither.
        expect(screen.queryByTestId('notice-strip')).toBeNull();
        expect(screen.queryByTestId('error-banner')).toBeNull();
    });
});
