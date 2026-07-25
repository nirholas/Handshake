// What the LLM judge is allowed to know, scaled by what the arm has earned.
//
// The judge used to see one thing: the launch in front of it. Name, socials,
// creator history, market cap, and the market-realness read. That is the same
// context whether the arm has been printing for a month or has never closed a
// profitable trade, which means a proven arm was being asked to decide with its
// hands tied to the same information as a failing one.
//
// This module builds the extra context an earned arm gets, straight out of the
// tables the fleet already fills:
//
//   informed (trusted tier)
//     • the ground-truth base rate: what fraction of launches actually win, so
//       the model knows how skeptical the prior should be.
//     • the learned signal weights (pump_intel_weights), retrained every 15 min
//       from labeled outcomes: which launch-time signals correlate with wins.
//     • the arm's OWN realized record: how many trades, what it won and lost,
//       and what its winners actually looked like.
//
//   full (autonomous tier)
//     • the conditional win-rate table: per signal bucket, the realized win rate
//       versus the baseline. This is the "what actually works" evidence, not a
//       correlation coefficient the model has to interpret.
//     • the model's own calibration: how its past buy calls on this network
//       actually turned out, so it can correct its own bias.
//
// Everything here is read from real rows. When a table is empty or the DB is
// unreachable the pack degrades to a shorter block or to nothing at all, and the
// judge falls back to exactly the prompt it used before. There is no synthetic
// or placeholder knowledge anywhere in this file: an arm is told what is true or
// it is told nothing.

import { sql } from '../../api/_lib/db.js';
import { classifyAutonomy, knowledgeFor } from '../../api/_lib/sniper-autonomy.js';
import { log } from './log.js';

const FLEET_TTL_MS = 5 * 60_000;   // base rate + weights: fleet-wide, changes slowly
const ARM_TTL_MS = 5 * 60_000;     // per-arm record: cheap query, still worth caching

let _fleet = null;
let _fleetAt = 0;
const _arms = new Map(); // strategyId → { value, ts }
const _calibration = new Map(); // model → { value, ts }

/** Ground-truth base rate + the latest trained weights and win-rate table. */
async function fleetKnowledge(network) {
	if (_fleet && Date.now() - _fleetAt < FLEET_TTL_MS) return _fleet;
	try {
		const [[rate], [trained]] = await Promise.all([
			sql`
				select
					count(*) filter (where outcome in ('pumped','graduated'))::float
						/ nullif(count(*), 0) as base_rate,
					count(*) as labeled
				from pump_coin_outcomes
			`,
			sql`
				select weights, sample_size, conditional_win_rates
				from pump_intel_weights
				where network = ${network}
				order by trained_at desc limit 1
			`,
		]);
		_fleet = {
			baseRate: rate?.base_rate != null ? Number(rate.base_rate) : null,
			labeled: Number(rate?.labeled) || 0,
			weights: trained?.weights || null,
			sampleSize: Number(trained?.sample_size) || 0,
			conditional: trained?.conditional_win_rates || null,
		};
		_fleetAt = Date.now();
		return _fleet;
	} catch (err) {
		log.warn('judge knowledge: fleet read failed', { err: err?.message });
		return null;
	}
}

/**
 * One arm's own realized record, and the tier it earns. Real fills only: paper
 * trades teach the fleet but they are not this arm's money and do not buy it rope.
 */
