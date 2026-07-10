# Task 07 — Verify the work + the living passport

**Goal:** Ship the **trust surface** — the thing that proves Agora isn't theater.
Click a job → its on-chain lifecycle timeline + a **Verify deliverable** button
that re-downloads the artifact, re-hashes it in the browser, and shows it matches
(or doesn't) the on-chain `proofHash`. Click a citizen → the full **living
passport**: reputation, slashable stake, status, complete task history, and the
**cross-chain identity handshake** (one agent proving an EVM ERC-8004 *and* a
Solana MPL-Core identity via the bridge).

**Depends on:** Task 06 (economy visuals + board markers to click).

## Context to read first
- `docs/agora.md` (§ The 3D layer — Verify + passport).
- `api/agora/[action].js` `passport` (projection + live `onchain` + `activity`).
- `api/agenc/[action].js` `get-task` (`&lifecycle=1` → timeline with actors + tx),
  `get-agent`, `link` (identity bridge: erc8004/mpl-core/handle → canonical id).
- `solana-agent-sdk/src/actions/agenc/identity-bridge.ts` — how the cross-chain id
  is derived (for the handshake explainer).
- Task 06's `src/agora/*`.

## Background
Completion bound the deliverable: `proofHash = sha256(deliverable bytes)`, stored
on-chain. So **anyone can verify** by re-fetching `deliverable_url` and hashing it
client-side (`crypto.subtle.digest('SHA-256', …)`) — no trust required. The
passport's `onchain` block is the live registry truth; `activity` is the full
history; `link` resolves whether a three.ws identity (EVM/Solana/handle) maps to a
registered AgenC agent — the basis of the handshake.

## Build (scope)
1. **Job detail.** Clicking a board marker opens a panel that calls
   `/api/agenc/get-task?...&lifecycle=1`: show the ordered timeline (created →
   claimed → completed, each with actor + a Solana Explorer tx link), reward,
   required profession, worker fill, state.
2. **Verify deliverable.** For a completed task with a `deliverableUrl`, a
   **Verify** button: fetch the bytes, `sha256` them in the browser, compare to the
   on-chain `proofHash`. Render a clear ✓ match / ✗ mismatch with both hashes
   shown, and (for a GLB) render the verified model inline. Handle fetch failure /
   CORS / large files gracefully (stream + size cap + honest error).
3. **Living passport.** Clicking a citizen opens the full passport from
   `/api/agora/passport`: avatar, name, professions, status, **reputation** (with
   an A–D-style grade if you derive one — reuse any existing trust-grade logic),
   **stake**, tasks completed/posted, $THREE earned, and a scrollable activity
   timeline (each row links its tx / deliverable). Designed empty/loading/error.
4. **Cross-chain handshake.** When a citizen's identity has both an EVM (ERC-8004)
   and a Solana (MPL-Core) proof (via `/api/agenc/link` or passport metadata),
   render the handshake: the two chain identities resolving into one canonical
   AgenC id, with a one-line plain-language explainer ("one agent, two chains, one
   reputation") and links to each on its explorer.
5. **Polish.** Keyboard navigable, focus-trapped panels, ARIA labels, copy-to-
   clipboard on hashes/addresses, deep-linkable (`/agora?citizen=…` / `?task=…`).

## Out of scope
Humans performing actions (posting/verifying as a logged-in user — Task 08; this
task's Verify is a public, read-only re-hash anyone can do). Arena/guild views
(Task 09).

## Contracts
- New: `src/agora/job-detail.js`, `src/agora/verify.js` (browser sha256 + compare),
  `src/agora/passport-panel.js` (upgrade Task 05's basic panel), `src/agora/
  handshake.js`.
- Consumes `/api/agora/passport`, `/api/agenc/get-task?lifecycle=1`,
  `/api/agenc/get-agent`, `/api/agenc/link`.
- Browser hashing via `crypto.subtle.digest`; compare lowercased hex to
  `proofHash`.

## Definition of Done
- [ ] Clicking a completed job shows its real lifecycle timeline with working
  Explorer tx links.
- [ ] **Verify** re-hashes a real deliverable in-browser and shows ✓ against the
  on-chain `proofHash`; tampering the URL/bytes shows a clear ✗ with both hashes.
- [ ] A verified GLB renders inline.
- [ ] The living passport shows real reputation/stake/status/history; every row
  links its tx/deliverable; empty/loading/error designed.
- [ ] A dual-identity citizen shows the cross-chain handshake with correct
  canonical id + per-chain explorer links (verify the id matches the bridge math).
- [ ] Panels are keyboard-accessible, focus-trapped, deep-linkable; hashes/
  addresses are copyable.

## Verification
`npm run dev` → `/agora`. Verify a real Sculptor deliverable (✓), then point the
verifier at a mutated copy (✗). Open a passport; cross-check its `onchain` block
against `/api/agenc/get-agent`. For the handshake, confirm the canonical id equals
`/api/agenc/link`'s output for the same identities.

## Guardrails
- The Verify path must be **honest**: if a deliverable can't be fetched/hashed,
  say "could not verify" — never show a green check you didn't compute.
- No coin but $THREE in any label/explainer.
- Push to `threews`; changelog: yes (user-visible — "verify any agent's on-chain
  work yourself; living passports with cross-chain identity").
