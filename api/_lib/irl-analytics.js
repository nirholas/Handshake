// api/_lib/irl-analytics.js
//
// Site-wide /irl usage analytics — the one thing the feature never had. Every
// other IRL surface (pins, interactions, drops, world lines) tracks state
// per-pin or per-owner; nothing rolled it up into "how many people actually
// use this feature, and through which door." This module is that rollup.
//
// Design constraints, both driven by the existing IRL privacy posture
// (see docs/irl/THREAT-MODEL.md, the H4/H5/H6 notes in api/irl/pins.js and
// api/irl/interactions.js):
//   - Never store a raw device token or exact coordinate. Events carry a
//     16-hex-char sha256 prefix of the device token (irreversible, matches
//     the `ipHash` pattern already used for sweep detection in pins.js) and,
//     when a location is available, only the ~150m geocell7 the rest of the
//     codebase already treats as the public-safe location granularity.
//   - Bounded retention. `irl_events` is swept by the existing IRL reaper
//     cron (api/cron/irl-reap.js) the same way interaction rows are, so a
//     coarse usage trail doesn't accumulate forever either.
//   - Logging must never be able to break the request it's attached to.
//     logIrlEvent() swallows and logs every failure internally.
//
// Follows the same self-provisioning-schema convention as the rest of
// api/irl/* (CREATE TABLE IF NOT EXISTS inline, cached per warm container —
// see ensureTable() in api/irl/pins.js) rather than the api/_lib/migrations
// pipeline, which IRL tables don't participate in.

import { sql } from './db.js';
import { sha256 } from './crypto.js';
import { encodeGeohash } from './geohash.js';

const GEOCELL_PRECISION = 7; // matches api/irl/pins.js's density-cell precision

let schemaReady = false;

