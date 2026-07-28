# pumpfun-create-coin

Skill for launching coins on pump.fun with an optional initial buy. It is
coin-agnostic tooling: the name, symbol, metadata URI, and amounts are supplied
at runtime by the caller. One tool wraps the fun-block API, which handles
account resolution, compute budget, and mint-keypair partial signing; the
caller's wallet co-signs and submits.

## Files

| File | Role |
|---|---|
| [manifest.json](./manifest.json) | Skill identity (`pumpfun-create-coin` v1.0.0), `sandboxPolicy: "trusted-main-thread"`. |
| [tools.json](./tools.json) | JSON-Schema definition of `pumpfun_create_coin`. |
| [handlers.js](./handlers.js) | One fetch to `POST https://fun-block.pump.fun/agents/create-coin` with `encoding: "base64"` forced. |
| [SKILL.md](./SKILL.md) | The full skill doc: API contract, required user confirmations, SDK fallback via `@pump-fun/pump-sdk`. |
| [references/METADATA.md](./references/METADATA.md) | How to build and upload the token metadata JSON the `uri` field points at. |
| [scripts/](./scripts/) | Runnable Node scripts for direct SDK use (no API), with shared helpers in `scripts/lib/`. |
| [package.json](./package.json) | Script entries and pinned SDK dependencies. |

## Tool: `pumpfun_create_coin`

Required args: `user` (creator wallet pubkey), `name`, `symbol`, `uri`
(metadata JSON on IPFS or HTTPS), `solLamports` (initial buy in lamports).
Optional: `mayhemMode`, `cashback`, `tokenizedAgent` (+ `buybackBps`, e.g.
`5000` = 50%), `frontRunningProtection` (+ `tipAmount`, a Jito tip in SOL),
`feePayer`, `creator`.

The response contains a base64-encoded `VersionedTransaction` already
partial-signed by the server-generated mint keypair, plus `mintPublicKey`.
The user wallet must co-sign before submitting, and the send call must use
`encoding: "base64"` to match (mismatched encodings fail the transaction; see
the encoding note in [SKILL.md](./SKILL.md)).

## Example

The handler's exact request, callable directly:

```bash
curl -s -X POST https://fun-block.pump.fun/agents/create-coin \
  -H 'content-type: application/json' \
  -d '{
    "user": "<CREATOR_PUBKEY>",
    "name": "MyCoin",
    "symbol": "MC",
    "uri": "https://ipfs.io/ipfs/Qm...",
    "solLamports": "1000000",
    "encoding": "base64"
  }'
# -> { "transaction": "<base64 VersionedTransaction>", "mintPublicKey": "...", ... }
```

## Runnable scripts (SDK path)

For custom integrations that skip the API, install and run the scripts:

```bash
cd pump-fun-skills/create-coin
npm install

# Coin metadata and state flags via the public pump.fun HTTP API (no RPC needed)
npm run fetch-coin -- --mint <MINT>

# Build the create + initial-buy transaction with the SDK (RPC required)
SOLANA_RPC_URL=<https rpc> npm run build-create-coin-tx -- --help
```

Every script prints `--help` with its full flag list. On-chain scripts read
`SOLANA_RPC_URL` (or `NEXT_PUBLIC_SOLANA_RPC_URL`) via `scripts/lib/env.mjs`;
`fetch-coin` needs no environment at all. Dependencies: `@pump-fun/pump-sdk`,
`@pump-fun/pump-swap-sdk`, `@solana/web3.js`, `@solana/spl-token`, `bn.js`,
`@three-ws/agent-payments`.

## Related

- Buy/sell after launch: [../swap/](../swap/).
- Creator fees for launched coins: [../coin-fees/](../coin-fees/).
- Collection overview: [../README.md](../README.md).
