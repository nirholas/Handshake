// api/_lib/x402/ring-reconciliation.js
//
// Ring Reconciliation — closes the reconciliation blind spot over the closed-loop
// x402 ring economy. The daily revenue reconciler (revenue-reconciliation.js)
// proves x402_autonomous_log and agent_payment_intents against the chain, but the
// ring's own books — x402_self_facilitator_log (every settle our self-hosted
// facilitator broadcast) and x402_ring_ledger (treasury→payer sweeps) — were
// never verified. A settlement that exists only in the facilitator log is a
// claim, not a fact; this module makes it a fact or a paged discrepancy.
//
// WHY A SIBLING MODULE, NOT AN EXTENSION OF revenue-reconciliation.js
// -------------------------------------------------------------------
// Three reasons. (1) Cadence: the ring ticks per-minute, so its silence alarm
// (the zero-volume tripwire) needs a 30-minute cycle — the revenue reconciler is
// daily and must stay daily. (2) Different verification depth: ring checks parse
// transactions to prove amount + receiver, not just signature existence. (3) The
// hard constraint that the existing reconciler's behavior for non-ring scopes
// stays byte-identical — a separate module makes that trivially true. Both
// modules share the same payment_reconciliation verdict table, upsert shape, and
// UNIQUE(source, source_ref) convention, so the ops financial-integrity board
// reads ring findings alongside everything else, separated by source.
//
// THE FIVE CHECKS (every 30 min, 72h rolling window, read-only on chain)
// ----------------------------------------------------------------------
//   1. SETTLE INTEGRITY — every ok settle in x402_self_facilitator_log must have
//      a tx signature that exists and succeeded on-chain (batched
//      getSignatureStatuses). Missing → x402_ring_settle_missing; reverted →
//      x402_ring_settle_failed. Both CRITICAL: the facilitator said "settled"
//      and the chain disagrees.
//   2. AMOUNT FIDELITY — for a sampled subset of confirmed settles (bounded by
//      the shared 50-parsed-tx budget), parse the transaction and prove the
//      recipient (pay_to) gained EXACTLY amount_atomic of the logged mint, from
//      pre/postTokenBalances. Divergence → x402_ring_amount_mismatch (CRITICAL:
//      the log's dollar figure is fiction).
//   3. SWEEP INTEGRITY — every x402_ring_ledger kind='sweep' row: signature must
//      exist + succeed, and (parsed, budget-first priority) the USDC must have
//      moved from_wallet → to_wallet in the exact ledger amount, with
//      from_wallet equal to the configured treasury. Wrong direction, wrong
//      amount, or a non-treasury source → x402_ring_sweep_mismatch (CRITICAL).
//   4. CROSS-LOG COHERENCE — a ring tick lands in BOTH books: the buyer side in
//      x402_autonomous_log and the settlement side in x402_self_facilitator_log,
//      joined on signature. A settlement with no buyer record is value leaving
//      through our own facilitator with no spender we know of; a ring-settle
//      buyer row with no settlement record means the facilitator log is losing
//      rows. Either orphan → x402_ring_log_orphan (WARN, daily-throttled alert;
//      rows younger than the grace window are skipped so an in-flight tick is
//      never a false positive).
//   5. FEE COHERENCE — yesterday's summed fee_lamports from the facilitator log
//      vs the fee-audit rollup's number for the same day (x402_fee_audit,
//      written by the fee-minimization pipeline). >20% divergence → WARN,
//      daily-throttled. If the fee-audit table has not landed in this
//      environment yet the check reports itself skipped rather than inventing a
//      comparison.
//
// ZERO-VOLUME TRIPWIRE — if the ring is enabled (self-facilitator on + treasury
// configured; ctx.ringEnabled overrides for callers that already validated
// config) and the facilitator log shows zero ok settles in the last 30 minutes,
// alert "ring enabled but silent". This is the alarm for "it was working and
// then it wasn't" — the failure mode that previously went unnoticed. The verdict
// row flips back to reconciled the moment volume returns, so the board self-heals.
//
// BOUNDS — read-only against the chain; getSignatureStatuses batched at 256; at
// most MAX_PARSED_TX_PER_RUN (50) getParsedTransaction calls per run, sweeps
// funded from that budget first (they are rare and each one moves the whole
// float). Never mutates the logs it audits — verdicts in payment_reconciliation
// and one x402_autonomous_log summary row are the only writes.
//
// Wiring: run()-style entry (`ring-reconciliation`) in autonomous-registry.js,
// cooldown 1800 s. Downstream: the ops financial-integrity board reads
// payment_reconciliation WHERE NOT reconciled; ring findings carry sources
// ring_facilitator_settle / ring_ledger_sweep / ring_log_coherence /
// ring_fee_coherence / ring_tripwire.

