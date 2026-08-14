/**
 * The house arena: the always-on daily competition that makes /arena a place
 * worth loading.
 *
 * The Arena shipped as a build-your-own-tournament tool, which gave it a cold
 * start it never escaped: nobody creates a tournament for an empty room, so the
 * room stayed empty and the route showed a single stale card. Meanwhile the
 * platform's sniper agents were already trading real pump.fun coins every day
 * with on-chain verifiable P&L. The two were never wired together.
 *
 * This module is that wire. It keeps exactly one house-run competition live at
 * all times (today's), one queued (tomorrow's), enters every agent that actually
 * trades, and finalizes, attests and settles the ones whose window has closed.
 * User-created tournaments still work exactly as before and are untouched by
 * every sweep here: a house row is identified by entry_rules.house.
 *
 * Honesty rules that shape the design:
 *   - A prize is advertised only when it can actually be paid. The daily pool is
 *     opt-in via ARENA_DAILY_PRIZE_THREE and is applied ONLY when the payout
 *     wallet is configured; otherwise the day runs as a zero-pool bragging-rights
 *     bracket rather than promising $THREE that would settle BLOCKED.
 *   - Auto-entry publishes nothing new. Every agent it enters is already ranked
 *     by name, wallet and realized P&L on the public /api/sniper/leaderboard.
 *     Owners can still withdraw an entry through the normal endpoint.
 *   - Ranking is realized P&L, the number a spectator can verify per row against
 *     Solscan. The verification gates still decide PRIZE eligibility, so a
 *     one-coin churn run can top the board for a day but cannot be paid for it.
 */

import { sql } from './db.js';
import { env } from './env.js';
import {
	ensureTournamentTables,
	getTournament,
	joinTournament,
	listTournaments,
	derivedStatus,
} from './tournament-store.js';
import { finalizeTournament, settleNow } from './tournament-engine.js';
import { prizeWalletConfigured } from './tournament-settlement.js';
import { computeTraderMetrics } from './trader-stats.js';

/** Marker written into entry_rules so house rows are distinguishable forever. */
export const HOUSE_KIND = 'daily';

/** Prize split for the daily, in basis points by rank. */
export const DAILY_SPLITS = [
	{ rank: 1, bps: 6000 },
	{ rank: 2, bps: 3000 },
	{ rank: 3, bps: 1000 },
];

/**
 * Entry gates for the daily. Deliberately looser than DEFAULT_GATES on unique
 * coins (a day is short; two coins in 24h is a real bar for a sniper, three
 * closed trades is not) and unchanged on churn.
 */
export const DAILY_GATES = { min_closed: 2, min_unique_coins: 2, max_churn_pct: 60 };

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The UTC day containing `now`, as an exact [00:00, 24:00) window. UTC and not a
 * local zone on purpose: the window has to mean the same thing to a spectator in
 * every timezone, and the attested result has to be reproducible from the row.
 */
export function utcDayWindow(now = Date.now()) {
	const d = new Date(now);
	const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
	return { startMs: start, endMs: start + DAY_MS };
}

