# Seeker dApp Store submission checklist

Work top-to-bottom. Do not submit until every box is checked.

## 1. Web app readiness (three.ws itself)

- [ ] `https://three.ws/manifest.webmanifest` returns 200 with `Content-Type: application/manifest+json`.
- [ ] `/pwa-192x192.png` and `/pwa-512x512.png` return 200 with `image/png`.
- [ ] The site is installable from Chrome → "Add to Home screen" produces a standalone window.
- [ ] `start_url` resolves and renders without console errors.
- [ ] Service worker registered (the build already emits `/registerSW.js` via vite-plugin-pwa).
- [ ] All third-party fonts and scripts allow embedding in a TWA (no `X-Frame-Options: DENY` on the root).

## 2. Digital Asset Links (DAL)

- [ ] `solana-mobile/scripts/build-apk.sh` has been run once locally so the SHA-256 fingerprint is known.
- [ ] `public/.well-known/assetlinks.json` exists, contains the real fingerprint (no `{{RELEASE_SHA256}}` placeholders), and is checked into `main`.
- [ ] `https://three.ws/.well-known/assetlinks.json` returns 200, `Content-Type: application/json`, max-age ≤ 3600.
- [ ] Verified via Google's tool: `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://three.ws&relation=delegate_permission/common.handle_all_urls`.

## 3. APK build

- [ ] Release keystore exists and is backed up offsite (lose this = lose the app forever).
- [ ] `solana-mobile/build/three-ws-release.apk` was produced by `scripts/build-apk.sh` and is signed.
- [ ] `apksigner verify --print-certs` prints the expected SHA-256 (matches the one in `assetlinks.json`).
- [ ] APK installs cleanly on a Seeker device: launches into three.ws full-screen, no Chrome address bar visible.
- [ ] App icon, name, and splash colors match brand (`three.ws`, `#080814` background, `#000000` theme).
- [ ] Three shortcuts (Create / Discover / My agents) appear on long-press of the app icon.

## 4. MWA integration

- [ ] `solana-mobile/src/index.js` is imported from a top-level entry point (see `docs/INTEGRATION.md`).
- [ ] In a real TWA session, `window.threeWsWallet` is defined and `isSolanaMobileTwa()` returns `true`.
- [ ] First sign-in triggers the Seed Vault sheet (no Phantom/Solflare prompts).
- [ ] `signMessage` produces a valid ed25519 signature that `/api/auth/siws/verify` accepts.
- [ ] `signAndSendTransaction` lands on mainnet (test with a 0-lamport memo tx before mint flows).
- [ ] Auth token survives app suspend/resume (test by switching apps for 60 s, then signing again — no second prompt).
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
