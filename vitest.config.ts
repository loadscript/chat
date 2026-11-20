// Vitest configuration uses jsdom because the package contains a React chat UI.
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Mirror vite.config.ts's `__APP_VERSION__` define so the tests resolve the
// application version from the same single source (this package's package.json)
// the shipped bundle does — see src/version.ts. A plain global define is used
// (not `import.meta.env.APP_VERSION`) because vitest's runtime materializes
// `import.meta.env` and swallows env-scoped defines in test runs.
const APP_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')).version as string;

// Keep test discovery scoped to this package.
export default defineConfig({
    // Vite 8 transforms JSX with oxc and reads the runtime from the tsconfig at
    // the config root. Pin the automatic runtime here for the same reason the
    // workspace-root vitest config does: a classic transform would require a
    // `React` binding in every test file that renders JSX.
    oxc: {
        jsx: {
            runtime: 'automatic',
            importSource: 'react'
        }
    },
    define: {
        __APP_VERSION__: JSON.stringify(APP_VERSION)
    },
    test: {
        environment: 'jsdom',
        globals: true,
        include: ['src/**/*.{test,spec}.{ts,tsx}'],
        passWithNoTests: true,
        // Under a parallel turbo run this suite's React/streaming tests
        // regularly exceed vitest's default ceilings (5s test / 10s hook) —
        // a timed-out test leaves its in-flight stream running and poisons
        // the next test in the file. Both get explicit headroom here.
        testTimeout: 60_000,
        hookTimeout: 60_000
    }
});
