// src/shared/leaflet-loader.js — single, lazy Leaflet stack + Nominatim helpers.
//
// One CDN version, one CSS injection, one in-flight promise — so every surface
// that needs a map (the IRL placement picker, the dashboard relocate modal, the
// My-pins overview) shares the same Leaflet instance and never ships a second map
// stack. Leaflet (JS + CSS) loads only when a map actually opens; the rest of the
// app never pays for it.

import { fetchFirstOrNull } from './failover-fetch.js';
import { loadModule } from './load-module.js';

// One pinned version, three CDNs each for the JS and the CSS. loadModule
// expands the esm.sh URL to its jsdelivr / unpkg mirrors; the stylesheet
// carries its own explicit list because a <link> is not an import().
const LEAFLET_JS  = 'https://esm.sh/leaflet@1.9.4';
const LEAFLET_CSS = [
	'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
	'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css',
	'https://esm.sh/leaflet@1.9.4/dist/leaflet.css',
];
const CSS_TIMEOUT_MS = 10_000;

function loadStylesheet(href) {
	return new Promise((resolve, reject) => {
		const link = document.createElement('link');
		link.rel = 'stylesheet';
		link.href = href;
		link.crossOrigin = '';
		const timer = setTimeout(() => { link.remove(); reject(new Error(`timed out loading ${href}`)); }, CSS_TIMEOUT_MS);
		link.onload = () => { clearTimeout(timer); resolve(link); };
		link.onerror = () => { clearTimeout(timer); link.remove(); reject(new Error(`failed to load ${href}`)); };
		document.head.appendChild(link);
	});
}

let _cssPromise = null;
export function ensureLeafletCss() {
	if (_cssPromise) return _cssPromise;
	_cssPromise = (async () => {
		if (document.getElementById('leaflet-css')) return;
		let lastErr;
		for (const href of LEAFLET_CSS) {
			try {
				const link = await loadStylesheet(href);
				link.id = 'leaflet-css';
				return;
			} catch (e) {
				lastErr = e;
			}
		}
		throw Object.assign(new Error('The map stylesheet could not be loaded from any mirror.'), {
			code: 'module_unavailable',
			cause: lastErr,
		});
	})().catch((e) => { _cssPromise = null; throw e; });
	return _cssPromise;
}

let _jsPromise = null;
export function loadLeaflet() {
	if (_jsPromise) return _jsPromise;
	_jsPromise = (async () => {
		const [mod] = await Promise.all([loadModule(LEAFLET_JS), ensureLeafletCss()]);
		const L = mod?.default || mod;
		if (!L || typeof L.map !== 'function') throw new Error('leaflet module missing');
		return L;
	})().catch((e) => { _jsPromise = null; throw e; });
	return _jsPromise;
}

// ── Geocoding (shared, memoized, polite, multi-provider) ────────────────────
// Free keyless geocoders, tried in order: OSM Nominatim → Photon (komoot) →
// BigDataCloud (reverse only). Nominatim is rate-limited and asks for a
// descriptive UA; a 429 there rolls to the next provider instead of losing the
// label. We memoize per ~11 m cell and never let a geocode failure block the
// caller — a null label is a soft, designed state, never an error.

const _reverseCache = new Map();

// Reverse: coords → a short human place label (city/town/first display part).
export async function reverseGeocode(lat, lng) {
	if (lat == null || lng == null) return null;
	const key = `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;
	if (_reverseCache.has(key)) return _reverseCache.get(key);
	const p = fetchFirstOrNull([
		{
			name: 'nominatim-reverse',
			url: `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
			init: { headers: { 'User-Agent': 'three.ws/1.0' } },
			parse: async (r) => {
				const d = await r.json();
				return d.address?.city || d.address?.town || d.address?.village
					|| d.address?.county || d.display_name?.split(',')[0] || null;
			},
		},
		{
			name: 'photon-reverse',
			url: `https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&limit=1`,
			parse: async (r) => {
				const f = (await r.json())?.features?.[0]?.properties;
				return f?.city || f?.town || f?.village || f?.county || f?.name || null;
			},
		},
		{
			name: 'bigdatacloud-reverse',
			url: `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`,
			parse: async (r) => {
				const d = await r.json();
				return d?.city || d?.locality || d?.principalSubdivision || null;
			},
		},
	], { timeoutMs: 5000, label: 'reverse-geocode' });
	_reverseCache.set(key, p);
	return p;
}

// Forward: free-text query → up to `limit` candidate places. Returns [] on any
// failure (empty query, network, non-OK) so the caller renders a "no results"
// state rather than throwing. `signal` lets the caller abort a stale search.
export async function searchPlaces(query, { limit = 6, signal } = {}) {
	const q = String(query || '').trim();
	if (q.length < 2) return [];
	const results = await fetchFirstOrNull([
		{
			name: 'nominatim-search',
			url: `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=${limit}`,
			init: { headers: { 'User-Agent': 'three.ws/1.0' }, signal },
			parse: async (r) => {
				const rows = await r.json();
				const list = (Array.isArray(rows) ? rows : [])
					.map((d) => ({
						lat: parseFloat(d.lat),
						lng: parseFloat(d.lon),
						label: d.display_name || '',
						short: d.display_name?.split(',').slice(0, 2).join(',') || d.display_name || '',
					}))
					.filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng));
				return list.length ? list : null;
			},
		},
		{
			name: 'photon-search',
			url: `https://photon.komoot.io/api?q=${encodeURIComponent(q)}&limit=${limit}`,
			init: { signal },
			parse: async (r) => {
				const feats = (await r.json())?.features || [];
				const list = feats
					.map((f) => {
						const [lon, lat] = f.geometry?.coordinates || [];
						const pr = f.properties || {};
						const parts = [pr.name, pr.city, pr.state, pr.country].filter(Boolean);
						return {
							lat: Number(lat),
							lng: Number(lon),
							label: parts.join(', '),
							short: parts.slice(0, 2).join(', '),
						};
					})
					.filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng) && row.label);
				return list.length ? list : null;
			},
		},
	], { timeoutMs: 5000, label: 'search-places' });
	return results || [];
}
