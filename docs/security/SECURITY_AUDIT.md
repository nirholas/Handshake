# three.ws Security Audit — 2026-06-18

_Historical record: a point-in-time audit of the code as it stood on 2026-06-18. Some environment references predate the 2026-07-07 move to Google Cloud Run and are preserved as written; for current infrastructure see [docs/ops/gcp-production.md](../ops/gcp-production.md). `vercel.json` remains the server's live route/cron config, read by `server/index.mjs` at runtime._

A full-surface security review of the three.ws monorepo: 93 serverless API
functions (`api/`), Cloudflare workers (`workers/`), the frontend (`src/`,
`pages/`, `public/`), the vendored `character-studio` fork, on-chain Anchor +
Solidity contracts (`contracts/`), payment/x402 flows, and dependency hygiene.

Five independent audits were run in parallel (auth/authz, secrets/keys,
injection/SSRF/XSS, payments/x402/Solana, headers/CSP/CORS/deps). Findings below
were verified against source by reading the actual code paths, not pattern
matching alone.

## How to read this

- **Severity** uses Critical / High / Medium / Low.
- Each item lists the file:line, the concrete attack, and the remediation.
- **Status** tracks remediation: `fixed`, `mitigated`, `tracked` (scheduled,
  e.g. breaking dep bumps), or `open`.

## Overall posture

The platform is, on balance, **well defended**. The money-moving core is the
strongest part of the codebase: x402 payment verification independently decodes
signed transfer amount/recipient/mint server-side before trusting any
facilitator, has an always-on replay guard, and the $THREE quote→settle path
uses HMAC-signed quotes with timing-safe comparison, on-chain memo binding, and
unique-nonce/tx replay protection. Custodial signing paths verify agent
ownership before decrypting keys. CORS never combines wildcard origin with
credentials. Cookies are HttpOnly+Secure+SameSite. CSRF is a single-use,
user-bound, DB-backed double-submit system.

The findings concentrate in five areas: **SSRF via on-chain-controlled URLs that
bypass the existing SSRF guard**, **two stored-XSS sinks**, **concurrency races
on spend caps / idempotency / OAuth code consumption (TOCTOU)**, **a few
unauthenticated or unthrottled expensive endpoints**, and **header/CSP +
dependency hardening**.

---

## Critical

### C1 — Dependency vulnerabilities: 3 critical, 49 high
`npm audit` (root): `{critical: 3, high: 49, moderate: 68, low: 55, total: 175}`.

- `vitest` UI server arbitrary file read/exec (dev-only) — non-breaking fix.
- `form-data` unsafe boundary + CRLF injection, via `aptos` →
  `@metaplex-foundation/js` — needs breaking bump to `@metaplex-foundation/js@0.19.5`.
- `axios <=0.31.1` (via `aptos`): SSRF, credential leak on redirect, prototype
  pollution, cloud-metadata exfil — same breaking bump.
- No-fix transitive cluster: `undici`, `bigint-buffer`, `@solana/spl-token`,
  `@solana/buffer-layout-utils` — track upstream.

**Remediation:** `npm audit fix --omit=dev` clears ~16 advisories (175 → 159) via
semver-compatible bumps, but in this monorepo it also reformats ~57k lines of
`package-lock.json` (npm version skew) — an unreviewable diff that conflicts with
concurrent work. So dependency bumps are deliberately **isolated to their own PR**:
run `npm audit fix --omit=dev` on a clean branch, review, and land separately.
The `@metaplex-foundation/js@0.19.5` breaking bump (clears axios/form-data/aptos)
and the no-fix Solana cluster (`undici`, `bigint-buffer`, `@solana/spl-token`)
are tracked upstream. **Status: tracked (isolated dependency PR) — command
verified to reduce counts; not bundled into this security changeset.**

---

## High

### H1 — Unauthenticated SSRF via on-chain agent manifest fetch
`api/_lib/onchain.js:315` (sink), reached unauthenticated via
`api/v1/agents/[caip].js:54` → returns body at `:84`.

`resolveURI` passes any `http(s)://` `tokenURI` through verbatim. Anyone can
register an ERC-8004 agent NFT and point its `tokenURI` at
`http://169.254.169.254/...` (cloud metadata) or `http://localhost:...`. The
public `[caip]` endpoint fetches it and returns the JSON in `card`. Full-read
SSRF, unauthenticated.

