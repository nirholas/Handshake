/**
 * Animation clips from JSON.
 * --------------------------
 * three.ws ships its motion library as serialized AnimationClips
 * (`/animations/clips/<name>.json`), not as GLBs. Parsing them here means a
 * server render can pose an avatar with any clip in the library without
 * fetching a second model, and it costs one JSON parse.
 */

import './env-shim.js';
import * as THREE from 'three';

/**
 * Parse a serialized three.js AnimationClip.
 * @param {object|string} source clip JSON, or its text
 * @returns {THREE.AnimationClip}
 */
export function parseClipJson(source) {
	const json = typeof source === 'string' ? JSON.parse(source) : source;
	if (!json || !Array.isArray(json.tracks)) throw new Error('not an AnimationClip: no tracks array');
	const clip = THREE.AnimationClip.parse(json);
	if (!clip.name) clip.name = json.name || 'clip';
	return clip;
}

/**
 * Fetch and parse a clip by URL.
 * @param {string} url
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [options]
 */
export async function loadClipJson(url, { fetchImpl, timeoutMs = 15_000 } = {}) {
	const doFetch = fetchImpl || globalThis.fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await doFetch(url, { signal: controller.signal });
		if (!res.ok) throw new Error(`clip fetch failed: ${res.status} ${res.statusText}`);
		return parseClipJson(await res.json());
	} finally {
		clearTimeout(timer);
	}
}
