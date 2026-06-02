# three.ws Agent — MCP server ("add a wallet to Claude")

The first MCP server where the assistant can **transact real value**: discover,
pay for, and call paid x402 services in USDC — settled on-chain from the
signed-in user's own three.ws agent wallet, bounded by spending caps.

Registered with the MCP Registry as **`io.github.nirholas/threews-agent`**.

- **Endpoint:** `https://three.ws/api/mcp-agent`
- **Transport:** Streamable HTTP (MCP `2025-06-18`)
- **Auth:** OAuth 2.1 (same three.ws authorization server as `/api/mcp`)
- **Money rail:** Solana USDC via the x402 `exact` scheme (`@x402/svm`)

## Tools

| Tool | What it does |
|------|--------------|
| `wallet_status` | Read-only: the user's agent wallet address, SOL + USDC balance, spending caps, and whether spend is enabled. Never moves funds. |
| `find_services(query, …)` | Search the live x402 facilitator network for paid services to call. |
| `pay_and_call(resource_url, method?, body?, max_usd?)` | Call a paid x402 endpoint and auto-settle the USDC payment from the user's wallet, within caps. Returns the service response. |

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
npx @modelcontextprotocol/inspector http://localhost:5173/api/mcp-agent
```
