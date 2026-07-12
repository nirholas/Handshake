// @ts-check
// api/_lib/economy-ledger.js
//
// The financial book of record for the economy master funding wallet
// (api/_lib/economy-master.js). Every sweep appends an append-only, hash-chained
// batch of rows to `economy_master_ledger`: one `transfer` row per SOL movement
// (with the signature, a running balance, and the USD value at the instant of the
// transfer), one `failed`/`blocked` row per rejected attempt, and one `sweep`
// heartbeat summary — so there is a durable, ordered, tamper-evident record of
// what left the wallet, to whom, when, why, and what it was worth.
//
// Tamper-evidence: each row's `entry_hash` = sha256(canonical fields | prev_hash),
// so the head commits the entire history (a Merkle-equivalent). Editing or
// deleting any historical row breaks the chain from that point; verifyChain()
// and the economy-reconcile cron detect the break and the gap.
//
// This module never throws into the money path: a DB stall drops the ledger batch
// (logged + surfaced), it never blocks or reverts a transfer that already landed.

import { createHash } from 'node:crypto';
import { sql } from './db.js';
import { withDbRetry } from './db-retry.js';
import { solPriceUsd } from './sol-price.js';

let _schemaReady = false;

/** Lazily create the ledger table (mirror of the migration) so a fresh env works. */
export async function ensureSchema() {
	if (_schemaReady) return;
	await withDbRetry(() => sql`
		CREATE TABLE IF NOT EXISTS economy_master_ledger (
			id                bigserial   PRIMARY KEY,
			seq               bigint      NOT NULL,
			ts                timestamptz NOT NULL,
			run_id            uuid,
			master_pubkey     text        NOT NULL,
			event             text        NOT NULL,
			target_name       text,
			target_pubkey     text,
			lamports          bigint,
			sol               numeric(20,9),
			sol_usd           numeric(20,6),
			usd_value         numeric(20,6),
			tx_signature      text,
			reason            text,
			master_sol_before numeric(20,9),
			master_sol_after  numeric(20,9),
			reserve_sol       numeric(20,9),
			run_cap_sol       numeric(20,9),
			per_topup_max_sol numeric(20,9),
			network           text        NOT NULL DEFAULT 'mainnet',
			detail            jsonb,
			prev_hash         text,
			entry_hash        text        NOT NULL
		)
	`);
	await withDbRetry(() => sql`
		CREATE UNIQUE INDEX IF NOT EXISTS economy_master_ledger_seq_idx
			ON economy_master_ledger (master_pubkey, seq)
	`);
	await withDbRetry(() => sql`
		CREATE INDEX IF NOT EXISTS economy_master_ledger_sig_idx
			ON economy_master_ledger (tx_signature)
	`);
	_schemaReady = true;
}

function sha256hex(s) {
	return createHash('sha256').update(s).digest('hex');
}

/**
 * Canonical hash of a ledger row given the prior row's hash. The field set is
 * fixed and order-stable — it commits the position (seq, ts), the movement
 * (event, target, lamports, signature), the resulting balance, and the prior
 * hash. verifyChain() recomputes exactly this, so any of these fields changing
 * after the fact is detectable.
 * @param {string} prevHash
 * @param {object} r
 * @returns {string}
 */
export function hashEntry(prevHash, r) {
	const payload = [
		r.seq,
		r.ts,
		r.master_pubkey,
		r.event,
		r.target_pubkey || '',
		r.lamports == null ? '' : String(r.lamports),
		r.tx_signature || '',
		r.reason || '',
		// master_sol_after is numeric(20,9). Canonicalize to a fixed 9-decimal
		// string so the WRITE side (which hashes the JS number, e.g. 0.30223827)
		// and the VERIFY side (which reads the DB's scale-9 string "0.302238270")
		// produce the SAME hash. Before this, `String(value)` dropped the JS
		// number's trailing zeros while Postgres kept them, so every row's content
		// hash mismatched — verifyChain broke at the first row and stopped, masking
		// it as a single "tamper at seq 5". Number().toFixed(9) is stable for both
		// a JS number and the DB decimal string.
		canonicalSol9(r.master_sol_after),
		prevHash || '',
	].join('|');
	return sha256hex(payload);
}

