// GET/POST /api/cron/wallets-leak-scan — general on-chain leak scanner.
//
// The ring leak scanner (api/cron/x402-ring-leak-scan.js) watches only the x402
// ring role wallets — a SUBSET of what the platform controls. This closes the
// gap: it watches EVERY resolvable SOLANA_SIGNERS mainnet wallet (economy master,
// coin-launcher master, platform/coin/club/buyback/circulation treasuries, x402
// sponsor/payer, SNS parent, gasless fee-payer, …) and alarms if SOL or a
// non-fee token debit ever leaves one of them to an address OUTSIDE the
// controlled-wallet universe (ringAllowedAddresses()).
//
// It reuses the ring scanner's audited pure classifier (classifyWalletDebits) so
// there is one classification of "internal vs network-fee vs LEAK vs delegation",
// not two that drift. Its own cursor table (wallet_scan_cursor) and verdict source
// ('wallets_onchain') keep it independent of the ring scan. Read-only on chain,
// never moves funds, CRON_SECRET-authed, bounded (≤100 sigs/wallet/run).

import { randomUUID } from 'node:crypto';
import { error, json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { sql } from '../_lib/db.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { SOLANA_SIGNERS, resolveSignerPubkey } from '../_lib/solana-signers.js';
import { ringAllowedAddresses } from '../_lib/x402/ring-allowlist.js';
import { classifyWalletDebits } from './x402-ring-leak-scan.js';
import { runTripwire, lastActivityMs } from '../_lib/financial-tripwire.js';

const SIG_LIMIT = 100;
const CANONICAL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function requireCron(req, res) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) { error(res, 503, 'not_configured', 'CRON_SECRET unset'); return false; }
	const auth = req.headers['authorization'] || '';
	const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!constantTimeEquals(presented, secret)) { error(res, 401, 'unauthorized', 'invalid cron secret'); return false; }
	return true;
}

async function ensureSchema() {
	await sql`
		CREATE TABLE IF NOT EXISTS wallet_scan_cursor (
			wallet          text PRIMARY KEY,
			wallet_name     text,
			last_signature  text,
			last_slot       bigint,
			scanned_total   bigint      NOT NULL DEFAULT 0,
			leaks_total     bigint      NOT NULL DEFAULT 0,
			last_run_id     uuid,
			updated_at      timestamptz NOT NULL DEFAULT now()
		)
	`;
}

async function loadCursor(wallet) {
	const [row] = await sql`SELECT last_signature FROM wallet_scan_cursor WHERE wallet = ${wallet}`;
	return row?.last_signature ?? null;
}

async function saveCursor(wallet, name, { lastSignature, lastSlot, scannedDelta, leaksDelta, runId }) {
	await sql`
		INSERT INTO wallet_scan_cursor (wallet, wallet_name, last_signature, last_slot, scanned_total, leaks_total, last_run_id, updated_at)
		VALUES (${wallet}, ${name}, ${lastSignature}, ${lastSlot ?? null}, ${scannedDelta}, ${leaksDelta}, ${runId}, now())
		ON CONFLICT (wallet) DO UPDATE SET
			wallet_name = EXCLUDED.wallet_name,
			last_signature = EXCLUDED.last_signature,
			last_slot = EXCLUDED.last_slot,
			scanned_total = wallet_scan_cursor.scanned_total + EXCLUDED.scanned_total,
			leaks_total = wallet_scan_cursor.leaks_total + EXCLUDED.leaks_total,
			last_run_id = EXCLUDED.last_run_id,
			updated_at = now()
	`;
}

async function upsertVerdict(v) {
	try {
		await sql`
			INSERT INTO payment_reconciliation
				(source, source_ref, tx_signature, network, amount_atomic,
				 db_status, chain_status, reconciled, discrepancy, detail, run_id, checked_at)
			VALUES
				(${v.source}, ${v.sourceRef}, ${v.txSig}, ${v.network}, ${v.amountAtomic},
				 ${v.dbStatus}, ${v.chainStatus}, ${v.reconciled}, ${v.discrepancy},
				 ${v.detail ? JSON.stringify(v.detail) : null}, ${v.runId}, now())
			ON CONFLICT (source, source_ref) DO UPDATE SET
				tx_signature = EXCLUDED.tx_signature, network = EXCLUDED.network,
				amount_atomic = EXCLUDED.amount_atomic, db_status = EXCLUDED.db_status,
				chain_status = EXCLUDED.chain_status, reconciled = EXCLUDED.reconciled,
				discrepancy = EXCLUDED.discrepancy, detail = EXCLUDED.detail,
				run_id = EXCLUDED.run_id, checked_at = now()
		`;
	} catch (err) {
		console.warn('[wallets-leak-scan] verdict upsert failed', { ref: v.sourceRef, message: err?.message });
	}
}

