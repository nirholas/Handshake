#!/usr/bin/env node
/**
 * Builds the Android launch announcement as ONE composition sliced into the
 * four images X lays out in a 2x2 grid.
 *
 * The trick is a property of rectangles: every quadrant of a rectangle has the
 * same aspect ratio as the whole. So a 16:9 master cut in four gives four 16:9
 * tiles, X drops each into a cell of its 2x2 collage without cropping, and the
 * post reassembles into the picture that was drawn. Same idea as the Seeker
 * carousel in solana-mobile/scripts/make-screenshots.mjs, which slices a strip
 * for a horizontally scrolling store listing; this slices a plane.
 *
 * Two things follow from that and are load-bearing:
 *
 *   1. Upload order is the layout. X fills its grid 1,2 across the top and 3,4
 *      across the bottom, in upload order. IMAGE-ORDER.md is written beside the
 *      tiles so the order cannot be lost between here and the post.
 *   2. Every tile has to survive alone, and nothing solid may cross a cut.
 *      Someone tapping one image sees only it, clients that do not render the
 *      collage show them as a list, and the collage itself puts a gutter
 *      between the cells. An object centred on a seam therefore reads as broken
 *      rather than continuous, which is the opposite of how the same trick
 *      behaves in a store carousel that shows one panel at a time. Each
 *      quadrant holds whole subjects; only the glow, beam and floor cross.
 *
 * The phones hold real captures of the shipping product, reused from the
 * Play listing run (`make-screenshots.mjs --target=play --keep-raw`), so the
 * announcement cannot show UI the app does not have.
 *
 * Usage:
 *   npm run build:x-grid
 *   node scripts/make-x-grid.mjs --out=/tmp/grid
 */
import sharp from 'sharp';
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'solana-mobile/publish-play/media/phone/raw');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
	const m = a.match(/^--([^=]+)(?:=(.*))?$/);
	return m ? [m[1], m[2] ?? true] : [a, true];
}));
const OUT = args.out ? path.resolve(String(args.out)) : path.join(ROOT, 'marketing/android-launch/kit/images');

/* 16:9 master, so each 2048x1152 quadrant is 16:9 too. X caps an upload well
   above this, and the tiles stay crisp when a client renders them full width. */
const W = 4096;
const H = 2304;
/* Pure black, matching X's dark timeline. Any lighter ground draws four
   visible rectangles into the feed and the seams announce themselves; at
   #000000 the gutters vanish and the composition floats. Everything that
   lights the scene must therefore fall off to true black before it reaches a
   tile edge, which is why the ground below is radial glows over black rather
   than a filled gradient.

   The glows are also kept dim on purpose. The gutter itself is pure black, so
   wherever the composition is brighter than black the gap shows as a line
   through it. Low contrast across a seam makes that line disappear; a bright
   field makes it a visible crosshair. */
const BG = '#000000';

/* X's collage container is not documented and has changed before. Whatever
   aspect it uses, each cell inherits it, so a quadrant can only ever be
   trimmed slightly on one axis. Nothing that carries meaning goes within this
   many pixels of a quadrant's own edge. */
const SAFE = 96;

/* Room each headline half has on its own side of the seam: half the canvas,
   less the tile keep-out and the 44px that opens the word space at the cut. */
const HALF_ROOM = W / 2 - SAFE - 44;

/* Ceilings for the two properties asserted after the render. */
const BORDER_MAX = 6;
const SEAM_MAX = 40;

const FONT_FACES = [
	['Space Grotesk', '300 700', 'space-grotesk-latin.woff2'],
	['Inter', '300 800', 'inter-latin.woff2'],
].map(([family, weight, file]) => `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};src:url(data:font/woff2;base64,${readFileSync(path.join(ROOT, 'public/fonts', file)).toString('base64')}) format('woff2');}`).join('\n');

const MARK_URI = `data:image/png;base64,${readFileSync(path.join(ROOT, 'public/pwa-512x512.png')).toString('base64')}`;

