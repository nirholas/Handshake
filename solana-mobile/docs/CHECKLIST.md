# Seeker dApp Store submission checklist

Work top-to-bottom. Do not submit until every box is checked. A date after a box is when it was last verified against production; re-verify anything older than the current release.

## 1. Web app readiness (three.ws itself)

- [x] `https://three.ws/manifest.webmanifest` returns 200 with `Content-Type: application/manifest+json`. (verified 2026-08-27)
- [x] `/pwa-192x192.png`, `/pwa-512x512.png`, and `/pwa-icon.svg` return 200 with the right image type. (verified 2026-08-27)
- [x] The three TWA shortcuts resolve: `/create`, `/marketplace`, `/my-agents` all return 200. (verified 2026-08-27; `/my-agents` replaced the public `/agents` index)
- [x] Nothing blocks a TWA: the root sends no `X-Frame-Options`, and CSP `frame-ancestors` is irrelevant to a TWA (it is not an iframe). (verified 2026-08-27)
- [x] Service worker registered (`vite-plugin-pwa` emits `/registerSW.js`). (verified 2026-08-10)
- [ ] Chrome on Android offers "Add to Home screen" and the result opens standalone (device check).
- [ ] `start_url` (`/?utm_source=seeker_app`) renders without console errors on the device.

## 2. Digital Asset Links (DAL)

- [x] `scripts/build-apk.sh` has been run so the SHA-256 fingerprint is known. (2026-08-10; keystore at `solana-mobile/android.keystore`, password in `.env` `SOLANA_MOBILE_KEYSTORE_PASSWORD`; on a fresh headless machine run `scripts/setup-android-sdk.sh` first)
- [x] `public/.well-known/assetlinks.json` contains the real fingerprint (no `{{RELEASE_SHA256}}` placeholder) and is on `main`. (2026-08-10)
- [x] `https://three.ws/.well-known/assetlinks.json` returns 200 as `application/json` AND carries the 2026-08-27 fingerprint `98:0A:...:13:D7`. (verified live 2026-08-28)
- [x] Google's statement list confirms the new key: `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://three.ws&relation=delegate_permission/common.handle_all_urls` returns `98:0A:...:13:D7` and nothing else. (verified 2026-08-28) On a device, follow with `adb shell pm verify-app-links --re-verify ws.three.app`.
- [ ] `cache-control` on `assetlinks.json` is at most one hour. The live site still read `max-age=86400` on 2026-08-28 even though the server default is `max-age=3600`: the `/.well-known/(.*)` route in `vercel.json` sets its own header, and `server/index.mjs` only applies its default when no earlier layer set one. That route was changed to `max-age=3600` on 2026-08-28; confirm on the live site after the next deploy.

## 3. APK build

- [x] Release keystore is backed up offsite. The 2026-08-10 keystore was lost with its codespace (never backed up), so a NEW key was generated 2026-08-27 and stored in Secret Manager (`three-ws-seeker-release-keystore`, base64, and `three-ws-seeker-keystore-password`, project `aerial-vehicle-466722-p5`; round trip verified by sha256). Nothing was ever published under the old key. Never generate another.
- [x] `build/three-ws-release.apk` was produced by `scripts/build-apk.sh` and is signed. (2026-08-27, 4.1 MB, versionCode 1, targetSdk 36; `build/` is gitignored, so rebuild on the release machine)
- [x] `apksigner verify --print-certs` prints the SHA-256 that is in `assetlinks.json`. (verified 2026-08-27: `98:0A:1A:AB:...:11:13:D7`)
- [x] APK installs and launches on Android 14 (Pixel 7 emulator, 2026-08-27). Full-screen without the address bar needs Digital Asset Links for the NEW fingerprint, which go live with the next deploy; until then Chrome shows a custom-tab bar, by design.
- [ ] App icon, name, and splash colors match brand on a real launcher (`three.ws`, `#080814` background, `#000000` theme).
- [x] Long-press shortcuts Create / Discover / My agents are registered in the installed APK (`dumpsys shortcut`, 2026-08-27); each opens inside the app once DAL verifies.
- [x] The Android share sheet target is registered (`shareTarget`, MIME types only) and an `ACTION_SEND` image intent opens the app (2026-08-27, emulator).

## 4. MWA integration

