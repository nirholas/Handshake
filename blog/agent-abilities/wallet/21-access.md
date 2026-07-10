# 21 · Access

> Put every bot on a leash: mint tight, revocable spending keys so no strategy ever touches more of your agent's wallet than you allow.

## What it does

The Access tab is where a wallet owner hands out least-privilege spending keys instead of full wallet authority. Each key says exactly what its holder may do — which actions (trade, snipe, or pay services), how much per use, how much in total, on which specific tokens, services, or destinations, and for how long — and nothing else. Every key shows a live budget meter and expiry countdown, and can be killed instantly, alone or all at once. Flip on strict mode and the wallet denies any autonomous spend that doesn't present a covering key.

## How it works

Every key is a server-enforced policy grant stored in the platform database — the wallet's private key is never delegated. Each grant is signed with an HMAC over its immutable scope and re-verified on every single use, so a tampered or forged grant fails its integrity check and is rejected. Spending against a key is metered through the same custody ledger that backs the wallet's daily limit, and each check-and-reserve happens as one atomic database statement under advisory locks, so concurrent spends can never race past a budget and a revoke takes effect on the very next spend. The gate is composed into the shared spend guards that every autonomous path — trading, sniping, and x402 service payments — must pass, and a key can only ever narrow what the wallet-wide policy already allows.

## Every feature

- Mint form: create a scoped key with a custom label describing who holds it
- Allowed-actions picker with three checkboxes: Trade, Snipe, Pay services (x402)
- Max-per-use USD spend ceiling (optional)
- Total lifetime USD budget ceiling (optional)
- Expiry presets: 1 hour, 6 hours, 24 hours (default), 7 days, 30 days — server accepts any TTL from 60 seconds up to 1 year
- Target restriction modes: Any target, Specific mints, Specific services, Specific destinations
- Multi-line target allowlist input (one per line, up to 50 targets); service entries are normalized to bare hostnames so a pasted full URL still matches
- Validation that a key must actually narrow something: at least one action, and either a spend ceiling or a target restriction
- Least-privilege mode toggle: require a covering key for every autonomous spend, deny anything without one (owner actions and withdrawals unaffected)
- Suggested keys: the server detects armed sniper strategies with no scoped key and drafts one sized to that strategy's own daily budget — accepted in one tap
- Live key list with status badges: active, revoked, expired, tampered
- Plain-English capability sentence on each key, e.g. "Can snipe up to $40 total on 3 allowed mints, and nothing else"
- Live budget progress bar per key that shifts from green/amber to amber/red at 90% consumed
- Spent-of-budget readout ($X of $Y used) plus live expiry countdown (days/hours/minutes/seconds left)
- Per-key Revoke button with confirmation — revocation is immediate, permanent, and idempotent
- Revoke-all kill switch that terminates every live key at once, with confirmation and a revoked count
- Auto-refresh every 20 seconds while the tab is visible, keeping spend meters and countdowns live
- Auto-resolution on the spend path: autonomous callers automatically find the best covering key (tightest, soonest-expiring first) without threading key IDs around
- Full audit trail: every mint, revoke, and spend is recorded as a custody event
- Designed states throughout: skeleton loading shimmer, retryable error state, and a guided empty state explaining what a first key does
- Accessibility built in: progressbar semantics, ARIA-labeled controls, live error announcements, reduced-motion support

## Guardrails & safety

Owner-only surface end to end: the tab is hidden from non-owners and the API verifies both authentication and agent ownership on every call (401/403 otherwise). Every mutation is CSRF-protected and rate-limited. Keys strictly subtract authority — both the key ceiling and the wallet-wide policy must pass, so a key can never spend more than the wallet allows. Every grant is HMAC-signed over its immutable scope and re-verified in constant time on every use; a database-level tamper produces a rejected \"tampered\" grant, and the server refuses to mint at all if the signing secret is missing or weak. Expiry is mandatory (60 seconds minimum, 1 year maximum, 24-hour default); withdrawals are deliberately not delegable. Budget checks and reservations are atomic under per-key and per-agent locks so concurrent spends cannot overshoot a ceiling, and a revoke can never be raced. Revoke and revoke-all require explicit confirmation dialogs. Every failure fails safe toward denial, and denial messages tell the holder exactly which limit blocked the spend.

## Screenshot-worthy (shot list)

- A key card that reads like a contract: "Can snipe up to $40 total on 3 allowed mints, and nothing else" — with a live budget bar burning from green to red and a ticking expiry countdown
- The Suggested keys card: the platform notices an armed sniper strategy running without a leash and drafts the exact scoped key for it, budgeted to what the strategy can already spend — one tap to accept
- The strict-mode switch: one toggle and every autonomous trade, snipe, or payment without a covering key is denied on the spot, while a red Revoke All button sits ready as the wallet-wide kill switch

## API surface

- `GET /api/agents/:id/capabilities`
- `POST /api/agents/:id/capabilities`
- `PUT /api/agents/:id/capabilities/settings`
- `POST /api/agents/:id/capabilities/:capabilityId/revoke`
- `POST /api/agents/:id/capabilities/revoke-all`
