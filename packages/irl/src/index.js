// @three-ws/irl — geofenced, real-world presence for agents and avatars.
// Thin client over the public /api/irl/* endpoints (the SDK twin of the live
// /irl surface): proof-of-presence minting, GPS pin placement, the geofenced
// nearby feed, and the real-world interaction log. See README.md for the full
// reference. Presence is the gate on every read — you can only query a point you
// are actually standing at.

import { createHttp, ThreeWsError } from './http.js';
import { prune, normToken, normalizeEnum, presenceFix, fixHeader } from './shared.js';
import { createDropsApi } from './drops.js';
import { createWorldLinesApi } from './world-lines.js';

export { ThreeWsError, PaymentRequiredError, DEFAULT_BASE_URL } from './http.js';

// Token lifetime the mint endpoint advertises (api/_lib/irl-presence.js
// FIX_TTL_SEC). Re-checkIn() once it lapses — the nearby read rejects an expired
// fix with `fix_required`.
const FIX_TTL_SEC = 180;
// Precision of the geohash cell carried on the presence token and used as the
// re-mint trigger as a viewer walks (FIX_CELL_PRECISION, ~153 m cell).
const FIX_CELL_PRECISION = 7;

const INTERACTION_TYPES = ['view', 'tap', 'message', 'pay'];
const PLACEMENT_KINDS = ['precise', 'approximate'];

/**
 * Create an IRL client bound to a base URL, fetch, and optional auth/device token.
 * For most callers the default exports (`checkIn()`, `nearby()`, …) backed by a
 * shared client are enough; use this when you want to reuse configuration — a
 * payment-aware fetch for an agent's `x402_endpoint`, a custom origin, or a
 * default anonymous device token — across many calls.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl]  API origin (default https://three.ws).
 * @param {typeof fetch} [options.fetch]  fetch implementation (default global fetch).
 * @param {string} [options.apiKey]  bearer session token for signed-in ownership.
 * @param {string} [options.deviceToken]  anonymous device credential (header-only).
 * @param {Record<string,string>} [options.headers]  default headers on every call.
 */
