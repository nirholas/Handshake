# three.ws Agent — MCP server ("add a wallet to Claude")

The first MCP server where the assistant can **transact real value**: discover,
pay for, and call paid x402 services in USDC — settled on-chain from the
signed-in user's own three.ws agent wallet, bounded by spending caps.

Registered with the MCP Registry as **`io.github.nirholas/threews-agent`**.

- **Endpoint:** `https://three.ws/api/mcp-agent`
- **Transport:** Streamable HTTP (MCP `2025-06-18`)
- **Auth:** OAuth 2.1 (same three.ws authorization server as `/api/mcp`), plus the wallet scopes below
- **Money rail:** Solana USDC via the x402 `exact` scheme (`@x402/svm`)

## Tools

| Tool | Scope required | What it does |
|------|----------------|--------------|
| `getting_started` | none (free, no sign-in) | Overview of the server and its tools. The one tool an unauthenticated client can call. |
| `wallet_status` | `wallet:read` (or `wallet:write`) | Read-only: the user's agent wallet address, SOL + USDC balance, spending caps, and whether spend is enabled. Never moves funds. |
| `find_services(query, type?, network?, max_price_usdc?, limit?)` | none beyond sign-in | Search the live x402 facilitator network for paid services to call. `max_price_usdc` accepts 0 to 1,000,000. |
| `pay_and_call(resource_url, method?, body?, max_usd?)` | `wallet:write` | Call a paid x402 endpoint and auto-settle the USDC payment from the user's wallet, within caps. Returns the service response. |
| `provision_wallet(agent_id, cluster?, airdrop?)` | `wallet:write` | Create (or return) the custodial Solana wallet for one of your own agents. Idempotent. `airdrop` is devnet only and never fires on mainnet. |
| `monetize_endpoint(agent_id, name, description, price_usdc, target_url, method?, input_schema?, network?)` | `services:write` | Publish an upstream API you already serve as a priced x402 endpoint. Buyers' USDC settles to your agent's own wallet. |

## Scopes

Every tool above that reads or moves an agent wallet is gated on an OAuth scope,
so a token minted for something else (an avatar client, say) can never read a
balance or spend a cent. An under-scoped call returns a designed result naming
the scope it needs, not a bare JSON-RPC error:

```json
{ "ok": false, "reason": "insufficient_scope", "required": "wallet:write" }
```

The three scopes (`wallet:read`, `wallet:write`, `services:write`) are advertised
in [`/.well-known/oauth-authorization-server`](https://three.ws/.well-known/oauth-authorization-server),
may be requested by any client (including dynamically-registered ones), and are
approved by name on the consent screen. Ask for them in the `scope` parameter of
the authorization request; re-authorize an existing connection to add one.

## How payment works

`pay_and_call` reuses the audited SDK payment path — it does **not** hand-roll
transactions:

1. Resolve the signed-in user's primary agent wallet (`agent_identities`, Solana).
2. Recover the keypair (`recoverSolanaAgentKeypair`) and build an `x402Client`
   with `ExactSvmScheme`.
3. Install the platform spending cap (`enforceCap → commit / rollback`).
4. `wrapAxiosWithPayment` runs the 402 → sign → retry → settle dance.

Per-call/hour/day caps come from `X402_MAX_PER_CALL_ATOMIC`,
`X402_MAX_PER_HOUR_ATOMIC`, `X402_MAX_PER_DAY_ATOMIC` (atomic USDC, 6 decimals).
A `max_usd` argument can only **lower** the per-call cap, never raise it.

## Safety gate — this moves real money

Autonomous spending is **off** unless `THREEWS_AGENT_PAY_ENABLED=1`. While off,
`pay_and_call` returns the exact payment details and a `/pay` link instead of
moving funds. `wallet_status` and `find_services` work regardless.

**Before enabling spend in production:** run a funded-wallet integration test
against a live x402 endpoint (confirm a real USDC settlement + cap enforcement +
rollback on failure). Do not enable the flag for the public until that passes.

## Configuration

| Env | Purpose |
|-----|---------|
| `THREEWS_AGENT_PAY_ENABLED` | `1` to enable autonomous spend. Default off. |
| `X402_MAX_PER_CALL_ATOMIC` / `_HOUR_` / `_DAY_` | Spending caps (atomic USDC). |
| `SOLANA_RPC_URL` | RPC for balance reads + settlement. |

## Publishing to the MCP Registry

Manifest: [`server-agent.json`](../server-agent.json).

```bash
mcp-publisher login github
mcp-publisher publish --file server-agent.json
```

## Local development

```bash
npm run dev
npx @modelcontextprotocol/inspector http://localhost:3000/api/mcp-agent
```
