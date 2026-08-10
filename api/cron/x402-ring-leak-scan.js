// @ts-check
// GET /api/cron/x402-ring-leak-scan — the ACTIVE, on-chain half of the
// leak-proofing invariant: **no SOL or USDC ever leaves the controlled-wallet
// set.** The runtime assertions (api/_lib/x402/ring-allowlist.js) stop the ring
// from *initiating* a leaking spend; this scanner watches the chain itself and
// alarms within minutes if money leaves anyway — a compromised key, a bug, or a
// path the assertions don't cover.
//
// Every 10 min, for each ring wallet:
//   1. getSignaturesForAddress(limit 100, until=<persisted cursor>) — only
//      signatures newer than the last scan. Cursor persisted per wallet so RPC
//      stays bounded and each tx is classified exactly once.
//   2. Batched getParsedTransactions over the new signatures.
//   3. classifyWalletDebits() (pure, exported, unit-tested) labels every debit:
//        • internal     — counterparty ∈ ringAllowedAddresses()
//        • network_fee  — the tx fee our wallet paid
//        • LEAK         — anything else: USDC to an unknown address, ANY
//                         non-USDC token out, an unexplained SOL debit, a
//                         System transfer to an unknown address
//        • delegation   — an SPL Approve on a ring ATA (a leak vector before
//                         funds even move) — alerted on sight
//   4. Any LEAK / delegation → CRITICAL sendOpsAlert (signature, counterparty,
//      amount, rotate-the-key recommendation) + a payment_reconciliation verdict
//      (source 'x402_ring_onchain'), mirroring economy-reconcile.js.
//   5. Per-day observed network-fee sum is accumulated and cross-checked against
//      task 05's x402_fee_audit rollup — a >20% mismatch WARNs (fees paid
//      outside the ring's accounting).
//
// STRICTLY read-only on chain. It never moves funds, never rotates keys. When
// classification is ambiguous it classifies as LEAK (false-negative is worse
// than false-positive here).

import { randomUUID } from 'node:crypto';

import { json, wrapCron, method } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { withDbRetry } from '../_lib/db-retry.js';
import { sql } from '../_lib/db.js';
import { ringAllowedAddresses, ringRoleWallets } from '../_lib/x402/ring-allowlist.js';
import { requireCron } from '../_lib/cron-auth.js';

// ── Tuning ────────────────────────────────────────────────────────────────────
const SIG_SCAN_LIMIT = 100;              // hard per-wallet-per-run cap (task constraint)
const PARSED_BATCH = 50;                 // getParsedTransactions batch size
// Residual SOL debit (after fee + accounted outflows) above this is a LEAK. One
// base-fee unit — small enough to catch a real drain, above lamport rounding.
const SOL_RESIDUAL_FLOOR_LAMPORTS = 5_000;
// Fee-book divergence: on-chain observed fees vs task 05's audit rollup.
const FEE_DIVERGENCE_THRESHOLD = 0.20;
const CANONICAL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ── Pure classification (exported for tests) ──────────────────────────────────

/**
 * Normalize a parsed message's accountKeys to an array of pubkey strings.
 * jsonParsed encodes them as { pubkey, signer, writable }; legacy shapes as raw
 * strings. Returns [] when unreadable.
 * @param {any} message
 * @returns {string[]}
 */
export function accountKeyStrings(message) {
	const keys = message?.accountKeys;
	if (!Array.isArray(keys)) return [];
	return keys.map((k) => (typeof k === 'string' ? k : (k?.pubkey || k?.toString?.() || '')));
}

/** Flatten top-level + inner instructions into one list of parsed instructions. */
function allInstructions(tx) {
	const top = tx?.transaction?.message?.instructions || [];
	const inner = (tx?.meta?.innerInstructions || []).flatMap((g) => g?.instructions || []);
	return [...top, ...inner];
}

/** Map accountIndex → { mint, owner, amount(BigInt) } from a token-balance array. */
function tokenBalanceMap(arr) {
	const m = new Map();
	for (const b of arr || []) {
		if (b?.accountIndex == null) continue;
		let amount = 0n;
		try { amount = BigInt(b?.uiTokenAmount?.amount ?? '0'); } catch { amount = 0n; }
		m.set(b.accountIndex, { mint: b.mint, owner: b.owner, amount });
	}
	return m;
}

