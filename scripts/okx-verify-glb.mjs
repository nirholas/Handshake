#!/usr/bin/env node
/**
 * GLB artifact verifier for the OKX.AI paid-service gauntlet.
 *
 * Why this exists: a paid call that answers HTTP 200 has not delivered
 * anything until the bytes it points at are a real model. The failure modes we
 * actually hit are quiet ones: a zero-byte file, an error JSON saved under a
 * .glb name, a valid container with no geometry, or a "rigged avatar" that
 * ships a mesh with no skeleton. Each of those reads as success to curl, so
 * work order 04 verifies artifacts here instead of assuming.
 *
 * Checks, in order of how badly they fail:
 *   1. the bytes parse as a glTF binary container (magic, version, chunks)
 *   2. geometry exists: at least one mesh primitive with a non-empty POSITION
 *   3. --rigged additionally requires a skeleton: a skin with joints, plus
 *      non-degenerate skin weights on a primitive (JOINTS_0 / WEIGHTS_0)
 *
 * Usage:
 *   node scripts/okx-verify-glb.mjs <url-or-path>
 *   node scripts/okx-verify-glb.mjs <url-or-path> --rigged
 *   node scripts/okx-verify-glb.mjs <url-or-path> --json report.json
 *
 * Exit 0 = every requested check passed. Exit 1 = a check failed. Exit 2 = the
 * artifact could not be fetched or read at all.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder } from 'meshoptimizer';

const GLB_MAGIC = 0x46546c67; // "glTF"

function parseArgs(argv) {
	const args = { target: null, rigged: false, json: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--rigged') args.rigged = true;
		else if (a === '--json') args.json = argv[++i];
		else if (!args.target) args.target = a;
	}
	return args;
}

async function loadBytes(target) {
	if (/^https?:\/\//.test(target)) {
		const res = await fetch(target, { signal: AbortSignal.timeout(180_000) });
		if (!res.ok) throw new Error(`fetch ${target} returned HTTP ${res.status}`);
		return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') || '' };
	}
	return { bytes: new Uint8Array(await readFile(target)), contentType: '' };
}

// The cheap structural pass. It runs before the glTF parser so that the common
// "an error JSON was saved as .glb" case reports what the body actually said
// instead of a parser stack trace.
function inspectContainer(bytes) {
	if (bytes.byteLength === 0) return { ok: false, reason: 'artifact is zero bytes' };
	if (bytes.byteLength < 12) return { ok: false, reason: `artifact is only ${bytes.byteLength} bytes, too short for a GLB header` };
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const magic = view.getUint32(0, true);
	if (magic !== GLB_MAGIC) {
		const head = Buffer.from(bytes.slice(0, 200)).toString('utf8').replace(/\s+/g, ' ').trim();
		return { ok: false, reason: `not a GLB container (magic 0x${magic.toString(16)}), body starts: ${head}` };
	}
	const version = view.getUint32(4, true);
	const declared = view.getUint32(8, true);
	if (declared !== bytes.byteLength) {
		return { ok: false, reason: `GLB header declares ${declared} bytes but the artifact is ${bytes.byteLength}, truncated download` };
	}
	return { ok: true, version, byteLength: bytes.byteLength };
}

async function readDocument(bytes) {
	const io = new NodeIO()
		.registerExtensions(ALL_EXTENSIONS)
		.registerDependencies({
			'draco3d.decoder': await draco3d.createDecoderModule(),
			'meshopt.decoder': MeshoptDecoder,
		});
	return io.readBinary(bytes);
}

// Geometry and rig facts, read off the parsed document rather than the header.
function inspectDocument(doc) {
	const root = doc.getRoot();
	const facts = {
		meshes: root.listMeshes().length,
		primitives: 0,
		vertices: 0,
		triangles: 0,
		textures: root.listTextures().length,
		materials: root.listMaterials().length,
		animations: root.listAnimations().length,
		skins: root.listSkins().length,
		joints: 0,
		skinnedPrimitives: 0,
		weightedVertices: 0,
	};

	for (const mesh of root.listMeshes()) {
		for (const prim of mesh.listPrimitives()) {
			facts.primitives++;
			const pos = prim.getAttribute('POSITION');
			if (pos) facts.vertices += pos.getCount();
			const idx = prim.getIndices();
			if (idx) facts.triangles += Math.floor(idx.getCount() / 3);
			else if (pos) facts.triangles += Math.floor(pos.getCount() / 3);

			const joints = prim.getAttribute('JOINTS_0');
			const weights = prim.getAttribute('WEIGHTS_0');
			if (!joints || !weights) continue;
			facts.skinnedPrimitives++;
			// A JOINTS_0/WEIGHTS_0 pair can still be inert: an all-zero weight
			// set binds nothing and the model animates as a statue. Count the
			// vertices that carry real influence.
			const count = weights.getCount();
			const el = [];
			for (let i = 0; i < count; i++) {
				weights.getElement(i, el);
				if (el.some((w) => w > 0)) facts.weightedVertices++;
			}
		}
	}

	const jointSet = new Set();
	for (const skin of root.listSkins()) {
		for (const joint of skin.listJoints()) jointSet.add(joint.getName() || joint);
	}
	facts.joints = jointSet.size;
	facts.jointNames = [...jointSet].slice(0, 40);
	return facts;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.target) {
		console.error('usage: node scripts/okx-verify-glb.mjs <url-or-path> [--rigged] [--json out.json]');
		process.exit(2);
	}

	let loaded;
	try {
		loaded = await loadBytes(args.target);
	} catch (err) {
		console.error(`FAIL  could not read artifact: ${err.message}`);
		process.exit(2);
	}

	const report = { target: args.target, contentType: loaded.contentType, checks: [] };
	const check = (name, ok, detail) => {
		report.checks.push({ name, ok, detail });
		console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
		return ok;
	};

	const container = inspectContainer(loaded.bytes);
	if (!check('container is a GLB', container.ok, container.ok ? `glTF v${container.version}, ${container.byteLength} bytes` : container.reason)) {
		if (args.json) await writeFile(args.json, JSON.stringify(report, null, 2));
		process.exit(1);
	}
	report.byteLength = container.byteLength;

	let doc;
	try {
		doc = await readDocument(loaded.bytes);
	} catch (err) {
		check('glTF document parses', false, err.message);
		if (args.json) await writeFile(args.json, JSON.stringify(report, null, 2));
		process.exit(1);
	}
	check('glTF document parses', true);

	const facts = inspectDocument(doc);
	report.facts = facts;

	let ok = true;
	ok = check('has geometry', facts.vertices > 0, `${facts.meshes} mesh(es), ${facts.primitives} primitive(s), ${facts.vertices} vertices, ${facts.triangles} triangles`) && ok;

	if (args.rigged) {
		ok = check('has a skeleton', facts.skins > 0 && facts.joints > 0, `${facts.skins} skin(s), ${facts.joints} joints`) && ok;
		ok = check('has skinned mesh geometry', facts.skinnedPrimitives > 0, `${facts.skinnedPrimitives} primitive(s) carry JOINTS_0 + WEIGHTS_0`) && ok;
		ok = check('skin weights are non-empty', facts.weightedVertices > 0, `${facts.weightedVertices} vertices carry non-zero influence`) && ok;
		if (facts.jointNames?.length) console.log(`      joints: ${facts.jointNames.slice(0, 12).join(', ')}${facts.joints > 12 ? `, +${facts.joints - 12} more` : ''}`);
	}

	report.ok = ok;
	if (args.json) await writeFile(args.json, JSON.stringify(report, null, 2));
	console.log(ok ? '\nARTIFACT: PASS' : '\nARTIFACT: FAIL');
	process.exit(ok ? 0 : 1);
}

await main();
