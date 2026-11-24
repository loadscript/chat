// ConversationInspector — what the aside column shows while the rail is on Chat.
//
// WHAT IT IS: the conversation's own readout — the live activity of the agentic run
// behind the transcript, the turn that is in flight, and the session's counters
// (model, agent, tools, tokens). It replaced the quiet "This column follows the
// rail" panel for this tab: that panel existed because the rail still had Agent /
// Tool / Settings TABS and the column was explaining its own rule. The rail lost its
// tabs (ChatSidebar.tsx:1-9), so the sentence became the only content of a column
// that renders nothing useful, while the readout the rail's Settings tab used to
// carry (activity, turns, model, tokens, follow-output — the `sidebar-settings`
// tree) lost its home with them. This surface is where those numbers live now, plus
// the work the harness is doing on this conversation in the background.
//
// READ-ONLY, ON PURPOSE. Every value is a `chat.*` cell projection: no control here
// writes anything back, because every one of them already has its own editor
// elsewhere — model/agent in the composer's picker strip (./ModelPicker), mode and
// provider base in the header's dialog (./SettingsDialog), follow-output through
// `chat.autoscroll.toggle` from the stage. A duplicate control in this column would
// put two editors of one cell on screen, which is exactly why the 'settings' tab
// still renders the quiet panel (see ChatInspector.tsx's header note).
//
// STATE, and why each cell is here:
//   chat.status      the refcounted phase (plugins/core.ts's activity tracker). It is
//                    the column's head line: 'idle' when nothing runs, and the phase
//                    word while the harness / provider / storage leg is working.
//   chat.pending     the user text whose reply is in flight, with its `at` stamp —
//                    the "what am I waiting on" half of a background run.
//   chat.streaming   the partial assistant text, so the length is live progress.
//   chat.error       the surfaced failure, repeated here (the stage's banner is the
//                    primary surface; this one survives a dismissed strip).
//   chat.sessions /
//   chat.activeSessionId   which conversation the numbers describe.
//   chat.transcript  message count of the open conversation. `chat.turns` is one row
//                    per transcript message (plugins/core.ts:211-228), so a second
//                    count would only restate this one.
//   chat.model /
//   chat.models /
//   chat.provider    the model that answers, through the SAME label resolution the
//                    composer uses (./ModelPicker's `useModelLabels`), so the two
//                    columns can never print two different names for one id.
//   chat.agent /
//   chat.agents      the agent that prefixes NEW chats — `chat.agent`, the composer's
//                    choice, NOT `chat.activeAgentId`, which is the row open in the
//                    Agents tab. Its `tools` array is the tool surface the next turn
//                    may call, i.e. the agentic capability actually attached.
//   chat.mode        'online' (the harness server) or 'offline' (browser-local): the
//                    two run with different transports, so the operator reads which
//                    one produced a number.
//   chat.usage       the session's token counters. The composer keeps the ONE live
//                    number (`token-usage`); this column breaks it into
//                    prompt / reply / total, answering where those tokens came from.
//   chat.autoscroll /
//   chat.listening   the two remaining background switches: whether the transcript is
//                    pinned to the bottom, and whether the recognizer is open.
//
// NO CLOCK, NO TIMER. `chat.pending.at` is a wall-clock instant, and this surface
// prints the queued text rather than an elapsed "12s" line: a ticking number needs an
// interval in a component that otherwise renders pure state, and a static one would
// freeze at whatever the last repaint was. The length line is live progress without
// either problem.
import {
    CHAT_ACTIVE_SESSION_STATE,
    CHAT_AGENT_STATE,
    CHAT_AGENTS_STATE,
    CHAT_AUTOSCROLL_STATE,
    CHAT_ERROR_STATE,
    CHAT_LISTENING_STATE,
    CHAT_MODE_STATE,
    CHAT_MODEL_STATE,
    CHAT_PENDING_STATE,
    CHAT_SESSIONS_STATE,
    CHAT_STATUS_STATE,
    CHAT_STREAMING_STATE,
    CHAT_TRANSCRIPT_STATE,
    CHAT_USAGE_STATE,
    type ChatMode,
    type ChatPendingTurn,
    type ChatSession,
    type ChatStatus,
    type ChatTranscript,
    type ChatUsage
} from '../contract';
import type { AgentDefinition } from '../../agents';
import { useDashboardValue } from '../state-hooks';
import { useModelLabels } from './ModelPicker';

