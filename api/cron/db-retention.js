// @ts-check
// GET /api/cron/db-retention — keep the database under its storage cap.
//
// Why this exists
// ---------------
// The platform runs on a Neon branch with a hard project-size cap (512 MB on the
// free tier). Two families of tables grow without bound and, left alone, march the
// branch straight into that cap — at which point Postgres raises SQLSTATE 53100
// ("could not extend file because project size limit … exceeded") and every WRITE
// path starts failing (the production incident this cron closes out):
//
//   1. The pump.fun intel firehose. `pump_coin_intel` ingests ~15–20k new mints a
//      day (≈30 MB/day), and its mint-keyed satellites (`pump_coin_wallets`,
//      `coin_smart_money`, `smart_money_scored`, `pump_coin_outcomes`,
//      `oracle_conviction`, `oracle_conviction_history`) grow in lockstep — ~60 MB
//      a day across the family. Nothing pruned it, so it accreted until the branch
//      was full.
//   2. `avatar_regen_jobs`. Each reconstruct job's `params` carries the multi-MB
//      base64 SOURCE images. The live path drops them once a job leaves
//      reconstruction (reconstruct-finalize.js), but terminal (done/failed) jobs
//      that took another route kept them — 346 rows were holding 43 MB.
//
// What it does
// ------------
// Runs on a schedule and, idempotently + bounded so a single tick can never run
// away past the function's maxDuration:
//
//   A. FIREHOSE RETENTION. Deletes every mint (and its satellite rows) older than
//      the retention window. The window self-tunes: normally PUMP_INTEL_RETENTION_
//      DAYS, but when the branch is over the high-water mark it tightens to
//      PUMP_INTEL_MIN_RETENTION_DAYS so the cap is never actually hit. This is the
//      self-healing valve — it sheds the oldest firehose data under storage
//      pressure and relaxes again once space is reclaimed. The engine's own judge
//      window (smart-money-rollup.js) resolves coins within a day or two of launch,
//      so a multi-day window keeps everything load-bearing; wallet reputation
//      (`wallet_reputation`, wallet-keyed, the durable output) and the win/loss
//      ground truth (`pumpfun_graduations`) are never touched.
//   A4. AUTOPILOT RUN LOGS. The buyback/distribute crons record one row per coin
//      per tick. Successful runs carry a tx_signature and are kept forever; the
//      `failed`/`skipped` diagnostic rows are pruned on the firehose window.
//   B. AVATAR JOB HYGIENE. Strips the base64 source images from terminal jobs past
//      a day old, and deletes terminal jobs past 30 days.
//   C. VACUUM. Plain VACUUM on the tables it pruned so the freed pages become
//      reusable and Neon's storage GC can return them.
//   D. COMPACTION. Plain VACUUM never shrinks the relation FILES, so on Neon
//      pg_database_size stays high after a prune and the storage-pressure gate
//      (isStoragePressured / requireWriteCapacity) can latch permanently: the
//      July 2026 recurrence had 770 MB of dead file space across the pruned
//      tables while every write-heavy cron sat skipped. When a tick starts
//      under pressure, this step measures reclaimable space per managed table
//      (pgstattuple_approx) and VACUUM FULLs the worst offenders, smallest
//      first and bounded per tick, so the file space actually returns and the
//      gate unlatches without a human.
//   E. HOME ACTION-LOG RETENTION. home_action_log is the "what did my agent do in
//      my house" trail, and read the other way round it is a behavioural record
//      of a household: when someone came home, which rooms they lit, what time
//      the bedroom light went off. Its window is therefore NOT a platform
//      constant and NOT tunable by an env var here. It is per home and it is
//      the owner's, stored on home_connections.action_log_retention_days
//      (90 days by default). This step joins the log against its own home's
//      setting so the whole policy stays in the database. Deliberately exempt
//      from the storage-pressure valve in both directions: shortening someone's
//      audit trail because our disk is full is not our call to make, and the
//      rows are small enough that they cannot be the reason it is full.
//      See docs/home-privacy.md and api/_lib/home/privacy.js.
//
// DELETE (not UPDATE) is used for the firehose because DELETE settles xmax in place
// and does NOT extend a relation file — it therefore succeeds even AT the cap,
// where an UPDATE (which writes a new tuple version, needing a fresh page) would
// itself fail with 53100. The image-strip UPDATE is guarded for the same reason.
//
// Everything here operates on the platform's OWN runtime launch/intel records at
// runtime and hardcodes no specific mint — generic retention plumbing, not an
// endorsement of any coin.

