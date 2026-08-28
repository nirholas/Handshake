# Google Play developer page

Everything the Play Console asks for under **Developer account -> Developer
page**, with the artwork generated from the brand source rather than exported by
hand. Regenerate the images with:

```bash
npm run build:play-assets
```

That runs [`scripts/render-play-assets.mjs`](../../scripts/render-play-assets.mjs)
and writes both files into `public/brand/play/`.

## What Play asks for, and what to upload

| Console field | Play's spec | Upload |
| --- | --- | --- |
| Developer icon | JPEG or 24-bit PNG (not transparent), 512 x 512, up to 1 MB | `public/brand/play/three-ws-play-developer-icon-512x512.png` |
| Header image | JPEG or 24-bit PNG (not transparent), 4096 x 2304, up to 1 MB | `public/brand/play/three-ws-play-header-4096x2304.png` |
| Developer website | Any URL | `https://three.ws` |
| Developer email address | Public on the listing | `support@three.ws` |
| Promotional text | Up to 140 characters | See below |
| Featured app | Optional, needs a published app | Leave unset until the first app ships |

### Promotional text

Shown at the bottom of the developer page, 140 characters maximum. Use this one:

```
Give your AI a body. Create rigged 3D avatars in seconds, embed them anywhere, and let your agents earn on the open web.
```

That is 120 characters, opening on the site's own tagline (`site.tagline` in
[`data/pages.json`](../../data/pages.json)) so the store page and the site say
the same thing. Two alternates, both inside the limit, if the emphasis should
sit on the developer surface instead:

```
Give your AI a body. Build, embed, and monetize autonomous AI agents with real 3D avatars, on-chain identity, and pay-per-call APIs.
```

```
three.ws gives your AI a body: rigged 3D avatars, on-chain identity, and pay-per-call APIs for autonomous agents on the open web.
```

Keep it to what the platform does. The store listing is not the place to
promote a token.

## Why the generator exists rather than a hand export

Play rejects an upload outright when a constraint is missed, and the two easy
ones to miss are both invisible in a preview:

- **24-bit, not transparent.** A PNG written by a canvas is always 32-bit RGBA,
  so the alpha channel has to be stripped deliberately. Both files are asserted
  to be 3-channel before they are written.
- **1 MB ceiling.** Asserted on the actual byte length, not estimated.

Dimensions are asserted too. A wrong file fails in the terminal instead of in
the Console.

Two artwork decisions are worth knowing about:

- **The header is the wordmark centred on black**, drawn by
  [`scripts/render-wordmark.mjs`](../../scripts/render-wordmark.mjs) against the
  same Space Grotesk files the site serves, so the banner can never drift from
  the product's typography. It is centred by the pixels that actually landed
  rather than by the font metrics that predicted them. Details in
  [`marketing/brand/README.md`](../../marketing/brand/README.md).
- **The developer icon is inset to 82%.** Play masks it to a circle, and the
  shipped app mark (`public/pwa-512x512.png`) is drawn edge to edge, so at full
  bleed the cube's vertices clip.

## Before any of this can be saved

The developer page fields sit behind Android developer verification: the account
owner has to open the Play Console app on a physical Android device, sign in as
the owner account, and pick the `three.ws` developer account. There is no
desktop or emulator path, by design. Until that clears, the Console shows the
setup banner instead of saving the profile.
