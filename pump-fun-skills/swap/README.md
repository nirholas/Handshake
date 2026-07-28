# pumpfun-swap

Skill for buying and selling tokens on pump.fun. It is coin-agnostic tooling:
the mints, amounts, and wallet are supplied at runtime by the caller. One tool
wraps the fun-block API, which detects the coin's state (bonding curve vs
graduated AMM pool) and builds the correct transaction automatically.

## Files

| File | Role |
|---|---|
| [manifest.json](./manifest.json) | Skill identity (`pumpfun-swap` v1.0.0), `sandboxPolicy: "trusted-main-thread"`. |
| [tools.json](./tools.json) | JSON-Schema definition of `pumpfun_swap`. |
| [handlers.js](./handlers.js) | One fetch to `POST https://fun-block.pump.fun/agents/swap` with `encoding: "base64"` forced. |
| [SKILL.md](./SKILL.md) | The full skill doc: API contract, buy/sell conventions, SDK fallback via `@pump-fun/pump-sdk` and `@pump-fun/pump-swap-sdk`. |
| [scripts/](./scripts/) | Runnable Node scripts for direct SDK use (bonding curve and AMM, buy and sell), with shared helpers in `scripts/lib/`. |
| [package.json](./package.json) | Script entries and pinned SDK dependencies. |

## Tool: `pumpfun_swap`

Required args: `inputMint`, `outputMint`, `amount` (string), `user` (signer
pubkey). Optional: `slippagePct` (default 2), `feePayer`,
`frontRunningProtection` (route via Jito; requires `tipAmount`, a tip in SOL).

Direction is expressed with the native mint
(`So11111111111111111111111111111111111111112`):

- **Buy**: `inputMint` = native mint, `outputMint` = token mint, `amount` = SOL in lamports.
- **Sell**: `inputMint` = token mint, `outputMint` = native mint, `amount` = token smallest units (6 decimals).

The response contains a base64-encoded `VersionedTransaction` plus
`pumpMintInfo` (including `hasGraduated` and `expectedOutAmount`). The user's
wallet signs and submits; the send call must use `encoding: "base64"` to match
(see the encoding note in [SKILL.md](./SKILL.md)).

## Example

The handler's exact request, callable directly (a 0.001 SOL buy):

```bash
curl -s -X POST https://fun-block.pump.fun/agents/swap \
  -H 'content-type: application/json' \
  -d '{
    "inputMint": "So11111111111111111111111111111111111111112",
    "outputMint": "<TOKEN_MINT>",
    "amount": "1000000",
    "user": "<WALLET_PUBKEY>",
    "slippagePct": 2,
    "encoding": "base64"
  }'
# -> { "transaction": "<base64 VersionedTransaction>", "pumpMintInfo": { "hasGraduated": false, ... } }
```

## Runnable scripts (SDK path)

```bash
cd pump-fun-skills/swap
npm install

# Coin metadata and state flags via the public pump.fun HTTP API (no RPC needed)
npm run fetch-coin -- --mint <MINT>

# SDK transaction builders (RPC required); each prints --help with its flags
SOLANA_RPC_URL=<https rpc> npm run build-buy-bonding-tx -- --help
SOLANA_RPC_URL=<https rpc> npm run build-sell-bonding-tx -- --help
SOLANA_RPC_URL=<https rpc> npm run build-buy-amm-tx -- --help
SOLANA_RPC_URL=<https rpc> npm run build-sell-amm-tx -- --help
SOLANA_RPC_URL=<https rpc> npm run print-balances -- --help
```

On-chain scripts read `SOLANA_RPC_URL` (or `NEXT_PUBLIC_SOLANA_RPC_URL`) via
`scripts/lib/env.mjs`. Dependencies: `@pump-fun/pump-sdk`,
`@pump-fun/pump-swap-sdk`, `@solana/web3.js`, `@solana/spl-token`, `bn.js`.

## Related

- Launch a coin first: [../create-coin/](../create-coin/).
- Creator fees: [../coin-fees/](../coin-fees/).
- Collection overview: [../README.md](../README.md).
