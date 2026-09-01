# Publishing three.ws to the Solana dApp Store

How a release of the three.ws Seeker app gets from this repo onto the Solana dApp Store. This is the runbook; the app itself and what it adds over the website are described in [three.ws on Solana Seeker](./seeker-app.md), and the box-by-box submission gate lives in [solana-mobile/docs/CHECKLIST.md](../solana-mobile/docs/CHECKLIST.md). If you are the owner sitting down to actually submit, follow [Submission day](./seeker-submission-day.md) instead: it inlines every field and value so you never open a file.

**Status: v1.0.0 is live on the Solana dApp Store** (submitted 2026-08-28, release `#331044442814`, versionCode 1, package `ws.three.app`). What the portal recorded, including the release NFT mint and app collection, is in [Submission day](./seeker-submission-day.md).

Publishing changed shape in May 2026. `dapp-store-cli` 1.0 is **Publisher Portal backed**: the publisher identity, KYC, the App NFT, and all listing copy live in <https://publish.solanamobile.com>, and the CLI only uploads one signed APK per release. The old `dapp-store create publisher` / `create app` / `publish submit` chain is gone. Anything that still describes that flow is out of date.

## Who does what

| Step | Who | Where |
|---|---|---|
| Publisher profile, KYC/KYB, App NFT, API key | Owner, once | Publisher Portal (browser) |
| Screenshots on a physical Seeker | Owner, per listing change | Real device |
| Keystore restore and APK build | Any agent, per release | This repo |
| Uploading the release | Owner, per release | Publisher Portal, or the CLI |

Everything scriptable is in [solana-mobile/scripts/](../solana-mobile/scripts/). The parts that need a human need an identity, a funded wallet, or a phone.

## One-time setup (owner, in the portal)

