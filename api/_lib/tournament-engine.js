/**
 * Tournament engine — the orchestration seam between storage (tournament-store),
 * the pure scoring layer (tournament-scoring), on-chain attestation, and prize
 * settlement. The API handlers call into here; nothing here knows about HTTP.
 *
 * Responsibilities:
 *   - loadStandings()      — fetch entrants + their in-window positions, compute the
 *                            live ranked board, and project prize allocation.
 *   - finalizeTournament() — at/after close, freeze the final standings, persist
 *                            rank/score/prize per entry, attest the result on-chain,
 *                            and flip status to 'closed'. Idempotent and money-free.
 *   - settleNow()          — pay the frozen prizes in real $THREE (or report BLOCKED).
 */

import { sql } from './db.js';
import { env } from './env.js';
import { solUsdPrice } from './avatar-wallet.js';
import {
	getTournament,
	listEntries,
	setTournamentStatus,
	persistFinalStanding,
	derivedStatus,
} from './tournament-store.js';
import { computeStandings, allocatePrizes } from './tournament-scoring.js';
import { attestTournamentStandings, attestationUrl, TournamentAttestError } from './tournament-attest.js';
import { settleTournament, settlementBlockReason } from './tournament-settlement.js';

/** Fetch every entrant's positions opened inside the window, in one query. */
async function fetchEntrantPositions({ agentIds, network, startIso, endIso }) {
	if (!agentIds.length) return new Map();
	const rows = await sql`
		select p.id, p.agent_id, p.wallet, p.mint, p.symbol, p.name, p.status,
		       p.entry_quote_lamports, p.exit_quote_lamports, p.last_value_lamports,
		       p.realized_pnl_lamports, p.realized_pnl_pct, p.buy_sig, p.sell_sig,
		       p.opened_at, p.closed_at
		from agent_sniper_positions p
		where p.network = ${network}
		  and p.agent_id = any(${agentIds}::uuid[])
		  and p.opened_at >= ${startIso} and p.opened_at <= ${endIso}
	`;
	const byAgent = new Map(agentIds.map((id) => [id, []]));
	for (const r of rows) {
		const arr = byAgent.get(r.agent_id);
		if (arr) arr.push(r);
	}
	return byAgent;
}

let _solCache = { usd: null, at: 0 };
async function cachedSolUsd() {
	const now = Date.now();
	if (_solCache.usd != null && now - _solCache.at < 60_000) return _solCache.usd;
	try {
		const usd = await solUsdPrice();
		_solCache = { usd, at: now };
		return usd;
	} catch {
		return _solCache.usd;
	}
}

/**
 * Compute the live (or final, if already closed) standings view for a tournament,
 * including projected prize allocation. Pure-ish: reads DB, never writes.
 */
export async function loadStandings(tournament, { now = Date.now() } = {}) {
	const entries = await listEntries(tournament.id);
	const agentIds = entries.map((e) => e.agent_id);
	const startIso = tournament.starts_at;
	const endIso = new Date(Math.min(now, new Date(tournament.ends_at).getTime())).toISOString();
	const [positionsByAgent, solUsd] = await Promise.all([
		fetchEntrantPositions({ agentIds, network: tournament.network, startIso, endIso }),
		cachedSolUsd(),
	]);

	const pairs = entries.map((entry) => ({ entry, positions: positionsByAgent.get(entry.agent_id) || [] }));
	const computed = computeStandings(tournament, pairs, { solUsd, now });

	// Project prize allocation onto the live board so spectators see what's at stake.
	const pool = BigInt(tournament.prize_pool_three || 0);
	const alloc = allocatePrizes(pool, tournament.prize_splits || [], computed.standings);
	const decimals = env.THREE_TOKEN_DECIMALS;
	computed.standings = computed.standings.map((s) => {
		const atomics = alloc.get(s.agent_id) || 0n;
		return {
			...s,
			// Live board carries the persisted prize once frozen, else the projection.
			projected_prize_three_atomics: atomics.toString(),
			projected_prize_three: atomicsToThree(atomics, decimals),
			persisted_prize_three_atomics: persistedPrize(entries, s.agent_id),
			settlement_status: settlementOf(entries, s.agent_id),
			settlement_tx: settlementTxOf(entries, s.agent_id),
		};
	});

	return {
		...computed,
		sol_usd: solUsd,
		prize_pool_three_atomics: pool.toString(),
		prize_pool_three: atomicsToThree(pool, decimals),
		prize_splits: tournament.prize_splits || [],
	};
}

function persistedPrize(entries, agentId) {
	const e = entries.find((x) => x.agent_id === agentId);
	return e ? String(e.prize_three || 0) : '0';
}
function settlementOf(entries, agentId) {
	const e = entries.find((x) => x.agent_id === agentId);
	return e ? e.settlement_status : 'none';
}
function settlementTxOf(entries, agentId) {
	const e = entries.find((x) => x.agent_id === agentId);
	return e?.settlement_tx || null;
}

