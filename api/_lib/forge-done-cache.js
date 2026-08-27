// Remembers the first finished frame of a forge job so every later poll of a
// done job answers from cache instead of rebuilding it.
//
// Why: the done branch of the poll materializes the creation and runs the
// vision quality gate. Both are worth doing ONCE. Measured live on 2026-08-27,
// every poll of an already-finished job re-ran them and took 13-33 s, which
// pushed the OKX forge_status tool (15 s client bound) into "timed out" on
// roughly every other read of a finished model. A done job is terminal: its
// frame cannot change, so the first one built is the one every poll gets.
//
// Keyed by a hash of the job handle (handles are signed tokens up to 1 KB) and
// held for six hours, which outlives any client's polling loop. The shared
// cache degrades to per-instance memory without Redis, which still dedupes
// the common case of one client polling one instance.

import { createHash } from 'node:crypto';
import { cacheGet, cacheSet } from './cache.js';

export const DONE_FRAME_TTL_S = 6 * 3600;

export function doneFrameKey(jobId) {
	return `forge:done:${createHash('sha256').update(String(jobId)).digest('hex').slice(0, 40)}`;
}

// The frame a done poll answered with, or null when this job has not finished
// on this instance (or its record expired).
export async function recallDoneFrame(jobId) {
	if (!jobId) return null;
	const v = await cacheGet(doneFrameKey(jobId));
	return v && typeof v === 'object' && v.status === 'done' ? v : null;
}

// Store a finished frame. Only a genuinely done frame with a model is worth
// remembering; anything else is a caller bug, not a cache entry.
export async function rememberDoneFrame(jobId, frame) {
	if (!jobId || !frame || frame.status !== 'done' || !frame.glb_url) return false;
	await cacheSet(doneFrameKey(jobId), frame, DONE_FRAME_TTL_S);
	return true;
}
