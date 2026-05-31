# three.ws plugin marketplace

The official Claude Code plugin marketplace for [three.ws](https://three.ws) — wallet operations, x402 payments, MCP tools, pump.fun trading, and agent scaffolding.

## Add the marketplace

```
/plugin marketplace add nirholas/three.ws
```

## Install plugins

```
/plugin install three-ws-core@three-ws        # wallet + x402 payment skills
/plugin install three-ws-developer@three-ws    # agent scaffolding + MCP tooling
/plugin install three-ws-pump-fun@three-ws     # pump.fun on-chain trading
```

Run `/reload-plugins` (or restart Claude Code) after installing.

## Plugins

| Plugin | Type | Summary | Docs |
| :----- | :--- | :------ | :--- |
| `three-ws-core` | 9 skills | Authenticate, fund, send, trade, search the bazaar, pay for and monetize services, query onchain data. | [README](../.agents/README.md) |
| `three-ws-developer` | 3 commands + MCP server | Scaffold agents, configure `@3d-agent/mcp-server`, get runnable tool code. | [README](../marketplace/plugins/three-ws-developer/README.md) |
| `three-ws-pump-fun` | 5 skills | Create coins, swap tokens, manage creator fees, tokenize agents, live feed reactions. | [README](../pump-fun-skills/README.md) |

## Configuration at a glance

| Plugin | Variables |
| :----- | :-------- |
| `three-ws-core` | `THREE_WS_API`, `THREE_WS_TOKEN` |
| `three-ws-developer` | `MCP_EVM_PAYMENT_ADDRESS`, `MCP_SVM_PAYMENT_ADDRESS` |
| `three-ws-pump-fun` | `SOLANA_PRIVATE_KEY`, `SOLANA_RPC_URL` |

See each plugin's README for details. Skills that move funds always confirm before executing, and transactions are irreversible.

## Validate locally

```
claude plugin validate .
```

## License

Apache-2.0
