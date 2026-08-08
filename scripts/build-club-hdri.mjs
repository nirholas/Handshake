#!/usr/bin/env node
/**
 * Authors public/club/venue/club-hdri.hdr — the equirectangular HDR the
 * /club page pre-filters through PMREMGenerator.fromEquirectangular() to
 * drive PBR reflections on the venue + dancer materials. The HDR only
 * affects materials, not the visible sky (`scene.background` stays the dark
 * fog colour).
 *
 * Run via: npm run build:club-hdri
 *
 * Why we synthesise it instead of shipping a Polyhaven download:
 *   The /club rails (CLAUDE.md) require every committed asset to have
 *   crystal-clear provenance. A locally-generated HDR is fully owned by
 *   three.ws and dedicated CC0 — see public/club/venue/LICENSES.md. The
 *   tradeoff is fidelity: this is a 128×64 procedural sphere with one warm
 *   downlight per pole + a soft purple wash; it's enough to make chrome
 *   poles glint and dancer skin pick up rim colour, but a hand-painted
 *   nightclub HDR will of course beat it. Drop a Polyhaven .hdr into this
 *   directory and update the LICENSES entry to upgrade later.
 *
 * Output format: Radiance RGBE, the standard `.hdr` format three.js's
 * HDRLoader consumes. Uncompressed (no RLE) for simplicity; the file ends
 * up around 32 kB which is fine for /club.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, 'public/club/venue');

const WIDTH = 128;
const HEIGHT = 64;

// Pack a single (r, g, b) float radiance triple into 4 bytes following the
// Greg Ward RGBE convention. Returns [R, G, B, E].
function packRGBE(r, g, b) {
	const v = Math.max(r, g, b);
	if (v < 1e-32) return [0, 0, 0, 0];
	// IEEE-754 frexp emulation — v = m * 2^e with 0.5 <= m < 1.
	let e = Math.ceil(Math.log2(v));
	let m = v / 2 ** e;
	// Re-normalise: m * 256 must land in [0, 256). m in [0.5, 1) → mantissa in [128, 256).
	if (m >= 1) {
		m *= 0.5;
		e += 1;
	}
	const scale = (m * 256) / v;
	return [
		Math.min(255, Math.max(0, Math.round(r * scale))),
		Math.min(255, Math.max(0, Math.round(g * scale))),
		Math.min(255, Math.max(0, Math.round(b * scale))),
		Math.min(255, Math.max(0, e + 128)),
	];
}

// Smooth bump centred at (theta0, phi0) with falloff `width`. Returns a
// 0..1 multiplier the caller scales by colour.
function bump(theta, phi, theta0, phi0, width) {
	const dTheta = Math.atan2(Math.sin(theta - theta0), Math.cos(theta - theta0));
	const dPhi = phi - phi0;
	const d2 = dTheta * dTheta + dPhi * dPhi;
	return Math.exp(-d2 / (2 * width * width));
}

// Sample radiance for one equirectangular pixel. (u, v) in [0, 1).
//   u ↔ longitude / azimuth (theta): 0 → -π, 1 → +π
//   v ↔ latitude (phi): 0 → +π/2 (zenith), 1 → -π/2 (nadir)
function sampleRadiance(u, v) {
	const theta = (u - 0.5) * Math.PI * 2;
	const phi = (0.5 - v) * Math.PI;

	// Base ambient — very low purple wash.
	let r = 0.012;
	let g = 0.006;
	let b = 0.02;

	// Soft hemisphere — purple ceiling, deep-blue floor — gives PBR
	// chrome a faint tint even where no spotlight points.
	const hemi = 0.5 + 0.5 * Math.sin(phi);
	r += hemi * 0.03;
	g += hemi * 0.014;
	b += hemi * 0.064;

	// Four warm downlights ringed around the dancefloor, one per pole,
	// roughly above the head height (phi ≈ +0.9 rad). Bright enough that
	// chrome / metallic dancer accessories pick up a clear highlight.
	const SPOTS = [
		{ theta: -1.05, hue: [3.4, 1.8, 0.8] }, // warm tungsten
		{ theta: -0.32, hue: [2.2, 0.9, 3.2] }, // magenta
		{ theta: 0.32, hue: [0.9, 2.4, 3.6] }, // cyan
		{ theta: 1.05, hue: [3.4, 1.8, 0.8] }, // warm tungsten
	];
	for (const spot of SPOTS) {
		const w = bump(theta, phi, spot.theta, 0.95, 0.32);
		r += w * spot.hue[0];
		g += w * spot.hue[1];
		b += w * spot.hue[2];
	}

	// Mirrorball glints — a ring of tiny brighter points circling the
	// zenith. Keeps reflective dancer skin lively.
	const mirrorRing = 0.85;
	const mirrorPhi = 1.05;
	const segments = 24;
	for (let i = 0; i < segments; i += 1) {
		const t = (i / segments) * Math.PI * 2 - Math.PI;
		const w = bump(theta, phi, t, mirrorPhi, 0.045);
		r += w * mirrorRing * 1.7;
		g += w * mirrorRing * 1.5;
		b += w * mirrorRing * 1.9;
	}

	// Bar back glow — a single warm wash along the back wall.
	const barGlow = bump(theta, phi, Math.PI, -0.12, 0.6);
	r += barGlow * 1.1;
	g += barGlow * 0.45;
	b += barGlow * 0.95;

	return [r, g, b];
}

function buildHdr() {
	const header =
		'#?RADIANCE\n' +
		'# Authored by three.ws build-club-hdri (CC0 1.0)\n' +
		'FORMAT=32-bit_rle_rgbe\n' +
		`EXPOSURE=1.0\n` +
		'\n' +
		`-Y ${HEIGHT} +X ${WIDTH}\n`;
	const headerBuf = Buffer.from(header, 'ascii');

	const pixelBytes = Buffer.alloc(WIDTH * HEIGHT * 4);
	for (let y = 0; y < HEIGHT; y += 1) {
		for (let x = 0; x < WIDTH; x += 1) {
			const u = (x + 0.5) / WIDTH;
			const v = (y + 0.5) / HEIGHT;
			const [r, g, b] = sampleRadiance(u, v);
			const [R, G, B, E] = packRGBE(r, g, b);
			const idx = (y * WIDTH + x) * 4;
			pixelBytes[idx] = R;
			pixelBytes[idx + 1] = G;
			pixelBytes[idx + 2] = B;
			pixelBytes[idx + 3] = E;
		}
	}

	return Buffer.concat([headerBuf, pixelBytes]);
}

function main() {
	mkdirSync(OUT_DIR, { recursive: true });
	const buf = buildHdr();
	const outPath = resolve(OUT_DIR, 'club-hdri.hdr');
	writeFileSync(outPath, buf);
	console.log(
		`[club-hdri] wrote club-hdri.hdr ${(buf.length / 1024).toFixed(1)} kB (${WIDTH}x${HEIGHT})`,
	);
}

main();
