# @three-ws/agent-sdk

Minimal TypeScript chat + embed SDK for the three.ws agent fabric. One class, zero runtime dependencies. It wraps the three.ws HTTP API so any Node script or web app can stream a conversation with a three.ws agent or drop the agent's hosted UI into a page, without pulling in the full [`@three-ws/sdk`](../README.md) (chat panel, on-chain registration, permissions, Solana helpers).

Use this package when you only need programmatic chat or an iframe embed. Use [`@three-ws/sdk`](../README.md) when you want the floating chat panel, avatar loading, ERC-8004 or Solana registration, or x402 paid agent calls.

## Status

Private workspace package (`"private": true`), consumed inside this repo. It is not published to npm. Built with tsup to dual CJS and ESM with type declarations.

## Build and use

From this directory:

```bash
npm install
npm run build   # tsup src/index.ts -> dist/index.js (ESM), dist/index.cjs (CJS), dist/index.d.ts
```

This package is not in the root npm workspaces list, so the bare specifier `@three-ws/agent-sdk` does not resolve on its own. After building, wire it into your consuming project by path or link:

```bash
# from the consuming project
npm install /workspaces/three.ws/sdk/agent-sdk   # or a relative path, e.g. ../sdk/agent-sdk
# or: run `npm link` here, then `npm link @three-ws/agent-sdk` in the consumer
```

Then import it (the `exports` map resolves ESM, CJS, and types automatically):

```ts
import { Agent, createAgent } from '@three-ws/agent-sdk';
```

`npm run dev` runs the same tsup build in watch mode.

## Exports

Everything lives in [src/index.ts](src/index.ts):

- `Agent`: the client class. Constructor: `new Agent(apiKey, agentId, options?)`.
- `createAgent(apiKey, agentId, options?)`: factory returning a `new Agent(...)`.
- `AgentOptions`: options interface, currently `{ baseUrl?: string }`.

### `new Agent(apiKey, agentId, options?)`

| Argument  | Type           | Description                                                                                      |
| --------- | -------------- | ------------------------------------------------------------------------------------------------ |
| `apiKey`  | `string`       | Sent as `Authorization: Bearer <apiKey>` on chat requests                                        |
| `agentId` | `string`       | three.ws agent id, included in the chat body and the embed URL                                   |
| `options` | `AgentOptions` | `baseUrl` overrides the API origin. Otherwise the `THREE_WS_BASE_URL` env var is used in Node when set, else `https://three.ws` |

### `agent.chat(message, history?)`

`POST`s `{ agentId, message, history }` to `<baseUrl>/api/chat` and returns a `Promise<AsyncIterable>` of parsed server-sent-event payloads. `history` is an optional array of `{ role: 'user' | 'assistant', content: string }`. Non-2xx responses throw `Error('Chat API request failed: <status> <body>')`; malformed SSE chunks are logged with `console.warn` and skipped rather than silently dropped.

### `agent.embed(element)`

Browser only. Appends a borderless full-size `<iframe>` pointing at `<baseUrl>/agent/<agentId>/embed` to the given `HTMLElement`. For the richer web-component embed (animations, camera controls, moods), use [`<agent-3d>`](../README.md#embed-a-3d-avatar) from the main SDK instead.

## Example

Stream a chat reply in Node 18+ (global `fetch` required):

```ts
import { createAgent } from '@three-ws/agent-sdk';

const apiKey = process.env.THREE_WS_KEY;
if (!apiKey) throw new Error('Set THREE_WS_KEY');

const agent = createAgent(apiKey, 'agt_abc123', {
	baseUrl: 'https://three.ws',
});

const stream = await agent.chat('What can you do?', [
	{ role: 'user', content: 'hi' },
	{ role: 'assistant', content: 'Hello! How can I help?' },
]);

for await (const chunk of stream) {
	console.log(chunk);
}
```

## Files

- [src/index.ts](src/index.ts): the whole SDK (`Agent`, `createAgent`, `AgentOptions`)
- [tsup.config.ts](tsup.config.ts): build config (CJS + ESM, dts, sourcemaps)
- [package.json](package.json): scripts and the `exports` map

## Links

- Homepage: https://three.ws
- Changelog: https://three.ws/changelog
- Full-featured sibling: [`@three-ws/sdk`](../README.md)
- Repo: https://github.com/nirholas/three.ws
