# @loadscript/chat

The chat application UI for the underload harness.

`@loadscript/chat` composes the reusable browser client from
[`@loadscript/harness`](../harness) into the Chat Assistant workstation: the
plugin-composed dashboard (sidebar, transcript, composer, inspector), the
`harness.v1` live-stream client, the offline provider transport, and the built
application shell.

The companion server lives in
[`@underload/chat`](../../underload/chat): it hosts the harness listener the UI
talks to at `/v1/harness` (same origin in development through the Vite proxy and
in production when its static root is the built `dist/` from this package).

## Install

```bash
yarn add @loadscript/chat
```

The package publishes TypeScript source (the same policy as the rest of the
workspace): `main`, `module` and `types` all name `src/index.ts`, so consumers
resolve the sources directly.

## Usage

```tsx
import { App, ChatAssistantApp } from '@loadscript/chat';

// The deployment shell (no props: same-origin harness API, offline provider
// default).
export const Chat = () => <App />;

// An embed with explicit endpoints: `baseUrl` is the harness API ROOT ('' =
// automatic, same origin); `providerUrl` is the OFFLINE-mode provider base.
export const Embedded = () => (
    <ChatAssistantApp baseUrl="/v1/harness" providerUrl="http://localhost:8800/providers/private/v1" />
);
```

`ChatAssistantApp` imports the workstation skin as a side effect, so an embed
gets the styled station without a separate stylesheet import.

## Development

```bash
yarn dev     # Vite dev server on :4500, proxying /v1/harness to :5181
yarn test
yarn typecheck
yarn build   # emits dist/
```

Run the companion server in another terminal:

```bash
yarn workspace @underload/chat start
```

## Deployment

Build this package and point the server's static root at the emitted `dist/`:

```bash
yarn build
CHAT_ASSISTANT_STATIC_ROOT="$(pwd)/dist" yarn workspace @underload/chat start
```

The server answers the REST mount, the `harness.v1` WebSocket and the UI from
one listener, so the browser's default same-origin `/v1/harness` needs no
configuration.

## License

ISC