/** The product screens, one per phone. Raws come from the Play listing run. */
const SCREENS = ['screen-2', 'screen-3', 'screen-4', 'screen-5'];
const missing = SCREENS.filter((s) => !existsSync(path.join(RAW, `${s}.png`)));
if (missing.length) {
	throw new Error(
		`[x-grid] missing raw captures: ${missing.join(', ')}\n` +
		'Run: node solana-mobile/scripts/make-screenshots.mjs --target=play --keep-raw',
	);
}
const shots = Object.fromEntries(SCREENS.map((s) => [s, `data:image/png;base64,${readFileSync(path.join(RAW, `${s}.png`)).toString('base64')}`]));

/**
 * Phones, anchored to a quadrant centre and offset within it.
 *
 * Every phone sits wholly inside one tile. A store carousel shows one panel at
 * a time, so an object centred on a seam reads as "continues offscreen"; X
 * shows all four at once with a gutter between them, where the same object just
 * reads as broken. Only the glow, the beam and the floor cross the cuts.
 *
 * A single 9:16 phone cannot fill a 16:9 tile, so each populated quadrant holds
 * a layered pair: a smaller one set back, a larger one in front.
 */
const Q = { bottomLeft: [W * 0.25, H * 0.75], bottomRight: [W * 0.75, H * 0.75] };
const PHONE_LAYOUT = [
	{ screen: 'screen-5', at: Q.bottomLeft, dx: 300, dy: -54, w: 396, tilt: 6, turn: -20, pitch: 7, back: true },
	{ screen: 'screen-2', at: Q.bottomLeft, dx: -146, dy: 28, w: 478, tilt: -3, turn: 15, pitch: 5 },
	{ screen: 'screen-4', at: Q.bottomRight, dx: -520, dy: -46, w: 396, tilt: -6, turn: 20, pitch: 7, back: true },
	{ screen: 'screen-3', at: Q.bottomRight, dx: -180, dy: 30, w: 478, tilt: 2, turn: -15, pitch: 5 },
];

/* The phone is 9:16 plus a 13px bezel each side; this is the drawn height, used
   to assert every phone clears its own tile's edges before anything renders. */
const phoneHeight = (w) => (w - 26) * (1920 / 1080) + 26;

const PHONES = PHONE_LAYOUT.map(({ screen, at, dx, dy, w, tilt, turn = 0, pitch = 4, back }) => {
	const cx = at[0] + dx;
	const cy = at[1] + dy;
	const h = phoneHeight(w);
	/* A rotated box needs more room than its width; check the rotated extent. */
	const rad = Math.abs(tilt) * Math.PI / 180;
	const halfW = (w * Math.cos(rad) + h * Math.sin(rad)) / 2;
	const halfH = (h * Math.cos(rad) + w * Math.sin(rad)) / 2;
	/* Which tile is this phone in, and does it stay clear of that tile's edges? */
	const qx = cx < W / 2 ? 0 : W / 2;
	const qy = cy < H / 2 ? 0 : H / 2;
	const clear = [cx - halfW - qx, qx + W / 2 - (cx + halfW), cy - halfH - qy, qy + H / 2 - (cy + halfH)];
	if (Math.min(...clear) < SAFE) {
		throw new Error(
			`[x-grid] ${screen} comes within ${Math.round(Math.min(...clear))}px of its tile edge ` +
			`(minimum ${SAFE}); it would be cut by the collage seam`,
		);
	}
	/* The 2D extent above is the conservative case: rotateY and rotateX
	   foreshorten the slab, so a phone that clears the seam flat clears it
	   turned. */
	return `<div class="phone${back ? ' back' : ''}" style="left:${cx}px;top:${cy}px;width:${w}px;--tilt:${tilt}deg;--turn:${turn}deg;--pitch:${pitch}deg">
    <img src="${shots[screen]}" alt="">
  </div>`;
}).join('\n');

