# Hold-to-Access — the $THREE demand lever

three.ws monetizes premium capability by **holding $THREE, not by spending it**. A
wallet's live USD value of $THREE resolves to a membership tier; tiers unlock fee
discounts, higher free quotas, and gated features. Holding removes float and rewards
bag size without depleting it — a deflation-free status lever that creates *standing*
demand rather than one-time spend.

This is the canonical reference for the system: the tier ladder, the enforcement
primitive, the perk registry, and the roadmap for activating the perks that are
registered but not yet enforced.

> The only coin this platform references is **$THREE**
> (`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`). Every threshold below is denominated
> in the USD value of $THREE held.

---

## The tier ladder

Resolved from the USD value a wallet currently holds of $THREE, priced live. Source of
truth: [`api/_lib/three-tier.js`](../api/_lib/three-tier.js).

| Level | Tier | Hold (USD) | Compute discount | Free-quota multiplier |
|------:|------|-----------:|-----------------:|----------------------:|
| 0 | Member | $0 | — | 1× |
| 1 | Bronze | $25 | 5% | 2× |
| 2 | Silver | $100 | 10% | 3× |
| 3 | Gold | $500 | 20% | 5× |
| 4 | Genesis | $2,500 | 30% | 10× |

A wallet that can't be priced (RPC/price hiccup) resolves to the **Member floor**, never
an error — a balance read must never block a charge.

---

## How resolution works

Three resolvers, picked by what the caller already knows:

| Resolver | I/O | Use |
|----------|-----|-----|
| `tierForUsd(usd)` | none (pure) | a level from a known USD value |
| `resolveUserTier(user)` | RPC + price | a session user's on-chain tier (degrades to Member) |
| `verifyTierPass(token)` | none (pure HMAC) | a presented signed pass — no RPC, zero latency |

**Signed tier passes** ([`signTierPass` / `verifyTierPass`](../api/_lib/three-tier.js))
seal a resolved `{ wallet, level, usd }` into a 10-minute HMAC token (`HOLDER_PASS_SECRET`).
A service that can't run a Solana RPC — the multiplayer/Colyseus server, an edge worker —
gates on the pass alone. Because the pass is pure-HMAC, a holder presenting one is **never
wrongly blocked during an RPC or price outage**.

---

## Enforcing a gate

One helper turns the registry into an actual gate:
[`requireFeatureAccess`](../api/_lib/require-three.js). It mirrors `cors()`/`method()`
semantics — on a blocked request it writes the response itself; on an allowed request it
writes nothing:

```js
import { requireFeatureAccess } from './_lib/require-three.js';

const gate = await requireFeatureAccess(req, res, 'forge.high', { body });
if (!gate.ok) return; // 402 three_hold_required already sent
// ...gate.access, gate.level, gate.wallet are available here
```

Resolution is **comp-first, then pass-first**: a comped account (below), then a signed
tier pass (header `x-three-tier-pass` or `body.tier_pass`), then the session user's
on-chain tier, then anonymous Member. Every failure degrades to Member: a clean 402,
never a 500.

### Comped accounts

Some accounts are exempt from the ladder entirely: the owner's own accounts, and
creators/partners granted lifetime access. They clear **every** gated feature with no
wallet, no holding, and no payment.

The allowlist is [`api/_lib/comp-access.js`](../api/_lib/comp-access.js), and it is the
only place the exemption lives, because `requireFeatureAccess` is the single keystone
every enforced gate resolves through, one entry covers `forge.high`, `forge.gameready`,
and any gate added later. `GET /api/three/access` applies it too, so the UI renders those
features unlocked rather than showing a lock the API would let straight through; that
response carries `tier.comped: true` to explain why a $0 holder reads as entitled.

```js
import { isCompedUser, resolveCompAccess } from './_lib/comp-access.js';

const { comped } = await resolveCompAccess(req);  // from a request (session-aware)
if (isCompedUser(user)) { /* from an already-resolved user */ }
```

Grant access by adding a handle to `COMPED_ACCOUNTS` in that module, or by setting
`THREE_COMP_ACCOUNTS` to a comma-separated list of handles / emails / user ids. Env
entries are **merged** with the built-ins, never replace them, so an env typo cannot
silently revoke a comp granted in code.

Three properties keep it safe and cheap:

- **Only unique identifiers count.** `username`, `email`, and `id` are uniquely indexed
  on `users`, as is the handle in a platform-issued `<handle>@users.three.ws.local`
  address (minted by `handleRegister` for username registrations, which leave the
  `username` column null). `display_name` is deliberately **not** matched, because it is
  user-settable and not unique, so honoring it would let anyone comp themselves by
  renaming.
- **Anonymous requests pay nothing.** The lookup is guarded by `hasSessionCookie()`, so a
  request with no session never issues a query and the zero-latency anonymous free lane
  is untouched.
