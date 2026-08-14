// $THREE holder snapshot — the cached read/write layer behind the public holder
// leaderboard, its OG share card, and the token stats panel.
//
// Why this exists: those three public surfaces each used to call
// fetchHolderBalances({ mint: THREE_MINT }) directly — a full Helius DAS
// `getTokenAccounts` walk of EVERY $THREE holder — on every edge-cache miss. That
// recomputed a slowly-changing set on web/bot traffic, so DAS credit burn scaled
// with page views (and the OG card amplified it: every crawler/unfurl that missed
// cache triggered a full scan). This module flips that around: a single cron
// (api/cron/three-holders-snapshot.js) runs ONE scan every few minutes and writes
// the result to three_holder_snapshot; the public reads serve from that snapshot
// for the cost of a single DB query.
//
// threeHolderBalances() returns the exact same Map<wallet, bigint> shape that
// fetchHolderBalances() returns, so call sites swap their data source in one line
// and every downstream derivation (ranking, tiers, % of supply) is untouched.

import { sql } from '../db.js';
import { TOKEN_MINT as THREE_MINT } from '../token/config.js';
import { fetchHolderBalances } from './holders.js';
import { jupiterTokenSearch } from '../token/jupiter.js';
import { acquireLock, releaseLock, cacheGet, cacheSet } from '../cache.js';

const UPSERT_CHUNK = 2000; // rows per batched upsert — mirrors persistHolderSnapshot
// A snapshot older than this is treated as missing: the reader falls back to a
// live scan so a stalled cron degrades to "slightly more expensive" rather than
// "serving hours-old holder data". The cron runs every 5m, so 30m tolerates a few
// missed ticks before falling back.
const MAX_SNAPSHOT_AGE_MS = 30 * 60_000;

let _ensured = null;
function ensureTables() {
	if (_ensured) return _ensured;
	_ensured = (async () => {
		await sql`
			create table if not exists three_holder_snapshot (
				wallet      text primary key,
				balance     bigint not null,
				updated_at  timestamptz not null default now(),
				-- When this wallet's CONTINUOUS hold of $THREE began. Set on first
				-- insert and preserved across refreshes; a wallet that fully exits is
				-- hard-deleted, so re-entry honestly restarts the clock. Powers the
				-- holding-duration component of the agent reputation score.
				held_since  timestamptz not null default now()
			)
		`;
		// Existing deployments: add the column and backfill conservatively to "now"
		// — we never fabricate a holding history we can't prove from real snapshots.
		await sql`alter table three_holder_snapshot add column if not exists held_since timestamptz`;
		await sql`update three_holder_snapshot set held_since = coalesce(held_since, updated_at, now()) where held_since is null`;
		await sql`
			create index if not exists three_holder_snapshot_balance_idx
				on three_holder_snapshot (balance desc)
		`;
		await sql`
			create table if not exists three_holder_snapshot_meta (
				id           smallint primary key default 1,
				snapshot_at  timestamptz,
				holder_count integer not null default 0
			)
		`;
		await sql`
			insert into three_holder_snapshot_meta (id, snapshot_at, holder_count)
			values (1, null, 0)
			on conflict (id) do nothing
		`;
		return true;
	})().catch((err) => {
		_ensured = null; // allow a retry on the next call
		throw err; // surface the original error — callers log it in their context
	});
	return _ensured;
}

/**
 * Run a full $THREE holder scan and atomically refresh the snapshot table.
 * Called by the cron only. Returns { holders, scannedAt } for logging.
 *
 * ensureTables() is preflighted here so a DB-down condition aborts BEFORE
 * the expensive Helius DAS scan — avoiding wasted API credits every cron tick
 * when the database is unreachable.
 */
export async function refreshThreeHolderSnapshot() {
	await ensureTables();
	const balances = await fetchHolderBalances({ mint: THREE_MINT });
	return persistThreeHolderSnapshot(balances);
}

