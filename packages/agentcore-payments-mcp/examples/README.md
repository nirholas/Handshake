# Examples: @three-ws/agentcore-payments-mcp

Two runnable examples. Neither one spends money, needs a wallet, or needs an
account, so you can run both before deciding whether to fund anything.

| File | What it does | Run |
|---|---|---|
| [`list-tools.mjs`](list-tools.mjs) | Spawns this package's MCP server over stdio and prints all 5 tools with their input schemas and safety annotations. | `node examples/list-tools.mjs` |
| [`plan-a-session.mjs`](plan-a-session.mjs) | Reads what live x402 endpoints actually charge (unpaid `402` probe), then prints the exact `create_payment_session` policy sized for your run. | `node examples/plan-a-session.mjs` |

Run them from the package directory:

```bash
cd packages/agentcore-payments-mcp
node examples/list-tools.mjs
node examples/plan-a-session.mjs
```

## list-tools.mjs

Runs the MCP `initialize` handshake against `node src/index.js`, calls
`tools/list`, and formats every tool. Registration is env-free, so all five
tools appear with no `THREE_WS_SESSION` or `PAYMENT_SESSION_TOKEN` set.

Abridged output:

```
server:       agentcore-payments-mcp v0.1.3 (stdio)
capabilities: tools
tools:        5

1. create_payment_session
   title: Create a funded agent payment session
   hints: write, non-destructive, non-idempotent, closed-world
   params:
     - budget_usd (required; number)
       Total budget in USD to allocate to this session (drawn from your credits). Min $0.001, max $1000.
     ...

2. pay_with_session
   title: Pay an x402 endpoint via a payment session
   hints: destructive, open-world
     ...

Tools that change state: create_payment_session, pay_with_session, cancel_payment_session
Only pay_with_session moves funds, and only up to the session budget you set.
```

The `hints` line is worth reading rather than skimming. It is the tool's MCP
[annotations](https://modelcontextprotocol.io/docs/concepts/tools), and it is
what an MCP client uses to decide whether to prompt you before a call. Note that
a tool whose four hints are all `false` (`create_payment_session`) is a
deliberate declaration of a non-destructive, closed-world write, which is not
the same thing as a tool that was never annotated. The example prints those two
cases differently on purpose.

## plan-a-session.mjs

The habit this example exists to build: **read the price before you authorize a
budget.** Sizing an envelope by guessing a round number gets it wrong in both
directions, and the expensive direction drains quietly.

It sends one unpaid request per endpoint, reads the price out of the `402`
challenge, and stops. It never presents a payment.

```bash
# Default: one live three.ws endpoint at $0.001/call
node examples/plan-a-session.mjs

# Your own endpoints
node examples/plan-a-session.mjs https://a.example/data https://b.example/feed

# Size the plan for a bigger run
CALLS_PER_ENDPOINT=500 node examples/plan-a-session.mjs
```

Output:

```
Reading prices for 1 endpoint(s). No payment is sent.

  $0.001 https://three.ws/api/x402/model-check?url=https://three.ws/models/demo.glb
      solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp, +2 other rail(s)

25 call(s) per endpoint costs $0.025.
With 25% headroom, the plan is:

{
  "budget_usd": 0.03125,
  "label": "Planned run, 1 endpoint(s) x 25 calls",
  "expiry_seconds": 3600,
  "max_per_tx_usd": 0.002,
  "allowed_hosts": ["three.ws"],
  "network": "solana"
}

What this policy refuses, before any money moves:
  a payment to any host outside three.ws                   allowlist_blocked
  a single call priced above $0.002                        per_tx_exceeded
  the call that would push total spend past $0.03125       insufficient_budget
  any call after the session expires or is cancelled       session_inactive
```

Three details in how it prices:

- **It quotes the Solana rail specifically.** Most endpoints advertise several
  networks in one `402`. Payment sessions settle on Solana, so pricing off the
  first `accepts[]` entry would quote a rail the session cannot pay on.
- **An endpoint that answers without a `402` is reported as free** and left out
  of the budget, because it consumes none.
- **The plan is clamped to the limits the API enforces** ($0.001 to $1000 per
  session, 50 allowlist entries) and tells you when clamping happened, so it
  never prints a policy the server would reject.

## The paid step

Neither example spends. To actually run a session:

1. Create it with the printed policy (`create_payment_session`, or
   `POST /api/pay/session` with an API key). The token is returned **once**.
2. Give the agent the token and nothing else.
3. The agent calls `pay_with_session`. Governance runs before any money moves.
4. Read the ledger with `check_payment_session` (`include_executions: true`).
5. `cancel_payment_session` refunds the unspent remainder immediately.

The full walkthrough with real request and response bodies is
[Give an agent a spending envelope](https://three.ws/docs/tutorials/agent-spending-envelope).

## Related

- [Package README](../README.md): tools, env vars, session lifecycle, security properties
- [Payment sessions](https://three.ws/docs/payment-sessions): the conceptual guide
- [API reference](https://three.ws/docs/api-reference): every endpoint, field, and error code
- [`@three-ws/x402-mcp`](../../x402-mcp): the other side, paying x402 endpoints with your own signer
