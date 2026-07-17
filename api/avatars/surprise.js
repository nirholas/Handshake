// GET/POST /api/avatars/surprise: compose a unique, rigged avatar in one call.
//
// The fastest path on the site from "landing" to "I made something": zero input,
// no sign-in, no wait screen. It composes a fresh avatar with the modular Avatar
// Composer (api/_lib/avatar-composer) and returns the GLB bytes directly. The
// browser previews it from a Blob URL and only persists on claim (the guest
// flow: guest-avatar.stage → /create-review), so this endpoint touches no DB and
// no storage: it is stateless and cache-friendly.
//
// Determinism is the trick that makes it both fun and cheap: the composer is a
// pure function of the seed, so `?seed=<x>` always returns the same avatar. A
// reroll just asks for a new random seed; a shared `?seed=` link resolves to the
// exact same character and is CDN-cacheable.
//
// Query / body params (all optional):
//   seed    reproducible seed (any string). Omitted → a fresh random one.
//   gender  'male' | 'female' bias for the identity body. Omitted → from the seed.
//
// Response: `model/gltf-binary` bytes, with an `x-avatar-meta` header carrying
// `{ seed, name, descriptor }` (exposed via CORS).

import { cors, method, error, rateLimited, wrap } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { fetchModel } from '../_lib/fetch-model.js';
import { env } from '../_lib/env.js';
import { pickDiversityProfile } from '../_lib/avaturn-seed.js';
import { composeStudioAvatar } from '../_lib/avatar-composer/index.js';
import { randomUUID } from 'node:crypto';

export const maxDuration = 30;

// Base bodies are served from the site origin (/avatars/<id>.glb); the composer
// only ever needs 1-3 of them per avatar.
const ORIGIN = () => env.APP_ORIGIN || 'https://three.ws';

// Warm-container cache of base-body bytes: the same handful of bases back every
// composition, so fetch each at most once per instance instead of per request.
const _baseCache = new Map();
async function defaultLoadBase(id) {
	if (_baseCache.has(id)) return _baseCache.get(id);
	const { bytes } = await fetchModel(`${ORIGIN()}/avatars/${id}.glb`, { maxBytes: 40 * 1024 * 1024 });
	const u8 = new Uint8Array(bytes);
	_baseCache.set(id, u8);
	return u8;
}

// A memorable two-word name (deterministic on the seed, so a shared link and its
// avatar always carry the same name). Deliberately generic and friendly: never a
// real person, never a coin.
const NAME_ADJ = [
	'Neon', 'Velvet', 'Cobalt', 'Amber', 'Lunar', 'Crimson', 'Jade', 'Onyx',
	'Solar', 'Frost', 'Coral', 'Ivory', 'Dusk', 'Ember', 'Halo', 'Nova',
	'Quartz', 'Sable', 'Aurora', 'Cosmic', 'Electric', 'Golden', 'Midnight', 'Wild',
];
const NAME_NOUN = [
	'Fox', 'Comet', 'Rider', 'Sage', 'Drifter', 'Falcon', 'Echo', 'Voyager',
	'Maven', 'Phoenix', 'Wanderer', 'Oracle', 'Nomad', 'Pilot', 'Ranger', 'Spark',
	'Cipher', 'Vertex', 'Muse', 'Atlas', 'Rogue', 'Beacon', 'Sonata', 'Pioneer',
];
function nameFromSeed(seed) {
	let h = 0;
	const s = String(seed);
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
	return `${NAME_ADJ[h % NAME_ADJ.length]} ${NAME_NOUN[(h >>> 8) % NAME_NOUN.length]}`;
}

/**
 * Compose one surprise avatar. Pure aside from `loadBase`, so tests can inject a
 * disk loader and callers get the deployed fetch-from-origin loader by default.
 *
 * @param {{ seed?: string, gender?: 'male'|'female' }} [opts]
 * @param {{ loadBase?: (id: string) => Promise<Uint8Array> }} [deps]
 * @returns {Promise<{ bytes: Uint8Array, seed: string, name: string, descriptor: object }>}
 */
export async function composeSurprise({ seed, gender } = {}, deps = {}) {
	const loadBase = deps.loadBase || defaultLoadBase;
	const s = seed && String(seed).trim() ? String(seed).trim().slice(0, 100) : randomUUID();
	const profile = pickDiversityProfile(s);
	if (gender === 'male' || gender === 'female') profile.gender = gender;
	const { bytes, descriptor } = await composeStudioAvatar({ profile, seed: s, loadBase });
	return { bytes, seed: s, name: nameFromSeed(s), descriptor };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const ip = clientIp(req);
	const rl = await limits.surpriseIp(ip);
	if (!rl.success) return rateLimited(res, rl, 'slow down a moment: too many avatars at once');

	const url = new URL(req.url, 'http://x');
	const seed = url.searchParams.get('seed') || undefined;
	const genderParam = url.searchParams.get('gender');
	const gender = genderParam === 'male' || genderParam === 'female' ? genderParam : undefined;

	let result;
	try {
		result = await composeSurprise({ seed, gender });
	} catch (err) {
		return error(res, 502, 'compose_failed', `could not compose an avatar: ${err?.message || err}`);
	}

	res.statusCode = 200;
	res.setHeader('content-type', 'model/gltf-binary');
	res.setHeader('content-disposition', `inline; filename="${result.name.replace(/\s+/g, '-').toLowerCase()}.glb"`);
	// Deterministic on the seed → safe to cache hard. A reroll uses a new seed.
	res.setHeader('cache-control', 'public, max-age=31536000, immutable');
	res.setHeader('x-avatar-meta', JSON.stringify({ seed: result.seed, name: result.name, descriptor: result.descriptor }));
	res.setHeader('access-control-expose-headers', 'x-avatar-meta');
	res.end(Buffer.from(result.bytes));
});
