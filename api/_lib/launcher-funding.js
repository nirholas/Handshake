// @ts-check
// Master → agent SOL funding for the autonomous coin launcher.
//
// The launcher never lets the master wallet mint a coin directly — that would
// detach the coin from an avatar identity. Instead the master ('coin-launcher-
// master' in SOLANA_SIGNERS) tops up the NEXT agent in the rotation with exactly
// the per-launch SOL it needs (deploy cost + dev-buy), and that agent signs its
// own pump.fun create. This module is the money-moving half of that handshake:
//
//   loadMasterSigner()        — the master Keypair (or null if unconfigured).
//   masterBalanceSol()        — current master SOL, for the circuit breaker.
//   dailySpentSol(scope,uid)  — SOL already spent today (enforces daily_sol_cap).
//   fundAgentForLaunch(...)   — the guarded transfer: caps, balance, send.
//
// Every transfer routes through sendSol → submitProtected, so it inherits the
// data-driven priority fee, blockhash-refresh rebroadcast, and hard-throw-on-
// revert behaviour — a fund step never drops silently under congestion.

import { sql } from './db.js';
import { decodeSecretKey } from './solana-signers.js';
import { sendSol, getSolBalance } from './avatar-wallet.js';
import { solanaConnection } from './agent-pumpfun.js';

const LAMPORTS_PER_SOL = 1_000_000_000;

// The master signer reuses the dedicated launcher env, falling back to the
// existing x402-launcher wallet so the feature works on current infra. Kept in
// sync with the 'coin-launcher-master' SignerSpec in solana-signers.js.
const MASTER_ENV = 'LAUNCHER_MASTER_SECRET_KEY_B64';
const MASTER_FALLBACK_ENV = 'PUMP_X402_LAUNCHER_SECRET_KEY_B64';

// SOL the master must still hold AFTER any funding transfer.
//
// This wallet is not only the launcher/sniper funding root: the same keypair is
// the x402 ring payer (it resolves to one pubkey through both SignerSpecs, which
// is why treasury-topup reports it as "coin-launcher-master+x402-ring-payer").
// In self-pay mode the facilitator hard-rejects a settle when the PAYER is under
// SPONSOR_SOL_FLOOR (0.02 SOL), so a funding transfer that left only transfer
// fees behind silently killed the entire paid-endpoint rail. That is exactly how
// the ring died on 2026-07-25 and again on 2026-07-26: the sniper auto-funder
// pulled arm top-ups until the shared wallet fell ~100 lamports under the floor,
// and every x402 settle 502'd while 3+ SOL sat idle in agent wallets.
//
// The floor is deliberately well above 0.02 so a burst of settles between two
// funding runs can never cross it. Override per-environment if the roles are
// ever split onto separate keypairs.
const DEFAULT_MASTER_RESERVE_SOL = 0.05;
export function masterReserveSol() {
	const n = Number(process.env.LAUNCHER_MASTER_RESERVE_SOL);
	return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MASTER_RESERVE_SOL;
}

/**
 * Load the master launch wallet keypair, or null when neither env is set.
 * @returns {Promise<import('@solana/web3.js').Keypair|null>}
 */
export async function loadMasterSigner() {
	const secret = process.env[MASTER_ENV] || process.env[MASTER_FALLBACK_ENV] || '';
	if (!secret) return null;
	const bytes = await decodeSecretKey(secret);
	if (!bytes) {
		throw Object.assign(new Error('coin-launcher-master secret did not decode'), { code: 'bad_signer' });
	}
	const { Keypair } = await import('@solana/web3.js');
	return Keypair.fromSecretKey(bytes);
}

/**
 * Current master wallet SOL balance. Null when the master is unconfigured.
 * @param {'mainnet'|'devnet'} network
 * @returns {Promise<number|null>}
 */
export async function masterBalanceSol(network = 'mainnet') {
	const master = await loadMasterSigner();
	if (!master) return null;
	const conn = solanaConnection(network);
	const { sol } = await getSolBalance(conn, master.publicKey);
	return sol;
}

/**
 * SOL the launcher has already committed today (UTC) for a scope. Sums runs that
 * actually moved money (funded/launched/confirmed); dry-run + skipped rows don't
 * count. Drives the daily_sol_cap ceiling.
 * @param {'global'|'user'} scope
 * @param {string|null} userId
 * @returns {Promise<number>}
 */
export async function dailySpentSol(scope, userId = null) {
	const [row] = await sql`
		select coalesce(sum(sol_spent), 0)::float8 as spent
		from launcher_runs
		where scope = ${scope}
		  and ${scope === 'user' ? sql`user_id = ${userId}` : sql`true`}
		  and status in ('funded', 'launched', 'confirmed')
		  and created_at >= date_trunc('day', now())
	`;
	return Number(row?.spent || 0);
}

// Optional hard ceiling on how much SOL may leave the master wallet PER UTC DAY,
// summed across every automated funder — enforced inside fundAgentForLaunch
// regardless of the per-call caps a caller passes. This is the backstop that a
// caller passing `dailyCapSol: null` (or a runaway loop) can't bypass. Opt-in:
// unset ⇒ no master cap (legacy behaviour). Set LAUNCHER_MASTER_DAILY_CAP_SOL to
// bound total master outflow.
const MASTER_DAILY_CAP_ENV = 'LAUNCHER_MASTER_DAILY_CAP_SOL';

