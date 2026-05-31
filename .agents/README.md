# three.ws Core

Core wallet and x402 payment skills for Claude Code. Authenticate a wallet, fund it, send tokens, trade, search the x402 bazaar, pay for services, monetize your own APIs, and query onchain data — all from natural language.

Part of the [three.ws plugin marketplace](https://github.com/nirholas/three.ws).

## Install

```
/plugin marketplace add nirholas/three.ws
/plugin install three-ws-core@three-ws
```

Then run `/reload-plugins` (or restart Claude Code) and start a request like *"send $5 USDC to vitalik.eth"*.

## Skills

| Skill | What it does |
| :---- | :----------- |
| `authenticate-wallet` | Sign in to the wallet. Prerequisite for sending, trading, and funding. |
| `fund` | Add money to the wallet — deposit, top up, buy USDC, onramp. |
| `send-usdc` | Send USDC, ETH, POL, or SOL to an address or ENS name on Base, Polygon, or Solana. |
| `trade` | Swap tokens on Base or Polygon (USDC ↔ ETH ↔ POL). |
| `search-for-service` | Search and browse the x402 bazaar for paid API services. |
| `pay-for-service` | Make a paid API request to an x402 endpoint with automatic USDC payment. |
| `monetize-service` | Build and deploy a paid API that other agents can pay to use via x402. |
| `query-onchain-data` | Query onchain data on Base using the CDP SQL API via x402. |
| `x402` | General x402 entry point — discover payment requirements and call paid endpoints. |

Skills are model-invoked: Claude selects the right one from the task. You can also call any of them explicitly, e.g. `/three-ws-core:send-usdc`.

## Configuration

These skills talk to the three.ws wallet API. Set the following in your environment before use:

| Variable | Purpose |
| :------- | :------ |
| `THREE_WS_API` | Base URL of the three.ws wallet API. |
| `THREE_WS_TOKEN` | Bearer token for the authenticated wallet. The `authenticate-wallet` skill obtains this for you. |

No secrets are written to disk by these skills. Transfers are confirmed with you before they execute, and they are irreversible.

## License

Apache-2.0
