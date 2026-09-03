// Which CDN the headless renderers load three.js from.
//
// render-glb.js, avatar-render.js and render-clip.js build a page whose
// import map points at a pinned three.js release. That page runs inside our
// own chromium, so a CDN outage never surfaces as an error: the module import
// hangs, the render watchdog fires, and every thumbnail and clip comes back
// blank. Both unpkg and jsDelivr serve the identical npm tarball, so the fix
// is to check unpkg once (bounded HEAD), remember the answer for ten minutes,
// and hand the renderers whichever host is up.

// The three.js release the headless renderers load. All three renderers share
// this pin so a bump lands everywhere at once instead of leaving one poster
// lane on an older release than the others.
export const THREE_VERSION = '0.176.0';

export const THREE_CDN_HOSTS = {
	unpkg: (version) => `https://unpkg.com/three@${version}/`,
	jsdelivr: (version) => `https://cdn.jsdelivr.net/npm/three@${version}/`,
};

// The base a renderer uses when it has not resolved a host yet. Keeping the
// default on unpkg means a caller that skips the probe behaves exactly as the
// renderers did before the failover was wired in.
export const DEFAULT_THREE_BASE = THREE_CDN_HOSTS.unpkg(THREE_VERSION);

const PROBE_TIMEOUT_MS = 3_000;
const PROBE_TTL_MS = 10 * 60_000;

// version -> { host, base, checkedAt }
const probes = new Map();

/** Import-map entries for a resolved base (ends in `/`). */
export function threeImportMap(base) {
	return {
		three: `${base}build/three.module.js`,
		'three/addons/': `${base}examples/jsm/`,
	};
}

/**
 * Resolve the three.js CDN base for `version`: unpkg when its module answers a
 * HEAD, jsDelivr otherwise. The probe result is cached per process for ten
 * minutes so a render burst pays one HEAD, not one per frame.
 *
 * @param {string} version
 * @param {{ fetchImpl?: typeof fetch, now?: () => number, force?: boolean }} [opts]
 * @returns {Promise<{ host: 'unpkg'|'jsdelivr', base: string, cached: boolean }>}
 */
export async function resolveThreeCdn(version, { fetchImpl = globalThis.fetch, now = Date.now, force = false } = {}) {
	const hit = probes.get(version);
	if (hit && !force && now() - hit.checkedAt < PROBE_TTL_MS) return { host: hit.host, base: hit.base, cached: true };
	const primary = THREE_CDN_HOSTS.unpkg(version);
	let host = 'unpkg';
	try {
		const res = await fetchImpl(`${primary}build/three.module.js`, {
			method: 'HEAD',
			redirect: 'follow',
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		if (!res.ok) throw new Error(`http ${res.status}`);
	} catch (err) {
		host = 'jsdelivr';
		console.warn(`[three-cdn] unpkg probe failed (${err?.message || err}); loading three@${version} from jsDelivr`);
	}
	const base = THREE_CDN_HOSTS[host](version);
	probes.set(version, { host, base, checkedAt: now() });
	return { host, base, cached: false };
}

/** Test hook: forget every cached probe. */
export function _resetThreeCdnProbes() {
	probes.clear();
}
