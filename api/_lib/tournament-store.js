/**
 * Tournament store — the persistence layer for the Social Trading Arena.
 *
 * Mirrors the lazy-ensure pattern used across the codebase (see diorama-store.js):
 * the tables are created on first use so the Arena self-heals in any environment,
 * and the canonical schema also ships as a migration
 * (migrations/20260623120000_tournaments.sql) for production.
 *
 * This module owns ONLY storage + lifecycle state transitions. All scoring lives
 * in tournament-scoring.js (pure), attestation in tournament-attest.js, and prize
 * settlement in tournament-settlement.js — so each layer stays independently
 * testable and the truth math is never duplicated.
 */

import { sql } from './db.js';

let _ensured = null;

/** Create the tournament tables + indexes once per process. Idempotent. */
export function ensureTournamentTables() {
	if (_ensured) return _ensured;
	_ensured = (async () => {
		await sql`
			create table if not exists tournaments (
				id                 uuid primary key default gen_random_uuid(),
				name               text not null check (length(name) between 1 and 120),
				description        text,
				network            text not null default 'mainnet' check (network in ('mainnet','devnet')),
				scoring            text not null default 'score' check (scoring in ('score','realized_pnl','roi_pct')),
				bracket            text not null default 'prize' check (bracket in ('prize','practice')),
				starts_at          timestamptz not null,
				ends_at            timestamptz not null,
				entry_rules        jsonb not null default '{}'::jsonb,
				prize_pool_three   numeric(40, 0) not null default 0,
				prize_splits       jsonb not null default '[]'::jsonb,
				status             text not null default 'upcoming'
					check (status in ('draft','upcoming','live','closed','settled','cancelled')),
				attestation_sig    text,
				attestation_kind   text,
				created_by         uuid,
				created_at         timestamptz not null default now(),
				updated_at         timestamptz not null default now(),
				constraint tournaments_window_ordered check (ends_at > starts_at),
				constraint tournaments_prize_nonneg check (prize_pool_three >= 0)
			)
		`;
		await sql`create index if not exists tournaments_status_start_idx on tournaments (status, starts_at desc)`;
		await sql`create index if not exists tournaments_network_end_idx on tournaments (network, ends_at desc)`;
		// One house arena per day per network, so two overlapping keeper ticks can never
		// split a day's entrants across two boards. Mirrors the index in
		// migrations/20260814180000_arena_house_daily.sql for a fresh bootstrap.
		await sql`
			create unique index if not exists tournaments_house_window_uniq
				on tournaments (network, starts_at)
				where (entry_rules->>'house') is not null
		`;
		await sql`
			create table if not exists tournament_entries (
				id                 uuid primary key default gen_random_uuid(),
				tournament_id      uuid not null references tournaments(id) on delete cascade,
				agent_id           uuid not null references agent_identities(id) on delete cascade,
				wallet             text,
				joined_at          timestamptz not null default now(),
				starting_snapshot  jsonb not null default '{}'::jsonb,
				status             text not null default 'active'
					check (status in ('active','disqualified','withdrawn')),
				dq_reason          text,
				final_rank         int,
				final_score        numeric,
				prize_three        numeric(40, 0) not null default 0,
				settlement_status  text not null default 'none'
					check (settlement_status in ('none','pending','settled','blocked')),
				settlement_tx      text,
				settlement_note    text,
				settled_at         timestamptz,
				created_at         timestamptz not null default now(),
				updated_at         timestamptz not null default now(),
				unique (tournament_id, agent_id)
			)
		`;
		await sql`create index if not exists tournament_entries_tid_idx on tournament_entries (tournament_id)`;
		await sql`create index if not exists tournament_entries_agent_idx on tournament_entries (agent_id)`;
		await sql`
			create unique index if not exists tournament_entries_settlement_tx_uniq
				on tournament_entries (settlement_tx) where settlement_tx is not null
		`;
		return true;
	})().catch((err) => {
		console.error('[tournament-store] ensureTournamentTables failed:', err?.message);
		_ensured = null;
		throw err;
	});
	return _ensured;
}

/**
 * Derive the lifecycle status a tournament SHOULD be in for a given clock, without
 * mutating anything. 'closed'/'settled'/'cancelled' are terminal and pass through;
 * the rest are time-derived so a row never looks 'upcoming' after it has started.
 */
export function derivedStatus(row, now = Date.now()) {
	if (['closed', 'settled', 'cancelled', 'draft'].includes(row.status)) return row.status;
	const start = new Date(row.starts_at).getTime();
	const end = new Date(row.ends_at).getTime();
	if (now >= end) return 'ended'; // past the window but not yet finalized on-chain
	if (now >= start) return 'live';
	return 'upcoming';
}

/** Coarse phase for the UI/filter layer: upcoming | live | finished. */
export function phaseOf(row, now = Date.now()) {
	const d = derivedStatus(row, now);
	if (d === 'upcoming' || d === 'draft') return 'upcoming';
	if (d === 'live') return 'live';
	return 'finished'; // ended | closed | settled | cancelled
}

export async function createTournament(input) {
	await ensureTournamentTables();
	const [row] = await sql`
		insert into tournaments (
			name, description, network, scoring, bracket,
			starts_at, ends_at, entry_rules, prize_pool_three, prize_splits, status, created_by
		) values (
			${input.name}, ${input.description ?? null}, ${input.network}, ${input.scoring}, ${input.bracket},
			${input.starts_at}, ${input.ends_at}, ${JSON.stringify(input.entry_rules ?? {})}::jsonb,
			${String(input.prize_pool_three ?? 0)}, ${JSON.stringify(input.prize_splits ?? [])}::jsonb,
			${input.status ?? 'upcoming'}, ${input.created_by ?? null}
		)
		returning *
	`;
	return row;
}

