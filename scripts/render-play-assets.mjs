#!/usr/bin/env node
/**
 * Renders the Google Play developer-page image set.
 *
 * Play states two hard constraints on both slots, and rejects the upload rather
 * than degrading if either is missed: "JPEG or 24-bit PNG (not transparent)"
 * and "Up to 1 MB". A PNG written by a canvas is always 32-bit RGBA, so the
 * alpha channel has to come off explicitly. Every constraint below is asserted
 * after the bytes exist, so a wrong file fails here and not in the Console.
 *
 *   Developer icon   512 x 512     Shown as a circle next to the developer name.
 *   Header image     4096 x 2304   Full-bleed banner at the top of the page.
 *   App icon         512 x 512     The store listing's icon.
 *   Feature graphic  1024 x 500    Promotional banner for the store listing.
 *
 * The header is the wordmark centred on black, drawn by scripts/render-wordmark.mjs
 * so the type comes from the same Space Grotesk files the site serves. The icon
 * is the shipped app mark (public/pwa-512x512.png) inset for the circular crop:
 * at full bleed the cube's vertices sit outside the circle and get clipped.
 *
 * Usage:
 *   npm run build:play-assets
 *   node scripts/render-play-assets.mjs --out=/tmp/play
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { renderWordmarks, renderPage } from './render-wordmark.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PUBLIC = join(ROOT, 'public');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
	const m = a.match(/^--([^=]+)(?:=(.*))?$/);
	return m ? [m[1], m[2] ?? true] : [a, true];
}));
/* Two destinations on purpose. The developer-page artwork is brand material and
   lives with the other marks; the store-listing artwork lives beside the listing
   worksheet, under the exact filenames publish-play/config.yaml names, so the
   worksheet never points at a file that does not exist. */
const BRAND_DIR = args.out ? resolve(String(args.out)) : join(PUBLIC, 'brand/play');
const LISTING_DIR = args.out ? resolve(String(args.out)) : join(ROOT, 'solana-mobile/publish-play/media');

/** Play's stated ceiling for both slots. */
const MAX_BYTES = 1024 * 1024;
const GROUND = '#000000';
/* The mark is drawn edge to edge, and Play masks the developer icon to a
   circle. 0.82 keeps the cube's vertices inside that circle with room to
   spare, which full bleed does not. */
const ICON_INSET = 0.82;
const SOURCE_MARK = join(PUBLIC, 'pwa-512x512.png');

mkdirSync(BRAND_DIR, { recursive: true });
mkdirSync(LISTING_DIR, { recursive: true });

/** Flatten onto the brand ground and drop the alpha channel Play refuses. */
async function toOpaquePng(pipeline) {
	return pipeline.flatten({ background: GROUND }).removeAlpha().png({ compressionLevel: 9 }).toBuffer();
}

/** Fail loudly here rather than shipping a file the Console will bounce. */
async function assertPlayReady(label, buffer, width, height) {
	const meta = await sharp(buffer).metadata();
	const problems = [];
	if (meta.width !== width || meta.height !== height) {
		problems.push(`is ${meta.width}x${meta.height}, Play requires ${width}x${height}`);
	}
	if (meta.hasAlpha || meta.channels !== 3) {
		problems.push(`has ${meta.channels} channels, Play requires 24-bit PNG with no transparency`);
	}
	if (buffer.length > MAX_BYTES) {
		problems.push(`is ${(buffer.length / 1024 / 1024).toFixed(2)} MB, Play's ceiling is 1 MB`);
	}
	if (problems.length) throw new Error(`${label} ${problems.join('; ')}`);
	return meta;
}

const written = [];

/* Header image: the wordmark centred on the brand ground. */
const [header] = await renderWordmarks([
	{ width: 4096, height: 2304, bg: GROUND, fg: '#ffffff' },
]);
await assertPlayReady('header image', header.buffer, 4096, 2304);
written.push([BRAND_DIR, 'three-ws-play-header-4096x2304.png', header.buffer, `wordmark ink ${header.ink.width}x${header.ink.height}, centred`]);

/* Developer icon: the shipped app mark, inset for the circular crop. */
const inner = Math.round(512 * ICON_INSET);
const pad = Math.round((512 - inner) / 2);
const icon = await toOpaquePng(
	sharp({ create: { width: 512, height: 512, channels: 4, background: GROUND } }).composite([{
		input: await sharp(SOURCE_MARK).resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
		top: pad,
		left: pad,
	}]).png(),
);
await assertPlayReady('developer icon', icon, 512, 512);
written.push([BRAND_DIR, 'three-ws-play-developer-icon-512x512.png', icon, `mark inset to ${Math.round(ICON_INSET * 100)}% for the circular crop`]);

/* App icon for the store listing. Same artwork as the dApp Store slot: the
   shipped mark flattened onto the brand ground. Play draws this one with its
   own rounded-corner mask rather than a circle, so it keeps the full bleed the
   developer icon gives up. */
const appIcon = await toOpaquePng(sharp(SOURCE_MARK).resize(512, 512));
await assertPlayReady('app icon', appIcon, 512, 512);
written.push([LISTING_DIR, 'icon-512.png', appIcon, 'shipped app mark on the brand ground']);

/* Feature graphic. Play's own guidance is to keep screenshots and small text
   out of this slot: it is scaled down hard in the store and cropped at the
   edges on some surfaces, so everything that carries meaning sits in the
   middle and is set large. Brand ground, the lockup, one line of copy. */
const FEATURE_HTML = `
<div style="
	width:1024px;height:500px;display:flex;flex-direction:column;
	align-items:center;justify-content:center;gap:26px;
	background:#000000;
	font-family:'Space Grotesk',Inter,sans-serif;
">
	<div style="display:flex;align-items:center;gap:26px;">
		<img src="/marketing/openai-select-partner/cards/three-ws-mark.png" alt=""
		     style="display:block;height:132px;width:auto;" />
		<span style="
			font-size:104px;font-weight:600;letter-spacing:-0.045em;line-height:1;
			color:#ffffff;white-space:nowrap;padding-right:6px;padding-bottom:8px;
		">three.ws</span>
	</div>
	<p style="
		font-family:Inter,sans-serif;font-size:30px;font-weight:400;line-height:1.35;
		letter-spacing:-0.01em;color:rgba(255,255,255,0.72);text-align:center;max-width:880px;
	">Turn a photo or a prompt into 3D models and AI agents.</p>
</div>`;
const feature = await renderPage(FEATURE_HTML, { width: 1024, height: 500 });
await assertPlayReady('feature graphic', feature, 1024, 500);
written.push([LISTING_DIR, 'feature-1024x500.png', feature, 'lockup and one line of copy, no small text']);

for (const [dir, name, buffer, note] of written) {
	const out = join(dir, name);
	writeFileSync(out, buffer);
	const meta = await sharp(out).metadata();
	console.log(
		`${name}  ${meta.width}x${meta.height}  ${meta.channels}-channel opaque  ` +
		`${Math.round(statSync(out).size / 1024)} KB / 1024 KB  (${note})  ->  ${out}`,
	);
}
