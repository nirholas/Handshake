<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/ibm-x402-mcp</h1>

<p align="center"><strong>Pay-per-use IBM Granite AI over MCP — chat, code, embeddings, analysis, and forecasting, billed in USDC on Solana. No IBM account required.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/ibm-x402-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/ibm-x402-mcp?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/ibm-x402-mcp"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/ibm-x402-mcp?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/ibm-x402-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/ibm-x402-mcp?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas%2Fibm--x402--mcp-6e56cf"></a>
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#tools">Tools</a> ·
  <a href="#payment-flow">Payment flow</a> ·
  <a href="#requirements">Requirements</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes IBM Granite foundation models as pay-per-use tools via the [x402](https://x402.org) payment protocol. End users pay **USDC on Solana** per call — no IBM Cloud account of their own. The server operator supplies IBM credentials (`WATSONX_*`) and a receiving Solana wallet (`MCP_SVM_PAYMENT_ADDRESS`); callers supply only USDC. One free tool (`ibm_granite_getting_started`) explains prices and the flow before any payment.

> Built by [three.ws](https://three.ws). Community-built and not affiliated with IBM.

## How it works

1. An MCP client (Claude Desktop, Claude Code, Cursor, or an agent) connects to this server.
2. The client calls a tool — e.g. `ibm_granite_chat`.
3. Without an x402 payment payload, the server returns a `402 PaymentRequired` envelope quoting the USDC price and the Solana receiving address.
4. The client signs a Solana USDC transfer and retries with the payment in `_meta["x402/payment"]`.
5. The server verifies and settles the payment via the facilitator, calls IBM watsonx.ai, and returns the result with a settlement receipt in `_meta["x402/payment-response"]`.

x402-capable MCP clients handle this loop automatically.

## Install

```bash
npm install @three-ws/ibm-x402-mcp
```

Run it directly with `npx` (no install needed):

```bash
MCP_SVM_PAYMENT_ADDRESS=<your-solana-wallet> \
WATSONX_API_KEY=<ibm-api-key> \
WATSONX_PROJECT_ID=<watsonx-project-id> \
npx @three-ws/ibm-x402-mcp
```

Or install globally for the `ibm-x402-mcp` binary on your `PATH`:

```bash
npm install -g @three-ws/ibm-x402-mcp
```

## Quick start

Whoever runs the process is the **operator**: the server fails fast at startup without a payment address and IBM credentials (`WATSONX_API_KEY`, `WATSONX_PROJECT_ID`). Callers of the running server need only USDC — no IBM account. With Claude Code, one command:

```bash
claude mcp add ibm-granite-x402 \
  -e MCP_SVM_PAYMENT_ADDRESS=your-solana-wallet \
  -e WATSONX_API_KEY=your-ibm-api-key \
  -e WATSONX_PROJECT_ID=your-watsonx-project-id \
  -- npx -y @three-ws/ibm-x402-mcp
```

Or wire the server into your MCP client config (`claude_desktop_config.json`, Cursor's `mcp.json`):

```json
{
	"mcpServers": {
		"ibm-x402": {
			"command": "npx",
			"args": ["-y", "@three-ws/ibm-x402-mcp"],
			"env": {
				"MCP_SVM_PAYMENT_ADDRESS": "your-solana-wallet-address",
				"WATSONX_API_KEY": "your-ibm-cloud-api-key",
				"WATSONX_PROJECT_ID": "your-watsonx-project-id"
			}
		}
	}
}
```

Inspect the tool surface with the MCP Inspector:

```bash
npx -y @modelcontextprotocol/inspector npx @three-ws/ibm-x402-mcp
```

## Tools

| Tool                          | What it does                                                                        | Price       |
| ----------------------------- | ----------------------------------------------------------------------------------- | ----------- |
| `ibm_granite_getting_started` | Overview, prices, and the x402 payment flow. No payment or IBM account required.    | Free        |
| `ibm_granite_chat`            | Conversational AI via IBM Granite (default `ibm/granite-3-8b-instruct`).            | $0.02 USDC  |
| `ibm_granite_code`            | Code generate, review, refactor, explain, test, document.                           | $0.025 USDC |
| `ibm_granite_embed`           | Batch text embeddings for RAG, search, and clustering (1–64 texts).                 | $0.005 USDC |
| `ibm_granite_analyze`         | Structured document analysis: entities, sentiment, risk flags, summary, next steps. | $0.04 USDC  |
| `ibm_granite_forecast`        | Zero-shot time-series forecasting via IBM Granite TTM (Tiny Time Mixer).            | $0.05 USDC  |

Every tool is a read-only model-inference call — nothing on your machine or in any account is modified — and declares MCP tool annotations (`readOnlyHint`, `openWorldHint`, `idempotentHint`) so clients can reason about side effects before paying.

### Input parameters

**`ibm_granite_getting_started`** — `section` (optional: `overview` (default, everything) / `pricing` / `payment` / `tools` / `setup`).

**`ibm_granite_chat`** — `messages` (required: 1–50 `{ role, content }` pairs; roles `system`/`user`/`assistant`, content ≤ 32,000 chars), `model` (default `ibm/granite-3-8b-instruct`), `max_new_tokens` (1–4096, default 1024), `temperature` (0–2, default 0.7).

**`ibm_granite_code`** — `task` (required: `generate`/`review`/`refactor`/`explain`/`test`/`document`), `prompt` (required, ≤ 16,000 chars: the description for `generate`, the code for everything else), `language`, `context` (≤ 4,000 chars).

**`ibm_granite_embed`** — `inputs` (required: 1–64 texts, ≤8000 chars each), `model`.

**`ibm_granite_analyze`** — `document` (required), `analysis_type` (`general`/`contract`/`financial`/`technical`/`medical`/`sentiment`, default `general`), `language`.

**`ibm_granite_forecast`** — `timestamps` (required: 64–1024 ISO-8601, uniform cadence, oldest first), `values` (required: 64–1024 numbers, same length), `freq` (required: pandas cadence, e.g. `1h`, `1D`), `prediction_length` (1–96), `label`.

### Example calls

```jsonc
// ibm_granite_chat
{
  "messages": [
    { "role": "system", "content": "You are an expert data engineer." },
    { "role": "user", "content": "Design a lakehouse schema for IoT sensor telemetry." }
  ],
  "max_new_tokens": 1024,
  "temperature": 0.7
}

// ibm_granite_code
{ "task": "review", "prompt": "def calculate_roi(revenue, cost): return revenue / cost", "language": "Python" }

// ibm_granite_embed
{ "inputs": ["enterprise data governance", "cloud-native AI pipeline", "real-time analytics"] }

// ibm_granite_analyze
{ "document": "This Software License Agreement is entered into between...", "analysis_type": "contract" }

// ibm_granite_forecast  (timestamps/values must be 64–1024 points; abbreviated here)
{ "timestamps": ["2025-01-01T00:00:00Z", "...", "2025-03-05T00:00:00Z"], "values": [12500, "...", 13200], "freq": "1D", "prediction_length": 14, "label": "daily_revenue_usd" }
```

## Payment flow

This server uses the [x402 protocol](https://x402.org) for micropayments:

1. Client calls a tool without payment → `402 PaymentRequired` with the USDC amount and Solana address.
2. Client builds and signs a Solana USDC transfer transaction.
3. Client retries with the signed tx in `_meta["x402/payment"]`.
4. Server verifies and settles via the configured facilitator (default PayAI).
5. Server calls IBM watsonx.ai and returns the result with `_meta["x402/payment-response"]` (settlement receipt).

```
MCP Client (Claude Desktop / Cursor / agent)
       │  tools/call (with x402 payment in _meta)
       ▼
ibm-x402-mcp (stdio MCP server)
       │  verify + settle USDC on Solana
       ├──► x402 facilitator (default https://facilitator.payai.network)
       │
       │  inference call with IAM Bearer token
       └──► IBM watsonx.ai (us-south.ml.cloud.ibm.com)
                 └── IBM Granite 3 8B Instruct / Embedding / TTM
```

## Requirements

- **Node.js >= 20.**
- A Solana wallet address to receive USDC (`MCP_SVM_PAYMENT_ADDRESS`).
- IBM Cloud credentials: an API key ([create one](https://cloud.ibm.com/iam/apikeys)) and a watsonx.ai project id (Project → Manage → General → Project ID), or a deployment space id.

### Environment variables

| Variable                  | Required                            | Default                                   |
| ------------------------- | ----------------------------------- | ----------------------------------------- |
| `MCP_SVM_PAYMENT_ADDRESS` | yes                                 | — (aliases: `X402_PAY_TO_SOLANA`, `X402_PAY_TO`) |
| `WATSONX_API_KEY`         | yes                                 | —                                         |
| `WATSONX_PROJECT_ID`      | yes (or `WATSONX_SPACE_ID`)         | —                                         |
| `WATSONX_SPACE_ID`        | alternative to `WATSONX_PROJECT_ID` | —                                         |
| `WATSONX_URL`             | no                                  | `https://us-south.ml.cloud.ibm.com`       |
| `WATSONX_MODEL_ID`        | no                                  | `ibm/granite-3-8b-instruct`               |
| `WATSONX_CODE_MODEL_ID`   | no                                  | `ibm/granite-3-8b-instruct`               |
| `WATSONX_EMBED_MODEL_ID`  | no                                  | `ibm/granite-embedding-278m-multilingual` |
| `WATSONX_FORECAST_MODEL`  | no                                  | `ibm/granite-ttm-512-96-r2`               |
| `WATSONX_TIMEOUT_MS`      | no                                  | `90000`                                   |
| `X402_FEE_PAYER_SOLANA`   | no                                  | three.ws fee payer                        |
| `X402_FACILITATOR_URL`    | no                                  | `https://facilitator.payai.network`       |
| `X402_FACILITATOR_TOKEN`  | no                                  | — (Bearer token for a private facilitator) |
| `X402_ASSET_MINT_SOLANA`  | no                                  | canonical Solana USDC mint                |

Regional hosts: `us-south`, `eu-de`, `eu-gb`, `jp-tok`, `au-syd`, `ca-tor` — e.g. `https://eu-de.ml.cloud.ibm.com`.

## Errors

Every failure state is explicit — there is no silent fallback:

| State | What you see | Recovery |
| ----- | ------------ | -------- |
| Missing env at startup | The process exits with a one-line `configuration error: …` naming the missing variable (`MCP_SVM_PAYMENT_ADDRESS`, `WATSONX_API_KEY`, or `WATSONX_PROJECT_ID`/`WATSONX_SPACE_ID`). | Set the variable and restart. |
| Unpaid call to a paid tool | An x402 `PaymentRequired` envelope quoting the USDC price and pay-to address — not an error; it is step 1 of the payment loop. | Pay and retry (x402-capable clients do this automatically). |
| Invalid/underpaid payment | The facilitator rejects verification and a fresh `PaymentRequired` envelope is returned; no inference runs and no funds settle. | Re-sign against the quoted accepts. |
| IBM-side failure | Tool result `{ "ok": false, "error": "watsonx_error", "message": "…", "status": … }` — IAM auth failure (bad `WATSONX_API_KEY`), model error, or a watsonx.ai timeout (`WATSONX_TIMEOUT_MS`, default 90 s). | The message carries IBM's reason; check credentials, project id, and region. |
| Unexpected server fault | Tool result `{ "ok": false, "error": "internal_error", "message": "…" }`. | Retry; file an issue if it persists. |
| Facilitator unreachable at boot | A `facilitator init warning: …` line on stderr; the server still starts and retries lazily on the first paid call. | Check `X402_FACILITATOR_URL` connectivity. |

`ibm_granite_getting_started` is always free and never touches IBM or the facilitator — use it to sanity-check the server before paying.

## Related

- [`@three-ws/ibm-watsonx-mcp`](https://www.npmjs.com/package/@three-ws/ibm-watsonx-mcp) — the same IBM Granite tools driven by your own IBM Cloud credentials (no x402, no per-call payment).

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
