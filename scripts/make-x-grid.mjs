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
const BG = '#080814';

/* X's collage container is not documented and has changed before. Whatever
   aspect it uses, each cell inherits it, so a quadrant can only ever be
   trimmed slightly on one axis. Nothing that carries meaning goes within this
   many pixels of a quadrant's own edge. */
const SAFE = 96;

const FONT_FACES = [
	['Space Grotesk', '300 700', 'space-grotesk-latin.woff2'],
	['Inter', '300 800', 'inter-latin.woff2'],
].map(([family, weight, file]) => `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};src:url(data:font/woff2;base64,${readFileSync(path.join(ROOT, 'public/fonts', file)).toString('base64')}) format('woff2');}`).join('\n');

const MARK_URI = `data:image/png;base64,${readFileSync(path.join(ROOT, 'public/pwa-512x512.png')).toString('base64')}`;

/** The product screens, one per phone. Raws come from the Play listing run. */
const SCREENS = ['screen-1', 'screen-2', 'screen-3', 'screen-4', 'screen-5'];
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
const Q = { topRight: [W * 0.75, H * 0.25], bottomLeft: [W * 0.25, H * 0.75], bottomRight: [W * 0.75, H * 0.75] };
const PHONE_LAYOUT = [
	{ screen: 'screen-4', at: Q.topRight, dx: -298, dy: -44, w: 404, tilt: -7, back: true },
	{ screen: 'screen-1', at: Q.topRight, dx: 142, dy: 34, w: 486, tilt: 3 },
	{ screen: 'screen-5', at: Q.bottomLeft, dx: 292, dy: -50, w: 404, tilt: 7, back: true },
	{ screen: 'screen-2', at: Q.bottomLeft, dx: -148, dy: 30, w: 486, tilt: -3 },
	{ screen: 'screen-3', at: Q.bottomRight, dx: -210, dy: 18, w: 500, tilt: -2 },
];

/* The phone is 9:16 plus a 13px bezel each side; this is the drawn height, used
   to assert every phone clears its own tile's edges before anything renders. */
const phoneHeight = (w) => (w - 26) * (1920 / 1080) + 26;

const PHONES = PHONE_LAYOUT.map(({ screen, at, dx, dy, w, tilt, back }) => {
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
	return `<div class="phone${back ? ' back' : ''}" style="left:${cx}px;top:${cy}px;width:${w}px;--tilt:${tilt}deg">
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
    radial-gradient(42% 48% at 14% 22%, rgba(96,140,255,.30), transparent 70%),
    radial-gradient(38% 46% at 74% 18%, rgba(64,196,255,.22), transparent 72%),
    radial-gradient(40% 50% at 34% 84%, rgba(150,90,255,.26), transparent 70%),
    radial-gradient(36% 48% at 88% 78%, rgba(120,110,255,.24), transparent 72%),
    linear-gradient(160deg, #0a0a1c 0%, #080814 58%, #06060f 100%)}
.beam{position:absolute;left:-8%;right:-8%;top:34%;height:520px;transform:rotate(-4deg);
  background:linear-gradient(90deg, transparent, rgba(150,200,255,.14) 18%, rgba(190,220,255,.24) 52%, rgba(150,200,255,.14) 82%, transparent);
  filter:blur(80px)}
.floor{position:absolute;left:0;right:0;bottom:0;height:640px;
  background:linear-gradient(180deg, transparent, rgba(4,5,16,.80))}

/* Headline block, wholly inside the top-left quadrant and clear of its edges. */
.head{position:absolute;left:${SAFE + 34}px;top:${SAFE + 96}px;width:${W / 2 - SAFE * 2 - 40}px}
.lockup{display:flex;align-items:center;gap:26px;margin-bottom:44px}
.lockup img{width:104px;height:104px;border-radius:26px}
.lockup span{font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:68px;letter-spacing:-.045em}
h1{font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:132px;line-height:1.02;letter-spacing:-.04em}
h1 em{font-style:normal;color:#8fb4ff}
.head p{margin-top:34px;font-size:41px;line-height:1.38;color:#9bb0d4;max-width:900px}

/* Phones. Two straddle a seam on purpose: the composition has to cross the
   cuts, or the four tiles read as four unrelated posters. */
.phone{position:absolute;transform:translate(-50%,-50%) rotate(var(--tilt,0deg));
  border-radius:58px;padding:13px;background:linear-gradient(160deg,#2f3350,#12131f 58%,#262a40);
  box-shadow:0 52px 140px rgba(3,4,14,.82), 0 0 0 1px rgba(255,255,255,.07) inset}
.phone img{display:block;width:100%;border-radius:47px;background:${BG}}
.phone.back{opacity:.86;filter:saturate(.92) brightness(.88)}

/* Footer line, wholly inside the bottom-right quadrant. */
.foot{position:absolute;right:${SAFE + 34}px;bottom:${SAFE + 40}px;text-align:right}
.foot .big{font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:56px;letter-spacing:-.03em}
.foot .small{margin-top:18px;font-size:32px;color:#8fa3c6;line-height:1.45}
</style><body>
<div class="glow"></div><div class="beam"></div><div class="floor"></div>

<div class="head">
  <div class="lockup"><img src="${MARK_URI}" alt=""><span>three.ws</span></div>
  <h1>Now an<br><em>Android app.</em></h1>
  <p>Turn a photo or a prompt into 3D models and AI agents you own, on your phone.</p>
</div>

${PHONES}

<div class="foot">
  <div class="big">three.ws</div>
  <div class="small">Android 6.0+ &middot; free &middot; open source</div>
</div>
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
	master = await page.screenshot({ type: 'png' });
} finally {
	await browser.close();
}

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