- [x] Wrapper logic is unit-tested against a fake transport (`npx vitest run tests/solana-mobile-mwa-*.test.js tests/solana-mobile-seeker-detect.test.js`): authorize/resume, one-tap `signIn`, sign/send, error normalization, disconnect, session persistence across process death, revoked-token reset, detection boundaries. (49 tests green 2026-08-27)
- [x] `solana-mobile/src/index.js` is imported from the app entry points (`src/wallet.js`, `src/game/play-auth.js`). (verified 2026-08-27)
- [x] Emulator run against Solana Mobile's reference wallet: connect returns a real public key through the on-device flow; icon format and sign/send response shapes fixed. (2026-08, see the changelog)
- [ ] On a real Seeker, `window.threeWsWallet` is defined and `isSolanaMobileTwa()` returns `true` inside the TWA.
- [ ] First sign-in triggers the Seed Vault sheet (no Phantom/Solflare prompts).
- [ ] One-tap SIWS: wallet linking shows a SINGLE Seed Vault sheet, and `/api/auth/siws/verify` accepts the wallet-built message.
- [ ] `signMessage` (two-step fallback) produces a signature `/api/auth/siws/verify` accepts.
- [ ] `signAndSendTransaction` lands on mainnet (test with a 0-lamport memo tx before any deploy flow).
- [ ] Session survives suspend/resume AND a forced stop of the app (Settings > Apps > three.ws > Force stop, relaunch, sign again: no second prompt). The token now lives in `localStorage`.
- [ ] A cancelled Seed Vault sheet surfaces as a clean "cancelled" state (`code 4001` / `reason USER_REJECTED`), not a generic failure.
- [ ] `disconnect()` removes the linked wallet from local state.

## 5. Listing copy (entered in the Publisher Portal)

- [x] `publish/listing/description.md` describes only features that exist in the app: selfie (one frontal + two optional angles) to rigged avatar, text and GLB creation, chat, marketplace, Metaplex Core deploy, USDC skills/tips, embeds, Seed Vault SIWS. (rewritten 2026-08-27)
- [x] `publish/listing/new-in-version.txt` reflects this exact build, no "coming soon". (2026-08-27)
- [x] `publish/listing/saga-features.md` cites Seed Vault signing, camera capture, and deep links / shortcuts, each verifiable in the APK. The earlier Web Share Target claim was removed: the live manifest declares none. (2026-08-27)
- [x] No third-party vendor names in the copy or media. (2026-08-27)
- [ ] The text in the portal matches the files in `publish/listing/` byte for byte (copy from git, not from memory).

## 6. Publisher Portal (owner, one-time)

- [ ] Publisher profile created at <https://publish.solanamobile.com> and KYC/KYB approved.
- [ ] Publisher wallet connected (Phantom/Solflare/Backpack extension) and funded with at least 0.2 SOL for the App NFT, release NFT, and Arweave uploads.
- [ ] Storage provider chosen (ArDrive recommended).
- [ ] "Add a dApp" completed with `publish/config.yaml` values, `publish/listing/`, and `publish/media/` (all eight images); App NFT minted.
- [ ] API key created under Settings > API keys and stored in the owner's password manager (never in the repo).
- [ ] The publisher wallet's keypair file is available to `scripts/publish.sh` as `SOLANA_KEYPAIR` and backed up offsite.

## 7. Policy compliance

- [x] Privacy policy is live at `https://three.ws/legal/privacy` and EULA at `https://three.ws/legal/eula`. (both 200 on 2026-08-27)
- [ ] Privacy policy discloses wallet address collection (re-read before submitting).
- [x] No US-restricted activities (gambling, securities offerings, derivatives) in the copy. (2026-08-27)
- [x] Payment flows use SOL/USDC on-chain; no fiat onramp is surfaced inside the app. (2026-08-27)
- [ ] Camera permission shows a visible justification at first prompt (device check on `/create/selfie`).
- [x] A wallet rejection (`USER_REJECTED`) is handled without crashing: `src/wallet.js` swallows it with no toast, everything else gets a retry toast. (unit + code review 2026-08-27)

## 8. Repeat builds

- [ ] `KEYSTORE_PASSWORD=... ./scripts/build-apk.sh` runs end-to-end unattended on the release machine (no interactive prompts).
- [ ] Keystore path and password live in the owner's password manager, not in the repo.
- [ ] `appVersionCode` was bumped in `twa/twa-manifest.json` (or via `VERSION_CODE`); the dApp Store rejects a re-used versionCode, and `scripts/publish.sh` refuses one it already shipped.
- [ ] `scripts/publish.sh` completes with the publisher wallet's keypair and the portal API key.

## 9. Pre-submit smoke (real Seeker)

- [ ] Fresh install: onboarding to a deployed agent takes under 3 minutes.
- [ ] Camera capture under poor lighting degrades gracefully (the quality gates in `src/selfie-gates.js` explain what to fix; no infinite spinner).
- [ ] Airplane mode: the app shows a clear network error, not a broken white page.
- [ ] Deep links (`https://three.ws/agents/...`) open inside the app, not in Chrome.
- [ ] Five screenshots captured per `docs/ASSETS.md` and dropped into `publish/media/`.

## 10. Post-submission

- [ ] Review results arrive by email from `publishersupport@dappstore.solanamobile.com` within 3-5 business days; watch the portal dashboard.
- [ ] On approval, verify the store listing renders all five screenshots and the feature graphic.
- [ ] Add a `data/changelog.json` entry announcing the store listing with its link.