export function createIrl(options = {}) {
	const request = createHttp(options);
	const defaultDeviceToken = normToken(options.deviceToken);

	// Resolve the device token for a call: per-call override → client default. Sent
	// in the `x-irl-device` header (never the URL — it is a bearer credential).
	function deviceToken(opts) {
		return normToken(opts && opts.deviceToken) || defaultDeviceToken;
	}
	function deviceHeader(opts, extra) {
		const h = { ...(extra || {}) };
		const tok = deviceToken(opts);
		if (tok) h['x-irl-device'] = tok;
		return h;
	}

	/**
	 * Establish presence at a location and mint a short-lived proof-of-presence
	 * token. With no argument it reads the browser Geolocation API; pass
	 * `{ lat, lng, accuracy? }` to supply a fix yourself (Node, or any non-browser
	 * source). Wraps `POST /api/irl/fix-token` and returns the token alongside the
	 * fix so `nearby()` can prove the read.
	 */
	async function checkIn(input, opts = {}) {
		const fix = await resolveFix(input);
		const minted = await request('/api/irl/fix-token', {
			method: 'POST',
			body: { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy },
			signal: opts.signal,
		});
		if (!minted || typeof minted.token !== 'string') {
			throw new ThreeWsError('fix-token did not return a presence token.', { code: 'bad_response', body: minted });
		}
		return {
			lat: fix.lat,
			lng: fix.lng,
			accuracy: fix.accuracy ?? null,
			token: minted.token,
			expiresIn: minted.expires_in ?? FIX_TTL_SEC,
			// The precision-7 geohash the fix fell in — the client's "re-mint on cell
			// change" trigger. Server-supplied; fall back to a local encode so a
			// dev/preview response without it still carries the cell.
			cell: minted.cell || encodeGeohash(fix.lat, fix.lng, FIX_CELL_PRECISION),
			raw: minted,
		};
	}

	/**
	 * Read agents within the radius of where you checked in. Wraps
	 * `GET /api/irl/pins?lat=&lng=&radius=` with the presence token in the
	 * `x-irl-fix` header. Only answers for the coarse area the token was minted in.
	 */
	async function nearby(presence, opts = {}) {
		const { lat, lng, token } = presenceFix(presence, 'nearby()');
		// The fix token rides a header, gating the read to a genuine presence.
		const headers = fixHeader(token, opts.headers);
		const radius = opts.radius;
		if (radius !== undefined && !Number.isFinite(radius)) {
			throw new ThreeWsError('nearby() radius must be a finite number of metres.', { code: 'invalid_input' });
		}
		const res = await request('/api/irl/pins', {
			query: { lat, lng, radius },
			headers: deviceHeader(opts, headers),
			signal: opts.signal,
		});
		return (res?.pins || []).map(shapePin);
	}

	/**
	 * Drop a 3D agent at a coordinate. Wraps `POST /api/irl/pins`. Returns the
	 * created pin and a `permanent` flag (true for signed-in owners, false — 7-day
	 * expiry — for anonymous device placements).
	 */
	async function placePin(input, opts = {}) {
		const p = input || {};
		const lat = Number(p.lat);
		const lng = Number(p.lng);
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
			throw new ThreeWsError('placePin() needs finite `lat` and `lng`.', { code: 'invalid_input' });
		}
		if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
			throw new ThreeWsError('placePin() coordinates are out of range.', { code: 'invalid_input' });
		}
		const placementKind = normalizeEnum(p.placementKind, PLACEMENT_KINDS, 'placementKind');

		const body = prune({
			lat,
			lng,
			heading: p.heading,
			avatarUrl: p.avatarUrl,
			avatarName: p.avatarName,
			caption: p.caption,
			agentId: p.agentId,
			x402Endpoint: p.x402Endpoint,
			anchor: p.anchor,
			room: p.room,
			vps: p.vps,
			placementKind,
			fuzzRadiusM: p.fuzzRadiusM,
		});

		const res = await request('/api/irl/pins', {
			method: 'POST',
			body,
			headers: deviceHeader(opts),
			signal: opts.signal,
		});
		return { pin: shapeOwnPin(res?.pin), raw: res };
	}

	/**
	 * List the pins you placed. With a device token, wraps `GET /api/irl/pins/mine`
	 * (the token rides the `x-irl-device` header); for a signed-in session,
	 * `GET /api/irl/pins?mine=1`.
	 */
	async function myPins(opts = {}) {
		const tok = deviceToken(opts);
		const res = tok
			? await request('/api/irl/pins/mine', { headers: deviceHeader(opts), signal: opts.signal })
			: await request('/api/irl/pins', { query: { mine: '1' }, signal: opts.signal });
		return (res?.pins || []).map(shapeOwnPin);
	}

	/**
	 * Log a real-world encounter. Wraps `POST /api/irl/interactions`. `agent_id`
	 * and owner are taken from the pin, never the caller.
	 */
	async function interact(input, opts = {}) {
		const i = input || {};
		const pinId = i.pinId ?? i.pin_id;
		if (!pinId || typeof pinId !== 'string') {
			throw new ThreeWsError('interact() needs a `pinId`.', { code: 'invalid_input' });
		}
		const type = i.type === undefined ? undefined : normalizeEnum(i.type, INTERACTION_TYPES, 'type');

		const body = prune({
			pinId,
			type,
			message: i.message,
			replyTo: i.replyTo,
			payload: i.payload,
			// `pay` settlement fields — passed through to the on-chain dedupe + earnings.
			signature: i.signature,
			currencyMint: i.currencyMint,
			amount: i.amount,
			network: i.network,
			device_type: i.deviceType,
		});

		const res = await request('/api/irl/interactions', {
			method: 'POST',
			body,
			headers: deviceHeader(opts),
			signal: opts.signal,
		});
		return shapeInteraction(res);
	}

	/** Remove one pin you placed. Wraps `DELETE /api/irl/pins?id=`. */
	async function removePin(id, opts = {}) {
		if (!id || typeof id !== 'string') {
			throw new ThreeWsError('removePin() needs a pin id.', { code: 'invalid_input' });
		}
		const res = await request('/api/irl/pins', {
			method: 'DELETE',
			query: { id },
			headers: deviceHeader(opts),
			signal: opts.signal,
		});
		return { ok: Boolean(res?.ok), raw: res };
	}

	/**
	 * Wipe every pin placed from a device token in one round-trip. Wraps
	 * `DELETE /api/irl/pins?all=1` — requires a device token (the bulk purge is
	 * scoped strictly to the credential that placed the pins).
	 */
	async function purgePins(opts = {}) {
		if (!deviceToken(opts)) {
			throw new ThreeWsError('purgePins() needs a device token (set one via createIrl/configure or pass { deviceToken }).', { code: 'invalid_input' });
		}
		const res = await request('/api/irl/pins', {
			method: 'DELETE',
			query: { all: '1' },
			headers: deviceHeader(opts),
			signal: opts.signal,
		});
		return { ok: Boolean(res?.ok), deleted: Number(res?.deleted) || 0, raw: res };
	}

	// Money Drops & World Lines — the same request core, device token, and
	// presence contract, wrapped for /api/irl/drops and /api/irl/world-lines.
	const drops = createDropsApi({ request, deviceHeader });
	const worldLines = createWorldLinesApi({ request, deviceHeader });

	return { checkIn, nearby, placePin, myPins, interact, removePin, purgePins, ...drops, ...worldLines };
}