- **It fails closed on the perk.** An auth or DB hiccup resolves to "not comped", which
  simply means the normal hold-or-pay gate applies. It never fails the request.

A comp also lifts the free-lane rate multiplier to the top tier (`api/forge.js`,
`api/gpt-forge.js`). It does **not** bypass BYOK (a caller's own vendor key is still
their own key), nor the platform-wide spend ceilings that protect real vendor budget.

### The hold-or-pay 402

A blocked request returns a structured `402 three_hold_required` carrying everything the
UI needs to recover — no second round-trip:

```jsonc
{
  "error": "three_hold_required",
  "message": "High-quality generation requires holding $THREE (Bronze+) — or pay per use.",
  "feature": "forge.high",
  "reason": "insufficient_tier",   // or sign_in | link_wallet
  "held":     { "level": 0, "id": "member", "usd": 12.50 },
  "required": { "level": 1, "id": "bronze", "min_usd": 25 },
  "usd_to_go": 12.50,
  "acquire": { "mint": "Fe…pump", "symbol": "THREE", "swap_url": "…", "pump_url": "…" },
  "pay_per_use": { "action": "forge.high", "usd": 0.49 }   // null when hold-only
}
```

A feature with a `payPerUse` action lets a non-holder pay once in $THREE instead of
holding. A hold-only feature omits `pay_per_use`.

---

## The perk registry

Source of truth: [`api/_lib/three-access.js`](../api/_lib/three-access.js). Each feature
maps to a minimum tier, a pay-per-use fallback (or `null`), and an **`enforced`** flag.

`enforced` is the integrity contract: it is `true` only when the gate is **wired and live
in the product** — a request for it is actually checked. `false` means the perk is
registered/planned but not enforced anywhere. The `/three` page reads this flag to mark a
feature **Live** vs **Planned**, so the platform never promises an unwired perk.

| Feature | Min tier | Status | Pay-per-use | Backend |
|---------|----------|--------|-------------|---------|
| `forge.high` — High-quality generation (200k poly + PBR) | Bronze | **Live** | yes | [`api/forge.js`](../api/forge.js) |
| `forge.gameready` — Game-ready export (Unity/Unreal) | Bronze | **Live** | yes | [`api/forge-gameready.js`](../api/forge-gameready.js) |
| `worlds.private` — Private, invite-only worlds | Silver | Planned | — | partial (no visibility dim yet) |
| `mcp.priority` — Priority MCP routing | Silver | Planned | — | not built (no shared queue) |
| `worlds.branded` — Branded worlds + custom environments | Gold | Planned | — | not built |
| `drops.early` — Early access to drops | Gold | Planned | — | drop endpoints exist |
| `names.first_dibs` — First dibs on rare `*.threews.sol` | Genesis | Planned | `name.auction` | SNS exists |

### Adjacent levers (live, not feature-gated)

- **Compute discount** — every fixed-price action is re-priced by the holder's
  `discountBps` in [`api/pricing.js`](../api/pricing.js) (`personalizedActions`).
- **Free-quota multiplier** — a verified tier pass lifts the anonymous free-generation
  ceiling by `rateMultiplier` in [`api/forge.js`](../api/forge.js) (`freeLaneMultiplier`),
  zero added latency.
- **Charged-at tier on `/credits`**: every credit debit already applies the discount, and
  `GET /api/credits` reports the caller's resolved tier as `holder` (the same shape
  `/api/pricing` returns, degrading to `null` on an RPC hiccup rather than failing the
  balance read), so the [`/credits`](../pages/credits.html) page shows the tier you are
  actually being charged at and the next one up.

---

## Proving a holding from the browser

The server only ever sees what the page sends it, so a gated surface that mints its proof
from the wrong identity charges holders. **[`src/three-access.js`](../src/three-access.js)
is the one client module a gated surface may use.** It resolves both identities a holder
can arrive with:

| Identity | How the pass is minted | Prompt? |
|----------|------------------------|---------|
| Signed in, wallet linked to the account | `POST /api/three/tier-pass` with the session cookie | silent |
| Wallet connected, no account (Phantom, Seeker) | signs a domain-bound message, `POST { wallet, message, signature }` | one free signature |

Wire a gated request in three steps:

```js
import { getAccess, getTierPass, attachTierPass } from './three-access.js';

const { access } = (await getAccess('forge.gameready', { fresh: true })) || {};
// Interactive only when the read says this identity is eligible, so a non-holder is
// never asked to sign for something that could not unlock anything.
await getTierPass({ interactive: Boolean(access?.eligible) });
const res = await fetch('/api/forge-gameready', {
  method: 'POST',
  headers: attachTierPass({ 'content-type': 'application/json' }),
  body: JSON.stringify(payload),
});
```