export async function getTournament(id) {
	await ensureTournamentTables();
	const [row] = await sql`select * from tournaments where id = ${id} limit 1`;
	return row || null;
}

/**
 * List tournaments, newest window first. The coarse `phase` (upcoming|live|finished)
 * is derived from `now` in JS after the fetch, so the list never lags the clock the
 * way a stored status would; `phase` filters that derived value.
 */
export async function listTournaments({ network = null, phase = null, limit = 60, now = Date.now() } = {}) {
	await ensureTournamentTables();
	const rows = await sql`
		select t.*,
		       (select count(*)::int from tournament_entries e
		         where e.tournament_id = t.id and e.status <> 'withdrawn') as entrant_count
		from tournaments t
		where (${network}::text is null or t.network = ${network})
		order by t.starts_at desc
		limit ${Math.min(Math.max(limit, 1), 200)}
	`;
	const withPhase = rows.map((r) => ({ ...r, phase: phaseOf(r, now), derived_status: derivedStatus(r, now) }));
	return phase ? withPhase.filter((r) => r.phase === phase) : withPhase;
}

/** Entries for a tournament, joined to identity for rendering (name/image/glb/wallet). */
export async function listEntries(tournamentId) {
	await ensureTournamentTables();
	return sql`
		select e.*,
		       a.name as agent_name,
		       a.profile_image_url, a.avatar_url, a.is_public
		from tournament_entries e
		join agent_identities a on a.id = e.agent_id
		where e.tournament_id = ${tournamentId}
		order by e.joined_at asc
	`;
}

export async function getEntry(tournamentId, agentId) {
	await ensureTournamentTables();
	const [row] = await sql`
		select * from tournament_entries
		where tournament_id = ${tournamentId} and agent_id = ${agentId} limit 1
	`;
	return row || null;
}

/**
 * Join a tournament. Idempotent on (tournament_id, agent_id): a re-join keeps the
 * original baseline snapshot and joined_at (scoring is scoped by the tournament
 * window, not by entry time, so the first entry is the honest record). Stores the
 * join-time wallet + all-time metrics snapshot so window scoping is auditable.
 *
 * An entry that was WITHDRAWN is flipped back to active, because the alternative is
 * worse than a rejection: the insert conflicts, the handler answers `joined: true`
 * off the stale row, the UI congratulates the user, and the agent sits out the whole
 * tournament. A disqualified entry is never revived this way.
 */
export async function joinTournament({ tournamentId, agentId, wallet, snapshot }) {
	await ensureTournamentTables();
	const [row] = await sql`
		insert into tournament_entries (tournament_id, agent_id, wallet, starting_snapshot)
		values (${tournamentId}, ${agentId}, ${wallet ?? null}, ${JSON.stringify(snapshot ?? {})}::jsonb)
		on conflict (tournament_id, agent_id) do nothing
		returning *
	`;
	if (row) return { entry: row, created: true };
	const [rejoined] = await sql`
		update tournament_entries
		set status = 'active', wallet = coalesce(${wallet ?? null}, wallet), updated_at = now()
		where tournament_id = ${tournamentId} and agent_id = ${agentId} and status = 'withdrawn'
		returning *
	`;
	if (rejoined) return { entry: rejoined, created: false };
	const existing = await getEntry(tournamentId, agentId);
	return { entry: existing, created: false };
}

export async function withdrawEntry(tournamentId, agentId) {
	await ensureTournamentTables();
	const [row] = await sql`
		update tournament_entries
		set status = 'withdrawn', updated_at = now()
		where tournament_id = ${tournamentId} and agent_id = ${agentId} and status = 'active'
		returning *
	`;
	return row || null;
}

/** Mark the tournament status (and optional attestation) atomically. */
export async function setTournamentStatus(id, status, { attestationSig, attestationKind } = {}) {
	await ensureTournamentTables();
	const [row] = await sql`
		update tournaments
		set status = ${status},
		    attestation_sig = coalesce(${attestationSig ?? null}, attestation_sig),
		    attestation_kind = coalesce(${attestationKind ?? null}, attestation_kind),
		    updated_at = now()
		where id = ${id}
		returning *
	`;
	return row || null;
}

/** Persist a computed final standing for one entry (rank, score, allocated prize). */
export async function persistFinalStanding({ tournamentId, agentId, rank, score, prizeThree, status, dqReason }) {
	await ensureTournamentTables();
	const [row] = await sql`
		update tournament_entries
		set final_rank = ${rank ?? null},
		    final_score = ${score ?? null},
		    prize_three = ${String(prizeThree ?? 0)},
		    status = ${status ?? 'active'},
		    dq_reason = ${dqReason ?? null},
		    settlement_status = case
		        when ${String(prizeThree ?? 0)}::numeric > 0 then 'pending'
		        else settlement_status end,
		    updated_at = now()
		where tournament_id = ${tournamentId} and agent_id = ${agentId}
		returning *
	`;
	return row || null;
}

/**
 * Record the outcome of a prize settlement attempt for one entry. `settled` carries
 * a real tx; `blocked` carries an honest reason (e.g. payout wallet unconfigured) and
 * never a fake proof. Idempotent: a row already 'settled' is left untouched.
 */
export async function recordSettlement({ tournamentId, agentId, status, tx, note }) {
	await ensureTournamentTables();
	const [row] = await sql`
		update tournament_entries
		set settlement_status = ${status},
		    settlement_tx = coalesce(${tx ?? null}, settlement_tx),
		    settlement_note = ${note ?? null},
		    settled_at = case when ${status} = 'settled' then now() else settled_at end,
		    updated_at = now()
		where tournament_id = ${tournamentId} and agent_id = ${agentId}
		  and settlement_status <> 'settled'
		returning *
	`;
	return row || null;
}
