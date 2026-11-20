// Composition root: one dashboard() call, the plugins that make the chat UI.
//
// Adapted from packages/underload/dashboard/example/src/app/composition.ts.
// T1 registered only the two skin plugins; T3 added the chat core (the whole
// `chat.*` state graph, the session lifecycle, the streaming send pipeline, the
// message/turn commands and the system-prompt flow); T6 filled the add-on seam
// (plugins/extras.ts) with the capability set — agents, tools, settings, voice,
// notices, the two input commands and the three region surfaces — so the graph this
// file builds is the complete workstation:
//
//   layout -> theme -> chat.core -> chat.source -> chat.sessions ->
//   chat.transcript -> chat.system-prompt -> chat.agents -> chat.tools ->
//   chat.settings -> chat.voice -> chat.notices -> chat.inputs -> chat.surfaces
//
// ORDER MATTERS (documented because the next contributor will hit it):
//   `requires` is the only ordering mechanism, and it ORDERS but does not
//   validate providers — declare an edge for every service a setup() reads, or
//   the lookup is a lucky coincidence (`unknown-service` otherwise). The chat
//   plugins declare `requires: ['chat.core']`, which is what makes the schedule
//   deterministic regardless of how this array is spelled.
//   Add-ons are appended last: they may depend on every built-in, and no built-in
//   can depend on them.
//
// Duplicate ids anywhere in the graph throw before a single setup() runs, so a
// plugin that registered a `chat.*` id owns it: see contract.ts for the reserved
// vocabulary and the command signatures each id must honour. The add-ons' services
// (`chat.agentStore`, `chat.toolStore`, `chat.speech`, `chat.notices`) and the
// `chat.agent.set` command are registered ONCE, by the plugins that own them.
import { dashboard, type Dashboard, type DashboardPlugin } from '@underload/dashboard';
// The public `baseUrl`/`providerUrl` props do NOT mean the same thing since the
// rebuild: `baseUrl` is the HARNESS API ROOT, where '' means "automatic, same origin"
// (api/harness.ts `configureHarnessApiRoot`), because the packaged server serves the
// API, the stream and the UI from one listener. `providerUrl` stays a provider BASE:
// the OFFLINE transport derives '{base}/models' and '{base}/chat/completions' from it
// (api/provider.ts), so a bare origin there is still the recorded "No models available"
// bug. Online, the provider lives server-side (@underload/chat/src/server/config.ts) and this option is
// not consulted at all.
import { DEFAULT_PROVIDER_URL } from '../api/provider';
import type { StreamScheduler, StreamSocketFactory } from '../api/harness-stream';
import { createLayoutPlugin } from './plugins/layout';
import { createThemePlugin } from './plugins/theme';
import { createChatPlugins } from './plugins/chat';
import { EXTRA_PLUGINS } from './plugins/extras';

export type ChatDashboardOptions = {
    /**
     * The harness API ROOT ('' = automatic, same origin). Threaded into the
     * `chat.conversations` service, which persists a declared value through the
     * harness client's own setting (see ChatAssistantAppProps.baseUrl).
     */
    baseUrl?: string;
    /**
     * Provider base for OFFLINE mode streaming (default: DEFAULT_PROVIDER_URL).
     * ONLINE inference is the server's provider; the runtime override lives in the
     * `chat.providerBase` cell, which is why `chat.conversations` and the catalog
     * effect resolve the live cells on every call.
     */
    providerUrl?: string;
    /**
     * Poll cadence for an in-flight ('pending') conversation. OFFLINE-only since
     * the rebuild (online settles through the stream). Defaults to
     * `CONVERSATION_POLL_INTERVAL_MS`; overridable for tests.
     */
    pollIntervalMs?: number;
    /**
     * The WebSocket seam (socket factory + clock) handed to the online provider
     * client. Production omits it and dials the platform socket; a test injects a
     * double and drives frames on purpose.
     */
    stream?: { socketFactory?: StreamSocketFactory; schedule?: StreamScheduler };
    /**
     * Capability add-ons appended after the built-ins. This is the seam the shell
     * test uses to prove the shell is feature-blind: a contribution from a plugin
     * the shell has never heard of still renders, in slot order, with no edit
     * here or in WorkstationShell.tsx.
     */
    extraPlugins?: readonly DashboardPlugin[];
};

export function createChatDashboard(options: ChatDashboardOptions = {}): Dashboard {
    // A mutable array satisfies both `DashboardPlugin[]` and the core's
    // `readonly DashboardPlugin[]` input, so a call site cannot break on that
    // detail of the public type.
    const plugins: DashboardPlugin[] = [
        // 1. layout: publishes `layout.brand` + `layout.regions` and the three
        //    replaceable region placeholders.
        createLayoutPlugin(),
        // 2. theme: owns `ui.theme` / `ui.density` / `ui.motion` and the commands
        //    the bar's skin affordances call.
        createThemePlugin(),
        // 3-7. the chat core: state graph -> transport -> sessions -> transcript
        //        -> system prompt. Built per instance so the endpoints below reach
        //        the services (see plugins/chat.ts for why both this factory and
        //        the default `chatPlugins` array exist).
        ...createChatPlugins({
            // A blank/absent root stays blank: "automatic, same origin", which is
            // what both the packaged server and the dev proxy are for.
            baseUrl: options.baseUrl ?? '',
            providerUrl: options.providerUrl ?? DEFAULT_PROVIDER_URL,
            ...(options.pollIntervalMs !== undefined
                ? { pollIntervalMs: options.pollIntervalMs }
                : {}),
            ...(options.stream === undefined ? {} : { stream: options.stream })
        }),
        // 8-14. the add-on capabilities, in the order documented in
        //       plugins/extras.ts: agents -> tools -> settings -> voice -> notices
        //       -> inputs -> surfaces. Every one of them is stateless at the FACTORY
        //       level (its per-instance state is created inside setup()), so the same
        //       module-level plugin objects are safe across two dashboards — the
        //       option-bearing add-ons (voice's speech client, notices' row cap) keep
        //       their own factory signatures for a variant build that needs them.
        //       `chat.surfaces` is last on purpose: the shell renders the FINAL
        //       contribution of a channel (WorkstationShell.tsx:62-81).
        ...EXTRA_PLUGINS,
        ...(options.extraPlugins ?? [])
    ];

    return dashboard({ plugins });
}