Rules that keep the two identities from drifting apart:

- **Mint before the request, not on page load.** A pass lives 10 minutes; minting at the
  moment of the gated call is what guarantees the header is fresh.
- **Read access with `{ fresh: true }`, and re-read on `wallet:changed`.** Connecting or
  switching a wallet changes who is asking; the cached matrix is then the wrong identity's.
- **Never gate the UI on the client's answer.** The server is the only authority; the
  client read exists so the surface can state the viewer's real price up front instead of
  a generic pitch.

`src/three-tier-pass.js` is the earlier, session-only helper. It backs `<three-gate>`'s
access read and mints nothing for a connected wallet, so a surface that uses it to build
headers silently bills every account-less holder. Do not use it for a new gated request.

---

## Activation roadmap

Goal: **drive $THREE demand** by activating registered-but-dormant perks. A perk is only
worth gating when its backend genuinely exists — wiring a gate onto a missing feature
would be a fake perk, exactly what `enforced` guards against.

Priority order by demand value × backend readiness:

1. **`worlds.private` (Silver)** — strongest *standing-hold* lever: a persistent private
   space you keep only while you hold Silver. Backend closest to ready. **Spec below.**
2. **`names.first_dibs` (Genesis)** — window-gate the `*.threews.sol` auction so Genesis
   holders get a head start. SNS backend exists ([`api/sns.js`](../api/sns.js)).
3. **`drops.early` (Gold)** — time-gate the existing drop endpoints
   ([`api/irl/drops.js`](../api/irl/drops.js), [`api/vanity/drops.js`](../api/vanity/drops.js))
   so Gold holders enter the window early.
4. **`mcp.priority`, `worlds.branded`** — deferred: no backend (shared MCP queue / custom
   environments) exists to gate. Build the feature first, then the gate.

Each activation is the same shape: add the gate call, flip `enforced: true`, add a gate
test mirroring `tests/forge-high-gate.test.js`, add a changelog entry. Nothing else
changes — the access endpoint and `/three` pick it up automatically.

---

## Spec: `worlds.private` (first activation)

Today worlds are **owner-based with no visibility concept**
([`api/_lib/world-store.js`](../api/_lib/world-store.js),
[`api/world/[action].js`](../api/world/[action].js)). A world's doc is readable by anyone
with its id. Making "private" a real perk means adding a visibility dimension and
enforcing it on read.

**1. Schema** — migration `api/_lib/migrations/2026-06-24-world-visibility.sql`:

```sql
ALTER TABLE world_docs ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'public';
```

Thread `visibility` through `world-store.js` `saveWorld` / `loadWorld` and the returned
shape. Default `'public'` so every existing world is untouched.

**2. Create gate** — in `api/world/[action].js` `handleSave`, when a write sets
`visibility: 'private'`:

```js
const gate = await requireFeatureAccess(req, res, 'worlds.private', { body });
if (!gate.ok) return; // 402 three_hold_required (hold-only, Silver+)
```

Hold-only (no pay-per-use) — a private world is a held perk, not a per-call cost.

**3. Load enforcement** — in `handleLoad`, a `private` world's doc is returned only to its
owner (or a service-token writer); any other caller gets `403 forbidden`. This is the step
that makes the perk *real* rather than a label.

**4. Activate** — flip `enforced: true` on `worlds.private` in
[`three-access.js`](../api/_lib/three-access.js). `/three` auto-flips it to **Live**.

**5. Test** — `tests/world-private-gate.test.js`: non-holder blocked with a 402 on
private create; Silver holder allowed; private-world load forbidden to a stranger; public
worlds unaffected.

**6. UI** — a visibility toggle in the world builder, defaulting to public.

**7. Changelog** — a `feature` entry in `data/changelog.json`.

---

## Configuration

| Env var | Required | Purpose |
|---------|----------|---------|
| `HOLDER_PASS_SECRET` | prod | HMAC key for signing/verifying tier passes |
| `THREE_COMP_ACCOUNTS` | no | extra comped handles / emails / user ids, comma-separated (merged with the built-in allowlist) |
| `THREE_TOKEN_MINT` | — | $THREE mint (defaults to the canonical CA) |
| `THREE_TOKEN_DECIMALS` | — | token decimals (default 6) |
| `SOLANA_RPC_URL` (+ provider keys) | — | RPC for on-chain balance reads (see `solana/connection.js`) |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | — | caches balance/tier lookups (optional, fail-safe) |

---

## Related

- [Validation](./validation.md) — the quality gate every model passes before publish.
- [Pricing catalog](../api/_lib/pricing/catalog.js) — fixed-price actions the discount applies to.
- [`/three`](../pages/three.html) — the holder-facing tier page that surfaces this ladder.