// Fixed 9-decimal canonical form for a SOL amount that round-trips a JS number
// and a Postgres numeric(_,9) string to the same string. Empty for null.
function canonicalSol9(v) {
	if (v == null || v === '') return '';
	const n = Number(v);
	return Number.isFinite(n) ? n.toFixed(9) : String(v);
}

function round9(n) {
	return Math.round(Number(n) * 1e9) / 1e9;
}
function round6(n) {
	return Math.round(Number(n) * 1e6) / 1e6;
}

/** Current chain head (highest seq) for a master, or null before genesis. */
export async function getHead(masterPubkey) {
	const rows = await withDbRetry(() => sql`
		SELECT seq, entry_hash FROM economy_master_ledger
		WHERE master_pubkey = ${masterPubkey}
		ORDER BY seq DESC LIMIT 1
	`);
	return rows[0] ? { seq: Number(rows[0].seq), entryHash: rows[0].entry_hash } : null;
}

/**
 * Append one sweep's worth of events to the ledger as a single hash-chained
 * batch. Pure-ish orchestration around DB writes; returns what it wrote.
 *
 * @param {object} args
 * @param {string} args.runId
 * @param {string} args.masterPubkey
 * @param {'mainnet'|'devnet'} [args.network]
 * @param {object} args.result   the object returned by sweepTopUps()
 * @param {{reserveSol?:number, runCapSol?:number, perTopupMaxSol?:number}} [args.caps]
 * @param {number} [args.now]    epoch ms (injectable for tests)
 * @returns {Promise<{written:number, seqFrom:number|null, seqTo:number|null, headHash:string|null, skippedWrite?:string}>}
 */
export async function recordSweep({ runId, masterPubkey, network = 'mainnet', result, caps = {}, now = Date.now() }) {
	await ensureSchema();
	const solUsd = round6((await solPriceUsd(now)) || 0);
	const rows = buildSweepRows({ masterPubkey, network, result, caps, solUsd, now });
	if (!rows.length) return { written: 0, seqFrom: null, seqTo: null, headHash: null };

	// Chain onto the current head. One retry if a concurrent writer took our seq.
	for (let attempt = 0; attempt < 2; attempt++) {
		const head = await getHead(masterPubkey);
		let seq = head ? head.seq : 0;
		let prevHash = head ? head.entryHash : '';
		const chained = rows.map((r, i) => {
			const row = { ...r, seq: seq + i + 1, prev_hash: prevHash, run_id: runId };
			row.entry_hash = hashEntry(prevHash, row);
			prevHash = row.entry_hash;
			return row;
		});
		try {
			for (const row of chained) await insertRow(row);
			return {
				written: chained.length,
				seqFrom: chained[0].seq,
				seqTo: chained[chained.length - 1].seq,
				headHash: prevHash,
			};
		} catch (err) {
			const conflict = /duplicate key|unique/i.test(err?.message || '');
			if (conflict && attempt === 0) continue; // re-read head and rebuild the chain
			console.error('[economy-ledger] recordSweep write failed', { runId, error: err?.message });
			return { written: 0, seqFrom: null, seqTo: null, headHash: null, skippedWrite: err?.message || 'write_failed' };
		}
	}
	return { written: 0, seqFrom: null, seqTo: null, headHash: null, skippedWrite: 'seq_conflict' };
}

/**
 * Turn a sweepTopUps() result into ordered ledger rows with a running balance.
 * Pure — no DB, no clock beyond the injected `now` — so it is unit-tested.
 * @returns {Array<object>}
 */