import { randomUUID } from 'node:crypto';

import { sql as defaultSql } from '../db.js';
import { env } from '../env.js';
import { logger } from '../usage.js';
import { sendOpsAlert } from '../alerts.js';
import { cacheGet, cacheSet } from '../cache.js';
import { solanaConnection } from '../solana/connection.js';
import { USDC_MINT, SOLANA_RPC } from './pay.js';

const log = logger('x402-ring-reconciliation');

const ASSET = USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// 72h rolling window on a 30-min cadence: every settle is re-verified ~144 times
// before it ages out, so a transient RPC miss self-heals instead of latching.
const LOOKBACK_HOURS = 72;
// Per-minute ring cadence ⇒ ~4,320 settles per 72h window. The row cap sits above
// that so normal volume is never silently truncated; if it ever is, the summary
// says so (settle_rows_truncated).
const MAX_SETTLE_ROWS = 5000;
const MAX_SWEEP_ROWS = 500;
// getSignatureStatuses accepts up to 256 signatures per call.
const STATUS_BATCH = 256;
// Shared parsed-transaction budget per run (the expensive RPC). Sweeps draw
// first; settle amount-sampling gets the remainder.
export const MAX_PARSED_TX_PER_RUN = 50;
// A tick is two writes from two processes; give the slower book this long before
// calling its counterpart an orphan.
export const ORPHAN_GRACE_MINUTES = 15;
// Tripwire window: the ring pays per-minute, so 30 silent minutes is ~30 missed
// ticks — unambiguously stalled, not merely slow.
export const TRIPWIRE_WINDOW_MINUTES = 30;
// Fee coherence tolerance — the audit rollup and the raw log measure the same
// burn; anything past this is one of them lying.
export const FEE_DIVERGENCE_THRESHOLD = 0.2;

// WARN-class findings (coherence, fee drift) throttle to one alert per day so a
// stable low-grade discrepancy cannot flood the ops channel.
const WARN_THROTTLE_SECONDS = 86_400;

// Same DDL as revenue-reconciliation.js — idempotent, shared verdict sink.
async function ensureSchema(db) {
	await db`
		CREATE TABLE IF NOT EXISTS payment_reconciliation (
			id            bigserial   PRIMARY KEY,
			source        text        NOT NULL,
			source_ref    text        NOT NULL,
			tx_signature  text,
			network       text,
			amount_atomic bigint,
			db_status     text        NOT NULL,
			chain_status  text        NOT NULL,
			reconciled    boolean     NOT NULL,
			discrepancy   text,
			detail        jsonb,
			run_id        uuid,
			first_seen_at timestamptz NOT NULL DEFAULT now(),
			checked_at    timestamptz NOT NULL DEFAULT now(),
			UNIQUE (source, source_ref)
		)
	`;
	await db`CREATE INDEX IF NOT EXISTS payment_reconciliation_open_idx
		ON payment_reconciliation (checked_at DESC) WHERE reconciled = false`;
	await db`ALTER TABLE x402_autonomous_log ADD COLUMN IF NOT EXISTS value_extracted jsonb`;
}

async function upsertVerdict(db, runId, { source, sourceRef, txSig, amountAtomic, dbStatus, chainStatus, reconciled, discrepancy, detail }) {
	try {
		await db`
			INSERT INTO payment_reconciliation
				(source, source_ref, tx_signature, network, amount_atomic,
				 db_status, chain_status, reconciled, discrepancy, detail, run_id, checked_at)
			VALUES
				(${source}, ${sourceRef}, ${txSig || null}, ${'solana:mainnet'}, ${amountAtomic ?? null},
				 ${dbStatus}, ${chainStatus}, ${reconciled}, ${discrepancy || null},
				 ${detail ? JSON.stringify(detail) : null}, ${runId}, now())
			ON CONFLICT (source, source_ref) DO UPDATE SET
				tx_signature  = EXCLUDED.tx_signature,
				network       = EXCLUDED.network,
				amount_atomic = EXCLUDED.amount_atomic,
				db_status     = EXCLUDED.db_status,
				chain_status  = EXCLUDED.chain_status,
				reconciled    = EXCLUDED.reconciled,
				discrepancy   = EXCLUDED.discrepancy,
				detail        = EXCLUDED.detail,
				run_id        = EXCLUDED.run_id,
				checked_at    = now()
		`;
	} catch (err) {
		log.warn('ring_reconcile_upsert_failed', { ref: `${source}:${sourceRef}`, message: err?.message });
	}
}

// ── Book loaders — tables may not exist in a fresh env; that is "no book", not
//    an error (mirrors loadInboundRecords in the sibling reconciler).

