// Vite configuration for @loadscript/chat.
//
// WHAT CHANGED IN THE HARNESS REBUILD (R2): the UI no longer dials absolute LAN
// origins. It talks SAME ORIGIN to `/v1/harness`, because the companion server
// (`@underload/chat`) answers the REST mount, the `harness.v1` WebSocket and the
// built UI from ONE listener. The absolute-URL strategy of the previous revision
// existed for GitHub Pages, where the static host serves no API at all; Pages is
// gone (see MISSING-FEATURES.md in @underload/chat), so the proxy below is the
// only routing the browser ever needs to know about.
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Application version: read once from this package's package.json and injected
// as the `__APP_VERSION__` define so the UI (src/version.ts) never carries a
// hardcoded duplicate of the "version" field. A plain global define (rather
// than `import.meta.env.APP_VERSION`) is used because vitest's runtime rewrites
// `import.meta.env` access, which silently swallows env-scoped defines during
// test runs; a plain identifier is substituted by esbuild identically in the
// vite build, the dev server, and vitest.
const APP_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')).version as string;

// The dev proxy target: the chat server this UI talks to
// (`yarn workspace @underload/chat start`, default port 5181). Kept in sync
// with DEFAULT_HOST/DEFAULT_PORT in @underload/chat's server config, and
// overridable through HARNESS_DEV_TARGET for a developer who runs the server
// elsewhere.
const DEV_API_TARGET = process.env.HARNESS_DEV_TARGET ?? 'http://127.0.0.1:5181';

export default defineConfig({
    plugins: [react()],
    // Pin the package.json version into the bundle (see the APP_VERSION note
    // above) — mirrors the define in vitest.config.ts so tests assert the same
    // value the shipped UI renders.
    define: {
        __APP_VERSION__: JSON.stringify(APP_VERSION)
    },
    // Relative assets keep the build servable from any path, including a host
    // that mounts the UI under a prefix.
    base: './',
    server: {
        port: 4500,
        // THE DEV PROXY (decision 3): `/v1/harness` is the one root the UI dials,
        // so proxying it makes `yarn dev` on :4500 same-origin with the chat
        // server on :5181 — REST AND WEBSOCKET. `ws: true` is not optional: the
        // live deltas ride `wss?://<origin>/v1/harness/stream` with the
        // `harness.v1` subprotocol, and the standalone harness listener sends no
        // CORS headers at all (it is a same-origin server), so without the socket
        // upgrade path the composer would stream nothing in development.
        proxy: {
            '/v1/harness': {
                target: DEV_API_TARGET,
                changeOrigin: true,
                ws: true
            }
        },
        // Never watch the server's shared writable data root: chokidar holding
        // files under temporary/harness while the harness persists a turn
        // surfaces as sporadic EPERM failures on Windows.
        watch: {
            ignored: ['**/temporary/**']
        }
    },
    build: {
        outDir: 'dist'
    }
});
