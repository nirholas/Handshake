// @ts-check
// api/_lib/economy-usdc-topup.js
//
// Keeps the USDC-spending engine wallets stocked from the master's idle USDC.
//
// WHY THIS EXISTS. The x402 ring payer and the a2a settlement payer spend USDC
// on every settlement, and until now their only refill path was economy-rebalance
// swapping their OWN SOL into USDC on Jupiter. When a payer holds neither spare
// SOL nor USDC while the funding master sits on idle USDC revenue, the payer
// starves inside arm's reach of the money: settles die with SPL Custom:1
// (insufficient funds) while the master's ATA holds multiples of the shortfall
// (observed 2026-07-28: payer at ~5 USDC failing every $10 ring-settle leg,
// master idle at 48 USDC). This module closes that gap with a direct
// master -> payer USDC transfer: no swap, no slippage, one signature.
//
// Safe by construction:
//   • Only ever pays registry-resolved USDC engine wallets (USDC_WALLETS from
//     economy-rebalance.js is the allowlist), never an arbitrary address and
//     never the master itself.
//   • Armed per wallet only while its USDC sits BELOW its floor; the transfer
//     refills toward floor x REFILL_MULTIPLE so it does not re-trigger every
//     run (same hysteresis shape as the fee-SOL leg in economy-rebalance).
//   • Triple-bounded: per-transfer cap, per-UTC-day cap, and a master USDC
//     keep-floor the topup never spends below (leaves refuelMasterFromUsdc its
//     own fuel). A cooldown guards against a same-minute double run.
//   • Non-oscillating with the other crons: recipients carry holdsTokens in the
//     registry, so treasury-sweepback's token sweep never claws the USDC back.
//   • Every transfer is booked to economy_usdc_topups (drives the daily cap)
//     and mirrored to the audit log.
//
// Inert switch: ECONOMY_USDC_TOPUP_ENABLED=0 turns it off entirely.

import { sql } from './db.js';
import { loadEconomyMaster } from './economy-master.js';
import { USDC_WALLETS } from './economy-rebalance.js';
import { USDC_MINT_BY_NETWORK, USDC_DECIMALS } from './vault-jupiter.js';
import { SOLANA_SIGNERS, resolveSignerPubkey } from './solana-signers.js';
import { submitProtected } from './execution-engine.js';
import { logAudit } from './audit.js';

const USDC_ATOMICS = 10 ** USDC_DECIMALS;

function num(name, dflt) {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v >= 0 ? v : dflt;
}

/** Direct master -> engine USDC refill is on unless explicitly disabled. */
export const USDC_TOPUP_ENABLED = process.env.ECONOMY_USDC_TOPUP_ENABLED !== '0';
/** Never spend the master's USDC below this (reserve for the SOL refuel swap). */
export const USDC_TOPUP_MASTER_KEEP = num('ECONOMY_USDC_TOPUP_MASTER_KEEP', 10);
/** Most USDC a single transfer may move. */
export const USDC_TOPUP_PER_TRANSFER = num('ECONOMY_USDC_TOPUP_PER_TRANSFER_USD', 15);
/** Most USDC all topups may move in one UTC day. */
export const USDC_TOPUP_DAILY = num('ECONOMY_USDC_TOPUP_DAILY_USD', 40);
/** Refill toward floor x this, so a topped-up wallet has real runway. */
export const USDC_TOPUP_REFILL_MULTIPLE = num('ECONOMY_USDC_TOPUP_REFILL_MULTIPLE', 1.5);
/** A transfer below this is not worth its fee. */
const MIN_TRANSFER_USD = 1;
/** Minimum seconds between two topup runs that move money. */
export const USDC_TOPUP_COOLDOWN_S = num('ECONOMY_USDC_TOPUP_COOLDOWN_S', 90);

/**
 * Pure topup decision + sizing, no RPC, no DB, so the bounds are unit-testable
 * (mirrors planRefuel in economy-fuel.js). Neediest wallet first; each transfer
 * draws down the shared per-run/day/master budgets.
 *
 * @param {object} a
 * @param {number} a.masterUsdc     master USDC balance (whole tokens)
 * @param {number} a.spentTodayUsd  USDC already topped up today (UTC)
 * @param {Array<{name:string,pubkey:string,usdc:number,floorUsd:number}>} a.wallets
 * @param {object} [a.caps]         { masterKeep, perTransferUsd, dailyUsd, refillMultiple, minTransferUsd }
 * @returns {{ plan:Array<{name:string,pubkey:string,sendUsd:number,reason:string}>,
 *             skipped:Array<{name:string,reason:string}> }}
 */
