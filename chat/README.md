# chat/ (three.ws Chat)

The Svelte chat client served in production at **https://three.ws/chat**. It is the
conversational surface of three.ws: multi-provider LLM chat with tool calling, inline
3D model generation and viewing, agent wallets, and the skills marketplace, all wired
to the platform's own `api/` handlers.

## Upstream and license

This app started as a fork of **eplus** (https://eplus.chat), a fast, light, open chat
UI with a Go tool server; the tool server ([server/](server)) and sync server
([sync/](sync)) still follow its design (write a Go function in
[server/toolfns/toolfns.go](server/toolfns/toolfns.go), its comment becomes the tool
description, click Sync in the UI). The three.ws copy has diverged heavily: platform
auth, wallets, forge tools, and the inline 3D viewer are all three.ws additions.
This directory is covered by [LICENSE](LICENSE) (proprietary, copyright 2026 nirholas).

## What it does

- **Models**: a Built-in free lane (server-selected `:free` models via `POST /api/chat/proxy`,
  no key needed) plus bring-your-own-key providers (OpenRouter, Anthropic, OpenAI, Groq,
  Mistral, local Ollama). Keys are stored only in the browser's localStorage and sent
  browser-to-provider. The live model list comes from `GET /api/chat/models`; defaults
  from `GET /api/chat/config` ([src/providers.js](src/providers.js), [src/stores.js](src/stores.js)).
- **3D in chat**: the `ForgeTextTo3D` and `ForgeAvatar` client tools call the free forge
  lane (`POST /api/forge`, `/api/forge?action=rig`, `/api/avatars/from-forge`) and return an
  `application/model-3d` envelope that [src/ModelViewer3D.svelte](src/ModelViewer3D.svelte)
  renders inline: orbit controls, animation playback, skeleton toggle, AR, GLB download.
  Pasted `.glb` links auto-render too, proxied through `/api/glb?src=` when the host lacks CORS.
- **Conversations** live entirely in the browser (localStorage), with optional
  end-to-end-encrypted sync through the Go server in [sync/](sync).

## Local development

```sh
cd chat
npm ci            # or: node scripts/ensure-deps.mjs
npm run dev       # http://localhost:5173
```

The dev server ([vite.config.js](vite.config.js)) does three things for you:

- Proxies `/api/*` to `https://three.ws` (override with `DEV_API_PROXY`, see below), so
  auth, forge jobs, and paid calls hit the real backend during development.
- Serves `/animations/*` and `/avatars/*` from the repo's `../public`, and `/agent-3d/*`
  from `../dist-lib`, so 3D features work without a root build.
- Aliases `$src` to [src/](src) and `$shared` to `../src/shared` (the app imports the
  platform's `portable-wallet.js` from there: one repo, one wallet truth).

`npm run format` / `format:check` run Prettier. There is no test suite inside `chat/`;
platform tests live in the repo root (`npm test`).

## How production builds it

`npm run build:chat` at the repo root runs [scripts/ensure-deps.mjs](scripts/ensure-deps.mjs)
(skips `npm ci` when `package-lock.json` is unchanged), then `vite build` with
`base: '/chat/'` into `../public/chat`, then copies that into `dist/chat/`.

In the deploy chain, `build:chat` is a step inside `npm run build:gcp`, ordered before
the root frontend `vite build`. That order is load-bearing: the root build empties
`dist/` and then copies `public/` (which now contains the fresh `public/chat`) into it,
so the chat bundle survives the wipe. The full chain is encoded in `build:gcp` in the
root `package.json`; the deploy runbook lives in
[../docs/ops/gcp-production.md](../docs/ops/gcp-production.md). The deploy worktree
must hardlink `chat/node_modules` (`cp -al`), or the chat build dies with
`Cannot find package '@sveltejs/vite-plugin-svelte'`.

At runtime, [../server/index.mjs](../server/index.mjs) serves `dist/` and applies the
route table from [../vercel.json](../vercel.json): `/chat` and `/chat/` rewrite to
`/chat/index.html`, `/chat/(.*)` serves the built assets. The page is declared in
`../data/pages.json` (path `/chat`), which feeds the sitemap and changelog.

## Environment variables

The built client ships no secrets and reads no runtime env vars.

| Variable | Where | Effect |
|---|---|---|
| `DEV_API_PROXY` | dev only, shell env | Upstream for the Vite `/api/*` proxy (default `https://three.ws`) |
| `BUILD_TIMESTAMP` | build time | Injected by [vite.config.js](vite.config.js) via `define`, shown in the UI |

The Built-in free lane depends on `OPENROUTER_API_KEY` being set on the platform API
(the Cloud Run service), not on anything in this directory.

## Platform integration points

Everything below is a real `api/` handler in the repo root, reached same-origin:

- **Chat**: `/api/chat/models`, `/api/chat/config`, `/api/chat/proxy` (free lane with
  moderation and model failover), `/api/chat-skills`, `/api/tts/google` (voice).
- **Auth and identity**: `/api/auth/me`, `/api/csrf-token` (cookie session shared with
  the rest of three.ws).
- **Forge and 3D**: `/api/forge` (create, poll, rig), `/api/avatars/from-forge`,
  `/api/glb` (CORS proxy), `/api/nft/resolve`.
- **Agents and marketplace**: `/api/agents/*`, `/api/marketplace/agents`,
  `/api/skills`, `/api/skills/*`, `/api/skills-manifest`.
- **Wallet and payments** ([src/AgentWallet.svelte](src/AgentWallet.svelte),
  [src/walletAuth.js](src/walletAuth.js)): `/api/wallet/balances`,
  `/api/tx/solana/build-transfer`, `/api/tx/solana/build-swap`, `/api/tx/explain`,
  `/api/x402-pay`, `/api/billing/*`, `/api/agents/payments/*`.
- **Launches** (platform launcher, runtime mint input): `/api/pump/quote`,
  `/api/pump/launch-prep`, `/api/pump/launch-confirm`, `/api/pump/sell-prep`,
  `/api/pump/balances`, `/api/pump-fun-mcp`.
- **Scenes and notifications**: `/api/scene/gate-check`, `/api/scene/gate-create`,
  `/api/nft/mint-scene`, `/api/notifications`.