export async function armRecord(strategyId, network) {
	const cached = _arms.get(strategyId);
	if (cached && Date.now() - cached.ts < ARM_TTL_MS) return cached.value;
	try {
		const [row] = await sql`
			select
				count(*)                                                          as closed,
				count(*) filter (where realized_pnl_lamports > 0)                 as wins,
				coalesce(sum(realized_pnl_lamports), 0)                           as net_lamports,
				coalesce(avg(realized_pnl_pct), 0)                                as avg_pct,
				max(realized_pnl_pct)                                             as best_pct,
				min(realized_pnl_pct)                                             as worst_pct,
				coalesce(avg(extract(epoch from (closed_at - opened_at))), 0)     as avg_hold_s
			from agent_sniper_positions
			where strategy_id = ${strategyId} and network = ${network}
			  and status = 'closed' and buy_sig <> 'SIMULATED'
		`;
		const record = {
			closed: Number(row?.closed) || 0,
			wins: Number(row?.wins) || 0,
			netPnlLamports: Number(row?.net_lamports) || 0,
			avgPnlPct: Number(row?.avg_pct) || 0,
			bestPnlPct: row?.best_pct != null ? Number(row.best_pct) : null,
			worstPnlPct: row?.worst_pct != null ? Number(row.worst_pct) : null,
			avgHoldSeconds: Math.round(Number(row?.avg_hold_s) || 0),
		};
		const value = { record, autonomy: classifyAutonomy(record) };
		_arms.set(strategyId, { value, ts: Date.now() });
		return value;
	} catch (err) {
		log.warn('judge knowledge: arm record read failed', { strategyId, err: err?.message });
		return null;
	}
}

/**
 * How this model's own past calls actually turned out. Buy verdicts scored
 * against the labeled outcome of the coin they were made on: the counterfactual
 * a trade record cannot capture, because it also covers the ones it skipped.
 */
async function modelCalibration(model, network) {
	const cached = _calibration.get(model);
	if (cached && Date.now() - cached.ts < FLEET_TTL_MS) return cached.value;
	try {
		const [row] = await sql`
			select
				count(*) filter (where v.buy)                                                          as buy_calls,
				count(*) filter (where v.buy and o.outcome in ('pumped','graduated'))                  as buy_right,
				count(*) filter (where not v.buy)                                                      as skip_calls,
				count(*) filter (where not v.buy and o.outcome in ('pumped','graduated'))              as skip_wrong
			from sniper_llm_verdicts v
			join pump_coin_outcomes o on o.mint = v.mint
			where v.model = ${model} and v.network = ${network} and o.outcome <> 'unknown'
		`;
		const value = {
			buyCalls: Number(row?.buy_calls) || 0,
			buyRight: Number(row?.buy_right) || 0,
			skipCalls: Number(row?.skip_calls) || 0,
			skipWrong: Number(row?.skip_wrong) || 0,
		};
		_calibration.set(model, { value, ts: Date.now() });
		return value;
	} catch (err) {
		log.warn('judge knowledge: calibration read failed', { model, err: err?.message });
		return null;
	}
}

/**
 * Pick the most informative buckets out of the conditional win-rate table: the
 * ones whose realized win rate diverges most from the baseline. A model handed
 * forty near-baseline rows learns nothing; handed the eight that actually move
 * the needle, it can act on them.
 *
 * Pure, exported for tests.
 */
export function topBuckets(conditional, limit = 8) {
	if (!conditional || typeof conditional !== 'object') return [];
	const rows = [];
	for (const [signal, buckets] of Object.entries(conditional)) {
		if (!buckets || typeof buckets !== 'object') continue;
		for (const [bucket, stat] of Object.entries(buckets)) {
			// Number(null) is 0, not NaN: without the explicit null check a missing
			// win rate would render as a confident "0%" in the prompt. The judge is
			// told what is true or it is told nothing.
			if (stat?.win_rate == null || stat?.baseline_win_rate == null) continue;
			const rate = Number(stat.win_rate);
			const baseline = Number(stat.baseline_win_rate);
			const count = Number(stat.count) || 0;
			if (!Number.isFinite(rate) || !Number.isFinite(baseline) || !count) continue;
			rows.push({ signal, bucket, rate, baseline, count, lift: rate - baseline });
		}
	}
	rows.sort((a, b) => Math.abs(b.lift) - Math.abs(a.lift));
	return rows.slice(0, limit);
}

const pct = (n) => `${(n * 100).toFixed(0)}%`;

/**
 * Build the extra context block for one arm's judge call.
 *
 * @param {{ strategyId:string, network:string, model:string }} arm
 * @returns {Promise<{ tier:string, depth:string, block:string }>}
 *   `block` is '' when the arm has earned no extra context or no real data
 *   exists yet, in which case the judge prompt is unchanged from its original.
 */
