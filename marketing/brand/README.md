# three.ws brand assets

The source of truth for the three.ws marks. Everything served at
[`/press`](../../pages/press/index.html) and everything inside
`public/brand/three-ws-press-kit.zip` is rendered from the one file in this
directory, so a change lands everywhere at once instead of drifting across
half a dozen hand-exported PNGs.

| File | What it is |
| --- | --- |
| [`brand-assets.html`](brand-assets.html) | Layout source. Each `.asset` element is one exported file. |
| `../openai-select-partner/cards/three-ws-mark.png` | The cube artwork the lockups are built from: `public/pwa-512x512.png` (the shipped app icon) trimmed of its transparent margin. |

## Rendering

```bash
npm run build:brand-assets
```

That runs [`scripts/render-brand-assets.mjs`](../../scripts/render-brand-assets.mjs),
which serves the repo over HTTP (so `/fonts/*.woff2` resolve exactly as in
production), screenshots each element with `omitBackground`, and writes:

| Output | Size | Use |
| --- | --- | --- |
| `public/brand/three-ws-mark.png` | 897 × 1024 | The mark alone. |
| `public/brand/three-ws-lockup-on-dark.png` | 1590 × 400 | Cube + wordmark, light type. |
| `public/brand/three-ws-lockup-on-light.png` | 1590 × 400 | Cube + wordmark, dark type. |
| `public/brand/three-ws-stacked-on-dark.png` | 793 × 864 | Stacked, light type. |
| `public/brand/three-ws-stacked-on-light.png` | 793 × 864 | Stacked, dark type. |
| `public/brand/three-ws-press-kit.zip` | ~5.5 MB | All of the above, the OpenAI announcement graphics, and a README with the usage rules. |

Commit the regenerated files with the source change. They ship with the site,
so `/press` and the zip are always the current artwork.

## Full-bleed wordmark

The lockups above are trimmed artwork sized to themselves. When a slot wants an
exact canvas instead (a wallpaper, a title card, a stage backdrop, a store
banner), render the wordmark centred on one:

```bash
npm run build:wordmark
```

That runs [`scripts/render-wordmark.mjs`](../../scripts/render-wordmark.mjs) and writes:

| Output | Size | Use |
| --- | --- | --- |
| `public/brand/three-ws-wordmark-on-dark-4096x2304.png` | 4096 x 2304 | White type on black. The default. |
| `public/brand/three-ws-wordmark-on-light-4096x2304.png` | 4096 x 2304 | Dark type on white. |
| `public/brand/three-ws-wordmark-transparent-4096x2304.png` | 4096 x 2304 | White type, alpha ground, to drop on your own colour. |

Any canvas and framing:

```bash
node scripts/render-wordmark.mjs --width=1920 --height=1080 --fit=0.5
node scripts/render-wordmark.mjs --variants=on-dark --out=/tmp/banner
```

`--fit` is the wordmark's ink width as a fraction of canvas width (default
`0.46`, which leaves roughly a quarter of the width clear on each side).

Three details are load-bearing:

- The type is drawn on a 2D canvas rather than screenshotted, so the file is
  exactly the pixel size asked for with no crop or rounding.
- It is centred by the pixels that actually landed, not by the font metrics that
  predicted them: the renderer draws once, reads back the alpha channel, and
  redraws with the correction. Metrics and the rasteriser disagree by a pixel or
  two, and lowercase with ascenders and no descenders rides visibly low when its
  line box is centred instead of its ink box.
- The two opaque variants ship with the alpha channel stripped. A store banner
  slot (Play's feature graphic among them) rejects 32-bit PNG outright.

## Why it renders in a browser

The wordmark is set in Space Grotesk, the display face the site already uses.
Rendering it through the same font files the site serves means the lockup can
never drift from the product's own typography, and a missing font is a loud
failure (the renderer exits non-zero when any asset request fails) rather than a
silent fallback that ships a wrong-looking logo.

Two details in the CSS are load-bearing:

- `width: max-content` on `.asset`, so the exported box wraps the artwork instead
  of clipping the wordmark at the viewport edge.
- `padding-right` on `.word`, which restores the side bearing that negative
  letter-spacing pulls past the glyph. Without it the final `s` is sheared off by
  a tight element screenshot.

## Usage rules

These are the rules published on `/press`, repeated here because this is where
someone adding a new asset will look:

1. Use the files as they are. No recolouring, outlining, stretching, rotating, or
   rebuilding the cube from parts.
2. Leave at least half the cube's height of clear space on every side.
3. Write the name lowercase: three.ws.
4. Do not lock the mark to another logo without asking.
5. Editorial use is granted. Using the mark as a product mark, or in a way that
   implies three.ws endorses a product, is not.

Adding an asset means adding an element to `brand-assets.html`, a row to
`ASSETS` in the renderer, and a card to the marks grid on
[`pages/press/index.html`](../../pages/press/index.html).