const html = `<!doctype html><meta charset="utf-8"><style>
${FONT_FACES}
*{margin:0;padding:0;box-sizing:border-box}
body{width:${W}px;height:${H}px;background:${BG};color:#fff;overflow:hidden;position:relative;
  font-family:'Inter',sans-serif;-webkit-font-smoothing:antialiased}
/* One continuous field behind all four tiles. It ignores both seams, which is
   what makes the reassembled post read as a single photograph. */
.glow{position:absolute;inset:0;
  background:
    radial-gradient(28% 32% at 20% 30%, rgba(78,120,255,.19), transparent 70%),
    radial-gradient(24% 28% at 78% 22%, rgba(56,180,255,.13), transparent 72%),
    radial-gradient(28% 32% at 28% 80%, rgba(140,84,255,.15), transparent 70%),
    radial-gradient(24% 30% at 82% 78%, rgba(104,96,255,.12), transparent 72%)}
.beam{position:absolute;left:8%;right:8%;top:36%;height:440px;transform:rotate(-4deg);
  background:linear-gradient(90deg, transparent, rgba(150,200,255,.08) 22%, rgba(190,220,255,.12) 50%, rgba(150,200,255,.08) 78%, transparent);
  filter:blur(110px)}

/* Headline block, wholly inside the top-left quadrant and clear of its edges. */
/* The mark, top left of the first tile. Sized against the headline rather than
   tucked into a corner: at 96px on a 4096px canvas it read as a watermark. */
.lockup{position:absolute;left:${SAFE + 40}px;top:${SAFE + 40}px;display:flex;align-items:center;gap:30px}
.lockup img{width:168px;height:168px;border-radius:42px}
.lockup span{font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:110px;letter-spacing:-.045em}

/* A second, quieter mark in the last tile. Tiles are tapped one at a time and
   shown as a list by some clients, so the first and last both have to carry the
   brand on their own; without this, three of the four are unbranded. */
.sign{position:absolute;right:${SAFE + 40}px;bottom:${SAFE + 44}px;display:flex;align-items:center;gap:20px}
.sign img{width:82px;height:82px;border-radius:21px}
.sign span{font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:60px;letter-spacing:-.045em}

/* The headline is one line drawn as two halves that meet at the vertical seam.
   The gap between them is a word space, so the cut lands between "an" and
   "Android" and never through a glyph: assembled it reads as one line, split it
   reads as two complete phrases. Sized and positioned by the page itself, so
   the halves stay locked to the seam whatever the font metrics do. */
h1{position:absolute;top:${H * 0.30}px;margin:0;white-space:nowrap;
  font-family:'Space Grotesk',sans-serif;font-weight:600;line-height:1;letter-spacing:-.04em;
  transform:translateY(-50%)}
#h-left{right:${W / 2 + 44}px;text-align:right}
#h-right{left:${W / 2 + 44}px;color:#8fb4ff}

/* Phones. Every one sits wholly inside a single tile: a face or 12px of UI
   text cut by the collage gutter reads as broken, unlike the headline above,
   which is large enough that the cut hides inside a word space. */
.phone{position:absolute;
  transform:translate(-50%,-50%) perspective(2600px) rotateY(var(--turn,0deg)) rotateX(var(--pitch,4deg)) rotate(var(--tilt,0deg));
  transform-style:preserve-3d;
  border-radius:58px;padding:13px;
  /* Lit from the upper left, so the bezel has a bright edge and a dark one and
     the slab reads as a solid object rather than a flat rounded rectangle. */
  background:linear-gradient(135deg,#4a5070 0%,#2a2e44 26%,#12131f 62%,#31364f 100%);
  box-shadow:
    0 80px 150px rgba(0,0,0,.92),
    0 18px 44px rgba(0,0,0,.7),
    0 0 0 1px rgba(255,255,255,.10) inset,
    0 2px 0 rgba(255,255,255,.16) inset}
.phone img{display:block;width:100%;border-radius:47px;background:${BG}}
/* A specular sheen across the glass, angled with the turn. */
.phone::after{content:'';position:absolute;inset:13px;border-radius:47px;pointer-events:none;
  background:linear-gradient(118deg, rgba(255,255,255,.16) 0%, rgba(255,255,255,.04) 18%, transparent 42%)}
.phone.back{opacity:.9;filter:saturate(.94) brightness(.8)}

/* Value line and install facts, wholly inside the bottom-right tile. */
.foot{position:absolute;right:${SAFE + 40}px;bottom:${SAFE + 190}px;text-align:right;max-width:860px}
.foot .lede{font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:52px;line-height:1.22;letter-spacing:-.03em}
.foot .small{margin-top:22px;font-size:31px;color:#8fa3c6}
</style><body>
<div class="glow"></div><div class="beam"></div>

<div class="lockup"><img src="${MARK_URI}" alt=""><span>three.ws</span></div>

<h1 id="h-left">Now an</h1><h1 id="h-right">Android app.</h1>

${PHONES}

<div class="foot">
  <div class="lede">A photo or a prompt in.<br>A 3D model or an agent out.</div>
  <div class="small">Android 6.0+ &middot; free &middot; open source</div>
</div>

<div class="sign"><img src="${MARK_URI}" alt=""><span>three.ws</span></div>

<script>
  /* Fit the two halves so the whole line spans the width, then hold them either
     side of the seam. Measured here rather than guessed, because a hardcoded
     font-size drifts the moment the copy or the face changes. */
  (async () => {
    await document.fonts.ready;
    const L = document.getElementById('h-left');
    const R = document.getElementById('h-right');
    const PROBE = 200;
    L.style.fontSize = R.style.fontSize = PROBE + 'px';
    /* The halves are unequal ("Now an" vs "Android app."), and each has the
       same room on its own side of the seam, so the wider one sets the size.
       Fitting their combined width instead overflows the canvas. */
    const room = ${HALF_ROOM};
    const size = PROBE * Math.min(
      room / L.getBoundingClientRect().width,
      room / R.getBoundingClientRect().width,
    );
    L.style.fontSize = R.style.fontSize = size + 'px';
    document.documentElement.dataset.fitted = '1';
  })();
</script>
</body>`;

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
let master;
try {
	const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
	await page.setContent(html, { waitUntil: 'load' });
	const loaded = await page.evaluate(async () => {
		await document.fonts.ready;
		return document.fonts.check('600 132px "Space Grotesk"') && document.fonts.check('400 41px "Inter"');
	});
	if (!loaded) throw new Error('[x-grid] brand fonts did not load; the composition would render in a fallback face');
	await page.waitForFunction(() => document.documentElement.dataset.fitted === '1');

	/* The seam must fall in the gap between the halves, never through a glyph. */
	const seam = await page.evaluate((mid) => {
		const left = document.getElementById('h-left');
		const right = document.getElementById('h-right');
		const l = left.getBoundingClientRect();
		const r = right.getBoundingClientRect();
		return { leftEnd: l.right, rightStart: r.left, mid, fontSize: getComputedStyle(left).fontSize };
	}, W / 2);
	if (seam.leftEnd >= seam.mid || seam.rightStart <= seam.mid) {
		throw new Error(`[x-grid] the headline crosses the seam (left ends ${seam.leftEnd}, right starts ${seam.rightStart}, seam ${seam.mid})`);
	}
	console.log(`[x-grid] headline ${parseInt(seam.fontSize, 10)}px, seam clears by ${Math.round(seam.mid - seam.leftEnd)}px / ${Math.round(seam.rightStart - seam.mid)}px`);
	master = await page.screenshot({ type: 'png' });
} finally {
	await browser.close();
}

