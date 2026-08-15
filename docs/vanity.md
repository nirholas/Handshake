# Vanity — brand a Solana address in one paid call

Three x402 endpoints that hand an agent a **branded Solana address** — one that
starts with your ticker/prefix and/or ends with a chosen suffix — with no wallet,
no account, and no SOL. Pay per call in USDC over the [x402](x402.md) rail and the
server grinds (or delivers from stock) a brand-new keypair that matches.

| Endpoint | What it is | Chars | Price | Pick it when |
| --- | --- | --- | --- | --- |
| [`/api/x402/vanity`](#tier-1--live-grinder) | Live grind, or **instant delivery** when a match is already in stock | ≤3 (grind or instant) · 4–5 (instant only) | $0.01–$0.50 (≤3) · $2.50–$10 (4–5) | You want a custom address **now** and don't care whether it was just ground or pulled from the shelf. |
| [`/api/x402/vanity-verifiable`](#tier-2--provably-fair-grinder) | Live grind **+ signed proof** it was ground fresh | ≤3 | $0.02–$0.40 | You need to **prove** no copy was kept (commit–reveal receipt). |
| [`/api/x402/vanity-premium`](#tier-3--premium-inventory) | Browse and buy a **specific pre-ground** long address from stock | 4–5+ | $1–$50 | You want to pick an exact rarer prefix from the catalog rather than "any match". |

All three are **keyless**: no API key, no signup. The Solana rail is the platform
default; Base mainnet is offered when a facilitator can settle it. The live 402
challenge always quotes the exact price for the pattern you asked for — read it,
don't hardcode.

Tier 1 and tier 3 **share one warehouse** — the `vanity_inventory` table,
pre-ground on batch spot CPU (`workers/vanity-grinder`) and auto-replenished
when stock runs low (`api/cron/vanity-inventory-replenish`, hourly). Tier 1 is
"give me anything that matches, right now"; tier 3 is "let me pick this exact
address from the catalog." [Pump Launcher](pump-launcher.md) draws from the
same warehouse for instant vanity mint addresses.

## Which agent uses this, and why us

A **token-launch bot** that wants its mint address to start with the ticker
(`PUMP…`, `DOGE…`). A **treasury/agent-wallet provisioner** that wants every
managed wallet recognizable at a glance. A **naming/branding service** an agent
calls mid-task to get an on-brand address as the payoff step. Grinding a vanity
key yourself means running an ed25519 miner, managing the output key, and burning
CPU you'd rather not. This collapses it into **one HTTP call priced in USDC** —
the currency an agent on Base or Solana already holds — and the key is delivered
once, over TLS, and never stored.

> **What can you actually match?** Base58 excludes `0`, `O`, `I`, `l`. An address
> is 32 random bytes Base58-encoded, so its **leading** character is not
> uniformly distributed: the 40 symbols from `K` to `z` are **~17× harder** to
> lead with than `2`-`H`, a 58× spread across the alphabet. Suffix characters
> *are* uniform at 1/58. Quotes, prices and rarity all use the exact
> distribution rather than a flat 58ⁿ estimate, so a `zebra…` prefix is priced
> as the genuinely harder grind it is, and an `Agent…` prefix is not overcharged.
> Each *additional* character still multiplies expected work by ~58, which is why
> the char caps and price ladder climb steeply. If a pattern cannot be found
> inside the request's time budget, the endpoint declines it up front with the
> real attempt count instead of grinding to a timeout.

---

## Tier 1 — live grinder

`GET /api/x402/vanity?prefix=<base58>&suffix=<base58>` first checks whether a
pre-ground address already matching your pattern is sitting in the premium
inventory. A hit is claimed atomically and delivered **instantly** — no grind
wait — at the exact same price as a live grind would have cost. A miss falls
straight through to grinding a brand-new Solana Ed25519 keypair in a Rust/WASM
engine (~25k keypairs/sec) under a 45-second budget. Either way the response's
`source` field says which path served you: `"inventory"` or `"ground"`.
Settlement runs **only after** a successful instant claim or grind, so a lost
race or an exhausted budget (rare) costs nothing and can be retried.

### Formats

- **`format=keypair`** (default) — returns the public `address` plus its secret
  key in two forms: `secretKeyBase58` (import into Phantom / Solflare) and
  `secretKey` (a 64-byte int array — save as a Solana CLI keypair JSON). Live
  grinding covers up to **3 Base58 chars**; **4–5 chars are offered too, but
  served ONLY from inventory** (see [Price ladder](#price-ladder)) — the server
  never attempts to grind that long live.
- **`format=mnemonic`** — returns a **BIP-39 seed phrase** (`strength=128` → 12
  words, default; `strength=256` → 24 words) whose derived key at
  `m/44'/501'/0'/0'` (Phantom's default path) lands on the vanity address.
  Importable as a recovery phrase into any wallet. Seed-phrase grinding runs
  ~100× slower (PBKDF2-HMAC-SHA512 per attempt), so it is capped at **2 chars**.

### Price ladder

Difficulty-tiered by combined prefix+suffix length (USDC, 6 decimals):

| Combined length | `keypair` | `mnemonic` | Fulfilled by |
| --- | --- | --- | --- |
| 1 char | $0.01 | $0.05 | instant if in stock, else ground |
| 2 chars | $0.05 | $0.50 | instant if in stock, else ground |
| 3 chars | $0.25 | — (capped at 2) | instant if in stock, else ground |
| 4 chars | $2.50 | — (not offered) | **inventory only** |
| 5 chars | $10.00 | — (not offered) | **inventory only** |

4–5 char patterns are quoted **only when a matching address is actually in
stock** — request one that isn't and you get a `404 not_in_stock` explaining
the grindable range instead of a 402 you could never redeem. Check
`GET /api/x402/vanity-premium?prefix=…` to see what's currently available.
Ops can override any tier: `X402_PRICE_VANITY_4` / `X402_PRICE_VANITY_5` (USDC
atomics) for the inventory-only band; the live 402 always quotes the exact
tier for the requested pattern.

### Inputs

| Param | Notes |
| --- | --- |
| `prefix` | Base58 chars the address must start with. Combined with `suffix`, ≤5 (keypair — 4–5 inventory-only) or ≤2 (mnemonic). |
| `suffix` | Base58 chars the address must end with. |
| `ignoreCase` | `1`/`true` matches the pattern case-insensitively (faster, less specific). |
| `format` | `keypair` (default) or `mnemonic`. |
| `strength` | Mnemonic only: `128` (12 words, default) or `256` (24 words). |
| `sealTo` | Optional X25519 public key (Base58/Base64url/hex), see [Security model](#security-model). Prefix with `base58:`, `base64url:` or `hex:` to be explicit; a bare 43-character string is a valid encoding under two of them and is rejected rather than guessed. Keys from our SDK's `generateRecipientKeypair()` are always unambiguous. |

### Example

<!-- runnable: 402 an unpaid call answers with the x402 challenge, which is the expected first response -->
```bash
# Grind an address starting with "So" (2-char keypair tier, $0.05).
# @x402/fetch handles the 402 → pay → retry handshake automatically.
curl "https://three.ws/api/x402/vanity?prefix=So"
```

```jsonc
{
  "address": "SoV3...",              // starts with your prefix
  "prefix": "So",
  "suffix": null,
  "format": "keypair",
  "secretKeyBase58": "…",            // the ground secret — capture it, it is never re-served
  "secretKey": [/* 64 bytes */],
  "mnemonic": null,
  "attempts": 3120,
  "durationMs": 140,
  "expectedAttempts": 3364,
  "network": "solana",
  "explorerUrl": "https://solscan.io/account/SoV3...",
  "source": "ground",                // or "inventory" — instant delivery from stock, same price
  "certificate": { /* signed proof-of-grind, contains no secret */ },
  "verifyUrl": "https://three.ws/vanity/verify"
}
```

Longer than 3 chars? A 4–5 char pattern is served if (and only if) it's in
stock — same endpoint, premium price, `source: "inventory"`. Out of stock gets
a `404 not_in_stock`; grind it yourself in the browser at
[`/vanity-wallet`](https://three.ws/vanity-wallet), or browse what IS available at
[premium inventory](#tier-3--premium-inventory).

### Security model

- **Nothing is ever stored.** The secret exists only in the response body, served
  once over TLS. The x402 replay/idempotency cache **strips** the plaintext secret
  from its stored copy — a replayed payment gets the public metadata plus an
  explicit "secret omitted, grind again" marker, never a spendable key.
- **`sealTo` (optional confidential delivery).** Supply your 32-byte X25519 public
  key and the secret is sealed to it with ECIES (`x25519-hkdf-sha256-aes256gcm`).
  The plaintext secret fields are then omitted entirely; you get a `sealedSecret`
  envelope you open client-side with the matching private key. The plaintext never
  appears in the response, a proxy log, or the cache.
- **Proof-of-grind certificate.** Every response carries a signed, offline-
  verifiable `certificate` (`three-pog/v1`) attesting the pattern, address,
  difficulty, and a freshness nonce — it contains **no secret**. Verify it at
  [`/vanity/verify`](https://three.ws/vanity/verify); the attestation public key is
  published at [`/.well-known/three-vanity.json`](https://three.ws/.well-known/three-vanity.json).

---

## Tier 2 — provably-fair grinder

`GET /api/x402/vanity-verifiable` is the trust-minimized sibling. Same pay-per-call
rails, but every key is ground under a **commit–reveal seed-mixing protocol**
(`three-vanity/v1`) and delivered with a **signed receipt** a buyer can verify
after the fact with open-source tooling — proving the key was generated fresh from
entropy the server committed to *before* it knew the result, that the buyer's own
`clientSeed` was mixed in, and that no copy was kept.

Because the verifier must reproduce the exact candidate stream, grinding walks a
deterministic pure-JS Ed25519 stream (slower than WASM), so it is capped at **3
chars** and priced $0.02–$0.40. `sealTo` is strongly recommended here. Verify with
`@three-ws/solana-agent`'s `verifyVanityReceipt()`, the CLI
(`scripts/verify-vanity-receipt.mjs`), or [`/vanity/verify`](https://three.ws/vanity/verify).

The full wire format is specified in [PROTOCOL-vanity.md](PROTOCOL-vanity.md).

---

## Tier 3 — premium inventory

`GET /api/x402/vanity-premium` is the **sell-from-stock** tier: long (4–5+ char)
brandable addresses ground ahead of time on batch CPU and held encrypted.

- **Browse** (free, no payment): `GET /api/x402/vanity-premium` with no `address`
  returns the available patterns, rarity tiers, and prices. Browsable in the UI at
  [`/vanity/premium`](https://three.ws/vanity/premium).
- **Buy**: `GET /api/x402/vanity-premium?address=<base58>` pays via x402. Price
  scales with grind difficulty ($1–$50). The key is delivered **exactly once** and
  its stored ciphertext is **destroyed on delivery** (delete-after-reveal) — three.ws
  cannot recover or re-send it. `sealTo` works here too.

> **Custody honesty (non-negotiable).** These keys were *generated by three.ws*,
> not by you. For anything of value, use a bought address as a **token mint
> address** or **sweep assets to a wallet you generated yourself** — do not use it
> as a long-term treasury. Every listing and delivery says this plainly.

**Restocking.** `api/cron/vanity-inventory-replenish` runs hourly, checks
available stock against a low-water mark (`VANITY_INVENTORY_LOW_WATERMARK`,
default 25), and fires the `workers/vanity-grinder` Cloud Run Job (via the
Cloud Run Admin API) when it's running low — plus sweeps any ciphertext past
its retention window. Trigger a batch manually any time with
`scripts/gcp/vanity-grind-deploy.sh --run` or `node
workers/vanity-grinder/grind.mjs` (see its
[README](../workers/vanity-grinder/README.md)).

**Pump Launcher upsell.** `POST /api/x402/pump-launch` with a `vanityPrefix` /
`vanitySuffix` checks this same inventory before grinding a mint address live —
a hit skips the grind entirely (`vanity_source: "inventory"` in the response),
a miss grinds as before (`vanity_source: "ground"`). Same one-shot claim, same
atomicity, no separate purchase step. See [pump-launcher.md](pump-launcher.md).

---

## How agents discover these

All three are paid x402 resources published in the discovery document at
[`/.well-known/x402.json`](https://three.ws/.well-known/x402.json) (served by
`api/wk.js`), so the CDP Bazaar / agentic.market and x402scan crawlers index them.
Each entry ships a complete input schema — an agent can grind an address from the
schema alone. Run `node scripts/verify-x402-discovery.mjs` to confirm the live 402
challenges and the discovery doc stay in parity.

## Related

- [x402 endpoints overview](x402-endpoints.md)
- [three-vanity/v1 protocol spec](PROTOCOL-vanity.md)
- [Pump Launcher](pump-launcher.md) — accepts an optional vanity mint prefix/suffix
- Web grinder + verifier: [`/vanity-wallet`](https://three.ws/vanity-wallet), [`/vanity/verify`](https://three.ws/vanity/verify)
