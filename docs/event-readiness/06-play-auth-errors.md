# Audit 6: /play auth, gates, and every failure state

Event visitors will arrive signed out, with ad blockers, on flaky wifi, with wallets we have never seen. Every one of those must get a designed experience, not a blank canvas or a raw stack trace.

## Where the code lives

- Auth flow: `src/game/play-auth.js`, `src/game/play-gate.js`, `src/game/play-handoff.js`
- World boot (error surfaces): `src/game/coincommunities.js`, `src/game/boot-avatar.js`
- QA credentials for authed testing: `AUDIT_EMAIL` / `AUDIT_PASSWORD` in `.env` (a real production QA account); sweeps via `npm run audit:web` (anon) and `npm run audit:web:login` (authed). Both take route paths as arguments to scope the sweep (`npm run audit:web -- /play`) and `--engine webkit` or `--engine firefox` to run it in Safari's or Firefox's engine instead of Chromium (`npx playwright install webkit` once)

## What to audit

1. **Signed-out experience.** Load the canonical $THREE URL (see `docs/event-readiness/README.md`) with no session. How much of the world is explorable before a gate appears? The gate itself: is it an invitation (clear value, one-tap sign-in) or a wall? Fix toward invitation.
2. **Sign-in mid-session.** Complete wallet sign-in from inside the world. The session must hand off without losing position or reloading the page if the flow supports it; if it must reload, state must restore.
3. **Session expiry.** Expire the session (clear the cookie/token) while playing, then perform an authed action (buy, bank). The user gets a re-auth prompt that resumes the action afterward, not a generic failure. Note `play-gate.js` now reads the cached play pass first on boot, and reading is how it is reaped: `loadStoredPass()` drops an expired or corrupt entry before either early exit (config probe failing open, gate off for this world), so a dead token no longer outlives the boot and gets handed to a room join the server can only refuse.
4. **Every fetch boundary.** Grep the play modules for `fetch(`/net calls and check each one handles rejection and non-2xx with a user-visible, actionable state. Internal code trusts itself; boundaries do not.
5. **Asset failures.** Block the IPFS coin image and one GLB in devtools. The world must render with fallbacks (placeholder texture, default rig per the `AnimationManager.supportsCanonicalClips()` gate), never a T-pose or an invisible avatar. A blocked or missing avatar GLB is a designed path in `boot-avatar.js`: it releases the loader, styles the card for the no-avatar case, and logs at info through the gated logger, so it costs a decoration, never the boot and never a console warning.
6. **Bad query strings.** /play with no params, a garbage `coin=`, an XSS attempt in `name=`/`symbol=` (must render escaped, never execute), and an oversized `image=` URL. Each gets a sane default world or a designed error, and never script execution.
7. **Console zero.** `npm run audit:console -- /play` (route paths passed as arguments scope the sweep; `--desktop` or `--mobile` picks one viewport), plus a manual pass. Zero errors, zero warnings from our code, on both anon and authed runs.

## Verify

- `npm run audit:web` and `npm run audit:web:login` pass for the play surface.
- Manual devtools-driven failure injection for items 3-6, each recovered per above.
- `npm test` stays green.

## Report format

A failure-mode table: scenario, what happened before, what happens now. Call out any XSS finding separately and first.
