// Pure scene math + (de)serialization for the AR Studio (/ar/studio).
//
// Everything here is DOM-free and Three-free so it can be unit-tested directly:
// model normalization (a forge prop and a full avatar land in the room at a
// believable size, resting ON the floor), spawn placement (new models appear on
// the floor in front of wherever the camera looks), the two-finger twist gesture
// (rotate a placed model in place), and the localStorage scene format (what
// survives a refresh, validated so a corrupt or hostile blob can never spawn a
// non-GLB URL or a NaN transform into the scene).

/** Standing height (m) a skinned/humanoid model is normalized to. */
export const AVATAR_TARGET_HEIGHT_M = 1.65;

/** Longest dimension (m) a static prop is normalized to. */
export const PROP_TARGET_SIZE_M = 0.75;

/** Placement scale bounds — mirrors the pinch clamp in src/ar/pinch-scale.js. */
export const SCALE_MIN = 0.25;
export const SCALE_MAX = 4;

/** Hard cap on simultaneous placements — keeps low-end phones interactive. */
export const MAX_PLACEMENTS = 20;

/** How far (m) in front of the camera a newly added model lands. */
export const SPAWN_DISTANCE_M = 1.6;

/**
 * Normalize a raw model bounding box into a floor-resting placement transform.
 *
 * @param {{min:{x:number,y:number,z:number}, max:{x:number,y:number,z:number}}} box
 *   World-space bounds of the freshly loaded model (Box3-shaped, plain numbers).
 * @param {{ skinned?: boolean }} [opts]  skinned = has a SkinnedMesh (treat as
 *   an avatar and normalize by height rather than longest dimension).
 * @returns {{ scale: number, yOffset: number }}
 *   scale: uniform scale to apply; yOffset: translate so the model's lowest
 *   point sits exactly on y=0 AFTER scaling. Degenerate/empty boxes come back
 *   as identity so a broken export still shows up instead of vanishing.
 */
export function fitTransform(box, { skinned = false } = {}) {
	const dx = Number(box?.max?.x) - Number(box?.min?.x);
	const dy = Number(box?.max?.y) - Number(box?.min?.y);
	const dz = Number(box?.max?.z) - Number(box?.min?.z);
	if (![dx, dy, dz].every((v) => Number.isFinite(v) && v >= 0)) {
		return { scale: 1, yOffset: 0 };
	}
	const longest = Math.max(dx, dy, dz);
	if (longest <= 1e-6) return { scale: 1, yOffset: 0 };

	let scale;
	if (skinned && dy > 1e-6) {
		scale = AVATAR_TARGET_HEIGHT_M / dy;
	} else {
		scale = PROP_TARGET_SIZE_M / longest;
	}
	// A model authored at real-world size should stay real-world size: only
	// shrink giants and grow miniatures, never rescale something already within
	// 2x of its target. This keeps furniture-scale scans believable.
	if (scale > 0.5 && scale < 2) scale = 1;

	const minY = Number(box.min.y);
	const yOffset = Number.isFinite(minY) ? -minY * scale : 0;
	return { scale, yOffset };
}

/**
 * Floor point where a newly added model spawns: project the camera's forward
 * direction onto the floor plane at a fixed distance, so the model lands in the
 * middle of the view no matter where the user is looking (including straight
 * up — the fallback drops it in front of the camera's horizontal heading).
 *
 * @param {{x:number,y:number,z:number}} camPos
 * @param {{x:number,y:number,z:number}} camForward  Unit-ish look vector.
 * @param {number} [distance]
 * @returns {{x:number,z:number}}
 */
export function spawnPointInFront(camPos, camForward, distance = SPAWN_DISTANCE_M) {
	const fx = Number(camForward?.x) || 0;
	const fz = Number(camForward?.z) || 0;
	const len = Math.hypot(fx, fz);
	// Looking straight up/down: fall back to -Z (the initial camera heading).
	const nx = len > 1e-4 ? fx / len : 0;
	const nz = len > 1e-4 ? fz / len : -1;
	const px = (Number(camPos?.x) || 0) + nx * distance;
	const pz = (Number(camPos?.z) || 0) + nz * distance;
	return { x: px, z: pz };
}

