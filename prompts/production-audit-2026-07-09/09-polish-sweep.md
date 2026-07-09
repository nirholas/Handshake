# 09 — Polish sweep: cosmetic header fix + config-gap 503s + stub-link spot-check

## Mission

Four lower-severity findings from the 2026-07-09 crawl. Three have a concrete, bounded fix;
one is genuinely "watch, don't touch" and should stay that way. Run this last, ideally after
prompt 01 has shipped, so re-checks reflect live production rather than a stale deploy.

## A. Permissions-Policy `bluetooth` — cosmetic, one-line, site-wide

### Root cause (confirmed)

`vercel.json` line 188, the global default header block applied to every route
(`"src": "/(.*)"`), sets:
```
"permissions-policy": "accelerometer=(), autoplay=(self), bluetooth=(), camera=(), display-capture=(), encrypted-media=(self), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(self), serial=(), usb=(), xr-spatial-tracking=(self)"
```
Chrome does not recognize `bluetooth` as a valid Permissions-Policy feature name and logs
`Unrecognized feature: 'bluetooth'.` on every page load — hence 302 pages flagged in the crawl
(essentially every page, since this is the site-wide default). This is pure cosmetic console
noise; no actual permission behavior changes either way since Chrome ignores the unrecognized
directive.

### Fix

Remove `bluetooth=()` from the `permissions-policy` value on line 188 of `vercel.json`. Leave
every other directive untouched. Remember root `CLAUDE.md`: `vercel.json` is a **live config
file** consumed directly by `server/index.mjs` (route table + headers), not a Vercel leftover —
editing it is correct here, and the change needs `npm run deploy:gcp` to take effect (bundle
with prompt 01's deploy if that hasn't shipped yet, or ship standalone).

### Verification

- [ ] `curl -sI https://three.ws/` (post-deploy) shows `permissions-policy` without `bluetooth=()`.
- [ ] DevTools console on any page no longer logs the "Unrecognized feature: 'bluetooth'" warning.

## B. `/api/agent/wallet` 503 — has a documented, scripted fix

### Root cause (confirmed)

`api/agent/wallet.js` returns its 503 with the exact remedy already in the error message:
*"avatar wallet is not configured — set `AVATAR_WALLET_SECRET` (run
`scripts/gen-avatar-wallet.mjs`)"*. The script already exists in the repo.

### Fix

