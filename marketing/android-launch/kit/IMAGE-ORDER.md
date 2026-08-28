# Image insertion order

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
