// IRL pin outfit baker — re-skin a placed agent for every nearby viewer.
//
// An IRL outfit change is the SAME appearance bake the avatar studio runs
// (api/_lib/bake.js → bakeAppearance); only the I/O differs:
//   • the base GLB comes from a URL (the pin's stored avatar), not an R2 key
//   • the output lands under an irl/pins/<id>/ namespace and is served through
//     the first-party /cdn proxy (publicUrl).
//
// We REUSE the bake core verbatim — no forked transform pipeline — so a pin's
// dressed avatar is byte-for-byte what the studio would produce.
//
// Baking always starts from the pin's CAPTURED BASE GLB, never the previously
// baked avatar_url: re-applying a manifest on top of a prior bake would
// double-merge bone accessories and could never un-hide a stripped garment.
// The manifest is the single source of truth, applied fresh onto the base each
// time, so the result is a pure function of (base, manifest) — idempotent and
// stack-free.

import { bakeAppearance, appearanceHash, isBakeable } from './bake.js';
import { putObject, publicUrl } from './r2.js';
import { env } from './env.js';
import { fetchUpstream } from './upstream-fetch.js';

export { isBakeable };

// A baked avatar GLB is small (the studio bake quantizes + meshopt-compresses),
// but guard against a pathological base so one fetch can't balloon memory.
const MAX_BASE_GLB_BYTES = 25 * 1024 * 1024;

// Resolve the pin's base GLB to absolute bytes. Relative URLs (the common
// `/api/avatars/:id/glb` form, or `/cdn/<key>`) resolve against the app origin —
// the avatar lives on our own API/CDN. Absolute URLs were already SSRF-screened
// by safeRemoteUrl() when the pin was created, so re-fetching them is safe.
async function fetchBaseGlb(baseUrl) {
	if (!baseUrl) throw new Error('pin has no base avatar GLB to dress');
	const abs = /^https?:\/\//i.test(baseUrl)
		? baseUrl
		: `${env.APP_ORIGIN}${baseUrl.startsWith('/') ? '' : '/'}${baseUrl}`;
	const r = await fetchUpstream(abs, {}, { timeoutMs: 60_000, attempts: 3, okWhen: () => true });
	if (!r.ok) throw new Error(`base GLB fetch failed: ${abs} → ${r.status}`);
	const declared = Number(r.headers.get('content-length') || 0);
	if (declared && declared > MAX_BASE_GLB_BYTES) {
		throw new Error('base GLB exceeds 25 MB');
	}
	const buf = Buffer.from(await r.arrayBuffer());
	if (buf.byteLength > MAX_BASE_GLB_BYTES) throw new Error('base GLB exceeds 25 MB');
	return buf;
}

/**
 * Bake `manifest` onto a pin's base GLB and store the dressed result.
 *
 * The R2 key is namespaced by pin id and keyed by the appearance hash, so two
 * distinct looks for one pin get distinct, write-once URLs (cache-correct for
 * the viewer's GLTFLoader) while re-selecting the same look reuses its URL.
 *
 * @param {object} args
 * @param {string} args.pinId   irl_pins.id (R2 key namespace)
 * @param {string} args.baseUrl the pin's captured base GLB (avatar_base_url ?? avatar_url)
 * @param {object} args.manifest { colors?, hidden?, accessories?, morphs?, outfit? }
 * @returns {Promise<{ url: string, hash: string, size_bytes: number }>}
 */
export async function bakePinOutfit({ pinId, baseUrl, manifest }) {
	const baseBytes = await fetchBaseGlb(baseUrl);
	const bakedBytes = await bakeAppearance(baseBytes, manifest);
	const hash = appearanceHash(manifest) || 'base';
	const key = `irl/pins/${pinId}/${hash.slice(0, 16)}.glb`;
	await putObject({
		key,
		body: Buffer.from(bakedBytes),
		contentType: 'model/gltf-binary',
		metadata: { 'irl-pin': String(pinId), 'appearance-hash': hash },
	});
	return { url: publicUrl(key), hash, size_bytes: bakedBytes.byteLength };
}
