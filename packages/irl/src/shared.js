// Internal helpers shared by the pin, drop, and world-line modules. Not part of
// the public API surface — import from './index.js' instead.

import { ThreeWsError } from './http.js';

export function normalizeEnum(value, allowed, label) {
	if (value === undefined || value === null) return undefined;
	if (!allowed.includes(value)) {
		throw new ThreeWsError(`Invalid ${label} "${value}". Expected one of: ${allowed.join(', ')}.`, { code: 'invalid_input' });
	}
	return value;
}

export function normToken(v) {
	if (typeof v !== 'string') return null;
	const t = v.trim();
	return t.length ? t : null;
}

export function prune(obj) {
	const out = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null) continue;
		if (Array.isArray(v) && v.length === 0) continue;
		out[k] = v;
	}
	return out;
}

// Pull { lat, lng, token } from a presence object (from checkIn) or a bare
// { lat, lng } fix. The token is optional — dev/preview reads work without it.
export function presenceFix(presence, label = 'this call') {
	const p = presence || {};
	const lat = Number(p.lat);
	const lng = Number(p.lng);
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
		throw new ThreeWsError(`${label} needs a presence from checkIn() (or a \`{ lat, lng }\` fix).`, { code: 'invalid_input' });
	}
	return { lat, lng, token: typeof p.token === 'string' ? p.token : null };
}

// Attach the presence token as the x-irl-fix header proof-of-presence reads and
// writes are gated on.
export function fixHeader(token, extra) {
	const h = { ...(extra || {}) };
	if (token) h['x-irl-fix'] = token;
	return h;
}

export function requireId(id, label) {
	if (!id || typeof id !== 'string') {
		throw new ThreeWsError(`${label} needs an id.`, { code: 'invalid_input' });
	}
	return id;
}