1. Run `node scripts/gen-avatar-wallet.mjs` (read it first — confirm it just generates a keypair
   and prints the values rather than doing anything destructive; it should be a pure keygen
   utility given the error message's phrasing).
2. Set `AVATAR_WALLET_SECRET` on the Cloud Run service env with the generated value.
3. This is a **new** wallet with zero balance — check what `api/agent/wallet.js` actually needs
   funded (if anything) for its endpoints to work end-to-end, not just to stop 503ing. If it
   needs SOL/USDC to be useful (vs. just needing to exist to unblock read-only calls), fund it
   minimally or flag the funding need explicitly rather than declaring this fixed on a technicality.

### Verification

- [ ] `curl -fsS https://three.ws/api/healthz` — this subsystem no longer reports the
      `AVATAR_WALLET_SECRET`-unset 503.
- [ ] A real call to whatever `/api/agent/wallet` endpoint exists succeeds (not just health-check
      green).

## C. `/api/agent-wallet-bridge` 503 — same family, different var

### Root cause (confirmed)

`api/agent-wallet-bridge.js`'s `agentSigner()` rejects with `"agent wallet not configured on the
server"` when `PAYER_SECRET` (aliased from `env.A2A_PAYER_SOLANA_SECRET`) is unset. This is the
**same role** already listed in `api/_lib/solana-signers.js`'s `SIGNER_SPECS` as `a2a-payer`
(`env: A2A_PAYER_SOLANA_SECRET`, fallback `A2A_PAYER_SOLANA_PRIVATE_KEY`, `minSol: 0.02`,
purpose: *"co-signs SPL TransferChecked for agent-to-agent mandate settlements"*).

### Fix

1. Run `scripts/audit-service-wallets.mjs` (same tool as prompt 08) against real deploy env — it
   already checks this exact signer role by name (`a2a-payer` — confirm the spec is in its
   `SIGNERS` list; if the script's inline copy of `SIGNER_SPECS` predates this role, add it there
   too so future audits catch it).
2. If genuinely absent and no existing funded wallet needs recovering, generate + fund a fresh
   keypair for this role (apply the same "check for existing funds before regenerating" caution
   as prompt 08 — this is real-money-adjacent, same class of risk).
3. Set `A2A_PAYER_SOLANA_SECRET` on the Cloud Run env.

### Verification

- [ ] `/api/healthz` no longer reports this subsystem as unavailable.
- [ ] `scripts/audit-service-wallets.mjs` shows `a2a-payer` passing its pubkey-match and
      SOL-floor checks.

## D. `/api/community/worlds` 503 — likely owner-blocked, verify before attempting

### Root cause (confirmed)

`api/community/worlds.js` (and `api/_lib/coin-communities.js`) requires `CC_API_KEY` — a
third-party CoinCommunities API credential — and is not set. Unlike B/C above, this is not a
platform-controlled Solana wallet you can generate; it's an external service credential.

### Task

1. Confirm whether the platform already has a CoinCommunities account/API key somewhere
   (`.env`, a password manager reference, prior commits/docs mentioning CoinCommunities
   onboarding) before assuming this needs a brand-new signup.
2. If a key exists but isn't wired into the Cloud Run env, wire it — same pattern as B/C.
3. If no key exists, this needs an owner-level signup decision (new third-party account,
   possibly billing) — **stop and report this explicitly rather than attempting a workaround**.
   Do not stub, mock, or fake the CoinCommunities integration to silence the 503 — that violates
   the no-mocks rule in root `CLAUDE.md` and would hide a real missing capability.

### Verification (only if a key was actually wired)

- [ ] `/api/healthz` no longer reports `cc_unconfigured` for this subsystem.
- [ ] A real `/api/community/worlds` call returns live CoinCommunities data.

## E. Stub links (`href="#"`) — spot-check only, likely by design

### Context (confirmed, not blindly flagged)

100 `href="#"` links across the crawl, worst offenders `agent-edit.html` (×11 at last count,
audit said ×14 — recount, the number may have shifted) and `create-agent.html` (×4). Sampled in
`agent-edit.html`: every one carries an `id` (`preview-view-link`, `mind-fullscreen-link`,
`embed-open`, `wallet-explorer`, `publish-view`, etc.) — the standard "placeholder href, JS sets
the real target once data loads" pattern (e.g. an agent's on-chain explorer link can't be known
until the agent's wallet address is fetched). This is very likely correct by design, matching
the audit's own read ("mostly JS-driven tab/menu buttons").

### Task

Do **not** bulk-fix these. Spot-check a representative sample (start with `agent-edit.html`'s
`wallet-explorer`, `preview-view-link`, and `embed-open`):

1. Confirm each has a corresponding `document.getElementById('<id>').href = ...` (or equivalent)
   assignment somewhere in the page's script that actually fires under normal use (not dead
   code, not gated behind a condition that never becomes true).
2. Load the actual page, exercise the flow that should populate each link, and confirm the
   `href` updates away from `#` and the link actually navigates somewhere real when clicked.
3. If you find one that's genuinely dead (JS never sets it, or sets it to another `#`), fix that
   specific instance. If you find the pattern holds for all sampled links, leave the rest alone
   — flag the total count as confirmed-by-design in your report rather than mass-editing.

## F. HTTP 429s and the remaining 503 — watch, don't fix blind

Per the audit itself: the 161× 429s (`/api/oracle/*`, `/api/skills`, `/api/clash/state`,
`/api/three/access`, `/api/marketplace/analytics`, `/api/forge-gallery`) are most likely the
audit crawler's own 8-way concurrency tripping a shared per-IP rate limit, not a real-user-facing
bug. Do not touch rate-limit configuration based on this alone. If you want confidence either
way, check `/api/healthz` or real traffic logs (not the crawler's own run) for the same routes
before concluding anything needs to change. Report what you find; only act if real traffic shows
the same pattern.

## Verification summary for this whole prompt

- [ ] A, B, C fixed and verified per their own sections.
- [ ] D resolved if a key was findable, otherwise explicitly reported as owner-blocked (not
      silently skipped, not faked).
- [ ] E spot-checked with a clear verdict (confirmed-by-design, or a specific dead link fixed).
- [ ] F explicitly left alone unless real (non-crawler) traffic evidence says otherwise.
