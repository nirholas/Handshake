# pumpfun-coin-fees

Skill for inspecting, collecting, and distributing creator fees on pump.fun
coins. It is coin-agnostic tooling: the mint and wallets are supplied at
runtime by the caller. Two tools wrap the fun-block API, which resolves
accounts, detects whether the coin uses a fee sharing config, and builds the
correct transaction automatically.

## Files

| File | Role |
|---|---|
| [manifest.json](./manifest.json) | Skill identity (`pumpfun-coin-fees` v1.0.0), `sandboxPolicy: "trusted-main-thread"`. |
| [tools.json](./tools.json) | JSON-Schema definitions of the two tools. |
| [handlers.js](./handlers.js) | Fetches to `POST https://fun-block.pump.fun/agents/collect-fees` and `POST .../agents/sharing-config`, both with `encoding: "base64"` forced. |
| [SKILL.md](./SKILL.md) | The full skill doc: API contract, fee-destination logic (cashback, shared config, direct creator), SDK fallback. |
| [scripts/](./scripts/) | Runnable Node scripts for direct SDK use, with shared helpers in `scripts/lib/`. |
| [package.json](./package.json) | Script entries and pinned SDK dependencies. |

## Tools

### `pumpfun_collect_fees`

Required args: `mint`, `user` (creator wallet pubkey). Optional:
`frontRunningProtection` and `tipAmount` (Jito tip in SOL). The API
auto-detects whether to collect directly for the creator or distribute via the
coin's sharing config, and the response reports what it found:
`{ transaction, creator, isGraduated, usesSharingConfig }`.

### `pumpfun_sharing_config`

Required args: `mint`, `user`, `shareholders` (up to 10 entries of
`{ address, bps }`; the `bps` values must total exactly 10000). Optional:
`mode` (`create` or `update`, auto-detected from on-chain state if omitted),
`frontRunningProtection`, `tipAmount`.

Both tools return a base64-encoded `VersionedTransaction` for the user's wallet
to sign and submit; the send call must use `encoding: "base64"` to match (see
the encoding note in [SKILL.md](./SKILL.md)).

## Example

The collect-fees handler's exact request, callable directly:

```bash
curl -s -X POST https://fun-block.pump.fun/agents/collect-fees \
  -H 'content-type: application/json' \
  -d '{
    "mint": "<TOKEN_MINT>",
    "user": "<CREATOR_PUBKEY>",
    "encoding": "base64"
  }'
# -> { "transaction": "<base64 VersionedTransaction>", "creator": "...",
#      "isGraduated": true, "usesSharingConfig": false }
```

## Runnable scripts (SDK path)

```bash
cd pump-fun-skills/coin-fees
npm install

# Coin metadata and state flags via the public pump.fun HTTP API (no RPC needed)
npm run fetch-coin -- --mint <MINT>

# Fee inspection and transaction builders (RPC required); each prints --help
SOLANA_RPC_URL=<https rpc> npm run fetch-fee-info -- --help
SOLANA_RPC_URL=<https rpc> npm run fetch-distributable-info -- --help
SOLANA_RPC_URL=<https rpc> npm run build-collect-fee-tx -- --help
SOLANA_RPC_URL=<https rpc> npm run build-distribute-fees-tx -- --help
```

On-chain scripts read `SOLANA_RPC_URL` (or `NEXT_PUBLIC_SOLANA_RPC_URL`) via
`scripts/lib/env.mjs`. Dependencies: `@pump-fun/pump-sdk`,
`@pump-fun/pump-swap-sdk`, `@solana/web3.js`, `@solana/spl-token`, `bn.js`.

## Related

- Launching coins: [../create-coin/](../create-coin/).
- Buying and selling: [../swap/](../swap/).
- Collection overview: [../README.md](../README.md).