1. Create the publisher profile at <https://publish.solanamobile.com> and submit KYC/KYB. Approval gates everything below.
2. Connect the publisher wallet (Phantom, Solflare, or Backpack extension). Fund it with **at least 0.2 SOL** to cover the App NFT, each release NFT, and ArDrive upload fees.
3. Choose a storage provider. ArDrive is the recommended default.
4. **Add a dApp**, filling every field from the repo rather than from memory, so the portal and git never drift:
   - identity and URLs: [solana-mobile/publish/config.yaml](../solana-mobile/publish/config.yaml)
   - listing text: [solana-mobile/publish/listing/](../solana-mobile/publish/listing/) (long description, short description, what's-new, Seeker features)
   - media: [solana-mobile/publish/media/](../solana-mobile/publish/media/) (icon, banner, and feature graphic are committed; screenshots are not, see below)

   Completing this mints the **App NFT**. The portal matches later uploads to this app by Android package name, `ws.three.app`.
5. Settings → API keys → create one. Store it in the owner's password manager; it never goes in the repo.

## Per release (in this repo)

The release keystore is gitignored and lives in Secret Manager. The 2026-08-10 key was lost with the codespace that generated it, so a new one was created on 2026-08-27 and backed up properly. **Never generate a second key while this one exists**: the dApp Store identifies the app by its signing certificate, and losing it means the app can never be updated.

**Two ways to upload the release, and the browser one is preferable.** The portal's **New Version** page accepts the APK as a file or as a public URL and signs the release NFT with the wallet already connected in the browser. The CLI path below does the same thing but needs the publisher wallet's private key exported to a keypair file on disk, which is a real risk for no gain on a normal release. v1.0.0 went in through the browser, by URL, from the `v1.0.0` GitHub release.

Either way the APK has to exist and be signed first:

```bash
cd solana-mobile

# 1. Restore the keystore and its password.
gcloud secrets versions access latest --secret three-ws-seeker-release-keystore \
  --project aerial-vehicle-466722-p5 | base64 -d > android.keystore
export SOLANA_MOBILE_KEYSTORE_PASSWORD="$(gcloud secrets versions access latest \
  --secret three-ws-seeker-keystore-password --project aerial-vehicle-466722-p5)"

# 2. On a machine with no Android toolchain (a fresh codespace), stage one.
./scripts/setup-android-sdk.sh

# 3. Build the signed APK. Also rewrites /public/.well-known/assetlinks.json
#    with this keystore's SHA-256 fingerprint.
KEYSTORE_PASSWORD="$SOLANA_MOBILE_KEYSTORE_PASSWORD" ACCEPT_ANDROID_SDK_LICENSES=1 \
  ./scripts/build-apk.sh

# 4. Deploy three.ws so the assetlinks file is live for this key, then confirm
#    Google can see it (deploy runbook: CLAUDE.md, or docs/ops/gcp-production.md).
curl -fsSL https://three.ws/.well-known/assetlinks.json | jq .
curl -fsSL 'https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://three.ws&relation=delegate_permission/common.handle_all_urls'

# 5. Submit.
SOLANA_KEYPAIR=~/.config/solana/publisher.json \
DAPP_STORE_API_KEY='<portal API key>' \
./scripts/publish.sh
```

[scripts/publish.sh](../solana-mobile/scripts/publish.sh) checks that assetlinks is reachable, refuses a `versionCode` it already shipped from this machine, passes the API key over stdin so it never appears in a process listing, uploads the APK, mints the release NFT, and submits for review. If the upload dies part way through, resume it with `npx --no-install dapp-store resume --release-id <id>` rather than starting over.

For a later release, bump `appVersionCode` and `appVersion` in [solana-mobile/twa/twa-manifest.json](../solana-mobile/twa/twa-manifest.json) (or pass `VERSION_CODE` / `VERSION_NAME`), then repeat steps 3 and 5. The store rejects a reused `versionCode`.

Releases are run locally by the owner. This repo does not use GitHub Actions.

## Step 4 is not optional

Digital Asset Links are what make the app run full-screen. Until `https://three.ws/.well-known/assetlinks.json` serves the fingerprint of the key that signed the APK, Chrome cannot verify the Trusted Web Activity and falls back to a custom tab with a visible address bar, which reviewers see as an unfinished app.

Two traps, both observed on 2026-08-28:

- **The header must be short-lived.** `.well-known/*` is served with `max-age=3600`. A day-long TTL means a rotated key stays unverified for up to a day after the deploy.
- **Chrome caches a failed verification.** After the correct assetlinks goes live, an already-installed app can keep showing the address bar until Chrome's cache clears. Force it with `adb shell pm clear com.android.chrome`, or `adb shell pm verify-app-links --re-verify ws.three.app` followed by `adb shell pm get-app-links ws.three.app`, which should print `three.ws: verified`.

## Listing media

Everything the portal asks for is generated and committed under [solana-mobile/publish/media/](../solana-mobile/publish/media/):

```bash
npm run build:dapp-store-media      # icon.png, banner.png, feature.png, editors-choice.png
npm run build:dapp-store-previews   # screen-1..5.png (the carousel)
```

`build:dapp-store-media` writes the 512x512 icon from the shipped app mark, the 1200x600 banner (the wordmark drawn in a browser against the site's own Space Grotesk files, so store type matches product type), the 1024x500 feature graphic (a live capture of a real agent page), and the 1200x1200 Editor's Choice card for the store's featured carousel.

`build:dapp-store-previews` builds the five 1080x1920 previews as one 5400x1920 composition and slices it. Four of its nine phones sit exactly on a seam, so each upload carries one whole screen plus the two halves it shares with its neighbours and the strip reads as a single photograph while scrolling. **Upload them in numbered order** or the halves stop lining up. Every phone holds a real capture of three.ws at Seeker resolution; nothing is mocked or drawn to look like product UI.

Two useful flags: `--origin=http://localhost:3000` captures the working tree instead of production (the dev server proxies `/api` to production, so the data stays real), and `--keep-raw` also writes the untouched captures to `publish/media/raw/` for inspection.

To ship true on-device frames instead, drop 1080x1920 Seeker captures into `publish/media/device/` as `screen-1.png` … `screen-5.png` and rerun: each one replaces its live capture and the carousel is rebuilt around it. Frame-by-frame guidance is in [solana-mobile/docs/ASSETS.md](../solana-mobile/docs/ASSETS.md).

## Verifying a build before submitting

Most of the app can be checked in a stock Android emulator; the recipe is in [solana-mobile/README.md](../solana-mobile/README.md#emulator-qa). What the emulator does prove: install, full-screen launch, home-screen shortcuts, app-link verification state, the service worker registering, the MWA association reaching a wallet (with Solana Mobile's reference wallet sideloaded), and that the share target is registered with the right MIME types.

What it cannot prove, and therefore what a physical Seeker is still for:

- **The Seed Vault sheet itself**, and a completed one-tap SIWS sign-in. The emulator's Chrome shows an unverified-intent interstitial that interrupts the MWA handshake; a verified TWA on current Chrome does not.
- **A real share.** `adb shell am start --grant-read-uri-permission` cannot confer a MediaStore URI grant, so the receiving app throws `SecurityException` before any web code runs. A genuine share from Photos grants the URI first. The web half of that flow is covered by `tests/share-target.test.js` and by the live `POST /create/share` fallback.
- **A mainnet transaction** approved in the secure element.

## After submitting

Review results arrive by email from `publishersupport@dappstore.solanamobile.com` within 3 to 5 business days; the portal dashboard shows status in the meantime. On approval, check that the public listing renders all five screenshots and the feature graphic, then add a [data/changelog.json](../data/changelog.json) entry announcing it.