/**
 * Two-finger twist: signed angle (radians) between two touch-pair orientations.
 * Wrapped to (-PI, PI] so a twist across the ±180° boundary never spins the
 * model the long way round.
 *
 * @param {number} startAngle  atan2 angle of the touch pair at gesture start.
 * @param {number} nowAngle    atan2 angle of the touch pair now.
 * @returns {number} delta yaw to ADD to the model's yaw at gesture start.
 */
export function twistDelta(startAngle, nowAngle) {
	if (!Number.isFinite(startAngle) || !Number.isFinite(nowAngle)) return 0;
	let d = nowAngle - startAngle;
	while (d > Math.PI) d -= 2 * Math.PI;
	while (d <= -Math.PI) d += 2 * Math.PI;
	return d;
}

/** atan2 orientation of a two-touch pair — feed into twistDelta. */
export function touchAngle(touches) {
	return Math.atan2(
		touches[1].clientY - touches[0].clientY,
		touches[1].clientX - touches[0].clientX,
	);
}

/**
 * Accept a GLB source the studio is willing to load: an https URL or a
 * site-relative path. Anything else (http, data:, blob:, javascript:,
 * protocol-relative) is rejected — these persist in localStorage and arrive
 * via ?src=, so they are untrusted input.
 *
 * @param {unknown} raw
 * @returns {string|null} normalized URL string, or null when rejected.
 */
