// Component barrel for the vendored workstation skin.
//
// Every surface a plugin contributes through a region slot is exported from here,
// so `composition.ts` (and any later task composing a variant dashboard) has ONE
// import path for the visible chat surface. The vocabulary a component needs (ids,
// panel shapes, view types) still lives in ../contract and is re-exported below,
// which is why a feature file has a single import for both.
//
// Nothing in this folder imports a plugin: views talk to the core only through
// ids (../contract) and the React bridge (../state-hooks), which keeps
// plugin -> component -> contract acyclic.
export type {
    BrandSpec,
    ChatMode,
    ChatRole,
    ChatSession,
    ChatStatus,
    ChatTranscript,
    ChatTurn,
    ChatUsage,
    Contribution,
    DashboardDensity,
    DashboardMotion,
    DashboardTheme,
    PanelComponent,
    PanelDescriptor,
    PanelValue,
    RegionId,
    RegionSpec,
    SidebarTab,
    StatusValue,
    ViewportMode
} from '../contract';
export { isPanelComponent } from '../contract';

// ——— the sidebar column ————————————————————————————————————————————————————
// ChatSidebar owns the whole rail (four registries + the mobile drawer);
// SessionsBoard is the row chrome all three lists share.
export { ChatSidebar } from './ChatSidebar';
export { SessionsBoard } from './SessionsBoard';
export type { BoardEntry, SessionsBoardProps } from './SessionsBoard';

// ——— the stage column —————————————————————————————————————————————————————
// ChatStageSlot is the channel's contribution: the notice strip stacked on the
// stage. ChatStage owns the single scroll container, the follow/jump scroll behaviour and
// the error strip, and composes the log with the composer (one owner per region).
export { ChatStageSlot } from './ChatStageSlot';
export { ChatStage, isExplicitFollowSignal, jumpEdgeTarget, shouldPinBottom } from './ChatStage';
export type { FollowSnapshot, JumpEdgeInput } from './ChatStage';
export { TranscriptStream } from './TranscriptStream';
export type { TranscriptStreamProps } from './TranscriptStream';
export { MessageTurn, controlsShouldFloat, nextRole, useStickyStrip } from './MessageTurn';
export type { MessageTurnProps } from './MessageTurn';
export { InlineEdit, caretOffsetFromPoint, placeCaretAtOffset, readEditableText } from './InlineEdit';
export type { InlineEditProps } from './InlineEdit';

// ——— the composer column —————————————————————————————————————————————————
export { ComposerDeck, resizeComposerField } from './ComposerDeck';
export { ModelPicker, PickerField, modelLabel, useModelLabels } from './ModelPicker';
export type { PickerFieldProps, PickerOption, ProviderLabelService } from './ModelPicker';
export { VoiceButton } from './VoiceButton';

// ——— the settings surface (T5, simplified by T3) ————————————————————————————————
// StationSettings is the whole configuration surface: mode + the offline provider
// base. It has ONE host, the header's dialog (SettingsDialogButton), which is the
// package's only configuration editor — the inspector column stopped rendering it, so
// the mode/base controls exist in exactly one place on screen. SettingsDialog is the
// accessible modal chrome, exported separately because the bar renders the
// `SettingsDialogButton` wrapper while the dialog tests drive the chrome half directly
// — NOT because it is a published component: this barrel is package-internal (neither
// src/dashboard/index.ts nor src/index.ts re-exports ./components), so a host outside
// @loadscript/chat has no import path to it. Same for the SettingsPanel primitives
// below, which are reused across this package only; NoticeStrip is the transient
// counterpart of the stage's error strip.
export { StationSettings } from './StationSettings';
export { SettingsDialog, SettingsDialogButton } from './SettingsDialog';
export type { SettingsDialogProps } from './SettingsDialog';
export { NoticeStrip } from './NoticeStrip';
export {
    SettingsField,
    SettingsGroup,
    SettingsInput,
    SettingsNote,
    SettingsOption,
    SettingsSelect,
    SettingsWorkspace
} from './SettingsPanel';
export type {
    SettingsChoice,
    SettingsFieldProps,
    SettingsGroupProps,
    SettingsInputProps,
    SettingsNoteProps,
    SettingsOptionProps,
    SettingsSelectProps,
    SettingsWorkspaceProps
} from './SettingsPanel';

// ——— the agent + tool surfaces (T4) —————————————————————————————————————————————
// AgentWorkspace is the aside's Agent tab (registry list + name/prompt editor +
// example-turn layout + tool toggles); AgentPromptEditor and AgentToolGrid are its
// two composed parts, exported because the prompt editor owns its own resize clamp
// and the grid owns the seed-vs-persisted tool rows. ToolInspector is the aside's
// Tool tab. `toolKindLabel` is the shared "native / custom" label the rows and the
// editor panel both print, so the wording cannot drift between the two.
export { AgentWorkspace } from './AgentWorkspace';
export {
    AgentPromptEditor,
    AGENT_PROMPT_MIN_HEIGHT,
    AGENT_PROMPT_MAX_HEIGHT,
    AGENT_PROMPT_RESIZE_STEP,
    clampPromptHeight,
    promptHeightFrom
} from './AgentPromptEditor';
export type { AgentPromptEditorProps } from './AgentPromptEditor';
export { AgentToolGrid } from './AgentToolGrid';
export { ToolInspector, toolKindLabel } from './ToolInspector';

// ——— the inspector column (T6) —————————————————————————————————————————————————
// ChatInspector is the aside channel's contribution: it switches on
// `chat.sidebarTab` and renders one of the four surfaces above (the conversation
// readout for the Chat tab, the quiet panel for the Settings tab). It is exported
// here so `plugins/surfaces.ts` — the only place the plugin layer imports a component
// — has one import path for the whole station. ConversationInspector is exported
// separately because it is a surface in its own right (own file, own test file), not
// because ChatInspector needs it: the switch above imports it by path.
export { ChatInspector } from './ChatInspector';
export { ConversationInspector } from './ConversationInspector';