/**
 * Persist an already-scanned Map<wallet, bigint> to the snapshot table. Split out
 * of refreshThreeHolderSnapshot so the cold-fallback read path can reuse a single
 * scan for BOTH the response and self-healing the cache — never scanning twice.
 */
export async function persistThreeHolderSnapshot(balances) {
	await ensureTables();

	const wallets = [...balances.keys()].filter((w) => balances.get(w) > 0n);
	const now = new Date();

	// Batched multi-row upsert via unnest — one round-trip per chunk instead of
	// one per holder (thousands of serial Neon HTTP calls otherwise).
	for (let i = 0; i < wallets.length; i += UPSERT_CHUNK) {
		const chunk = wallets.slice(i, i + UPSERT_CHUNK);
		const balanceStrs = chunk.map((w) => balances.get(w).toString());
		await sql`
			insert into three_holder_snapshot (wallet, balance, updated_at, held_since)
			select u.wallet, u.balance, ${now}, ${now}
			from unnest(${chunk}::text[], ${balanceStrs}::bigint[]) as u(wallet, balance)
			on conflict (wallet) do update set
				balance = excluded.balance,
				updated_at = excluded.updated_at
				-- held_since is intentionally NOT touched on update: it marks the start
				-- of the wallet's UNBROKEN hold, so a continuing holder keeps accruing
				-- duration while a wallet that exited (deleted below) and returned starts
				-- fresh on its re-insert above.
		`;
	}

	// Hard-delete wallets that fully exited since the last snapshot — this is a
	// pure cache, so there's no accrual to preserve (unlike coin_holders). Neon's
	// HTTP client expands arrays into Postgres params, so use `<> all(...)`.
	if (wallets.length > 0) {
		await sql`
			delete from three_holder_snapshot
			where not (wallet = any(${wallets}))
		`;
	} else {
		// An empty scan almost certainly means Helius was unreachable, not that
		// $THREE has zero holders — never wipe a good snapshot on a bad scan.
		throw new Error('holder scan returned 0 holders — refusing to wipe snapshot');
	}

	await sql`
		update three_holder_snapshot_meta
		set snapshot_at = ${now}, holder_count = ${wallets.length}
		where id = 1
	`;

	return { holders: wallets.length, scannedAt: now.toISOString() };
}

/**
 * Read the cached snapshot as a Map<wallet, bigint>. Returns null when there is
 * no fresh snapshot (table missing, never populated, or older than
 * MAX_SNAPSHOT_AGE_MS) so the caller can fall back to a live scan.
 */
export async function readThreeHolderSnapshot({ allowStale = false } = {}) {
	let meta;
	try {
		[meta] = await sql`select snapshot_at, holder_count from three_holder_snapshot_meta where id = 1`;
	} catch {
		// Table not created yet (migration pending on a fresh deploy) — signal the
		// caller to live-scan rather than erroring the public read.
		return null;
	}
	if (!meta?.snapshot_at) return null;
	const ageMs = Date.now() - new Date(meta.snapshot_at).getTime();
	// `allowStale` is the degraded path: when a cold-fallback live scan can't finish
	// inside the request budget, serving an hours-old snapshot beats blocking to a
	// 504. The freshness gate still applies to the normal read.
	if (!allowStale && ageMs > MAX_SNAPSHOT_AGE_MS) return null;

	const rows = await sql`select wallet, balance from three_holder_snapshot`;
	const balances = new Map();
	for (const r of rows) {
		// Neon returns bigint columns as strings to preserve precision.
		balances.set(r.wallet, BigInt(r.balance));
	}
	return balances.size > 0 ? balances : null;
}

/**
 * Cheap holder *count* for the public stats panel. Reads only the snapshot meta
 * row (one query, no balance rows) so the hot, edge-cached /api/three-token/stats
 * path never triggers the multi-second DAS walk that threeHolderBalances() can.
 * Returns null only when neither our snapshot nor the keyless fallback answers,
 * so the caller renders a blank figure rather than a wrong one.
 */
