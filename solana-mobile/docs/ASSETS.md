# Listing assets

Drop these files into `solana-mobile/publish/media/` (referenced from `config.yaml`). Every asset must be PNG, RGB or RGBA, no transparency on the icon. Use 100% real product UI — Solana dApp Store reviewers reject mocked screenshots.

`icon.png`, `banner.png`, and `feature.png` are generated: run `node solana-mobile/scripts/make-media.mjs` from the repo root. The icon is the flattened PWA icon, the banner is composed from the vector logo plus the listing tagline, and the feature graphic is a live Playwright capture of a real agent page on three.ws. Only the five screenshots below require a physical Seeker.

| File              | Purpose         | Size            | Required | Notes                                                            |
| ----------------- | --------------- | --------------- | -------- | ---------------------------------------------------------------- |
| `icon.png`        | App icon        | 512 × 512       | yes      | Same image as `/public/pwa-512x512.png`; no transparency.        |
| `banner.png`      | App banner      | 1200 × 600      | yes      | Used in featured rows. Logo + tagline on dark background.        |
| `feature.png`     | Feature graphic | 1024 × 500      | yes      | Hero image — captured agent in three.ws viewer.                  |
| `screen-1.png`    | Screenshot      | 1080 × 1920     | yes      | Discover feed on Seeker.                                         |
| `screen-2.png`    | Screenshot      | 1080 × 1920     | yes      | Agent detail with 3D viewer.                                     |
| `screen-3.png`    | Screenshot      | 1080 × 1920     | yes      | Selfie capture flow.                                             |
| `screen-4.png`    | Screenshot      | 1080 × 1920     | yes      | Seed Vault sign sheet (SIWS approval).                           |
| `screen-5.png`    | Screenshot      | 1080 × 1920     | yes      | "Minted" confirmation showing wallet address.                    |
| `video.mp4`       | Promo video     | ≤ 30 s, ≤ 30 MB | optional | H.264 / AAC; can be omitted for v1.                              |

## Capture instructions

1. Open three.ws on a real Seeker device (or Saga, or Android emulator with frame size 1080 × 1920).
2. Hide the system navigation bar (Settings → Display → Gesture navigation), so screenshots show only the app chrome.
3. Use the device's native screenshot binding (Power + Vol-Down) for every frame. Do not use the desktop Chrome devtools mobile emulator — reviewers can tell.
4. For the Seed Vault sheet, capture during a real SIWS sign-in to `https://three.ws/api/auth/siws/verify`. The sheet must show `three.ws` as the requesting origin and a non-empty `Nonce: …` line.
5. Drop the resulting PNGs into `solana-mobile/publish/media/` with the exact filenames above.

## Brand consistency

- Surface uses three.ws branding only. Vendor names (Avaturn, RPM, Mixamo, OSOM, Fxtec) must not appear in any screenshot or copy.
- Theme color is `#000000`; background is `#080814`. Do not introduce a third surface color.
- The Solana mark may appear on the Seed Vault sheet but not on the three.ws chrome.
