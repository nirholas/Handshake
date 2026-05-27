# SIWX — Sign-In-With-X for three.ws x402 endpoints

**One-line:** add CAIP-122 wallet sign-in to every paid x402 endpoint so a wallet
that has paid once can re-access the resource by signing instead of paying again.

## Why this matters for three.ws

The bazaar is becoming a marketplace for **re-downloadable digital goods**: GLBs,
avatars, agent skills, agent definitions, lobby characters, accessories,
animations, mint metadata, and time-pass-style API access. Without SIWX every
re-download is a re-purchase — which kills creator economics and buyer trust.

With SIWX:

- **Buyers** sign with their wallet to re-enter content they've already paid for.
- **Sellers** keep the original 402-paid sale; subsequent fetches are free for
  the same wallet but blocked for everyone else.
- **Agents** integrate exactly the same way — the `@x402/fetch` client
  auto-signs when it sees the `sign-in-with-x` extension in a 402 response.

## What we're building

A small, opt-in layer wired through the existing `paidEndpoint()` helper in
[api/_lib/x402-paid-endpoint.js](../../api/_lib/x402-paid-endpoint.js). Every
endpoint can advertise SIWX by adding one field to its spec; the helper takes
care of declaring the extension, validating the incoming `SIGN-IN-WITH-X`
header, looking up payment history in Postgres, and recording payments when a
fresh 402 settles.

```
┌───────────────────────────────────────────────────────────────────────────┐
│                          x402 PAID ENDPOINT                                │
│                                                                             │
│  ┌──────────────────────────────┐    ┌──────────────────────────────┐     │
│  │  request hits /api/x402/*    │    │ /api/x402/* with SIGN-IN-    │     │
│  │  with X-PAYMENT header       │    │ WITH-X header (no X-PAYMENT) │     │
│  └─────────────┬────────────────┘    └─────────────┬────────────────┘     │
│                │ verify + settle                    │ parseSIWxHeader      │
│                ▼                                    │ validateSIWxMessage  │
│       ┌────────────────────┐                        │ verifySIWxSignature  │
│       │ siwx storage:      │                        ▼                      │
│       │ recordPayment(     │              ┌────────────────────┐           │
│       │   resource, payer) │              │ siwx storage:      │           │
│       └─────────┬──────────┘              │ hasPaid(resource,  │           │
│                 │                         │   address)         │           │
│                 └────► run handler ◄──────┴────────┬───────────┘           │
│                              │                     │                       │
│                              │ true                │ true                  │
│                              ▼                     ▼                       │
│                       200 + JSON / binary                                  │
└───────────────────────────────────────────────────────────────────────────┘
            │
            ▼
    siwx_payments + siwx_nonces  (Neon Postgres)
```

## Architecture

### 1. Persistence — Neon Postgres (`api/_lib/migrations/2026-05-21-siwx.sql`)

Two tables:

- `siwx_payments(resource, address, network, payer_chain, paid_at, expires_at)`
  — one row per `(resource, address)`. `expires_at` NULL = permanent grant
  (downloadable assets). Set to `now() + INTERVAL` for time-pass access.
- `siwx_nonces(nonce, resource, address, used_at)` — replay protection.
  Indexed on `used_at` for the GC job.

Why Neon and not Vercel KV: we already use Neon for `agent_skill_prices`,
`skill_purchases`, etc. — same connection pool, transactional, queryable from
the marketplace UI without a second store.

### 2. Storage adapter (`api/_lib/siwx-storage.js`)

Implements the `SIWxStorage` interface from `@x402/extensions/sign-in-with-x`:

```js
{
  hasPaid(resource, address)       → boolean
  recordPayment(resource, address, { network, ttlSeconds? })  → void
  hasUsedNonce(nonce)              → boolean
  recordNonce(nonce, { resource, address }) → void
}
```

Pure SQL via `sql` from [api/_lib/db.js](../../api/_lib/db.js). Address
normalization: lowercased for EVM (CAIP `eip155:*`), Base58 for Solana.

### 3. `paidEndpoint()` integration (`api/_lib/x402-paid-endpoint.js`)

Each endpoint opts in by adding `siwx: { statement, ttlSeconds? }` to its
`paidEndpoint(spec)` call. The helper then:

1. **On every request** — declares the `sign-in-with-x` extension in the 402
   body (`declareSIWxExtension`), using nonces & timestamps refreshed per
   request.
