# 13 · Launch a coin (testnet) — blocked on siblings

**Status: not built.** This example is supposed to launch a memecoin on
Robinhood Chain testnet (46630) via `hood-launcher`'s direct rail. That
package doesn't exist yet in the `robinhood/` workspace — see the root
README's SDK feedback for the full picture of what's shipped vs. pending.

## What's missing

**`hood-launcher`** — a launch client for NOXA and The Odyssey (prompt 08 in
`prompts/robinhood-chain/`), wrapping the raw factory calldata documented in
`hoodchain`'s `launchpads.ts` (`NOXA_ADDRESSES.launchFactory`,
`ODYSSEY_ADDRESSES.bondingCurveFactory`) into a single `launch({ name, symbol,
initialBuy })` call.

## What this example will do once it exists

```bash
ROBINHOOD_CHAIN_PRIVATE_KEY=0x... node index.js --name "Test Coin" --symbol TEST
```

launching a real token on testnet 46630 from faucet-funded ETH, printing the
new token address, the launch tx hash, and an explorer link — the same
funded-key pattern as [example 04](../04-swap-memecoin).

## Owner action

Build `hood-launcher` (prompt 08), then this example becomes a real testnet
launch script. Note the faucet is currently owner-blocked (Turnstile + Google
Sign-In gate) independent of this — see example 04's README for that detail.

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
