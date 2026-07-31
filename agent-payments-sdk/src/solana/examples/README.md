# Solana examples

Runnable examples for the Solana half of `@three-ws/agent-payments`. They read live mainnet data and never sign or send a transaction, so nothing here can spend.

| Example | What it does |
|---|---|
| [`listen-pump-events.ts`](./listen-pump-events.ts) | Subscribes to the pump.fun bonding-curve program, pretty-prints every decoded event for 60 seconds, then exits 0. |

## Run it

```bash
# From the agent-payments-sdk directory. Watches every mint on the program.
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
  npx tsx src/solana/examples/listen-pump-events.ts

# Narrow it to one mint
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com MINT=<MINT_ADDRESS> \
  npx tsx src/solana/examples/listen-pump-events.ts
```

`SOLANA_RPC_URL` defaults to the public `api.mainnet-beta.solana.com` endpoint, which is rate-limited and will drop subscriptions under load. Point it at a dedicated RPC for anything beyond a quick look.

The run is time-boxed to 60 seconds by design, so it terminates on its own in CI or a scripted check instead of hanging. A quiet program is a normal outcome: if no trades happen in that window it prints nothing and still exits 0.

## What it demonstrates

`subscribeToPumpEvents` from [`../pump-events.ts`](../pump-events.ts) handles the log subscription and Anchor event decoding, so the example only formats what it receives. That formatting is the interesting part for anyone building on this: `BN` values print as decimal strings and `PublicKey` values as base58, because both serialize to unhelpful objects through `JSON.stringify`.

Related: [the SDK README](../../../README.md) for install and the full API, and [docs/solana-pumpfun.md](../../../../docs/solana-pumpfun.md) for how the platform consumes these signals.