import { json, method, wrapCron } from '../_lib/http.js';
import { sql, isDbCapacityError } from '../_lib/db.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { requireCron } from '../_lib/cron-auth.js';
import { purgeExpiredActionLog } from '../_lib/home/privacy.js';

// Mint-keyed satellites of pump_coin_intel, deleted before the master so no run
// orphans a satellite row. Every name here is a fixed constant (never user input),
// so splicing it into the DELETE text below is safe. Verified to carry a `mint`
// column. Deliberately EXCLUDES: wallet_reputation / smart_wallet_reputation
// (wallet-keyed accumulated output — the durable product value), and
// pumpfun_graduations (small, slow-growing win/loss ground truth the judge reads).
const FIREHOSE_SATELLITES = [
	'pump_coin_wallets',
	'coin_smart_money',
	'smart_money_scored',
	'pump_coin_outcomes',
	'oracle_conviction',
	'oracle_conviction_history',
];

// Bounds so a single tick stays well under the function's maxDuration. The cron
// re-runs on its schedule, so a large backlog (the first prune once data crosses
// the window, or a pressure-valve catch-up) is chewed through over several ticks.
const MINT_BATCH = 2000; // mints per cascade batch
const MAX_MINTS_PER_RUN = 40_000; // ceiling per tick across all batches
const REGEN_STRIP_BATCH = 200;
const REGEN_DELETE_BATCH = 500;
const REGEN_MAX_ITERS = 40;
const SERIES_BATCH = 5000; // rows per batch for time-keyed series prunes
const SERIES_MAX_PER_RUN = 50_000; // per-table ceiling per tick
const ORPHAN_BATCH = 5000; // orphaned satellite rows per table per tick

// Compaction bounds (section D). VACUUM FULL rewrites a table into a fresh file
// under an ACCESS EXCLUSIVE lock, cheap on Neon for these churn tables (a
// 500 MB table compacted in ~2 s in the July 2026 recovery) but never free, so
// only tables with real reclaimable space qualify and each tick rewrites at
// most a few. Smallest-first ordering matters near the hard cap: each rewrite
// needs headroom ≈ the table's LIVE size, so freeing the small ones first buys
// the room to rewrite the big ones.
const COMPACT_MIN_FREE_MB = 25; // ignore tables with less reclaimable space than this
const COMPACT_MIN_FREE_RATIO = 0.3; // ... or mostly-live files (rewrite buys little)
const COMPACT_MAX_TABLES = 3; // per tick; the cron re-runs on its schedule

