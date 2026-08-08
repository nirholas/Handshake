// Build tiny fixture assets for the /club playwright spec.
//
// We can't ship the real authored nightclub GLB (10+ MB, Blender-authored,
// licensed externally). The e2e spec needs SOMETHING served at the venue
// URLs that exercises the runtime's named-empty contract without dragging
// a paid asset into the repo. So we emit:
//
//   tests/_fixtures/club-venue.glb — a node-only GLB containing every
//   empty in REQUIRED_VENUE_EMPTIES at the same world positions the
//   spec uses elsewhere. No geometry, no materials — just transforms.
//
//   tests/_fixtures/club-hdri.hdr — a hand-rolled minimal Radiance HDR
//   (a 4x4 mid-grey image) so HDRLoader resolves and PMREMGenerator
//   can pre-filter it.
//
// Re-run with `node scripts/build-club-venue-fixture.mjs` after edits to
// REQUIRED_VENUE_EMPTIES. The output files are committed under
// tests/_fixtures/ so playwright runs deterministically without a build
// step.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Document, NodeIO } from '@gltf-transform/core';

import { REQUIRED_VENUE_EMPTIES } from '../src/club-venue.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, '..');
const outDir = join(repo, 'tests/_fixtures');
mkdirSync(outDir, { recursive: true });

// Deterministic positions — kept in sync with the synthetic scene used by
// tests/club-venue-load.test.js so a future regression that miscomputes a
// world transform shows up in both the unit and e2e suites.
const positions = {
	'truss_mirrorball':       [0,    6.0, 0],
	'bar_backsplash_neon':    [0,    1.6, -7.5],
	'stage_01':               [-3.5, 0,   -3.0],
	'stage_02':               [-1.2, 0,   -4.4],
	'stage_03':               [1.2,  0,   -4.4],
	'stage_04':               [3.5,  0,   -3.0],
	'backstage_door_01':      [-3.5, 0,   -6.8],
	'backstage_door_02':      [-1.2, 0,   -7.2],
	'backstage_door_03':      [1.2,  0,   -7.2],
	'backstage_door_04':      [3.5,  0,   -6.8],
	'truss_spot_01':          [-3.5, 6.0, -2.5],
	'truss_spot_02':          [-1.2, 6.0, -4.0],
	'truss_spot_03':          [1.2,  6.0, -4.0],
	'truss_spot_04':          [3.5,  6.0, -2.5],
};

// Sanity-check the table covers exactly the contract — guards against an
// edit to one side without the other.
const missing = REQUIRED_VENUE_EMPTIES.filter((n) => !(n in positions));
const extra = Object.keys(positions).filter((n) => !REQUIRED_VENUE_EMPTIES.includes(n));
if (missing.length || extra.length) {
	throw new Error(
		`fixture positions drift: missing=${missing.join(',') || '∅'} ` +
			`extra=${extra.join(',') || '∅'} — keep this script in sync with ` +
			'REQUIRED_VENUE_EMPTIES in src/club-venue.js',
	);
}

// ── GLB ─────────────────────────────────────────────────────────────────
const doc = new Document();
const root = doc.createNode('venue');
const scene = doc.createScene('venue').addChild(root);
doc.getRoot().setDefaultScene(scene);

for (const name of REQUIRED_VENUE_EMPTIES) {
	const node = doc.createNode(name).setTranslation(positions[name]);
	root.addChild(node);
}

const io = new NodeIO();
const glb = await io.writeBinary(doc);
const glbPath = join(outDir, 'club-venue.glb');
writeFileSync(glbPath, glb);
console.log(`[build-club-venue-fixture] wrote ${glbPath} (${glb.byteLength} bytes)`);

// ── HDR ─────────────────────────────────────────────────────────────────
// Radiance picture format: ASCII header, blank line, "-Y H +X W\n", scanline
// payload. For a 4x4 image we emit 4 uncompressed scanlines of 4 RGBE
// pixels each. Mid-grey at exponent 128 → linear ≈ 0.5. Small enough that
// PMREMGenerator pre-filters it in a single frame.
const W = 4;
const H = 4;
const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${H} +X ${W}\n`;
// One RGBE pixel: 0x80 0x80 0x80 0x80 → R=G=B=0x80 (128), E=0x80 → ≈0.5
const pixel = Buffer.from([0x80, 0x80, 0x80, 0x80]);
const payload = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i += 1) pixel.copy(payload, i * 4);
const hdrBuf = Buffer.concat([Buffer.from(header, 'ascii'), payload]);
const hdrPath = join(outDir, 'club-hdri.hdr');
writeFileSync(hdrPath, hdrBuf);
console.log(`[build-club-venue-fixture] wrote ${hdrPath} (${hdrBuf.byteLength} bytes)`);