/** Human name for a day's arena, e.g. "Daily Arena, Aug 14". */
export function houseName(startMs) {
	const d = new Date(startMs);
	return `Daily Arena, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function houseDescription() {
	return (
		'Every three.ws agent that trades today, ranked on real pump.fun P&L from trades opened inside the window. ' +
		'Live board, every row traceable on-chain, standings attested at the bell.'
	);
}

/**
 * Resolve the daily prize pool, in $THREE atomics. Returns 0n unless the owner
 * configured a pool AND the payout wallet exists, so the Arena never advertises
 * a prize it would have to settle as BLOCKED.
 */
export function dailyPrizeAtomics({ configured = prizeWalletConfigured() } = {}) {
	const amount = Number(env.ARENA_DAILY_PRIZE_THREE || 0);
	if (!Number.isFinite(amount) || amount <= 0) return 0n;
	if (!configured) return 0n;
	const decimals = env.THREE_TOKEN_DECIMALS;
	const [whole, frac = ''] = String(amount).split('.');
	const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
	return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
}

/** The entry_rules blob every house row carries. */
export function houseEntryRules() {
	return { house: HOUSE_KIND, ...DAILY_GATES };
}

/**
 * Insert one day's house arena. Idempotent under concurrency: the partial unique
 * index (tournaments_house_window_uniq) makes a double-insert a no-op rather than
 * a duplicate board, and the existing row is returned instead.
 */
async function insertHouseDay({ network, startMs, endMs, now }) {
	const poolAtomics = dailyPrizeAtomics();
	const [row] = await sql`
		insert into tournaments (
			name, description, network, scoring, bracket,
			starts_at, ends_at, entry_rules, prize_pool_three, prize_splits, status, created_by
		) values (
			${houseName(startMs)}, ${houseDescription()}, ${network}, 'realized_pnl', 'prize',
			${new Date(startMs).toISOString()}, ${new Date(endMs).toISOString()},
			${JSON.stringify(houseEntryRules())}::jsonb,
			${poolAtomics.toString()},
			${JSON.stringify(poolAtomics > 0n ? DAILY_SPLITS : [])}::jsonb,
			${startMs <= now ? 'live' : 'upcoming'}, null
		)
		on conflict (network, starts_at) where (entry_rules->>'house') is not null do nothing
		returning *
	`;
	if (row) return { row, created: true };
	const [existing] = await sql`
		select * from tournaments
		where network = ${network} and starts_at = ${new Date(startMs).toISOString()}
		  and (entry_rules->>'house') is not null
		limit 1
	`;
	return { row: existing || null, created: false };
}

/**
 * Guarantee the route is never empty: today's arena exists and is live, and
 * tomorrow's exists so the Upcoming tab has something real in it the moment
 * today's closes.
 */
export async function ensureHouseArenas({ network = 'mainnet', now = Date.now() } = {}) {
	await ensureTournamentTables();
	const today = utcDayWindow(now);
	const tomorrow = { startMs: today.endMs, endMs: today.endMs + DAY_MS };

	const results = [];
	for (const win of [today, tomorrow]) {
		const { row, created } = await insertHouseDay({ network, startMs: win.startMs, endMs: win.endMs, now });
		if (row) results.push({ id: row.id, name: row.name, created, starts_at: row.starts_at, ends_at: row.ends_at });
	}

	// A row inserted as 'upcoming' yesterday needs its stored status advanced once
	// its window opens. derivedStatus() already renders it correctly to readers;
	// this keeps the stored column honest for anything querying it directly.
	await sql`
		update tournaments set status = 'live', updated_at = now()
		where (entry_rules->>'house') is not null and network = ${network}
		  and status = 'upcoming' and starts_at <= now() and ends_at > now()
	`;

	return { arenas: results, created: results.filter((r) => r.created).length };
}

/**
 * Every agent worth putting on today's board: one with a live trading mandate
 * (an armed sniper strategy) or a demonstrated one (a real position opened in
 * the recent past). Both arms require a resolvable Solana wallet, because an
 * entry without one can never produce a verifiable row.
 */
export async function eligibleAgents({ network = 'mainnet', lookbackDays = 14 } = {}) {
	const rows = await sql`
		with armed as (
			select s.agent_id
			from agent_sniper_strategies s
			where s.network = ${network}
			  and s.enabled = true and s.kill_switch = false
			  and s.daily_budget_lamports > 0
		),
		recent as (
			select distinct p.agent_id
			from agent_sniper_positions p
			where p.network = ${network}
			  and p.opened_at > now() - (${lookbackDays} * interval '1 day')
			  and p.buy_sig is not null and p.buy_sig <> 'SIMULATED'
		),
		candidates as (
			select agent_id from armed union select agent_id from recent
		)
		select a.id as agent_id, a.name as agent_name,
		       coalesce(
		           (select p.wallet from agent_sniper_positions p
		             where p.agent_id = a.id and p.network = ${network} and p.wallet is not null
		             order by p.opened_at desc limit 1),
		           a.wallet_address
		       ) as wallet
		from candidates c
		join agent_identities a on a.id = c.agent_id
		where a.deleted_at is null
	`;
	return rows.filter((r) => r.wallet);
}

/**
 * Baseline snapshot recorded on an auto-entry, mirroring what the manual join
 * endpoint stores so the two entry paths stay auditable in the same way.
 */
async function baselineSnapshot(agentId, network, now) {
	try {
		const positions = await sql`
			select status, entry_quote_lamports, exit_quote_lamports, last_value_lamports,
			       realized_pnl_lamports, realized_pnl_pct, mint, buy_sig, opened_at, closed_at
			from agent_sniper_positions
			where agent_id = ${agentId} and network = ${network}
		`;
		const m = computeTraderMetrics(positions, { solUsd: null });
		return {
			at: new Date(now).toISOString(),
			source: 'house_auto_entry',
			all_time_closed: m.closed_count,
			all_time_realized_pnl_sol: m.realized_pnl_sol,
			all_time_score: m.score,
			verified: m.verified,
		};
	} catch {
		return { at: new Date(now).toISOString(), source: 'house_auto_entry' };
	}
}

/**
 * Enter every eligible agent into a house arena. Idempotent: joinTournament is a
 * no-op for an agent already entered, and a withdrawn entry is left withdrawn
 * rather than silently re-added, so an owner opting out stays opted out.
 */
export async function autoEnroll(tournament, { now = Date.now() } = {}) {
	const agents = await eligibleAgents({ network: tournament.network });
	let entered = 0;
	for (const a of agents) {
		const snapshot = await baselineSnapshot(a.agent_id, tournament.network, now);
		const { created } = await joinTournament({
			tournamentId: tournament.id,
			agentId: a.agent_id,
			wallet: a.wallet,
			snapshot,
		});
		if (created) entered += 1;
	}
	return { candidates: agents.length, entered };
}

/**
 * Finalize every tournament whose window has closed but which was never frozen.
 * Covers house AND user-created rows: nothing else in the codebase runs this, so
 * before this sweep existed an ended tournament sat at 'ended' forever with no
 * attestation and no payout. Settlement is attempted only when a pool exists.
 */
export async function sweepFinished({ network = 'mainnet', now = Date.now(), limit = 10 } = {}) {
	const rows = await listTournaments({ network, now, limit: 200 });
	const pending = rows.filter((r) => derivedStatus(r, now) === 'ended').slice(0, limit);
	const done = [];
	for (const row of pending) {
		const t = await getTournament(row.id);
		if (!t) continue;
		try {
			const result = await finalizeTournament(t, { now });
			const out = {
				id: t.id,
				name: t.name,
				status: result.status,
				attestation: result.attestation?.status || null,
				ranked: result.standings.filter((s) => s.rank != null).length,
			};
			// Auto-settlement is for the house bracket ONLY. A user-declared pool is
			// escrowed nowhere (POST /api/tournaments takes the number on the creator's
			// word), so paying one from the platform wallet on a timer would turn
			// tournament creation into a scheduled treasury withdrawal. Those stay
			// creator-driven, and poolBacked() gates the payout itself either way.
			if ((t.entry_rules || {}).house && BigInt(t.prize_pool_three || 0) > 0n) {
				const settled = await settleNow(t.id, { now }).catch((err) => ({ error: err.message }));
				out.settlement = settled.error ? { error: settled.error } : { block_reason: settled.block_reason || null };
			}
			done.push(out);
		} catch (err) {
			done.push({ id: t.id, name: t.name, error: err.message });
		}
	}
	return done;
}

/**
 * One tick of the house arena: keep the board stocked, keep it populated, and
 * close out whatever the clock has ended. Each stage is independent so a failure
 * in one never starves the others.
 */
export async function arenaTick({ network = 'mainnet', now = Date.now() } = {}) {
	const summary = { network, at: new Date(now).toISOString() };

	try {
		summary.ensured = await ensureHouseArenas({ network, now });
	} catch (err) {
		summary.ensured = { error: err.message };
	}

	try {
		const rows = await listTournaments({ network, now, limit: 200 });
		const live = rows.find((r) => (r.entry_rules || {}).house && derivedStatus(r, now) === 'live');
		summary.enrolled = live ? { tournament: live.id, ...(await autoEnroll(live, { now })) } : { tournament: null };
	} catch (err) {
		summary.enrolled = { error: err.message };
	}

	try {
		summary.finalized = await sweepFinished({ network, now });
	} catch (err) {
		summary.finalized = { error: err.message };
	}

	return summary;
}
