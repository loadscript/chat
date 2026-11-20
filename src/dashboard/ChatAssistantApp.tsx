// Public application shell of the rebuilt chat assistant.
//
// Same exported props shape as the pre-rebuild component it replaces
// ({ baseUrl?, providerUrl? }, see src/components/ChatAssistantApp.tsx), so
// src/App.tsx and any embedder keep working while the surface underneath becomes
// the plugin-composed workstation.
//
// Responsibilities (and nothing else):
//   1. resolve the deployment defaults from ../api — the harness API ROOT (automatic,
//      same origin, unless a `baseUrl` is declared: api/harness.ts) and the OFFLINE-mode
//      provider base (DEFAULT_PROVIDER_URL, api/provider.ts) — never hardcoded in the
//      surface, and never a bare origin for the provider;
//   2. build ONE dashboard instance for this mount (composition.ts);
//   3. tear it down on unmount in the order the framework requires;
//   4. provide the instance through context and render the skin.
//
// Disposal ordering, the part that is easy to get wrong:
//
//   React unmounts bottom-up, so a child's useSyncExternalStore unsubscribe runs
//   BEFORE this component's own effect cleanup. Deferring dispose() one microtask
//   past that cleanup adds the second half of the guarantee and, more
//   importantly, survives React 18 StrictMode: StrictMode runs
//   setup -> cleanup -> setup for the same committed tree, and the re-run setups
//   are again child-first. A synchronous dispose() in the cleanup would therefore
//   leave the children re-subscribing to detached state cells, and a detached
//   cell throws DashboardError('disposed') on get()/subscribe() (see
//   packages/underload/dashboard/src/extensions/state.ts). The deferred dispose is
//   cancelled by the second setup, so the instance simply stays alive; on a real
//   unmount no setup follows, and the microtask disposes exactly once.
//
// The instance is built once per mount: changing baseUrl/providerUrl after mount
// does not rebuild it (an embedder remounts by keying this component instead),
// because rebuilding would drop every state cell mid-session.
import { memo, useEffect, useRef } from 'react';
import type { Dashboard } from '@underload/dashboard';
// The vendored workstation skin travels WITH this export (R15). The pre-rebuild
// component self-styled through Emotion (`styledComponent`), so an embedder that
// imported `ChatAssistantApp` got a styled station with no setup; the rebuild
// styles through plain CSS files instead, and only src/main.tsx imported them —
// which left every consumer of the export rendering an unstyled DOM tree. A
// side-effect import here is the exact equivalent of the old Emotion wiring: Vite
// dedupes the module, so the build still emits ONE CSS asset (verified with
// `vite build`), and the app entry keeps its own import for the standalone
// bundle (src/main.tsx).
import './styles/index.css';
// Deployment defaults, single source of truth. The two are NOT the same kind of address
// since the rebuild: `baseUrl` is the harness API ROOT ('' = automatic, same origin,
// api/harness.ts `harnessApiRoot`), while `providerUrl` is the OFFLINE-mode provider base
// that api/provider.ts turns into '{base}/models' and '{base}/chat/completions'. Online
// inference is the SERVER's provider (@underload/chat/src/server/config.ts), never a browser default.
// Composition and options agree on these same two constants (composition.ts, and the
// `ChatConfig` both plugins and the store read).
import { DEFAULT_PROVIDER_URL } from '../api/provider';
import { createChatDashboard } from './composition';
import { WorkstationShell } from './WorkstationShell';
import { WorkbenchProvider } from './workbench';

export type ChatAssistantAppProps = {
    /**
     * The HARNESS API ROOT this UI dials — the REBUILT meaning of the unchanged
     * prop name (decision 3). Accepts the same forms the harness client accepts:
     * a rooted path (`/v1/harness`) or an absolute `http(s)://host/v1/harness`.
     *
     * OMITTED is the normal case and means "same origin as this page": the chat
     * server (`@underload/chat/src/server/main.ts`) serves the API, the stream and the built UI
     * from one listener, and the Vite dev proxy forwards `/v1/harness` (http +
     * ws) to it, so the SPA needs no configuration in dev or in production.
     *
     * A DECLARED root is persisted through the harness client's own setting
     * (`configureHarnessApiRoot`, api/harness.ts) because that client resolves one
     * root per page load — every REST URL and the socket URL are built from it.
     * A change therefore takes effect on the next reload, which is the honest
     * contract rather than a per-request re-point the old client could do.
     */
    baseUrl?: string;
    /**
     * The provider base OFFLINE mode streams through (the pre-rebuild
     * `providerUrl` meaning, narrowed to what it now is). ONLINE inference belongs
     * to the SERVER's provider configuration (`@underload/chat/src/server/config.ts`), never to a
     * browser prop, so this value only seeds the offline transport when the
     * operator has configured nothing in Settings.
     */
    providerUrl?: string;
};

export const ChatAssistantApp = memo(function ChatAssistantApp({
    // '' = "automatic, same origin" — the documented default, resolved by the
    // harness client rather than by this component (see the prop's jsdoc).
    baseUrl = '',
    providerUrl = DEFAULT_PROVIDER_URL
}: ChatAssistantAppProps = {}) {
    // Built during the first render (not in an effect) so the very first commit
    // already has a live instance: a dashboard is synchronous by contract, and
    // deferring it would mean a render pass with no shell. The ref write is
    // idempotent, which is what keeps StrictMode's double render from leaking a
    // second instance.
    const instanceRef = useRef<Dashboard | null>(null);
    if (instanceRef.current === null) {
        instanceRef.current = createChatDashboard({ baseUrl, providerUrl });
    }
    const instance = instanceRef.current;

    // Cancel handle for the dispose scheduled by the previous cleanup, if any.
    const cancelDisposeRef = useRef<(() => void) | null>(null);

    useEffect(() => {
        // A remount (StrictMode, Fast Refresh) re-entering this setup means the
        // tree is still live: retract the pending teardown.
        const cancel = cancelDisposeRef.current;
        if (cancel !== null) {
            cancelDisposeRef.current = null;
            cancel();
        }

        return () => {
            // Children have already unsubscribed (bottom-up unmount), so nothing
            // in the tree can observe this dispose; the microtask only exists so
            // a StrictMode re-setup can still cancel it.
            let cancelled = false;
            cancelDisposeRef.current = () => {
                cancelled = true;
            };
            queueMicrotask(() => {
                if (cancelled) {
                    return;
                }
                cancelDisposeRef.current = null;
                // dispose() is idempotent and collects its own cleanup failures;
                // a teardown error must never surface as an unhandled rejection.
                try {
                    instance.dispose();
                } catch {
                    // cleanup-failed: the dashboard is disposed regardless. The
                    // chat transports own their teardown diagnostics.
                }
            });
        };
    }, [instance]);

    return (
        <WorkbenchProvider instance={instance}>
            {/* The shell takes no props here: it reads brand, regions, slots and
                the three skin cells out of the instance through context. */}
            <WorkstationShell />
        </WorkbenchProvider>
    );
});