export async function threeHolderCount() {
	try {
		const [meta] = await sql`
			select snapshot_at, holder_count from three_holder_snapshot_meta where id = 1
		`;
		if (meta?.snapshot_at) {
			const ageMs = Date.now() - new Date(meta.snapshot_at).getTime();
			const n = Number(meta.holder_count);
			if (ageMs <= MAX_SNAPSHOT_AGE_MS && Number.isFinite(n) && n > 0) return n;
		}
	} catch {
		// Table not migrated yet / DB blip: fall through to the keyless rung.
	}
	return jupiterThreeHolderCount();
}

// Keyless holder-count rung, used whenever our own snapshot is missing or stale.
//
// Why it exists: the snapshot is refreshed by a Helius DAS walk
// (api/cron/three-holders-snapshot.js), so an exhausted Helius quota freezes it.
// The staleness gate above then correctly refuses the frozen number, and every
// public surface that shows holders went blank indefinitely rather than for a
// tick or two. Jupiter's token search carries a holderCount for any mint and
// needs no key, so it keeps the figure real through a DAS outage instead of
// blanking it. Deliberately NOT a substitute for the snapshot: it is a single
// count with no per-wallet balances, so ranking and %-of-supply still come from
// the snapshot alone.
const JUP_HOLDERS_KEY = 'three:holders:jup-count';
const JUP_HOLDERS_TTL_S = 300;
const JUP_HOLDERS_TIMEOUT_MS = 4000;

async function jupiterThreeHolderCount() {
	try {
		const cached = await cacheGet(JUP_HOLDERS_KEY);
		if (Number.isFinite(cached?.count) && cached.count > 0) return cached.count;
	} catch {
		// Cache miss/outage just means we ask Jupiter directly.
	}
	try {
		const rows = await jupiterTokenSearch(THREE_MINT, {
			limit: 1,
			signal: AbortSignal.timeout(JUP_HOLDERS_TIMEOUT_MS),
		});
		const row = rows.find((r) => r?.id === THREE_MINT) || rows[0];
		const count = Number(row?.holderCount);
		if (!Number.isFinite(count) || count <= 0) return null;
		await cacheSet(JUP_HOLDERS_KEY, { count }, JUP_HOLDERS_TTL_S).catch(() => {});
		return count;
	} catch {
		// Upstream down or throttled: unknown beats a fabricated number.
		return null;
	}
}

// Cross-instance lock + TTL for the cold-fallback scan. The full DAS walk takes
// several seconds; 90s is comfortably longer so a slow scan keeps the lock, and
// it auto-expires if the holder's lambda dies mid-scan.
const COLD_SCAN_LOCK_KEY = 'three:holders:coldscan';
const COLD_SCAN_LOCK_TTL = 90;
// How long a public READ will wait on the cold-fallback DAS walk before degrading
// to a stale snapshot. A full walk can take tens of seconds (well past the public
// endpoints' function budget → 504); cap the wait so the request always returns
// fast while the scan keeps running in the background to self-heal the snapshot.
const COLD_SCAN_READ_BUDGET_MS = 18_000;
const SCAN_DEADLINE = Symbol('threeHolderScanDeadline');
// In-process single-flight: coalesce concurrent cold scans within ONE warm
// lambda so a burst of cache-miss requests on the same instance shares one scan.
let _inflightColdScan = null;

/**
 * The drop-in replacement for fetchHolderBalances({ mint: THREE_MINT }) on public
 * read paths: serve the cached snapshot, falling back to a single live scan only
 * on a cold start (snapshot missing/stale). Same Map<wallet, bigint> shape, so
 * callers' downstream ranking/tier/percentage logic is unchanged.
 *
 * The cold fallback is stampede-guarded. Without it, a traffic spike against a
 * missing/stale snapshot (cold deploy, or a stalled cron) had EVERY uncached
 * request to the leaderboard, token stats, and OG card independently fire a full
 * multi-second Helius DAS walk — N concurrent scans burning credits. Now: an
 * in-process single-flight collapses concurrent callers on one instance, and a
 * cross-instance Redis lock ensures only one lambda platform-wide runs the scan
 * — and the winner refreshes the shared snapshot so the fallback self-heals and
 * everyone else reads from cache.
 */