**Remediation:** route `tokenURIResolved` (and the card-model fetch, M-INJ-1)
through `assertSafePublicUrl`/`fetchSafePublicUrl` (`api/_lib/ssrf-guard.js`)
with `allowHttp:true`. One fix covers all callers of `resolveOnChainAgent`.
**Status: fixed.**

### H2 — Stored XSS: validator report renders attacker-authored GLB metadata
`src/components/validator-report.jsx:88,94,100` → `src/validation-page.js:193`
(`innerHTML`). Uses `vhtml`'s `dangerouslySetInnerHTML`, which copies `__html`
verbatim (no escaping). `info.extras.author/license/source` come from an
uploaded GLB's `asset.extras` (fully attacker-authored). Payload:
`<img src=x onerror=...>` in `author`.

**Remediation:** render as text children (`{info.extras.author}`); vhtml escapes
interpolated children. **Status: fixed.**

### H3 — Stored XSS: admin user panel renders user-set fields unescaped
`public/admin/index.html:289-290,338,340` (and error banners `:195,280,328`).
`display_name`/`email` are user-supplied and interpolated into `innerHTML`.
Fires in the **admin's** authenticated session → privilege escalation.

**Remediation:** add an `escapeHtml` helper and wrap every interpolated
user/remote field. **Status: fixed.**

### H4 — Avatar IDOR: private GLBs resolvable by id, bypassing visibility check
`api/avatar/optimize.js:72-76` (no auth, no rate limit) and
`api/avatar/video-generate.js:76-88` (auth, no ownership check). Both resolve
`avatars` by `id` alone, bypassing the canonical `getAvatar({id, requesterId})`
helper (`_lib/avatars.js:78`) that enforces `visibility='private'` ownership.
Anyone with a private avatar UUID downloads the source model (optimize) or runs
paid GPU video-gen against it (video-generate).

**Remediation:** resolve through `getAvatar` with the requester id; add a per-IP
limiter to `optimize`. **Status: fixed.**

### H5 — billing/withdrawals records an attacker-controlled payout destination
`api/billing/withdrawals/index.js:12-18,116-139`. `to_address` is taken from the
request body (format-validated only) and persisted into `agent_withdrawals`,
which the admin processor pays out verbatim. The sibling
`monetization/withdrawals.js` correctly ignores client addresses and resolves
the destination from the user's saved `agent_payout_wallets`.

**Remediation:** drop `to_address` from the body; resolve from
`agent_payout_wallets WHERE user_id` (422 if none registered). **Status: fixed.**

### H6 — OAuth authorization-code consumption is not atomic (TOCTOU)
`api/oauth/[action].js:164-176`. `consumed_at` check and the `UPDATE` are
separate statements; two concurrent token requests with the same code + valid
PKCE verifier can both mint refresh-token chains from one single-use code.

**Remediation:** consume atomically:
`UPDATE oauth_auth_codes SET consumed_at=now() WHERE code=$1 AND consumed_at IS NULL RETURNING *`;
a missing row → `invalid_grant` + revoke the chain. **Status: fixed.**

### H7 — pump-fun-mcp: one payment settles an entire batch (pay-once-run-many) + bearer-presence auth + SSRF
`api/pump-fun-mcp.js` — a JSON-RPC batch of up to 16 gated `tools/call` settles
payment once (`settlePayment` invoked once per request); any valid bearer
bypasses payment with no scope check; `handleUploadMetadata` fetches a fully
attacker-supplied `image_url` with no SSRF guard.

**Remediation:** settle per gated call (or reject single-payment batches with >1
gated call); gate the bearer bypass on a specific scope; route the image fetch
through the SSRF guard. **Status: fixed.**

### H8 — Custodial wallet keys encrypted with `JWT_SECRET`
`api/_lib/agent-wallet.js:18-33`. The AES-256-GCM key encrypting every agent's
EVM+Solana private key derives solely from `JWT_SECRET` with a constant salt.
`JWT_SECRET` is the highest-circulation secret (every session/bearer check), so
a single disclosure decrypts all custodial wallets; rotating it to invalidate
sessions would brick every wallet.

**Remediation:** dedicated `WALLET_ENCRYPTION_KEY` independent of `JWT_SECRET`,
random per-record salt stored with ciphertext, dual-read during migration so
existing records keep decrypting. **Status: fixed (dual-read; new writes use the
dedicated key).**

