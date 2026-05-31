# three.ws Developer Tools

Developer tooling for building on three.ws inside Claude Code. Scaffold a new agent, configure the `@3d-agent/mcp-server`, and get runnable code for the paid MCP tools — plus the MCP server itself, wired for x402 payments.

Part of the [three.ws plugin marketplace](https://github.com/nirholas/three.ws).

## Install

```
/plugin marketplace add nirholas/three.ws
/plugin install three-ws-developer@three-ws
```

Run `/reload-plugins` (or restart Claude Code) afterward.

## Commands

| Command | What it does |
| :------ | :----------- |
| `/three-ws-developer:scaffold-agent <Name>` | Scaffold a runnable three.ws agent wired to the SDK, MCP tools, and x402 payments. |
| `/three-ws-developer:setup-mcp` | Configure `@3d-agent/mcp-server` in Claude Desktop, Claude Code, or Cursor. Merges into your existing config. |
| `/three-ws-developer:use-tools <tool>` | Print ready-to-run code for any of the four paid MCP tools. |

## Bundled MCP server

Installing this plugin registers the `3d-agent` MCP server (`npx -y @3d-agent/mcp-server`), exposing four paid tools settled in USDC via x402:

| Tool | Price | What it does |
| :--- | :---- | :----------- |
| `get_pose_seed` | $0.001 | Deterministic pose map for a three.ws avatar |
| `pump_snapshot` | $0.005 | Live pump.fun token snapshot — price, volume, holders |
| `agent_reputation` | $0.01 | ERC-8004 reputation lookup on any EVM chain |
| `vanity_grinder` | up to $0.50 | Mine a Solana keypair with a custom address prefix |

Run `/three-ws-developer:use-tools <tool>` for runnable code for any of them.

> **Note:** the MCP server runs via `npx -y @3d-agent/mcp-server`, so the `@3d-agent/mcp-server` package must be published to npm for the server to start on a user's machine. The skills and commands in this plugin work regardless.

## Configuration

| Variable | Purpose |
| :------- | :------ |
| `MCP_EVM_PAYMENT_ADDRESS` | EVM address where you **receive** x402 micropayments. Public — never a private key. |
| `MCP_SVM_PAYMENT_ADDRESS` | Solana address where you **receive** x402 micropayments. |
| `ANTHROPIC_API_KEY` | Used by scaffolded agents to call Claude. Set in the generated agent's `.env`, not here. |

The payment addresses are public receiving addresses only. The MCP server never needs a private key.

## License

Apache-2.0
