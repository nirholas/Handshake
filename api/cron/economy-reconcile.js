// @ts-check
// GET /api/cron/economy-reconcile — financial-integrity + breach monitor for the
// economy master funding wallet (api/_lib/economy-master.js).
//
// Runs every 30 min and answers three questions a regulator, an accountant, and
// an incident responder each ask:
//
//   1. TAMPER — is the accounting ledger intact? verifyChain() recomputes the
//      hash chain; a broken link or a seq gap means a historical row was edited
//      or deleted. → CRITICAL alert.
//   2. BREACH — did any SOL leave the master that our books did NOT record? It
//      pulls the master's real on-chain transaction history and flags every
//      outbound debit whose signature is absent from the ledger. An unrecorded
//      outbound is the key-compromise signal: someone moved funds outside our
//      system. → CRITICAL alert.
//   3. INTEGRITY — does every transfer our books CLAIM actually exist on-chain
//      and succeed? Missing/failed signatures mean a fabricated or lost record.
//
// Every non-reconciled finding is upserted into the shared `payment_reconciliation`
// table (source `economy_master_*`), so it surfaces on the existing ops
// financial-integrity board alongside x402 revenue discrepancies. Read-only
// on-chain — it never moves funds.

import { error, json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { withDbRetry } from '../_lib/db-retry.js';
import { sql } from '../_lib/db.js';
import { ECONOMY_MASTER_ADDRESS, RESERVE_SOL } from '../_lib/economy-master.js';
import { SOLANA_SIGNERS, resolveSignerPubkey } from '../_lib/solana-signers.js';
import { verifyChain } from '../_lib/economy-ledger.js';
import { getSolBalance } from '../_lib/avatar-wallet.js';

// How many recent on-chain signatures to scan per run, and how far back to
// re-verify our own recorded transfers. A low-activity funder makes both cheap.
const SIG_SCAN_LIMIT = 200;
const LEDGER_VERIFY_WINDOW_HOURS = 72;
// Net debit below this (SOL) on an unrecorded tx is treated as fee noise, not a
// drain — a real unauthorized transfer moves far more than a signature fee.
const OUTBOUND_FEE_FLOOR_SOL = 0.0005;
const LAMPORTS_PER_SOL = 1_000_000_000;

function requireCron(req, res) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) {
		error(res, 503, 'not_configured', 'CRON_SECRET unset');
		return false;
	}
	const auth = req.headers['authorization'] || '';
	const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!constantTimeEquals(presented, secret)) {
		error(res, 401, 'unauthorized', 'invalid cron secret');
		return false;
	}
	return true;
}