/** Readout copy. Values are the cell vocabularies verbatim wherever one exists. */
const COPY = {
    title: 'Conversation',
    /** Every absent value — no model, no agent, no open conversation. */
    none: 'None',
    noSession: 'No conversation',
    queued: 'Queued',
    reply: 'Partial reply',
    /** Row labels. CSS uppercases them; they stay sentence-cased for the DOM. */
    labels: {
        session: 'Conversation',
        id: 'Session id',
        messages: 'Messages',
        model: 'Model',
        agent: 'Agent',
        tools: 'Tools',
        mode: 'Transport',
        promptTokens: 'Prompt tokens',
        replyTokens: 'Reply tokens',
        totalTokens: 'Total tokens',
        follow: 'Follow output',
        voice: 'Voice input'
    }
} as const;

/**
 * The `chat.status` vocabulary as the operator reads it. `busy` is what the activity
 * dot pulses on: the three transient phases the core's activity tracker publishes
 * (plugins/core.ts:380-388) plus the 'streaming' label the contract also allows.
 * 'error' is NOT busy — it is what a run ended with, and it paints danger.
 */
const ACTIVITY: Record<ChatStatus, { label: string; busy: boolean }> = {
    idle: { label: 'Idle', busy: false },
    loading: { label: 'Reading session', busy: true },
    sending: { label: 'Streaming reply', busy: true },
    streaming: { label: 'Streaming reply', busy: true },
    saving: { label: 'Saving', busy: true },
    error: { label: 'Failed', busy: false }
};

/** One readout line. `key` is the testid suffix, so it stays ASCII-kebab. */
type Row = { key: string; label: string; value: string };

/** A row pair, so the list below reads as data rather than as twelve JSX blocks. */
const row = (key: string, label: string, value: string): Row => ({ key, label, value });

/** "3 tools" / "None" — the tool surface attached to the agent that prefixes a send. */
const toolCount = (agent: AgentDefinition | null): string =>
    agent === null ? COPY.none : `${agent.tools.length} attached`;

/** The token counters, 0 when the session has reported none — as the composer does. */
const tokens = (usage: ChatUsage | null, key: 'prompt_tokens' | 'completion_tokens' | 'total_tokens'): string =>
    String(usage?.[key] ?? 0);

/**
 * What the tinted block calls the work. A buffer that already holds text is named for
 * what it looks like ('Streaming reply'), even when `chat.status` has settled back to
 * 'idle' after an abort; an active phase prints its own word; and queued text whose
 * status is NOT busy — the gap between the send and the first status write — prints
 * 'In flight' rather than the contradictory 'Idle'.
 */
const liveLabel = (status: ChatStatus, streaming: string): string =>
    streaming !== '' ? ACTIVITY.streaming.label : ACTIVITY[status].busy ? ACTIVITY[status].label : 'In flight';

/**
 * True while a TURN is in flight, i.e. while the block has something to say beyond
 * the phase word. The head line already prints the phase, so a status-only block
 * would repeat it in a tinted panel (visible in the browser: "Reading session" twice
 * during the opening session read). Queued user text or streamed reply text is what
 * makes the block worth painting.
 */
const isInFlight = (pending: ChatPendingTurn | null, streaming: string): boolean =>
    pending !== null || streaming !== '';