export function buildSweepRows({ masterPubkey, network = 'mainnet', result, caps = {}, solUsd = 0, now = Date.now() }) {
	const rows = [];
	const before = round9(result?.masterSol ?? 0);
	let running = before;
	const baseTs = now;
	let i = 0;
	const ts = () => new Date(baseTs + i++).toISOString();

	const common = {
		master_pubkey: masterPubkey,
		network,
		reserve_sol: caps.reserveSol ?? result?.reserveSol ?? null,
		run_cap_sol: caps.runCapSol ?? null,
		per_topup_max_sol: caps.perTopupMaxSol ?? null,
		master_sol_before: before,
	};

	for (const f of result?.funded || []) {
		const solAfter = round9(running - f.sol);
		rows.push({
			...common,
			ts: ts(),
			event: 'transfer',
			target_name: f.name,
			target_pubkey: f.pubkey,
			lamports: Math.round(f.sol * 1e9),
			sol: round9(f.sol),
			sol_usd: solUsd || null,
			usd_value: solUsd ? round6(f.sol * solUsd) : null,
			tx_signature: f.signature,
			reason: null,
			master_sol_after: solAfter,
			detail: null,
		});
		running = solAfter;
	}
	for (const f of result?.failed || []) {
		rows.push({
			...common,
			ts: ts(),
			event: 'failed',
			target_name: f.name,
			target_pubkey: f.pubkey,
			lamports: f.sol != null ? Math.round(f.sol * 1e9) : null,
			sol: f.sol != null ? round9(f.sol) : null,
			sol_usd: solUsd || null,
			usd_value: null,
			tx_signature: null,
			reason: f.reason || 'send_failed',
			master_sol_after: running,
			detail: null,
		});
	}
	for (const r of result?.rejected || []) {
		rows.push({
			...common,
			ts: ts(),
			event: 'blocked',
			target_name: r.name,
			target_pubkey: r.pubkey,
			lamports: null,
			sol: null,
			sol_usd: solUsd || null,
			usd_value: null,
			tx_signature: null,
			reason: r.reason || 'not_in_registry',
			master_sol_after: running,
			detail: null,
		});
	}
	// Heartbeat summary — always written, even on a no-op sweep, so a continuous
	// monitoring trail exists (regulatory "we watch this every 30 min" evidence).
	rows.push({
		...common,
		ts: ts(),
		event: 'sweep',
		target_name: null,
		target_pubkey: null,
		lamports: null,
		sol: round9(result?.spentSol ?? 0),
		sol_usd: solUsd || null,
		usd_value: solUsd ? round6((result?.spentSol ?? 0) * solUsd) : null,
		tx_signature: null,
		reason: result?.configured === false ? 'unconfigured' : null,
		master_sol_after: running,
		detail: {
			configured: result?.configured ?? false,
			funded: (result?.funded || []).length,
			failed: (result?.failed || []).length,
			blocked: (result?.rejected || []).length,
			skipped: result?.skipped || [],
			spent_sol: round9(result?.spentSol ?? 0),
			spendable_sol: result?.spendableSol ?? null,
		},
	});
	return rows;
}

/**
 * Append one consolidation sweep's events (api/_lib/economy-sweepback.js) to the
 * same hash chain: one `inflow` row per SOL return, one `inflow_token` row per
 * token transfer, `inflow_failed` for what didn't land, and a `sweepback`
 * summary. Inflows raise the running balance — the mirror image of recordSweep.
 *
 * @param {object} args
 * @param {string} args.runId
 * @param {string} args.masterPubkey
 * @param {'mainnet'|'devnet'} [args.network]
 * @param {object} args.result   the object returned by sweepBack()
 * @param {number} [args.now]    epoch ms (injectable for tests)
 * @returns {Promise<{written:number, seqFrom:number|null, seqTo:number|null, headHash:string|null, skippedWrite?:string}>}
 */
export async function recordSweepback({ runId, masterPubkey, network = 'mainnet', result, now = Date.now() }) {
	await ensureSchema();
	const solUsd = round6((await solPriceUsd(now)) || 0);
	const rows = buildSweepbackRows({ masterPubkey, network, result, solUsd, now });
	if (!rows.length) return { written: 0, seqFrom: null, seqTo: null, headHash: null };

	for (let attempt = 0; attempt < 2; attempt++) {
		const head = await getHead(masterPubkey);
		let seq = head ? head.seq : 0;
		let prevHash = head ? head.entryHash : '';
		const chained = rows.map((r, i) => {
			const row = { ...r, seq: seq + i + 1, prev_hash: prevHash, run_id: runId };
			row.entry_hash = hashEntry(prevHash, row);
			prevHash = row.entry_hash;
			return row;
		});
		try {
			for (const row of chained) await insertRow(row);
			return {
				written: chained.length,
				seqFrom: chained[0].seq,
				seqTo: chained[chained.length - 1].seq,
				headHash: prevHash,
			};
		} catch (err) {
			const conflict = /duplicate key|unique/i.test(err?.message || '');
			if (conflict && attempt === 0) continue; // re-read head and rebuild the chain
			console.error('[economy-ledger] recordSweepback write failed', { runId, error: err?.message });
			return { written: 0, seqFrom: null, seqTo: null, headHash: null, skippedWrite: err?.message || 'write_failed' };
		}
	}
	return { written: 0, seqFrom: null, seqTo: null, headHash: null, skippedWrite: 'seq_conflict' };
}

