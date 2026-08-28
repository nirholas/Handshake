#!/usr/bin/env node
/**
 * Generates the iOS app icon and launch images from the brand mark.
 *
 *   node ios/scripts/make-icons.mjs [--check]
 *
 * Xcode refuses to archive without an app icon, and App Store Connect rejects
 * one that carries an alpha channel, so this is a build prerequisite rather
 * than a polish step. Generating it is better than committing a hand-exported
 * PNG for the usual reason: when the mark changes, one command re-derives every
 * size instead of somebody remembering which files to re-cut.
 *
 * Source of truth is public/pwa-512x512.png, the same chrome wireframe cube the
 * web app and the Android app use. It ships with transparency, which iOS forbids
 * in an icon, so it is composited onto the product's own background rather than
 * flattened onto white: the gradient here is the one in ios/shell/offline.html
 * and capacitor.config.ts, so the icon, the launch screen and the first frame of
 * the app are the same colour.
 *
 * --check verifies the committed assets match what this script would produce,
 * without writing. That is what keeps a hand-edited icon from drifting away
 * from the mark silently.
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const ASSETS = join(REPO, 'ios/native/App/App/Assets.xcassets');

const SOURCE = join(REPO, 'public/pwa-512x512.png');

// The product's background, matched across the icon, the launch screen,
// capacitor.config.ts `ios.backgroundColor`, and shell/offline.html.
const BG_TOP = { r: 0x16, g: 0x16, b: 0x3a };
const BG_BASE = { r: 0x08, g: 0x08, b: 0x14 };

/**
 * The same radial the offline screen paints, rendered as a bitmap so the icon
 * is not a flat rectangle. `radial-gradient(120% 80% at 50% 0%, #16163a, #080814)`.
 *
 * @param {number} size
 * @returns {Promise<Buffer>} raw RGB pixels, `size` x `size`
 */
async function backgroundPlate(size) {
	const px = Buffer.allocUnsafe(size * size * 3);
	const cx = size / 2;
	const rx = size * 1.2;
	const ry = size * 0.8;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const dx = (x + 0.5 - cx) / rx;
			const dy = (y + 0.5) / ry;
			// Clamp so the far corners settle on the base colour rather than
			// wrapping past it.
			const t = Math.min(1, Math.sqrt(dx * dx + dy * dy));
			const i = (y * size + x) * 3;
			px[i] = Math.round(BG_TOP.r + (BG_BASE.r - BG_TOP.r) * t);
			px[i + 1] = Math.round(BG_TOP.g + (BG_BASE.g - BG_TOP.g) * t);
			px[i + 2] = Math.round(BG_TOP.b + (BG_BASE.b - BG_TOP.b) * t);
		}
	}
	return sharp(px, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

/**
 * @param {number} size Output edge length in pixels.
 * @param {number} coverage Fraction of the edge the mark occupies.
 * @returns {Promise<Buffer>} PNG bytes with no alpha channel.
 */
async function compose(size, coverage) {
	const mark = Math.round(size * coverage);
	const glyph = await sharp(SOURCE).resize(mark, mark, { fit: 'contain' }).png().toBuffer();
	const offset = Math.round((size - mark) / 2);
	return sharp(await backgroundPlate(size))
		.composite([{ input: glyph, left: offset, top: offset }])
		// removeAlpha, not flatten: the plate is already opaque, and an icon
		// that reaches App Store Connect with an alpha channel is rejected.
		.removeAlpha()
		.png({ compressionLevel: 9 })
		.toBuffer();
}

// Xcode 15+ derives every home-screen and Settings size from the single 1024
// slot, so this is the whole icon set. The splash is one square that Capacitor
// scales and crops per device, which is why the mark sits small in it.
const TARGETS = [
	{
		file: join(ASSETS, 'AppIcon.appiconset/AppIcon-512@2x.png'),
		size: 1024,
		// Full-bleed. iOS applies only a squircle corner radius, so the Android
		// maskable framing (which insets the glyph ~20% for a circle crop) would
		// leave the icon looking small next to every other app on the home screen.
		coverage: 0.82,
		label: 'app icon',
	},
	{ file: join(ASSETS, 'Splash.imageset/splash-2732x2732.png'), size: 2732, coverage: 0.18, label: 'splash' },
	{ file: join(ASSETS, 'Splash.imageset/splash-2732x2732-1.png'), size: 2732, coverage: 0.18, label: 'splash (dark)' },
	{ file: join(ASSETS, 'Splash.imageset/splash-2732x2732-2.png'), size: 2732, coverage: 0.18, label: 'splash (alt)' },
];

const check = process.argv.includes('--check');

if (!existsSync(SOURCE)) {
	console.error(`[ios-icons] brand mark missing: ${SOURCE}`);
	process.exit(1);
}

const digest = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 12);
let drifted = 0;

for (const target of TARGETS) {
	const produced = await compose(target.size, target.coverage);
	if (check) {
		const current = existsSync(target.file) ? readFileSync(target.file) : null;
		const same = current && digest(current) === digest(produced);
		console.log(`[ios-icons] ${same ? 'ok  ' : 'DRIFT'} ${target.label} (${target.size}px)`);
		if (!same) drifted++;
		continue;
	}
	writeFileSync(target.file, produced);
	console.log(`[ios-icons] wrote ${target.label} ${target.size}x${target.size} (${produced.length} bytes)`);
}

if (check && drifted) {
	console.error(`[ios-icons] ${drifted} asset(s) differ from the brand mark. Run: node ios/scripts/make-icons.mjs`);
	process.exit(1);
}
