# @three-ws/knock-mcp

Let an agent reach a real person.

Knock is a priced door to a human. Every [three.ws](https://three.ws) account
can publish one at `three.ws/knock/<handle>`, and the owner sets what one
message from a stranger costs. Paying that price buys exactly one message
through: it lands in their inbox, and their 3D companion walks on screen
wherever they are on the site and delivers it out loud, naming the sender and
the amount. The USDC settles **directly to the recipient**.

This MCP server gives any agent client (Claude Code, Claude Desktop, Cursor,
Windsurf, or your own) the tools to find a reachable person, knock, and read
the answer.

## This server holds no wallet

On a **free** door, `knock_send` sends immediately, because nothing moves.

On a **priced** door, `knock_send` does not pay and cannot pay. It returns the
recipient, the amount, the token, the chain and the endpoint, and stops. The
human approves the spend and pays from the wallet they already control, with
[`@three-ws/knock`](https://www.npmjs.com/package/@three-ws/knock) or any other
x402 client.

That is deliberate. An MCP server with a key in an environment variable should
not be able to move a person's money on its own.

## Install

Claude Code:

```bash
claude mcp add knock -- npx -y @three-ws/knock-mcp
```

Any MCP client, by config:

```json
{
	"mcpServers": {
		"knock": {
			"command": "npx",
			"args": ["-y", "@three-ws/knock-mcp"]
		}
	}
}
```

Add `THREE_WS_API_KEY` only if you also want the two owner-side tools:

```json
{
	"mcpServers": {
		"knock": {
			"command": "npx",
			"args": ["-y", "@three-ws/knock-mcp"],
			"env": { "THREE_WS_API_KEY": "sk_live_…" }
		}
	}
}
```

Node 20+.

## Tools

| Tool | Credential | What it does |
| --- | --- | --- |
| `knock_quote` | none | What one person charges for a single message, which chains they take it on, the length limit, and the endpoint. |
| `knock_directory` | none | Everyone reachable right now, cheapest first. |
| `knock_send` | none | Get one message through. Free doors send; priced doors are quoted for a human to approve. |
| `knock_receipt` | none | What became of a knock you sent: pending, read, replied (with the reply), or dismissed. |
| `knock_inbox` | `THREE_WS_API_KEY` | The knocks **your** door has taken, each with what the sender paid, plus totals. |
| `knock_act` | `THREE_WS_API_KEY` | Reply to, mark read, dismiss, or block one of them. |

The owner tools are account-scoped server-side. They can never read or change
another account.

## What a session looks like

> **You:** Find someone on three.ws who takes questions about x402, and ask them
> how their Solana facilitator handles fee payers.

The agent calls `knock_directory`, picks a door, calls `knock_quote` to get the
live price, and comes back with:

```
nirholas (@nirholas) charges $0.05 USDC on solana.
Endpoint: https://three.ws/api/x402/knock?to=nirholas
The payment settles directly to the recipient.
Approve?
```

You approve and pay from your own wallet:

```bash
npx @three-ws/knock send nirholas \
  "How does your Solana facilitator handle the fee payer?" \
  --from "Ada (research agent)" --subject "x402 fee payer" --payer ./payer.mjs
```

Their companion walks on screen and says: *"Ada paid $0.05 to reach you: x402
fee payer."* When they answer, the agent reads it back with `knock_receipt` on
the receipt URL. No account on either side beyond the door owner's.

## Environment

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `THREE_WS_API_KEY` | for `knock_inbox` / `knock_act` only | none | API key or OAuth token for the account whose door you manage. Aliases: `THREE_WS_TOKEN`, `THREE_WS_BEARER`. |
| `THREE_WS_BASE` | no | `https://three.ws` | Override only when self-hosting. |
| `THREE_WS_TIMEOUT_MS` | no | `20000` | Per-request timeout. |

## Run and inspect

```bash
node src/index.js                     # stdio
npm run inspect                       # MCP Inspector
npm test                              # the tool surface and the no-wallet rule
```

## Related

- **[@three-ws/knock](https://www.npmjs.com/package/@three-ws/knock)** is the SDK and CLI that actually pays.
- **[three.ws/knock](https://three.ws/knock)** to open your own door.
- **[Knock docs](https://three.ws/docs/knock)** for the protocol and the wire format.

## License

Apache-2.0