// Time-keyed tables outside the mint-cascade family that still grow without
// bound. Each is pruned by its own timestamp column on the shared valve
// (window tightens to the floor under storage pressure). All names/columns are
// fixed constants — never user input — so splicing them into SQL text is safe.
//
//   - pump_launch_snapshots: append-only jsonb time series (one row per paid
//     snapshot, `launches` carries the full launch list) — July 2026 storage
//     incident showed retention never touched it.
//   - x402_autonomous_log: one row per autonomous x402 call, success AND
//     failure, with jsonb response payloads. Money-adjacent (tx signatures),
//     so it keeps the audit ledger's longer window.
//   - sniper_coin_sentiment / token_intel_risk: keyed (mint, network) so they
//     grow with the mint universe; their gates treat stale rows as absent, so
//     rows past the firehose window are dead weight.
//   - x402_spent_payments: one small row per honoured x402 payment proof, the
//     durable replay guard behind api/_lib/x402/spent-payments.js. Its window is
//     `spent` — FIXED at 90 days and deliberately exempt from the storage-
//     pressure valve, because shortening it is exactly what re-opens the replay
//     hole the table exists to close. The rows are tiny (a hash, a route, an
//     amount), so it cannot be the reason the branch is under pressure.
//
// DELIBERATELY UNMANAGED, and the single biggest table this cron does NOT prune:
// x402_self_facilitator_log (632 MB as of 2026-08-10, third largest in the
// branch). Every other big grower above is churn; this one is the settle book.
// It is excluded because /api/x402-ring aggregates it with NO time filter for
// its `lifetime` period (api/x402-ring.js, sinceFor() returns null), so any
// retention window silently shrinks published lifetime settlement and fee
// totals. Every other reader is short-window (healthz 24h, fee-audit and
// wallet-fee-meter current-day, ring-reconciliation LOOKBACK_HOURS,
// sponsor-runway X402_SPONSOR_BURN_WINDOW_DAYS), so a window is technically
// safe for them. Pruning it is therefore a product decision about the public
// revenue figures, not a mechanical retention one: get owner sign-off on what
// `lifetime` should mean (and roll the pruned totals into a summary row first)
// before adding it here.
const TIME_SERIES_TABLES = [
	{ table: 'pump_launch_snapshots', tsColumn: 'ts', windowKind: 'firehose' },
	{ table: 'x402_autonomous_log', tsColumn: 'ts', windowKind: 'audit' },
	{ table: 'sniper_coin_sentiment', tsColumn: 'checked_at', windowKind: 'firehose' },
	{ table: 'token_intel_risk', tsColumn: 'checked_at', windowKind: 'firehose' },
	{ table: 'x402_spent_payments', tsColumn: 'created_at', windowKind: 'spent' },
];

// ── Autopilot run logs ────────────────────────────────────────────────────────
// The buyback / distribute crons append one row per coin per tick, whatever the
// outcome. Successful runs carry a `tx_signature` — an on-chain money record we
// keep indefinitely (the /autopilot history reads them). Unsuccessful ones carry
// only a diagnostic: `failed` (SDK/RPC error) or `skipped` (vault empty or under
// threshold). Those are pure churn, and a persistent failure loop mints them at
// the cron's cadence: a PumpAgent argument-order bug produced 228k `failed` rows
// (~40k/day, 59 MB) between 2026-06-15 and 2026-07-10 before anyone noticed,
// because a failing run recorded itself instead of alerting.
//
// Prune only the diagnostic rows, on the self-tightening firehose window. Rows
// with a tx_signature are never touched, so no burn or payout record is lost.
const RUN_LOG_TABLES = [
	{ table: 'pump_buyback_runs', tsColumn: 'created_at' },
	{ table: 'pump_distribute_runs', tsColumn: 'created_at' },
];

function clampInt(raw, min, max, dflt) {
	const n = Number.parseInt(String(raw ?? ''), 10);
	if (!Number.isFinite(n)) return dflt;
	return Math.min(max, Math.max(min, n));
}

async function dbSizeMb() {
	const [{ mb }] = await sql`SELECT (pg_database_size(current_database()) / 1048576.0)::int AS mb`;
	return Number(mb) || 0;
}

async function tableExists(name) {
	const [{ reg }] = await sql`SELECT to_regclass(${'public.' + name}) AS reg`;
	return reg != null;
}