/**
 * Pure cap check — extracted so the arithmetic is unit-testable. `capSol<=0`
 * (or non-finite) means "no cap".
 * @param {number} spentSol   SOL already moved from the master today
 * @param {number} amountSol  the transfer about to be made
 * @param {number} capSol     the daily ceiling
 * @returns {{ ok: boolean, reason?: string }}
 */
export function withinMasterDailyCap(spentSol, amountSol, capSol) {
	if (!Number.isFinite(capSol) || capSol <= 0) return { ok: true };
	if (spentSol + amountSol > capSol + 1e-9) {
		return { ok: false, reason: `master_daily_cap: ${spentSol.toFixed(4)}+${amountSol} SOL > ${capSol} SOL/day` };
	}
	return { ok: true };
}

/**
 * SOL that has left the master wallet today (UTC) via the app's automated
 * funders. Sums the two known on-chain ledgers — launcher runs and sniper
 * wallet top-ups — and FAILS OPEN per-source (a missing table in some env
 * contributes 0 rather than throwing), so this can never break a funding call.
 * @param {'mainnet'|'devnet'} network
 * @returns {Promise<number>}
 */
export async function masterDailyOutflowSol(network = 'mainnet') {
	let total = 0;
	try {
		const [r] = await sql`
			select coalesce(sum(sol_spent), 0)::float8 as s from launcher_runs
			where status in ('funded', 'launched', 'confirmed')
			  and created_at >= date_trunc('day', now())
		`;
		total += Number(r?.s || 0);
	} catch { /* launcher_runs absent in this env — fail open on this source */ }
	try {
		const [r] = await sql`
			select coalesce(sum(lamports), 0)::float8 / 1e9 as s from sniper_funding_events
			where mode = 'live' and network = ${network}
			  and created_at >= date_trunc('day', now())
		`;
		total += Number(r?.s || 0);
	} catch { /* sniper_funding_events absent in this env — fail open on this source */ }
	return total;
}

/**
 * @typedef {Object} FundResult
 * @property {boolean} ok
 * @property {string} [signature]   the funding transfer signature
 * @property {number} [lamports]    lamports moved
 * @property {string} [reason]      why the fund was refused (when ok=false)
 */

/**
 * Guarded master → agent SOL top-up for one launch. Refuses (never throws for a
 * business-rule stop) when a cap would be breached or the master can't cover it,
 * so the engine can record a clean 'skipped' run and trip the breaker. Only a
 * genuine on-chain/RPC failure throws.
 *
 * @param {Object} p
 * @param {string} p.agentAddress      recipient agent Solana pubkey (base58)
 * @param {number} p.sol               SOL to move (per_launch_sol)
 * @param {number} p.perLaunchCapSol   hard ceiling for a single launch
 * @param {number} p.dailyCapSol       remaining daily allowance already computed by caller
 * @param {'mainnet'|'devnet'} [p.network]
 * @param {string} [p.memo]
 * @returns {Promise<FundResult>}
 */
export async function fundAgentForLaunch({
	agentAddress,
	sol,
	perLaunchCapSol,
	dailyCapSol,
	network = 'mainnet',
	memo = 'three.ws launcher',
}) {
	const amount = Number(sol);
	if (!Number.isFinite(amount) || amount <= 0) {
		return { ok: false, reason: 'per_launch_sol must be positive' };
	}
	if (perLaunchCapSol > 0 && amount > perLaunchCapSol) {
		return { ok: false, reason: `per-launch ${amount} SOL exceeds cap ${perLaunchCapSol}` };
	}
	if (dailyCapSol != null && amount > dailyCapSol) {
		return { ok: false, reason: `daily SOL cap reached (${dailyCapSol} remaining)` };
	}

	// Hard master-wide daily outflow ceiling — independent of the caller's caps, so
	// a null/loose per-call cap can't drain the master. Opt-in via env; no-op unset.
	const masterCapSol = Number(process.env[MASTER_DAILY_CAP_ENV]);
	if (Number.isFinite(masterCapSol) && masterCapSol > 0) {
		const outflow = await masterDailyOutflowSol(network);
		const capCheck = withinMasterDailyCap(outflow, amount, masterCapSol);
		if (!capCheck.ok) return { ok: false, reason: capCheck.reason };
	}

	const master = await loadMasterSigner();
	if (!master) return { ok: false, reason: 'master launch wallet not configured' };

	const conn = solanaConnection(network);
	// Keep a fee buffer AND the shared-wallet operating reserve, so the master
	// never empties below the cost of this transfer plus the SOL its other role
	// (x402 ring payer) needs to keep settling. See masterReserveSol().
	const reserve = masterReserveSol();
	const { sol: masterSol } = await getSolBalance(conn, master.publicKey);
	if (masterSol < amount + 0.002 + reserve) {
		return {
			ok: false,
			reason: `master balance ${masterSol} SOL below ${amount} + fees + ${reserve} reserve`,
		};
	}

	const lamports = Math.round(amount * LAMPORTS_PER_SOL);
	const signature = await sendSol({
		connection: conn,
		fromKeypair: master,
		to: agentAddress,
		lamports,
		memo,
		network,
	});
	return { ok: true, signature, lamports };
}

export { LAMPORTS_PER_SOL };
