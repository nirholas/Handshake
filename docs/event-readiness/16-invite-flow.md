# Feature 16: invite flow (deep link, QR, OG card) for the event

Everyone at the event arrives through one link, and everyone who has fun should be able to pull one more person in. Make inviting effortless from inside the world, and make the link unfurl beautifully everywhere it is pasted.

## Where the code lives

- Deep-link contract: `coinWorldUrl()` in `src/fits-lib.js` (tested in `tests/fits-lib.test.js`); canonical URL emission in `src/game/coincommunities.js` (`history.replaceState` in `enter()`, which keeps exactly `coin`, `name`, `symbol`, `image`, `tier` for a holders world, and `ui`; a bare `coin` link now resolves its name, symbol and image through `_fetchCoinIdentity` before the rewrite, so the canonical link is always complete)
- OG image for /play links: `api/play-og.js` (GET-only since the fleet hardening pass; any other verb is refused before the satori render); house OG patterns: `api/page-og.js`, `api/og-leaderboard.js`
- HUD mount + share precedent: `src/game/coincommunities-ui.js` and the build-share sheet. Do not confuse this with the friend invites in `src/game/friends-panel.js`, which are a social-graph request, not a world link
- QR: `qrcode` is already a dependency (`src/wallet-deposit.js` and `src/marketplace.js` render with it); use it, no new encoder

## What to build

1. **Invite button.** A HUD control (and lobby-card action) opening a small invite sheet: the canonical world link with copy button, a live QR code of that link (event hosts will show phones to each other), and `navigator.share` where available. The link always carries `coin`, `name`, `symbol`, `image` so the destination renders identity instantly, before any API round-trip.
2. **OG card truth.** Paste-test the canonical $THREE URL: the unfurl must show the coin image, name, symbol, and a line that sells the world. If `api/play-og.js` renders stale or generic art, fix it: it should composite the real coin image (via the `/api/img` proxy, with a designed fallback when IPFS fails) and live-ish facts if cheap (online count is a nice touch only if it does not slow the card).
3. **Arrival continuity.** An invitee landing from the link skips straight into the flow a first-timer needs: intro suppressed (a `coin` param already does this), onboarding shown once, and if Feature 14 landed the concierge greets them. Verify the whole arrival path on a fresh profile.
4. **Event framing.** During the event window (`public/event.json`), the invite sheet leads with the event name and countdown, so the share reads as an invitation to a happening, not just a link.

## Verify

- `npm run dev`: invite sheet on desktop and emulated mobile; QR scans from a real phone camera to the right URL; copy toast; share sheet on mobile.
- OG card rendered locally (hit the endpoint directly) and correct for the $THREE canonical URL, including the IPFS-failure fallback.
- `npm test` green.

## Report format

Files shipped, any dependency added (name, weekly downloads, license, why), a rendered OG card sample path, and the `data/changelog.json` entry.