// ── A. Firehose retention (cascade prune older than cutoffDays) ───────────────
async function pruneFirehose(cutoffDays) {
	if (!(await tableExists('pump_coin_intel'))) return { mints: 0, perTable: {}, liveSatellites: [] };

	// Resolve satellite existence once (a fresh deploy may not have every table).
	const liveSatellites = [];
	for (const t of FIREHOSE_SATELLITES) {
		if (await tableExists(t)) liveSatellites.push(t);
	}

	const perTable = {};
	let totalMints = 0;
	const maxBatches = Math.ceil(MAX_MINTS_PER_RUN / MINT_BATCH);
	for (let i = 0; i < maxBatches; i++) {
		const olds = await sql`
			SELECT mint FROM pump_coin_intel
			WHERE first_seen_at < now() - ${cutoffDays} * interval '1 day'
			LIMIT ${MINT_BATCH}
		`;
		if (!olds.length) break;
		const mints = olds.map((r) => r.mint);

		for (const t of liveSatellites) {
			// t is a fixed constant from FIREHOSE_SATELLITES — safe to splice; the
			// mint list is bound as $1. DELETE settles xmax in place (no file
			// extension), so it works even at the cap.
			const del = await sql(`DELETE FROM ${t} WHERE mint = ANY($1) RETURNING mint`, [mints]);
			perTable[t] = (perTable[t] || 0) + del.length;
		}
		const delIntel = await sql`DELETE FROM pump_coin_intel WHERE mint = ANY(${mints}) RETURNING mint`;
		perTable['pump_coin_intel'] = (perTable['pump_coin_intel'] || 0) + delIntel.length;

		totalMints += mints.length;
		if (olds.length < MINT_BATCH) break;
	}
	return { mints: totalMints, perTable, liveSatellites };
}

// ── A2. Orphaned-satellite sweep ──────────────────────────────────────────────
// The cascade prune only deletes satellite rows for mints it selects FROM
// pump_coin_intel — satellite rows whose master row is already gone (written
// after the master was pruned, or from a partial historical run) leak forever.
// Sweep them with a bounded anti-join per satellite. DELETE settles xmax in
// place, so this too is safe at the cap.
async function pruneOrphanedSatellites(liveSatellites) {
	if (!(await tableExists('pump_coin_intel'))) return {};
	const perTable = {};
	for (const t of liveSatellites) {
		const del = await sql(
			`DELETE FROM ${t} WHERE mint IN (
				SELECT s.mint FROM ${t} s
				LEFT JOIN pump_coin_intel p ON p.mint = s.mint
				WHERE p.mint IS NULL
				LIMIT $1
			) RETURNING mint`,
			[ORPHAN_BATCH],
		);
		if (del.length > 0) perTable[t] = del.length;
	}
	return perTable;
}

// ── A3. Time-keyed series retention ───────────────────────────────────────────
async function pruneTimeSeries(cutoffs) {
	const perTable = {};
	for (const { table, tsColumn, windowKind } of TIME_SERIES_TABLES) {
		if (!(await tableExists(table))) continue;
		const cutoffDays = cutoffs[windowKind];
		let deleted = 0;
		const maxBatches = Math.ceil(SERIES_MAX_PER_RUN / SERIES_BATCH);
		for (let i = 0; i < maxBatches; i++) {
			// table/tsColumn are fixed constants from TIME_SERIES_TABLES; only the
			// numeric bounds are parameters. Bounded subselect + DELETE works at cap.
			const del = await sql(
				`DELETE FROM ${table} WHERE ctid IN (
					SELECT ctid FROM ${table}
					WHERE ${tsColumn} < now() - $1 * interval '1 day'
					LIMIT $2
				) RETURNING 1`,
				[cutoffDays, SERIES_BATCH],
			);
			deleted += del.length;
			if (del.length < SERIES_BATCH) break;
		}
		if (deleted > 0) perTable[table] = deleted;
	}
	return perTable;
}