async function loadSettleRows(db) {
	try {
		return await db`
			SELECT id, ts, payer, pay_to, mint, amount_atomic, tx_sig
			FROM x402_self_facilitator_log
			WHERE action = 'settle' AND ok = true
			  AND ts > now() - (${LOOKBACK_HOURS} || ' hours')::interval
			ORDER BY ts DESC
			LIMIT ${MAX_SETTLE_ROWS}
		`;
	} catch (err) {
		if (!err?.message?.includes('does not exist')) {
			log.warn('ring_reconcile_settle_load_failed', { message: err?.message });
		}
		return [];
	}
}

async function loadSweepRows(db) {
	try {
		return await db`
			SELECT id, ts, kind, from_wallet, to_wallet, mint, amount_atomic, tx_sig
			FROM x402_ring_ledger
			WHERE kind IN ('sweep', 'revshare')
			  AND ts > now() - (${LOOKBACK_HOURS} || ' hours')::interval
			ORDER BY ts DESC
			LIMIT ${MAX_SWEEP_ROWS}
		`;
	} catch (err) {
		if (!err?.message?.includes('does not exist')) {
			log.warn('ring_reconcile_sweep_load_failed', { message: err?.message });
		}
		return [];
	}
}

// Buyer-side rows for cross-log coherence: every successful autonomous payment
// with a signature (any endpoint — a settle matched by ANY buyer row is
// coherent), plus the endpoint so ring-settle buyer rows can be isolated for the
// reverse direction.
async function loadBuyerRows(db) {
	try {
		return await db`
			SELECT id, ts, tx_signature, endpoint_url
			FROM x402_autonomous_log
			WHERE success = true AND tx_signature IS NOT NULL
			  AND ts > now() - (${LOOKBACK_HOURS} || ' hours')::interval
			ORDER BY ts DESC
			LIMIT ${MAX_SETTLE_ROWS}
		`;
	} catch (err) {
		if (!err?.message?.includes('does not exist')) {
			log.warn('ring_reconcile_buyer_load_failed', { message: err?.message });
		}
		return [];
	}
}

// ── Chain helpers

// signature → { found, err } | absent on RPC failure (callers treat a missing
// entry as unknown, never a discrepancy).
async function fetchOnChainStatuses(conn, signatures) {
	const out = new Map();
	for (let i = 0; i < signatures.length; i += STATUS_BATCH) {
		const batch = signatures.slice(i, i + STATUS_BATCH);
		try {
			const { value } = await conn.getSignatureStatuses(batch, { searchTransactionHistory: true });
			batch.forEach((sig, j) => {
				const st = value?.[j];
				out.set(sig, st ? { found: true, err: st.err ?? null } : { found: false, err: null });
			});
		} catch (err) {
			log.warn('ring_reconcile_status_batch_failed', { from: i, message: err?.message });
		}
	}
	return out;
}

// Net token movement per owner for one mint, from a parsed transaction's
// pre/postTokenBalances. Sums across ATAs so an owner with several accounts
// still nets correctly. Pure; exported for tests.
export function tokenDeltasByOwner(parsedTx, mint) {
	const deltas = new Map();
	const meta = parsedTx?.meta;
	if (!meta || !Array.isArray(meta.preTokenBalances) || !Array.isArray(meta.postTokenBalances)) {
		return null;
	}
	const add = (owner, amount) => {
		if (!owner) return;
		deltas.set(owner, (deltas.get(owner) ?? 0n) + amount);
	};
	for (const b of meta.postTokenBalances) {
		if (b?.mint === mint) add(b.owner, BigInt(b.uiTokenAmount?.amount || 0));
	}
	for (const b of meta.preTokenBalances) {
		if (b?.mint === mint) add(b.owner, -BigInt(b.uiTokenAmount?.amount || 0));
	}
	return deltas;
}

// Prove one confirmed settle's parsed tx pays EXACTLY amount_atomic of mint to
// pay_to. Pure; exported for tests. Returns { ok } | { ok:false, reason }.
export function verifySettleAmount(row, parsedTx) {
	const mint = row.mint || ASSET;
	const deltas = tokenDeltasByOwner(parsedTx, mint);
	if (deltas === null) return { ok: false, reason: 'tx_unparseable', soft: true };
	const received = deltas.get(row.pay_to) ?? 0n;
	if (received !== BigInt(row.amount_atomic ?? 0)) {
		return { ok: false, reason: `receiver_got_${received}_logged_${row.amount_atomic}` };
	}
	return { ok: true };
}

