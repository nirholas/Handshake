#!/usr/bin/env node
// Measure the world-space extents of every published garment, grouped by slot.
//
// Feeds the per-slot proportion envelopes that garment-forge enforces before
// publishing (garment_glb.SLOT_ENVELOPE): the envelope has to sit above every
// legitimately-shaped piece and below the malformed ones, so it is set from
// measurements, not taste. Run it after a seeding batch or a placement change:
//
//   node scripts/measure-garment-extents.mjs
//
// Output is one line per piece plus a per-slot max, which is the number to
// compare against the envelope in workers/garment-forge/garment_glb.py.

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const CATALOG = 'https://storage.googleapis.com/three-ws-garments/garments/catalog.json';

const io = new NodeIO()
	.registerExtensions(ALL_EXTENSIONS)
	.registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

async function extents(url) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
	const doc = await io.readBinary(new Uint8Array(await res.arrayBuffer()));
	const lo = [Infinity, Infinity, Infinity];
	const hi = [-Infinity, -Infinity, -Infinity];
	const p = [0, 0, 0];
	for (const mesh of doc.getRoot().listMeshes()) {
		for (const prim of mesh.listPrimitives()) {
			const pos = prim.getAttribute('POSITION');
			if (!pos) continue;
			for (let i = 0; i < pos.getCount(); i++) {
				pos.getElement(i, p);
				for (let a = 0; a < 3; a++) {
					lo[a] = Math.min(lo[a], p[a]);
					hi[a] = Math.max(hi[a], p[a]);
				}
			}
		}
	}
	return { size: hi.map((v, i) => v - lo[i]), lo, hi };
}

const catalog = await (await fetch(CATALOG)).json();
const bySlot = new Map();
const f = (n) => (Number.isFinite(n) ? n.toFixed(3) : '?');

for (const m of catalog) {
	let e;
	try {
		e = await extents(m.model.uri);
	} catch (err) {
		console.log(`${m.slot.padEnd(10)} ${m.id.padEnd(46)} UNREADABLE ${err.message}`);
		continue;
	}
	const rows = bySlot.get(m.slot) || [];
	rows.push({ id: m.id, ...e });
	bySlot.set(m.slot, rows);
	console.log(
		`${m.slot.padEnd(10)} ${m.id.padEnd(46)} w=${f(e.size[0])} h=${f(e.size[1])} d=${f(e.size[2])} y:[${f(e.lo[1])}..${f(e.hi[1])}]`,
	);
}

console.log('\n=== per-slot maxima (w, h, d) ===');
for (const [slot, rows] of [...bySlot].sort()) {
	const max = [0, 1, 2].map((a) => Math.max(...rows.map((r) => r.size[a])));
	const worst = [0, 1, 2].map((a) => rows.reduce((w, r) => (r.size[a] > w.size[a] ? r : w)).id);
	console.log(`${slot.padEnd(10)} n=${String(rows.length).padStart(2)} max w=${f(max[0])} h=${f(max[1])} d=${f(max[2])}`);
	console.log(`${''.padEnd(10)}    widest=${worst[0]}\n${''.padEnd(10)}    tallest=${worst[1]}\n${''.padEnd(10)}    deepest=${worst[2]}`);
}
