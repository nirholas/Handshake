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
import { compactClipJson } from './compact-clips.mjs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import { Blob } from 'node:buffer';
import { liftHipsUpright } from './upright-hips.mjs';
import { recenterHips } from './recenter-hips.mjs';

// three's loaders + exporter touch a handful of DOM globals; stub them out for node.
globalThis.self = globalThis;
globalThis.window = globalThis;
// FBXLoader and GLTFLoader both load embedded/referenced textures by creating
// an <img>, wiring 'load'/'error' listeners, then setting .src. We never use
// pixel data here — only skeleton bones (reference rig) and animation tracks
// (clip sources) — but GLTFLoader's parse() (unlike FBXLoader's synchronous
// animation extraction) awaits every texture's load promise before resolving
// the whole scene. A stub whose addEventListener is a no-op NEVER fires that
// promise, so GLTFLoader.parse() hangs forever with no error and no timeout —
// the process just idles until Node's event loop drains and exits silently.
// FakeImage is a real EventTarget: addEventListener actually registers
// listeners, and assigning .src schedules an async synthetic 'load' event
// (next macrotask, matching a real browser's async decode) so both loaders'
// promise chains resolve instead of stalling.
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

// CLI overrides let the bulk Mixamo library pipeline (scripts/mixamo-all.mjs)
// bake into a staging dir for R2 upload without touching the curated public
// set: --config=<path> --out=<dir> --manifest=<path> --url-prefix=<prefix>.
// With no flags, behavior is unchanged (curated set → public/animations).
const cliFlags = Object.fromEntries(
	process.argv.slice(2).map((a) => {
		const m = a.match(/^--([^=]+)(?:=(.*))?$/);
		return m ? [m[1], m[2] ?? true] : [a, true];
	}),
);

// FBX sources are build-time inputs only — kept out of public/ so they never
// ship in the deploy bundle. GLB sources stay in public/animations (some are
// also served at runtime).
const SOURCES_DIR = resolve(ROOT, 'animation-sources');
const OUT_DIR = cliFlags.out ? resolve(ROOT, cliFlags.out) : resolve(ANIM_DIR, 'clips');
const REFERENCE_GLB = resolve(ROOT, 'public/avatars/cz.glb');
const CONFIG = cliFlags.config ? resolve(ROOT, cliFlags.config) : resolve(__dirname, 'animations.config.json');
const MANIFEST_OUT = cliFlags.manifest ? resolve(ROOT, cliFlags.manifest) : resolve(ANIM_DIR, 'manifest.json');
// Hand-authored clips that were never retargeted from an FBX/GLB source (e.g. a
// short pose baked directly as AnimationClip JSON). They still live in OUT_DIR
// as real clip files, but since main() rebuilds `manifest` purely from CONFIG
// entries, anything not in CONFIG would silently vanish from the manifest on
// every rebuild. Merged in below — for the curated build only — so they stay
// permanently reachable instead of regressing every time this script runs.
const EXTRA_CLIPS_FILE = resolve(__dirname, 'animations-extra-clips.json');
const URL_PREFIX = typeof cliFlags['url-prefix'] === 'string' ? cliFlags['url-prefix'] : '/animations/clips/';
const IS_CUSTOM_BUILD = !!(cliFlags.config || cliFlags.out || cliFlags.manifest);
const HASH_CACHE = resolve(OUT_DIR, '.input-hashes.json');

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
	// The reference rig (cz.glb) and several GLB clip sources are Meshopt-
	// compressed; without a decoder GLTFLoader throws "setMeshoptDecoder must be
	// called before loading compressed files". Same decoder the runtime viewer
	// registers (src/viewer/internal.js).
	const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js');
	const buf = readFileSync(path);
	const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	const loader = new GLTFLoader();
	loader.setMeshoptDecoder(MeshoptDecoder);
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

// The reference rig's rest Hips position — the mark a re-centered clip is
// anchored to (see recenter-hips.mjs). Read from the rig rather than hardcoded
// so swapping cz.glb for a future reference rig stays correct.
function collectRestHips(root) {
	let rest = null;
	root.traverse((n) => {
		if (n.isBone && n.name === 'Hips' && !rest) rest = n.position.toArray();
	});
	return rest;
}

// A humanoid hips position track in meters never exceeds ~2m of magnitude;
// centimeter-authored rigs (Mixamo FBX, three.js Soldier/Michelle GLBs) sit
// around 100. Anything past this threshold is unambiguously centimeter data.
const HIPS_CM_THRESHOLD = 10;