// ── Default zero-config client (the `import { checkIn }` path) ───────────────
// A module-level client built lazily so the common case needs no setup, plus a
// `configure()` to set a base URL / default device token once for the module.
let shared = null;
let sharedOptions = {};
function defaultClient() {
	return (shared ||= createIrl(sharedOptions));
}

/**
 * Set module-level defaults for the zero-config functions: base origin (defaults
 * to https://three.ws) and an anonymous device token sent header-only on every
 * write. Rebuilds the shared client.
 */
export function configure(opts = {}) {
	sharedOptions = { ...sharedOptions, ...opts };
	shared = null;
	return sharedOptions;
}

/** Establish presence and mint a proof-of-presence token. */
export function checkIn(input, opts) {
	return defaultClient().checkIn(input, opts);
}
/** Read agents within the radius of where you checked in. */
export function nearby(presence, opts) {
	return defaultClient().nearby(presence, opts);
}
/** Drop a 3D agent at a coordinate. */
export function placePin(input, opts) {
	return defaultClient().placePin(input, opts);
}
/** List the pins you placed. */
export function myPins(opts) {
	return defaultClient().myPins(opts);
}
/** Log a real-world encounter with an agent. */
export function interact(input, opts) {
	return defaultClient().interact(input, opts);
}
/** Remove one pin you placed. */
export function removePin(id, opts) {
	return defaultClient().removePin(id, opts);
}
/** Wipe every pin placed from a device token. */
export function purgePins(opts) {
	return defaultClient().purgePins(opts);
}

// ── Money Drops (real value escrowed at real-world spots) ────────────────────

