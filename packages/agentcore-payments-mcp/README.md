# @three-ws/agentcore-payments-mcp

MCP server for three.ws Agent Payment Sessions — govern agent x402 spending without exposing private keys.

## Concept

> The agent does not hold a wallet. It proposes spend. Governance enforces policy.

A **Payment Session** is a budget envelope you fund once from your three.ws credits. You hand an agent the session bearer token; the agent calls paid x402 endpoints through this server. The platform's wallet signs every transaction. The session's allowlist, per-transaction ceiling, and total budget are enforced atomically on the server — the agent can never overspend.

## Quick start

```bash
# Configure
export THREE_WS_SESSION="<the value of your __Host-sid cookie>"
export PAYMENT_SESSION_TOKEN="pss_<session-id>_<random>"

# Run
npx @three-ws/agentcore-payments-mcp
```

MCP client config (`~/.cursor/mcp.json`, Claude Desktop, etc.):

```json
{
  "mcpServers": {
    "three-ws-payments": {
      "command": "npx",
      "args": ["-y", "@three-ws/agentcore-payments-mcp"],
      "env": {
        "THREE_WS_SESSION": "<the value of your __Host-sid cookie>",
        "PAYMENT_SESSION_TOKEN": "pss_..."
      }
    }
  }
}
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `THREE_WS_SESSION` | For session management tools | The **value** of your `__Host-sid` browser cookie (no `__Host-sid=` prefix; the server sends the cookie for you) for creating/listing/cancelling sessions |
| `PAYMENT_SESSION_TOKEN` | For `pay_with_session` default | Bearer token returned when you created a session; passed as the default when no inline token is provided |
| `THREE_WS_BASE` | No | Base URL (default: `https://three.ws`) |
| `THREE_WS_TIMEOUT_MS` | No | Request timeout in ms (default: 30000) |

## Tools

### `create_payment_session`
Create a new session funded from your credits.

```json
{
  "budget_usd": 10.00,
  "label": "Research agent — June sprint",
  "expiry_seconds": 86400,
  "max_per_tx_usd": 0.50,
  "allowed_hosts": ["api.example.com", "data.provider.io"],
  "network": "solana"
}
```

Returns `{ session, token }`. **The token is shown once — store it immediately.**

### `pay_with_session`
Pay an x402 endpoint using a session token. The platform wallet signs; your session's policy is enforced.

```json
{
  "url": "https://api.example.com/data",
  "method": "GET",
  "session_token": "pss_...",
  "idempotency_key": "run-42-fetch-data"
}
```

Returns `{ ok, paid, result, payment, session }` with the tx hash, explorer link, and updated budget.

If `session_token` is omitted, the `PAYMENT_SESSION_TOKEN` env var is used.

### `check_payment_session`
Inspect a session's budget, status, and recent payments.

```json
{ "session_id": "...", "include_executions": true }
```

### `list_payment_sessions`
List all sessions for the authenticated user, with aggregate stats.

```json
{ "status": "active", "limit": 20 }
```

### `cancel_payment_session`
Cancel a session and refund the un-spent budget to your credits.

```json
{ "session_id": "..." }
```

## Network support

| Session `network` | Platform payer | USDC contract |
|---|---|---|
| `solana` (default) | `X402_AGENT_SOLANA_SECRET_BASE58` | Solana mainnet USDC |
| `base` | `X402_EVM_AGENT_PRIVATE_KEY` | Base mainnet USDC (0x8335…) |

## Integrating with `@three-ws/x402-mcp`

The existing `pay_and_call` tool in `@three-ws/x402-mcp` now accepts `session_token` directly:

```json
{
  "url": "https://api.example.com/endpoint",
  "session_token": "pss_...",
  "confirm": true
}
```

This routes the payment through `/api/pay/execute` instead of signing locally — the session's governance policy applies.

## Examples

Runnable, no-payment examples live in [`examples/`](./examples):

```bash
node examples/list-tools.mjs       # every tool with its schema and safety annotations
node examples/plan-a-session.mjs   # read live x402 prices, print the policy to authorize
```

Neither one holds a wallet, reads a credential, or calls `pay_with_session`, so
nothing is signed and nothing is spent. `plan-a-session.mjs` is the habit worth
copying: read what an endpoint actually charges before you decide what budget to
authorize. See [`examples/README.md`](./examples/README.md).

## Session lifecycle

```
create (budget debited from credits)
  └─ active → pay_with_session calls spend against budget
       ├─ exhausted (budget fully consumed)
       ├─ expired (TTL elapsed — cron refunds remaining budget)
       └─ cancelled (manual — remaining budget refunded immediately)
```

## Programmatic use

The package entry point exports **`TOOLS`** (every tool definition: `name`, `title`,
`description`, `inputSchema`, `annotations`, `handler`) and **`buildServer()`**, which returns a
fully-registered `McpServer` with no transport attached. Importing is side-effect free and needs
no credential, so you can mount these tools inside a host of your own or inspect the surface
offline; a credential is only required when a handler actually runs.

```js
// run with: THREE_WS_SESSION=<your __Host-sid value> node this-file.mjs
import { TOOLS, buildServer } from '@three-ws/agentcore-payments-mcp';

for (const tool of TOOLS) {
	const kind = tool.annotations.readOnlyHint ? 'read ' : 'write';
	console.log(`${kind} ${tool.name}`);
}

// A tool handler is a plain async function against the live API.
const list = TOOLS.find((t) => t.name === 'list_payment_sessions');
console.log(await list.handler({ limit: 3 }));

// Or hand the whole registered server to your own MCP transport.
buildServer();
```

## Security properties

- **No key exposure**: the session token is a time-bounded, HMAC-signed grant. Compromising it lets an attacker spend up to the remaining budget at allowed hosts — nothing more.
- **Atomic budget enforcement**: concurrent payments use a SQL `UPDATE … WHERE remaining >= amount RETURNING` — two simultaneous requests can never collectively overspend.
- **Allowlist**: if `allowed_hosts` is set, the governor rejects any request to a host not on the list before signing.
- **Per-transaction cap**: `max_per_tx_usd` prevents a single large payment draining the entire budget.
- **SSRF protection**: all x402 target URLs are validated against a public-IP allowlist and DNS-resolved server-side before any payment is signed.
