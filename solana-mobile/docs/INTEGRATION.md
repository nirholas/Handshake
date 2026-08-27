# Wiring the MWA wallet into three.ws

The `solana-mobile/src/` module is designed to be a single-import drop-in. It does nothing on desktop or in non-TWA contexts, and on Seeker it transparently swaps `window.solana` for an MWA-backed wallet that talks to the Seed Vault.

## 1. Install peer deps

From the repo root:

```bash
npm install --save \
  @solana-mobile/mobile-wallet-adapter-protocol \
  @solana-mobile/mobile-wallet-adapter-protocol-web3js
```

`@solana/web3.js` is already a transitive dep of `agent-payments-sdk` and `pump-fun-skills`; nothing else to add.

## 2. Boot the adapter from an app entry

Pick the lowest entry point that runs on every page that signs transactions. For three.ws, the natural place is `src/app.js` (or whichever script is first in the bundle graph for `home.html`, `agent-detail.html`, `account.html`, etc.).

```js
// At the very top of src/app.js, before any wallet code runs:
import './solana-mobile/src/index.js';
```

That's it. On Seeker, `window.solana` is now an `MwaWallet`. On every other platform, the import is a no-op.

## 3. No changes needed to existing call sites

The existing call sites already use the Phantom-shaped API:

- `src/wallet.js` reads `window.solana`, calls `.connect()`, `.on('connect'|'disconnect', …)`.
- `src/onchain/adapters/solana.js` calls `provider.signMessage(bytes, 'utf8')` and posts to `/api/auth/siws/{nonce,verify}`.

Those work unchanged. The `MwaWallet` exposes the same shape; `signMessage` returns `{ signature: Uint8Array }`, `signTransaction` returns a transaction of the same constructor as the input, etc.

The only call that changes shape is `provider.isPhantom` — we deliberately set it to `false` so legacy "only Phantom" branches don't try to treat the MWA wallet as Phantom. If you have code that gates on `isPhantom`, replace those checks with `provider.isThreeWs || provider.isPhantom`.

## 4. One-tap Sign-In With Solana (SIWS)

On the Seed Vault, `connect()` + `signMessage()` costs the user **two** prompts. `MwaWallet.signIn()` collapses authorization and the SIWS signature into a **single** wallet interaction using the MWA `sign_in_payload`. The wallet builds the canonical CAIP-122 SIWS message itself and returns the exact bytes it signed, so you forward them straight to `/api/auth/siws/verify`:

```js
const provider = window.threeWsWallet;
if (provider?.supportsSignIn) {
  const siws = await provider.signIn({
    domain: location.host,
    statement: 'Link this wallet to deploy your agent on Solana.',
    uri: location.origin,
    version: '1',
    chainId: 'mainnet',
    nonce,          // from /api/auth/siws/nonce
    issuedAt: new Date().toISOString(),
  });
  if (siws) {
    // siws.signedMessageText + base64(siws.signature) → /api/auth/siws/verify
  } else {
    // Older wallet without authorize-time sign-in — fall back to signMessage.
  }
}
```

`signIn()` returns `null` when the connected wallet doesn't support authorize-time sign-in; callers fall back to the two-step path. This is already wired in `src/onchain/adapters/solana.js#ensureLinkedViaSiws` — the injected wallets (Phantom/Backpack/Solflare) skip it (`supportsSignIn` is undefined) and Seed Vault gets the one-tap flow, with a graceful two-step fallback on any non-rejection failure.

## 5. Normalized errors

Every signing path routes failures through `normalizeMwaError()` (`solana-mobile/src/mwa-errors.js`), which returns an `MwaError` with a stable `reason` slug and a human `userMessage`. A user decline (MWA protocol `-1`/`-3`, adapter `ERROR_ASSOCIATION_CANCELLED`) carries `code === 4001`, so existing `err?.code === 4001` call sites treat a Seed Vault cancel exactly like a Phantom cancel. Non-decline faults (`WALLET_NOT_FOUND`, `SECURE_CONTEXT_REQUIRED`, `SESSION_TIMEOUT`, …) keep their own reason and never masquerade as a cancel. Use `isUserRejection(err)` to branch.

## 6. (Optional) Surface "Sign in with Seed Vault" affordances

If you want the in-product UI to read "Sign in with Seed Vault" instead of "Connect wallet" when the user is on Seeker:

```js
import { isSolanaMobileTwa, isSolanaMobileDevice, isMwaSupported } from './solana-mobile/src/seeker-detect.js';

const label = isSolanaMobileTwa() || isSolanaMobileDevice()
  ? 'Sign in with Seed Vault'
  : 'Connect wallet';

// Offer the affordance even in a Seeker's regular browser (outside the TWA):
if (await isMwaSupported()) { /* show the Seed Vault option */ }
```

`isSolanaMobileTwa()` is strict (returns true only inside the dApp Store app). `isSolanaMobileDevice()` is loose (returns true on any Seeker, even in regular Chrome). `isMwaSupported()` is an async capability probe (Android + secure context + the transport loads). Use the loose/probe ones for affordance hints, the strict one for behavioural changes.

## 7. Server-side: nothing changes

