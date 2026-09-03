#!/usr/bin/env node
/**
 * Generates the three.ws Glance macOS app icon from the brand mark.
 *
 *   node apple/scripts/make-macos-icon.mjs [--check]
 *
 * Same reasoning as ios/scripts/make-icons.mjs: Xcode refuses to archive
 * without an app icon, and deriving it from the mark means one command re-cuts
 * every size when the mark changes. macOS differs from iOS in two ways that
 * matter here. It needs the whole ladder of sizes (16 through 512, at 1x and
 * 2x) rather than a single 1024 slot, and it draws the icon exactly as given,
 * so the rounded rectangle and the margin around it are ours to paint rather
 * than the system's to apply.
 *
 * --check verifies the committed assets match what this script would produce,
 * without writing, which is what keeps a hand-edited icon from drifting.
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const ICONSET = join(REPO, 'apple/macos/ThreeWSGlance/Assets.xcassets/AppIcon.appiconset');
const SOURCE = join(REPO, 'public/pwa-512x512.png');

// The product's background, matched across the iOS icon, the launch screen and
// the widget's canvas in apple/GlanceKit/GlanceCardView.swift.
const BG_TOP = { r: 0x16, g: 0x16, b: 0x3a };
const BG_BASE = { r: 0x08, g: 0x08, b: 0x14 };

// Apple's macOS icon grid: the art sits inside about 80% of the canvas with a
// corner radius near a fifth of the art's edge. A full-bleed square reads as a
// mistake in the Dock next to every other app.
const INSET = 0.1;
const RADIUS = 0.185;
const MARK_COVERAGE = 0.56;

/** The radial the offline screen paints, as raw pixels. */
function backgroundPlate(size) {
	const px = Buffer.allocUnsafe(size * size * 3);
	const cx = size / 2;
	const rx = size * 1.2;
	const ry = size * 0.8;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const dx = (x + 0.5 - cx) / rx;
			const dy = (y + 0.5) / ry;
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
 * One icon: a rounded plate inset in a transparent canvas, with the mark
 * centred on it. macOS icons keep their alpha channel, unlike iOS ones.
 *
 * @param {number} size Output edge length in pixels.
 * @returns {Promise<Buffer>} PNG bytes.
 */
async function compose(size) {
	const art = Math.round(size * (1 - INSET * 2));
	const offset = Math.round((size - art) / 2);
	const radius = Math.round(art * RADIUS);

	const mask = Buffer.from(
		`<svg width="${art}" height="${art}"><rect width="${art}" height="${art}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`
	);
	const plate = await sharp(await backgroundPlate(art))
		.composite([{ input: mask, blend: 'dest-in' }])
		.png()
		.toBuffer();

	const mark = Math.max(1, Math.round(art * MARK_COVERAGE));
	const glyph = await sharp(SOURCE).resize(mark, mark, { fit: 'contain' }).png().toBuffer();
	const markOffset = offset + Math.round((art - mark) / 2);

	return sharp({
		create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
	})
		.composite([
			{ input: plate, left: offset, top: offset },
			{ input: glyph, left: markOffset, top: markOffset },
		])
		.png({ compressionLevel: 9 })
		.toBuffer();
}

// The full macOS ladder. Every entry is one file and one Contents.json image.
const SIZES = [16, 32, 128, 256, 512];
const TARGETS = SIZES.flatMap((size) => [
	{ size, scale: 1, pixels: size, file: `icon_${size}x${size}.png` },
	{ size, scale: 2, pixels: size * 2, file: `icon_${size}x${size}@2x.png` },
]);

const contents = {
	images: TARGETS.map((t) => ({
		filename: t.file,
		idiom: 'mac',
		scale: `${t.scale}x`,
		size: `${t.size}x${t.size}`,
	})),
	info: { author: 'xcode', version: 1 },
};

const check = process.argv.includes('--check');

if (!existsSync(SOURCE)) {
	console.error(`[macos-icon] brand mark missing: ${SOURCE}`);
	process.exit(1);
}
if (!check) mkdirSync(ICONSET, { recursive: true });

const digest = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 12);
let drifted = 0;

for (const target of TARGETS) {
	const path = join(ICONSET, target.file);
	const produced = await compose(target.pixels);
	if (check) {
		const current = existsSync(path) ? readFileSync(path) : null;
		const same = current && digest(current) === digest(produced);
		if (!same) {
			drifted++;
			console.log(`[macos-icon] DRIFT ${target.file} (${target.pixels}px)`);
		}
		continue;
	}
	writeFileSync(path, produced);
	console.log(`[macos-icon] wrote ${target.file} ${target.pixels}x${target.pixels} (${produced.length} bytes)`);
}

const manifest = `${JSON.stringify(contents, null, 2)}\n`;
const manifestPath = join(ICONSET, 'Contents.json');
if (check) {
	const current = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
	if (current !== manifest) {
		drifted++;
		console.log('[macos-icon] DRIFT Contents.json');
	}
} else {
	writeFileSync(manifestPath, manifest);
	console.log('[macos-icon] wrote Contents.json');
}

if (check) {
	if (drifted) {
		console.error(`[macos-icon] ${drifted} asset(s) differ from the brand mark. Run: node apple/scripts/make-macos-icon.mjs`);
		process.exit(1);
	}
	console.log(`[macos-icon] ok ${TARGETS.length} icons match the brand mark`);
}
