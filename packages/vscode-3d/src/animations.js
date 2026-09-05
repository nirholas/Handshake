// The three.ws motion library and the text to animation lane.
//
// The library is 2,800+ clips baked onto the canonical humanoid skeleton, the
// same clips the /animations gallery and the <agent-3d> embed play. A clip is a
// three.js AnimationClip serialised as JSON, so the viewer parses it with
// AnimationClip.parse and retargets it onto whatever rig is open with the
// platform's own retargeter. Text to animation samples a motion model on the
// three.ws GPU fleet and returns a clip in the same format.

import { normalizeOrigin } from './studio.js';
import { slugFromPrompt } from './naming.js';

const PAGE = 1000;
const MOTION_POLL_MS = 3000;
const MOTION_TIMEOUT_MS = 6 * 60_000;

/**
 * @typedef {object} LibraryClip
 * @property {string} name stable id, e.g. "mx-happy-idle-c9cd...";
 * @property {string} label human title, e.g. "Happy Idle"
 * @property {boolean} loop whether the clip is meant to cycle
 * @property {number} duration seconds
 * @property {string} url the clip JSON on the CDN
 * @property {string|null} thumb preview image
 */

/**
 * Every clip in the library. Pages through the manifest so a growing catalogue
 * never produces one oversized response.
 *
 * @param {string} origin
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<LibraryClip[]>}
 */
export async function listLibrary(origin, { signal } = {}) {
	const base = normalizeOrigin(origin);
	const clips = [];
	let offset = 0;
	for (let page = 0; page < 20; page++) {
		const url = new URL('/api/animations/library', base);
		url.searchParams.set('limit', String(PAGE));
		url.searchParams.set('offset', String(offset));
		const body = await getJson(url.href, { signal, what: 'the animation library' });
		for (const row of Array.isArray(body?.clips) ? body.clips : []) {
			const clip = normalizeClip(row);
			if (clip) clips.push(clip);
		}
		if (body?.next_offset === null || body?.next_offset === undefined) break;
		offset = Number(body.next_offset);
		if (!Number.isFinite(offset)) break;
	}
	return clips;
}

/** One manifest row, validated. Rows without a fetchable clip URL are dropped. */
export function normalizeClip(row) {
	const url = row?.url;
	if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return null;
	const label = String(row.label || row.name || '').trim();
	if (!label) return null;
	return {
		name: String(row.name || label),
		label,
		loop: Boolean(row.loop),
		duration: Number(row.duration) || 0,
		url,
		thumb: typeof row.thumb === 'string' ? row.thumb : null,
	};
}

/**
 * Fetch one clip's JSON.
 * @param {string} url
 * @param {{ signal?: AbortSignal }} [opts]
 */
export async function fetchClip(url, { signal } = {}) {
	const clip = await getJson(url, { signal, what: 'the animation clip' });
	if (!Array.isArray(clip?.tracks) || !clip.tracks.length) {
		throw new Error('the clip has no animation tracks');
	}
	return clip;
}

/** A file-safe stem for a clip: "Happy Idle" -> "happy-idle". */
export function clipSlug(label) {
	return slugFromPrompt(String(label || '').replace(/^mx-/, ''), 'clip').replace(/-[0-9a-f]{12}(-\d+)?$/, '');
}

/**
 * Generate an animation clip from a text prompt.
 *
 * POST /api/forge-motion starts the job; GET ?job= polls it. Resolves with the
 * finished clip JSON plus its URL.
 *
 * @param {string} origin
 * @param {string} prompt
 * @param {{ signal?: AbortSignal, durationSeconds?: number, onStatus?: (message: string) => void, pollMs?: number }} [opts]
 * @returns {Promise<{ clipUrl: string, clip: object }>}
 */
export async function generateMotion(origin, prompt, { signal, durationSeconds = 4, onStatus, pollMs = MOTION_POLL_MS } = {}) {
	const base = normalizeOrigin(origin);
	const start = await fetch(new URL('/api/forge-motion', base).href, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({ prompt, duration_seconds: durationSeconds }),
		signal,
	}).catch((err) => {
		throw new Error(`could not reach the motion lane: ${err?.message || err}`);
	});
	const started = await start.json().catch(() => null);
	if (start.status === 503) {
		throw new Error(started?.message || 'text to animation is not available on this origin right now');
	}
	if (!start.ok || !started?.job_id) {
		throw new Error(started?.message || `the motion lane returned HTTP ${start.status}`);
	}

	const deadline = Date.now() + MOTION_TIMEOUT_MS;
	const poll = new URL('/api/forge-motion', base);
	poll.searchParams.set('job', started.job_id);
	while (Date.now() < deadline) {
		await sleep(pollMs, signal);
		const status = await getJson(poll.href, { signal, what: 'the motion job' });
		if (status?.status === 'failed') {
			throw new Error(status.error || 'the motion model could not animate that prompt');
		}
		if (status?.clip_url) {
			onStatus?.('retargeting the clip…');
			const clip = await fetchClip(status.clip_url, { signal });
			return { clipUrl: status.clip_url, clip };
		}
		onStatus?.(status?.status === 'running' ? 'the motion model is sampling…' : 'queued on the GPU fleet…');
	}
	throw new Error('the motion job did not finish within six minutes');
}

async function getJson(url, { signal, what }) {
	let res;
	try {
		res = await fetch(url, { headers: { accept: 'application/json' }, signal });
	} catch (err) {
		if (signal?.aborted) throw new Error('cancelled');
		throw new Error(`could not reach ${what}: ${err?.message || err}`);
	}
	if (!res.ok) throw new Error(`${what} returned HTTP ${res.status}`);
	const body = await res.json().catch(() => null);
	if (body === null) throw new Error(`${what} returned a non-JSON body`);
	return body;
}

function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error('cancelled'));
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error('cancelled'));
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}
