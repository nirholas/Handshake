# Listing assets

Drop these files into `solana-mobile/publish/media/` (referenced from `config.yaml`). Every asset must be PNG, RGB or RGBA, no transparency on the icon. Use 100% real product UI — Solana dApp Store reviewers reject mocked screenshots.

Every asset here is generated from the repo root:

```bash
npm run build:dapp-store-media      # icon.png, banner.png, feature.png
npm run build:dapp-store-previews   # screen-1..5.png
```

The icon is the shipped app mark flattened onto the brand ground. The banner is the wordmark and listing tagline drawn in a headless browser against the site's own `/fonts/*.woff2`, so the store type is the product's type rather than whatever face the renderer happened to have. The feature graphic is a live capture of a real agent page on three.ws. The five previews are one composition, described below.

| File              | Purpose         | Size            | Required | Notes                                                            |
| ----------------- | --------------- | --------------- | -------- | ---------------------------------------------------------------- |
| `icon.png`        | App icon        | 512 × 512       | yes      | Same image as `/public/pwa-512x512.png`; no transparency.        |
| `banner.png`      | App banner      | 1200 × 600      | yes      | Used in featured rows. Logo + tagline on dark background.        |
| `feature.png`     | Feature graphic | 1024 × 500      | yes      | Hero image — captured agent in three.ws viewer.                  |
| `screen-1.png`    | dApp preview 1  | 1080 × 1920     | yes      | Seeker home screen. Upload first.                                |
| `screen-2.png`    | dApp preview 2  | 1080 × 1920     | yes      | Marketplace grid.                                                |
| `screen-3.png`    | dApp preview 3  | 1080 × 1920     | yes      | Agent page with the 3D viewer.                                   |
| `screen-4.png`    | dApp preview 4  | 1080 × 1920     | yes      | The create chooser.                                              |
| `screen-5.png`    | dApp preview 5  | 1080 × 1920     | yes      | Seed Vault verification card. Upload last.                       |
| `video.mp4`       | Promo video     | ≤ 30 s, ≤ 30 MB | optional | H.264 / AAC; can be omitted for v1.                              |

## The previews are a carousel

The five previews are not five designs. `make-screenshots.mjs` draws one 5400x1920 picture and slices it into five 1080x1920 panels: the glow field, the light beam, and the floor run the length of the strip, and four of the nine phones are centred exactly on a seam, so every upload carries one whole screen plus the two halves it shares with its neighbours. Scrolling the listing reads as one photograph of a shelf of devices.

Consequences worth knowing before touching it:

- **Order is load-bearing.** Uploaded out of order the seam halves stop meeting. Upload `screen-1.png` first through `screen-5.png` last.
- **Every phone is a real capture** of three.ws at Seeker resolution (432 CSS px at 2.5x), taken by Playwright with `reducedMotion: 'reduce'` so the same page twice gives the same frame. Floating product widgets (the corner stack, the walking companion, the marketplace sidebar handle) are hidden for the capture only.
- `--origin=http://localhost:3000` captures the working tree; the dev server proxies `/api` to production so the data stays real. `--keep-raw` writes the untouched captures to `publish/media/raw/`.
- The whole strip is left at `publish/media/carousel.png` for review. It is not an upload.

## Substituting real Seeker captures

A genuine device capture beats a browser capture, and the generator prefers one whenever it exists:

1. Settings → Display → gesture navigation, so no navigation bar crosses the bottom.
2. Open the app and capture with Power + Volume-Down: home screen, marketplace grid, an agent with the 3D viewer, the Seed Vault sheet (showing `three.ws` and a non-empty `Nonce:` line), and the selfie capture screen.
3. Save them as `solana-mobile/publish/media/device/screen-1.png` … `screen-5.png`, 1080x1920 each. A wrong size fails the build rather than being silently rescaled.
4. `npm run build:dapp-store-previews`. Each device file replaces its live capture; the carousel is rebuilt around them.

## Brand consistency

- Surface uses three.ws branding only. Vendor names (Avaturn, RPM, Mixamo, OSOM, Fxtec) must not appear in any screenshot or copy.
- Theme color is `#000000`; background is `#080814`. Do not introduce a third surface color.
- The Solana mark may appear on the Seed Vault sheet but not on the three.ws chrome.