/** Pure: is this signer spec a mainnet wallet we should scan? (Devnet wallets
 *  never hold real funds, so they are skipped.) */
export function isScannableSpec(spec) {
	return !!spec && spec.network !== 'devnet';
}

/** Pure: dedupe resolved {pubkey,name} pairs by pubkey (fallback envs can point
 *  two specs at the same wallet — scan it once, keep the first name). */
export function dedupeWallets(pairs) {
	const out = new Map();
	for (const p of pairs || []) {
		if (p?.pubkey && !out.has(p.pubkey)) out.set(p.pubkey, p.name);
	}
	return [...out].map(([pubkey, name]) => ({ pubkey, name }));
}

/** Every resolvable mainnet controlled wallet from the registry. Devnet and
 *  unconfigured/undecodable signers are skipped; duplicates collapsed. */
export async function scannableWallets() {
	const resolved = [];
	for (const spec of SOLANA_SIGNERS) {
		if (!isScannableSpec(spec)) continue;
		const r = await resolveSignerPubkey(spec);
		if (!r.configured || r.decodeError || !r.pubkey) continue;
		resolved.push({ pubkey: r.pubkey, name: spec.name });
	}
	return dedupeWallets(resolved);
}

async function scanOne(conn, PublicKey, wallet, name, allowed, runId) {
	let scannedDelta = 0, leaksDelta = 0;
	const cursorSig = await loadCursor(wallet);
	let sigInfos;
	try {
		sigInfos = await conn.getSignaturesForAddress(new PublicKey(wallet), { limit: SIG_LIMIT, ...(cursorSig ? { until: cursorSig } : {}) });
	} catch (err) {
		console.warn('[wallets-leak-scan] getSignatures failed', { wallet, err: err?.message });
		return { scannedDelta, leaksDelta, error: true };
	}
	if (!sigInfos.length) return { scannedDelta, leaksDelta };

	// newest → oldest; process oldest→newest so the cursor advances to the newest.
	const signatures = sigInfos.map((s) => s.signature);
	// Fetch in chunks with a per-signature fallback. A single batch over ALL
	// signatures 500s against RPC providers that cap `getTransaction` batches
	// (the public node allows 1), which used to abort the whole scan and — worse —
	// surface as an unhandled 5xx. On any batch failure, drop to one-at-a-time so
	// one restrictive provider can't blind the leak scanner. Mirrors
	// x402-ring-leak-scan's resilient fetch.
	const PARSED_BATCH = 25;
	const parsed = [];
	for (let i = 0; i < signatures.length; i += PARSED_BATCH) {
		const chunk = signatures.slice(i, i + PARSED_BATCH);
		try {
			const got = await conn.getParsedTransactions(chunk, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
			parsed.push(...got);
		} catch {
			for (const s of chunk) {
				try {
					parsed.push(await conn.getParsedTransaction(s, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }));
				} catch {
					parsed.push(null); // unreadable — skipped below, retried next run
				}
			}
		}
	}

	for (let i = signatures.length - 1; i >= 0; i--) {
		const tx = parsed[i];
		if (!tx) continue;
		scannedDelta += 1;
		const { unreadable, events } = classifyWalletDebits(tx, { wallet, allowed, usdcMint: env.X402_ASSET_MINT_SOLANA || CANONICAL_USDC });
		if (unreadable) continue;
		for (const ev of events) {
			if (ev.type === 'internal') continue;
			leaksDelta += 1;
			const sig = signatures[i];
			const isDelegation = ev.type === 'delegation';
			await upsertVerdict({
				source: 'wallets_onchain',
				sourceRef: `${sig}:${wallet}:${ev.asset}:${ev.reason}`,
				txSig: sig, network: 'mainnet', amountAtomic: ev.amountAtomic,
				dbStatus: isDelegation ? 'delegation_risk' : 'onchain_leak',
				chainStatus: ev.reason, reconciled: false,
				discrepancy: isDelegation
					? `SPL approve on ATA of ${name} (${wallet}) → delegate ${ev.counterparty}`
					: `${ev.asset} left ${name} (${wallet}) to ${ev.counterparty ?? 'unknown'} (${ev.reason})`,
				detail: { wallet, name, asset: ev.asset, counterparty: ev.counterparty, reason: ev.reason, amountAtomic: ev.amountAtomic },
				runId,
			});
			const amtLabel = ev.asset === 'SOL' ? `${(ev.amountAtomic / 1e9).toFixed(6)} SOL` : `${ev.amountAtomic} ${ev.asset} atoms`;
			const envHint = signerEnvFor(name);
			await sendOpsAlert(
				isDelegation ? '🚨 Controlled-wallet delegation risk — SPL Approve' : '🚨 Controlled-wallet LEAK — funds left the platform set',
				isDelegation
					? `${name} (${wallet}) approved delegate ${ev.counterparty} to move ${amtLabel} in tx ${sig}. Revoke the approval and ROTATE ${envHint}. https://solscan.io/tx/${sig}`
					: `${amtLabel} left ${name} (${wallet}) to ${ev.counterparty ?? 'an unknown address'} (${ev.reason}) in tx ${sig}. Treat the key as COMPROMISED: rotate ${envHint}, drain remaining funds to a controlled wallet, investigate. https://solscan.io/tx/${sig}`,
				{ signature: `wallet-leak:${sig}:${wallet}:${ev.reason}` },
			);
		}
	}

	const newestSig = signatures[0];
	const newestSlot = sigInfos[0]?.slot ?? null;
	await saveCursor(wallet, name, { lastSignature: newestSig, lastSlot: newestSlot, scannedDelta, leaksDelta, runId });
	return { scannedDelta, leaksDelta };
}

