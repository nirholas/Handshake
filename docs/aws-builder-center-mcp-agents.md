---
venue: AWS Builder Center
account: three.ws (official) or personal builder byline
suggested_title: "I built an MCP server whose tools pay for themselves"
suggested_description: "An open-source MCP server that lets any agent (Claude, Cursor, your own) work with 3D avatars and call paid tools that settle per-call in USDC over HTTP 402. No subscription, no API key for the paid tools. Runs on AWS."
suggested_tags: [mcp, agents, agentic-ai, generative-ai, open-source]
suggested_canonical: https://three.ws/docs/mcp.md
---

# I built an MCP server whose tools pay for themselves

Most AI tooling assumes a human is standing by with a credit card and an API key. You sign up, you paste a key into a config, you get a monthly bill. That model breaks the moment the *agent* is the one that needs a tool mid-reasoning. It cannot sign up for anything. It cannot paste a key. It just stops.

I wanted agents to call paid tools the way they call free ones: discover, call, get a result, with the payment handled inline and autonomously. The Model Context Protocol gave me the tool interface, and HTTP 402 gave me the payment rail. This is a walk through what I built, all of it open source under Apache 2.0.

## Why MCP

MCP is an open standard from Anthropic that gives AI assistants a uniform way to discover and call external tools over JSON-RPC. The practical win is that I expose one server, and Claude Desktop, Claude Code, Cursor, and any custom agent all speak to it the same way. I did not have to write a per-client integration. A tool is a tool, whether it loads a 3D model or returns a market snapshot.

There are two surfaces, and they answer two different questions.

## Surface one: the hosted server (your account, your avatars)

The hosted server lives at `https://three.ws/api/mcp`. It is streamable HTTP, MCP protocol `2025-06-18`, and it is account-aware, so it authenticates with OAuth 2.1 or a server-to-server API key. Once an MCP client points at it, the agent can:

- browse and search your avatar library without anyone copy-pasting URLs,
- render any avatar inline as an interactive `<model-viewer>` artifact,
- run the Khronos glTF-Validator against any public GLB or glTF URL,
- inspect mesh, texture, and animation counts and geometry stats,
- get concrete optimization suggestions (compression, LOD, texture transcoding).

The OAuth flow is the textbook one: dynamic client registration (RFC 7591), PKCE, and `.well-known` discovery (RFC 8414 / 9728), so a client that has never seen the server can register, get consent, and start calling tools with zero manual setup. Scopes on the token gate which tools the agent is allowed to touch.

```json
{
  "mcpServers": {
    "3d-agent": {
      "url": "https://three.ws/api/mcp",
      "headers": { "Authorization": "Bearer 3da_live_xxxxx" }
    }
  }
}
```

## Surface two: four tools that pay for themselves

This is the part I am most proud of. The npm package `@3d-agent/mcp-server` exposes four tools that take **no subscription and no API key**. Each call settles per-use in USDC over the x402 protocol (the HTTP 402 Payment Required status code, finally put to work). You configure a wallet address, not a key.

| Tool | Price | What it returns |
|---|---|---|
| `get_pose_seed` | $0.001 | A deterministic seed and full Euler-rotation pose map for the pose-studio mannequin, plus a preview URL. |
| `pump_snapshot` | $0.005 | A live token snapshot: USD price (Jupiter), 24h volume and pair (Dexscreener), mint metadata and image, and on-chain top-holder distribution (Solana RPC). |
| `agent_reputation` | $0.01 | ERC-8004 on-chain reputation for an agent: score, total stake, and the latest reputation events from the canonical registry (default Base). |
| `vanity_grinder` | up to $0.50 | A Solana keypair whose address starts with a prefix you choose. Settled USDC scales with the work actually done, capped at $0.50. |

Setup is a wallet, not an account:

```json
{
  "mcpServers": {
    "3d-agent": {
      "command": "npx",
      "args": ["-y", "@3d-agent/mcp-server"],
      "env": {
        "MCP_EVM_PAYMENT_ADDRESS": "0xYourBaseWallet",
        "MCP_SVM_PAYMENT_ADDRESS": "YourSolanaWallet"
      }
    }
  }
}
```

## The payment flow, end to end

Here is what happens when an agent calls a paid tool:

1. The agent calls, say, `pump_snapshot`.
2. The server replies with HTTP 402 and a challenge describing the price and where to pay.
3. The package settles the micropayment from the configured wallet in USDC.
4. It retries the call with proof of payment, and the result streams back.

From the agent's point of view this is a single tool call that just works. Under the hood, a real on-chain micropayment happened, no human in the loop. That is the unlock: an agent can consume a paid data feed in the middle of its reasoning without anyone provisioning access first. And because it is a standard, the same machinery lets *you* charge other agents for tools you expose. Consumer and provider, one protocol.

## The architecture is deliberately thin

```
MCP client (Claude, Cursor)  ->  @3d-agent/mcp-server (npm, stdio)  ->  HTTPS + x402  ->  platform on AWS
```

The npm package is a stdio-to-HTTP bridge. It speaks MCP over stdio to the client, handles the OAuth or x402 settlement, and forwards each call to the platform API over HTTPS. All the real logic lives server-side behind a normal HTTP API. That keeps the bridge small enough to audit in one sitting, and it means every capability is reachable without MCP at all, which is exactly what you want from infrastructure.

## Where AWS comes in

The platform runs on AWS in `us-east-1`, with assets and storage on S3, and it is available to subscribe through AWS Marketplace so usage lands on your AWS bill and counts toward existing commitments. three.ws is an AWS Partner (APN Software Path, Technology Partner).

The MCP server itself is intentionally cloud-agnostic: it is an npm bridge to an HTTP API, so it drops into a Bedrock agent, a Strands agent, a Claude Code session, or anything else that speaks MCP, without caring where the agent runs. If you are building agentic systems on AWS and want them to use paid external tools without a human managing keys, this is a working pattern you can copy.

## Try it

- MCP docs and the full tool reference: [three.ws/docs/mcp.md](https://three.ws/docs/mcp.md)
- Paid tools: `npx -y @3d-agent/mcp-server`
- Source (Apache 2.0): [github.com/nirholas/three.ws](https://github.com/nirholas/three.ws)

If you wire it into something, or you want to list a paid tool of your own, the repo issues are open. I would like to see what people point this at.

---

*three.ws is an open-source platform for 3D AI agents and on-chain communities, an AWS Partner and available on AWS Marketplace. Live at [three.ws](https://three.ws).*
