# x402 Wallet MCP — a wallet that pays for anything

Hand any AI assistant a **self-custodial Solana wallet** and four tools: find a paid service in the live x402 bazaar, inspect exactly what an endpoint costs before paying, check your balance, and **pay-and-call** — settle the USDC and return the result, all in one step. This is the buyer side of the agent economy: your agent can use the open web's paid APIs without you wiring a single integration.

Registered in the [official MCP registry](https://registry.modelcontextprotocol.io/?q=io.github.nirholas) as **`io.github.nirholas/x402-mcp`**.

- **Install:** `npx -y @three-ws/x402-mcp`
- **npm:** [`@three-ws/x402-mcp`](https://www.npmjs.com/package/@three-ws/x402-mcp) (the package page carries the current version; `npx -y` always fetches it)
- **Transport:** stdio
- **Money rail:** Solana USDC via the x402 `exact` scheme (real `@x402/*` settlement), or $THREE when the endpoint advertises it

> **This server moves real money.** Read [Safety](#safety) before enabling spend. The read tools (`x402_wallet`, `find_services`, `inspect_endpoint`) never touch funds and need no signer.

## Add it

```bash
claude mcp add x402-wallet \
  -e SOLANA_SECRET_KEY=<base58-secret> \
  -e MAX_PAY_USD=1 \
  -- npx -y @three-ws/x402-mcp
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "x402-wallet": {
      "command": "npx",
      "args": ["-y", "@three-ws/x402-mcp"],
      "env": { "SOLANA_SECRET_KEY": "<base58-secret>", "MAX_PAY_USD": "1" }
    }
  }
}
```

Leave `SOLANA_SECRET_KEY` unset to run read-only (discovery + inspection only), or unset it and pay through a three.ws Payment Session instead, which never needs a local key (see [How payment works](#how-payment-works)).

## Tools

| Tool | Arguments | What it does | Moves money? |
|------|-----------|--------------|:---:|
| `x402_wallet` | `address` *(string, optional)* | Show a Solana wallet's address and live SOL + USDC balance. With no `address`, derives the wallet from `SOLANA_SECRET_KEY`. Call it before paying to confirm there's USDC. | No |
| `find_services` | `query` *(string, required)*, `type` *(`http`\|`mcp`, default `http`)*, `network` *(CAIP-2, optional)*, `max_price_usdc` *(number, optional)*, `limit` *(1–100, default 25)* | Search the live x402 facilitator network (PayAI + Coinbase CDP bazaar) for paid services. Returns each match with its price, networks, and resource URL. | No |
| `inspect_endpoint` | `url` *(URL, required)*, `method` *(`GET`\|`POST`, default `GET`)*, `body` *(object, optional)* | Fetch an x402 endpoint and return its **402 payment requirements** — every accepted scheme, network, asset, price, and pay-to address — **without paying**. If the endpoint is free, returns its result instead. | No |
| `pay_and_call` | `url` *(URL, required)*, `method` *(`GET`\|`POST`, default `GET`)*, `body` *(object)*, `session_token` *(string)*, `token` *(`usdc`\|`three`, default `usdc`)*, `max_usd` *(number)*, `secret` *(string)*, `confirm` *(boolean)*, `idempotency_key` *(string)* | Call a paid x402 endpoint and settle the payment automatically, then return the result. Bounded by `max_usd` and the `MAX_PAY_USD` cap; refuses before any money moves if the price is over the cap. | **Yes** |

## How payment works

`pay_and_call` has two modes, and the arguments you pass decide which one runs.

**Self-custodial (the default).** It probes the endpoint, reads its 402
requirements, picks the Solana (`solana:*`) `exact`-scheme requirement, and
settles from your own signer (`SOLANA_SECRET_KEY`, or a per-call `secret`), then
retries the request with the payment header and returns the response. Settlement
is USDC (6 decimals) unless you set `token: "three"`, which pays in $THREE on
endpoints that advertise it.

**Session-governed.** Pass a three.ws Payment Session token as `session_token`
(or set `PAYMENT_SESSION_TOKEN`) and the whole flow delegates to
`/api/pay/execute`: the platform wallet probes, signs, and settles, and the
session's own budget, allowlist, and per-transaction cap are enforced
server-side. No private key is involved, so `secret` and `token` are ignored in
this mode. Pass an `idempotency_key` so a retried call cannot double-charge the
session. Solana USDC sessions are the primary rail; Base USDC sessions work too.

The spend ceiling for a call is `min(max_usd, MAX_PAY_USD)` in both modes. The
`max_usd` argument can only **lower** the env cap, never raise it. If the quoted
price exceeds the ceiling, the call returns `{ ok: false, error: "over_cap" }`
and **no money moves**.

## Safety

- `pay_and_call` is annotated `destructiveHint: true` — it spends real USDC.
- **Per-call cap:** `MAX_PAY_USD` (default **$1**). A runaway or prompt-injected payment can't exceed it.
- **Confirmation gate:** with `REQUIRE_CONFIRM` on (default), `pay_and_call` refuses until re-issued with `confirm: true`, returning `{ ok: false, error: "confirm_required", price_usd, url }` first so a human or policy layer can approve.
- **Self-custodial:** the key in `SOLANA_SECRET_KEY` never leaves your machine. Treat it like cash; fund it with only what your agent should be able to spend.
- **Or no key at all:** a Payment Session (`session_token`) keeps the signer on the platform side and adds a second, server-enforced layer of governance (budget, allowlist, per-transaction cap) that the agent cannot talk its way past. Pair it with `idempotency_key` so a retry cannot pay twice.

## Examples

Check the spending wallet:

```json
{}
```

Find a service under 50¢:

```json
{ "query": "token intel", "type": "http", "max_price_usdc": 0.5, "limit": 10 }
```

Inspect a price without paying:

```json
{ "url": "https://api.example.com/intel?mint=…", "method": "GET" }
```

Pay and call (with confirmation):

```json
{ "url": "https://api.example.com/intel?mint=…", "max_usd": 0.10, "confirm": true }
```

Pay through a Payment Session instead of a local key, safe to retry:

```json
{ "url": "https://api.example.com/intel?mint=…", "session_token": "pss_…", "idempotency_key": "intel-2026-08-13-a", "confirm": true }
```

## Configuration

| Env | Purpose | Default |
|-----|---------|---------|
| `SOLANA_SECRET_KEY` | Base58 (or JSON byte-array) Solana secret that signs payments and holds the USDC. Not needed for read tools, and not needed at all in session-governed mode. `FUNDER_SECRET` is read as a fallback. **Secret, treat like cash.** | *(none)* |
| `PAYMENT_SESSION_TOKEN` | A three.ws Payment Session token used when a call omits `session_token`. Setting it makes session-governed mode the default for every `pay_and_call`. | *(none)* |
| `SOLANA_RPC_URL` | Solana mainnet RPC. Must be https (except localhost). Bring your own for production. | `https://api.mainnet-beta.solana.com` |
| `MAX_PAY_USD` | Hard ceiling for a single `pay_and_call`. | `1` |
| `REQUIRE_CONFIRM` | When on, `pay_and_call` refuses until re-issued with `confirm:true`. Set `0`/`false` to disable. | `true` |
| `THREE_WS_BASE` | three.ws API base serving `/api/bazaar/search` for `find_services`. | `https://three.ws` |

Errors are normalized with codes such as `no_signer`, `bad_secret`, `bad_rpc_url`, `insecure_rpc_url`, `bad_policy_config`, `over_cap`, `no_solana_requirement`, `three_not_offered`, `session_execute_failed`, `confirm_required`, `timeout`, and `call_failed`.

## Source & publishing

Manifest: [`packages/x402-mcp/server.json`](https://github.com/nirholas/three.ws/blob/main/packages/x402-mcp/server.json). Published with `npm run publish:mcp`.

For the **selling** side (put a price on an API you serve), see the hosted [Agent wallet server](/docs/mcp) (`/api/mcp-agent`). Full catalog: [MCP overview](/docs/mcp).
