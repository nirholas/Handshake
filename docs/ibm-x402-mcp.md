# IBM Granite x402 MCP — pay-per-call AI for agents

> The world's first **x402-enabled MCP server on IBM Cloud**. Any AI agent or MCP
> client can call IBM Granite foundation models and pay **per call in USDC** — no
> IBM Cloud account, no subscription, no API-key signup.

In plain terms: this is a menu of IBM AI capabilities (chat, code, embeddings,
document analysis, forecasting) that any agent or MCP client can use by paying a
few cents per call from a crypto wallet it already controls.

Every AI agent needs three things: a **body** (its 3D avatar), a **brain**
(an LLM with memory), and a **wallet** (to pay for the jobs it runs). This is the
wallet half of the brain — three.ws is an **IBM Business Partner**, and this suite
is how an agent reaches enterprise-grade **IBM Granite** inference and settles the
bill itself, in USDC, over [x402](https://x402.org).

This is the developer guide for the `@three-ws/ibm-x402-mcp` tool suite. For the
broader IBM integration (the platform showcase, Guardian Trust Layer, the
credentials-based `@three-ws/ibm-watsonx-mcp` connector) see **[docs/ibm.md](./ibm.md)**.
For the x402 protocol primitives used elsewhere on the platform see
**[docs/x402.md](./x402.md)**.

---

## Why this exists

A normal MCP server that wraps a hosted model forces every caller to bring their
own provider account, API key, and billing relationship. That kills the agent
use case: an autonomous agent can't sign up for IBM Cloud, accept terms, and
provision a watsonx.ai project mid-task.

The x402 MCP suite flips the model. **The operator** holds the IBM credentials
and funds inference; **the caller** pays a few cents of USDC per call and gets the
result. Settlement is on-chain, instant, and requires nothing but a wallet the
agent already controls. That's the unlock — Granite becomes a metered utility any
agent can consume the moment it has USDC.

| | Credentials connector ([`ibm-watsonx-mcp`](../packages/ibm-watsonx-mcp/)) | **x402 suite ([`ibm-x402-mcp`](../packages/ibm-x402-mcp/))** |
|---|---|---|
| Who pays IBM | The **caller** (their `WATSONX_*` key) | The **operator** (one shared key) |
| Caller needs IBM Cloud account | Yes | **No** |
| Caller pays per call | No (flat IBM billing) | **Yes — USDC on Solana/Base** |
| Best for | A developer wiring their own watsonx.ai key into their own client | An **agent** that wants Granite on demand and will pay for it |

---

## The five paid tools (plus one free)

Each tool is independently priced. Prices are the source of truth in
[`packages/ibm-x402-mcp/src/tools/`](../packages/ibm-x402-mcp/src/tools/) and
mirrored here. A sixth tool, `ibm_granite_getting_started`, is **free** (no
payment, no wallet): it returns an overview of the suite, per-tool prices, and
how the x402 payment flow works. It is the right first call for a new client.

| Tool | What it does | Model | Price |
|---|---|---|---|
| `ibm_granite_chat` | Conversational AI — Q&A, drafting, reasoning, instruction following | Granite 3 8B Instruct | **$0.02** |
| `ibm_granite_code` | Generate / review / refactor / explain / test / document code | Granite 3 8B Instruct | **$0.025** |
| `ibm_granite_embed` | Batch text embeddings (1–64 inputs) for RAG, search, clustering | Granite Embedding 278M Multilingual | **$0.005** |
| `ibm_granite_analyze` | Structured document analysis — entities, sentiment, risk flags, summary, next steps | Granite 3 8B Instruct | **$0.04** |
| `ibm_granite_forecast` | Zero-shot time-series forecasting, no training | Granite TTM (Tiny Time Mixer) | **$0.05** |

All Granite 3 tools also process German, Spanish, French, Portuguese, Japanese,
Korean, Italian, Dutch, Chinese, Arabic, and Czech.

---

## Two transports, one tool suite

The exact same tools (the free getting-started tool plus the five paid tools,
identical schemas, prices, and output shapes) ship over two transports:

| Transport | Endpoint | For | Payment |
|---|---|---|---|
| **stdio** (npm) | `npx @three-ws/ibm-x402-mcp` | Local MCP hosts: Claude Desktop, Claude Code, Cursor | Per-call USDC on **Solana** |
| **Streamable HTTP** (remote) | `https://three.ws/api/ibm-mcp` | Hosted clients, watsonx Orchestrate, custom agents | Per-call USDC on **Base or Solana** |

The stdio package is [`packages/ibm-x402-mcp`](../packages/ibm-x402-mcp/). The
remote endpoint is [`api/ibm-mcp.js`](../api/ibm-mcp.js) backed by
[`api/_mcpibm/`](../api/_mcpibm/), reusing the platform's server-side watsonx
client and x402 settlement infra. Both are registered with the MCP Registry:
`io.github.nirholas/ibm-x402-mcp` (stdio) and
`io.github.nirholas/ibm-x402-mcp-remote` (HTTP, see [`server-ibm.json`](../server-ibm.json)).

### Dual-mode access on the remote endpoint

watsonx Orchestrate is not x402-capable, so the hosted endpoint supports two
paths:

- **Anonymous callers pay per call.** An unpaid `tools/call` returns a `402`
  quoting the exact per-tool price, advertised on Base and Solana mainnet.
  x402-capable clients pay and retry automatically; settlement runs *after* the
  tool succeeds.
- **Authenticated three.ws principals (Bearer / OAuth) call without per-call
  payment** — the operator-funded path. A watsonx Orchestrate connection supplies
  a Bearer credential, making the tools included-in-connection rather than billed
  per USDC call.

---

## How a paid call works

```
MCP Client (Claude Desktop / Cursor / agent)
       │  tools/call  (no payment yet)
       ▼
ibm-x402-mcp  ──►  402 PaymentRequired   {price: $0.02 USDC, payTo: <wallet>, network: solana}
       ▲
       │  tools/call  (signed USDC transfer in _meta["x402/payment"])
       ▼
ibm-x402-mcp
       ├──► PayAI Facilitator   verify + settle USDC on-chain
       ├──► IBM watsonx.ai      inference with operator Bearer token
       └──► result + _meta["x402/payment-response"]  (settlement receipt)
```

1. Client calls a tool without payment → server returns a `402 PaymentRequired`
   envelope quoting the USDC price and the receiving Solana address.
2. Client builds and signs a Solana USDC transfer.
3. Client retries with the signed tx in `_meta["x402/payment"]`.
4. Server verifies via the [PayAI facilitator](https://facilitator.payai.network),
   calls watsonx.ai, then settles the payment.
5. Response carries the result plus a settlement receipt in
   `_meta["x402/payment-response"]`.

x402-capable MCP clients run this whole loop automatically — to the agent it
looks like one tool call that happens to cost a few cents.

---

## Quickstart — call it (end user)

You only need a wallet with USDC. Wire the server into your MCP client:

```json
{
  "mcpServers": {
    "ibm-x402": {
      "command": "npx",
      "args": ["-y", "@three-ws/ibm-x402-mcp"],
      "env": {
        "MCP_SVM_PAYMENT_ADDRESS": "operator-wallet-address"
      }
    }
  }
}
```

> The stdio package is one process: it both **serves** tools and, when *you* run
> it, the operator env (`WATSONX_*` + receiving wallet) belongs to whoever hosts
> it. To consume someone else's hosted suite without running watsonx yourself,
> point your client at the remote endpoint `https://three.ws/api/ibm-mcp`.

Inspect the tools interactively:

```bash
npx -y @modelcontextprotocol/inspector npx @three-ws/ibm-x402-mcp
```

---

## Quickstart — run it (server operator)

You supply IBM credentials and a wallet to receive payments; your callers supply
only USDC.

```bash
MCP_SVM_PAYMENT_ADDRESS=<your-solana-wallet> \
WATSONX_API_KEY=<ibm-api-key> \
WATSONX_PROJECT_ID=<watsonx-project-id> \
npx @three-ws/ibm-x402-mcp
```

### Configuration

**Required**

| Env var | Description |
|---|---|
| `MCP_SVM_PAYMENT_ADDRESS` | Solana wallet that receives USDC payments from callers |
| `WATSONX_API_KEY` | IBM Cloud API key — [create one](https://cloud.ibm.com/iam/apikeys) |
| `WATSONX_PROJECT_ID` | watsonx.ai project id (Project → Manage → General → Project ID) |

**Optional**

| Env var | Default | Description |
|---|---|---|
| `WATSONX_SPACE_ID` | — | Deployment space id (alternative to `WATSONX_PROJECT_ID`) |
| `WATSONX_URL` | `https://us-south.ml.cloud.ibm.com` | Regional inference host |
| `WATSONX_MODEL_ID` | `ibm/granite-3-8b-instruct` | Default chat/generation model |
| `WATSONX_EMBED_MODEL_ID` | `ibm/granite-embedding-278m-multilingual` | Default embedding model |
| `X402_FEE_PAYER_SOLANA` | three.ws fee payer | Solana account sponsoring tx fees |
| `X402_FACILITATOR_URL` | `https://facilitator.payai.network` | x402 payment facilitator |
| `X402_FACILITATOR_TOKEN` | — | Bearer token for the facilitator (optional) |
| `X402_ASSET_MINT_SOLANA` | USDC mainnet mint | USDC mint override |

Regional hosts: `us-south`, `eu-de`, `eu-gb`, `jp-tok`, `au-syd`, `ca-tor` →
e.g. `https://eu-de.ml.cloud.ibm.com`.

The server **fails fast**: a missing payment address or missing IBM credentials
exits at startup with an actionable message — a running server that can't receive
USDC or reach watsonx is useless, so it never silently degrades.

---

## Tool reference

### `ibm_granite_getting_started` (free)

No payment required. Returns the suite overview, per-tool pricing, setup
requirements, and a walkthrough of the x402 payment flow. Optional `section`
narrows the answer (for example `pricing`).

### `ibm_granite_chat` — $0.02

Conversational completion. Send an ordered array of role/content messages; get
the assistant reply plus token usage.

```jsonc
{
  "messages": [
    { "role": "system", "content": "You are an expert data engineer." },
    { "role": "user", "content": "Design a lakehouse schema for IoT sensor telemetry." }
  ],
  "max_new_tokens": 1024,   // 1–4096, default 1024
  "temperature": 0.7        // 0–2, default 0.7
}
```

`messages` accepts 1–50 entries. Optional `model` overrides the default chat
model.

### `ibm_granite_code` — $0.025

Six code tasks via Granite instruct models.

```jsonc
{
  "task": "review",   // generate | review | refactor | explain | test | document
  "prompt": "def calculate_roi(revenue, cost): return revenue / cost",
  "language": "Python"   // optional hint
}
```

- **generate** — new code from a description
- **review** — severity-ranked bugs / security / improvement findings
- **refactor** — clarity, performance, best practices
- **explain** — plain-language walkthrough
- **test** — unit tests
- **document** — inline docs / docstrings

Optional `context` supplies surrounding code or constraints.

### `ibm_granite_embed` — $0.005

Batch-embeds 1–64 texts (up to 8,000 chars each), one dense float vector per
input. Use for semantic search, RAG retrieval, clustering, dedup, and
cross-language similarity.

```jsonc
{
  "inputs": [
    "enterprise data governance",
    "cloud-native AI pipeline",
    "real-time analytics"
  ]
}
```

### `ibm_granite_analyze` — $0.04

Extracts a machine-readable JSON analysis from any text — entities, sentiment
(label + score), key findings, severity-tagged risk flags, a 3-sentence summary,
and 3 actionable next steps. Extraction is tailored per `analysis_type`.

```jsonc
{
  "document": "This Software License Agreement is entered into between...",
  "analysis_type": "contract"  // general | contract | financial | technical | medical | sentiment
}
```

`document` accepts up to 24,000 chars. Examples of type-specific extraction:
`contract` → parties, obligations, termination/penalty clauses; `financial` →
metrics, red flags, forward-looking statements.

### `ibm_granite_forecast` — $0.05

Zero-shot numeric forecasting via IBM Granite TTM — no training. Provide 64–1024
ISO-8601 timestamps and aligned numeric values at a uniform cadence; receive a
forecast horizon as timestamped points.

```jsonc
{
  "timestamps": ["2025-01-01T00:00:00Z", "2025-01-02T00:00:00Z", "..."],
  "values": [12500, 13200, 0],
  "freq": "1D",               // pandas-style: 1min, 5min, 1h, 1D, 1W, 1ME, ...
  "prediction_length": 14,    // optional, 1–96; defaults to model horizon
  "label": "daily_revenue_usd" // optional, echoed back for traceability
}
```

`timestamps` and `values` must be equal length. Example response:

```jsonc
{
  "ok": true,
  "label": "daily_revenue_usd",
  "model": "ibm/granite-ttm-512-96-r2",
  "inputWindow": 512,
  "forecastSteps": 14,
  "forecast": [
    { "timestamp": "2025-06-07T00:00:00Z", "value": 1420 },
    { "timestamp": "2025-06-08T00:00:00Z", "value": 1388 }
  ]
}
```

Use for revenue, traffic, demand, sensor, energy, and financial series.

### Error shape

Tools never throw to the client. On bad input or an upstream watsonx failure they
return a structured error:

```jsonc
{ "ok": false, "error": "watsonx_error", "message": "...", "status": 400 }
```

Codes: `invalid_input` (caller-side), `watsonx_error` (upstream, carries the
HTTP `status`), `internal_error` (unexpected).

---

## Discovery (x402 Bazaar)

Each tool declares an x402 discovery extension, so the suite is browsable in the
[x402 Bazaar](./mcp-x402-bazaar.md) alongside its schema, example input, and
example output. Agents can find Granite tools by capability and price without
knowing the server up front.

---

## Affiliation

three.ws is an **IBM Business Partner**. This npm package is an independent,
open-source project (Apache-2.0) built by three.ws that integrates IBM Granite via
watsonx.ai — IBM Cloud Partner Center requires third-party MCP listings to state
this, so to be precise: the package itself is **not an IBM product** and is not
operated by IBM. Granite, watsonx, and watsonx.ai are trademarks of IBM.
Catalog/listing copy is maintained in
[`CATALOG.md`](../packages/ibm-x402-mcp/CATALOG.md); support policy in
[`SUPPORT.md`](../packages/ibm-x402-mcp/SUPPORT.md).

---

## See also

- [docs/ibm.md](./ibm.md) — the full IBM Granite / watsonx integration and showcase
- [docs/x402.md](./x402.md) — the x402 payment protocol on three.ws
- [docs/mcp.md](./mcp.md) — wiring MCP servers into a client
- [docs/mcp-x402-bazaar.md](./mcp-x402-bazaar.md) — x402 service discovery
- [packages/ibm-x402-mcp](../packages/ibm-x402-mcp/) — the npm package source
- npm: [`@three-ws/ibm-x402-mcp`](https://www.npmjs.com/package/@three-ws/ibm-x402-mcp)