/**
 * Two properties make this post read as one floating image rather than four
 * rectangles, and both are easy to undo by accident with a colour tweak.
 *
 *   - The outer border must be black. X's dark timeline is #000000; any lighter
 *     value there draws a visible box around the post.
 *   - The seams must be dim. The gutter between cells is pure black, so
 *     wherever the composition is brighter the gap shows as a line through it.
 */
async function assertBlendsIntoTimeline(png) {
	const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
	const { width, height, channels } = info;
	const lum = (x, y) => {
		const i = (y * width + x) * channels;
		return Math.max(data[i], data[i + 1], data[i + 2]);
	};

	let border = 0;
	for (let x = 0; x < width; x += 4) border = Math.max(border, lum(x, 0), lum(x, height - 1));
	for (let y = 0; y < height; y += 4) border = Math.max(border, lum(0, y), lum(width - 1, y));
	if (border > BORDER_MAX) {
		throw new Error(
			`[x-grid] the outer border reaches ${border}/255 (limit ${BORDER_MAX}); ` +
			"it would draw a visible rectangle on X's black timeline",
		);
	}

	let seam = 0;
	for (let y = 0; y < height; y += 2) seam = Math.max(seam, lum(width / 2, y));
	for (let x = 0; x < width; x += 2) seam = Math.max(seam, lum(x, height / 2));
	if (seam > SEAM_MAX) {
		throw new Error(
			`[x-grid] the composition reaches ${seam}/255 on a seam (limit ${SEAM_MAX}); ` +
			'the collage gutter would cut a visible line through it',
		);
	}
	console.log(`[x-grid] border ${border}/255, brightest seam pixel ${seam}/255`);
}