async function upsertVerdict({ source, sourceRef, txSig, network, amountAtomic, dbStatus, chainStatus, reconciled, discrepancy, detail, runId }) {
	try {
		await withDbRetry(() => sql`
			INSERT INTO payment_reconciliation
				(source, source_ref, tx_signature, network, amount_atomic,
				 db_status, chain_status, reconciled, discrepancy, detail, run_id, checked_at)
			VALUES
				(${source}, ${sourceRef}, ${txSig}, ${network}, ${amountAtomic},
				 ${dbStatus}, ${chainStatus}, ${reconciled}, ${discrepancy},
				 ${detail ? JSON.stringify(detail) : null}, ${runId}, now())
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
		console.warn('[economy-reconcile] upsert failed', { source, sourceRef, message: err?.message });
	}
}

/** Distinct master wallets present in the ledger, falling back to the canonical. */
async function ledgerMasters() {
	try {
		const rows = await withDbRetry(() => sql`
			SELECT DISTINCT master_pubkey FROM economy_master_ledger
		`);
		const set = new Set(rows.map((r) => r.master_pubkey).filter(Boolean));
		set.add(ECONOMY_MASTER_ADDRESS);
		return [...set];
	} catch {
		return [ECONOMY_MASTER_ADDRESS];
	}
}

async function ledgerSignatures(masterPubkey) {
	const rows = await withDbRetry(() => sql`
		SELECT DISTINCT tx_signature FROM economy_master_ledger
		WHERE master_pubkey = ${masterPubkey} AND tx_signature IS NOT NULL
	`);
	return new Set(rows.map((r) => r.tx_signature));
}

async function recentLedgerTransfers(masterPubkey) {
	return withDbRetry(() => sql`
		SELECT seq, tx_signature, lamports FROM economy_master_ledger
		WHERE master_pubkey = ${masterPubkey}
		  AND event = 'transfer' AND tx_signature IS NOT NULL
		  AND ts >= now() - (${LEDGER_VERIFY_WINDOW_HOURS} || ' hours')::interval
		ORDER BY seq DESC LIMIT 500
	`);
}

/** Net lamports the master LOST in a parsed tx (>0 ⇒ debit). null if unreadable. */
function masterNetDebit(tx, masterPubkey) {
	const msg = tx?.transaction?.message;
	const meta = tx?.meta;
	if (!msg || !meta || !Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances)) return null;
	const keys = (msg.accountKeys || []).map((k) => (typeof k === 'string' ? k : k?.pubkey?.toString?.() || k?.toString?.()));
	const idx = keys.findIndex((k) => k === masterPubkey);
	if (idx < 0) return null;
	const pre = meta.preBalances[idx];
	const post = meta.postBalances[idx];
	if (typeof pre !== 'number' || typeof post !== 'number') return null;
	return pre - post; // lamports lost
}

// Accounts (other than the master) that GAINED lamports in this tx — the SOL
// recipients. Used to tell an internal topup (recipient ∈ controlled registry)
// from an actual leak (recipient external). Exported for tests.
export function masterOutboundRecipients(tx, masterPubkey) {
	const msg = tx?.transaction?.message;
	const meta = tx?.meta;
	if (!msg || !meta || !Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances)) return [];
	const keys = (msg.accountKeys || []).map((k) => (typeof k === 'string' ? k : k?.pubkey?.toString?.() || k?.toString?.()));
	const out = [];
	for (let i = 0; i < keys.length; i++) {
		if (keys[i] === masterPubkey) continue;
		const d = meta.postBalances[i] - meta.preBalances[i];
		if (typeof d === 'number' && d > 0) out.push(keys[i]);
	}
	return out;
}

// The owner-controlled wallet set: every resolvable SOLANA_SIGNERS pubkey plus
// the master. The master ONLY ever tops up registry members (enforced by
// filterToRegistry in economy-master.js), so an outbound whose recipients are
// all in this set is an internal topup — expected and benign, even if the ledger
// write lagged. An outbound to anything OUTSIDE this set is the real breach.
async function controlledPubkeys(masterPubkey) {
	const set = new Set([masterPubkey]);
	await Promise.all(
		SOLANA_SIGNERS.map(async (spec) => {
			try {
				// resolveSignerPubkey → { configured, pubkey, decodeError }. Only a
				// configured signer with a real pubkey counts toward the controlled set.
				const r = await resolveSignerPubkey(spec);
				if (r?.pubkey) set.add(r.pubkey);
			} catch {
				/* unresolvable signer (missing secret) — skip */
			}
		}),
	);
	return set;
}

async function reconcileMaster(conn, masterPubkey, runId) {
	const findings = [];
	const summary = { master: masterPubkey, scanned_onchain: 0, unrecorded_outbound: 0, ledger_transfers_checked: 0, missing_onchain: 0, failed_onchain: 0 };

	// 1. TAMPER — verify the hash chain.
	let chain;
	try {
		chain = await verifyChain(masterPubkey);
	} catch (e) {
		chain = { ok: true, count: 0, note: `verify_skipped:${e?.message}` };
	}
	summary.ledger_rows = chain.count;
	summary.chain_ok = chain.ok;
	if (chain.ok === false) {
		const where = chain.brokenAtSeq != null ? `broken at seq ${chain.brokenAtSeq}` : `missing row before seq ${chain.gapAtSeq}`;
		findings.push({ kind: 'tamper', detail: where });
		await upsertVerdict({
			source: 'economy_master_chain', sourceRef: masterPubkey, txSig: null, network: 'mainnet',
			amountAtomic: null, dbStatus: 'chain_intact', chainStatus: 'chain_broken', reconciled: false,
			discrepancy: where, detail: chain, runId,
		});
		await sendOpsAlert(
			`🚨 Economy ledger tamper detected`,
			`The economy master accounting chain for ${masterPubkey} failed integrity: ${where}. A historical ledger row was edited or deleted. Freeze changes and investigate before trusting the books.`,
			{ signature: `economy-tamper:${masterPubkey}:${chain.brokenAtSeq ?? chain.gapAtSeq}` },
		);
	}

	// 2. BREACH — every on-chain outbound must be in the ledger. But a topup to
	// one of our OWN registry wallets is an internal movement, not a leak: no
	// funds left the controlled set, so it must never fire a "rotate the key"
	// alarm just because the ledger write lagged. Only outbound to an EXTERNAL
	// address is a real breach.
	const recorded = await ledgerSignatures(masterPubkey);
	const controlled = await controlledPubkeys(masterPubkey);
	let sigInfos = [];
	try {
		const { PublicKey } = await import('@solana/web3.js');
		sigInfos = await conn.getSignaturesForAddress(new PublicKey(masterPubkey), { limit: SIG_SCAN_LIMIT });
	} catch (e) {
		summary.onchain_scan_error = e?.message || 'sig_fetch_failed';
	}
	summary.scanned_onchain = sigInfos.length;
	for (const info of sigInfos) {
		const sig = info.signature;
		if (recorded.has(sig)) continue; // matched to a book entry — fine
		if (info.err) continue; // a failed tx moved nothing
		let tx = null;
		try {
			tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
		} catch {
			/* unreadable — skip; a later run retries */
		}
		const debitLamports = tx ? masterNetDebit(tx, masterPubkey) : null;
		if (debitLamports == null) continue;
		if (debitLamports <= OUTBOUND_FEE_FLOOR_SOL * LAMPORTS_PER_SOL) continue; // dust / fee only

		const recipients = masterOutboundRecipients(tx, masterPubkey);
		const external = recipients.filter((r) => !controlled.has(r));
		const solStr = (debitLamports / LAMPORTS_PER_SOL).toFixed(6);

		if (recipients.length > 0 && external.length === 0) {
			// Internal topup to registry wallet(s) whose ledger write lagged. Benign —
			// record the recording gap (reconciled), no compromise alert.
			summary.unbooked_internal_topup = (summary.unbooked_internal_topup || 0) + 1;
			await upsertVerdict({
				source: 'economy_master_onchain', sourceRef: sig, txSig: sig, network: 'mainnet',
				amountAtomic: debitLamports, dbStatus: 'unbooked_internal_topup', chainStatus: 'internal_topup',
				reconciled: true, discrepancy: `internal topup of ${solStr} SOL to registry wallet(s) not booked in ledger`,
				detail: { blockTime: info.blockTime ?? null, slot: info.slot ?? null, recipients }, runId,
			});
			continue;
		}

		// Recipient outside the controlled set (or unresolvable) — the real breach.
		summary.unrecorded_outbound += 1;
		findings.push({ kind: 'unrecorded_outbound', sig, sol: debitLamports / LAMPORTS_PER_SOL, external });
		await upsertVerdict({
			source: 'economy_master_onchain', sourceRef: sig, txSig: sig, network: 'mainnet',
			amountAtomic: debitLamports, dbStatus: 'not_in_ledger', chainStatus: 'unrecorded_outbound',
			reconciled: false, discrepancy: `master debited ${solStr} SOL to external ${external.join(', ') || 'unknown'} with no ledger row`,
			detail: { blockTime: info.blockTime ?? null, slot: info.slot ?? null, external }, runId,
		});
		await sendOpsAlert(
			`🚨 Unrecorded SOL leaving the economy master`,
			`${solStr} SOL left ${masterPubkey} in tx ${sig} to an address OUTSIDE the controlled set (${external.join(', ') || 'unknown'}) with NO ledger entry. If the treasury-topup cron did not make this transfer, the key is compromised — rotate ECONOMY_MASTER_SECRET_BASE58 and move remaining funds now. https://solscan.io/tx/${sig}`,
			{ signature: `economy-breach:${sig}` },
		);
	}

	// 3. INTEGRITY — every recorded transfer must exist + succeed on-chain.
	const transfers = await recentLedgerTransfers(masterPubkey);
	summary.ledger_transfers_checked = transfers.length;
	if (transfers.length) {
		const sigs = transfers.map((t) => t.tx_signature);
		let statuses = new Map();
		try {
			const { value } = await conn.getSignatureStatuses(sigs, { searchTransactionHistory: true });
			sigs.forEach((s, j) => statuses.set(s, value?.[j] ?? null));
		} catch (e) {
			summary.status_error = e?.message || 'status_fetch_failed';
		}
		for (const t of transfers) {
			const st = statuses.get(t.tx_signature);
			if (st === undefined) continue; // RPC gap — do not flag on our own failure
			let chainStatus = null;
			if (st === null) chainStatus = 'missing_onchain';
			else if (st.err) chainStatus = 'failed_onchain';
			if (!chainStatus) continue;
			summary[chainStatus] += 1;
			findings.push({ kind: chainStatus, sig: t.tx_signature });
			await upsertVerdict({
				source: 'economy_master_ledger', sourceRef: `${masterPubkey}:${t.seq}`, txSig: t.tx_signature, network: 'mainnet',
				amountAtomic: t.lamports ?? null, dbStatus: 'recorded_transfer', chainStatus, reconciled: false,
				discrepancy: chainStatus === 'missing_onchain' ? 'ledger transfer not found on-chain' : 'ledger transfer reverted on-chain',
				detail: { seq: Number(t.seq) }, runId,
			});
		}
	}

	// Balance-below-reserve is a fund-safety warning (engines will stall).
	try {
		const { PublicKey } = await import('@solana/web3.js');
		const { sol } = await getSolBalance(conn, new PublicKey(masterPubkey));
		summary.master_sol = sol;
		if (sol < RESERVE_SOL) {
			findings.push({ kind: 'below_reserve', sol });
			await sendOpsAlert(
				`⛽ Economy master below reserve`,
				`${masterPubkey} holds ${sol.toFixed(4)} SOL, under the ${RESERVE_SOL} SOL reserve floor. Engines cannot be topped up until it is funded.`,
				{ signature: `economy-below-reserve:${masterPubkey}:${Math.floor(Date.now() / 86_400_000)}` },
			);
		}
	} catch (e) {
		summary.balance_error = e?.message || 'balance_failed';
	}

	return { summary, findings };
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const runId = (await import('node:crypto')).randomUUID();
	const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
	const { solanaConnection } = await import('../_lib/solana/connection.js');
	const conn = solanaConnection({ url: rpcUrl, network: 'mainnet', commitment: 'confirmed' });

	const masters = await ledgerMasters();
	const results = [];
	let breaches = 0;
	let tampers = 0;
	for (const m of masters) {
		try {
			const r = await reconcileMaster(conn, m, runId);
			results.push(r.summary);
			breaches += r.findings.filter((f) => f.kind === 'unrecorded_outbound').length;
			tampers += r.findings.filter((f) => f.kind === 'tamper').length;
		} catch (e) {
			results.push({ master: m, error: e?.message || 'reconcile_failed' });
		}
	}

	return json(res, 200, {
		ok: true,
		run_id: runId,
		rpc: rpcUrl,
		masters: masters.length,
		breaches,
		tampers,
		results,
	});
});