// Prove one confirmed sweep moved amount_atomic of mint from_wallet → to_wallet,
// and that the source is the configured treasury (treasury→payer and
// treasury→master revshare are the only legal directions). A single sweep tx
// may carry MULTIPLE ledger legs (payer sweep + master revshare), so the
// treasury's total on-chain delta is checked against `txTotalAtomic` — the sum
// of every ledger row sharing this tx_sig (defaults to the row's own amount for
// the single-leg case). The recipient check stays per-row. Pure; exported for
// tests.
export function verifySweepMovement(row, parsedTx, treasuryAddress, txTotalAtomic = null) {
	const mint = row.mint || ASSET;
	if (treasuryAddress && row.from_wallet !== treasuryAddress) {
		return { ok: false, reason: `sweep_source_not_treasury:${row.from_wallet}` };
	}
	const deltas = tokenDeltasByOwner(parsedTx, mint);
	if (deltas === null) return { ok: false, reason: 'tx_unparseable', soft: true };
	const amount = BigInt(row.amount_atomic ?? 0);
	const txTotal = BigInt(txTotalAtomic ?? row.amount_atomic ?? 0);
	const sent = deltas.get(row.from_wallet) ?? 0n;
	const received = deltas.get(row.to_wallet) ?? 0n;
	if (sent !== -txTotal) return { ok: false, reason: `treasury_delta_${sent}_expected_${-txTotal}` };
	if (received !== amount) return { ok: false, reason: `payer_delta_${received}_expected_${amount}` };
	return { ok: true };
}

// Fee divergence between the raw facilitator log and the fee-audit rollup for
// one day. Pure; exported for tests. null = not comparable (no audit figure).
export function feeDivergence(loggedLamports, auditLamports) {
	if (auditLamports == null || !Number.isFinite(Number(auditLamports))) return null;
	const logged = Number(loggedLamports || 0);
	const audited = Number(auditLamports);
	if (logged === 0 && audited === 0) return 0;
	const base = Math.max(logged, audited);
	return Math.abs(logged - audited) / base;
}

// Is the ring supposed to be producing volume? Local config read: the
// self-hosted facilitator flag plus a configured treasury are the two settings
// without which nothing can settle. Callers that already ran a fuller config
// validation pass the answer in via ctx.ringEnabled instead.
function ringEnabledLocal() {
	const on = String(process.env.X402_SELF_FACILITATOR_ENABLED || '').toLowerCase() === 'true';
	return on && Boolean(env.X402_PAY_TO_SOLANA || process.env.X402_PAY_TO_SOLANA);
}

async function recordLogRow(db, runId, { durationMs, success, errorMsg, summary }) {
	try {
		await db`
			INSERT INTO x402_autonomous_log
				(run_id, endpoint_type, service_name, endpoint_url,
				 network, amount_atomic, asset, tx_signature,
				 response_data, value_extracted, duration_ms, success, error_msg, pipeline)
			VALUES
				(${runId}, ${'self'}, ${'Ring Reconciliation'}, ${'/api/x402-facilitator'},
				 ${'solana:mainnet'}, ${0}, ${ASSET}, ${null},
				 ${summary ? JSON.stringify(summary) : null},
				 ${summary ? JSON.stringify(summary) : null},
				 ${durationMs || 0}, ${success}, ${errorMsg || null}, ${'reconciliation'})
		`;
	} catch (err) {
		log.warn('ring_reconcile_log_insert_failed', { message: err?.message });
	}
}

/**
 * Run the ring reconciliation. Registry run()-contract; read-only on chain, so a
 * missing spend wallet never blocks it. Injectable for tests:
 *   ctx.sql          — DB tag (default shared sql)
 *   ctx.conn         — Solana connection (default keyless RPC)
 *   ctx.sendAlert    — ops alert fn (default sendOpsAlert)
 *   ctx.cache        — { get, set } for WARN throttling (default shared cache)
 *   ctx.ringEnabled  — boolean override for the tripwire's config check
 *   ctx.now          — epoch ms override (grace/tripwire windows in tests)
 */