export async function ensureIrlAnalyticsSchema() {
	if (schemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS irl_events (
			id          BIGSERIAL PRIMARY KEY,
			event_type  TEXT NOT NULL,
			pin_id      UUID,
			geocell7    TEXT,
			device_hash TEXT,
			metadata    JSONB,
			created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS irl_events_type_created ON irl_events (event_type, created_at DESC)`;
	await sql`CREATE INDEX IF NOT EXISTS irl_events_created ON irl_events (created_at)`;

	await sql`
		CREATE TABLE IF NOT EXISTS irl_pin_shares (
			id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
			pin_id      UUID NOT NULL REFERENCES irl_pins(id) ON DELETE CASCADE,
			token       TEXT NOT NULL UNIQUE,
			image_key   TEXT NOT NULL,
			image_url   TEXT NOT NULL,
			device_hash TEXT,
			view_count  BIGINT NOT NULL DEFAULT 0,
			created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS irl_pin_shares_pin ON irl_pin_shares (pin_id)`;

	schemaReady = true;
}

/** sha256(token).slice(0,16) — same opaque-prefix convention as pins.js's ipHash. Never stores the raw token. */
export async function hashDeviceToken(token) {
	if (!token || typeof token !== 'string') return null;
	return (await sha256(token)).slice(0, 16);
}

// event_type vocabulary — keep this list authoritative so a typo'd type never
// silently fragments the rollup below.
export const IRL_EVENT_TYPES = new Set([
	'pin_created',   // a placement landed (AR method carried in metadata.mode: webxr | quicklook | pin | map)
	'nearby_fetch',  // a browse/discovery read of the nearby feed (metadata.count = pins returned)
	'share_created', // a shareable card was minted for a pin
	'share_viewed',  // a minted share link was opened
]);

/**
 * Fire-and-forget event log. Never throws — a caller on the hot path (placing
 * a pin, reading nearby) must never fail or slow down because analytics did.
 *
 * @param {object} opts
 * @param {string} opts.type IRL_EVENT_TYPES member
 * @param {string} [opts.pinId]
 * @param {number} [opts.lat] @param {number} [opts.lng] — coarsened to geocell7 before storage, never kept raw
 * @param {string} [opts.deviceToken] — hashed before storage, never kept raw
 * @param {object} [opts.metadata]
 */
export async function logIrlEvent({ type, pinId, lat, lng, deviceToken, metadata } = {}) {
	if (!IRL_EVENT_TYPES.has(type)) return;
	try {
		await ensureIrlAnalyticsSchema();
		const geocell7 = Number.isFinite(lat) && Number.isFinite(lng) ? encodeGeohash(lat, lng, GEOCELL_PRECISION) : null;
		const deviceHash = await hashDeviceToken(deviceToken);
		await sql`
			INSERT INTO irl_events (event_type, pin_id, geocell7, device_hash, metadata)
			VALUES (${type}, ${pinId || null}, ${geocell7}, ${deviceHash}, ${metadata ? JSON.stringify(metadata) : null}::jsonb)
		`;
	} catch (err) {
		console.error('[irl-analytics] logIrlEvent failed (non-fatal)', { type, reason: err?.message || String(err) });
	}
}

/** Record a share-link open, best-effort, and bump the share row's view_count. */
export async function recordShareView(token) {
	try {
		await ensureIrlAnalyticsSchema();
		const rows = await sql`
			UPDATE irl_pin_shares SET view_count = view_count + 1
			WHERE token = ${token}
			RETURNING pin_id
		`;
		if (rows[0]) {
			await logIrlEvent({ type: 'share_viewed', pinId: rows[0].pin_id, metadata: { token } });
		}
		return rows[0] || null;
	} catch (err) {
		console.error('[irl-analytics] recordShareView failed (non-fatal)', { reason: err?.message || String(err) });
		return null;
	}
}

const WINDOWS = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };

/**
 * Owner-facing rollup — GET /api/irl/analytics. Every number here is a real
 * aggregate query, no cached/sampled/fake figures.
 */
export async function getIrlAnalyticsSummary() {
	await ensureIrlAnalyticsSchema();

	const windows = {};
	for (const [key, interval] of Object.entries(WINDOWS)) {
		const [placed] = await sql`
			SELECT count(*)::int AS n, count(DISTINCT device_hash)::int AS unique_devices
			FROM irl_events WHERE event_type = 'pin_created' AND created_at > now() - ${interval}::interval
		`;
		const [nearby] = await sql`
			SELECT count(*)::int AS n, count(DISTINCT device_hash)::int AS unique_devices
			FROM irl_events WHERE event_type = 'nearby_fetch' AND created_at > now() - ${interval}::interval
		`;
		const interactionRows = await sql`
			SELECT type, count(*)::int AS n FROM irl_interactions
			WHERE created_at > now() - ${interval}::interval GROUP BY type
		`;
		const [shares] = await sql`
			SELECT count(*)::int AS created, coalesce(sum(view_count), 0)::int AS views
			FROM irl_pin_shares WHERE created_at > now() - ${interval}::interval
		`;
		const [drops] = await sql`
			SELECT count(*)::int AS n FROM irl_drop_claims
			WHERE status = 'confirmed' AND confirmed_at > now() - ${interval}::interval
		`;

		windows[key] = {
			pins_placed: placed?.n || 0,
			unique_placers: placed?.unique_devices || 0,
			nearby_fetches: nearby?.n || 0,
			unique_browsers: nearby?.unique_devices || 0,
			interactions: Object.fromEntries(interactionRows.map((r) => [r.type, r.n])),
			shares_created: shares?.created || 0,
			share_views: shares?.views || 0,
			drops_claimed: drops?.n || 0,
		};
	}

	const placementModes = await sql`
		SELECT coalesce(metadata->>'mode', 'unknown') AS mode, count(*)::int AS n
		FROM irl_events
		WHERE event_type = 'pin_created' AND created_at > now() - interval '30 days'
		GROUP BY mode ORDER BY n DESC
	`;

	const dailySeries = await sql`
		SELECT
			day::date AS day,
			coalesce(p.n, 0)::int AS pins_placed,
			coalesce(n.n, 0)::int AS nearby_fetches
		FROM generate_series(current_date - interval '29 days', current_date, interval '1 day') AS day
		LEFT JOIN (
			SELECT date_trunc('day', created_at) AS day, count(*) AS n
			FROM irl_events WHERE event_type = 'pin_created' AND created_at > now() - interval '30 days'
			GROUP BY 1
		) p ON p.day = day
		LEFT JOIN (
			SELECT date_trunc('day', created_at) AS day, count(*) AS n
			FROM irl_events WHERE event_type = 'nearby_fetch' AND created_at > now() - interval '30 days'
			GROUP BY 1
		) n ON n.day = day
		ORDER BY day ASC
	`;

	return {
		windows,
		placement_modes_30d: Object.fromEntries(placementModes.map((r) => [r.mode, r.n])),
		daily_series_30d: dailySeries.map((r) => ({
			day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10),
			pins_placed: r.pins_placed,
			nearby_fetches: r.nearby_fetches,
		})),
		generated_at: new Date().toISOString(),
	};
}
