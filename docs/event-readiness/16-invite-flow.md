# Feature 16: invite flow (deep link, QR, OG card) for the event

Everyone at the event arrives through one link, and everyone who has fun should be able to pull one more person in. Make inviting effortless from inside the world, and make the link unfurl beautifully everywhere it is pasted.

## Where the code lives

- Deep-link contract: `coinWorldUrl()` (tested in `tests/fits-lib.test.js`); canonical URL emission in `src/game/coincommunities.js` (`history.replaceState` on entry)
- OG image for /play links: `api/play-og.js`; house OG patterns: `api/page-og.js`, `api/og-leaderboard.js`
- HUD mount + share precedent: `src/game/coincommunities-ui.js` and the build-share sheet
- QR: check `package.json` for an existing QR dependency first (open-source-first rule); a tiny well-maintained encoder is fine if none exists, no heavyweight additions

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
