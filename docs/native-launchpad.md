# The three.ws launchpad: our own bonding curve

three.ws has always been able to launch a coin for an agent. Until now, every one of those launches went out on pump.fun: their program, their curve, their fee schedule. That lane still exists and still matters, because that is where the buyers are.

This document covers the second lane: **the native launchpad**, a coin launch that runs on a bonding curve three.ws configures and owns. Same launch button, same 3D agent identity attached to the coin, different economics underneath.

Related surfaces: [the pump.fun lane](./api-reference.md) (`/api/pump/*`), [agent wallets](./agent-wallets.md) (custody), and [the launch page](https://three.ws/launch).

---

## Why a second lane exists

A launchpad's revenue is a share of trading fees. On the pump.fun lane, three.ws only ever touches the creator-fee side of a launch, because the platform fee belongs to pump.fun. On the native lane, three.ws is the on-chain partner of the curve itself, so the platform earns a share of every trade on every coin launched through it, plus a share of the fees the pool keeps earning after graduation.

The tradeoff is honest and worth stating plainly: pump.fun brings order flow that a new curve does not have. Trading terminals and aggregators index pump.fun natively. So the two lanes are not a migration, they are a choice the launcher makes per coin: **reach, or economics.**

## What the native lane does not do

Building our own bonding-curve program from scratch would mean writing, auditing, and maintaining custody-grade Solana code, and then bootstrapping liquidity for graduated coins with no venue to graduate into. We did not do that.

The native lane runs on **Meteora's Dynamic Bonding Curve (DBC)** program: an audited, permissionless launchpad-as-infrastructure program. three.ws creates a *partner config* on it once per network. That config encodes our curve shape, our fee split, and our graduation target, and every pool created under our config key is a three.ws launch. We own the product, the economics, and the brand; we do not own the risk of unaudited custody code, and graduated coins land in a real AMM pool with real routing.

---

## The curve

All of it lives in one file, [`api/_lib/native-launch/config.js`](../api/_lib/native-launch/config.js), so the numbers a user is shown can never drift from the numbers the chain enforces.

| Property | Value |
|---|---|
| Quote asset | SOL |
| Supply | 1,000,000,000 (6 decimals) |
| Metadata authority | Immutable at launch |
| Starting market cap | ~28 SOL |
| Graduation market cap | ~410 SOL (≈85 SOL raised on the curve) |
| Trading fee | 1%, taken in SOL, plus a volatility-scaled dynamic fee during spikes |
| Trading fee split | 50% coin creator / 50% three.ws |
| Migration fee | 1% of the raised SOL, split 50/50 |
| Graduates into | A Meteora DAMM v2 pool |
| LP at graduation | 100% permanently locked (50% creator / 50% platform) |

Two of these deserve emphasis:

**The metadata authority is immutable.** Nobody, including three.ws, can rewrite a launched coin's name, symbol, or image after the fact.

**All liquidity is permanently locked at graduation.** Neither the creator nor the platform can withdraw the pool. A graduated native coin cannot be rugged by liquidity removal, and both sides keep earning LP fees on it for as long as it trades.

The graduation target deliberately mirrors the shape traders already recognise from pump.fun (~85 SOL raised), so the lane feels familiar rather than novel where novelty would only add friction.

### Why `leftover: 1`

The DBC program requires that the tokens on the curve, the tokens reserved for migration, and the leftover reconcile *exactly* against the fixed supply. A leftover of `0` fails that check on-chain with `InvalidTokenSupply`. One base unit of dust satisfies it. This was found by simulating the real `create_config` instruction against devnet, and it is pinned by a test so nobody "cleans it up" later.

---

## How a launch works

The custody model is identical to the pump.fun lane: **the server never holds a user key.** It builds an unsigned transaction; the browser signs it with the launcher's wallet and the new mint's keypair; a confirm step verifies the landed transaction on-chain before anything is recorded.

```
POST /api/native-launch/launch-prep     → unsigned create-pool tx + mint keypair
   ↓  (browser signs with wallet + mint, submits to Solana)
POST /api/native-launch/launch-confirm  → verifies on-chain, records the launch
```

### `POST /api/native-launch/launch-prep`

Requires a session and a Solana wallet linked to that account.

```json
{
  "avatar_id": "e29028e5-dcdf-4359-8101-0fb8cbba5dc3",
  "wallet_address": "<your linked Solana wallet>",
  "name": "Native Coin",
  "symbol": "NTV",
  "uri": "https://three.ws/metadata.json",
  "sol_buy_in": 0.05,
  "network": "mainnet"
}
```

`agent_id` may be sent instead of `avatar_id`. `sol_buy_in` is an optional first buy bundled into the same transaction. `mint_address` may carry a client-ground vanity mint; omit it and the server grinds one.

Returns `201` with the unsigned transaction and the deterministic pool address:

```json
{
  "prep_id": "…",
  "agent_id": "…",
  "lane": "native",
  "mint": "3ws…",
  "pool": "…",
  "config_key": "…",
  "mint_secret_key_b64": "…",
  "client_supplied_mint": false,
  "tx_base64": "…",
  "network": "mainnet",
  "expires_at": "2026-07-27T17:50:51.336Z"
}
```

Every three.ws coin's mint address carries the `3ws` mark, on both lanes. When the server stamps the mint it returns the secret so the browser can co-sign; when you supply your own ground vanity mint, the server never sees its key.

Errors: `401` not signed in, `403` wallet not linked to your account, `400 unbranded_mint` for a supplied mint without the mark, `503 lane_not_configured` when the curve is not deployed on that network.

### `POST /api/native-launch/launch-confirm`

```json
{ "prep_id": "…", "tx_signature": "…" }
```

Before recording anything, the server independently verifies the signature against the chain and applies two guards:

1. The prepped mint must appear in the transaction's account keys.
2. The transaction must actually have **invoked the bonding-curve program** (`422 not_a_native_launch` otherwise).

The second guard is the important one: without it, a confirmed memo or transfer that merely touches the new mint account could be recorded as a launch. Returns `201` with the recorded row, or `409` if that mint is already registered.

### Read endpoints

All public, no auth:

- `GET /api/native-launch/config[?network=]` — the lane's live economics and whether it is deployed. This is what the launch UI renders, so the fee story on the page always comes from the same source as the on-chain config.
- `GET /api/native-launch/pool?mint=…[&network=]` — pool address, curve progress (0..1), SOL raised, graduation threshold, migration status.
- `GET /api/native-launch/quote?mint=…&sol_in=…[&network=]` — a live buy quote off the curve: tokens out, minimum out, and the fee breakdown.
- `GET /api/native-launch/launches[?network=&agent_id=&limit=&offset=]`: the native launch directory, each row carrying its agent and avatar thumbnail. `agent_id` must be a uuid: anything else answers `400 validation_error` instead of reaching the database. `limit` is clamped to 1..100 (default 24), `offset` to a non-negative integer.

---

## Deploying the lane on a network

The partner config is created once per network and then pinned in the environment. Until it is pinned, the lane reports itself unavailable, the launch UI hides the lane toggle entirely, and every launch stays on pump.fun. There is no half-configured state.

```bash
# devnet (the partner wallet needs ~0.05 SOL for rent + fees)
node scripts/native-launchpad-create-config.mjs --network devnet --airdrop

# mainnet
node scripts/native-launchpad-create-config.mjs --network mainnet
```

The script prints the config pubkey. Pin it:

| Variable | Meaning |
|---|---|
| `NATIVE_LAUNCH_CONFIG_KEY` | Mainnet partner config pubkey |
| `NATIVE_LAUNCH_CONFIG_KEY_DEVNET` | Devnet partner config pubkey |
| `NATIVE_LAUNCH_FEE_WALLET` | Platform fee claimer + leftover receiver (defaults to the treasury wallet) |
| `NATIVE_LAUNCH_PARTNER_SECRET_BASE58` | Signer that creates the config (falls back to the treasury secret) |

On production these live on the Cloud Run service, not in a file.

### Verifying a deployment end to end

`scripts/native-launchpad-e2e-devnet.mjs` drives the real modules the API uses: it builds a create-pool transaction, signs and lands it on devnet, reads the pool back, quotes a buy, executes that buy, and asserts the curve moved.

```bash
node scripts/native-launchpad-e2e-devnet.mjs
```

The devnet run that shipped this feature created config `FK3HQrWG5y6rh3SC8ew5WVUfo31bfmkm2Z1nwuZaKcam`, launched a pool, and confirmed the fee math on-chain: a 0.5 SOL buy moved the pool's reserve by exactly 0.49499951 SOL, i.e. precisely the 1% fee.

---

## Where it lives

| Piece | Path |
|---|---|
| Curve economics (single source of truth) | [`api/_lib/native-launch/config.js`](../api/_lib/native-launch/config.js) |
| DBC wrapper (build tx, read pool, quote) | [`api/_lib/native-launch/dbc.js`](../api/_lib/native-launch/dbc.js) |
| HTTP dispatcher | [`api/native-launch/[action].js`](../api/native-launch/%5Baction%5D.js) |
| Launch table | `native_launches` (migration `20260726100000_native_launchpad.sql`) |
| Launch UI (lane toggle) | [`public/studio/launch-panel.js`](../public/studio/launch-panel.js) |
| Config creation | [`scripts/native-launchpad-create-config.mjs`](../scripts/native-launchpad-create-config.mjs) |
| Devnet end-to-end | [`scripts/native-launchpad-e2e-devnet.mjs`](../scripts/native-launchpad-e2e-devnet.mjs) |
| Tests | `tests/native-launch-curve.test.js`, `tests/native-launch-endpoint.test.js` |

Note the namespace: this lane is `/api/native-launch/*`. The unrelated `/api/launchpad/*` endpoints belong to Launchpad Studio, the page builder.

---

## Current limits

Stated plainly, because a half-built feature that claims to be finished is worse than one that names its edges:

- **No custodial launch path.** The pump.fun lane can launch from an agent's own server-signed wallet; the native lane is always signed by the launcher's connected wallet. The lane toggle switches the signer back to the connected wallet automatically rather than offering an option that would fail.
- **No coin-detail page yet.** `/launches/<mint>` reads price history, trades, safety, and smart-money data from pump-specific endpoints, so it cannot render a native coin. The launch success screen links to Solscan and the agent page instead of a link that would 404.
- **No coin variants.** Mayhem, USDC pairing, buyback binding, and delegated reward splits are pump.fun program features. The native lane is SOL-quoted and variant-free, so that picker is withheld on this lane rather than shown with dead options.
