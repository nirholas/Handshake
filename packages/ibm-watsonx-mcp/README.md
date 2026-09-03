<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/ibm-watsonx-mcp</h1>

<p align="center"><strong>MCP server for IBM watsonx.ai — chat, generation, embeddings, tokenization, forecasting, and model discovery, on your own IBM Cloud account.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/ibm-watsonx-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/ibm-watsonx-mcp?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/ibm-watsonx-mcp"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/ibm-watsonx-mcp?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/ibm-watsonx-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/ibm-watsonx-mcp?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas%2Fibm--watsonx-6e56cf"></a>
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#tools">Tools</a> ·
  <a href="#requirements">Requirements</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes IBM watsonx.ai — IBM Granite foundation models and anything else in your account — to MCP clients such as Claude Desktop, Claude Code, and Cursor. It talks **directly** to the watsonx.ai as-a-Service REST API with **your own IBM Cloud credentials**: it mints an IAM bearer token from your API key, caches it until just before expiry, and scopes every call to your project. No intermediary backend, no telemetry, no mock data.

> Community-built and not affiliated with IBM. Registry name: `io.github.nirholas/ibm-watsonx`.

## Install

```bash
npm install @three-ws/ibm-watsonx-mcp
```

Run it directly with `npx` (no install needed):

```bash
WATSONX_API_KEY=... WATSONX_PROJECT_ID=... npx @three-ws/ibm-watsonx-mcp
```

Or install globally to get the `ibm-watsonx-mcp` binary on your `PATH`:

```bash
npm install -g @three-ws/ibm-watsonx-mcp
```

## Quick start

With Claude Code, one command:

```bash
claude mcp add ibm-watsonx -e WATSONX_API_KEY=... -e WATSONX_PROJECT_ID=... -- npx -y @three-ws/ibm-watsonx-mcp
```