/** Live drops within the radius of where you checked in (presence-gated). */
export function nearbyDrops(presence, opts) {
	return defaultClient().nearbyDrops(presence, opts);
}
/** One drop by id — coarse (~110 m) location for anyone but the owner. */
export function getDrop(id, opts) {
	return defaultClient().getDrop(id, opts);
}
/** Your created drops (every status) plus your claim receipts. */
export function myDrops(opts) {
	return defaultClient().myDrops(opts);
}
/** Place value in the real world — returns the escrow address to fund. */
export function createDrop(input, opts) {
	return defaultClient().createDrop(input, opts);
}
/** Confirm your signed funding transfer on-chain and activate the drop. */
export function fundDrop(input, opts) {
	return defaultClient().fundDrop(input, opts);
}
/** Claim a drop you are standing at — a real on-chain release to your wallet. */
export function claimDrop(input, opts) {
	return defaultClient().claimDrop(input, opts);
}
/** Cancel an unclaimed drop you created — a real on-chain refund sweep. */
export function cancelDrop(id, opts) {
	return defaultClient().cancelDrop(id, opts);
}

// ── World Lines (agent-signed proof-of-presence AR quests) ──────────────────

/** Quests near where you checked in (fix-gated; distance coarsened to 10 m). */
export function nearbyWorldLines(presence, opts) {
	return defaultClient().nearbyWorldLines(presence, opts);
}
/** Public, coordinate-free discovery — region roll-up or one region's quests. */
export function browseWorldLines(opts) {
	return defaultClient().browseWorldLines(opts);
}
/** One quest for the AR detail view — full challenge only when co-located. */
export function getWorldLine(id, opts) {
	return defaultClient().getWorldLine(id, opts);
}
/** Place a quest anchored to a pin you own, signed by an agent you own. */
export function createWorldLine(input, opts) {
	return defaultClient().createWorldLine(input, opts);
}
/** Your placed quests + a coarse completion heatmap (signed-in). */
export function myWorldLines(opts) {
	return defaultClient().myWorldLines(opts);
}
/** The proof-of-presence collectibles you've earned. */
export function myCollectibles(opts) {
	return defaultClient().myCollectibles(opts);
}
/** Start a completion at the spot — issues the single-use nonce. */
export function challengeWorldLine(input, opts) {
	return defaultClient().challengeWorldLine(input, opts);
}
/** Finish the interaction and receive the agent-signed proof collectible. */
export function completeWorldLine(input, opts) {
	return defaultClient().completeWorldLine(input, opts);
}
/** Independently re-verify a proof's agent signature (public). */
export function verifyProof(proofId, opts) {
	return defaultClient().verifyProof(proofId, opts);
}

// ── Fix resolution ──────────────────────────────────────────────────────────

// Resolve a fix to { lat, lng, accuracy? } from an explicit object, a presence
// already carrying a fix, or — with no input — the browser Geolocation API.
async function resolveFix(input) {
	if (input && Number.isFinite(Number(input.lat)) && Number.isFinite(Number(input.lng))) {
		return {
			lat: Number(input.lat),
			lng: Number(input.lng),
			accuracy: Number.isFinite(Number(input.accuracy)) ? Number(input.accuracy) : undefined,
		};
	}
	if (input !== undefined && input !== null) {
		throw new ThreeWsError('checkIn() needs `{ lat, lng }` — or call it with no argument in a browser to read GPS.', { code: 'invalid_input' });
	}
	return readBrowserFix();
}

