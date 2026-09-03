// @ts-check
// Persistence for simulation-readiness grades: the cache and the corpus.
//
// A grade is a property of BYTES, so every row here is keyed by the GLB's
// sha256 and nothing else. The same mesh reaches us as a forge creation, an
// Object Library entry, a remix, and as an arbitrary third-party URL handed to
// the free endpoint; one row serves all four and none of them re-grade work
// that has already been done. That is also why a grade never expires on a
// clock: fixed bytes graded by a fixed grader cannot change their answer. The
// only thing that invalidates a row is a grader version bump, which is why
// `grader_version` is stored rather than assumed and why getGrade() treats a
// row from an older grader as a miss instead of serving a stale claim.
//
// Every function here is fail-soft. Grading is useful without a database and
// the caller always holds a freshly computed report, so a write that cannot
// land logs and returns rather than throwing: an outage must degrade the cache,
// never the grade. Schema: api/_lib/migrations/20260813180000_sim_readiness_grades.sql.

import { sql } from './db.js';
import { databaseConfigured } from './env.js';
import { SIM_READINESS_VERSION } from './sim-readiness.js';

const HASH_RE = /^[0-9a-f]{64}$/;

/** True when the store can read or write at all. */
export function simReadinessStoreEnabled() {
	return databaseConfigured();
}

// Postgres double precision rejects NaN/Infinity through the driver's numeric
// path and a JSON null is the honest value for "this report has no such
// number" (an unreadable buffer has no scale, no mass, no hull), so every
// promoted column goes through this rather than through Number() alone.
function finiteOrNull(value) {
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

/**
 * The cached grade for these bytes, or null when there is none at the current
 * grader version. A row written by an older grader is deliberately a miss: it
 * stays in the table (a signed grade is permanent evidence of what that grader
 * measured) but it is never served as if the current grader had produced it.
 *
 * @param {string} glbSha256 lowercase hex sha256 of the GLB
 * @param {{ graderVersion?: string }} [opts]
 * @returns {Promise<{ report: object, gradedAt: string, graderVersion: string, sourceUrl: string|null }|null>}
 */
export async function getGrade(glbSha256, opts = {}) {
	if (!simReadinessStoreEnabled() || !HASH_RE.test(String(glbSha256 || ''))) return null;
	const graderVersion = opts.graderVersion || SIM_READINESS_VERSION;
	try {
		const rows = await sql`
			select report, grader_version, source_url, graded_at
			from sim_readiness_grades
			where glb_sha256 = ${glbSha256} and grader_version = ${graderVersion}
			limit 1
		`;
		const row = rows[0];
		if (!row) return null;
		return {
			report: row.report,
			graderVersion: row.grader_version,
			sourceUrl: row.source_url ?? null,
			gradedAt: new Date(row.graded_at).toISOString(),
		};
	} catch (err) {
		console.warn('[sim-readiness-store] getGrade failed:', err?.message);
		return null;
	}
}

/**
 * Store a grade, promoting the four fields the product filters and sorts on out
 * of the JSON report into their own columns. Upserts on the content hash: a
 * re-grade at a new grader version replaces the row and re-stamps graded_at, so
 * the table always holds the newest reading for each asset.
 *
 * Returns the ISO timestamp the row now carries, or null when nothing was
 * written. A null is never an error the caller has to handle: it means the
 * grade is uncached, not that it is wrong.
 *
 * @param {{ glbSha256: string, report: object, sourceUrl?: string|null,
 *           creationId?: string|null, sizeBytes?: number|null, gradeMs?: number|null }} row
 * @returns {Promise<string|null>}
 */
export async function putGrade(row) {
	if (!simReadinessStoreEnabled()) return null;
	const { glbSha256, report } = row || {};
	if (!HASH_RE.test(String(glbSha256 || '')) || !report || typeof report !== 'object') return null;

	const graderVersion = String(report.grader || SIM_READINESS_VERSION);
	const verdict = String(report.verdict || 'unreadable');
	const blockers = Array.isArray(report.blockers) ? report.blockers : [];
	const warnings = Array.isArray(report.warnings) ? report.warnings : [];

	try {
		const rows = await sql`
			insert into sim_readiness_grades (
				glb_sha256, grader_version, verdict, blockers, warnings,
				watertight, longest_axis_m, volume_m3, convexity_ratio,
				triangles, size_bytes, source_url, creation_id, grade_ms, report, graded_at
			) values (
				${glbSha256}, ${graderVersion}, ${verdict},
				${JSON.stringify(blockers)}::jsonb, ${JSON.stringify(warnings)}::jsonb,
				${typeof report.topology?.watertight === 'boolean' ? report.topology.watertight : null},
				${finiteOrNull(report.scale?.longestAxisMeters)},
				${finiteOrNull(report.mass?.volumeM3)},
				${finiteOrNull(report.collision?.convexityRatio)},
				${finiteOrNull(report.geometry?.triangles)},
				${finiteOrNull(row.sizeBytes)},
				${row.sourceUrl || null},
				${row.creationId || null},
				${finiteOrNull(row.gradeMs)},
				${JSON.stringify(report)}::jsonb,
				now()
			)
			on conflict (glb_sha256) do update set
				grader_version = excluded.grader_version,
				verdict = excluded.verdict,
				blockers = excluded.blockers,
				warnings = excluded.warnings,
				watertight = excluded.watertight,
				longest_axis_m = excluded.longest_axis_m,
				volume_m3 = excluded.volume_m3,
				convexity_ratio = excluded.convexity_ratio,
				triangles = excluded.triangles,
				size_bytes = coalesce(excluded.size_bytes, sim_readiness_grades.size_bytes),
				source_url = coalesce(excluded.source_url, sim_readiness_grades.source_url),
				creation_id = coalesce(excluded.creation_id, sim_readiness_grades.creation_id),
				grade_ms = excluded.grade_ms,
				report = excluded.report,
				graded_at = now()
			returning graded_at
		`;
		return rows[0] ? new Date(rows[0].graded_at).toISOString() : null;
	} catch (err) {
		console.warn('[sim-readiness-store] putGrade failed:', err?.message);
		return null;
	}
}

export default { getGrade, putGrade, simReadinessStoreEnabled };