export async function threeHolderBalances() {
	const snap = await readThreeHolderSnapshot();
	if (snap) return snap;
	// Cold/stale snapshot: run at most one guarded scan, shared across callers. But
	// never let the REQUEST block on it past the read budget — a full DAS walk can
	// exceed the function's maxDuration and 504. The scan runs to completion in the
	// background (self-healing the snapshot); this read degrades to the most recent
	// stale snapshot, or an empty map only on a truly cold first deploy.
	if (!_inflightColdScan) {
		_inflightColdScan = coldFallbackScan().finally(() => { _inflightColdScan = null; });
	}
	const scan = _inflightColdScan;
	let timer;
	const budget = new Promise((resolve) => {
		timer = setTimeout(() => resolve(SCAN_DEADLINE), COLD_SCAN_READ_BUDGET_MS);
	});
	const result = await Promise.race([scan.catch(() => SCAN_DEADLINE), budget]).finally(() => clearTimeout(timer));
	if (result && result !== SCAN_DEADLINE) return result;
	const stale = await readThreeHolderSnapshot({ allowStale: true }).catch(() => null);
	return stale || new Map();
}

/**
 * $THREE holding for a SINGLE wallet, straight from the cached snapshot — one
 * indexed primary-key lookup, no Helius walk. Used by the agent reputation engine
 * to score the $THREE-conviction pillar (balance held + continuous duration)
 * without adding an RPC read per agent. Returns zero/null for a wallet that holds
 * no $THREE (absent from the snapshot) so callers degrade honestly.
 *
 * @param {string} wallet base58 Solana address
 * @returns {Promise<{ balance: bigint, heldSince: Date|null }>}
 */
export async function threeHoldingFor(wallet) {
	if (!wallet) return { balance: 0n, heldSince: null };
	let row;
	try {
		[row] = await sql`
			select balance, held_since from three_holder_snapshot where wallet = ${wallet} limit 1
		`;
	} catch {
		// Snapshot table not migrated yet / DB blip — treat as "unknown, holds none"
		// rather than erroring the score computation.
		return { balance: 0n, heldSince: null };
	}
	if (!row) return { balance: 0n, heldSince: null };
	return {
		balance: BigInt(row.balance),
		heldSince: row.held_since ? new Date(row.held_since) : null,
	};
}

async function coldFallbackScan() {
	const gotLock = await acquireLock(COLD_SCAN_LOCK_KEY, COLD_SCAN_LOCK_TTL);
	if (!gotLock) {
		// Another instance is scanning. Wait briefly for it to refresh the snapshot,
		// then serve from cache. If it never appears (slow/dead holder), scan
		// ourselves rather than hanging the request.
		for (let i = 0; i < 12; i++) {
			await new Promise((r) => setTimeout(r, 500));
			const snap = await readThreeHolderSnapshot();
			if (snap) return snap;
		}
		return fetchHolderBalances({ mint: THREE_MINT });
	}
	try {
		// Winner: one live scan serves this response AND self-heals the shared
		// snapshot, so subsequent reads hit cache instead of scanning. Persist is
		// fire-and-forget — a write failure (e.g. snapshot table not migrated yet)
		// must never break the page, and we never scan twice.
		const balances = await fetchHolderBalances({ mint: THREE_MINT });
		persistThreeHolderSnapshot(balances).catch((err) =>
			console.warn('[three-holders] cold snapshot persist failed:', err?.message || err),
		);
		return balances;
	} finally {
		await releaseLock(COLD_SCAN_LOCK_KEY);
	}
}