The signatures that `MwaWallet.signMessage` and `signIn` produce are standard ed25519 over the SIWS message, which is exactly what `/api/auth/siws/verify` already validates. No server changes required.

## 8. Testing

The wrapper's logic is unit-tested against a fake transport (no device needed) — run:

```bash
npx vitest run tests/solana-mobile-mwa-wallet.test.js \
  tests/solana-mobile-mwa-errors.test.js \
  tests/solana-mobile-seeker-detect.test.js
```

These cover authorize/reauthorize/resume, one-tap `signIn`, sign/sign-all/send, error normalization (decline → 4001), disconnect, session persistence, and detection false-positive/negative boundaries.

On-device signing (the Seed Vault sheet itself) still needs real hardware. What you _can_ additionally spot-check on desktop:

```js
// In any browser console on https://three.ws:
import('/src/solana-mobile/src/seeker-detect.js').then(m => console.log({
  twa: m.isSolanaMobileTwa(),
  device: m.isSolanaMobileDevice(),
}));
// Both should be false on desktop.
```

For end-to-end testing, build the APK with `scripts/build-apk.sh`, sideload it via `adb install build/three-ws-release.apk`, and run through the flows on a Seeker.

## 9. Failure modes & how the wrapper handles them

| Scenario                                | Behaviour                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| User cancels the Seed Vault sheet       | Rejects with an `MwaError`, `reason: 'USER_REJECTED'`, `code: 4001` — indistinguishable from a Phantom cancel to callers. |
| Auth token revoked (e.g. wallet wiped)  | `reauthorize` fails on connect OR on any signing call: the wrapper clears the stored token, emits `disconnect`, and the next call authorizes from scratch. |
| MWA library fails to load (offline)     | `loadTransact()` rejects; the caller sees a `MwaWallet#connect` rejection with the original error.|
| Page reload, app suspend, or Android killing the TWA process | `localStorage` retains `authToken`; next sign uses `reauthorize` (no prompt for the user). |
| Two tabs of the TWA simultaneously open | MWA serialises transactions per app — second tab waits for the first to release the connection.   |

## 10. Share a photo or a GLB into three.ws

three.ws is an Android Web Share Target. From any app on the Seeker (gallery, camera, file manager, a chat), pick "Share", choose three.ws, and the file lands directly in the right creation flow, already attached.

**How it works**

1. The web manifest (`vite.config.js`, `share_target`) and the TWA manifest (`solana-mobile/twa/twa-manifest.json`, `shareTarget`) register `POST /create/share` (multipart, file field `media`, accepting JPEG/PNG/WebP and `.glb` / `model/gltf-binary`). Bubblewrap turns the second one into the Android share activity; the first one covers a plain installed PWA.
2. Android opens the app on `/create/share` with the files in the POST body. No server ever receives it: the service worker (`public/share-target-sw.js`, pulled into the Workbox SW via `importScripts`) intercepts the request.
3. The worker reads the form, stores every `media` file in the Cache API cache `threews-share-target` under `/_share/0`, `/_share/1`, ... (with `x-share-filename` and `x-share-received` headers) and the title/text/url fields under `/_share/meta`, then answers `303` to:
   - `/create/selfie?shared=1` when the first file is an image,
   - `/create?shared=glb` when it is a `.glb`,
   - `/create?shared=1` for anything else,
   - `/create?shared=error` if reading the form failed (the page shows a retry hint), or `/create` when nothing was attached.
4. The landing page calls `takeSharedFiles()` from `src/shared/share-target.js`. It rebuilds `File` objects from the cache, drops anything older than ten minutes, and deletes what it consumed: one share, one handoff. `/create/selfie` fills the frontal slot, then left and right, with the shared images; `/create` feeds the `.glb` straight into the same upload path as the "Upload GLB" card. Both then strip `?shared=` from the address bar so a reload is a normal page load.

**Testing with adb**

Push a file to the device, then fire the share intent at the TWA's launcher activity (Bubblewrap generates `LauncherActivity` inside the `ws.three.app` package; confirm with `adb shell dumpsys package ws.three.app | grep -A2 SEND` after installing):

```bash
adb push ./selfie.jpg /sdcard/Download/selfie.jpg
adb shell am start -a android.intent.action.SEND -t image/jpeg \
  --eu android.intent.extra.STREAM file:///sdcard/Download/selfie.jpg \
  -n ws.three.app/.LauncherActivity
```

For a GLB, replace the type and path:

```bash
adb push ./avatar.glb /sdcard/Download/avatar.glb
adb shell am start -a android.intent.action.SEND -t model/gltf-binary \
  --eu android.intent.extra.STREAM file:///sdcard/Download/avatar.glb \
  -n ws.three.app/.LauncherActivity
```

Expected: the app opens on `/create/selfie` with the photo in the frontal slot, or on `/create` with the GLB check running and the review screen following. If the app opens on `/create?shared=error`, inspect the SW console (`chrome://inspect` on a tethered desktop) for `[share-target-sw]`.

Desktop check without a device: `npx vitest run tests/share-target.test.js` exercises the worker's routing and the cache round trip.