function hipsLooksCentimeterScale(clip) {
	for (const track of clip.tracks) {
		const stripped = track.name.replace(MIXAMO_PREFIX, '');
		if (!stripped.endsWith('Hips.position')) continue;
		for (const v of track.values) {
			if (Math.abs(v) > HIPS_CM_THRESHOLD) return true;
		}
	}
	return false;
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
		// for any clip with horizontal motion. Sources already authored in
		// meters get scaleHips:false from the caller's unit detection.
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
 * Trim a clip to its first `maxSec` seconds in place. Used for long looping
 * source dances (a 15s Mixamo twerk loop) where we only ever play a short beat:
 * shipping the full clip is dead weight (~5× the bytes) the browser downloads
 * and parses for motion no one sees. Keyframes past the cutoff are dropped and
 * the duration is pinned so a play-once finishes exactly at the cut.
 *
 * @param {import('three').AnimationClip} clip
 * @param {number} maxSec
 */
function trimClip(clip, maxSec) {
	if (!(maxSec > 0) || clip.duration <= maxSec) return clip;
	for (const track of clip.tracks) {
		const valueSize = track.values.length / track.times.length;
		let keep = track.times.length;
		for (let i = 0; i < track.times.length; i++) {
			if (track.times[i] > maxSec) { keep = i; break; }
		}
		if (keep < 1) keep = 1; // never strip a track to zero keyframes
		if (keep < track.times.length) {
			track.times = track.times.slice(0, keep);
			track.values = track.values.slice(0, keep * valueSize);
		}
	}
	clip.duration = maxSec;
	return clip;
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
	let restHips = null;
	async function getRig() {
		if (avaturnBones) return avaturnBones;
		console.log('[animations] loading reference Avaturn rig:', basename(REFERENCE_GLB));
		const reference = await loadGLB(REFERENCE_GLB);
		avaturnBones = collectBoneNames(reference.scene);
		restHips = collectRestHips(reference.scene);
		console.log(
			`[animations] reference rig has ${avaturnBones.size} bones, rest hips [${(restHips ?? []).map((v) => v.toFixed(3)).join(', ')}]`,
		);
		return avaturnBones;
	}

	const manifest = [];
	let okCount = 0;
	let skipCount = 0;
	let failCount = 0;

	for (const def of config) {
		const sourceCandidates = [resolve(SOURCES_DIR, def.source), resolve(ANIM_DIR, def.source)];
		const fbxPath = sourceCandidates.find((p) => existsSync(p)) ?? sourceCandidates[0];
		const outName = `${def.name}.json`;
		const outPath = resolve(OUT_DIR, outName);

		if (!existsSync(fbxPath)) {
			// Retarget sources are build-time inputs and some are deliberately
			// never committed (`animation-sources/mx-*.fbx` in .gitignore), so a
			// clean checkout legitimately lacks them. The built clip in OUT_DIR is
			// the committed artifact, so republish it rather than dropping a live
			// clip for want of an input we never intended to keep. Retiring a clip
			// is still done by removing its config entry, which is what the
			// regression guard below treats as the source of truth.
			if (existsSync(outPath)) {
				const existing = JSON.parse(readFileSync(outPath, 'utf8'));
				manifest.push({
					name: def.name,
					url: `${URL_PREFIX}${outName}`,
					label: def.label,
					icon: def.icon,
					loop: def.loop !== false,
					...(def.category ? { category: def.category } : {}),
					...(existing.duration ? { duration: existing.duration } : {}),
				});
				console.log(`[animations] PREBUILT ${def.name.padEnd(12)} (source ${def.source} absent)`);
				skipCount++;
				okCount++;
				continue;
			}
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
				url: `${URL_PREFIX}${outName}`,
				label: def.label,
				icon: def.icon,
				loop: def.loop !== false,
				...(def.category ? { category: def.category } : {}),
				...(existing.duration ? { duration: existing.duration } : {}),
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
			// Hip units are detected from the data, never from the extension.
			// Raw Mixamo FBX is centimeter-baked and GLB is usually a meter-scale
			// Avaturn export, but both have exceptions: the three.js Soldier GLBs
			// are cm-authored, and an FBX round-tripped through Blender or
			// glTF-Transform comes back in meters. Trusting the extension there
			// divides hips by 100 and sinks the avatar into the floor.
			const scaleHips = hipsLooksCentimeterScale(sourceClip);
			const { clip, matched, total, dropped } = retargetClip(sourceClip, bones, { scaleHips });
			const matchPct = (matched / total) * 100;
			if (matchPct < 60) {
				console.warn(
					`[animations] SKIP ${def.name}: only ${matchPct.toFixed(0)}% bones matched`,
				);
				failCount++;
				continue;
			}
			clip.name = def.name;
			if (def.trim) trimClip(clip, def.trim);
			const json = await serializeClip(clip);
			// Sources whose up-axis conversion rides on the animated Hips (three.js
			// Soldier/Michelle GLBs) bake a ~90° parent-frame bias the retargeter
			// can't see — re-stand them upright so the runtime fallen-pose guard
			// doesn't reject the clip. Opt-in per source; a no-op on healthy clips.
			if (def.uprightFix) {
				const lift = liftHipsUpright(json);
				if (lift.changed) {
					console.log(
						`[animations] upright ${def.name.padEnd(12)} ${lift.tiltBefore.toFixed(0)}° → ${lift.tiltAfter.toFixed(0)}°`,
					);
				}
			}
			// Sources with the armature transform baked onto the Hips track stand
			// permanently off-origin. Runs after uprightFix so the offset is
			// measured in the corrected frame. Opt-in per source; a no-op on clips
			// already starting on their mark.
			if (def.recenterHips) {
				const shift = recenterHips(json, restHips);
				if (shift.changed) {
					console.log(
						`[animations] recenter ${def.name.padEnd(12)} shifted [${shift.offset.map((v) => v.toFixed(2)).join(', ')}] (${shift.distance.toFixed(2)}m)`,
					);
				}
			}
			// 7 significant digits per number: lossless for float32 keyframes and
			// about half the bytes of double-precision output (scripts/compact-clips.mjs).
			const text = JSON.stringify(compactClipJson(json));
			writeFileSync(outPath, text);
			hashCache[def.name] = cacheKey;
			manifest.push({
				name: def.name,
				url: `${URL_PREFIX}${outName}`,
				label: def.label,
				icon: def.icon,
				loop: def.loop !== false,
				...(def.category ? { category: def.category } : {}),
				...(json.duration ? { duration: json.duration } : {}),
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

	// Regression guard: refuse to publish a manifest that silently drops clips
	// which are still configured and shipped in the previous manifest. A clip
	// legitimately removed from the config may disappear; a configured clip
	// that stops building is a build failure, not a fact to record. (This
	// exact failure shipped once: gitignored FBX sources were missing on a
	// fresh checkout and 11 live clips vanished from the manifest.)
	if (existsSync(MANIFEST_OUT)) {
		const prevNames = new Set(
			JSON.parse(readFileSync(MANIFEST_OUT, 'utf8')).map((c) => c.name),
		);
		const builtNames = new Set(manifest.map((c) => c.name));
		const regressed = config
			.map((d) => d.name)
			.filter((n) => prevNames.has(n) && !builtNames.has(n));
		if (regressed.length) {
			console.error(
				`\n[animations] ABORT: ${regressed.length} previously published clip(s) failed to build and would be dropped from the manifest:`,
			);
			for (const n of regressed) console.error(`[animations]   - ${n}`);
			console.error(
				'[animations] Fix: run `npm run extract:animations` to regenerate extracted sources, restore the missing FBX in animation-sources/, or remove the entry from scripts/animations.config.json if the clip is truly retired. The existing manifest was left untouched.',
			);
			process.exit(1);
		}
	}

	// Merge in hand-authored extra clips (see EXTRA_CLIPS_FILE comment above).
	// Curated build only — a staging/bulk build (--out/--manifest flags) has its
	// own OUT_DIR that never contains these files.
	if (!IS_CUSTOM_BUILD && existsSync(EXTRA_CLIPS_FILE)) {
		const extras = JSON.parse(readFileSync(EXTRA_CLIPS_FILE, 'utf8'));
		const already = new Set(manifest.map((c) => c.name));
		for (const extra of extras) {
			if (already.has(extra.name)) continue;
			const clipPath = resolve(OUT_DIR, `${extra.name}.json`);
			if (!existsSync(clipPath)) {
				console.warn(`[animations] SKIP extra clip "${extra.name}": no baked file at ${clipPath}`);
				continue;
			}
			const { duration } = JSON.parse(readFileSync(clipPath, 'utf8'));
			manifest.push({
				name: extra.name,
				url: `${URL_PREFIX}${extra.name}.json`,
				label: extra.label,
				icon: extra.icon,
				loop: extra.loop !== false,
				...(duration ? { duration } : {}),
			});
			already.add(extra.name);
			console.log(`[animations] EXTRA ${extra.name.padEnd(12)} merged from ${basename(EXTRA_CLIPS_FILE)}`);
		}
	}

	writeFileSync(MANIFEST_OUT, JSON.stringify(manifest, null, '\t') + '\n');
	console.log(`\n[animations] wrote manifest with ${manifest.length} clips → ${MANIFEST_OUT}`);
	console.log(`[animations] ${okCount} ok (${skipCount} cached), ${failCount} failed`);
	if (okCount === 0) process.exit(1);

	// Auto-patch home.html with the real clip count so copy is always accurate.
	// Staging builds (bulk library) don't describe the curated set — skip.
	if (!IS_CUSTOM_BUILD) patchHomeClipCount(manifest.length);
}

function patchHomeClipCount(count) {
	const homePath = resolve(ROOT, 'pages/home.html');
	if (!existsSync(homePath)) return;
	let html = readFileSync(homePath, 'utf8');

	// Round down to nearest 10 for a "X+" style claim; minimum 89.
	const display = `${Math.max(89, Math.floor(count / 10) * 10)}+`;

	// Match "<digits>+ motion/animation clips" and the span-wrapped bento count.
	const updated = html
		.replace(/\d+\+ motion clips/g, `${display} motion clips`)
		.replace(/\d+\+ animation clips/g, `${display} animation clips`)
		.replace(/(<span id="bento-anim-count">)\d+\+(<\/span>)/, `$1${display}$2`);

	if (updated !== html) {
		writeFileSync(homePath, updated);
		console.log(`[animations] patched home.html → "${display} motion clips"`);
	}
}

main().catch((err) => {
	console.error('[animations] build failed:', err);
	process.exit(1);
});