Or add the server to your MCP client config (`claude_desktop_config.json`, Cursor's `mcp.json`):

```json
{
	"mcpServers": {
		"ibm-watsonx": {
			"command": "npx",
			"args": ["-y", "@three-ws/ibm-watsonx-mcp"],
			"env": {
				"WATSONX_API_KEY": "your-ibm-cloud-api-key",
				"WATSONX_PROJECT_ID": "your-watsonx-project-id"
			}
		}
	}
}
```

Restart the client and the six tools below appear. Inspect the surface manually with the MCP Inspector:

```bash
npx -y @modelcontextprotocol/inspector npx @three-ws/ibm-watsonx-mcp
```

## Tools

| Tool                  | What it does                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `watsonx_chat`        | Chat completion from a list of role/content messages. Returns the reply plus token usage.       |
| `watsonx_generate`    | Raw prompt completion with decoding control (greedy/sample, stop sequences).                    |
| `watsonx_embed`       | Embedding vectors for one or more texts (up to 1000). One vector per input plus dimensionality. |
| `watsonx_tokenize`    | Token count (and optionally the tokens) for a text against a model tokenizer.                   |
| `watsonx_forecast`    | Zero-shot time-series forecasting with an IBM Granite TimeSeries (TinyTimeMixer) model.         |
| `watsonx_list_models` | List the foundation models available to your account and region, optionally filtered.           |

Every tool is a read-only model-inference call — nothing in your environment or IBM account is modified — and declares MCP tool annotations (`readOnlyHint`, `openWorldHint`, `idempotentHint`) so clients can reason about side effects.

### Input parameters

**`watsonx_chat`** — `messages` (required: array of `{ role, content }`, roles `system`/`user`/`assistant`), `model`, `max_tokens` (1–4096), `temperature` (0–2), `top_p` (0–1).

**`watsonx_generate`** — `input` (required), `model`, `max_new_tokens` (1–4096), `temperature` (0–2), `decoding_method` (`greedy`/`sample`), `stop_sequences`.

**`watsonx_embed`** — `inputs` (required: 1–1000 texts), `model`.

**`watsonx_tokenize`** — `input` (required), `model`, `return_tokens` (boolean).

**`watsonx_forecast`** — `timestamps` (required: ISO-8601, uniform cadence, oldest first), `values` (required: numeric, same length), `freq` (required: pandas cadence, e.g. `1h`, `15min`, `1D`), `model`, `target_column`, `prediction_length` (1–96).

**`watsonx_list_models`** — `filter` (e.g. `function_text_generation`, `function_embedding`), `limit` (1–200, default 100).

### Example calls

```jsonc
// watsonx_chat
{ "messages": [{ "role": "user", "content": "Explain MCP in one sentence." }] }

// watsonx_generate
{ "input": "Write a haiku about Kubernetes.", "decoding_method": "sample", "temperature": 0.7, "max_new_tokens": 60 }

// watsonx_embed
{ "inputs": ["lakehouse", "data warehouse"] }

// watsonx_forecast
{ "timestamps": ["2025-01-01T00:00:00Z", "2025-01-01T01:00:00Z"], "values": [1200, 1180], "freq": "1h", "prediction_length": 24 }

// watsonx_list_models
{ "filter": "function_embedding" }
```

## How auth works

`WATSONX_API_KEY` is exchanged for a short-lived IAM bearer token at `https://iam.cloud.ibm.com/identity/token` (`grant_type=urn:ibm:params:oauth:grant-type:apikey`). The token is cached in-process and refreshed about five minutes before it expires. Your API key never leaves your machine except in that single IAM exchange.

## Requirements

- **Node.js >= 20.**
- An IBM Cloud account with watsonx.ai provisioned — [sign up](https://dataplatform.cloud.ibm.com/registration/stepone?context=wx) (free tier available).
- An **IBM Cloud API key** — create one at <https://cloud.ibm.com/iam/apikeys>.
- Your **watsonx.ai project id** — open the project → **Manage** → **General** → **Project ID** (or a deployment space id).

### Environment variables

| Variable                 | Required                            | Default                                   |
| ------------------------ | ----------------------------------- | ----------------------------------------- |
| `WATSONX_API_KEY`        | yes                                 | —                                         |
| `WATSONX_PROJECT_ID`     | yes (or `WATSONX_SPACE_ID`)         | —                                         |
| `WATSONX_SPACE_ID`       | alternative to `WATSONX_PROJECT_ID` | —                                         |
| `WATSONX_URL`            | no                                  | `https://us-south.ml.cloud.ibm.com`       |
| `WATSONX_MODEL_ID`       | no                                  | `ibm/granite-3-8b-instruct`               |
| `WATSONX_EMBED_MODEL_ID` | no                                  | `ibm/granite-embedding-278m-multilingual` |
| `WATSONX_FORECAST_MODEL` | no                                  | `ibm/granite-ttm-512-96-r2`               |
| `WATSONX_API_VERSION`    | no                                  | `2024-05-31`                              |
| `WATSONX_TS_API_VERSION` | no                                  | `2025-02-11` (time-series API date)       |
| `WATSONX_TIMEOUT_MS`     | no                                  | `60000`                                   |
| `WATSONX_IAM_URL`        | no                                  | `https://iam.cloud.ibm.com/identity/token` |

Regional hosts: `us-south`, `eu-de`, `eu-gb`, `jp-tok`, `au-syd`, `ca-tor` — e.g. `https://eu-de.ml.cloud.ibm.com`.

## Related

- [`@three-ws/ibm-x402-mcp`](https://www.npmjs.com/package/@three-ws/ibm-x402-mcp) — the same IBM Granite tools as pay-per-use x402 endpoints (USDC on Solana), so callers need no IBM account of their own.

## Links

- Homepage: https://three.ws
- Changelog: https://three.ws/changelog
- Issues: https://github.com/nirholas/three.ws/issues
- License: Apache-2.0, see [LICENSE](./LICENSE)

---

<p align="center">
  <sub>
    Part of the <a href="https://three.ws">three.ws</a> SDK suite — 3D AI agents, on-chain identity, and agent payments.<br/>
    <a href="https://three.ws">Website</a> · <a href="https://three.ws/changelog">Changelog</a> · <a href="https://github.com/nirholas/three.ws">GitHub</a>
  </sub>
</p>