### H9 — USD daily spend cap is read-then-write (TOCTOU)
`api/_lib/agent-trade-guards.js:409-421,471-482`; enforced in
`api/x402-pay.js:560-576` then recorded after settle. K parallel calls read the
same pre-spend daily total, all pass, all settle → cap×K. The repo already
solved this for SOL outflow (`agent-spend-policy.js reserveSpend`, advisory lock
+ conditional insert); the USD cap wasn't given the same treatment.

**Remediation:** reserve atomically under `pg_advisory_xact_lock` before signing;
finalize after settle; make the ledger write awaited/fail-closed.
**Status: fixed.**

### H10 — VITE_PINATA_API_SECRET embedded in client bundle (character-studio fork)
`character-studio/src/library/mint-utils.js:16-17` (+ OpenSea/Helius/Alchemy
keys). Vite inlines `VITE_`-prefixed vars into the browser bundle. A Pinata
*secret* in the `/avatar-studio` build is world-readable. No hardcoded values
today (env-referenced, `.env.example` empty) — a latent footgun gated on the
build env.

**Remediation:** move Pinata uploads behind a server endpoint; remove
`VITE_PINATA_API_SECRET` from client code; proxy/referrer-lock RPC keys; audit +
rotate any value ever set in the `/avatar-studio` build env. **Status: fixed
(client secret path removed / proxied).**

### H11 — Site-wide clickjacking: global CSP `frame-ancestors *`, no X-Frame-Options
`vercel.json:198-204`. The global `(.*)` route sets `frame-ancestors *` and no
`X-Frame-Options`. Only a narrow allowlist of auth paths downgrades to `'self'`.
Every other page (dashboard variants, agent profiles, launch feed) is framable
by any attacker → UI-redress on wallet/trade/launch actions.

**Remediation:** global default `frame-ancestors 'self'` + `X-Frame-Options:
SAMEORIGIN`; keep explicit `*` only on genuine embed/OG/widget routes.
**Status: fixed.**

### H12 — CSP `script-src` allows `'unsafe-inline'` and `'unsafe-eval'`
`vercel.json:202,209`. Neutralizes CSP's primary XSS mitigation; wide CDN
allowlist multiplies supply-chain exposure.

**Remediation:** move toward nonce/hash inline allowance; scope `'unsafe-eval'`
to the routes that genuinely need WASM/shader compilation; trim the CDN
allowlist; remove the duplicate `https://three.ws`. **Status: partially fixed
(CDN trim + dedupe + scope); nonce migration tracked.**

### H13 — Wildcard CORS on ~25 authenticated handlers
Hand-rolled `Access-Control-Allow-Origin: *` on session-authenticated handlers.
Not currently credential-exploitable (no handler sets `*` + credentials), but
fragile: adding `credentials:true` next to a `*` later silently becomes a full
account-data CORS leak.

**Remediation:** route authenticated handlers through the shared allowlisted
`cors()` helper (`api/_lib/http.js:212`); reserve `*` for genuinely public
read-only assets. **Status: fixed (audited + migrated authenticated handlers).**

---

## Medium

- **M1 — SSRF (blind) card-model verification** `api/v1/agents/[caip].js:108`.
  Same guard as H1. **Status: fixed.**
- **M2 — SSRF (blind) erc8004 register-confirm** `api/erc8004/register-confirm.js:168`;
  `metadataUri` from body, never cross-checked against the on-chain event. Guard
  + verify against `agent_uri`. **Status: fixed.**
- **M3 — oracle/social.js broken limiter** `api/oracle/social.js:62` uses
  undefined `limits.moderate` → always-429 dead endpoint that becomes an open
  anonymous write the moment it's "fixed" naively. Wire a real `oracleSocialIp`
  bucket. **Status: fixed.**
- **M4 — ibm/attest.js `submit:true` broadcasts on-chain tx with no auth**
  `api/ibm/attest.js:476-512`; drains the shared wallet via fees. Require
  auth + distributed daily ceiling. **Status: fixed.**
- **M5 — persona LLM endpoints have no rate limit** `api/persona/extract.js`,
  `api/persona/preview.js`; unbounded LLM bill. Wire `limits.personaExtract`.
  **Status: fixed.**
- **M6 — pump-fun-mcp no per-principal rate limit on expensive tools.** Add
  per-principal critical limiters. **Status: fixed.**
- **M7 — permissions/redeem spend cap non-atomic (TOCTOU) + IP-keyed limiter**
  `api/permissions/[action].js:808-881`. Reserve atomically; per-principal
  critical limiter. **Status: fixed.**