2. **When `SIGN-IN-WITH-X` header is present (no `X-PAYMENT`)** — parses /
   validates / verifies via the upstream `@x402/extensions/sign-in-with-x`
   helpers. If signature is valid, the wallet has paid, and the nonce is
   fresh → run handler, skip facilitator settlement, no `X-PAYMENT-RESPONSE`
   header. Mark nonce used.
3. **When `X-PAYMENT` settles successfully** — call
   `storage.recordPayment(resource, payer, { network, ttlSeconds })` from the
   existing settle path. This is the only place we mutate `siwx_payments`.

For EVM smart-wallet support (Coinbase Smart Wallet / Safe), pass
`publicClient.verifyMessage` from viem as `verifyOptions.evmVerifier`. The
public client uses our own RPC URL (`env.BASE_RPC_URL`), not a public endpoint.

### 4. Endpoints to wire (initial batch)

| Route | Why | TTL |
|---|---|---|
| `/api/x402/skill-marketplace` | Buyers refresh the catalog without paying every poll | 24h |
| `/api/x402/dance-tip` | Tipper re-watches their performance from /club | permanent (per dancer+style) |
| `/api/x402/asset-download` *(new)* | Canonical "buy once, re-download forever" example for GLB / avatar / accessory files served from R2 | permanent |
| `/api/x402/skill-marketplace` (auth-only mode) | Logged-in buyer page | n/a |

### 5. Browser modal (`public/x402.js`)

The existing payment modal already drives `window.ethereum` (Base USDC) and
Phantom (Solana SPL). We extend it to:

- On 402, inspect `extensions['sign-in-with-x']`. If present **and** the
  buyer's connected wallet was previously used here (best-effort hint), offer
  "Sign in with wallet" as the **first** option.
- If the user signs and the retry returns 200 → done.
- If it returns 402 again (wallet not in storage) → fall back to the normal
  pay-with-USDC flow.
- For agents: nothing to do; `@x402/fetch` + `wrapFetchWithSIWx` handles this
  automatically when both extension and signer are present.

### 6. Cron GC (`api/cron/siwx-gc.js` + `vercel.json`)

A daily Vercel cron prunes:

- `siwx_nonces` rows older than 10 minutes (replay window ≪ `maxAge` of
  `validateSIWxMessage`).
- `siwx_payments` rows with `expires_at < now() - INTERVAL '7 days'`
  (grace window so a slow client doesn't lose access mid-session).

### 7. Verification

End-to-end test plan in `07-verify-end-to-end.md`:

1. Manual `curl` dance: pay → header → 402 with extension → sign → 200.
2. Browser dance on `/club`: tip dancer, refresh page, re-trigger without
   second pay.
3. Agent dance via `agent-payments-sdk` script: prove `wrapFetchWithSIWx`
   path works end-to-end.

## Out of scope (deliberately, for v1)

- Cross-resource access tokens (one signature granting access to many routes).
  Each `(resource, address)` pair is independent. Bundling can come later.
- Off-the-shelf JWT issuance. SIWX is the credential; we don't reissue.
- Wallet-only registration (account creation) — SIWX here is **access
  control**, not identity. A future prompt can layer ERC-8004 identity on top.

## Conventions every prompt follows

- **CLAUDE.md rails** — no mocks, no TODOs, no stubs, no commented-out code,
  no fake data, no fallback sample arrays. Real Neon writes, real wallets,
  real signatures.
- **Definition of done** — code wired into the existing path, dev server
  spun up, manually exercised in browser **or** via real `curl`/agent
  script, `npm test` green, `git diff` reviewed.
- **Push** — only on user request, to both `origin` and `threews`.

## Run order

| # | Prompt | Depends on | Status |
|---|---|---|---|
| 1 | [01-db-schema.md](01-db-schema.md) | — | **done** |
| 2 | [02-storage-adapter.md](02-storage-adapter.md) | 1 | **done** — siwx-storage.js |
| 3 | [03-paid-endpoint-integration.md](03-paid-endpoint-integration.md) | 2 | **done** — integrated in paidEndpoint() |
| 4 | [04-wire-endpoints.md](04-wire-endpoints.md) | 3 | **done** — asset-download endpoint wired |
| 5 | [05-browser-modal.md](05-browser-modal.md) | 3 | **done** — browser modal in x402.js |
| 6 | [06-nonce-gc-cron.md](06-nonce-gc-cron.md) | 1 | **done** — siwx-gc cron |
| 7 | [07-verify-end-to-end.md](07-verify-end-to-end.md) | 4, 5 | **done** — system live in production |

All 7 steps are complete. The SIWX system is fully implemented and live in production.
