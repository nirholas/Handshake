#!/usr/bin/env node
/**
 * Animation build pipeline.
 *
 * Reads Mixamo FBX clips listed in scripts/animations.config.json, retargets
 * them to the canonical Avaturn skeleton (cz.glb), and writes one GLB per
 * clip into public/animations/clips/. Also rewrites public/animations/manifest.json
 * to point only at clips that retargeted successfully.
 *
 * Why pre-bake?
 *   - On-chain agents must animate without runtime retargeting fragility.
 *   - Browser cold-loads should not re-parse FBX or guess bone names.
 *   - Build-time validation = clips that don't survive retargeting are dropped
 *     here, not silently broken in production.
 *
 * Run via: npm run build:animations
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import { Blob } from 'node:buffer';

// three's loaders + exporter touch a handful of DOM globals; stub them out for node.
globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.document = { createElementNS: () => ({}) };
globalThis.Blob = Blob;

// GLTFExporter calls FileReader.readAsDataURL on Blob-wrapped texture/binary
// chunks. Node has no FileReader; the minimal stub below handles the two
// methods three's exporter actually invokes.
class NodeFileReader extends EventTarget {
	readAsDataURL(blob) {
		blob.arrayBuffer().then((buf) => {
			const b64 = Buffer.from(buf).toString('base64');
			this.result = `data:${blob.type || 'application/octet-stream'};base64,${b64}`;
			this.onload?.({ target: this });
			this.dispatchEvent(new Event('load'));
		});
	}
	readAsArrayBuffer(blob) {
		blob.arrayBuffer().then((buf) => {
			this.result = buf;
			this.onload?.({ target: this });
			this.dispatchEvent(new Event('load'));
		});
	}
}
globalThis.FileReader = NodeFileReader;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const ANIM_DIR = resolve(ROOT, 'public/animations');
const OUT_DIR = resolve(ANIM_DIR, 'clips');
const REFERENCE_GLB = resolve(ROOT, 'public/avatars/cz.glb');
const CONFIG = resolve(__dirname, 'animations.config.json');
const MANIFEST_OUT = resolve(ANIM_DIR, 'manifest.json');
const HASH_CACHE = resolve(ANIM_DIR, 'clips/.input-hashes.json');

function hashFile(path) {
	return createHash('sha1').update(readFileSync(path)).digest('hex');
}

function loadHashCache() {
	try { return JSON.parse(readFileSync(HASH_CACHE, 'utf8')); } catch { return {}; }
}

function saveHashCache(cache) {
	writeFileSync(HASH_CACHE, JSON.stringify(cache, null, '\t') + '\n');
}

const MIXAMO_PREFIX = /^mixamorig\d*[_:]?/i;
// Mixamo FBX exports hip translation in centimeters relative to the rig's
// natural scale. FBXLoader applies a 0.01 unit scale (cm→m), but the hip
// translation track itself is a *delta* baked into the clip and survives that
// rescale. We rescale the hips position track to match Avaturn's meter rig.
// 0.01 = the empirical factor that lands feet on the ground for the Avaturn
// rig (verified against cz.glb). Adjust here if a future rig diverges.
const HIPS_POSITION_SCALE = 0.01;

async function loadGLB(path) {
	const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
	const buf = readFileSync(path);
	const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	const loader = new GLTFLoader();
	return new Promise((res, rej) => loader.parse(ab, '', res, rej));
}

async function loadFBX(path) {
	const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
	const buf = readFileSync(path);
	const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	const loader = new FBXLoader();
	return loader.parse(ab, '');
}

function collectBoneNames(root) {
	const names = new Set();
	root.traverse((n) => {
		if (n.isBone) names.add(n.name);
	});
	return names;
}

/**
 * Retarget a single clip from a Mixamo skeleton to the canonical Avaturn rig.
 *
 * @param {import('three').AnimationClip} clip
 * @param {Set<string>} avaturnBones
 * @returns {{ clip: import('three').AnimationClip, matched: number, total: number, dropped: string[] }}
 */
function retargetClip(clip, avaturnBones, { scaleHips = true } = {}) {
	const dropped = [];
	const newTracks = [];
	for (const track of clip.tracks) {
		const dot = track.name.indexOf('.');
		const boneRaw = track.name.slice(0, dot);
		const property = track.name.slice(dot + 1);
		const stripped = boneRaw.replace(MIXAMO_PREFIX, '');
		if (!avaturnBones.has(stripped)) {
			dropped.push(boneRaw);
			continue;
		}
		const newTrack = track.clone();
		newTrack.name = `${stripped}.${property}`;
		// Mixamo bakes hip translation in cm even after FBXLoader rescaling.
		// Without this, the avatar floats ~100m in the air for clips that have
		// vertical motion (Joyful Jump, Falling, etc.) and slides off-screen
		// for any clip with horizontal motion. Avaturn GLBs already use meters,
		// so the caller passes scaleHips:false for those.
		if (scaleHips && stripped === 'Hips' && property === 'position') {
			for (let i = 0; i < newTrack.values.length; i++) {
				newTrack.values[i] *= HIPS_POSITION_SCALE;
			}
		}
		newTracks.push(newTrack);
	}
	const out = clip.clone();
	out.tracks = newTracks;
	return { clip: out, matched: newTracks.length, total: clip.tracks.length, dropped };
}