export function ConversationInspector() {
    const sessions = useDashboardValue<readonly ChatSession[]>(CHAT_SESSIONS_STATE);
    const activeSessionId = useDashboardValue<string | null>(CHAT_ACTIVE_SESSION_STATE);
    const transcript = useDashboardValue<ChatTranscript>(CHAT_TRANSCRIPT_STATE);
    const status = useDashboardValue<ChatStatus>(CHAT_STATUS_STATE);
    const error = useDashboardValue<string>(CHAT_ERROR_STATE);
    const pending = useDashboardValue<ChatPendingTurn | null>(CHAT_PENDING_STATE);
    const streaming = useDashboardValue<string>(CHAT_STREAMING_STATE);
    const model = useDashboardValue<string>(CHAT_MODEL_STATE);
    const agent = useDashboardValue<string>(CHAT_AGENT_STATE);
    const agents = useDashboardValue<readonly AgentDefinition[]>(CHAT_AGENTS_STATE);
    const usage = useDashboardValue<ChatUsage | null>(CHAT_USAGE_STATE);
    const mode = useDashboardValue<ChatMode>(CHAT_MODE_STATE);
    const autoscroll = useDashboardValue<boolean>(CHAT_AUTOSCROLL_STATE);
    const listening = useDashboardValue<boolean>(CHAT_LISTENING_STATE);

    // The composer's own id -> display-label resolution (async provider labels, with
    // the stripped-name fallback for ids outside the live catalog).
    const { labelFor } = useModelLabels();

    // ——— derived ——————————————————————————————————————————————————————————
    const session = sessions.find((entry) => entry.conversationId === activeSessionId) ?? null;
    // `chat.agent` is an id; a registry row that vanished under this surface still
    // prints its id rather than claiming 'None' about a choice the next send honours.
    const prefixAgent = agents.find((entry) => entry.id === agent) ?? null;
    const live = isInFlight(pending, streaming);

    const rows: Row[] = [
        row(
            'session',
            COPY.labels.session,
            session?.title ?? (activeSessionId === null ? COPY.noSession : activeSessionId)
        ),
        // The id row exists only while a conversation is open: an id reading 'None'
        // under a 'No conversation' row would state one fact twice.
        ...(activeSessionId === null
            ? []
            : [row('id', COPY.labels.id, activeSessionId)]),
        row('messages', COPY.labels.messages, String(transcript.length)),
        row('model', COPY.labels.model, model === '' ? COPY.none : labelFor(model)),
        row('agent', COPY.labels.agent, agent === '' ? COPY.none : (prefixAgent?.name ?? agent)),
        row('tools', COPY.labels.tools, toolCount(prefixAgent)),
        row('mode', COPY.labels.mode, mode),
        row('prompt-tokens', COPY.labels.promptTokens, tokens(usage, 'prompt_tokens')),
        row('reply-tokens', COPY.labels.replyTokens, tokens(usage, 'completion_tokens')),
        row('total-tokens', COPY.labels.totalTokens, tokens(usage, 'total_tokens')),
        row('follow', COPY.labels.follow, autoscroll ? 'on' : 'off'),
        row('voice', COPY.labels.voice, listening ? 'on' : 'off')
    ];

    return (
        <section className="panel" data-testid="inspector-chat" aria-label="Conversation inspector">
            <header className="panel__head">
                <h2 className="panel__title">{COPY.title}</h2>
                {/* The live phase, as a WORD plus the dot in ./inspector.css, so the
                    state is never colour-only. `data-status` is the contract's
                    vocabulary, not the display label. */}
                <span
                    className="panel__hint inspector__state"
                    data-status={status}
                    data-busy={ACTIVITY[status].busy}
                    data-testid="inspector-activity"
                >
                    {ACTIVITY[status].label}
                </span>
            </header>

            <div className="panel__body">
                {live ? (
                    <div className="inspector__live" data-testid="inspector-live" data-status={status}>
                        <span className="inspector__live-label">{liveLabel(status, streaming)}</span>

                        {pending === null ? null : (
                            <>
                                <span className="inspector__count">{COPY.queued}</span>
                                <p className="inspector__preview" data-testid="inspector-pending">
                                    {pending.text}
                                </p>
                            </>
                        )}

                        {streaming === '' ? null : (
                            <p className="inspector__count" data-testid="inspector-streaming">
                                {COPY.reply}: {streaming.length} chars
                            </p>
                        )}
                    </div>
                ) : null}

                {error === '' ? null : (
                    <p className="inspector__error" data-testid="inspector-error">
                        {error}
                    </p>
                )}

                {/* A <dl> of `div` pairs — grouping dt/dd in a div is the markup HTML
                    allows inside a dl, and it keeps one testid per row. */}
                <dl className="inspector__rows">
                    {rows.map((entry) => (
                        <div className="inspector__row" key={entry.key} data-testid={`inspector-row-${entry.key}`}>
                            <dt>{entry.label}</dt>
                            <dd>{entry.value}</dd>
                        </div>
                    ))}
                </dl>
            </div>
        </section>
    );
}