await assertBlendsIntoTimeline(master);

writeFileSync(path.join(OUT, '..', 'android-launch-master-16x9.png'), await sharp(master).removeAlpha().png({ compressionLevel: 9 }).toBuffer());
/* CoinMarketCap article covers are 640x360 (16:9), the master's own aspect, so the
 * cover is the composition itself scaled down rather than a separate design. */
writeFileSync(path.join(OUT, '..', 'cmc-cover-640x360.png'), await sharp(master).removeAlpha().resize(640, 360, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer());

/* Quadrants in X's fill order: 1,2 across the top, then 3,4. */
const TILES = [
	['01-top-left.png', 0, 0],
	['02-top-right.png', W / 2, 0],
	['03-bottom-left.png', 0, H / 2],
	['04-bottom-right.png', W / 2, H / 2],
];
for (const [name, left, top] of TILES) {
	const tile = await sharp(master)
		.extract({ left, top, width: W / 2, height: H / 2 })
		.flatten({ background: BG })
		.removeAlpha()
		.png({ compressionLevel: 9 })
		.toBuffer();
	/* X re-encodes a PNG over 5 MB as JPEG, which bands these gradients. */
	if (tile.length > 5 * 1024 * 1024) {
		throw new Error(`[x-grid] ${name} is ${(tile.length / 1024 / 1024).toFixed(2)} MB; X re-encodes above 5 MB`);
	}
	writeFileSync(path.join(OUT, name), tile);
	console.log(`[x-grid] ${name}  ${W / 2}x${H / 2}  ${Math.round(tile.length / 1024)} KB`);
}

writeFileSync(path.join(OUT, '..', 'IMAGE-ORDER.md'), `# Image insertion order

X lays four images out in a 2x2 grid and fills it in UPLOAD ORDER. Attach them
in exactly this sequence or the composition reassembles wrong:

| Slot | File |
| --- | --- |
| top left | \`images/01-top-left.png\` |
| top right | \`images/02-top-right.png\` |
| bottom left | \`images/03-bottom-left.png\` |
| bottom right | \`images/04-bottom-right.png\` |

Each tile is ${W / 2}x${H / 2} (16:9), the same aspect as the cell it lands in, so X
crops nothing. \`android-launch-master-16x9.png\` is the uncut composition, for
reference and for surfaces that take a single image.

Regenerate with \`npm run build:x-grid\`.
`);
console.log(`[x-grid] master + IMAGE-ORDER.md -> ${path.relative(ROOT, path.join(OUT, '..'))}/`);
