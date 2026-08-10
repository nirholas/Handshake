# Seeker dApp Store submission checklist

Work top-to-bottom. Do not submit until every box is checked.

## 1. Web app readiness (three.ws itself)

- [x] `https://three.ws/manifest.webmanifest` returns 200 with `Content-Type: application/manifest+json`. (verified 2026-08-10)
- [x] `/pwa-192x192.png` and `/pwa-512x512.png` return 200 with `image/png`. (verified 2026-08-10)
- [ ] The site is installable from Chrome → "Add to Home screen" produces a standalone window.
- [ ] `start_url` resolves and renders without console errors.
- [x] Service worker registered (the build already emits `/registerSW.js` via vite-plugin-pwa). (verified 2026-08-10)
- [ ] All third-party fonts and scripts allow embedding in a TWA (no `X-Frame-Options: DENY` on the root).

## 2. Digital Asset Links (DAL)

- [x] `solana-mobile/scripts/build-apk.sh` has been run once locally so the SHA-256 fingerprint is known. (2026-08-10, keystore at `solana-mobile/android.keystore`, password in `.env` `SOLANA_MOBILE_KEYSTORE_PASSWORD`; on a fresh headless machine run `scripts/setup-android-sdk.sh` first)
- [x] `public/.well-known/assetlinks.json` exists, contains the real fingerprint (no `{{RELEASE_SHA256}}` placeholders), and is checked into `main`. (2026-08-10)
- [ ] `https://three.ws/.well-known/assetlinks.json` returns 200, `Content-Type: application/json`, max-age ≤ 3600.
- [ ] Verified via Google's tool: `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://three.ws&relation=delegate_permission/common.handle_all_urls`.

## 3. APK build

- [ ] Release keystore exists and is backed up offsite (lose this = lose the app forever). (keystore generated 2026-08-10 in the codespace; OFFSITE BACKUP STILL NEEDED: download `solana-mobile/android.keystore` + the `.env` password to the owner's password manager)
- [x] `solana-mobile/build/three-ws-release.apk` was produced by `scripts/build-apk.sh` and is signed. (2026-08-10, 4.5 MB)
- [x] `apksigner verify --print-certs` prints the expected SHA-256 (matches the one in `assetlinks.json`). (verified 2026-08-10: `49:84:9C:CC:...:DC:27`)
- [ ] APK installs cleanly on a Seeker device: launches into three.ws full-screen, no Chrome address bar visible.
- [ ] App icon, name, and splash colors match brand (`three.ws`, `#080814` background, `#000000` theme).
- [ ] Three shortcuts (Create / Discover / My agents) appear on long-press of the app icon.

## 4. MWA integration

- [x] Wrapper logic is unit-tested against a fake transport (`npx vitest run tests/solana-mobile-mwa-*.test.js tests/solana-mobile-seeker-detect.test.js`) — authorize/resume, one-tap `signIn`, sign/send, error normalization, disconnect, session persistence, detection boundaries.
- [x] `solana-mobile/src/index.js` is imported from a top-level entry point (see `docs/INTEGRATION.md`). (verified 2026-08-10: imported by `src/wallet.js` and `src/game/play-auth.js`)
- [ ] In a real TWA session, `window.threeWsWallet` is defined and `isSolanaMobileTwa()` returns `true`.
- [ ] First sign-in triggers the Seed Vault sheet (no Phantom/Solflare prompts).
- [ ] One-tap SIWS: wallet linking via `signIn()` shows a SINGLE Seed Vault sheet (not connect-then-sign), and `/api/auth/siws/verify` accepts the wallet-built message.
- [ ] `signMessage` produces a valid ed25519 signature that `/api/auth/siws/verify` accepts (two-step fallback path).
- [ ] `signAndSendTransaction` lands on mainnet (test with a 0-lamport memo tx before mint flows).
- [ ] Auth token survives app suspend/resume (test by switching apps for 60 s, then signing again — no second prompt).
- [ ] A cancelled Seed Vault sheet surfaces as a clean "cancelled" state (error carries `code 4001` / `reason USER_REJECTED`), not a generic failure.
- [ ] `disconnect()` removes the linked wallet from local state.

## 5. Listing copy

- [ ] `publish/config.yaml` has `publisher.address` and `app.address` filled in (from `init-publisher.sh` output).
- [ ] `publish/listing/description.md` mentions only features that exist in the submitted APK.
- [ ] `publish/listing/new-in-version.txt` reflects this exact build (no "coming soon").
- [ ] `publish/listing/saga-features.md` cites Seed Vault, camera capture, and Share Target — each is verifiable.
- [ ] No mention of vendor names that don't belong to three.ws.

## 6. On-chain assets

- [ ] Publisher NFT minted on mainnet, address recorded.
- [ ] App NFT minted on mainnet, address recorded.
- [ ] Solana publishing wallet holds ≥ 0.2 SOL (covers release NFT + Arweave fees).
- [ ] Publishing keypair is backed up offsite.

## 7. Policy compliance

- [ ] Privacy policy is live at `https://three.ws/legal/privacy` and discloses wallet address collection.
- [ ] EULA is live at `https://three.ws/legal/eula`.
- [ ] No mention of US-restricted activities (gambling, securities offerings, derivatives).
- [ ] Payment flows use SPL tokens or USDC, not fiat onramps surfaced inside the app.
- [ ] Camera permission has a visible justification string at first prompt.
- [ ] App handles the case where the wallet rejects (`USER_REJECTED`) without crashing.

## 8. Repeat builds

This repo does not use GitHub Actions — releases are built locally by the owner.

- [ ] `KEYSTORE_PASSWORD=… ./scripts/build-apk.sh` runs end-to-end unattended on the release machine (no interactive prompts).
- [ ] The release keystore path and password are stored in the owner's password manager, not on disk in the repo.
- [ ] `appVersionCode` was bumped in `twa/twa-manifest.json` (or via `VERSION_CODE`) — the dApp Store rejects a re-used versionCode.
- [ ] `scripts/publish.sh` completes with the same `SOLANA_KEYPAIR` used at init time.

## 9. Pre-submit smoke

- [ ] Fresh install on a Seeker — full onboarding to mint takes < 3 minutes.
- [ ] Camera capture works under poor lighting (degrades gracefully — no infinite spinner).
- [ ] Offline mode shows the offline page, not a Chrome error.
- [ ] Deep links (`https://three.ws/agents/...`) open inside the app, not Chrome.

## 10. Post-submission

- [ ] Watch the Publisher Portal review queue — typical turnaround is 2–5 business days.
- [ ] Subscribe to the `Solana Mobile Developers` Telegram for review feedback.
- [ ] On approval, the release NFT becomes visible at `https://dapp-store.solanamobile.com/...`. Verify the listing renders all five screenshots.
