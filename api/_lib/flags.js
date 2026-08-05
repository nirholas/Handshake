// @ts-check
// Runtime feature flags — DB-backed switches that flip without a redeploy.
//
// A flag lives in the `app_flags` table (key, enabled, value). Code reads it
// with isFlagEnabled()/getFlag(); flip a flag with setFlag() from ops tooling
// or SQL against `app_flags` (see docs/ops/runtime-flags.md).
// When no row exists the flag reports its caller-supplied `fallback` (normally
// the matching env var), so adopting a flag is back-compatible: behavior only
// changes once someone sets a row.
//
// Reads are cached in-process for a short TTL so a per-minute cron and hot paths
// don't hit the DB every call. Each serverless instance refreshes independently,
// so a toggle propagates fleet-wide within CACHE_TTL_MS. setFlag() clears the
// local entry immediately so the writer sees its own change at once.
//
// Every read is fail-soft: if the DB is unconfigured or the query throws, the
// flag resolves to `fallback` rather than propagating the error — a flags table
// outage must never take down a cron or a request path.

import { sql } from './db.js';

const CACHE_TTL_MS = 30_000;

/** @type {Map<string, { enabled: boolean, value: unknown, exists: boolean, expires: number }>} */
const _cache = new Map();

// Known flags: lets listFlags() enumerate switches (with their effective state)
// even before a row exists, and documents which env var each one falls back to.
export const KNOWN_FLAGS = {
	avaturn_seed: {
		env: 'AVATURN_SEED_ENABLED',
		description:
			'Per-minute headless Avaturn seed cron — forges a fully-rigged Avaturn avatar and publishes it public to the gallery.',
	},
	avaturn_seed_photo: {
		env: null,
		description:
			'Diverse-humans lane for the Avaturn seeder — generates a face across a gender/age/ethnicity matrix and reconstructs it with Avaturn v2, so seeded avatars are distinct people. Requires AVATURN_API_KEY; falls back to the catalog lane if unset or a face fails.',
	},
};

/**
 * Read a flag's full state. Returns the cached row when fresh, otherwise queries
 * `app_flags` and caches the result. On any DB error returns the fallback with
 * exists=false so callers degrade to the code default.
 *
 * @param {string} key
 * @param {{ fallback?: boolean }} [opts]
 * @returns {Promise<{ enabled: boolean, value: unknown, exists: boolean }>}
 */
export async function getFlag(key, { fallback = false } = {}) {
	const now = Date.now();
	const hit = _cache.get(key);
	if (hit && hit.expires > now) {
		return {
			enabled: hit.exists ? hit.enabled : fallback,
			value: hit.value,
			exists: hit.exists,
		};
	}

	try {
		const [row] = await sql`
			select enabled, value from app_flags where key = ${key} limit 1
		`;
		const exists = !!row;
		const enabled = exists ? row.enabled === true : false;
		const value = exists ? (row.value ?? null) : null;
		_cache.set(key, { enabled, value, exists, expires: now + CACHE_TTL_MS });
		return { enabled: exists ? enabled : fallback, value, exists };
	} catch {
		// Fail-soft: never let a flags-table hiccup break the caller.
		return { enabled: fallback, value: null, exists: false };
	}
}

/**
 * Convenience boolean read.
 * @param {string} key
 * @param {{ fallback?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
export async function isFlagEnabled(key, opts) {
	return (await getFlag(key, opts)).enabled;
}

/**
 * Upsert a flag and clear its cache entry so the writing instance sees the new
 * value immediately. `value` is optional structured JSON for non-boolean flags.
 *
 * @param {string} key
 * @param {{ enabled: boolean, value?: unknown, updatedBy?: string | null }} patch
 * @returns {Promise<{ key: string, enabled: boolean, value: unknown, updated_at: string }>}
 */
export async function setFlag(key, { enabled, value = null, updatedBy = null }) {
	const [row] = await sql`
		insert into app_flags (key, enabled, value, updated_by, updated_at)
		values (${key}, ${enabled === true}, ${value === null ? null : JSON.stringify(value)}::jsonb, ${updatedBy}, now())
		on conflict (key) do update
			set enabled = excluded.enabled,
			    value = excluded.value,
			    updated_by = excluded.updated_by,
			    updated_at = now()
		returning key, enabled, value, updated_at
	`;
	_cache.delete(key);
	return row;
}

/**
 * List every flag row, merged with the KNOWN_FLAGS registry so the console shows
 * documented switches that have no row yet (enabled=false, exists=false).
 * @returns {Promise<Array<{ key: string, enabled: boolean, value: unknown, exists: boolean, env: string | null, description: string | null, updated_at: string | null }>>}
 */
export async function listFlags() {
	let rows = [];
	try {
		rows = await sql`select key, enabled, value, updated_at from app_flags order by key`;
	} catch {
		rows = [];
	}
	const byKey = new Map(rows.map((r) => [r.key, r]));
	const keys = new Set([...Object.keys(KNOWN_FLAGS), ...byKey.keys()]);
	return [...keys].sort().map((key) => {
		const row = byKey.get(key);
		const meta = KNOWN_FLAGS[key] || {};
		return {
			key,
			enabled: row ? row.enabled === true : false,
			value: row ? (row.value ?? null) : null,
			exists: !!row,
			env: meta.env ?? null,
			description: meta.description ?? null,
			updated_at: row ? row.updated_at : null,
		};
	});
}

// Test seam — drop cached entries so a unit test sees fresh DB reads.
export function __clearFlagCache() {
	_cache.clear();
}