// Read a single GPS fix from the browser Geolocation API. Rejects with a typed
// error outside a browser so a Node caller gets a clear "pass { lat, lng }".
function readBrowserFix() {
	const geo = typeof navigator !== 'undefined' ? navigator.geolocation : undefined;
	if (!geo || typeof geo.getCurrentPosition !== 'function') {
		throw new ThreeWsError('No Geolocation API available — pass an explicit `{ lat, lng }` to checkIn().', { code: 'no_geolocation' });
	}
	return new Promise((resolve, reject) => {
		geo.getCurrentPosition(
			(pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
			(err) => reject(new ThreeWsError(`Geolocation failed: ${err?.message || 'permission denied'}`, { code: 'geolocation_failed' })),
			{ enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
		);
	});
}

// ── Response shaping (snake_case → camelCase, with a .raw escape hatch) ──────

// A pin from the public nearby feed — the allow-list projection (never user_id
// or device_token). Coordinates are server-coarsened to ~1.1 m.
function shapePin(r) {
	if (!r || typeof r !== 'object') return r;
	return {
		id: r.id,
		agentId: r.agent_id ?? null,
		lat: r.lat,
		lng: r.lng,
		heading: r.heading ?? 0,
		distanceM: r.distance_m ?? null,
		avatarUrl: r.avatar_url ?? null,
		avatarName: r.avatar_name ?? null,
		caption: r.caption ?? null,
		x402Endpoint: r.x402_endpoint ?? null,
		viewCount: Number(r.view_count) || 0,
		avatarVersion: Number(r.avatar_version) || 0,
		placedAt: r.placed_at ?? null,
		anchorHeightM: r.anchor_height_m ?? null,
		anchorYawDeg: r.anchor_yaw_deg ?? null,
		anchorQuat: r.anchor_quat ?? null,
		anchorSource: r.anchor_source ?? null,
		gpsAccuracyM: r.gps_accuracy_m ?? null,
		altitudeM: r.altitude_m ?? null,
		roomId: r.room_id ?? null,
		relEastM: r.rel_east_m ?? null,
		relNorthM: r.rel_north_m ?? null,
		originLat: r.origin_lat ?? null,
		originLng: r.origin_lng ?? null,
		originYawDeg: r.origin_yaw_deg ?? null,
		isMine: Boolean(r.is_mine),
		raw: r,
	};
}

// A pin the caller owns (from placePin / myPins) — carries owner-only fields the
// public feed strips, plus the `permanent` flag from the create response.
function shapeOwnPin(r) {
	if (!r || typeof r !== 'object') return r;
	return {
		id: r.id,
		agentId: r.agent_id ?? null,
		lat: r.lat,
		lng: r.lng,
		heading: r.heading ?? 0,
		avatarUrl: r.avatar_url ?? null,
		avatarName: r.avatar_name ?? null,
		caption: r.caption ?? null,
		x402Endpoint: r.x402_endpoint ?? null,
		viewCount: Number(r.view_count) || 0,
		avatarVersion: Number(r.avatar_version) || 0,
		placedAt: r.placed_at ?? null,
		expiresAt: r.expires_at ?? null,
		permanent: 'permanent' in r ? Boolean(r.permanent) : (r.expires_at == null),
		raw: r,
	};
}

// A logged interaction from POST /api/irl/interactions.
function shapeInteraction(res) {
	if (!res || typeof res !== 'object') return res;
	const ix = res.interaction || {};
	return {
		ok: Boolean(res.ok),
		id: ix.id ?? res.id ?? null,
		type: ix.type ?? null,
		createdAt: ix.created_at ?? null,
		deduped: Boolean(res.deduped),
		self: Boolean(res.self),
		notified: Boolean(res.notified),
		raw: res,
	};
}

// Geohash encoder — identical lattice to api/_lib/geohash.js so a fix maps to the
// same precision-7 cell the server keys on. Used as the local fallback for a
// presence cell and to compare cells across a walk-up poll.
const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
export function encodeGeohash(lat, lng, precision = FIX_CELL_PRECISION) {
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
	let idx = 0;
	let bit = 0;
	let evenBit = true;
	let geohash = '';
	let latMin = -90, latMax = 90;
	let lngMin = -180, lngMax = 180;
	while (geohash.length < precision) {
		if (evenBit) {
			const mid = (lngMin + lngMax) / 2;
			if (lng >= mid) { idx = idx * 2 + 1; lngMin = mid; } else { idx = idx * 2; lngMax = mid; }
		} else {
			const mid = (latMin + latMax) / 2;
			if (lat >= mid) { idx = idx * 2 + 1; latMin = mid; } else { idx = idx * 2; latMax = mid; }
		}
		evenBit = !evenBit;
		if (++bit === 5) {
			geohash += GEOHASH_BASE32[idx];
			bit = 0;
			idx = 0;
		}
	}
	return geohash;
}
