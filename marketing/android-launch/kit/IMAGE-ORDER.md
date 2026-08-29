# Image insertion order

**X changed the four-image layout on 2026-08-28.** It is no longer a 2x2 collage;
it is a swipe carousel that shows one image at a time in a fixed cell of about
1.18:1 and center-crops each image to fit. The 16:9 grid tiles below lose both
edges in it. Use the strip instead.

## The strip (current)

`npm run build:x-strip` draws one 4800x1020 scene and cuts it into four
1200x1020 tiles, the cell's own shape, so nothing is cropped and swiping reads
as one continuous picture. Attach in this order:

| Swipe | File |
| --- | --- |
| 1st | `strip/01-left.png` |
| 2nd | `strip/02.png` |
| 3rd | `strip/03.png` |
| 4th | `strip/04-right.png` |

`strip/android-launch-strip.png` is the uncut scene, for reference and for any
surface that takes one wide image.

## The grid (kept for a 2x2 collage, if X brings it back)

X lays four images out in a 2x2 grid and fills it in UPLOAD ORDER. Attach them
in exactly this sequence or the composition reassembles wrong:

| Slot | File |
| --- | --- |
| top left | `images/01-top-left.png` |
| top right | `images/02-top-right.png` |
| bottom left | `images/03-bottom-left.png` |
| bottom right | `images/04-bottom-right.png` |

Each tile is 2048x1152 (16:9), the same aspect as the cell it lands in, so X
crops nothing. `android-launch-master-16x9.png` is the uncut composition, for
reference and for surfaces that take a single image.

Regenerate with `npm run build:x-grid`.