function atomicsToThree(atomics, decimals) {
	const a = BigInt(atomics);
	if (a === 0n) return 0;
	const div = 10n ** BigInt(decimals);
	const whole = a / div;
	const frac = a % div;
	return Number(`${whole}.${frac.toString().padStart(decimals, '0')}`);
}

/**
 * Freeze the final standings for a tournament whose window has ended. Persists each
 * entry's final rank/score/prize, attests the standings on-chain (best-effort), and
 * flips status to 'closed'. Idempotent: re-finalizing a closed tournament re-attests
 * only if no attestation exists yet, and re-persists the same frozen numbers.
 *
 * Money-free — prize TRANSFERS happen only in settleNow().
 *
 * @returns {{ standings, attestation:{status,signature,url,reason}|null, status }}
 */
export async function finalizeTournament(tournament, { now = Date.now() } = {}) {
	const ended = now >= new Date(tournament.ends_at).getTime();
	if (!ended) {
		const err = new Error('tournament window has not ended yet');
		err.status = 409;
		err.code = 'not_ended';
		throw err;
	}

	// Compute final standings as of the END of the window (clamp now to ends_at).
	const view = await loadStandings(tournament, { now: new Date(tournament.ends_at).getTime() + 1 });

	// Allocate and freeze prizes (prize bracket only).
	const pool = BigInt(tournament.prize_pool_three || 0);
	const alloc =
		tournament.bracket === 'prize' ? allocatePrizes(pool, tournament.prize_splits || [], view.standings) : new Map();

	for (const s of view.standings) {
		const prize = alloc.get(s.agent_id) || 0n;
		await persistFinalStanding({
			tournamentId: tournament.id,
			agentId: s.agent_id,
			rank: s.rank,
			score: s.score_value,
			prizeThree: prize,
			status: s.entry_status,
		});
	}

	// Attest on-chain — best-effort, honestly reported.
	let attestation = null;
	if (!view.standings.length) {
		// Nobody entered: there is no result to commit. Broadcasting a memo of an
		// empty board would burn a real signature (and real lamports) to prove
		// nothing, so an empty tournament closes unattested and says so.
		attestation = { status: 'skipped', signature: null, url: null, reason: 'no_entrants' };
	} else if (tournament.attestation_sig) {
		attestation = {
			status: 'deduped',
			signature: tournament.attestation_sig,
			url: attestationUrl(tournament.attestation_sig, tournament.network),
		};
	} else {
		try {
			const r = await attestTournamentStandings({ tournament, standings: view.standings, now });
			attestation = { status: r.status, signature: r.signature, url: attestationUrl(r.signature, tournament.network) };
			await setTournamentStatus(tournament.id, 'closed', {
				attestationSig: r.signature,
				attestationKind: r.kind,
			});
		} catch (err) {
			const reason = err instanceof TournamentAttestError ? err.code : 'attestation_failed';
			attestation = { status: 'unavailable', signature: null, url: null, reason, message: err.message };
		}
	}

	// Flip to closed even if attestation was unavailable (standings are still frozen).
	const updated = await setTournamentStatus(tournament.id, 'closed');

	return { standings: view.standings, attestation, status: updated?.status || 'closed', view };
}

/**
 * Pay the frozen prizes. Requires the tournament to be finalized (status closed or
 * settled). Returns the per-entry settlement outcome; BLOCKED entries are honest.
 */
export async function settleNow(tournamentId, { now = Date.now() } = {}) {
	const tournament = await getTournament(tournamentId);
	if (!tournament) {
		const err = new Error('tournament not found');
		err.status = 404;
		err.code = 'not_found';
		throw err;
	}
	if (!['closed', 'settled'].includes(tournament.status)) {
		const err = new Error(`tournament is ${tournament.status}, not finalized — close it first`);
		err.status = 409;
		err.code = 'not_finalized';
		throw err;
	}
	const entries = await listEntries(tournamentId);
	const result = await settleTournament(tournament, entries);

	// If every prize is settled (none left pending/blocked among winners), mark the
	// tournament settled. A blocked environment leaves it 'closed' so a later retry
	// (once the wallet is funded) can finish the job.
	const refreshed = await listEntries(tournamentId);
	const winners = refreshed.filter((e) => BigInt(e.prize_three || 0) > 0n && e.status !== 'withdrawn');
	const allPaid = winners.length > 0 && winners.every((e) => e.settlement_status === 'settled');
	if (allPaid) await setTournamentStatus(tournamentId, 'settled');

	return {
		...result,
		block_reason: settlementBlockReason(tournament.network, tournament),
		status: allPaid ? 'settled' : tournament.status,
	};
}

/** Expose the time-derived lifecycle for handlers that need it. */
export { derivedStatus };
