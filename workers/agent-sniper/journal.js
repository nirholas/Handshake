// agent-sniper — trade journal. The "learn what works" surface.
//
// Every entry and every exit leg is written here WITH its reasoning: why the
// mint was bought (mcap, score, trigger), and why/how much was sold (take-
// initials / trailing / stop / timeout, the fraction, the leg PnL). The point of
// the 10-SOL experiment is to learn, and you can only learn from a decision log
// that captures the *why*, not just the PnL. Read it via /api/sniper/journal.
//
// Best-effort: a journal write NEVER fails a trade. A dropped row costs a lesson,
// not money — so every call is wrapped and swallowed with a warning.

import { sql } from '../../api/_lib/db.js';
import { log } from './log.js';

/**
 * Lazy table create so a fresh env journals whether the migration ran or not.
 * agent_id and position_id are uuid because that is what every caller passes
 * (agent_sniper_strategies.agent_id and agent_sniper_positions.id are both
 * uuid); the original text/bigint shape made every INSERT here fail silently.
 */
let _ensured = false;
async function ensure() {
	if (_ensured) return;
	await sql`
		CREATE TABLE IF NOT EXISTS trading_journal (
			id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
			ts            timestamptz NOT NULL DEFAULT now(),
			agent_id      uuid,
			position_id   uuid,
			network       text,
			mint          text,
			symbol        text,
			event         text NOT NULL,          -- entry | take_initials | exit
			reason        text,                   -- trigger (entry) or exit reason
			mode          text,                   -- live | simulate
			venue         text,
			sold_fraction numeric,
			leg_pnl_lamports numeric,
			market_cap_usd   numeric,
			score            numeric,
			rationale     text,                   -- human-readable "why"
			sig           text
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS trading_journal_agent_ts_idx ON trading_journal (agent_id, ts DESC)`;
	_ensured = true;
}

/**
 * Record an entry. `mint` is the enriched candidate (carries market_cap_usd,
 * score, entry_trigger). `rationale` is the plain-language why.
 */
export async function journalEntry({ cfg, strat, mint, posId, sig, score, rationale }) {
	try {
		await ensure();
		await sql`
			INSERT INTO trading_journal
				(agent_id, position_id, network, mint, symbol, event, reason, mode, sold_fraction,
				 market_cap_usd, score, rationale, sig)
			VALUES (${strat.agent_id}, ${posId ?? null}, ${cfg.network}, ${mint.mint}, ${mint.symbol || null},
			        'entry', ${mint.entry_trigger || 'new_mint'}, ${cfg.mode}, 0,
			        ${mint.market_cap_usd ?? null}, ${score ?? null},
			        ${rationale || null}, ${sig || null})
		`;
	} catch (err) {
		log.warn('journal entry write failed', { agent: strat.agent_id, mint: mint?.mint, err: err?.message });
	}
}

/**
 * Record an exit leg (full or partial). `position` is the DB row; `legPnlLamports`
 * is a BigInt of the realized PnL on this leg.
 */
export async function recordJournal({ position, cfg, event, reason, sig, venue, soldFraction, legPnlLamports, remainingBase }) {
	try {
		await ensure();
		const rationale = event === 'take_initials'
			? `Reached the take-initials band — sold ${(soldFraction * 100).toFixed(0)}% to recover the cost basis; moon bag (${remainingBase?.toString?.() ?? '?'} base) rides on the trailing stop.`
			: `Full exit: ${reason}.`;
		await sql`
			INSERT INTO trading_journal
				(agent_id, position_id, network, mint, symbol, event, reason, mode, venue,
				 sold_fraction, leg_pnl_lamports, rationale, sig)
			VALUES (${position.agent_id}, ${position.id}, ${cfg.network}, ${position.mint}, ${position.symbol || null},
			        ${event}, ${reason}, ${cfg.mode}, ${venue || null},
			        ${soldFraction ?? null}, ${legPnlLamports != null ? legPnlLamports.toString() : null},
			        ${rationale}, ${sig || null})
		`;
	} catch (err) {
		log.warn('journal exit write failed', { position: position?.id, err: err?.message });
	}
}
