# `solana-mobile/` — three.ws on the Seeker dApp Store

This directory contains everything needed to package three.ws as a Solana Mobile (Seeker / Saga) app and publish it to the on-chain dApp Store.

## Layout

```
solana-mobile/
├── pwa/                      # PWA manifest + offline fallback (mirrors the live site)
├── twa/twa-manifest.json     # Bubblewrap input — wraps three.ws as an Android TWA
├── well-known/               # assetlinks.json template (real file lives at /public/.well-known/)
├── src/                      # MWA wallet wrapper (drop-in for the existing Solana code)
│   ├── seeker-detect.js      #   conservative "are we inside the TWA" detector
│   ├── mwa-wallet.js         #   Phantom-shaped wallet backed by the on-device Seed Vault
│   ├── index.js              #   single-import boot — sets window.solana when on Seeker
│   └── package.json          #   declares MWA peer/runtime deps
├── scripts/
│   ├── init-publisher.sh     # one-time: mint Publisher + App NFTs on Solana
│   ├── build-apk.sh          # generate keystore (if needed), build + sign release APK
│   ├── update-assetlinks.sh  # refresh /public/.well-known/assetlinks.json from the keystore
│   └── publish.sh            # mint Release NFT + submit to the dApp Store
├── publish/                  # solana-mobile/dapp-store-cli config + listing copy
│   ├── config.yaml
│   └── listing/
│       ├── description.md
│       ├── short-description.txt
│       ├── new-in-version.txt
│       └── saga-features.md
└── docs/
    ├── ASSETS.md             # exact pixel specs for icon/banner/screenshots
    ├── CHECKLIST.md          # end-to-end submission checklist
    └── INTEGRATION.md        # how to wire src/index.js into the three.ws build
```

## Quickstart

The MWA wallet is already wired into the bundle — `src/wallet.js` and
`src/game/play-auth.js` import `solana-mobile/src/index.js`, and
`@solana-mobile/mobile-wallet-adapter-protocol-web3js` is a root dependency.

```bash
# 1. One-time: mint the on-chain Publisher + App NFTs (mainnet, costs ~0.05 SOL).
cd solana-mobile
SOLANA_KEYPAIR=~/.config/solana/publisher.json ./scripts/init-publisher.sh
# Commit the addresses written into publish/config.yaml.

# 2. Build the signed APK (creates the keystore on first run — back it up!).
#    Runs unattended: passwords reach Bubblewrap via env vars, the Android
#    project is regenerated from twa/twa-manifest.json with `bubblewrap
#    update`, and ACCEPT_ANDROID_SDK_LICENSES=1 clears the first-run SDK
#    license gate on a fresh machine.
KEYSTORE_PASSWORD='your-strong-pass' ACCEPT_ANDROID_SDK_LICENSES=1 ./scripts/build-apk.sh
# This also writes /public/.well-known/assetlinks.json with the real fingerprint.

# 3. Deploy three.ws so the assetlinks.json is live (npm run deploy:gcp from
#    the repo root — production is Cloud Run).
curl -fsSL https://three.ws/.well-known/assetlinks.json | jq .

# 4. Submit the release.
SOLANA_KEYPAIR=~/.config/solana/publisher.json \
DAPP_STORE_API_KEY='your-api-key' \
./scripts/publish.sh
```

For subsequent releases, only steps 2 and 4 are needed (bump `appVersionCode`
/ `appVersionName` in `twa/twa-manifest.json`, or pass `VERSION_CODE` /
`VERSION_NAME` env overrides). Releases are run locally by the owner — this
repo does not use GitHub Actions.

## What was NOT added to the bundle (intentional)

- **Promo video** — optional for v1, can be added later via `publish/media/video.mp4`.
- **Screenshots** — must be captured on a real Seeker device (see `docs/ASSETS.md`); no placeholders are checked in because reviewers reject them.
- **Privacy policy + EULA pages** — these are content for the main three.ws site, not this bundle. They must be live at `/legal/privacy` and `/legal/eula` before submission.

## See also

- `docs/CHECKLIST.md` — the only doc you need open during submission.
- `docs/INTEGRATION.md` — what to add to `src/app.js`.
- `docs/ASSETS.md` — pixel specs and capture instructions.
- Solana Mobile official docs: <https://docs.solanamobile.com/dapp-publishing/intro>
