// Server-side rig inspection for stored GLBs.
//
// The rig classifier needs to know whether an avatar carries a skeleton
// (glTF skins[] + joints). That signal lives entirely in the glTF JSON chunk,
// which sits at the head of the file — so we read only a leading prefix via a
// ranged request and never download the (potentially large) mesh binary.
//
// Used at upload time (api/avatars/index.js → handleCreate) so every new avatar
// self-classifies, and by scripts/backfill-rig-meta.mjs to populate avatars
// that predate the classifier.

import { getObjectRange } from './r2.js';
import { inspectGlb, glbJsonChunkEnd } from './glb-inspect.js';
import { fetchUpstream } from './upstream-fetch.js';

// 256 KB covers the JSON chunk of essentially every real avatar in one read.
const INITIAL_PREFIX = 256 * 1024;
// Refetch ceiling — a JSON chunk larger than this is pathological; leave it
// "unknown" rather than pull megabytes hunting for joints.
const MAX_PREFIX = 8 * 1024 * 1024;

async function readGlbPrefix(storageKey, length) {
	if (/^https?:\/\//i.test(storageKey)) {
		// Externally-hosted / first-party absolute URLs (e.g. the built-in sample
		// avatars at three.ws/avatars/*.glb) aren't bucket objects — range-fetch.
		const r = await fetchUpstream(storageKey, { headers: { Range: `bytes=0-${length - 1}` } }, { timeoutMs: 60_000, attempts: 3, okWhen: () => true });
		if (!r.ok) throw new Error(`http ${r.status}`);
		return Buffer.from(await r.arrayBuffer());
	}
	return getObjectRange(storageKey, length);
}

/**
 * Inspect a stored GLB's rig signal from its JSON chunk only.
 * @param {string} storageKey — R2 object key or absolute URL.
 * @returns {Promise<null | {
 *   is_rigged: boolean, skin_count: number, skeleton_joint_count: number,
 *   node_count: number, mesh_count: number, animation_count: number,
 *   glb_generator: string | null,
 * }>} null when the object isn't a parseable GLB (caller treats as "unknown").
 */
export async function inspectStorageKeyRig(storageKey) {
	if (!storageKey) return null;
	let buf = await readGlbPrefix(storageKey, INITIAL_PREFIX);
	let info = inspectGlb(buf, { allowPartial: true });
	if (!info) {
		// JSON chunk didn't fit in the first prefix — refetch exactly enough.
		const need = glbJsonChunkEnd(buf);
		if (need > buf.length && need <= MAX_PREFIX) {
			buf = await readGlbPrefix(storageKey, need);
			info = inspectGlb(buf, { allowPartial: true });
		}
	}
	if (!info) return null;
	return {
		is_rigged: info.isRigged,
		skin_count: info.skinCount,
		skeleton_joint_count: info.skeletonJointCount,
		node_count: info.nodeCount,
		mesh_count: info.meshCount,
		animation_count: info.animationCount,
		glb_generator: info.generator,
	};
}