function signerEnvFor(name) {
	const spec = SOLANA_SIGNERS.find((s) => s.name === name);
	return spec?.env || 'the wallet secret';
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;
	await ensureSchema();

	const runId = randomUUID();
	const rpcUrl = process.env.SOLANA_RPC_URL || (env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}` : 'https://api.mainnet-beta.solana.com');
	const { PublicKey } = await import('@solana/web3.js');
	const { solanaConnection } = await import('../_lib/solana/connection.js');
	const conn = solanaConnection({ url: rpcUrl, network: 'mainnet', commitment: 'confirmed' });

	const allowed = await ringAllowedAddresses();
	const wallets = await scannableWallets();

	let scanned = 0, leaks = 0, errors = 0;
	const perWallet = [];
	for (const { pubkey, name } of wallets) {
		const r = await scanOne(conn, PublicKey, pubkey, name, allowed, runId);
		scanned += r.scannedDelta; leaks += r.leaksDelta; if (r.error) errors += 1;
		perWallet.push({ name, wallet: pubkey, scanned: r.scannedDelta, leaks: r.leaksDelta, error: !!r.error });
	}

	// Zero-activity tripwire for the always-active x402 autonomous loop — the same
	// "enabled but silent" alarm that was missing when the ring quietly died. The
	// ring's own settle-silence is covered by ring-reconciliation; this covers the
	// loop that DRIVES it (pipelines + tick), which should never be idle when on.
	const now = Date.now();
	const autoConfigured = String(env.X402_AUTONOMOUS_ENABLED ?? '').toLowerCase() !== 'false';
	const autoLast = await lastActivityMs('x402_autonomous_log', 'created_at');
	const tripwire = await runTripwire({
		subsystem: 'x402_autonomous_loop', configured: autoConfigured,
		lastActivityMs: autoLast, windowMinutes: 60, now, runId,
	});

	return json(res, 200, { ok: true, run_id: runId, wallets: wallets.length, scanned, leaks, rpc_errors: errors, per_wallet: perWallet, tripwire });
});