// ── A4. Autopilot run-log retention (diagnostic rows only) ────────────────────
// Deletes `failed`/`skipped` rows past the firehose window. `tx_signature IS
// NULL` is belt-and-braces: a row that somehow reached a terminal-diagnostic
// status while still carrying a signature keeps its on-chain record.
async function pruneRunLogs(cutoffDays) {
	const perTable = {};
	for (const { table, tsColumn } of RUN_LOG_TABLES) {
		if (!(await tableExists(table))) continue;
		let deleted = 0;
		const maxBatches = Math.ceil(SERIES_MAX_PER_RUN / SERIES_BATCH);
		for (let i = 0; i < maxBatches; i++) {
			// table/tsColumn are fixed constants from RUN_LOG_TABLES; only the numeric
			// bounds are parameters. Bounded subselect + DELETE works at cap.
			const del = await sql(
				`DELETE FROM ${table} WHERE ctid IN (
					SELECT ctid FROM ${table}
					WHERE ${tsColumn} < now() - $1 * interval '1 day'
					  AND status IN ('failed', 'skipped')
					  AND tx_signature IS NULL
					LIMIT $2
				) RETURNING 1`,
				[cutoffDays, SERIES_BATCH],
			);
			deleted += del.length;
			if (del.length < SERIES_BATCH) break;
		}
		if (deleted > 0) perTable[table] = deleted;
	}
	return perTable;
}

// ── Storage visibility ────────────────────────────────────────────────────────
// When the branch is pinned above the high-water mark, the single most useful
// diagnostic is WHERE the space lives. Report the largest relations so the ops
// alert (and the cron's JSON body) names the offenders instead of just the total.
async function topRelationsBySize(limit = 15) {
	try {
		const rows = await sql`
			SELECT relname AS table, (pg_total_relation_size(c.oid) / 1048576.0)::numeric(10,1) AS mb
			FROM pg_class c
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = 'public' AND c.relkind = 'r'
			ORDER BY pg_total_relation_size(c.oid) DESC
			LIMIT ${limit}
		`;
		return rows.map((r) => ({ table: r.table, mb: Number(r.mb) }));
	} catch {
		return []; // visibility is best-effort — never fails the prune
	}
}

// ── B2. x402 payment audit-log retention ──────────────────────────────────────
// The payment audit ledger (x402_audit_log) grows one row per paid request on hot
// routes (e.g. /api/x402/dance-tip). Unbounded it both marches toward the storage
// cap and slows every dashboard aggregate (getPaymentStats full-scans it). Keep a
// generous window — long enough for revenue reporting — then prune by created_at,
// which the table's (event_type, created_at) indexes make cheap. Kept far longer
// than the intel firehose because these are money records, not churn; it tightens
// to a floor only under storage pressure via the shared valve.
const AUDIT_BATCH = 5000;
const AUDIT_MAX_PER_RUN = 100_000;

async function pruneAuditLog(cutoffDays) {
	if (!(await tableExists('x402_audit_log'))) return { deleted: 0 };

	let deleted = 0;
	const maxBatches = Math.ceil(AUDIT_MAX_PER_RUN / AUDIT_BATCH);
	for (let i = 0; i < maxBatches; i++) {
		// DELETE settles xmax in place (no file extension), so it works even at the
		// cap. Bounded subselect so a single statement never scans the whole table.
		const del = await sql`
			DELETE FROM x402_audit_log
			WHERE id IN (
				SELECT id FROM x402_audit_log
				WHERE created_at < now() - ${cutoffDays} * interval '1 day'
				LIMIT ${AUDIT_BATCH}
			) RETURNING id
		`;
		deleted += del.length;
		if (del.length < AUDIT_BATCH) break;
	}
	return { deleted };
}