/**
 * Turn a sweepBack() result into ordered ledger rows with a rising running
 * balance. Pure — no DB, no clock beyond the injected `now` — so it is
 * unit-tested alongside buildSweepRows.
 * @returns {Array<object>}
 */
export function buildSweepbackRows({ masterPubkey, network = 'mainnet', result, solUsd = 0, now = Date.now() }) {
	const rows = [];
	const before = result?.masterSolBefore == null ? null : round9(result.masterSolBefore);
	let running = before ?? 0;
	const baseTs = now;
	let i = 0;
	const ts = () => new Date(baseTs + i++).toISOString();

	const common = {
		master_pubkey: masterPubkey,
		network,
		reserve_sol: null,
		run_cap_sol: null,
		per_topup_max_sol: null,
		master_sol_before: before,
	};

	for (const s of result?.sweptSol || []) {
		const solAfter = round9(running + s.sol);
		rows.push({
			...common,
			ts: ts(),
			event: 'inflow',
			target_name: s.name,
			target_pubkey: s.pubkey,
			lamports: Math.round(s.sol * 1e9),
			sol: round9(s.sol),
			sol_usd: solUsd || null,
			usd_value: solUsd ? round6(s.sol * solUsd) : null,
			tx_signature: s.signature,
			reason: null,
			master_sol_after: solAfter,
			detail: null,
		});
		running = solAfter;
	}
	for (const t of result?.sweptTokens || []) {
		rows.push({
			...common,
			ts: ts(),
			event: 'inflow_token',
			target_name: t.name,
			target_pubkey: t.pubkey,
			lamports: null,
			sol: null,
			sol_usd: solUsd || null,
			usd_value: null,
			tx_signature: t.signature,
			reason: null,
			master_sol_after: running,
			detail: { mint: t.mint, amount: t.amount, decimals: t.decimals },
		});
	}
	for (const f of result?.failed || []) {
		rows.push({
			...common,
			ts: ts(),
			event: 'inflow_failed',
			target_name: f.name,
			target_pubkey: f.pubkey,
			lamports: f.sol != null ? Math.round(f.sol * 1e9) : null,
			sol: f.sol != null ? round9(f.sol) : null,
			sol_usd: solUsd || null,
			usd_value: null,
			tx_signature: null,
			reason: f.reason || 'send_failed',
			master_sol_after: running,
			detail: null,
		});
	}
	// Summary — always written, even on a no-op sweep, so the consolidation trail
	// is as continuous as the funding trail.
	rows.push({
		...common,
		ts: ts(),
		event: 'sweepback',
		target_name: null,
		target_pubkey: null,
		lamports: null,
		sol: round9(result?.receivedSol ?? 0),
		sol_usd: solUsd || null,
		usd_value: solUsd ? round6((result?.receivedSol ?? 0) * solUsd) : null,
		tx_signature: null,
		reason: null,
		master_sol_after: result?.masterSolAfter == null ? running : round9(result.masterSolAfter),
		detail: {
			mode: result?.mode || 'excess',
			sol_transfers: (result?.sweptSol || []).length,
			token_transfers: (result?.sweptTokens || []).length,
			failed: (result?.failed || []).length,
			skipped: result?.skipped || [],
			received_sol: round9(result?.receivedSol ?? 0),
			master_sol_before: before,
			master_sol_after: result?.masterSolAfter == null ? null : round9(result.masterSolAfter),
		},
	});
	return rows;
}

