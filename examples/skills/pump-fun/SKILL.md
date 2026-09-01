# pump-fun

Read-only Solana market intel for three.ws agents. The skill calls the
in-house MCP route at `/api/pump-fun-mcp` (not an external host), so it
works on any deployment of three.ws without third-party DNS or proxies.

## Tools (10)

| Tool | Backed by | Notes |
|---|---|---|
| `getBondingCurve` | `@pump-fun/pump-sdk` on-chain | Real reserves + graduation %. Always available. |
| `getTokenDetails` | Solana RPC + Metaplex metadata | Mint, supply, decimals, name, symbol. Always available. |
| `getTokenHolders` | `connection.getTokenLargestAccounts` | Top holders + concentration. Always available. |
| `searchTokens` | upstream pumpfun-claims-bot | Requires `PUMPFUN_BOT_URL`. |
| `getTokenTrades` | upstream pumpfun-claims-bot, else on-chain | Real trades decoded from Solana RPC when `PUMPFUN_BOT_URL` is unset. Always available. |
| `getTrendingTokens` | upstream pumpfun-claims-bot, else live pump.fun feed | Falls through to pump.fun's public feed and the platform's launch recorder when `PUMPFUN_BOT_URL` is unset. Always available. |
| `getNewTokens` | upstream pumpfun-claims-bot, else live pump.fun feed | Newest launches from pump.fun's public feed, with the platform's launch recorder as backup, when `PUMPFUN_BOT_URL` is unset. Always available. |
| `getGraduatedTokens` | upstream pumpfun-claims-bot | Requires `PUMPFUN_BOT_URL`. |
| `getKingOfTheHill` | upstream pumpfun-claims-bot | Requires `PUMPFUN_BOT_URL`. |
| `getCreatorProfile` | upstream pumpfun-claims-bot | Requires `PUMPFUN_BOT_URL`. |

Tools requiring the indexer return JSON-RPC error `-32004` (with a clear
configuration message) when the bot URL is not set — they never return
fabricated or placeholder data.

## Endpoint resolution

The skill resolves `/api/pump-fun-mcp` against the page origin
(`window.location.origin`) at call time. No build-step configuration needed.

## Install

Reference the bundle from your agent manifest:

```json
{
  "skills": [
    { "uri": "skills/pump-fun/" }
  ]
}
```

## Sentiment hooks

Some handlers attach a `sentiment` (-1..1) to their result so the avatar's
Empathy Layer reacts:

- `getCreatorProfile` with rug flags → negative (concern)
- `getBondingCurve` near graduation → positive (celebration)
- `getTokenHolders` with whale concentration → negative (concern)
- `getKingOfTheHill` → mild positive (curiosity)

## Suggested system prompt

> When the user mentions a token name, symbol, or mint address, call
> `searchTokens` first, then `getBondingCurve` and `getTokenHolders`
> before giving an opinion. Always check `getCreatorProfile` for rug
> flags before recommending a buy.
