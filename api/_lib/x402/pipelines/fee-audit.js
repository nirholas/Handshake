// api/_lib/x402/pipelines/fee-audit.js
//
// Fee Audit + ATA Rent Reclaim — autonomous pipeline (self/fee-audit).
//
// The owner's rule is "the lowest fees ALWAYS". This nightly pipeline is the
// continuous enforcement of that rule: it measures the REAL SOL burned per
// settlement and per $100 of ring volume, alarms when either drifts above
// budget, and reclaims the one-time ATA rent the ring locks up over time.
//
// Two jobs, one run:
//
//   1. FEE ROLLUP (measurement). Sums the real, chain-read fees the self-hosted
//      facilitator logged for the day (x402_self_facilitator_log.fee_lamports —
//      populated from getParsedTransaction().meta.fee, not an estimate) plus the
//      settlement + volume counts from both the facilitator log and the
//      autonomous loop log. Derives lamports-per-settlement and SOL-per-$100 of
//      gross volume, upserts one row per day into x402_fee_audit, and raises an
//      ops alert when lamports-per-settlement exceeds 1.5× the 1-signature floor
//      (7,500 lamports) or the daily burn exceeds X402_RING_DAILY_FEE_BUDGET_
//      LAMPORTS (default 0.05 SOL). Those are the two ways the fee floor slips:
//      a per-tx regression (someone flipped off self-pay, or a priority fee
//      crept up) or runaway volume burning more SOL than budgeted.
//
//   2. ATA RENT RECLAIM (recovery). Every new receiver ATA the ring creates
//      locks 2,039,280 lamports of rent — one-time, but reclaimable by closing
//      the account once it is empty. This job enumerates the USDC token accounts
//      owned by the ring's role wallets and closes any that are (a) zero-balance
//      AND (b) not one of the three ACTIVE role ATAs (payer / treasury / sponsor
//      canonical USDC ATAs). Closing returns the rent to the owner wallet. It is
//      owner-signed, idempotent (a closed account simply no longer appears),
//      capped at 5 closes/run, and NEVER touches an account with a balance or an
//      active role ATA — the safety invariant selectClosableAtas() enforces and
//      the tests hammer before any live run.
//
// Value sink: x402_fee_audit (one row per day, upserted). Downstream consumer:
// GET /api/x402-ring exposes fees.lamports_per_settlement and fees.sol_per_100_usd
// read from the same live logs, and the acceptance run reads the measured
// efficiency from here.
//
// No mocks. The rollup reads real settled-fee rows; the reclaim enumerates real
// on-chain token accounts and closes empty ones with a real transaction.

import { randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import {
	PublicKey, Keypair, TransactionMessage, VersionedTransaction, ComputeBudgetProgram,
} from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync, createCloseAccountInstruction,
	TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

import { sql as defaultSql } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../usage.js';
import { solanaConnection } from '../../solana/connection.js';
import { blockhashKey, getRecentBlockhashInfo } from '../../solana/read-guards.js';
import { sendOpsAlert } from '../../alerts.js';
import { loadSeedKeypair, USDC_MINT, SIGNATURE_FEE_LAMPORTS, RING_CU_LIMIT, ringPriorityMicrolamports } from '../pay.js';

const log = logger('x402-fee-audit');

// One-time ATA rent (lamports) reclaimed per closed account. Matches the
// facilitator's ATA_RENT_LAMPORTS — the same rent the create locked up.
export const ATA_RENT_LAMPORTS = 2_039_280;

// The 1-signature self-pay floor. lamports-per-settlement above 1.5× this is a
// fee-floor regression worth an alert.
const ONE_SIG_FLOOR_LAMPORTS = SIGNATURE_FEE_LAMPORTS; // 5000
const PER_SETTLEMENT_ALERT_LAMPORTS = Math.round(ONE_SIG_FLOOR_LAMPORTS * 1.5); // 7500

// Daily SOL-burn budget for the whole ring. Default 0.05 SOL. Above this the
// day's burn is over budget regardless of per-tx efficiency (too much volume).
function dailyFeeBudgetLamports() {
	return Number(process.env.X402_RING_DAILY_FEE_BUDGET_LAMPORTS || 50_000_000);
}

// Max ATA closes per run — bounds the reclaim so one run can never fan out an
// unbounded number of close transactions.
const MAX_CLOSES_PER_RUN = 5;

function loadKp(b58) {
	const raw = bs58.decode(b58);
	if (raw.length !== 64) throw new Error(`keypair expected 64 bytes, got ${raw.length}`);
	return Keypair.fromSecretKey(raw);
}

// ── Pure: fee-efficiency math ────────────────────────────────────────────────
// Given the day's real settled fee total, settlement count, and gross USDC
// volume (atomic), derive the two efficiency numbers plus the alert verdicts.
// Pure and total — the rollup and the tests both reason about this one function.
export function computeFeeEfficiency({
	feesLamports = 0,
	settlements = 0,
	grossVolumeAtomic = 0,
	budgetLamports = 50_000_000,
}) {
	const fees = Number(feesLamports) || 0;
	const n = Number(settlements) || 0;
	const grossUsd = (Number(grossVolumeAtomic) || 0) / 1e6;
	const lamportsPerSettlement = n > 0 ? Math.round(fees / n) : null;
	const solBurned = fees / 1e9;
	// SOL burned per $100 of gross volume. Null when there is no volume to
	// normalize against (avoids a divide-by-zero that would read as "free").
	const solPer100Usd = grossUsd > 0
		? Number(((solBurned / grossUsd) * 100).toFixed(9))
		: null;
	const aboveFloor = lamportsPerSettlement != null
		&& lamportsPerSettlement > PER_SETTLEMENT_ALERT_LAMPORTS;
	const overBudget = fees > Number(budgetLamports);
	return {
		fees_lamports: fees,
		settlements: n,
		gross_volume_atomic: Number(grossVolumeAtomic) || 0,
		gross_volume_usd: Number(grossUsd.toFixed(6)),
		lamports_per_settlement: lamportsPerSettlement,
		sol_burned: Number(solBurned.toFixed(9)),
		sol_per_100_usd: solPer100Usd,
		budget_lamports: Number(budgetLamports),
		above_floor: aboveFloor,
		over_budget: overBudget,
		per_settlement_alert_lamports: PER_SETTLEMENT_ALERT_LAMPORTS,
	};
}

// ── Pure: which role ATAs are active and must NEVER be closed ────────────────
// The canonical USDC ATA for each configured ring role wallet. These hold (or
// are meant to hold) the ring's live float — closing one would break settlement.
// Returns a Set of base58 ATA addresses.
export function activeRoleAtas({ mint, owners }) {
	const set = new Set();
	if (!mint) return set;
	const mintPk = new PublicKey(mint);
	for (const owner of owners) {
		if (!owner) continue;
		try {
			const ownerPk = owner instanceof PublicKey ? owner : new PublicKey(owner);
			const ata = getAssociatedTokenAddressSync(
				mintPk, ownerPk, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
			);
			set.add(ata.toBase58());
		} catch { /* skip an unparseable owner */ }
	}
	return set;
}

// ── Pure: SAFETY-CRITICAL — pick which ATAs are closable ─────────────────────
// Given enumerated USDC token accounts (each { pubkey, amount, mint }) and the
// set of active role ATAs, return ONLY the ones safe to close: exact USDC mint,
// zero balance, and NOT an active role ATA — capped. Every exclusion is defended
// by a unit test. A non-zero balance or a role ATA is NEVER returned, no matter
// the cap. This is the invariant the whole reclaim rests on.
export function selectClosableAtas({ accounts, activeAtaSet, mint, cap = MAX_CLOSES_PER_RUN }) {
	const out = [];
	for (const acc of accounts || []) {
		if (out.length >= cap) break;
		if (!acc || !acc.pubkey) continue;
		// Wrong mint → never touch (defensive; the enumerator already filters).
		if (mint && acc.mint && acc.mint !== mint) continue;
		// Active role ATA → the ring's live float. Never close.
		if (activeAtaSet.has(acc.pubkey)) continue;
		// Any balance → funded account. Never close (would burn the tokens).
		const amount = BigInt(acc.amount ?? 0n);
		if (amount !== 0n) continue;
		out.push(acc.pubkey);
	}
	return out;
}

// One-time DDL guard per warm instance (mirrors the loop's ensureSchema idiom).
let _schemaReady = false;
async function ensureSchema(sql) {
	if (_schemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS x402_fee_audit (
			day                         date PRIMARY KEY,
			settlements                 bigint NOT NULL DEFAULT 0,
			gross_volume_atomic         numeric NOT NULL DEFAULT 0,
			fees_lamports               numeric NOT NULL DEFAULT 0,
			lamports_per_settlement     numeric,
			sol_per_100_usd             numeric,
			budget_lamports             numeric,
			above_floor                 boolean NOT NULL DEFAULT false,
			over_budget                 boolean NOT NULL DEFAULT false,
			ata_closed_count            int NOT NULL DEFAULT 0,
			ata_rent_reclaimed_lamports numeric NOT NULL DEFAULT 0,
			run_id                      uuid,
			updated_at                  timestamptz NOT NULL DEFAULT now()
		)
	`;
	_schemaReady = true;
}

// Sum the day's real settled fees + settlement/volume counts. Fees come ONLY
// from the facilitator log (the sole place a real chain-read fee is recorded);
// the autonomous log contributes its successful paid calls to the settlement +
// volume totals so the efficiency number reflects the full ring, not just the
// self-facilitator lane.
async function readDailyTotals(sql) {
	const [fac] = await sql`
		SELECT count(*)::bigint AS settlements,
		       COALESCE(sum(fee_lamports), 0)::numeric AS fees_lamports,
		       COALESCE(sum(amount_atomic), 0)::numeric AS gross_atomic
		FROM x402_self_facilitator_log
		WHERE action = 'settle' AND ok = true
		  AND ts >= date_trunc('day', now())
	`;
	// Autonomous loop paid calls today (successful, non-zero spend). These add to
	// the settlement + volume denominators; their on-chain fee — when settled by
	// our own facilitator — is already counted in the facilitator sum above, so
	// we deliberately do NOT add a second fee figure here.
	const [auto] = await sql`
		SELECT count(*)::bigint AS settlements,
		       COALESCE(sum(amount_atomic), 0)::numeric AS gross_atomic
		FROM x402_autonomous_log
		WHERE success = true AND amount_atomic > 0
		  AND ts >= date_trunc('day', now())
	`;
	return {
		feesLamports: Number(fac?.fees_lamports || 0),
		facSettlements: Number(fac?.settlements || 0),
		facGrossAtomic: Number(fac?.gross_atomic || 0),
		autoSettlements: Number(auto?.settlements || 0),
		autoGrossAtomic: Number(auto?.gross_atomic || 0),
	};
}

// Enumerate the ring's USDC token accounts, one owner at a time. Returns
// { owner, ownerKp, pubkey, amount, mint } rows — every USDC account each role
// wallet owns, with its live balance. Best-effort per owner: an RPC hiccup on
// one owner skips that owner, never the whole reclaim.
async function enumerateRingUsdcAccounts(conn, mint, roleWallets) {
	const rows = [];
	const mintPk = new PublicKey(mint);
	for (const { role, kp } of roleWallets) {
		try {
			const res = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { mint: mintPk });
			for (const { pubkey, account } of res.value) {
				const info = account?.data?.parsed?.info;
				const amount = BigInt(info?.tokenAmount?.amount ?? '0');
				rows.push({
					role,
					ownerKp: kp,
					owner: kp.publicKey.toBase58(),
					pubkey: pubkey.toBase58(),
					amount,
					mint,
				});
			}
		} catch (err) {
			log.warn('enumerate_owner_failed', { role, message: err?.message });
		}
	}
	return rows;
}

async function confirmSignature(conn, signature, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const { value } = await conn.getSignatureStatuses([signature]);
		const st = value?.[0];
		if (st) {
			if (st.err) return { confirmed: false, err: JSON.stringify(st.err) };
			if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') {
				return { confirmed: true };
			}
		}
		if (Date.now() > deadline) return { confirmed: false, err: 'confirm_timeout' };
		await new Promise((r) => setTimeout(r, 1200));
	}
}

// Close one empty ATA, owner-signed, rent → owner. Returns the signature or an
// error string. The owner is BOTH the fee payer and the close authority, so the
// tx is 1 signature; rent lands back in the owner's SOL balance.
async function closeEmptyAta(conn, { ownerKp, pubkey }) {
	const account = new PublicKey(pubkey);
	const owner = ownerKp.publicKey;
	// A cron tick that cannot read a blockhash used to throw straight through the
	// handler into an ops alert. The guard answers from a hash still inside its
	// validity window when the chain is unreadable, and raises a typed
	// rpc_unavailable only when there is genuinely nothing to sign with.
	const { blockhash } = await getRecentBlockhashInfo(conn, blockhashKey({ url: env.SOLANA_RPC_URL }));
	const ixs = [
		ComputeBudgetProgram.setComputeUnitLimit({ units: RING_CU_LIMIT }),
		ComputeBudgetProgram.setComputeUnitPrice({ microLamports: ringPriorityMicrolamports(0) }),
		// closeAccount: [account, destination(rent), authority]. Destination =
		// owner → the reclaimed rent returns to the wallet that funded it.
		createCloseAccountInstruction(account, owner, owner, [], TOKEN_PROGRAM_ID),
	];
	const msg = new TransactionMessage({
		payerKey: owner,
		recentBlockhash: blockhash,
		instructions: ixs,
	}).compileToV0Message();
	const vtx = new VersionedTransaction(msg);
	vtx.sign([ownerKp]);
	let signature;
	try {
		signature = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 5 });
	} catch (err) {
		return { ok: false, error: `close_broadcast_failed:${String(err?.message || err).slice(0, 160)}` };
	}
	const conf = await confirmSignature(conn, signature);
	if (!conf.confirmed) return { ok: false, error: `close_not_confirmed:${conf.err}`, signature };
	return { ok: true, signature };
}

// Resolve the ring's role wallets we can sign for (needed to close their empty
// ATAs). Payer + treasury + sponsor, each only if its secret is configured.
function resolveRoleWallets() {
	const wallets = [];
	try { wallets.push({ role: 'payer', kp: loadSeedKeypair() }); } catch { /* payer unset */ }
	const treasurySecret = process.env.X402_TREASURY_SECRET_BASE58;
	if (treasurySecret) {
		try { wallets.push({ role: 'treasury', kp: loadKp(treasurySecret) }); } catch { /* bad key */ }
	}
	const sponsorSecret = process.env.X402_FEE_PAYER_SECRET_BASE58;
	if (sponsorSecret) {
		try { wallets.push({ role: 'sponsor', kp: loadKp(sponsorSecret) }); } catch { /* bad key */ }
	}
	return wallets;
}

/**
 * Run the fee audit + ATA rent reclaim. Conforms to the run()-style registry
 * contract. All ctx fields optional for a standalone/manual run.
 *
 * @param {object} ctx { sql, conn, redis, runId, dryRun }
 *   dryRun — enumerate + select closable ATAs but broadcast nothing (used by the
 *            acceptance run to prove the reclaim's safety selection without spend).
 * @returns the aggregate the loop records to x402_autonomous_log.
 */
export async function run(ctx = {}) {
	const runId = ctx.runId || randomUUID();
	const sql = ctx.sql || defaultSql;
	const dryRun = ctx.dryRun === true;

	if (!USDC_MINT) {
		return { success: false, amountAtomic: 0, skipped: true, note: 'usdc_mint_unset' };
	}

	// ── 1. Fee rollup ─────────────────────────────────────────────────────────
	let eff = null;
	try {
		await ensureSchema(sql);
		const totals = await readDailyTotals(sql);
		const settlements = totals.facSettlements + totals.autoSettlements;
		const grossVolumeAtomic = totals.facGrossAtomic + totals.autoGrossAtomic;
		eff = computeFeeEfficiency({
			feesLamports: totals.feesLamports,
			settlements,
			grossVolumeAtomic,
			budgetLamports: dailyFeeBudgetLamports(),
		});
	} catch (err) {
		log.warn('fee_rollup_failed', { message: err?.message });
	}

	// ── 2. ATA rent reclaim ─────────────────────────────────────────────────────
	let closedCount = 0;
	let reclaimedLamports = 0;
	const closedSigs = [];
	const selected = [];
	let reclaimNote = 'no_role_wallets';
	try {
		const roleWallets = resolveRoleWallets();
		if (roleWallets.length > 0) {
			const conn = ctx.conn || solanaConnection({ url: env.SOLANA_RPC_URL, commitment: 'confirmed' });
			// The three active role ATAs — the canonical USDC ATA of each role
			// wallet AND the advertised treasury/sponsor pubkeys (a role wallet
			// might be configured only by pubkey, no secret).
			const activeOwners = [
				...roleWallets.map((w) => w.kp.publicKey),
				env.X402_PAY_TO_SOLANA || null,
				env.X402_FEE_PAYER_SOLANA || null,
			];
			const activeAtaSet = activeRoleAtas({ mint: USDC_MINT, owners: activeOwners });

			const accounts = await enumerateRingUsdcAccounts(conn, USDC_MINT, roleWallets);
			const closablePubkeys = selectClosableAtas({
				accounts, activeAtaSet, mint: USDC_MINT, cap: MAX_CLOSES_PER_RUN,
			});
			// Map selected pubkeys back to their owner keypair for signing.
			const byPubkey = new Map(accounts.map((a) => [a.pubkey, a]));
			for (const pk of closablePubkeys) selected.push(byPubkey.get(pk));

			if (dryRun) {
				reclaimNote = `dry_run_selected:${selected.length}`;
				log.info('fee_audit_dry_run', {
					run_id: runId,
					enumerated: accounts.length,
					active_role_atas: activeAtaSet.size,
					closable: selected.map((s) => ({ role: s.role, ata: s.pubkey })),
				});
			} else {
				for (const acc of selected) {
					const res = await closeEmptyAta(conn, acc);
					if (res.ok) {
						closedCount += 1;
						reclaimedLamports += ATA_RENT_LAMPORTS;
						closedSigs.push(res.signature);
						log.info('ata_rent_reclaimed', {
							run_id: runId, role: acc.role, ata: acc.pubkey, tx: res.signature,
						});
					} else {
						log.warn('ata_close_failed', { role: acc.role, ata: acc.pubkey, error: res.error });
					}
				}
				reclaimNote = `closed:${closedCount}`;
			}
		}
	} catch (err) {
		log.warn('ata_reclaim_failed', { message: err?.message });
		reclaimNote = `reclaim_error:${err?.message}`;
	}

	// ── 3. Persist the day's audit row (upsert) ──────────────────────────────────
	if (eff) {
		try {
			await sql`
				INSERT INTO x402_fee_audit
					(day, settlements, gross_volume_atomic, fees_lamports,
					 lamports_per_settlement, sol_per_100_usd, budget_lamports,
					 above_floor, over_budget, ata_closed_count,
					 ata_rent_reclaimed_lamports, run_id, updated_at)
				VALUES
					(date_trunc('day', now()), ${eff.settlements}, ${eff.gross_volume_atomic},
					 ${eff.fees_lamports}, ${eff.lamports_per_settlement}, ${eff.sol_per_100_usd},
					 ${eff.budget_lamports}, ${eff.above_floor}, ${eff.over_budget},
					 ${closedCount}, ${reclaimedLamports}, ${runId}, now())
				ON CONFLICT (day) DO UPDATE SET
					settlements = EXCLUDED.settlements,
					gross_volume_atomic = EXCLUDED.gross_volume_atomic,
					fees_lamports = EXCLUDED.fees_lamports,
					lamports_per_settlement = EXCLUDED.lamports_per_settlement,
					sol_per_100_usd = EXCLUDED.sol_per_100_usd,
					budget_lamports = EXCLUDED.budget_lamports,
					above_floor = EXCLUDED.above_floor,
					over_budget = EXCLUDED.over_budget,
					ata_closed_count = x402_fee_audit.ata_closed_count + EXCLUDED.ata_closed_count,
					ata_rent_reclaimed_lamports = x402_fee_audit.ata_rent_reclaimed_lamports + EXCLUDED.ata_rent_reclaimed_lamports,
					run_id = EXCLUDED.run_id,
					updated_at = now()
			`;
		} catch (err) {
			log.warn('fee_audit_upsert_failed', { message: err?.message });
		}
	}

	// ── 4. Alert on fee-floor drift ──────────────────────────────────────────────
	if (eff && (eff.above_floor || eff.over_budget)) {
		const reasons = [];
		if (eff.above_floor) {
			reasons.push(
				`lamports/settlement ${eff.lamports_per_settlement} > ${eff.per_settlement_alert_lamports} (1.5× the 1-sig floor)`,
			);
		}
		if (eff.over_budget) {
			reasons.push(
				`daily burn ${eff.sol_burned} SOL > budget ${(eff.budget_lamports / 1e9).toFixed(4)} SOL`,
			);
		}
		await sendOpsAlert(
			'x402 ring fee floor drift',
			`${reasons.join('; ')}. settlements=${eff.settlements}, ` +
				`gross=$${eff.gross_volume_usd}, sol/$100=${eff.sol_per_100_usd}`,
			{ signature: 'x402-fee-audit-drift' },
		).catch(() => {});
		log.warn('fee_floor_drift', { run_id: runId, ...eff });
	}

	const note = eff
		? `settlements=${eff.settlements} lamports/settle=${eff.lamports_per_settlement} ` +
			`sol/$100=${eff.sol_per_100_usd} ${reclaimNote}`
		: `rollup_unavailable ${reclaimNote}`;

	return {
		success: true,
		amountAtomic: 0, // audit + reclaim — never a spend
		txSig: closedSigs[0] || null,
		signalData: eff ? { ...eff, ata_closed_count: closedCount, ata_rent_reclaimed_lamports: reclaimedLamports } : null,
		valueExtracted: {
			fees: eff,
			reclaim: {
				dry_run: dryRun,
				selected: selected.map((s) => ({ role: s?.role, ata: s?.pubkey })),
				closed_count: closedCount,
				reclaimed_lamports: reclaimedLamports,
				signatures: closedSigs,
			},
		},
		note,
	};
}

export const FEE_AUDIT = Object.freeze({
	perSettlementAlertLamports: PER_SETTLEMENT_ALERT_LAMPORTS,
	oneSigFloorLamports: ONE_SIG_FLOOR_LAMPORTS,
	maxClosesPerRun: MAX_CLOSES_PER_RUN,
	ataRentLamports: ATA_RENT_LAMPORTS,
});