async function insertRow(r) {
	await withDbRetry(() => sql`
		INSERT INTO economy_master_ledger
			(seq, ts, run_id, master_pubkey, event, target_name, target_pubkey,
			 lamports, sol, sol_usd, usd_value, tx_signature, reason,
			 master_sol_before, master_sol_after, reserve_sol, run_cap_sol,
			 per_topup_max_sol, network, detail, prev_hash, entry_hash)
		VALUES
			(${r.seq}, ${r.ts}, ${r.run_id}, ${r.master_pubkey}, ${r.event},
			 ${r.target_name}, ${r.target_pubkey}, ${r.lamports}, ${r.sol},
			 ${r.sol_usd}, ${r.usd_value}, ${r.tx_signature}, ${r.reason},
			 ${r.master_sol_before}, ${r.master_sol_after}, ${r.reserve_sol},
			 ${r.run_cap_sol}, ${r.per_topup_max_sol}, ${r.network},
			 ${r.detail ? JSON.stringify(r.detail) : null}, ${r.prev_hash}, ${r.entry_hash})
	`);
}

/**
 * Recompute the hash chain for a master and report any integrity failure. This is
 * the tamper detector — a broken link means a historical row was edited/deleted,
 * a seq gap means a row is missing. Reads the whole chain (bounded by `limit`).
 *
 * @param {string} masterPubkey
 * @param {{limit?:number}} [opts]
 * @returns {Promise<{ok:boolean, count:number, brokenAtSeq:number|null, gapAtSeq:number|null, headSeq:number|null, headHash:string|null}>}
 */
export async function verifyChain(masterPubkey, { limit = 100_000 } = {}) {
	const rows = await withDbRetry(() => sql`
		SELECT seq, ts, master_pubkey, event, target_pubkey, lamports, tx_signature,
		       reason, master_sol_after, prev_hash, entry_hash
		FROM economy_master_ledger
		WHERE master_pubkey = ${masterPubkey}
		ORDER BY seq ASC LIMIT ${limit}
	`);
	let prevHash = '';
	let prevSeq = 0;
	for (const row of rows) {
		const seq = Number(row.seq);
		if (seq !== prevSeq + 1) {
			return { ok: false, count: rows.length, brokenAtSeq: null, gapAtSeq: seq, headSeq: null, headHash: null };
		}
		// Normalize ts to the ISO form we hashed (Postgres returns a Date).
		const tsIso = row.ts instanceof Date ? row.ts.toISOString() : String(row.ts);
		const recomputed = hashEntry(row.prev_hash || '', {
			seq,
			ts: tsIso,
			master_pubkey: row.master_pubkey,
			event: row.event,
			target_pubkey: row.target_pubkey,
			lamports: row.lamports,
			tx_signature: row.tx_signature,
			reason: row.reason,
			master_sol_after: row.master_sol_after == null ? null : String(row.master_sol_after),
		});
		if ((row.prev_hash || '') !== (prevHash || '') || recomputed !== row.entry_hash) {
			return { ok: false, count: rows.length, brokenAtSeq: seq, gapAtSeq: null, headSeq: null, headHash: null };
		}
		prevHash = row.entry_hash;
		prevSeq = seq;
	}
	return {
		ok: true,
		count: rows.length,
		brokenAtSeq: null,
		gapAtSeq: null,
		headSeq: prevSeq || null,
		headHash: prevHash || null,
	};
}

/**
 * Read ledger rows for accounting/reconciliation over a window.
 * @param {{masterPubkey?:string, from?:string, to?:string, event?:string, limit?:number}} [opts]
 */
export async function readLedger({ masterPubkey = null, from = null, to = null, event = null, limit = 10_000 } = {}) {
	return withDbRetry(() => sql`
		SELECT * FROM economy_master_ledger
		WHERE (${masterPubkey}::text IS NULL OR master_pubkey = ${masterPubkey})
		  AND (${from}::timestamptz IS NULL OR ts >= ${from})
		  AND (${to}::timestamptz IS NULL OR ts <= ${to})
		  AND (${event}::text IS NULL OR event = ${event})
		ORDER BY seq ASC LIMIT ${limit}
	`);
}
