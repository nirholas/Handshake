<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/mcp-server</h1>

<p align="center"><strong>MCP tools from three.ws — free text→3D plus paid text/image→3D, avatars, rigging, agent reputation, and more. Paid calls settled per call in USDC.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/mcp-server"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/mcp-server?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/mcp-server"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/mcp-server?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/mcp-server?color=3b82f6">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-7c3aed"></a>
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/mcp-server?color=339933&logo=node.js">
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

<p align="center">
  <a href="#quickstart-30-seconds">Quickstart</a> ·
  <a href="#tools">Tools</a> ·
  <a href="#environment-variables">Config</a> ·
  <a href="#programmatic-client">Programmatic</a> ·
  <a href="#payment-flow">Payments</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> Sixteen MCP tools from [three.ws](https://three.ws) — **one free** (`forge_free`: text prompt → 3D GLB on the free NVIDIA NIM / Microsoft TRELLIS lane, no payment and no API key) and fifteen paid: text/image→3D mesh generation, 3D avatars, GLB auto-rigging, pose seeds, pump.fun snapshots, ERC-8004 agent reputation, ENS/SNS resolution, agent-to-agent delegation, token sentiment, AgenC coordination reads, aixbt market intel, and a Solana vanity grinder. Paid calls are settled in USDC via the [x402](https://x402.org) payment protocol on Solana mainnet (`exact` scheme). No subscription, no API key — pay per call, and failed calls never bill the caller.

---

## Quickstart (30 seconds)

### Claude Code

```bash
claude mcp add 3d-agent -- npx -y @three-ws/mcp-server
```

To also receive payments (server operators), pass the payout address as env: `claude mcp add 3d-agent -e MCP_SVM_PAYMENT_ADDRESS=YourSolanaWallet -- npx -y @three-ws/mcp-server`.

### Claude Desktop

Paste this into your **Claude Desktop** config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
	"mcpServers": {
		"3d-agent": {
			"command": "npx",
			"args": ["-y", "@three-ws/mcp-server"],
			"env": {
				"MCP_SVM_PAYMENT_ADDRESS": "YourSolanaWallet"
			}
		}
	}
}
```

Restart Claude Desktop. All tools appear immediately — no install step required.

---

## Tools

Most tools quote a fixed USDC price and settle `exact` on Solana mainnet (prices below come straight from each tool's source); **`forge_free` is free** — no payment, no wallet, no API key. Every tool also declares MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) so clients can scope confirmation prompts correctly — none of these tools are destructive.

### 3D generation

| Tool             | Price  | What it returns                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forge_free`     | **Free** | Textured 3D GLB from a **text prompt — at zero cost**. Drives the three.ws `/api/forge` pipeline on the free NVIDIA NIM (Microsoft TRELLIS) text→3D lane — the same engine the [`/forge`](https://three.ws/forge) web page uses for prompt drafts. No x402 payment, no wallet, no API key. Pick tier `draft` (fast, default), `standard`, or `high` — all free. Returns the durable `glbUrl`, a three.ws viewer `preview` link, the `tier`, and the `backend` that actually ran. Text-only; for image/multi-view input or the Granite-directed chain use `mesh_forge`. Feed the `glbUrl` to `rig_mesh` to animate it. |
| `mesh_forge`     | $0.25  | Textured 3D GLB from a **text prompt or a reference image**. Text mode runs a chain of specialist models — an IBM Granite "prompt director" rewrites the prompt into an optimized single-subject 3D spec, FLUX renders a reference image, and Microsoft TRELLIS / Tencent Hunyuan3D reconstruct the mesh. Image mode (`image_url`) reconstructs directly. Returns the durable `glbUrl`, a three.ws viewer `preview`, the `directedPrompt`, and timing. |
| `rig_mesh`       | $0.20  | Auto-rig a static GLB into an animation-ready model — humanoid skeleton + per-vertex skin weights via VAST-AI UniRig. Takes a `glb_url` (e.g. `mesh_forge`'s output), returns the `riggedGlbUrl` and a three.ws pose-studio link.                                                                                                                                                                                                                      |
| `text_to_avatar` | $0.15  | Textured 3D GLB avatar from a text prompt or reference image URLs, driving Replicate (Hunyuan-3D 3.1 by default). Returns the GLB URL, model version, prediction id, and timing.                                                                                                                                                                                                                                                                       |
| `get_pose_seed`  | $0.001 | Deterministic seed + full Euler-rotation pose map (radians) for the three.ws pose-studio mannequin, matched from the in-repo preset library. Includes a `previewUrl` at `https://three.ws/pose?seed=…&preset=…`.                                                                                                                                                                                                                                       |

### Solana & markets

| Tool              | Price  | What it returns                                                                                                                                                                                                                                                                         |
| ----------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pump_snapshot`   | $0.005 | Live token snapshot — USD price (Jupiter), 24h volume + pair (Dexscreener), mint metadata + image (pump.fun frontend-api-v3), and on-chain top-holder distribution (Solana RPC). Adds Helius DAS data when `HELIUS_API_KEY` is set.                                                     |
| `sentiment_pulse` | $0.003 | Sentiment for a Solana token: scores recent pump.fun comments (plus optional caller-supplied snippets) with the three.ws deterministic lexicon. Returns overall + per-source breakdown with examples. Pairs with `pump_snapshot`.                                                       |
| `vanity_grinder`  | $0.05  | Solana keypair whose base58 address starts with `prefix` (and optionally ends with `suffix`). Returns the full base58 secret key — treat as a secret. Flat price (override with `MCP_VANITY_PRICE_USD`); a difficulty guard rejects prefixes too long to mine within the iteration cap. |
| `aixbt_intel`     | $0.01  | aixbt narrative intelligence feed — recent intel items across crypto with category, description, observation count, official-source flag, and the project/ticker concerned. Optional category/chain filter. Live aixbt REST API.                                                        |
| `aixbt_projects`  | $0.01  | aixbt momentum scan — projects ranked by spiking/climbing/active scores, with ticker, chain, market metrics (price, mcap, 24h volume + change), and recent intel. Filter by names or chain. Live aixbt REST API.                                                                        |
| `crypto_news`     | FREE   | Live crypto headlines aggregated natively by three.ws from 192 publisher RSS/Atom feeds in 17 languages — filter by category, source, or language, or full-text search. Each article carries the publisher link, publish time, detected tickers, and lexicon sentiment. No payment, no key.       |
| `crypto_news_digest` | FREE | The last 1–72h of coverage clustered into distinct narratives — title, plain-language summary, bullish/bearish stance, tickers, coverage count, and every real article behind each story. Names its engine honestly (`llm` semantic grouping or `heuristic` Jaccard clustering). No payment, no key. |
| `crypto_news_archive` | FREE | Search 660,000+ archived articles back to September 2017 (refreshed hourly) by keyword, ticker, source, date range, sentiment, or language — with market context at publication where captured. `mode: stats` and `mode: trending` for corpus statistics and most-covered tickers. No payment, no key. |

### Agents & identity

| Tool                    | Price   | What it returns                                                                                                                                                                                                                                              |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent_reputation`      | $0.01   | ERC-8004 reputation: `getReputation`, `getTotalStake`, and the latest `ReputationSubmitted` / `ReputationStaked` events from the canonical ReputationRegistry on the requested chain (default Base). Resolves `agentId` from a wallet address automatically. |
| `agent_delegate_action` | $0.01   | Send a message to a three.ws-registered agent and receive its response (it uses its configured Claude model + system prompt). Agents opted out of MCP delegation are refused. For agent-to-agent collaboration and tool composition.                         |
| `ens_sns_resolve`       | $0.0005 | Resolve a human-readable name across **ENS** (`.eth` → Ethereum address via ethers) and **SNS** (`.sol` → Solana owner wallet via Bonfida, plus the wallet's other owned `.sol` domains). Suffix-less names are tried against both.                          |
| `agenc_list_tasks`      | $0.001  | List every public AgenC task created by a Solana wallet — task PDA, state, reward, deadline, worker counts, reward mint. AgenC (agenc.tech, Tetsuo Corp) is a Solana task-coordination protocol. `cluster` defaults to mainnet.                              |
| `agenc_get_task`        | $0.001  | On-chain state + lifecycle timeline of a single AgenC task. Pass `taskPda` or `{creator, taskId}` (hex or any UTF-8 label). Returns state, reward, deadline, worker counts, lifecycle events, reward mint.                                                   |
| `agenc_get_agent`       | $0.001  | An AgenC agent's on-chain registration. Pass `agentPda` or `agentId` (hex or UTF-8 label). Returns authority wallet, capability bitmask, endpoint URL, status, reputation, stake, and active task count.                                                     |

---

## Installation

The server runs locally on your machine and speaks stdio JSON-RPC — your MCP client spawns it automatically via the `npx` command above. You do not need to `npm install` globally.

If you prefer a global install:

```bash
npm install -g @three-ws/mcp-server
```

Then replace `"command": "npx", "args": ["-y", "@three-ws/mcp-server"]` with `"command": "3d-agent-mcp"` in your config.

---

## Environment variables

### Payout (set this to receive payments yourself)

| Var                       | Description                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `MCP_SVM_PAYMENT_ADDRESS` | Solana USDC payout address (base58) where tools receive payment. Falls back to `X402_PAY_TO_SOLANA` / `X402_PAY_TO`. **If unset, the server still boots and routes paid-call USDC to the three.ws platform payout** — set this to a 32–44 char base58 wallet to collect payments yourself. A configured-but-malformed address fails fast. |

### Optional

| Var                             | Default                               | Description                                                                                                        |
| ------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `HELIUS_API_KEY`                | unset                                 | Adds Helius DAS enrichment to `pump_snapshot`                                                                      |
| `SOLANA_RPC_URL`                | `https://api.mainnet-beta.solana.com` | Primary Solana RPC for `pump_snapshot` / AgenC reads                                                               |
| `SOLANA_RPC_URLS`               | built-in public set                   | **Failover** — comma-separated Solana RPCs tried in order; first healthy one answers                               |
| `MCP_EVM_RPC_<chainId>`         | built-in public set                   | **Failover** — comma-separated EVM RPCs for that chain (`agent_reputation`, ENS uses chain 1)                      |
| `X402_FACILITATOR_URL_SOLANA`   | `https://facilitator.payai.network`   | Primary PayAI Solana facilitator that verifies + settles payments                                                  |
| `X402_FACILITATOR_URLS_SOLANA`  | unset                                 | **Failover** — comma-separated facilitators; earlier entries take precedence at init, a later one covers an outage |
| `X402_FACILITATOR_TOKEN_SOLANA` | unset                                 | Bearer token for the Solana facilitator, if required                                                               |
| `X402_FEE_PAYER_SOLANA`         | three.ws default                      | Fee payer for the settlement transaction                                                                           |
| `MCP_VANITY_PRICE_USD`          | `$0.05`                               | Flat price for `vanity_grinder`                                                                                    |
| `FORGE_FREE_API_BASE`           | `https://three.ws`                    | three.ws origin the free `forge_free` tool calls (`/api/forge`)                                                    |
| `FORGE_FREE_TIMEOUT_MS`         | `180000`                              | `forge_free` poll budget before it returns a resumable `timeout`                                                   |
| `FORGE_FREE_POLL_MS`            | `3000`                                | `forge_free` poll interval while a queued job runs                                                                 |
| `FORGE_FREE_ATTEMPTS`           | `2`                                   | Max `forge_free` generations to prefer a **durable** result when the NVIDIA lane degrades (1–4). It never returns a confirmed-dead URL as success |
| `MCP_REVIEW_SECRET`             | unset                                 | **Review entitlement.** When set, a caller presenting a matching `MCP_REVIEW_MODE` runs paid tools for real with **no charge** (connector-review access). Off unless set — never bypassable on a normal install |
| `MCP_REVIEW_MODE`               | unset                                 | Client-side value that must equal the server's `MCP_REVIEW_SECRET` to activate the review entitlement above        |
| `MCP_POSE_PREVIEW_BASE`         | `https://three.ws/pose`               | Base URL for `get_pose_seed` preview links                                                                         |
| `MCP_AGENT_TALK_TOKEN`          | unset                                 | Platform service credential (`api_keys` bearer, scope `agents:delegate`) the `agent_hire` / `agent_delegate_action` tools present to `/api/agents/talk`. That endpoint burns platform LLM credit and requires a principal — **without this token a paid hire's delegation 401s and the x402 payment cancels (the hire cannot deliver).** Falls back to `THREE_WS_MCP_TOKEN` / `MCP_SERVICE_TOKEN` |
| `MCP_AGENT_HIRE_PRICE_USD`      | `$0.05`                               | The platform delegation fee `agent_hire` settles per hire                                                          |
| `MCP_AGENT_HIRE_MAX_PER_CALL_USD` | `$1`                                | Hard per-call spend cap — a hire above this is refused before any payment                                          |
| `MCP_AGENT_HIRE_MAX_PER_SESSION_USD` | `$5`                             | Cumulative per-session spend cap across one connection                                                             |
| `MCP_AGENT_HIRE_CONFIRM_THRESHOLD_USD` | `$0.50`                        | Hires at or above this require an explicit `confirm: true`                                                          |
| `MCP_AGENT_HIRE_MIN_REPUTATION` | `0`                                   | Default ERC-8004 reputation floor for hires (0 = don't gate; a caller can raise it per call)                        |
| `MCP_AGENT_REP_RPC_<chainId>`   | public RPC                            | Per-chain RPC override for `agent_reputation` (tried before the failover set)                                      |
| `MCP_AGENT_REP_LOG_WINDOW`      | `200000`                              | Block window for `agent_reputation` event scan                                                                     |
| `X402_ASSET_MINT_SOLANA`        | USDC (`EPjFW…Dt1v`)                   | SPL mint settled as the payment asset (defaults to Solana USDC)                                                    |
| `SOLANA_DEVNET_RPC_URL`         | public devnet                         | Devnet RPC for the AgenC tools when `cluster: "devnet"`                                                            |
| `AGENC_RPC_URL`                 | unset                                 | Single-endpoint override for all AgenC reads (wins over cluster defaults)                                          |
| `MCP_ENS_RPC_URL` / `MAINNET_RPC_URL` | failover set                    | Ethereum-mainnet RPC override for `ens_sns_resolve`                                                                |
| `MESH_FORGE_TIMEOUT_MS` / `MESH_FORGE_POLL_MS` | `180000` / `3000`      | `mesh_forge` reconstruct poll budget / interval                                                                   |
| `MESH_FORGE_DIRECTOR`           | `1` (on)                              | Set `0` to skip the IBM Granite prompt-director stage in `mesh_forge`                                              |
| `RIG_MESH_TIMEOUT_MS` / `RIG_MESH_POLL_MS` | `180000` / `3000`          | `rig_mesh` poll budget / interval                                                                                  |

### `text_to_avatar` (Replicate)

The `text_to_avatar` tool drives Replicate. If the two vars below are unset it returns a `not_configured` error instead of generating — every other tool works without them.

| Var                            | Default                | Description                                                              |
| ------------------------------ | ---------------------- | ----------------------------------------------------------------------- |
| `REPLICATE_API_TOKEN`          | unset (**required**)   | Replicate API token used to submit the prediction                       |
| `REPLICATE_TEXT_TO_AVATAR_MODEL` | unset (**required**) | Pinned commercial-OK image/text-to-3D version hash (e.g. Hunyuan-3D 3.1) |
| `MCP_TEXT_TO_AVATAR_TIMEOUT_MS` / `MCP_TEXT_TO_AVATAR_POLL_MS` | `110000` / `2000` | Prediction poll budget / interval |
| `MCP_TEXT_TO_AVATAR_REHOST`    | `0`                    | Set `1` to rehost the Replicate GLB to three.ws R2 via `MCP_REHOST_ENDPOINT` + `MCP_REHOST_KEY` |

---

## Programmatic client

Use `@x402/mcp`'s `wrapMCPClientWithPayment` to call these tools from another Node service. The wrapper auto-handles 402 retries:

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { wrapMCPClientWithPayment } from '@x402/mcp';
import { x402Client } from '@x402/core/client';
import { registerExactSvmScheme } from '@x402/svm/exact/client';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const transport = new StdioClientTransport({
	command: 'npx',
	args: ['-y', '@three-ws/mcp-server'],
	env: {
		// Where the server receives USDC. Your client funds payments from the
		// Solana keypair below.
		MCP_SVM_PAYMENT_ADDRESS: process.env.MCP_SVM_PAYMENT_ADDRESS,
	},
});

const mcp = new Client({ name: 'agent', version: '1.0.0' });
await mcp.connect(transport);

// Solana mainnet, `exact` scheme — the only network/scheme these tools accept.
const payer = Keypair.fromSecretKey(bs58.decode(process.env.AGENT_SOLANA_SECRET_KEY));
const x402 = new x402Client();
registerExactSvmScheme(x402, { signer: payer });
const paid = wrapMCPClientWithPayment(mcp, x402, { autoPayment: true });

const result = await paid.callTool('get_pose_seed', { prompt: 'warrior stance' });
// Prefer MCP structured output; fall back to the text mirror for older servers.
console.log(result.structuredContent ?? JSON.parse(result.content[0].text));
```

`forge_free` needs no payer — it never emits a 402 — so you can call it on the **bare** MCP client (the one before `wrapMCPClientWithPayment`):

```js
// Free text → 3D — no wallet, no payment, no API key.
const free = await mcp.callTool('forge_free', { prompt: 'a glossy white robot mascot', tier: 'draft' });
const out = free.structuredContent ?? JSON.parse(free.content[0].text);
console.log(out.glbUrl, out.preview); // durable GLB + in-browser viewer link
```

---

## Cursor

In Cursor's MCP settings (`Cursor > Settings > Features > MCP`):

```json
{
	"mcpServers": {
		"3d-agent": {
			"command": "npx",
			"args": ["-y", "@three-ws/mcp-server"],
			"env": {
				"MCP_SVM_PAYMENT_ADDRESS": "YourSolanaWallet"
			}
		}
	}
}
```

---

## Run from source

From the monorepo root:

```bash
npm install
node mcp-server/src/index.js
```

Inspect tools interactively:

```bash
npm run inspect --prefix mcp-server
```

---

## Payment flow

The server is the x402 **resource server**. On each tool call:

1. Client sends a `tools/call` request (no payment yet).
2. Server returns `PaymentRequired` (v2 MCP transport spec) with the USDC amount and payment address.
3. A payment-aware client (or `wrapMCPClientWithPayment`) signs and submits the on-chain payment.
4. Client retries the `tools/call` with `_meta["x402/payment"]` attached.
5. Server verifies + settles via the configured facilitator, runs the tool, and returns the result with `_meta["x402/payment-response"]`.

Every tool settles in USDC on **Solana mainnet** with the `exact` scheme (`@x402/svm` ships no `upto`/metered scheme). Each tool quotes a fixed price; there is no post-hoc metering.

A successful result carries the tool's JSON in two forms: `content[0].text` (for text-only clients) and `structuredContent` (MCP 2025-06-18 structured output — a ready-to-use object). A tool-level error sets `isError: true`, and the x402 wrapper **cancels rather than settles** the payment, so failed calls do not bill the caller.

---

## Reliability & failover

Every external dependency has a backup path, so a single provider blip doesn't take a tool down — and no call can hang a paid request indefinitely.

- **Every outbound HTTP call** runs through a shared resilient layer (`src/lib/resilient-fetch.js`): a hard per-attempt timeout plus jittered exponential-backoff retries on transient `429`/`5xx`/network errors, honoring `Retry-After`. Retries are restricted to idempotent reads by default — a non-idempotent action like `agent_delegate_action` gets the timeout but is **never** silently replayed.
- **Solana RPC** (`src/lib/solana-rpc.js`) fails over across an ordered endpoint list (`SOLANA_RPC_URLS`, else the primary, else a built-in public set). A throttling or down endpoint rotates to the back and the next one answers.
- **EVM RPC** (`src/lib/evm-rpc.js`) uses an ethers `FallbackProvider` (quorum 1) over multiple endpoints per chain (`MCP_EVM_RPC_<chainId>` or built-in redundancy), each request timeout-bounded.
- **The x402 facilitator** accepts a comma-separated `X402_FACILITATOR_URLS_SOLANA`: earlier entries take precedence at init, and a later facilitator covers the Solana `exact` kind if the primary's `/supported` is unreachable.
- **Data fallback:** `pump_snapshot` cross-fills its USD price from Dexscreener when Jupiter is unavailable, and each upstream fails soft to a `null`/`{ error }` field rather than failing the whole snapshot.

For maximum redundancy, set dedicated endpoints rather than relying on the public defaults:

```bash
SOLANA_RPC_URLS="https://your-primary-rpc,https://your-secondary-rpc"
MCP_EVM_RPC_8453="https://your-base-rpc,https://base-rpc.publicnode.com"
X402_FACILITATOR_URLS_SOLANA="https://facilitator.payai.network,https://your-backup-facilitator"
```

---

## Architecture

```
┌─────────────────┐     ┌─────────────────────┐     ┌──────────────────────┐
│ Claude Desktop  │────▶│ @three-ws/mcp-server │────▶│  x402 facilitator    │
│  / Cursor /     │     │   (stdio transport) │     │  (PayAI — Solana     │
│  your agent     │     │                     │     │   USDC, exact)       │
└─────────────────┘     └─────────────────────┘     └──────────────────────┘
```

Source: [`mcp-server/`](https://github.com/nirholas/three.ws/tree/main/mcp-server)

---

## Requirements

- Node.js **>= 20** (from `engines`).
- A Solana USDC payout address in `MCP_SVM_PAYMENT_ADDRESS` (or `X402_PAY_TO_SOLANA` / `X402_PAY_TO`) to settle paid calls — see [Environment variables](#environment-variables). Tool registration (names/schemas) needs no env; only an actual paid invocation does.
- A payment-aware MCP client (or `@x402/mcp`'s `wrapMCPClientWithPayment`) funding payments from a Solana keypair.

## Related

- [`@three-ws/pumpfun-mcp`](https://www.npmjs.com/package/@three-ws/pumpfun-mcp) — the free, read-only pump.fun + Solana MCP (token discovery, on-chain analysis, live 3D snapshots; no keys).

## Links

- Homepage: https://three.ws
- Changelog: https://three.ws/changelog
- Issues: https://github.com/nirholas/three.ws/issues
- License: Apache-2.0 — see [LICENSE](./LICENSE)

---

<p align="center">
  <sub>
    Part of the <a href="https://three.ws">three.ws</a> SDK suite — 3D AI agents, on-chain identity, and agent payments.<br/>
    <a href="https://three.ws">Website</a> · <a href="https://three.ws/changelog">Changelog</a> · <a href="https://github.com/nirholas/three.ws">GitHub</a>
  </sub>
</p>
