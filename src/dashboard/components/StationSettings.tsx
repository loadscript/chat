// StationSettings — the configuration surface, now exactly TWO controls: the
// online/offline mode switch, and (while offline) the provider base URL.
//
// WHAT THIS SURFACE USED TO CARRY, and what happened to it (T3): the theme, spacing
// and motion groups and the live palette list are gone, together with the long mode /
// blank-base notes — the product ships one dark theme and no user-facing skin choice,
// and the descriptions were help text the operator read once. R2 is explicit that
// those controls are REMOVED, not relocated, so nothing in this file reads
// `ui.theme|density|motion` any more; the shell still projects those cells onto
// `.station[data-*]` (../WorkstationShell.tsx) and the skin commands stay registered
// as internal APIs (../plugins/theme.ts), they just have no widget here.
//
// IT HAS ONE HOST NOW: the header's configuration dialog
// (./SettingsDialog.tsx -> `SettingsDialogButton`). The inspector column no longer
// renders this panel for the rail's Settings tab (see ./ChatInspector.tsx), so the
// dialog is the only configuration editor and this file never needs a heading of its
// own — the dialog's labelled title is the accessible name, and a second "Settings"
// heading inside it would be read twice.
//
// BEHAVIOR ORACLE (read-only): src/components/ChatAssistantApp.tsx
//   - the settings workspace render            4808-4871
//   - mode selector + its option values        4818-4829
//   - offline-only provider base field         4849-4858
//   - `switchMode` / `updateProviderBase`      3387-3427
// The option VALUES ('online' / 'offline') and the raw-value dispatch contract are
// unchanged from the oracle; only the labels lost their parenthetical explanations,
// because the dialog labels the field `Mode` and the two words are the whole choice.
//
// EVERY MUTATION IS A COMMAND, never a cell write: `chat.mode.set` owns the persist +
// namespace reset and `chat.providerBase.set` owns the persist + stream invalidation
// (../plugins/settings.ts), so a view that wrote `chat.mode` directly would switch
// modes without re-persisting it and without clearing the previous namespace. That
// half of the contract is untouched by this simplification.
//
// WHY THE PROVIDER FIELD IS OFFLINE-ONLY (oracle 4847): in online mode the provider
// base is deployment configuration (../composition.ts's `providerUrl`), not operator
// configuration — rendering it while online would offer a field the transport ignores.
import {
    CHAT_MODE_SET_COMMAND,
    CHAT_MODE_STATE,
    CHAT_PROVIDER_BASE_SET_COMMAND,
    CHAT_PROVIDER_BASE_STATE,
    type ChatMode
} from '../contract';
import { useDashboardValue } from '../state-hooks';
import { useWorkbench } from '../workbench';
import {
    SettingsField,
    SettingsInput,
    SettingsSelect,
    SettingsWorkspace,
    type SettingsChoice
} from './SettingsPanel';

// ——— the copy. Option values are command inputs; labels are the two words the mode
// cell can hold, with no explanatory prose (R2 removed the notes). ————————————————

export const MODE_CHOICES: readonly SettingsChoice[] = Object.freeze([
    { value: 'online', label: 'Online' },
    { value: 'offline', label: 'Offline' }
]);

/**
 * The field caption is now the field NAME, not a sentence: the two derived routes
 * (`/models` and `/chat/completions`) are what the command builds beneath the base
 * (../api/offline.ts), and that is documented where it is implemented rather than
 * printed above the input. The control's `aria-label` still names the mode the field
 * belongs to, so the accessible name stays unambiguous without the caption.
 */
export const PROVIDER_BASE_LABEL = 'Provider base URL';

/** A real LAN base, so the placeholder doubles as the shape of a valid value. */
export const PROVIDER_BASE_PLACEHOLDER = 'http://192.168.50.109:8800/providers/private/v1';

export function StationSettings() {
    const instance = useWorkbench();
    const mode = useDashboardValue<ChatMode>(CHAT_MODE_STATE);
    const providerBase = useDashboardValue<string>(CHAT_PROVIDER_BASE_STATE);

    const offline = mode === 'offline';

    return (
        <SettingsWorkspace>
            {/* The MODE selector (oracle 4818-4829). Anything other than 'offline' is
                coerced to 'online', the same guard switchMode applies (:3395). */}
            <SettingsField label="Mode" testId="mode-field">
                <SettingsSelect
                    testId="mode-select"
                    ariaLabel="Assistant mode"
                    value={mode}
                    options={MODE_CHOICES}
                    onChange={(value) =>
                        instance.execute<ChatMode>(
                            CHAT_MODE_SET_COMMAND,
                            value === 'offline' ? 'offline' : 'online'
                        )
                    }
                />
            </SettingsField>

            {/* The offline-only configuration: ONE base URL, because the standard
                OpenAI-compatible routes derive beneath it (api/offline.ts:50-68). The
                RAW value goes into the cell (fluid typing, oracle 3360-3362);
                `chat.providerBase.set` normalizes what it persists and refreshes the
                catalog for the new base. */}
            {offline ? (
                <SettingsField label={PROVIDER_BASE_LABEL} testId="provider-base-field">
                    <SettingsInput
                        testId="provider-base-input"
                        ariaLabel="Offline provider base URL"
                        placeholder={PROVIDER_BASE_PLACEHOLDER}
                        value={providerBase}
                        onChange={(value) =>
                            instance.execute<string>(CHAT_PROVIDER_BASE_SET_COMMAND, value)
                        }
                    />
                </SettingsField>
            ) : null}
        </SettingsWorkspace>
    );
}