export function planUsdcTopups({ masterUsdc, spentTodayUsd, wallets, caps }) {
	const C = caps || {
		masterKeep: USDC_TOPUP_MASTER_KEEP,
		perTransferUsd: USDC_TOPUP_PER_TRANSFER,
		dailyUsd: USDC_TOPUP_DAILY,
		refillMultiple: USDC_TOPUP_REFILL_MULTIPLE,
		minTransferUsd: MIN_TRANSFER_USD,
	};
	const plan = [];
	const skipped = [];
	let masterSpendable = Math.max(0, masterUsdc - C.masterKeep);
	let dailyRemaining = Math.max(0, C.dailyUsd - spentTodayUsd);

	const rows = wallets
		.map((w) => ({ w, shortfallUsd: Math.max(0, w.floorUsd - w.usdc) }))
		.sort((a, b) => b.shortfallUsd - a.shortfallUsd);

	for (const { w, shortfallUsd } of rows) {
		// Armed only below the floor itself; the refill target is only how HIGH we
		// lift, never what arms the transfer, so a wallet between floor and target
		// sits in a stable band instead of drawing a trickle every run.
		if (shortfallUsd <= 0) {
			skipped.push({ name: w.name, reason: 'above_floor' });
			continue;
		}
		const targetUsd = w.floorUsd * C.refillMultiple;
		const sendUsd = round(Math.min(targetUsd - w.usdc, C.perTransferUsd, dailyRemaining, masterSpendable));
		if (sendUsd < C.minTransferUsd) {
			const reason =
				dailyRemaining < C.minTransferUsd ? 'daily_cap_reached'
				: masterSpendable < C.minTransferUsd ? 'master_at_keep_floor'
				: 'below_min_transfer';
			skipped.push({ name: w.name, reason });
			continue;
		}
		plan.push({ name: w.name, pubkey: w.pubkey, sendUsd, reason: `usdc ${w.usdc.toFixed(2)} < floor ${w.floorUsd}` });
		masterSpendable = round(masterSpendable - sendUsd);
		dailyRemaining = round(dailyRemaining - sendUsd);
	}
	return { plan, skipped };
}