/**
 * Classify every SOL/USDC debit a single parsed transaction makes FROM `wallet`.
 *
 * @param {any} tx  a jsonParsed transaction (getParsedTransaction[s] shape)
 * @param {{ wallet: string, allowed: Set<string>, usdcMint: string }} ctx
 * @returns {{
 *   unreadable: boolean,
 *   signature: string|null,
 *   fee: { lamports: number, ours: boolean },
 *   events: Array<{ type: 'internal'|'leak'|'delegation', asset: string, counterparty: string|null, amountAtomic: number, reason: string }>,
 * }}
 */
export function classifyWalletDebits(tx, { wallet, allowed, usdcMint }) {
	const usdc = usdcMint || CANONICAL_USDC;
	const signature = tx?.transaction?.signatures?.[0] || null;
	const msg = tx?.transaction?.message;
	const meta = tx?.meta;
	const events = [];

	if (!msg || !meta) return { unreadable: true, signature, fee: { lamports: 0, ours: false }, events };

	const keys = accountKeyStrings(msg);
	const walletIdx = keys.indexOf(wallet);

	// Network fee: attributed to the fee payer (account index 0).
	const feeLamports = Number(meta.fee || 0);
	const feeOurs = keys[0] === wallet;
	const fee = { lamports: feeLamports, ours: feeOurs };

	// A failed tx moved no funds (fee still burned, captured above).
	if (meta.err) return { unreadable: false, signature, fee, events };
	if (walletIdx < 0) return { unreadable: false, signature, fee, events };

	const isInternal = (addr) => addr != null && allowed.has(addr);

	// ── SOL outflows we can attribute to a counterparty ──────────────────────
	let accountedSolOut = 0;
	for (const ix of allInstructions(tx)) {
		const info = ix?.parsed?.info;
		const type = ix?.parsed?.type;
		if (!info || !type) continue;

		if (ix.program === 'system') {
			// transfer / transferWithSeed: lamports leaving `wallet`.
			if ((type === 'transfer' || type === 'transferWithSeed') && info.source === wallet) {
				const lamports = Number(info.lamports || 0);
				accountedSolOut += lamports;
				events.push({
					type: isInternal(info.destination) ? 'internal' : 'leak',
					asset: 'SOL', counterparty: info.destination ?? null, amountAtomic: lamports,
					reason: isInternal(info.destination) ? 'system_transfer_internal' : 'system_transfer_to_unknown',
				});
			} else if (type === 'createAccount' && info.source === wallet) {
				const lamports = Number(info.lamports || 0);
				accountedSolOut += lamports;
				events.push({
					type: isInternal(info.newAccount) ? 'internal' : 'leak',
					asset: 'SOL', counterparty: info.newAccount ?? null, amountAtomic: lamports,
					reason: isInternal(info.newAccount) ? 'create_account_internal' : 'create_account_unknown_owner',
				});
			}
		} else if (ix.program === 'spl-associated-token-account') {
			// ATA create: rent leaves the funder for a NEW token account. Internal
			// only when the account's OWNER (info.wallet) is a controlled address.
			if ((type === 'create' || type === 'createIdempotent') && info.source === wallet) {
				const owner = info.wallet ?? null;
				// rent is not in `info`; it surfaces as residual — do not double-count.
				events.push({
					type: isInternal(owner) ? 'internal' : 'leak',
					asset: 'SOL', counterparty: owner, amountAtomic: 0,
					reason: isInternal(owner) ? 'ata_create_internal' : 'ata_create_unknown_owner',
				});
			}
		} else if (ix.program === 'spl-token' || ix.program === 'spl-token-2022') {
			// Delegation risk: an Approve on a ring token account authorizes a
			// delegate to move funds later — a leak vector before any transfer.
			if ((type === 'approve' || type === 'approveChecked') && (info.owner === wallet || isInternal(info.source))) {
				let amount = 0;
				try { amount = Number(info.amount ?? info.tokenAmount?.amount ?? 0); } catch { amount = 0; }
				events.push({
					type: 'delegation', asset: info.mint || 'token', counterparty: info.delegate ?? null,
					amountAtomic: amount, reason: 'spl_approve_on_ring_ata',
				});
			}
		}
	}

	// ── Token outflows via balance deltas (mechanism-agnostic) ───────────────
	const pre = tokenBalanceMap(meta.preTokenBalances);
	const post = tokenBalanceMap(meta.postTokenBalances);
	for (const [idx, before] of pre) {
		if (before.owner !== wallet) continue;
		const after = post.get(idx);
		const delta = before.amount - (after?.amount ?? 0n); // >0 ⇒ tokens left the account
		if (delta <= 0n) continue;

		const nonUsdc = before.mint !== usdc;
		// Counterparty: the account that GAINED this mint in the same tx.
		let counterparty = null;
		for (const [j, a2] of post) {
			if (j === idx || a2.mint !== before.mint) continue;
			const gain = a2.amount - (pre.get(j)?.amount ?? 0n);
			if (gain > 0n) { counterparty = a2.owner || keys[j] || null; break; }
		}

		// Non-USDC out is ALWAYS a leak (the ring only ever moves USDC). USDC out
		// is internal only to a controlled COUNTERPARTY (the account that gained
		// the tokens) — never keyed off our own debited account's owner, which is
		// always us. Unknown counterparty → leak (false-negative averse).
		const internal = !nonUsdc && isInternal(counterparty);
		events.push({
			type: internal ? 'internal' : 'leak',
			asset: nonUsdc ? (before.mint || 'token') : 'USDC',
			counterparty, amountAtomic: Number(delta),
			reason: nonUsdc ? 'non_usdc_token_out' : (internal ? 'usdc_transfer_internal' : 'usdc_to_unknown'),
		});
	}

	// ── Residual SOL: any unexplained lamport debit is a LEAK ────────────────
	const pre0 = Number(meta.preBalances?.[walletIdx]);
	const post0 = Number(meta.postBalances?.[walletIdx]);
	if (Number.isFinite(pre0) && Number.isFinite(post0)) {
		const solDebit = pre0 - post0;
		const explained = (feeOurs ? feeLamports : 0) + accountedSolOut;
		const residual = solDebit - explained;
		if (residual > SOL_RESIDUAL_FLOOR_LAMPORTS) {
			events.push({
				type: 'leak', asset: 'SOL', counterparty: null, amountAtomic: residual,
				reason: 'unexplained_sol_debit',
			});
		}
	}

	return { unreadable: false, signature, fee, events };
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function ensureSchema() {
	try {
		await withDbRetry(() => sql`
			CREATE TABLE IF NOT EXISTS x402_ring_scan_cursor (
				wallet          text PRIMARY KEY,
				last_signature  text,
				last_slot       bigint,
				scanned_total   bigint NOT NULL DEFAULT 0,
				leaks_total     bigint NOT NULL DEFAULT 0,
				last_run_id     uuid,
				updated_at      timestamptz NOT NULL DEFAULT now()
			)
		`);
	} catch { /* migration owns it */ }
	try {
		await withDbRetry(() => sql`
			CREATE TABLE IF NOT EXISTS x402_ring_fee_observed (
				day          date PRIMARY KEY,
				fee_lamports bigint NOT NULL DEFAULT 0,
				tx_count     bigint NOT NULL DEFAULT 0,
				updated_at   timestamptz NOT NULL DEFAULT now()
			)
		`);
	} catch { /* migration owns it */ }
}

async function loadCursor(wallet) {
	try {
		const [row] = await withDbRetry(() => sql`
			SELECT last_signature, scanned_total, leaks_total
			FROM x402_ring_scan_cursor WHERE wallet = ${wallet}
		`);
		return row || null;
	} catch { return null; }
}

async function saveCursor(wallet, { lastSignature, lastSlot, scannedDelta, leaksDelta, runId }) {
	try {
		await withDbRetry(() => sql`
			INSERT INTO x402_ring_scan_cursor
				(wallet, last_signature, last_slot, scanned_total, leaks_total, last_run_id, updated_at)
			VALUES (${wallet}, ${lastSignature}, ${lastSlot}, ${scannedDelta}, ${leaksDelta}, ${runId}, now())
			ON CONFLICT (wallet) DO UPDATE SET
				last_signature = COALESCE(EXCLUDED.last_signature, x402_ring_scan_cursor.last_signature),
				last_slot      = COALESCE(EXCLUDED.last_slot, x402_ring_scan_cursor.last_slot),
				scanned_total  = x402_ring_scan_cursor.scanned_total + ${scannedDelta},
				leaks_total    = x402_ring_scan_cursor.leaks_total + ${leaksDelta},
				last_run_id    = EXCLUDED.last_run_id,
				updated_at     = now()
		`);
	} catch (err) {
		console.warn('[ring-leak-scan] cursor upsert failed', { wallet, message: err?.message });
	}
}

async function accrueObservedFee(dayToLamports) {
	for (const [day, { lamports, count }] of dayToLamports) {
		if (lamports <= 0 && count <= 0) continue;
		try {
			await withDbRetry(() => sql`
				INSERT INTO x402_ring_fee_observed (day, fee_lamports, tx_count, updated_at)
				VALUES (${day}::date, ${lamports}, ${count}, now())
				ON CONFLICT (day) DO UPDATE SET
					fee_lamports = x402_ring_fee_observed.fee_lamports + ${lamports},
					tx_count     = x402_ring_fee_observed.tx_count + ${count},
					updated_at   = now()
			`);
		} catch (err) {
			console.warn('[ring-leak-scan] fee rollup upsert failed', { day, message: err?.message });
		}
	}
}

async function upsertVerdict(v) {
	try {
		await withDbRetry(() => sql`
			INSERT INTO payment_reconciliation
				(source, source_ref, tx_signature, network, amount_atomic,
				 db_status, chain_status, reconciled, discrepancy, detail, run_id, checked_at)
			VALUES
				(${v.source}, ${v.sourceRef}, ${v.txSig}, ${v.network}, ${v.amountAtomic},
				 ${v.dbStatus}, ${v.chainStatus}, ${v.reconciled}, ${v.discrepancy},
				 ${v.detail ? JSON.stringify(v.detail) : null}, ${v.runId}, now())
			ON CONFLICT (source, source_ref) DO UPDATE SET
				tx_signature = EXCLUDED.tx_signature,
				network = EXCLUDED.network,
				amount_atomic = EXCLUDED.amount_atomic,
				db_status = EXCLUDED.db_status,
				chain_status = EXCLUDED.chain_status,
				reconciled = EXCLUDED.reconciled,
				discrepancy = EXCLUDED.discrepancy,
				detail = EXCLUDED.detail,
				run_id = EXCLUDED.run_id,
				checked_at = now()
		`);
	} catch (err) {
		console.warn('[ring-leak-scan] verdict upsert failed', { ref: v.sourceRef, message: err?.message });
	}
}

/** UTC day string for a blockTime (unix seconds), or today when absent. */
function dayOf(blockTime, nowMs) {
	const ms = blockTime ? blockTime * 1000 : nowMs;
	return new Date(ms).toISOString().slice(0, 10);
}

// ── Wallets to scan ───────────────────────────────────────────────────────────

/** The ring wallets that actually hold/move funds: the role wallets + registry. */
async function ringScanWallets() {
	const out = new Set();
	const roles = await ringRoleWallets();
	for (const pk of Object.values(roles)) if (pk) out.add(pk);
	try {
		const rows = await withDbRetry(() => sql`SELECT pubkey FROM x402_ring_wallets WHERE enabled = true`);
		for (const r of rows) if (r?.pubkey) out.add(r.pubkey);
	} catch { /* env-derived set stands */ }
	return [...out];
}

// ── Per-wallet scan ───────────────────────────────────────────────────────────

export async function scanWallet(conn, PublicKey, wallet, { allowed, usdcMint, runId, feeByDay }) {
	const summary = { wallet, scanned: 0, leaks: 0, delegations: 0, truncated: false };
	const cursor = await loadCursor(wallet);

	let sigInfos = [];
	try {
		const opts = { limit: SIG_SCAN_LIMIT };
		if (cursor?.last_signature) opts.until = cursor.last_signature;
		sigInfos = await conn.getSignaturesForAddress(new PublicKey(wallet), opts);
	} catch (err) {
		summary.error = err?.message || 'sig_fetch_failed';
		return summary;
	}
	if (sigInfos.length === 0) return summary;
	summary.truncated = sigInfos.length >= SIG_SCAN_LIMIT && !!cursor?.last_signature;

	// getSignaturesForAddress returns newest→oldest.
	const signatures = sigInfos.map((s) => s.signature);
	const slotBySig = new Map(sigInfos.map((s) => [s.signature, s.slot ?? null]));
	const blockTimeBySig = new Map(sigInfos.map((s) => [s.signature, s.blockTime ?? null]));

	// Batched parsed fetch.
	const parsed = [];
	for (let i = 0; i < signatures.length; i += PARSED_BATCH) {
		const batch = signatures.slice(i, i + PARSED_BATCH);
		try {
			const got = await conn.getParsedTransactions(batch, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
			parsed.push(...got);
		} catch {
			// Fall back to per-sig on a batch failure so one bad sig can't blind the run.
			for (const s of batch) {
				try { parsed.push(await conn.getParsedTransaction(s, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })); }
				catch { parsed.push(null); }
			}
		}
	}

	let scannedDelta = 0;
	let leaksDelta = 0;
	const nowMs = Date.now();

	// Cursor advance (getSignaturesForAddress `until` returns sigs NEWER than the
	// cursor). To never silently skip an unreadable tx — which could hide a leak —
	// the new cursor is the newest signature OLDER than the last (oldest-indexed)
	// unreadable one, so that tx and everything older is refetched next run. A
	// transient null self-heals in one extra run; a few already-scanned txs newer
	// than it are reprocessed idempotently (upsert + alert dedup). If the OLDEST
	// sig in the window is unreadable there is nothing older to anchor to → keep
	// the previous cursor and retry the whole window.
	let lastNullIdx = -1;
	for (let i = 0; i < parsed.length; i++) if (!parsed[i]) lastNullIdx = i;
	let cursorSig = cursor?.last_signature ?? null;
	let cursorSlot = null;
	if (lastNullIdx < parsed.length - 1) {
		const anchor = signatures[lastNullIdx + 1]; // newest readable older than every unreadable
		cursorSig = anchor;
		cursorSlot = slotBySig.get(anchor);
	}

	for (let i = 0; i < parsed.length; i++) {
		const tx = parsed[i];
		const sig = signatures[i];
		if (!tx) continue; // unreadable — refetched next run (cursor anchored older)
		scannedDelta += 1;

		const { unreadable, fee, events } = classifyWalletDebits(tx, { wallet, allowed, usdcMint });
		if (unreadable) continue;

		// Accrue the network fee our wallet paid, bucketed by UTC day.
		if (fee.ours && fee.lamports > 0) {
			const day = dayOf(blockTimeBySig.get(sig), nowMs);
			const cur = feeByDay.get(day) || { lamports: 0, count: 0 };
			cur.lamports += fee.lamports; cur.count += 1;
			feeByDay.set(day, cur);
		}

		for (const ev of events) {
			if (ev.type === 'internal') continue;

			summary[ev.type === 'delegation' ? 'delegations' : 'leaks'] += 1;
			leaksDelta += 1;

			const isDelegation = ev.type === 'delegation';
			await upsertVerdict({
				source: 'x402_ring_onchain',
				sourceRef: `${sig}:${wallet}:${ev.asset}:${ev.reason}`,
				txSig: sig, network: 'mainnet', amountAtomic: ev.amountAtomic,
				dbStatus: isDelegation ? 'delegation_risk' : 'onchain_leak',
				chainStatus: ev.reason, reconciled: false,
				discrepancy: isDelegation
					? `SPL approve on ring ATA of ${wallet} → delegate ${ev.counterparty}`
					: `${ev.asset} left ${wallet} to ${ev.counterparty ?? 'unknown'} (${ev.reason})`,
				detail: { wallet, asset: ev.asset, counterparty: ev.counterparty, reason: ev.reason, amountAtomic: ev.amountAtomic },
				runId,
			});

			const amtLabel = ev.asset === 'SOL'
				? `${(ev.amountAtomic / 1e9).toFixed(6)} SOL`
				: `${ev.amountAtomic} ${ev.asset} atoms`;
			await sendOpsAlert(
				isDelegation ? '🚨 x402 ring delegation risk — SPL Approve on a ring ATA' : '🚨 x402 ring LEAK — funds left the controlled set',
				isDelegation
					? `Ring wallet ${wallet} approved delegate ${ev.counterparty} to move ${amtLabel} in tx ${sig}. A delegate can drain the account later. ROTATE the wallet's secret and revoke the approval now. https://solscan.io/tx/${sig}`
					: `${amtLabel} left ring wallet ${wallet} to ${ev.counterparty ?? 'an unknown address'} (${ev.reason}) in tx ${sig}. This should be impossible in the closed loop — treat the wallet's key as COMPROMISED: rotate its secret, drain remaining funds to the treasury, and re-verify with scripts/x402-ring-verify.mjs. https://solscan.io/tx/${sig}`,
				{ signature: `ring-leak:${sig}:${wallet}:${ev.reason}` },
			);
		}
	}

	summary.scanned = scannedDelta;
	summary.leaks_and_delegations = leaksDelta;
	// Only persist a cursor we actually advanced to (cursorSig is null only on a
	// first run whose entire window was unreadable — nothing to anchor, retry all).
	if (cursorSig) {
		await saveCursor(wallet, { lastSignature: cursorSig, lastSlot: cursorSlot, scannedDelta, leaksDelta, runId });
	}

	if (summary.truncated) {
		console.warn('[ring-leak-scan] sig backlog', { wallet, note: `>=${SIG_SCAN_LIMIT} new sigs in one run` });
	}
	return summary;
}

// ── Fee-book cross-check ──────────────────────────────────────────────────────

/** |observed - audited| / max(...). null when either side is unknown/zero. */
export function feeDivergence(observed, audited) {
	if (observed == null || audited == null) return null;
	const a = Number(observed);
	const b = Number(audited);
	if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
	const denom = Math.max(a, b);
	if (denom <= 0) return null;
	return Math.abs(a - b) / denom;
}

async function crossCheckFees(runId, nowMs) {
	// Compare the last complete UTC day's observed on-chain fees against task 05's
	// fee-audit rollup. Divergence ⇒ fees paid outside the ring's accounting.
	const day = new Date(nowMs - 86_400_000).toISOString().slice(0, 10);
	let observed = null;
	let audited = null;
	try {
		const [row] = await withDbRetry(() => sql`SELECT fee_lamports FROM x402_ring_fee_observed WHERE day = ${day}::date`);
		observed = row ? Number(row.fee_lamports) : null;
	} catch { /* table absent → skip */ }
	try {
		const [row] = await withDbRetry(() => sql`SELECT total_fee_lamports FROM x402_fee_audit WHERE day = ${day}::date`);
		audited = row ? Number(row.total_fee_lamports) : null;
	} catch { /* task 05 audit not present yet → skip cross-check */ }

	if (observed == null || audited == null) return { day, observed, audited, divergence: null, skipped: true };
	const divergence = feeDivergence(observed, audited);
	if (divergence != null && divergence > FEE_DIVERGENCE_THRESHOLD) {
		await upsertVerdict({
			source: 'x402_ring_onchain', sourceRef: `fee-coherence:${day}`, txSig: null, network: 'mainnet',
			amountAtomic: observed, dbStatus: 'fees_observed_onchain', chainStatus: 'fee_divergence', reconciled: false,
			discrepancy: `on-chain fees diverge ${(divergence * 100).toFixed(1)}% from the fee-audit rollup on ${day}`,
			detail: { day, observed_lamports: observed, audited_lamports: audited, divergence }, runId,
		});
		await sendOpsAlert(
			'⚠️ x402 ring fee books diverge — fees paid outside the ring accounting',
			`On ${day} ring wallets burned ${observed} lamports in network fees on-chain, but the fee-audit rollup recorded ${audited}. A >${(FEE_DIVERGENCE_THRESHOLD * 100).toFixed(0)}% gap means something outside the ring's accounting is paying fees from our wallets. Reconcile x402_ring_fee_observed vs x402_fee_audit for ${day}.`,
			{ signature: `ring-fee-divergence:${day}` },
		);
	}
	return { day, observed, audited, divergence };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const runId = randomUUID();
	const nowMs = Date.now();
	await ensureSchema();

	const { PublicKey } = await import('@solana/web3.js');
	const { solanaConnection } = await import('../_lib/solana/connection.js');
	const conn = solanaConnection({
		url: process.env.SOLANA_RPC_URL || env.SOLANA_RPC_URL,
		network: 'mainnet', commitment: 'confirmed',
	});

	const [allowed, wallets] = await Promise.all([ringAllowedAddresses(), ringScanWallets()]);
	const usdcMint = env.X402_ASSET_MINT_SOLANA;

	if (wallets.length === 0) {
		return json(res, 200, { ok: true, run_id: runId, skipped: true, reason: 'no_ring_wallets_configured' });
	}

	const feeByDay = new Map();
	const results = [];
	let leaks = 0;
	let delegations = 0;
	for (const wallet of wallets) {
		try {
			const s = await scanWallet(conn, PublicKey, wallet, { allowed, usdcMint, runId, feeByDay });
			results.push(s);
			leaks += s.leaks || 0;
			delegations += s.delegations || 0;
		} catch (err) {
			results.push({ wallet, error: err?.message || 'scan_failed' });
		}
	}

	await accrueObservedFee(feeByDay);
	const feeCheck = await crossCheckFees(runId, nowMs);

	return json(res, 200, {
		ok: true,
		run_id: runId,
		wallets: wallets.length,
		allowed_set_size: allowed.size,
		leaks,
		delegations,
		fee_cross_check: feeCheck,
		results,
	});
});