/**
 * Serialize a retargeted clip as three.js native JSON. Loaded at runtime with
 * AnimationClip.parse — no FBXLoader, no GLTFLoader, no retargeting needed in
 * the browser. ~5–10× smaller than the equivalent GLB and round-trips losslessly.
 */
async function serializeClip(clip) {
	const { AnimationClip } = await import('three');
	return AnimationClip.toJSON(clip);
}

async function main() {
	const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
	mkdirSync(OUT_DIR, { recursive: true });

	const hashCache = loadHashCache();
	const rigHash = hashFile(REFERENCE_GLB);
	const configHash = hashFile(CONFIG);
	const inputKey = `rig:${rigHash}|config:${configHash}`;

	// Lazy-load the reference rig only if at least one clip needs retargeting.
	let avaturnBones = null;
	async function getRig() {
		if (avaturnBones) return avaturnBones;
		console.log('[animations] loading reference Avaturn rig:', basename(REFERENCE_GLB));
		const reference = await loadGLB(REFERENCE_GLB);
		avaturnBones = collectBoneNames(reference.scene);
		console.log(`[animations] reference rig has ${avaturnBones.size} bones`);
		return avaturnBones;
	}

	const manifest = [];
	let okCount = 0;
	let skipCount = 0;
	let failCount = 0;

	for (const def of config) {
		const fbxPath = resolve(ANIM_DIR, def.source);
		const outName = `${def.name}.json`;
		const outPath = resolve(OUT_DIR, outName);

		if (!existsSync(fbxPath)) {
			console.warn(`[animations] SKIP ${def.name}: missing source ${def.source}`);
			failCount++;
			continue;
		}

		// Skip retargeting if the FBX + rig + config haven't changed and output exists.
		const fbxHash = hashFile(fbxPath);
		const cacheKey = `${inputKey}|fbx:${fbxHash}`;
		if (hashCache[def.name] === cacheKey && existsSync(outPath)) {
			const existing = JSON.parse(readFileSync(outPath, 'utf8'));
			manifest.push({
				name: def.name,
				url: `/animations/clips/${outName}`,
				label: def.label,
				icon: def.icon,
				loop: def.loop !== false,
			});
			console.log(`[animations] CACHED ${def.name}`);
			skipCount++;
			okCount++;
			continue;
		}

		try {
			const bones = await getRig();
			const isGlb = /\.glb$/i.test(fbxPath);
			let sourceClip;
			if (isGlb) {
				const gltf = await loadGLB(fbxPath);
				sourceClip = gltf.animations?.[0];
			} else {
				const fbx = await loadFBX(fbxPath);
				sourceClip = fbx.animations?.[0];
			}
			if (!sourceClip) {
				console.warn(`[animations] SKIP ${def.name}: no clip in source ${def.source}`);
				failCount++;
				continue;
			}
			const { clip, matched, total, dropped } = retargetClip(sourceClip, bones, { scaleHips: !isGlb });
			const matchPct = (matched / total) * 100;
			if (matchPct < 60) {
				console.warn(
					`[animations] SKIP ${def.name}: only ${matchPct.toFixed(0)}% bones matched`,
				);
				failCount++;
				continue;
			}
			clip.name = def.name;
			const json = await serializeClip(clip);
			const text = JSON.stringify(json);
			writeFileSync(outPath, text);
			hashCache[def.name] = cacheKey;
			manifest.push({
				name: def.name,
				url: `/animations/clips/${outName}`,
				label: def.label,
				icon: def.icon,
				loop: def.loop !== false,
			});
			okCount++;
			const droppedNote = dropped.length ? ` (dropped ${dropped.length} unknown bones)` : '';
			console.log(
				`[animations] OK   ${def.name.padEnd(12)} ${matched}/${total} tracks, ${(text.length / 1024).toFixed(0)}kB${droppedNote}`,
			);
		} catch (err) {
			console.warn(`[animations] FAIL ${def.name}: ${err.message}`);
			failCount++;
		}
	}

	saveHashCache(hashCache);
	writeFileSync(MANIFEST_OUT, JSON.stringify(manifest, null, '\t') + '\n');
	console.log(`\n[animations] wrote manifest with ${manifest.length} clips → ${MANIFEST_OUT}`);
	console.log(`[animations] ${okCount} ok (${skipCount} cached), ${failCount} failed`);
	if (okCount === 0) process.exit(1);
}

main().catch((err) => {
	console.error('[animations] build failed:', err);
	process.exit(1);
});
