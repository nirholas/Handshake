#!/usr/bin/env node
/**
 * Stage the Trench Car GLB into public/vehicles/trench-car.glb.
 *
 * The Trench Car is a community model published to the three.ws avatar gallery
 * (avatar e702d59a-d29f-4f21-af8a-6400dd1a2c6f, slug `trench-car`). It is the
 * default car in the world: ambient traffic drives it and it is the vehicle
 * parked at the /play spawn plaza for players to take the wheel.
 *
 * The published master is 16 MB, almost all of it two oversized textures (a
 * 2048² metal-roughness PNG and a 5333×5292 body-wrap JPEG). Every /play visitor
 * downloads this file, so the master is unusable as-is. This script pulls the
 * master from the live avatar API (no hardcoded storage URL, so a re-upload of
 * the same avatar re-stages cleanly), caps texture resolution, and runs the same
 * geometry chain scripts/compress-glbs.mjs uses, landing well under 2 MB with no
 * visible change at gameplay distance.
 *
 * The output keeps EXT_meshopt_compression, which every loader that touches it
 * already wires a decoder for (src/game/vehicle-model.js, shared with
 * src/game/avatar-rig.js).
 *
 *   npm run build:trench-car            # fetch + optimize + write
 *   npm run build:trench-car -- --dry   # report the sizes, write nothing
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, resample, weld, simplify, quantize, meshopt, textureCompress } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const AVATAR_ID = 'e702d59a-d29f-4f21-af8a-6400dd1a2c6f';
const API = process.env.THREE_WS_API_BASE || 'https://three.ws';
const OUT = path.join(ROOT, 'public', 'vehicles', 'trench-car.glb');
const DRY = process.argv.includes('--dry');

// The body wrap carries the model's identity (the collage livery), so it keeps
// the larger cap; the metal-roughness map is a grayscale detail texture that
// reads identically at half resolution.
const COLOR_CAP = [2048, 2048];
const DATA_CAP = [1024, 1024];

function fmt(n) {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

async function fetchMaster() {
	const metaUrl = `${API}/api/avatars/${AVATAR_ID}`;
	const metaRes = await fetch(metaUrl, { headers: { accept: 'application/json' } });
	if (!metaRes.ok) throw new Error(`avatar lookup failed: ${metaRes.status} ${metaUrl}`);
	const { avatar } = await metaRes.json();
	const src = avatar?.model_url || avatar?.url;
	if (!src) throw new Error(`avatar ${AVATAR_ID} has no model URL`);
	console.log(`[trench-car] source: ${avatar.name} (${avatar.slug}) → ${src}`);
	const glbRes = await fetch(src);
	if (!glbRes.ok) throw new Error(`model download failed: ${glbRes.status} ${src}`);
	return Buffer.from(await glbRes.arrayBuffer());
}

async function main() {
	await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
	const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
		'meshopt.encoder': MeshoptEncoder,
		'meshopt.decoder': MeshoptDecoder,
	});

	const master = await fetchMaster();
	console.log(`[trench-car] master: ${fmt(master.byteLength)}`);

	const document = await io.readBinary(new Uint8Array(master));
	await document.transform(
		dedup(),
		prune(),
		resample(),
		// The master is a 263k-triangle studio model. A world with a lane of
		// traffic plus a parked fleet draws a dozen of these at once, with shadow
		// casting on top, so decimate to a game budget: `error` is a fraction of
		// the AABB, and 0.5% keeps the silhouette, the wheel arches and the rims
		// reading correctly while cutting the triangle count by ~2/3.
		weld(),
		simplify({ simplifier: MeshoptSimplifier, ratio: 0.35, error: 0.005 }),
		quantize(),
		meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
		textureCompress({
			encoder: sharp, targetFormat: 'webp', quality: 88,
			slots: /metallicRoughness|occlusion|normal/, resize: DATA_CAP,
		}),
		textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 90, resize: COLOR_CAP }),
	);

	const bytes = await io.writeBinary(document);
	const pct = ((1 - bytes.byteLength / master.byteLength) * 100).toFixed(1);
	console.log(`[trench-car] optimized: ${fmt(bytes.byteLength)} (-${pct}%)`);

	for (const tex of document.getRoot().listTextures()) {
		const size = tex.getSize();
		console.log(`  texture ${tex.getName() || '(unnamed)'}: ${size?.join('x')} ${tex.getMimeType()} ${fmt(tex.getImage()?.byteLength || 0)}`);
	}

	if (DRY) { console.log('[trench-car] --dry: nothing written.'); return; }
	fs.mkdirSync(path.dirname(OUT), { recursive: true });
	fs.writeFileSync(OUT, bytes);
	console.log(`[trench-car] wrote ${path.relative(ROOT, OUT)}`);
}

main().catch((err) => {
	console.error('[trench-car] fatal:', err.message);
	process.exit(1);
});