export function normalizeGlbUrl(raw) {
	const s = String(raw ?? '').trim();
	if (!s) return null;
	if (s.startsWith('/') && !s.startsWith('//')) return s;
	try {
		const u = new URL(s);
		return u.protocol === 'https:' ? u.href : null;
	} catch {
		return null;
	}
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Serialize live placements for localStorage. Only source + transform survive
 * a refresh — meshes are re-loaded from their URLs on restore.
 *
 * @param {Array<{ src: string, title?: string, x: number, z: number,
 *   yaw: number, scale: number }>} placements
 * @returns {string} JSON payload.
 */
export function serializeScene(placements) {
	const items = (Array.isArray(placements) ? placements : [])
		.slice(0, MAX_PLACEMENTS)
		.map((p) => ({
			src: String(p.src || ''),
			title: String(p.title || '').slice(0, 120),
			x: Number(p.x) || 0,
			z: Number(p.z) || 0,
			yaw: Number(p.yaw) || 0,
			scale: clamp(Number(p.scale) || 1, SCALE_MIN, SCALE_MAX),
		}))
		.filter((p) => normalizeGlbUrl(p.src));
	return JSON.stringify({ v: 1, items });
}

/**
 * Parse + validate a persisted scene. Hostile or corrupt input degrades to an
 * empty scene, never a throw and never an unvetted URL.
 *
 * @param {string|null|undefined} json
 * @returns {Array<{ src: string, title: string, x: number, z: number,
 *   yaw: number, scale: number }>}
 */
export function deserializeScene(json) {
	let data;
	try {
		data = JSON.parse(json ?? 'null');
	} catch {
		return [];
	}
	if (!data || data.v !== 1 || !Array.isArray(data.items)) return [];
	const out = [];
	for (const it of data.items) {
		if (out.length >= MAX_PLACEMENTS) break;
		const src = normalizeGlbUrl(it?.src);
		if (!src) continue;
		const x = Number(it.x);
		const z = Number(it.z);
		if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
		out.push({
			src,
			title: String(it.title || '').slice(0, 120),
			x: clamp(x, -50, 50),
			z: clamp(z, -50, 50),
			yaw: Number.isFinite(Number(it.yaw)) ? Number(it.yaw) : 0,
			scale: clamp(Number(it.scale) || 1, SCALE_MIN, SCALE_MAX),
		});
	}
	return out;
}

/**
 * Models requested via the URL: every ?src= (repeatable) paired positionally
 * with an optional ?title=. Invalid sources are dropped, capped to the scene
 * limit. Used for deep links and the desktop→phone QR handoff.
 *
 * @param {URLSearchParams} params
 * @returns {Array<{ src: string, title: string }>}
 */
export function parseSrcParams(params) {
	const srcs = params.getAll('src');
	const titles = params.getAll('title');
	const out = [];
	for (let i = 0; i < srcs.length && out.length < MAX_PLACEMENTS; i++) {
		const src = normalizeGlbUrl(srcs[i]);
		if (!src) continue;
		out.push({ src, title: String(titles[i] || '').slice(0, 120) });
	}
	return out;
}

// ── Full-scene links (#s= hash) ───────────────────────────────────────────────
// The ?src= list reopens the same MODELS; the hash carries the whole
// ARRANGEMENT (positions, yaw, scale) so a composed scene round-trips exactly.
// base64url over the same validated JSON the localStorage scene uses — the
// decoder funnels through deserializeScene, so a hostile hash degrades to an
// empty scene exactly like a hostile storage blob.

function toBase64Url(s) {
	const bytes = new TextEncoder().encode(s);
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
	const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
	const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
	const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

/**
 * Encode the current placements (sources + transforms) as a URL-hash payload.
 *
 * @param {Array<{ src: string, title?: string, x: number, z: number,
 *   yaw: number, scale: number }>} placements
 * @returns {string} base64url payload for `#s=`, or '' when nothing is shareable.
 */
export function sceneToHashParam(placements) {
	const json = serializeScene(placements);
	try {
		return JSON.parse(json).items.length ? toBase64Url(json) : '';
	} catch {
		return '';
	}
}

/**
 * Decode a `#s=` payload back into validated scene items. Hostile, truncated,
 * or foreign input degrades to an empty list — never a throw.
 *
 * @param {string|null|undefined} raw  The value after `#s=`.
 * @returns {ReturnType<typeof deserializeScene>}
 */
export function sceneFromHashParam(raw) {
	if (!raw) return [];
	try {
		return deserializeScene(fromBase64Url(raw));
	} catch {
		return [];
	}
}

/**
 * Full-fidelity share URL: the ?src= list (link previews + old clients) plus
 * the `#s=` arrangement hash. Falls back to the plain source URL when the
 * payload would push the link past QR-friendly length.
 *
 * @param {string} origin
 * @param {Array<{ src: string, title?: string, x?: number, z?: number,
 *   yaw?: number, scale?: number }>} placements
 * @param {number} [maxUrlLength]
 * @returns {string}
 */
export function studioSceneUrl(origin, placements, maxUrlLength = 1500) {
	const base = studioShareUrl(origin, placements);
	const hash = sceneToHashParam(placements);
	if (!hash) return base;
	const full = `${base}#s=${hash}`;
	return full.length <= maxUrlLength ? full : base;
}

/**
 * Build the shareable /ar/studio URL that reopens the current scene's models
 * (sources only — transforms are device-local). Caps the payload so the QR
 * stays scannable.
 *
 * @param {string} origin  e.g. 'https://three.ws'
 * @param {Array<{ src: string, title?: string }>} placements
 * @param {number} [max]  Max models to embed in the link.
 * @returns {string}
 */
export function studioShareUrl(origin, placements, max = 4) {
	const base = `${origin}/ar/studio`;
	const list = (Array.isArray(placements) ? placements : [])
		.map((p) => ({ src: normalizeGlbUrl(p.src), title: String(p.title || '').slice(0, 60) }))
		.filter((p) => p.src);
	// De-duplicate by source: five copies of the same crate share one URL entry.
	const seen = new Set();
	const unique = list.filter((p) => (seen.has(p.src) ? false : (seen.add(p.src), true))).slice(0, max);
	if (!unique.length) return base;
	const q = new URLSearchParams();
	for (const p of unique) {
		q.append('src', p.src);
		q.append('title', p.title);
	}
	return `${base}?${q.toString()}`;
}