// ── B. avatar_regen_jobs hygiene ──────────────────────────────────────────────
async function pruneRegenJobs() {
	if (!(await tableExists('avatar_regen_jobs'))) return { stripped: 0, deleted: 0 };

	// Delete terminal jobs past 30 days first (DELETE frees space without
	// extending a file, so it is safe even under storage pressure).
	let deleted = 0;
	for (let i = 0; i < REGEN_MAX_ITERS; i++) {
		const del = await sql`
			DELETE FROM avatar_regen_jobs
			WHERE job_id IN (
				SELECT job_id FROM avatar_regen_jobs
				WHERE status IN ('done', 'failed') AND created_at < now() - interval '30 days'
				LIMIT ${REGEN_DELETE_BATCH}
			) RETURNING job_id
		`;
		deleted += del.length;
		if (del.length < REGEN_DELETE_BATCH) break;
	}

	// Strip the multi-MB base64 source images from terminal jobs older than a day —
	// never read for a finished job. This is an UPDATE (rewrites the row), so it can
	// need to extend a file; if the branch is at the cap the DELETE prune above will
	// have freed space, but guard anyway so a capacity blip degrades to "skip the
	// strip this tick" rather than failing the whole cron.
	let stripped = 0;
	try {
		for (let i = 0; i < REGEN_MAX_ITERS; i++) {
			const upd = await sql`
				UPDATE avatar_regen_jobs
				SET params = (params - 'images') - 'image', updated_at = now()
				WHERE job_id IN (
					SELECT job_id FROM avatar_regen_jobs
					WHERE status IN ('done', 'failed')
					  AND created_at < now() - interval '1 day'
					  AND (params ? 'images' OR params ? 'image')
					LIMIT ${REGEN_STRIP_BATCH}
				) RETURNING job_id
			`;
			stripped += upd.length;
			if (upd.length < REGEN_STRIP_BATCH) break;
		}
	} catch (err) {
		if (!isDbCapacityError(err)) throw err;
	}
	return { stripped, deleted };
}

// ── D. Bounded compaction under storage pressure ──────────────────────────────
// Every table this cron manages is a compaction candidate; nothing outside the
// retention set is ever rewritten (a VACUUM FULL on a hot product table would
// block its writers behind an exclusive lock).
const COMPACT_CANDIDATES = [
	'pump_coin_intel',
	...FIREHOSE_SATELLITES,
	...TIME_SERIES_TABLES.map((t) => t.table),
	...RUN_LOG_TABLES.map((t) => t.table),
	'x402_audit_log',
	'avatar_regen_jobs',
];

/**
 * Pure target selection so the bounds are unit-testable. Keeps tables whose
 * reclaimable space clears both the absolute and the ratio floor, orders them
 * smallest file first (each rewrite needs headroom ≈ live size, so free the
 * cheap space before attempting the big files near a hard cap), and caps how
 * many one tick may rewrite.
 *
 * @param {object} a
 * @param {Array<{table:string, tableMb:number, freeMb:number}>} a.candidates
 * @param {number} a.minFreeMb
 * @param {number} a.minFreeRatio
 * @param {number} a.maxTables
 */
export function pickCompactionTargets({ candidates, minFreeMb, minFreeRatio, maxTables }) {
	return candidates
		.filter(
			(c) =>
				c.tableMb > 0 &&
				c.freeMb >= minFreeMb &&
				c.freeMb / c.tableMb >= minFreeRatio,
		)
		.sort((a, b) => a.tableMb - b.tableMb)
		.slice(0, Math.max(0, maxTables));
}

// Measure reclaimable space per candidate and VACUUM FULL the picks. Wholly
// best-effort: pgstattuple missing, a lock we can't get, or a rewrite failing
// mid-tick degrades to "less compacted this tick", never a failed cron.
async function compactTables({ minFreeMb, maxTables }) {
	const result = { measured: 0, compacted: [], skipped: [] };
	try {
		// Idempotent; Neon ships pgstattuple as an installable extension.
		await sql`CREATE EXTENSION IF NOT EXISTS pgstattuple`;
	} catch (err) {
		result.skipped.push({ reason: 'pgstattuple_unavailable', detail: err?.message?.slice(0, 120) });
		return result;
	}

	const candidates = [];
	for (const t of COMPACT_CANDIDATES) {
		if (!(await tableExists(t))) continue;
		try {
			// t is a fixed constant from the retention config above, safe to splice.
			const [r] = await sql(`SELECT * FROM pgstattuple_approx('public.${t}'::regclass)`);
			candidates.push({
				table: t,
				tableMb: Number(r.table_len) / 1048576,
				freeMb: (Number(r.approx_free_space) + Number(r.dead_tuple_len)) / 1048576,
			});
		} catch {
			/* a table we cannot measure is a table we do not rewrite */
		}
	}
	result.measured = candidates.length;

	const targets = pickCompactionTargets({
		candidates,
		minFreeMb,
		minFreeRatio: COMPACT_MIN_FREE_RATIO,
		maxTables,
	});
	for (const target of targets) {
		const t0 = Date.now();
		try {
			await sql(`VACUUM FULL ${target.table}`);
			const [after] = await sql(
				`SELECT (pg_total_relation_size('${target.table}') / 1048576.0)::numeric(10,1) AS mb`,
			);
			result.compacted.push({
				table: target.table,
				before_mb: Math.round(target.tableMb),
				after_mb: Number(after.mb),
				took_ms: Date.now() - t0,
			});
		} catch (err) {
			result.skipped.push({ table: target.table, reason: err?.message?.slice(0, 120) });
		}
	}
	return result;
}

