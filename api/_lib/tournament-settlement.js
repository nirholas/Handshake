/**
 * $THREE prize settlement for the Arena.
 *
 * Prizes are $THREE only (FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump). Each
 * winning entry is paid from the platform prize wallet with a REAL on-chain SPL
 * transfer (reusing the audited transferSolanaUSDC helper — it's mint-generic), and
 * the resulting tx is recorded against the entry for idempotency and audit.
 *
 * Honest accounting is a hard requirement:
 *   - If the prize wallet isn't configured in this environment, settlement does NOT
 *     fake a payout. It records the entry as BLOCKED(payout_unconfigured) with the
 *     exact unblock step, and the tournament still ran and ranked.
 *   - Settlement is idempotent: an entry already 'settled' is never paid twice (the
 *     store's compare-and-set + the unique settlement_tx index enforce it).
 *   - Devnet tournaments never pay real $THREE — that would be meaningless — so they
 *     report BLOCKED(devnet_no_prizes).
 */

import bs58 from 'bs58';

import { transferSolanaUSDC } from './solana-transfer.js';
import { env } from './env.js';
import { recordSettlement } from './tournament-store.js';

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Resolve the prize payout wallet as a Base58 64-byte secret, from the dedicated
 * THREE_PRIZE_PAYOUT_KEY (Base58 or base64) or the existing base64 club treasury
 * secret. Returns null when nothing is configured.
 */
function resolvePrizeKeyBase58() {
	const dedicated = env.THREE_PRIZE_PAYOUT_KEY;
	if (dedicated && dedicated.trim()) {
		const s = dedicated.trim();
		try {
			if (bs58.decode(s).length === 64) return s;
		} catch {
			/* not Base58 — try base64 below */
		}
		try {
			const raw = Buffer.from(s, 'base64');
			if (raw.byteLength === 64) return bs58.encode(raw);
		} catch {
			/* ignore */
		}
	}
	const clubB64 = process.env.CLUB_SOLANA_TREASURY_SECRET_KEY_B64;
	if (clubB64) {
		try {
			const raw = Buffer.from(clubB64, 'base64');
			if (raw.byteLength === 64) return bs58.encode(raw);
		} catch {
			/* ignore */
		}
	}
	return null;
}

/** True when the platform can actually pay $THREE prizes. */
export function prizeWalletConfigured() {
	return !!resolvePrizeKeyBase58();
}

/**
 * Is this tournament's pool one the platform wallet is willing to pay?
 *
 * Nothing escrows a prize today: POST /api/tournaments takes `prize_pool_three` on
 * the creator's word and never asks them to deposit it, while settlement pays real
 * $THREE out of the PLATFORM wallet. Unbounded, that combination turns tournament
 * creation into a withdrawal form on the treasury (declare a pool, enter your own
 * agent, clear the gates with a handful of cheap trades, settle). So the platform
 * only pays what it actually stands behind: its own house arena, or a user pool
 * within the ceiling a deployment explicitly opted into.
 *
 * Ranking, attestation, and the whole competition are untouched by this: only the
 * payout is gated, and it is gated loudly rather than silently.
 */
export function poolBacked(tournament) {
	const pool = BigInt(tournament?.prize_pool_three || 0);
	if (pool <= 0n) return true; // nothing to pay
	if ((tournament?.entry_rules || {}).house) return true; // the platform's own bracket
	const ceiling = Number(env.ARENA_UNFUNDED_PRIZE_MAX_THREE || 0);
	if (!Number.isFinite(ceiling) || ceiling <= 0) return false;
	return pool <= BigInt(Math.floor(ceiling)) * 10n ** BigInt(env.THREE_TOKEN_DECIMALS);
}

/**
 * Why settlement is blocked, or null if it can run. Pass the tournament to include
 * the funding check; with only a network it answers the environment question alone.
 */
export function settlementBlockReason(network, tournament = null) {
	if (network === 'devnet') return 'devnet_no_prizes';
	if (!resolvePrizeKeyBase58()) return 'payout_unconfigured';
	if (tournament && !poolBacked(tournament)) return 'pool_unfunded';
	return null;
}

/**
 * Settle a tournament's prizes. Pays every entry that has prize_three > 0 and isn't
 * already settled, recording the outcome per entry. Never throws on an individual
 * payout failure — it records that entry as blocked with the reason and continues,
 * so one bad recipient can't strand the rest.
 *
 * @param {object} tournament  the tournament row (id, network)
 * @param {Array}  entries     tournament_entries rows (with prize_three, wallet, settlement_status)
 * @returns {Promise<{ settled:number, blocked:number, skipped:number, results:Array }>}
 */
export async function settleTournament(tournament, entries) {
	const network = tournament.network;
	const mint = env.THREE_TOKEN_MINT;
	const blockAll = settlementBlockReason(network, tournament);

	const winners = entries.filter((e) => BigInt(e.prize_three || 0) > 0n && e.status !== 'withdrawn');
	const results = [];
	let settled = 0,
		blocked = 0,
		skipped = 0;

	const fromWallet = blockAll ? null : resolvePrizeKeyBase58();

	for (const e of winners) {
		if (e.settlement_status === 'settled' && e.settlement_tx) {
			skipped += 1;
			results.push({ agent_id: e.agent_id, status: 'settled', tx: e.settlement_tx, alreadyPaid: true });
			continue;
		}

		// Environment-level block (devnet / no wallet) — honest, with the unblock step.
		if (blockAll) {
			const note =
				blockAll === 'payout_unconfigured'
					? 'prize wallet unconfigured: set THREE_PRIZE_PAYOUT_KEY (Base58 64-byte secret holding $THREE)'
					: blockAll === 'pool_unfunded'
						? 'this prize pool was declared but never funded, so the platform wallet will not pay it (see ARENA_UNFUNDED_PRIZE_MAX_THREE)'
						: 'devnet tournaments do not pay real $THREE prizes';
			await recordSettlement({ tournamentId: tournament.id, agentId: e.agent_id, status: 'blocked', note });
			blocked += 1;
			results.push({ agent_id: e.agent_id, status: 'blocked', reason: blockAll, note });
			continue;
		}

		// Per-entry guard: a missing/invalid wallet can't be paid — block just this one.
		if (!BASE58_RE.test(String(e.wallet || ''))) {
			const note = 'entry has no valid Solana wallet to receive the prize';
			await recordSettlement({ tournamentId: tournament.id, agentId: e.agent_id, status: 'blocked', note });
			blocked += 1;
			results.push({ agent_id: e.agent_id, status: 'blocked', reason: 'invalid_wallet', note });
			continue;
		}

		try {
			const tx = await transferSolanaUSDC({
				fromWallet,
				toAddress: e.wallet,
				amount: BigInt(e.prize_three),
				mint,
			});
			await recordSettlement({ tournamentId: tournament.id, agentId: e.agent_id, status: 'settled', tx });
			settled += 1;
			results.push({ agent_id: e.agent_id, status: 'settled', tx, amount_atomics: String(e.prize_three) });
		} catch (err) {
			const note = `prize transfer failed: ${err?.message || 'unknown error'}`;
			await recordSettlement({ tournamentId: tournament.id, agentId: e.agent_id, status: 'blocked', note });
			blocked += 1;
			results.push({ agent_id: e.agent_id, status: 'blocked', reason: 'transfer_failed', note });
		}
	}

	return { settled, blocked, skipped, results };
}
