# Pump Launcher — deploy a pump.fun token in one paid call

`POST /api/x402/pump-launch` launches a brand-new [pump.fun](https://pump.fun)
token for an autonomous agent in a single paid request. The agent needs **no
SOL, no wallet, and no three.ws account** — it pays a flat USDC fee over the
[x402](x402.md) rail and the platform does the rest:

- fronts the ~0.022 SOL bonding-curve deploy cost from a funded launcher keypair,
- optionally grinds a **vanity mint address**,
- pins the token image + metadata to pump.fun IPFS (if you didn't pre-pin it),
- signs and broadcasts the create-coin transaction,
- routes pump.fun **creator rewards** to any Solana wallet the agent nominates.

## Which agent uses this, and why us

A launchpad bot, a "coin-per-X" automation (one coin per GitHub repo, per news
event, per Discord command), or an agent that mints a token as the payoff step of
a longer task. Every other path to a pump.fun launch needs a funded Solana wallet,
the SOL to pay rent + fees, and code that builds and signs the create instruction.
This endpoint collapses all of that into **one HTTP call priced in USDC** — the
one currency an agent operating on Base or Solana already holds. That's the pick:
no key management, no SOL treasury, no transaction assembly.

## Price

**$5.00** flat (USDC atomics `5000000`, 6 decimals). It comfortably covers the
~0.022 SOL the launcher fronts plus margin. Ops can override per unit-economics
with `X402_PRICE_PUMP_LAUNCH=<atomics>`. The live 402 challenge always quotes the
current figure — read it, don't hardcode.

## The free → paid funnel

The paid launch sits between two **free, keyless** [Crypto Data API](do-i-need-crypto.md)
endpoints. Use them to make the launch land well:

1. **Before you launch — check the ticker.**
   `GET /api/crypto/symbol?ticker=<SYMBOL>` reports whether a live pump.fun coin
   already trades that symbol and lists near-collisions. Free, no key. Pick a
   symbol that isn't already crowded before you spend $5.
2. **Launch** — `POST /api/x402/pump-launch` (this endpoint).
3. **After you launch — confirm it landed.**
   `GET /api/crypto/launches` is the live pump.fun launch feed; your new mint
   appears there once it's on-chain. Free, no key. Use it to verify the deploy
   and to surface the coin in a UI without polling an RPC.

Free data drives paid launches; paid launches show up in the free feed. That loop
is the point.

## Inputs

`name` and `symbol` are always required, plus **exactly one** of `metadataUri`
or `imageUrl`.

| Field | Required | Notes |
| --- | --- | --- |
| `name` | ✅ | Token name, 1–32 chars. |
| `symbol` | ✅ | Ticker, 1–10 chars. Check it first with `/api/crypto/symbol`. |
| `metadataUri` | one of | Pre-pinned pump.fun metadata descriptor (JSON on IPFS). Used verbatim; no server-side pinning. |
| `imageUrl` | one of | https URL of the token image. We pin the image + a descriptor to pump.fun IPFS for you (png/jpeg/gif/webp, ≤5 MB). |
| `description` | — | Coin description. Used only on the `imageUrl` (we-pin) path. |
| `twitter` / `telegram` / `website` | — | Socials embedded in the pinned metadata (`imageUrl` path). |
| `creator` | — | Solana pubkey (base58) to receive pump.fun creator rewards. Defaults to the launcher. |
| `vanityPrefix` / `vanitySuffix` | — | Base58 affix (≤5 chars each) to brand the mint address. When a matching address is already sitting in the [pre-ground inventory](vanity.md#tier-3--premium-inventory), it's claimed and used instantly instead of grinding — same $5 flat price either way. Longer patterns with no inventory match grind live and get exponentially slower. |
| `vanityIgnoreCase` | — | Match the vanity affixes case-insensitively (faster). Default `false`. |

### Example request

```bash
# 1. (free) is HELIO taken?
curl "https://three.ws/api/crypto/symbol?ticker=HELIO"

# 2. (paid, $5 USDC via x402) launch it — your x402 client handles the 402 dance
curl -X POST https://three.ws/api/x402/pump-launch \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Helios",
    "symbol": "HELIO",
    "imageUrl": "https://three.ws/logo.png",
    "description": "A sun-themed community coin.",
    "creator": "wwwPqsM4N7T9J69tB82nLyzxqsH159j4orftLTQfUGV",
    "twitter": "https://x.com/heliocoin",
    "vanityPrefix": "HEL"
  }'

# 3. (free) confirm it landed on the live launch feed
curl "https://three.ws/api/crypto/launches"
```

See [x402 buyer client](x402-buyer.md) for how to satisfy the 402 challenge in
code (the `curl` above shows the shape, not the payment headers).

## Output

```json
{
  "mint": "HEL1oXyz…",
  "signature": "5xY…sig",
  "creator": "wwwPqsM4N7T9J69tB82nLyzxqsH159j4orftLTQfUGV",
  "name": "Helios",
  "symbol": "HELIO",
  "metadataUri": "https://ipfs.io/ipfs/Qm…",
  "network": "mainnet",
  "explorer": "https://solscan.io/tx/5xY…sig",
  "pumpfun_url": "https://pump.fun/coin/HEL1oXyz…",
  "vanity_prefix": "HEL",
  "vanity_suffix": null,
  "vanity_iterations": 4821,
  "vanity_duration_ms": 190,
  "vanity_source": "ground"
}
```

`vanity_source` is `"inventory"` when the mint was served instantly from the
pre-ground warehouse (no grind wait, `vanity_iterations`/`vanity_duration_ms`
both `0`), `"ground"` when mined fresh for this launch, or `null` when no
`vanityPrefix`/`vanitySuffix` was requested.

`mint`, `signature`, `metadataUri`, and `pumpfun_url` are guaranteed on success.

## Networks & settlement

Pay in **USDC on Base or Solana mainnet** (the 402 challenge advertises both). The
token itself always deploys on **Solana mainnet** — pump.fun is mainnet-only.

## Correctness guarantees

- **Validation before payment.** A missing `name`/`symbol`, a request with
  neither `metadataUri` nor `imageUrl`, or a malformed field is rejected `400`
  **before** settlement — a bad request never charges you.
- **Failed deploy costs nothing.** The launch runs after payment verification but
  **before** settlement. A bad image URL, IPFS failure, or RPC error throws before
  settle, so the buyer is not charged for a launch that didn't happen.
- **Idempotent per payment.** When your x402 client sends a payment identifier, a
  same-proof retry replays the **same** mint + signature instead of launching a
  second token.

## Related

- [x402 paid endpoints](x402-endpoints.md) — the full catalog and pricing.
- [Crypto Data API](do-i-need-crypto.md) — the free `symbol` and `launches`
  endpoints that bookend a launch.
- [Repo → Coin Launcher](pump-launch-repos.md) — the batch/CLI launcher that
  routes 100% of creator rewards to a GitHub identity (shares the same engine).
- [x402 protocol](x402.md) — challenge/settle mechanics.
