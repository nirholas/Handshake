# three.ws on Solana Seeker

three.ws ships as a native Android app for the Solana Seeker (and Saga) through the Solana dApp Store. It is a Trusted Web Activity: the signed APK (`ws.three.app`) opens `https://three.ws/seeker` full-screen in Chrome's rendering engine with no browser chrome, and every wallet interaction is routed to the phone's Seed Vault through Mobile Wallet Adapter. For a WebGL product that is the right shape (it is what Solana Mobile recommends for web apps); what makes it feel like an app is everything around that shell. This page is the user-facing map of those pieces. The packaging and code layout live in [solana-mobile/README.md](../solana-mobile/README.md); how a release reaches the store is [Publishing to the Solana dApp Store](./seeker-publishing.md).

**Status: v1.0.0 was submitted to the Solana dApp Store on 2026-08-28 and is in review** (release `#331044442814`). Until it is approved the app is installable from the [v1.0.0 GitHub release](https://github.com/nirholas/three.ws/releases/tag/v1.0.0); everything described below is live on the web at [/seeker](/seeker) today.

## What the app does differently from the website

| Surface | On Seeker | Where it lives |
|---|---|---|
| Home screen | [/seeker](https://three.ws/seeker): one-tap Seed Vault sign-in, Create / Explore grid, your agents, Seeker verification | `pages/seeker.html`, `src/seeker.js` |
| Sign-in | A single Seed Vault sheet (Sign-In With Solana at authorize time) instead of connect-then-sign. The session survives Android killing the app; a revoked session is dropped cleanly | `solana-mobile/src/mwa-wallet.js`, `src/onchain/adapters/solana.js` |
| Share sheet | Share a photo from any app to three.ws: it opens the selfie flow with the photo attached. Share a `.glb`: it opens the upload flow | `public/share-target-sw.js`, `src/shared/share-target.js` |
| Offline | A branded offline screen that reloads itself when the network returns, instead of Chrome's error page | `public/offline.html`, `vite.config.js` (workbox `precacheFallback`) |
| Home-screen shortcuts | Long-press the icon: Create, Discover, My agents | `solana-mobile/twa/twa-manifest.json`, web manifest in `vite.config.js` |
| Icon | A maskable icon with the glyph inside Android's safe zone, so circle and squircle launchers never crop it | `public/pwa-maskable-*.png` |
| Seeker verification | Prove Seeker ownership by holding the soulbound Seeker Genesis Token; owners get a "Seeker verified" badge on every agent they own | `api/seeker/[action].js`, `api/_lib/seeker-genesis.js` |
| Deep links | Any `https://three.ws/...` link opens inside the app once Digital Asset Links verify the release key | `public/.well-known/assetlinks.json` |

## Seeker verification

The Seeker Genesis Token is a soulbound Token-2022 asset that Solana Mobile mints once per device into the primary Seed Vault account. three.ws reads it (never moves it):

1. Sign in on [/seeker](https://three.ws/seeker) with Seed Vault. That links the wallet to your account through SIWS.
2. Tap **Check my wallet**. The server calls Helius `getTokenAccountsByOwnerV2` for the linked Solana wallets, then checks each mint's authority, metadata pointer, and token-group membership against the Genesis Token group. No transaction, no signature.
3. On success the wallet is recorded in `seeker_genesis_verifications`, and every agent you own shows a **Seeker verified** pill in its trust row on `/agents/:id`.

API: `GET /api/seeker/status` and `POST /api/seeker/verify`, documented in [api-reference.md](./api-reference.md#seeker-verification). Verification fails closed: an RPC error is a 502, never a false positive.

## Sharing into three.ws

The web manifest declares a `share_target` at `POST /create/share`. The service worker intercepts that POST, parks the files in the Cache API, and redirects:

- an image goes to `/create/selfie?shared=1`, where the page picks it up as the frontal selfie (a second and third image fill the optional side angles);
- a `.glb` goes to `/create?shared=glb`, where the upload flow validates and stages it;
- anything else goes to `/create`.

The handoff is one-shot and expires after ten minutes, so a stale share can never resurface. On the Seeker the APK registers the same target with Android, so three.ws appears in the system share sheet for photos and `model/gltf-binary` files.

## Testing without a Seeker

The APK can be exercised in a stock Android emulator (Pixel 7, Android 14 image). Everything except the Seed Vault itself works there: install, launch, shortcuts, the share intent, deep-link verification state. The recipe is in [solana-mobile/README.md](../solana-mobile/README.md#emulator-qa). For the wallet flows, `tests/solana-mobile-*.test.js` drive the MWA wrapper against a fake transport, and the Solana Mobile reference wallet can be sideloaded into the emulator for an end-to-end sign-in.

Because the app is a TWA, filming it needs no device either: [Filming three.ws on a Seeker without a Seeker](./seeker-video.md) records the shipping page at the Seeker's real panel geometry and seats it in a device body, and says which moments genuinely have to come from the emulator.

## The home screen widget

Version 1.1 adds **Agent glance**, an Android app widget: your agent's avatar, its name, and how
many moves it made today, refreshed by the system about every 30 minutes without opening the app,
with a tap that opens the agent inside the app. Link the phone from [three.ws/glance](https://three.ws/glance)
(one tap, signed in), then add the widget from the launcher's picker. It keeps the last card it
downloaded when the phone is offline and can be revoked from the same page. Everything about it,
including every state it can be in and how it authenticates, is in
[native-widgets.md](native-widgets.md#android); the native sources are in
[solana-mobile/android-overlay/](../solana-mobile/android-overlay/README.md).

## What is next

Windows 11 already gets the same card through the installed PWA's manifest. macOS and iOS follow
through a shared WidgetKit extension against the same endpoint and widget token; that is Phase 5
of the [roadmap](../README.md#roadmap) and the scoped work order is
[prompts/roadmap/native-widgets.md](../prompts/roadmap/native-widgets.md).