- **M8 — OAuth introspection/revocation unauthenticated for public clients**
  `api/oauth/[action].js:233-276`; token-validity/`sub`/`scope` oracle. Require
  client auth regardless of type; rate-limit both. **Status: fixed.**
- **M9 — forever/inscribe.js unauthenticated + unthrottled paid 3rd-party call**
  `api/forever/inscribe.js:155-206`. Require auth + per-IP limiter.
  **Status: fixed.**
- **M10 — x402 idempotency TOCTOU → double-settle/deliver**
  `api/_lib/x402/idempotency-cache.js:117-129` (plain `set`, no NX). Reserve with
  `SET NX EX` before verify/settle. **Status: fixed.**
- **M11 — pay-by-name SNS recipient poisoning / re-resolve TOCTOU**
  `api/x402/pay-by-name.js:96-108,233`. Bind previewed address into the signed
  request; assert re-resolution matches; on-curve check; route `handleSend`
  through `enforceSpendLimit`. **Status: fixed.**
- **M12 — buyer spending-cap trusts payee-supplied decimals/name**
  `api/_lib/x402-spending-price.js:86-107`. Derive decimals/asset from the
  on-chain mint, not payee `extra`. **Status: fixed.**
- **M13 — triggerSkillPayment EVM spend bypasses custody cap**
  `api/_lib/agent-wallet.js:222-316`. Route through `enforceSpendLimit`; validate
  `author_wallet` shape. **Status: fixed.**
- **M14 — no global Permissions-Policy** `vercel.json:198-203`. Add a restrictive
  default. **Status: fixed.**
- **M15 — missing CSRF on cookie-auth mutations** (notifications, dashboard prefs,
  friends, payout-wallets DELETE, avatars/widgets PATCH/DELETE). Not exploitable
  today (`SameSite=Lax`, user-scoped) but inconsistent. Add bearer-exempt
  `requireCsrf`. **Status: fixed.**

---

## Low

- **L1 — admin error banners interpolate remote `error_description`** (covered by
  H3 fix). **Status: fixed.**
- **L2 — ThreeWSPayments.sol ignores transfer return values**
  `contracts/ThreeWSPayments.sol:55,62`. Use `SafeERC20`/`require(success)`.
  Off-chain boundary independently re-verifies the event, so impact is limited.
  **Status: fixed.**
- **L3 — Helius webhook length-leaking compare + no replay window**
  `api/pump/helius-webhook.js:24-37`. Pad-then-compare; add timestamp skew window.
  **Status: fixed.**
- **L4 — avatar demo wallet arbitrary-recipient drain in default config**
  `api/agent/send-sol.js`, `api/_lib/avatar-wallet.js`. Default
  `lockRecipient=true`. **Status: fixed.**
- **L5 — oracle/follow.js IDOR by unverified Telegram chat_id.** Bind to a
  `/start`-issued token. **Status: fixed.**
- **L6 — play/builds.js anonymous featured-build publish.** Require a valid
  play-pass for the mint. **Status: fixed.**
- **L7 — chat/config.js non-constant-time admin key compare.** Use
  `constantTimeEquals`. **Status: fixed.**
- **L8 — widgets/view.js anonymous counter inflation.** Validate id + limiter.
  **Status: fixed.**
- **L9 — agents/solana-trade.js weaker per-IP limiter** vs twin's `tradePerUser`.
  Gate on `tradePerUser`. **Status: fixed.**
- **L10 — render/glb.js + render/avatar-clip.js per-process limiter.** Use shared
  Upstash limiter. **Status: fixed.**

---

## Verified safe (checked, not issues)

Custodial withdraw/trade/send ownership checks; x402 `verifyPayment` + replay
guard; $THREE quote→settle HMAC + memo binding + unique-nonce/tx replay; pump
buy/sell/launch/withdraw on-chain confirm + signature dedupe; `requireAdmin` on
all `api/admin/*`; cron `requireCron` fail-closed constant-time; inbound webhooks
(`replicate` HMAC+5-min window, `solana-pay` padded constant-time) verified; GPU
workers timing-safe shared bearer; parameterized SQL throughout; no
`child_process` in the request tier; path-traversal sinks locked down; Anchor
programs PDA/signer/owner constrained; cookies HttpOnly+Secure+SameSite; CSRF
single-use user-bound; CORS never `*`+credentials.

---

## Remediation tracking

See the checklist in [SECURITY_REMEDIATION.md](SECURITY_REMEDIATION.md) for the
ordered fix plan and status of each item above.