// ── C. Best-effort VACUUM of the tables we pruned ─────────────────────────────
async function vacuumTables(names) {
	for (const t of names) {
		try {
			// Plain VACUUM (never FULL): FULL rewrites the whole table into a fresh
			// file, needing free space ≈ the table's live size — the one thing we lack
			// near the cap. Plain VACUUM marks dead tuples reusable and lets Neon's
			// storage GC return the space. Single-statement over the HTTP driver runs
			// in autocommit, so VACUUM's no-transaction rule is satisfied.
			await sql(`VACUUM ${t}`);
		} catch {
			/* best-effort — reclaim happens on the next autovacuum regardless */
		}
	}
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const started = Date.now();
	const retentionDays = clampInt(process.env.PUMP_INTEL_RETENTION_DAYS, 2, 365, 14);
	const minDays = clampInt(process.env.PUMP_INTEL_MIN_RETENTION_DAYS, 1, retentionDays, 3);
	const highWaterMb = clampInt(process.env.DB_RETENTION_HIGH_WATER_MB, 128, 100_000, 470);
	// Audit ledger keeps its own, longer window (money records): default 90 days,
	// tightening to a 30-day floor while the branch is over the high-water mark.
	const auditDays = clampInt(process.env.X402_AUDIT_RETENTION_DAYS, 7, 3650, 90);
	const auditMinDays = clampInt(process.env.X402_AUDIT_MIN_RETENTION_DAYS, 1, auditDays, 30);
	// Spent-payment proofs: 90 days, FIXED. No pressure-tightened floor — a
	// shorter window is a shorter replay-protection window, and the rows are too
	// small to matter for storage. The 30-day lower bound stops a typo'd env var
	// from silently shrinking the guard to hours.
	const spentDays = clampInt(process.env.X402_SPENT_RETENTION_DAYS, 30, 3650, 90);

	const sizeBeforeMb = await dbSizeMb();
	const underPressure = sizeBeforeMb >= highWaterMb;
	// Self-healing valve: tighten the window to the floor while the branch is over
	// the high-water mark, so the cap is never actually reached; relax to the full
	// window once GC has returned the freed space and size drops back under it.
	const cutoffDays = underPressure ? minDays : retentionDays;
	const auditCutoffDays = underPressure ? auditMinDays : auditDays;

	const firehose = await pruneFirehose(cutoffDays);
	const orphans = await pruneOrphanedSatellites(firehose.liveSatellites);
	const series = await pruneTimeSeries({
		firehose: cutoffDays,
		audit: auditCutoffDays,
		spent: spentDays,
	});
	const runLogs = await pruneRunLogs(cutoffDays);
	const audit = await pruneAuditLog(auditCutoffDays);
	const regen = await pruneRegenJobs();
	// E. Per-home action-log retention. Best-effort: the home tables may not exist
	// on a branch that has not run the Home migrations, and a failure here must
	// not cost the platform its storage sweep.
	let homeActionLog = { deleted: 0, batches: 0, homes: 0 };
	if (await tableExists('home_action_log')) {
		try {
			homeActionLog = await purgeExpiredActionLog();
		} catch (err) {
			homeActionLog = { deleted: 0, batches: 0, homes: 0, error: err?.message?.slice(0, 160) };
		}
	}

	// VACUUM only tables we actually deleted from this tick.
	const touched = Object.keys(firehose.perTable).filter((t) => firehose.perTable[t] > 0);
	for (const t of Object.keys(orphans)) if (!touched.includes(t)) touched.push(t);
	for (const t of Object.keys(series)) if (!touched.includes(t)) touched.push(t);
	for (const t of Object.keys(runLogs)) if (!touched.includes(t)) touched.push(t);
	if (audit.deleted > 0) touched.push('x402_audit_log');
	if (regen.deleted > 0 || regen.stripped > 0) touched.push('avatar_regen_jobs');
	if (homeActionLog.deleted > 0) touched.push('home_action_log');
	await vacuumTables(touched);

	// D. Under pressure, actually shrink the files (plain VACUUM cannot) so the
	// storage gate unlatches. Off-switch and bounds are env-tunable.
	let compaction = { measured: 0, compacted: [], skipped: [] };
	const compactEnabled = process.env.DB_COMPACT_ENABLED !== '0';
	if (underPressure && compactEnabled) {
		compaction = await compactTables({
			minFreeMb: clampInt(process.env.DB_COMPACT_MIN_FREE_MB, 1, 10_000, COMPACT_MIN_FREE_MB),
			maxTables: clampInt(process.env.DB_COMPACT_MAX_TABLES, 0, 20, COMPACT_MAX_TABLES),
		});
	}

	const sizeAfterMb = await dbSizeMb();
	const topTables = await topRelationsBySize();

	// One deduped signal when the valve engages so ops knows storage is tight and a
	// Neon plan bump (for a longer history window) is worth considering. Neon's GC
	// is not instant, so sizeAfter may still read high right after a prune — that's
	// expected; the space returns within the branch's history-retention window.
	if (underPressure) {
		const seriesDeleted = Object.values(series).reduce((a, b) => a + b, 0);
		const orphansDeleted = Object.values(orphans).reduce((a, b) => a + b, 0);
		const runLogsDeleted = Object.values(runLogs).reduce((a, b) => a + b, 0);
		const topLine = topTables
			.slice(0, 5)
			.map((t) => `${t.table} ${t.mb}MB`)
			.join(', ');
		const compactLine = compaction.compacted.length
			? ` Compacted: ${compaction.compacted.map((c) => `${c.table} ${c.before_mb}→${c.after_mb}MB`).join(', ')}.`
			: '';
		sendOpsAlert(
			'db retention pressure valve engaged',
			`db ${sizeBeforeMb}MB ≥ high-water ${highWaterMb}MB, tightened firehose retention to ${minDays}d; pruned ${firehose.mints} mints, ${seriesDeleted} series rows, ${runLogsDeleted} autopilot run-log rows, ${orphansDeleted} orphaned satellite rows.${compactLine} Largest tables: ${topLine || 'n/a'}. Raise the Neon storage plan (or DB_RETENTION_HIGH_WATER_MB / PUMP_INTEL_RETENTION_DAYS) for a longer window.`,
			{ signature: 'db:retention-pressure' },
		);
	}

	return json(res, 200, {
		ok: true,
		size_before_mb: sizeBeforeMb,
		size_after_mb: sizeAfterMb,
		high_water_mb: highWaterMb,
		under_pressure: underPressure,
		retention_days: retentionDays,
		cutoff_days: cutoffDays,
		audit_retention_days: auditDays,
		audit_cutoff_days: auditCutoffDays,
		spent_retention_days: spentDays,
		firehose: { mints: firehose.mints, perTable: firehose.perTable },
		orphans,
		series,
		run_logs: runLogs,
		audit,
		regen,
		home_action_log: homeActionLog,
		vacuumed: touched,
		compaction,
		top_tables: topTables,
		took_ms: Date.now() - started,
	});
});