let schemaReady = false;
async function ensureSchema() {
	if (schemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS economy_usdc_topups (
			id            bigserial PRIMARY KEY,
			day           date        NOT NULL,
			recipient     text        NOT NULL,
			recipient_name text,
			usdc_atomics  bigint      NOT NULL,
			signature     text,
			network       text        NOT NULL DEFAULT 'mainnet',
			created_at    timestamptz NOT NULL DEFAULT now()
		)`;
	await sql`CREATE INDEX IF NOT EXISTS economy_usdc_topups_day_idx ON economy_usdc_topups (day)`;
	schemaReady = true;
}

async function usdcSentTodayUsd() {
	const rows = await sql`
		SELECT COALESCE(SUM(usdc_atomics), 0)::text AS atomics
		FROM economy_usdc_topups
		WHERE day = (now() AT TIME ZONE 'utc')::date`;
	return Number(rows?.[0]?.atomics || 0) / USDC_ATOMICS;
}

async function secondsSinceLastTopup() {
	const rows = await sql`
		SELECT EXTRACT(EPOCH FROM (now() - MAX(created_at)))::float8 AS secs
		FROM economy_usdc_topups`;
	const secs = rows?.[0]?.secs;
	return secs == null ? Infinity : Number(secs);
}

/** Read an owner's USDC balance (whole tokens) on the classic token program. */
async function readUsdcUsd(connection, ownerPubkey, mintPk) {
	const { PublicKey } = await import('@solana/web3.js');
	let atomics = 0n;
	try {
		const r = await connection.getParsedTokenAccountsByOwner(new PublicKey(ownerPubkey), { mint: mintPk });
		for (const a of r.value) atomics += BigInt(a.account.data.parsed?.info?.tokenAmount?.amount || '0');
	} catch {
		/* no ATA yet reads as zero, which is exactly what a starved wallet is */
	}
	return Number(atomics) / USDC_ATOMICS;
}

/**
 * Top up every under-floor USDC engine wallet straight from the master's USDC.
 * Reads live balances, plans with planUsdcTopups, and executes each transfer as
 * master-signed TransferChecked into the recipient's (idempotently created) ATA.
 *
 * @param {object} args
 * @param {import('@solana/web3.js').Connection} args.connection
 * @param {'mainnet'|'devnet'} [args.network]
 * @param {boolean} [args.dryRun]
 * @returns {Promise<{enabled:boolean, acted:boolean, reason?:string, masterUsdc?:number,
 *   plan?:Array<object>, sent?:Array<object>, failed?:Array<object>, skipped?:Array<object>}>}
 */
export async function topUpUsdcEngines({ connection, network = 'mainnet', dryRun = false }) {
	if (!USDC_TOPUP_ENABLED) return { enabled: false, acted: false, reason: 'disabled' };

	const master = await loadEconomyMaster();
	if (!master) return { enabled: true, acted: false, reason: 'master_unconfigured' };

	const { PublicKey } = await import('@solana/web3.js');
	const mint = new PublicKey(network === 'devnet' ? USDC_MINT_BY_NETWORK.devnet : USDC_MINT_BY_NETWORK.mainnet);

	// Resolve the allowlisted USDC engines and their live balances. A wallet whose
	// secret aliases to the master can never be a target (it IS the master).
	const wallets = [];
	for (const cfg of USDC_WALLETS) {
		const spec = SOLANA_SIGNERS.find((s) => s.name === cfg.role);
		if (!spec) continue;
		const resolved = await resolveSignerPubkey(spec).catch(() => null);
		if (!resolved?.pubkey || resolved.pubkey === master.publicKey.toBase58()) continue;
		const usdc = await readUsdcUsd(connection, resolved.pubkey, mint);
		const floorUsd = Number(process.env[cfg.floorEnv]) || cfg.floorDflt;
		wallets.push({ name: cfg.role, pubkey: resolved.pubkey, usdc, floorUsd });
	}
	if (!wallets.length) return { enabled: true, acted: false, reason: 'no_targets' };

	const masterUsdc = await readUsdcUsd(connection, master.publicKey.toBase58(), mint);
	await ensureSchema();
	const spentToday = await usdcSentTodayUsd();
	const { plan, skipped } = planUsdcTopups({ masterUsdc, spentTodayUsd: spentToday, wallets });

	const base = { enabled: true, masterUsdc: round(masterUsdc), plan, skipped };
	if (!plan.length) return { ...base, acted: false, reason: 'nothing_below_floor' };
	if (dryRun) return { ...base, acted: false, reason: 'dry_run' };

	const sinceLast = await secondsSinceLastTopup();
	if (sinceLast < USDC_TOPUP_COOLDOWN_S) {
		return { ...base, acted: false, reason: 'cooldown', secondsSinceLastTopup: Math.round(sinceLast) };
	}

	const {
		TOKEN_PROGRAM_ID,
		getAssociatedTokenAddressSync,
		createAssociatedTokenAccountIdempotentInstruction,
		createTransferCheckedInstruction,
	} = await import('@solana/spl-token');

	const masterAta = getAssociatedTokenAddressSync(mint, master.publicKey, false, TOKEN_PROGRAM_ID);
	const sent = [];
	const failed = [];
	for (const leg of plan) {
		const recipient = new PublicKey(leg.pubkey);
		const recipientAta = getAssociatedTokenAddressSync(mint, recipient, false, TOKEN_PROGRAM_ID);
		const atomics = BigInt(Math.floor(leg.sendUsd * USDC_ATOMICS));
		if (atomics <= 0n) continue;
		try {
			const { signature } = await submitProtected({
				network,
				connection,
				payer: master,
				instructions: [
					createAssociatedTokenAccountIdempotentInstruction(master.publicKey, recipientAta, recipient, mint, TOKEN_PROGRAM_ID),
					createTransferCheckedInstruction(masterAta, mint, recipientAta, master.publicKey, atomics, USDC_DECIMALS, [], TOKEN_PROGRAM_ID),
				],
			});
			sent.push({ name: leg.name, pubkey: leg.pubkey, sendUsd: leg.sendUsd, signature });
			// This row IS the daily-cap counter; a dropped write must be loud, and the
			// cooldown still bounds a same-minute repeat even without it.
			try {
				await sql`
					INSERT INTO economy_usdc_topups (day, recipient, recipient_name, usdc_atomics, signature, network)
					VALUES ((now() AT TIME ZONE 'utc')::date, ${leg.pubkey}, ${leg.name}, ${atomics.toString()}, ${signature}, ${network})`;
			} catch (e) {
				console.warn(`[usdc-topup] transfer ${signature} settled but its ledger row was NOT written: ${e?.message}`);
			}
			logAudit({
				action: 'economy_usdc_topup',
				meta: { name: leg.name, pubkey: leg.pubkey, sendUsd: leg.sendUsd, signature },
			});
		} catch (e) {
			failed.push({ name: leg.name, reason: (e?.message || 'send_failed').slice(0, 160) });
		}
	}
	return { ...base, acted: sent.length > 0, sent, failed };
}

function round(n) {
	return Math.round(n * 1e6) / 1e6;
}