export async function buildKnowledgePack({ strategyId, network = 'mainnet', model }) {
	const armed = strategyId ? await armRecord(strategyId, network) : null;
	const tier = armed?.autonomy?.tier || 'standard';
	const depth = knowledgeFor(tier);
	if (depth === 'base') return { tier, depth, block: '' };

	const fleet = await fleetKnowledge(network);
	const lines = [];

	if (fleet?.baseRate != null && fleet.labeled > 0) {
		lines.push(
			`BASE RATE: ${pct(fleet.baseRate)} of ${fleet.labeled.toLocaleString('en-US')} labeled launches actually went on to pump or graduate. ` +
			`Most launches fail; a verdict that would buy far more than ${pct(fleet.baseRate)} of what it sees is miscalibrated.`,
		);
	}

	const r = armed?.record;
	if (r && r.closed > 0) {
		const wr = Math.round((r.wins / r.closed) * 100);
		const net = (r.netPnlLamports / 1e9).toFixed(4);
		lines.push(
			`YOUR OWN RECORD ON THIS ARM: ${r.closed} closed trades, ${r.wins} winners (${wr}% hit rate), ` +
			`net ${net} SOL, average ${r.avgPnlPct >= 0 ? '+' : ''}${r.avgPnlPct.toFixed(1)}% per trade` +
			(r.bestPnlPct != null ? `, best +${r.bestPnlPct.toFixed(0)}%` : '') +
			(r.worstPnlPct != null ? `, worst ${r.worstPnlPct.toFixed(0)}%` : '') +
			(r.avgHoldSeconds ? `, average hold ${Math.round(r.avgHoldSeconds / 60)} min` : '') + '. ' +
			`This is the record that earned you the extra context below. A low hit rate is fine if the winners pay for the losers.`,
		);
	}

	if (fleet?.weights && fleet.sampleSize > 0) {
		const ranked = Object.entries(fleet.weights)
			.filter(([, w]) => Number.isFinite(Number(w)))
			.sort((a, b) => Math.abs(Number(b[1])) - Math.abs(Number(a[1])))
			.slice(0, 8)
			.map(([k, w]) => `${k} ${Number(w) >= 0 ? '+' : ''}${Number(w).toFixed(3)}`);
		if (ranked.length) {
			lines.push(
				`LEARNED SIGNAL WEIGHTS (correlation with a winning outcome, trained on ${fleet.sampleSize.toLocaleString('en-US')} labeled launches): ` +
				`${ranked.join(', ')}. Positive means the signal tracks winners, negative means it tracks losers.`,
			);
		}
	}

	if (depth === 'full') {
		const buckets = topBuckets(fleet?.conditional);
		if (buckets.length) {
			lines.push(
				'REALIZED WIN RATES BY SIGNAL BUCKET (what actually happened, not a correlation): ' +
				buckets.map((b) => `${b.signal}=${b.bucket} → ${pct(b.rate)} vs ${pct(b.baseline)} baseline (n=${b.count})`).join('; ') + '.',
			);
		}
		const cal = model ? await modelCalibration(model, network) : null;
		if (cal && (cal.buyCalls > 0 || cal.skipCalls > 0)) {
			const parts = [];
			if (cal.buyCalls > 0) parts.push(`of your ${cal.buyCalls} past BUY calls, ${cal.buyRight} (${pct(cal.buyRight / cal.buyCalls)}) landed on a coin that pumped or graduated`);
			if (cal.skipCalls > 0) parts.push(`of your ${cal.skipCalls} past SKIP calls, ${cal.skipWrong} (${pct(cal.skipWrong / cal.skipCalls)}) were on coins that went on to win anyway`);
			lines.push(`YOUR OWN CALIBRATION: ${parts.join('; ')}. Correct for your own bias.`);
		}
	}

	if (!lines.length) return { tier, depth, block: '' };
	return {
		tier,
		depth,
		block: `\n\nEARNED CONTEXT (this arm's track record has unlocked the evidence below; use it):\n${lines.map((l) => `- ${l}`).join('\n')}`,
	};
}

/** Test seam: drop every cache. */
export function _resetKnowledgeCache() {
	_fleet = null;
	_fleetAt = 0;
	_arms.clear();
	_calibration.clear();
}
