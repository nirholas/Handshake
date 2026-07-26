// Catalog-wide garment quality audit.
//
// For EVERY entry in the live wardrobe catalog:
//   1. consumer validation (the same validateManifest the closet runs),
//   2. sha256 of the fetched GLB against the manifest,
//   3. attachGarment onto the canonical body (the real runtime bind path),
//   4. the walk-gait deviation metric from the rig-path bake-off: distance
//      from each skinned garment vertex to the nearest body vertex, sampled
//      across the canonical walk clip. Good cloth keeps a small bounded
//      offset; broken skinning spikes.
//
// Hard failures (validation reject, sha mismatch, attach refusal) exit 1 so
// this can gate a seeding batch. Gait stats are reported per garment with a
// per-slot p95 ceiling; breaching it is a WARN (geometry taste, not a broken
// contract) and is listed for human review.
//
// Usage:
//   node scripts/audit-garments.mjs [--catalog <url>] [--avatar <glb path>]

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Blob } from 'node:buffer';

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
const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
const { Group, Vector3, AnimationClip, AnimationMixer } = await import('three');
const { attachGarment } = await import('../src/avatar-garment.js');
const { retargetClipToObject } = await import('../src/animation-retarget.js');
const { sanitizeCatalog, GARMENT_CATALOG_URL } = await import('../src/garment-catalog.js');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const CATALOG_URL = flag('catalog', GARMENT_CATALOG_URL);
const AVATAR_PATH = resolve(process.cwd(), flag('avatar', 'public/avatars/parametric-base.glb'));

// p95 cloth-to-body ceilings (meters) per slot before a garment is flagged
// for review. Body-hugging slots sit tight; loose slots (hair, bags) ride
// farther by design. Derived from the 2026-07-25 bake-off (production shirt:
// p95 6.4 cm) with headroom for looser cuts.
const P95_CEILING = {
	top: 0.12, outerwear: 0.15, bottom: 0.12, footwear: 0.10,
	hair: 0.20, headwear: 0.15, glasses: 0.12, accessory: 0.25,
};
const GAIT_SAMPLES = [0.1, 0.3, 0.5, 0.7, 0.9];

function loadGlb(bytes) {
	const loader = new GLTFLoader();
	loader.setMeshoptDecoder(MeshoptDecoder);
	return new Promise((res, rej) => {
		loader.parse(
			bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '', res, rej,
		);
	});
}

async function fetchBytes(url) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
}

// Distance stats from each skinned garment vertex to the nearest body vertex,
// sampled across the walk gait. Brute-force nearest with a stride cap keeps
// the audit under a second per garment without changing the verdict.
function gaitStats(root, body, garmentMesh, clip) {
	const mixer = new AnimationMixer(root);
	mixer.clipAction(clip).play();
	const gPos = garmentMesh.geometry.attributes.position;
	const bPos = body.geometry.attributes.position;
	const gStride = Math.max(1, Math.floor(gPos.count / 800));
	const bStride = Math.max(1, Math.floor(bPos.count / 2500));
	const gv = new Vector3();
	const bv = new Vector3();
	const bodyPts = [];
	const all = [];

	for (const t of GAIT_SAMPLES) {
		mixer.setTime(t * clip.duration);
		root.updateMatrixWorld(true);
		body.skeleton.update();
		garmentMesh.skeleton.update();

		bodyPts.length = 0;
		for (let i = 0; i < bPos.count; i += bStride) {
			bodyPts.push(body.applyBoneTransform(i, bv.fromBufferAttribute(bPos, i)).clone());
		}
		for (let i = 0; i < gPos.count; i += gStride) {
			garmentMesh.applyBoneTransform(i, gv.fromBufferAttribute(gPos, i));
			let best = Infinity;
			for (const p of bodyPts) {
				const d = gv.distanceToSquared(p);
				if (d < best) best = d;
			}
			all.push(Math.sqrt(best));
		}
	}
	all.sort((a, b) => a - b);
	const mean = all.reduce((s, d) => s + d, 0) / all.length;
	return {
		mean,
		p95: all[Math.floor(all.length * 0.95)],
		max: all[all.length - 1],
		n: all.length,
	};
}

const avatarBytes = readFileSync(AVATAR_PATH);
const clipJson = JSON.parse(readFileSync(resolve(process.cwd(), 'public/animations/clips/walk.json'), 'utf8'));
const walkClip = AnimationClip.parse(clipJson.clip || clipJson);

const raw = await (await fetch(CATALOG_URL)).json();
const { garments, rejected } = sanitizeCatalog(raw);
console.log(`catalog: ${raw.length} entries, ${garments.length} valid, ${rejected.length} rejected`);
for (const r of rejected) console.log(`  REJECTED ${r.id}: ${r.errors.join('; ')}`);

let hardFailures = rejected.length;
const warns = [];

for (const m of garments) {
	const label = `${m.slot}/${m.id}`;
	try {
		const glb = await fetchBytes(m.model.uri);
		const sha = createHash('sha256').update(glb).digest('hex');
		if (sha !== m.model.sha256) throw new Error('sha256 mismatch');

		const avatar = await loadGlb(avatarBytes);
		const root = new Group();
		root.add(avatar.scene);
		root.updateMatrixWorld(true);
		const garment = await loadGlb(glb);
		garment.scene.updateMatrixWorld(true);

		const res = attachGarment(root, garment.scene, { slot: m.slot });
		if (!res.ok) throw new Error(`attach refused: ${res.reason}`);

		let body = null;
		root.traverse((o) => {
			if (o.isSkinnedMesh && !o.userData.garmentSlot
				&& (!body || o.geometry.attributes.position.count > body.geometry.attributes.position.count)) body = o;
		});
		const { clip: rClip } = retargetClipToObject(walkClip, root);
		if (!rClip) throw new Error('walk clip failed to retarget onto the audit avatar');

		const stats = gaitStats(root, body, res.meshes[0], rClip);
		const ceiling = P95_CEILING[m.slot] ?? 0.2;
		const flag = stats.p95 > ceiling ? '  << WARN p95 over slot ceiling' : '';
		if (flag) warns.push(label);
		console.log(
			`ok    ${label.padEnd(52)} coverage=${res.coverage.toFixed(3)} `
			+ `gait mean=${(stats.mean * 100).toFixed(1)}cm p95=${(stats.p95 * 100).toFixed(1)}cm `
			+ `max=${(stats.max * 100).toFixed(1)}cm (n=${stats.n})${flag}`,
		);
	} catch (err) {
		hardFailures++;
		console.log(`FAIL  ${label.padEnd(52)} ${err.message}`);
	}
}

console.log(`\n${garments.length} audited, ${hardFailures} hard failures, ${warns.length} review flags`
	+ (warns.length ? `: ${warns.join(', ')}` : ''));
process.exit(hardFailures ? 1 : 0);
