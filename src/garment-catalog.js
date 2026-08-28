// Garment catalog — fetch, validate, and index the additive-wardrobe catalog.
//
// The catalog is a JSON array of Garment Manifest v1 documents
// (specs/GARMENT_MANIFEST.md) served from the public garments bucket. This
// module is the single place that decides whether a manifest is trustworthy
// enough to offer to a user: anything that fails validation is dropped and
// reported, never rendered as a broken tile.
//
// Pure data module — no three.js, no DOM — so it runs identically in the
// browser and in vitest. Loading the GLB and binding it to an avatar is the
// caller's job (src/avatar-garment.js `attachGarment`).

import { GARMENT_SLOTS, BODY_REGIONS } from './garment-taxonomy.js';

export const GARMENT_SPEC_URI = 'https://three.ws/specs/garment-manifest-v1';
export const GARMENT_CATALOG_URL =
	'https://storage.googleapis.com/three-ws-garments/garments/catalog.json';

/** Licences a garment may carry into the catalog. Anything else is rejected —
 *  an unlicensed asset must never reach a user's avatar (see spec §Validation). */
const COMMERCIAL_LICENSES = new Set([
	'CC0-1.0', 'CC-BY-4.0', 'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause',
]);

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Validate one manifest against the v1 spec.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateManifest(m) {
	const errors = [];
	if (!m || typeof m !== 'object') return { ok: false, errors: ['not an object'] };

	if (m.spec !== GARMENT_SPEC_URI) errors.push(`unknown spec "${m.spec}"`);
	if (!ID_RE.test(m.id || '')) errors.push(`id "${m.id}" is not kebab-case`);
	if (typeof m.name !== 'string' || !m.name.trim()) errors.push('missing name');
	if (!GARMENT_SLOTS.includes(m.slot)) errors.push(`unknown slot "${m.slot}"`);

	const model = m.model || {};
	let uri;
	try {
		uri = new URL(model.uri);
		if (uri.protocol !== 'https:' && uri.protocol !== 'ipfs:') {
			errors.push(`model.uri protocol "${uri.protocol}" not allowed`);
		}
	} catch {
		errors.push('model.uri is not a valid URL');
	}
	if (model.format !== 'gltf-binary') errors.push(`unsupported format "${model.format}"`);
	if (!SHA256_RE.test(model.sha256 || '')) errors.push('model.sha256 missing or malformed');

	if (m.rig?.skeleton !== 'three.ws-canonical-v1') {
		errors.push(`unknown rig.skeleton "${m.rig?.skeleton}"`);
	}

	if (!Array.isArray(m.occludes)) {
		errors.push('occludes must be an array (empty is legal)');
	} else {
		for (const region of m.occludes) {
			if (!BODY_REGIONS.includes(region)) errors.push(`unknown body region "${region}"`);
		}
	}

	if (!COMMERCIAL_LICENSES.has(m.license)) {
		errors.push(`license "${m.license}" is not an approved commercial licence`);
	}

	return { ok: errors.length === 0, errors };
}

/**
 * Filter a raw catalog array down to valid manifests.
 * @returns {{ garments: object[], rejected: Array<{ id: string, errors: string[] }> }}
 */
export function sanitizeCatalog(raw) {
	const garments = [];
	const rejected = [];
	const seen = new Set();
	for (const m of Array.isArray(raw) ? raw : []) {
		const { ok, errors } = validateManifest(m);
		const key = `${m?.slot}/${m?.id}`;
		if (ok && seen.has(key)) {
			rejected.push({ id: String(m.id), errors: [`duplicate id in slot "${m.slot}"`] });
			continue;
		}
		if (ok) {
			seen.add(key);
			garments.push(m);
		} else {
			rejected.push({ id: String(m?.id ?? '<missing id>'), errors });
		}
	}
	return { garments, rejected };
}

/** Group valid manifests by slot, preserving catalog order within each. */
export function bySlot(garments) {
	const out = new Map();
	for (const g of garments) {
		if (!out.has(g.slot)) out.set(g.slot, []);
		out.get(g.slot).push(g);
	}
	return out;
}

// One in-flight/settled fetch per session; force=true refetches (e.g. after the
// generation lane publishes a new garment and the UI wants to show it now).
let _catalogPromise = null;

/**
 * Load and validate the live catalog.
 * @param {object} [opts]
 * @param {boolean} [opts.force]     bypass the session cache
 * @param {string}  [opts.url]       override the catalog URL (tests, staging)
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{ garments: object[], rejected: Array<{id: string, errors: string[]}> }>}
 */
// One bounded attempt plus two retries: the catalog is a small static file, so a
// transient 5xx or a dropped connection is worth re-asking before falling back.
async function fetchCatalogPayload(fetchImpl, url) {
	let lastErr;
	for (let attempt = 0; attempt < 3; attempt++) {
		if (attempt > 0) await new Promise((r) => setTimeout(r, 300 * attempt));
		try {
			const res = await fetchImpl(url, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok) {
				const err = new Error(`garment catalog fetch failed: ${res.status}`);
				if (res.status < 500 && res.status !== 429) throw err;
				lastErr = err;
				continue;
			}
			return await res.json();
		} catch (err) {
			lastErr = err;
			if (err?.message?.startsWith('garment catalog fetch failed')) throw err;
		}
	}
	throw lastErr;
}

const CATALOG_CACHE_KEY = (url) => `three.ws:garment-catalog:${url}`;
const CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function readCatalogCache(url) {
	try {
		const raw = localStorage.getItem(CATALOG_CACHE_KEY(url));
		if (!raw) return null;
		const { at, payload } = JSON.parse(raw);
		return Date.now() - at < CATALOG_CACHE_TTL_MS ? payload : null;
	} catch {
		return null;
	}
}

function writeCatalogCache(url, payload) {
	try {
		localStorage.setItem(CATALOG_CACHE_KEY(url), JSON.stringify({ at: Date.now(), payload }));
	} catch {
		// A private window or a full quota is not a reason to fail the load.
	}
}

export function loadCatalog(opts = {}) {
	if (_catalogPromise && !opts.force) return _catalogPromise;
	const url = opts.url || GARMENT_CATALOG_URL;
	const fetchImpl = opts.fetchImpl || fetch;
	_catalogPromise = (async () => {
		let payload;
		try {
			payload = await fetchCatalogPayload(fetchImpl, url);
			writeCatalogCache(url, payload);
		} catch (err) {
			// The catalog is a static manifest on one bucket. A blip there used to
			// empty the garment picker outright; the copy this browser last loaded
			// is a far better answer than no garments at all.
			const cached = readCatalogCache(url);
			if (!cached) throw err;
			console.warn(`[garment-catalog] fetch failed (${err?.message || err}); using the last catalog this browser loaded`);
			payload = cached;
		}
		const { garments, rejected } = sanitizeCatalog(payload);
		if (rejected.length) {
			console.warn(
				`[garment-catalog] dropped ${rejected.length} invalid manifest(s):`,
				rejected.map((r) => `${r.id}: ${r.errors.join('; ')}`).join(' | '),
			);
		}
		return { garments, rejected };
	})();
	// A failed fetch must not poison every later call with a rejected promise.
	_catalogPromise.catch(() => { _catalogPromise = null; });
	return _catalogPromise;
}

/**
 * Verify fetched GLB bytes against the manifest's pinned hash. Callers attach
 * nothing that fails this — a CDN swap or truncated download surfaces here.
 * @param {ArrayBuffer} bytes
 * @param {object} manifest
 */
export async function verifyModelBytes(bytes, manifest) {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
	return hex === manifest?.model?.sha256;
}
