#!/usr/bin/env node
/**
 * Exercise the PBR derivation pass across every material class.
 *
 * api/_lib/glb-pbr-derive.js fills a model's missing PBR channels from a
 * material class: skin gets sheen and a pulled-down specular, glass gets
 * transmission and an IOR, car paint gets a clearcoat. The class is normally
 * picked from the generation prompt, which means a change to the class table or
 * to the classifier is easy to ship and hard to see. This runs one input GLB
 * through each class in turn and prints what the pass actually derived, so the
 * table can be reviewed as a table instead of one generation at a time.
 *
 *   node scripts/derive-pbr-classes.mjs model.glb
 *   node scripts/derive-pbr-classes.mjs model.glb --out=/tmp/pbr --classes=glass,person
 *   node scripts/derive-pbr-classes.mjs model.glb --json
 *
 * With --out, each class writes `<out>/<basename>.<class>.glb`, ready to open in
 * the viewer or hand to scripts/inspect-glb-materials.mjs for the channel table.
 * Without it nothing is written and only the report is printed.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, extname, resolve, join } from 'node:path';
import {
	derivePbrChannels,
	MATERIAL_CLASSES,
	MATERIAL_CLASS_IDS,
} from '../api/_lib/glb-pbr-derive.js';

function parseArgs(argv) {
	const args = { input: null, out: null, classes: MATERIAL_CLASS_IDS, tier: 'standard', json: false };
	for (const raw of argv) {
		if (raw === '--json') args.json = true;
		else if (raw.startsWith('--out=')) args.out = raw.slice('--out='.length);
		else if (raw.startsWith('--tier=')) args.tier = raw.slice('--tier='.length);
		else if (raw.startsWith('--classes=')) args.classes = raw.slice('--classes='.length).split(',').map((s) => s.trim()).filter(Boolean);
		else if (raw.startsWith('--')) throw new Error(`unknown flag ${raw}`);
		else if (args.input) throw new Error('only one input GLB is supported');
		else args.input = raw;
	}
	const unknown = args.classes.filter((c) => !MATERIAL_CLASS_IDS.includes(c));
	if (unknown.length) throw new Error(`unknown material class(es): ${unknown.join(', ')}. Known: ${MATERIAL_CLASS_IDS.join(', ')}`);
	if (!['draft', 'standard', 'high'].includes(args.tier)) throw new Error(`--tier must be draft, standard or high`);
	return args;
}

/** The class table itself, so a run shows what it is applying, not just the result. */
function printClassTable(ids) {
	console.log('material classes');
	for (const id of ids) {
		const c = MATERIAL_CLASSES[id];
		const roughness = typeof c.roughness === 'object' ? `${c.roughness.base} [${c.roughness.min}..${c.roughness.max}]` : String(c.roughness);
		const ext = Object.keys(c.ext || {}).join(', ') || '(none)';
		console.log(`  ${id.padEnd(13)} metallic=${c.metallic}  roughness=${roughness.padEnd(22)} ext: ${ext}`);
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.input) {
		console.error('usage: node scripts/derive-pbr-classes.mjs <model.glb> [--classes=a,b] [--tier=standard] [--out=<dir>] [--json]');
		process.exit(2);
	}

	const buf = await readFile(resolve(args.input));
	if (args.out) await mkdir(resolve(args.out), { recursive: true });
	const stem = basename(args.input, extname(args.input));

	if (!args.json) {
		printClassTable(args.classes);
		console.log(`\ninput ${args.input}  ${(buf.byteLength / 1024).toFixed(1)} KiB  tier=${args.tier}\n`);
	}

	const results = [];
	for (const materialClass of args.classes) {
		const r = await derivePbrChannels(buf, { materialClass, tier: args.tier });
		let outPath = null;
		if (args.out) {
			outPath = join(resolve(args.out), `${stem}.${materialClass}.glb`);
			await writeFile(outPath, r.buffer);
		}
		const row = {
			materialClass,
			changed: r.changed,
			inputBytes: r.inputBytes,
			outputBytes: r.outputBytes,
			materialsCreated: r.materialsCreated,
			normalsFilled: r.normalsFilled,
			materials: r.materials,
			outPath,
		};
		results.push(row);
		if (!args.json) {
			const derived = [...new Set(r.materials.flatMap((m) => m.derived))].sort();
			console.log(
				`  ${materialClass.padEnd(13)} ${r.changed ? 'changed' : 'no-op  '}  ${(r.outputBytes / 1024).toFixed(1).padStart(8)} KiB  derived: ${derived.join(', ') || '(nothing)'}`,
			);
			if (outPath) console.log(`                wrote ${outPath}`);
		}
	}

	if (args.json) {
		console.log(JSON.stringify({ generatedAt: new Date().toISOString(), input: args.input, tier: args.tier, results }, null, 2));
	} else {
		const inert = results.filter((r) => !r.changed).map((r) => r.materialClass);
		console.log('');
		console.log(
			inert.length
				? `${inert.length} class(es) derived nothing on this input: ${inert.join(', ')}`
				: `All ${results.length} class(es) derived at least one channel.`,
		);
	}
}

main().catch((err) => {
	console.error(err.message || err);
	process.exit(2);
});
