// Verify a published garment against the runtime wardrobe contract.
//
// Downloads (or reads) a garment manifest, verifies the manifest's sha256
// against the fetched GLB bytes, loads the garment and a target avatar with
// three's GLTFLoader, runs the REAL runtime attach path
// (attachGarment from src/avatar-garment.js), and reports the measured bind
// coverage plus the skin-occlusion result for the manifest's `occludes`.
//
// This is the "definition of done" harness for workers/garment-forge: a
// garment only counts as shipped when this script attaches it to an avatar
// at >= MIN_BIND_COVERAGE.
//
// Usage:
//   node scripts/verify-garment.mjs <manifest.json url|path> [avatar.glb url|path]
//
// The avatar defaults to public/avatars/parametric-base.glb, the platform's
// canonical body. Pass any other humanoid GLB to prove cross-rig attachment.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Blob } from 'node:buffer';

// three's GLTFLoader touches DOM globals; same shims as scripts/build-animations.mjs.
globalThis.self = globalThis;
globalThis.window = globalThis;
class FakeImage extends EventTarget {
	constructor() {
		super();
		this._src = '';
		this.style = {};
		this.complete = false;
		this.naturalWidth = 1;
		this.naturalHeight = 1;
	}
	get src() { return this._src; }
	set src(value) {
		this._src = value;
		setTimeout(() => {
			this.complete = true;
			this.onload?.({ target: this });
			this.dispatchEvent(new Event('load'));
		}, 0);
	}
	setAttribute() {}
}
globalThis.document = {
	createElementNS: () => new FakeImage(),
	createElement: () => new FakeImage(),
};
globalThis.Image = FakeImage;
globalThis.Blob = Blob;

const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
// Meshopt-compressed avatars (xbot, cz, the realistic set) decode with the
// pure-WASM decoder three ships; no workers, so it runs in plain Node.
const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
const { attachGarment, applySkinOcclusion, MIN_BIND_COVERAGE } =
	await import('../src/avatar-garment.js');

async function fetchBytes(source) {
	if (/^https?:\/\//.test(source)) {
		const res = await fetch(source);
		if (!res.ok) throw new Error(`${source} -> HTTP ${res.status}`);
		return Buffer.from(await res.arrayBuffer());
	}
	return readFileSync(resolve(process.cwd(), source));
}

function loadGlb(bytes) {
	const loader = new GLTFLoader();
	loader.setMeshoptDecoder(MeshoptDecoder);
	return new Promise((res, rej) => {
		loader.parse(
			bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
			'',
			(gltf) => res(gltf),
			rej,
		);
	});
}

const [manifestSource, avatarSource = 'public/avatars/parametric-base.glb'] =
	process.argv.slice(2);
if (!manifestSource) {
	console.error('usage: node scripts/verify-garment.mjs <manifest url|path> [avatar url|path]');
	process.exit(2);
}

const manifest = JSON.parse((await fetchBytes(manifestSource)).toString('utf8'));
console.log(`manifest: ${manifest.id} v${manifest.version} slot=${manifest.slot}`);

const glbBytes = await fetchBytes(manifest.model.uri);
const sha = createHash('sha256').update(glbBytes).digest('hex');
if (sha !== manifest.model.sha256) {
	console.error(`FAIL sha256 mismatch: manifest=${manifest.model.sha256} fetched=${sha}`);
	process.exit(1);
}
console.log(`sha256 ok (${glbBytes.length} bytes)`);

const [avatar, garment] = await Promise.all([
	fetchBytes(avatarSource).then(loadGlb),
	loadGlb(glbBytes),
]);
avatar.scene.updateMatrixWorld(true);
garment.scene.updateMatrixWorld(true);

const result = attachGarment(avatar.scene, garment.scene, { slot: manifest.slot });
if (!result.ok) {
	console.error(`FAIL attachGarment refused: ${result.reason}`);
	console.error(`coverage=${result.coverage.toFixed(4)} unresolved=${result.unresolved.join(', ')}`);
	process.exit(1);
}

const occlusion = applySkinOcclusion(avatar.scene, manifest.occludes);

console.log(`attachGarment: ok slot=${result.slot} meshes=${result.meshes.length}`);
console.log(`coverage: ${result.coverage.toFixed(4)} (gate ${MIN_BIND_COVERAGE})`);
if (result.unresolved.length) {
	console.log(`unresolved bones (ancestor-fallback applied upstream of coverage): ${result.unresolved.join(', ')}`);
}
console.log(`occludes: [${manifest.occludes.join(', ')}] -> applied via ${occlusion.method}`
	+ (occlusion.trianglesHidden ? ` (${occlusion.trianglesHidden} triangles hidden)` : ''));
console.log(`PASS ${manifest.id} binds at ${(result.coverage * 100).toFixed(1)}% >= ${MIN_BIND_COVERAGE * 100}%`);