export async function run(ctx = {}) {
	const runId = ctx.runId || randomUUID();
	const db = ctx.sql || defaultSql;
	const alert = ctx.sendAlert || sendOpsAlert;
	const cache = ctx.cache || { get: cacheGet, set: cacheSet };
	const nowMs = ctx.now ?? Date.now();
	const t0 = Date.now();

	try {
		await ensureSchema(db);
	} catch (err) {
		log.warn('ring_reconcile_schema_failed', { message: err?.message });
		return { success: false, skipped: true, amountAtomic: 0, errorMsg: `schema_failed: ${err?.message}` };
	}

	const conn = ctx.conn || solanaConnection({ url: SOLANA_RPC, commitment: 'confirmed' });

	// One WARN alert per class per day; CRITICALs bypass this and page immediately.
	async function warnThrottled(key, title, detail) {
		try {
			if (await cache.get(`ring-reconcile:warn:${key}`)) return;
			await cache.set(`ring-reconcile:warn:${key}`, 1, WARN_THROTTLE_SECONDS);
		} catch { /* throttle store down → still alert; dedup in alerts.js backstops */ }
		await alert(title, detail, { signature: `ring-reconcile:${key}` }).catch?.(() => {});
	}

	// ── Load all three books once.
	const settles = await loadSettleRows(db);
	const sweeps = await loadSweepRows(db);
	const buyers = await loadBuyerRows(db);

	const summary = {
		settles_checked: settles.length,
		settle_rows_truncated: settles.length >= MAX_SETTLE_ROWS,
		settles_confirmed: 0,
		settles_missing: 0,
		settles_failed: 0,
		settles_no_signature: 0,
		settles_unknown: 0,
		settles_amount_sampled: 0,
		amount_mismatches: 0,
		sweeps_checked: sweeps.length,
		sweeps_confirmed: 0,
		sweeps_missing: 0,
		sweeps_failed: 0,
		sweep_mismatches: 0,
		sweeps_unknown: 0,
		orphans_settle_side: 0,
		orphans_buyer_side: 0,
		fee_day: null,
		fee_divergence: null,
		tripwire_fired: false,
		parsed_tx_used: 0,
	};
	const critical = [];

	// ── Status lookup for every signature in both ring books, one batched pass.
	const allSigs = [...new Set([
		...settles.map((r) => r.tx_sig).filter(Boolean),
		...sweeps.map((r) => r.tx_sig).filter(Boolean),
	])];
	const statuses = allSigs.length ? await fetchOnChainStatuses(conn, allSigs) : new Map();

	let parsedBudget = ctx.maxParsedTx ?? MAX_PARSED_TX_PER_RUN;
	async function parseTx(sig) {
		if (parsedBudget <= 0) return { budgetExhausted: true, tx: null };
		parsedBudget -= 1;
		summary.parsed_tx_used += 1;
		try {
			const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
			return { budgetExhausted: false, tx };
		} catch {
			return { budgetExhausted: false, tx: null };
		}
	}

	// ── Check 3 first: sweeps draw the parsed-tx budget before settle sampling —
	//    each sweep moves the entire float, so full verification of every sweep
	//    outranks sampling one more settle.
	const treasuryAddress = env.X402_PAY_TO_SOLANA || process.env.X402_PAY_TO_SOLANA || null;
	// A split sweep (payer leg + master revshare leg) shares one tx_sig; the
	// treasury's on-chain delta must match the SUM of its legs, not each row.
	const sweepTxTotals = new Map();
	for (const row of sweeps) {
		if (!row.tx_sig) continue;
		sweepTxTotals.set(row.tx_sig, (sweepTxTotals.get(row.tx_sig) ?? 0n) + BigInt(row.amount_atomic ?? 0));
	}
	for (const row of sweeps) {
		const ref = String(row.id);
		if (!row.tx_sig) {
			summary.sweeps_missing += 1;
			critical.push({ kind: 'x402_ring_sweep_missing', ref, sig: null });
			await upsertVerdict(db, runId, {
				source: 'ring_ledger_sweep', sourceRef: ref, txSig: null,
				amountAtomic: row.amount_atomic, dbStatus: 'sweep_recorded',
				chainStatus: 'missing_signature', reconciled: false,
				discrepancy: 'x402_ring_sweep_missing',
				detail: { from: row.from_wallet, to: row.to_wallet },
			});
			continue;
		}
		const st = statuses.get(row.tx_sig);
		if (!st) { summary.sweeps_unknown += 1; continue; } // RPC gap — next run re-checks
		if (!st.found || st.err != null) {
			const kind = st.found ? 'x402_ring_sweep_failed' : 'x402_ring_sweep_missing';
			summary[st.found ? 'sweeps_failed' : 'sweeps_missing'] += 1;
			critical.push({ kind, ref, sig: row.tx_sig });
			await upsertVerdict(db, runId, {
				source: 'ring_ledger_sweep', sourceRef: ref, txSig: row.tx_sig,
				amountAtomic: row.amount_atomic, dbStatus: 'sweep_recorded',
				chainStatus: st.found ? 'failed_onchain' : 'missing_onchain', reconciled: false,
				discrepancy: kind, detail: { from: row.from_wallet, to: row.to_wallet },
			});
			continue;
		}
		// Confirmed — now prove amount + direction from the parsed tx.
		const { budgetExhausted, tx } = await parseTx(row.tx_sig);
		if (budgetExhausted || !tx) {
			// Confirmed on-chain, movement unproven this run — reconciled with a
			// note; the rolling window re-samples it next tick.
			summary.sweeps_confirmed += 1;
			await upsertVerdict(db, runId, {
				source: 'ring_ledger_sweep', sourceRef: ref, txSig: row.tx_sig,
				amountAtomic: row.amount_atomic, dbStatus: 'sweep_recorded',
				chainStatus: 'confirmed', reconciled: true, discrepancy: null,
				detail: { movement_verified: false },
			});
			continue;
		}
		const check = verifySweepMovement(row, tx, treasuryAddress, sweepTxTotals.get(row.tx_sig));
		if (!check.ok && !check.soft) {
			summary.sweep_mismatches += 1;
			critical.push({ kind: 'x402_ring_sweep_mismatch', ref, sig: row.tx_sig, reason: check.reason });
			await upsertVerdict(db, runId, {
				source: 'ring_ledger_sweep', sourceRef: ref, txSig: row.tx_sig,
				amountAtomic: row.amount_atomic, dbStatus: 'sweep_recorded',
				chainStatus: 'amount_mismatch', reconciled: false,
				discrepancy: 'x402_ring_sweep_mismatch',
				detail: { reason: check.reason, from: row.from_wallet, to: row.to_wallet },
			});
		} else {
			summary.sweeps_confirmed += 1;
			await upsertVerdict(db, runId, {
				source: 'ring_ledger_sweep', sourceRef: ref, txSig: row.tx_sig,
				amountAtomic: row.amount_atomic, dbStatus: 'sweep_recorded',
				chainStatus: 'confirmed', reconciled: true, discrepancy: null,
				detail: { movement_verified: check.ok },
			});
		}
	}

	// ── Checks 1 + 2: settle signature integrity for every row; amount fidelity
	//    for the most recent confirmed rows the remaining budget covers.
	const confirmedSettles = [];
	for (const row of settles) {
		const ref = String(row.id);
		if (!row.tx_sig) {
			summary.settles_no_signature += 1;
			critical.push({ kind: 'x402_ring_settle_missing', ref, sig: null });
			await upsertVerdict(db, runId, {
				source: 'ring_facilitator_settle', sourceRef: ref, txSig: null,
				amountAtomic: row.amount_atomic, dbStatus: 'settle_ok',
				chainStatus: 'missing_signature', reconciled: false,
				discrepancy: 'x402_ring_settle_missing',
				detail: { payer: row.payer, pay_to: row.pay_to },
			});
			continue;
		}
		const st = statuses.get(row.tx_sig);
		if (!st) { summary.settles_unknown += 1; continue; }
		if (!st.found || st.err != null) {
			const kind = st.found ? 'x402_ring_settle_failed' : 'x402_ring_settle_missing';
			summary[st.found ? 'settles_failed' : 'settles_missing'] += 1;
			critical.push({ kind, ref, sig: row.tx_sig });
			await upsertVerdict(db, runId, {
				source: 'ring_facilitator_settle', sourceRef: ref, txSig: row.tx_sig,
				amountAtomic: row.amount_atomic, dbStatus: 'settle_ok',
				chainStatus: st.found ? 'failed_onchain' : 'missing_onchain', reconciled: false,
				discrepancy: kind, detail: { payer: row.payer, pay_to: row.pay_to },
			});
			continue;
		}
		summary.settles_confirmed += 1;
		confirmedSettles.push(row);
	}

	for (const row of confirmedSettles) {
		if (parsedBudget <= 0) break;
		const ref = String(row.id);
		const { tx } = await parseTx(row.tx_sig);
		if (!tx) {
			// Signature confirmed; amount unproven this run — reconciled, resampled later.
			await upsertVerdict(db, runId, {
				source: 'ring_facilitator_settle', sourceRef: ref, txSig: row.tx_sig,
				amountAtomic: row.amount_atomic, dbStatus: 'settle_ok',
				chainStatus: 'confirmed', reconciled: true, discrepancy: null,
				detail: { amount_verified: false },
			});
			continue;
		}
		summary.settles_amount_sampled += 1;
		const check = verifySettleAmount(row, tx);
		if (!check.ok && !check.soft) {
			summary.amount_mismatches += 1;
			critical.push({ kind: 'x402_ring_amount_mismatch', ref, sig: row.tx_sig, reason: check.reason });
			await upsertVerdict(db, runId, {
				source: 'ring_facilitator_settle', sourceRef: ref, txSig: row.tx_sig,
				amountAtomic: row.amount_atomic, dbStatus: 'settle_ok',
				chainStatus: 'amount_mismatch', reconciled: false,
				discrepancy: 'x402_ring_amount_mismatch',
				detail: { reason: check.reason, payer: row.payer, pay_to: row.pay_to },
			});
		} else {
			await upsertVerdict(db, runId, {
				source: 'ring_facilitator_settle', sourceRef: ref, txSig: row.tx_sig,
				amountAtomic: row.amount_atomic, dbStatus: 'settle_ok',
				chainStatus: 'confirmed', reconciled: true, discrepancy: null,
				detail: { amount_verified: check.ok },
			});
		}
	}
	// Confirmed settles the budget did not reach are still signature-reconciled.
	for (const row of confirmedSettles.slice(summary.settles_amount_sampled)) {
		await upsertVerdict(db, runId, {
			source: 'ring_facilitator_settle', sourceRef: String(row.id), txSig: row.tx_sig,
			amountAtomic: row.amount_atomic, dbStatus: 'settle_ok',
			chainStatus: 'confirmed', reconciled: true, discrepancy: null,
			detail: { amount_verified: false },
		});
	}

	// ── Check 4: cross-log coherence, joined on signature, outside the grace window.
	const graceCutoff = nowMs - ORPHAN_GRACE_MINUTES * 60_000;
	const buyerSigs = new Set(buyers.map((b) => b.tx_signature).filter(Boolean));
	const settleSigs = new Set(settles.map((s) => s.tx_sig).filter(Boolean));

	for (const row of settles) {
		if (!row.tx_sig || buyerSigs.has(row.tx_sig)) continue;
		if (new Date(row.ts).getTime() > graceCutoff) continue;
		summary.orphans_settle_side += 1;
		await upsertVerdict(db, runId, {
			source: 'ring_log_coherence', sourceRef: `settle:${row.tx_sig}`, txSig: row.tx_sig,
			amountAtomic: row.amount_atomic, dbStatus: 'settle_ok',
			chainStatus: 'no_buyer_record', reconciled: false,
			discrepancy: 'x402_ring_log_orphan',
			detail: { side: 'settle_without_buyer', payer: row.payer, pay_to: row.pay_to },
		});
	}
	for (const row of buyers) {
		if (!String(row.endpoint_url || '').includes('ring-settle')) continue;
		if (!row.tx_signature || settleSigs.has(row.tx_signature)) continue;
		if (new Date(row.ts).getTime() > graceCutoff) continue;
		summary.orphans_buyer_side += 1;
		await upsertVerdict(db, runId, {
			source: 'ring_log_coherence', sourceRef: `buyer:${row.tx_signature}`, txSig: row.tx_signature,
			amountAtomic: null, dbStatus: 'buyer_paid',
			chainStatus: 'no_settle_record', reconciled: false,
			discrepancy: 'x402_ring_log_orphan',
			detail: { side: 'buyer_without_settle', endpoint: row.endpoint_url },
		});
	}
	const orphanTotal = summary.orphans_settle_side + summary.orphans_buyer_side;
	if (orphanTotal > 0) {
		await warnThrottled(
			'log-orphans',
			`⚠️ x402 ring cross-log orphans: ${orphanTotal}`,
			[
				`${summary.orphans_settle_side} settlement(s) with NO buyer record — value moved through our own facilitator with no spend we booked (the internal-leak signature).`,
				`${summary.orphans_buyer_side} ring buyer payment(s) with NO facilitator settle record.`,
				`Board: SELECT * FROM payment_reconciliation WHERE source = 'ring_log_coherence' AND reconciled = false`,
			].join('\n'),
		);
	}

	// ── Check 5: fee coherence for the last complete UTC day.
	const day = new Date(nowMs - 86_400_000).toISOString().slice(0, 10);
	summary.fee_day = day;
	try {
		const [logged] = await db`
			SELECT COALESCE(sum(fee_lamports), 0)::bigint AS total
			FROM x402_self_facilitator_log
			WHERE action = 'settle' AND ok = true
			  AND ts >= ${day}::date AND ts < ${day}::date + interval '1 day'
		`;
		let auditTotal = null;
		try {
			const [audit] = await db`
				SELECT total_fee_lamports FROM x402_fee_audit WHERE day = ${day}::date
			`;
			auditTotal = audit?.total_fee_lamports ?? null;
		} catch (err) {
			if (!err?.message?.includes('does not exist')) {
				log.warn('ring_reconcile_fee_audit_load_failed', { message: err?.message });
			}
			summary.fee_audit_available = false;
		}
		const divergence = feeDivergence(logged?.total, auditTotal);
		summary.fee_divergence = divergence;
		if (divergence != null && divergence > FEE_DIVERGENCE_THRESHOLD) {
			await upsertVerdict(db, runId, {
				source: 'ring_fee_coherence', sourceRef: day, txSig: null,
				amountAtomic: Number(logged?.total || 0), dbStatus: 'fees_logged',
				chainStatus: 'fee_divergence', reconciled: false,
				discrepancy: 'x402_ring_fee_divergence',
				detail: { day, logged_lamports: Number(logged?.total || 0), audit_lamports: Number(auditTotal), divergence },
			});
			await warnThrottled(
				`fee-divergence:${day}`,
				`⚠️ x402 ring fee books diverge ${(divergence * 100).toFixed(1)}% on ${day}`,
				`Facilitator log: ${logged?.total} lamports; fee-audit rollup: ${auditTotal} lamports. One of the two fee books is wrong — check x402_self_facilitator_log vs x402_fee_audit for ${day}.`,
			);
		} else if (divergence != null) {
			await upsertVerdict(db, runId, {
				source: 'ring_fee_coherence', sourceRef: day, txSig: null,
				amountAtomic: Number(logged?.total || 0), dbStatus: 'fees_logged',
				chainStatus: 'confirmed', reconciled: true, discrepancy: null,
				detail: { day, divergence },
			});
		}
	} catch (err) {
		log.warn('ring_reconcile_fee_check_failed', { message: err?.message });
	}

	// ── Zero-volume tripwire.
	const ringEnabled = ctx.ringEnabled ?? ringEnabledLocal();
	summary.ring_enabled = ringEnabled;
	if (ringEnabled) {
		const windowCutoff = nowMs - TRIPWIRE_WINDOW_MINUTES * 60_000;
		const recentSettles = settles.filter((r) => new Date(r.ts).getTime() >= windowCutoff).length;
		if (recentSettles === 0) {
			summary.tripwire_fired = true;
			await upsertVerdict(db, runId, {
				source: 'ring_tripwire', sourceRef: 'ring-silent', txSig: null,
				amountAtomic: null, dbStatus: 'ring_enabled',
				chainStatus: 'no_volume', reconciled: false,
				discrepancy: 'x402_ring_enabled_but_silent',
				detail: { window_minutes: TRIPWIRE_WINDOW_MINUTES },
			});
			await alert(
				'⚠️ x402 ring enabled but silent',
				`The self-hosted facilitator is enabled and configured, but x402_self_facilitator_log shows ZERO successful settles in the last ${TRIPWIRE_WINDOW_MINUTES} minutes. The ring should tick continuously — check the autonomous loop, the payer's USDC/SOL balances, and /api/x402-ring.`,
				{ signature: 'ring-reconcile:tripwire' },
			).catch?.(() => {});
		} else {
			// Volume present — clear any standing tripwire verdict so the board self-heals.
			await upsertVerdict(db, runId, {
				source: 'ring_tripwire', sourceRef: 'ring-silent', txSig: null,
				amountAtomic: null, dbStatus: 'ring_enabled',
				chainStatus: 'confirmed', reconciled: true, discrepancy: null,
				detail: { window_minutes: TRIPWIRE_WINDOW_MINUTES, settles_in_window: recentSettles },
			});
		}
	}

	// ── CRITICAL page: books disagree with the chain about ring money.
	if (critical.length > 0) {
		const counts = critical.reduce((m, c) => { m[c.kind] = (m[c.kind] || 0) + 1; return m; }, {});
		await alert(
			`🚨 x402 ring reconciliation: ${critical.length} discrepanc${critical.length === 1 ? 'y' : 'ies'}`,
			[
				...Object.entries(counts).map(([k, n]) => `${k}=${n}`),
				`sample: ${critical.slice(0, 5).map((c) => `${c.kind}:${c.ref}${c.reason ? `(${c.reason})` : ''}`).join(', ')}`,
				`full set: SELECT * FROM payment_reconciliation WHERE source LIKE 'ring_%' AND reconciled = false`,
			].join('\n'),
			{ signature: `ring-reconcile-critical:${Object.entries(counts).map(([k, n]) => `${k}:${n}`).join(',')}` },
		).catch?.(() => {});
	}

	const durationMs = Date.now() - t0;
	summary.discrepancies = critical.length + orphanTotal;
	await recordLogRow(db, runId, { durationMs, success: true, errorMsg: null, summary });

	log.info('ring_reconcile_complete', {
		run_id: runId,
		settles: summary.settles_checked,
		sweeps: summary.sweeps_checked,
		critical: critical.length,
		orphans: orphanTotal,
		tripwire: summary.tripwire_fired,
		parsed_tx: summary.parsed_tx_used,
		duration_ms: durationMs,
	});

	return {
		success: true,
		amountAtomic: 0, // read-only audit — no payment owed
		txSig: null,
		errorMsg: null,
		skipped: false,
		responseData: summary,
		signalData: null,
		note: `ring reconcile settles=${summary.settles_checked} sweeps=${summary.sweeps_checked} critical=${critical.length} orphans=${orphanTotal}${summary.tripwire_fired ? ' TRIPWIRE' : ''}`,
	};
}
