# 13 · Launch a coin (testnet)

Robinhood Chain has three ways to bring a token into the world: **NOXA** (one
tx deploys the ERC-20, opens a Uniswap v3 pool, and locks the LP), **The
Odyssey** (a native-ETH bonding curve that graduates to Uniswap), and a
**direct** rail that deploys and seeds a Uniswap v3 pool yourself.
[`hood-launcher`](https://www.npmjs.com/package/hood-launcher) puts all three
behind one call.

This example walks the whole pipeline for a single coin: build and screen the
concept, run the rail's on-chain preflight, print exactly what the launch will
cost and what it will send, then stop (dry run, the default) or broadcast.

**What it proves:** a launch is a pipeline, not a transaction. Content
screening, ticker uniqueness, artwork, spend caps, and a rail preflight all
have to pass before any ETH moves, and every one of those checks is a real
read against the live chain.

## Prerequisites

- Node ≥ 20.
- **No wallet or key for the dry run.** Preflight is read-only.
- Broadcasting needs a testnet-funded key. The public faucet is behind a
  Turnstile + Google Sign-In gate, so it cannot be scripted; fund a throwaway
  key by hand first. This is the same funding gate as
  [example 04](../04-swap-memecoin).

## Run

```bash
npm install
npm start                              # dry run on the direct rail
node index.js --symbol MYCOIN          # pin your own ticker
node index.js --rail noxa              # ask a mainnet-only rail what it thinks
node index.js --generate-logo          # generate a real 3D GLB logo first (slow)
```

## Expected output

```
1 - Operator config
  network    testnet  (chain 46630)
  signer     none, reads only
  live flag  unset
  mode       dry run (no broadcast)

2 - Coin
  name       Example Coin
  symbol     EXZJJ
  rail       direct
  initialBuy 0.001 ETH
  logo       https://three.ws/models/demo-avatar.glb

3 - Preflight (a real read against the live factory)
  rail         direct on testnet
  protocol fee 0 ETH
  tx value     0.001 ETH  (fee + initial buy)
  pairs with   0x7943e237c7F95DA44E0301572D358911207852Fa
  ready        no
    blocker: No signer configured, direct rail requires a wallet account.

4 - Result
  Dry run: nothing was broadcast. The numbers above are what the
  launch would cost right now, read from the live contracts.
```

One blocker, and it is the honest one: no key is configured, so nothing can be
signed. Everything else already passed against the real chain, including the
WETH pair token the pool would use.

## Which rail works on testnet

Only `direct`. Ask the others and preflight says so itself:

```
$ node index.js --rail noxa
    blocker: NOXA only operates on mainnet 4663, no testnet deployment exists.

$ node index.js --rail odyssey
    blocker: The Odyssey only operates on mainnet 4663, no testnet deployment exists.
```

That is not a limitation of this example. Both launchpads are mainnet-only
contracts, and the launcher reads their deployment state rather than assuming
it, so you find out in a free dry run instead of a reverted transaction.

## Launching for real

```bash
LIVE=1 ACKNOWLEDGE_LAUNCH_RESPONSIBILITY=1 \
  ROBINHOOD_CHAIN_PRIVATE_KEY=0x... node index.js --send
```

Three separate gates, all deliberate: `LIVE=1` arms the launcher,
`ACKNOWLEDGE_LAUNCH_RESPONSIBILITY=1` records that a human owns what gets
deployed, and `--send` is the per-run confirmation. Spend caps
(`MAX_LAUNCHES_PER_DAY`, `MAX_SEED_USDG`) are enforced on top of those, and a
kill switch on disk can stop everything. A launch that clears all of that
prints the token address, the tx hash, the pool, and an explorer link.

## The safety rails are real, and you will hit them

Two of them fired while this example was being written, both correctly:

- **Content screening.** An early draft described the coin using a brand term
  and the launcher refused to price it: `Concept rejected (description):
  contains denylisted term`.
- **Ticker uniqueness.** The first hardcoded default collided with a token
  that already exists on testnet, so the default is now randomised: `Ticker
  "EXMPL" is already taken (testnet token 0x021b0a28...)`.

Both are on-chain or policy reads that happen before any spend. That is the
point of a preflight.

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
