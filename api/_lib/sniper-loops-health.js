// "Count rows, not status codes."
//
// The July 2026 fleet audit's hardest operational lesson: two of the fleet's
// autonomous learning loops ran DEAD for two days while every health check they
// had returned green. The crons fired, the handlers returned 200, and no rows
// were written. Autonomy without audited side effects is theater.
//
// This module is the pure half of the fix. Each loop the fleet depends on is
// declared here with the QUESTION THAT CANNOT LIE: the freshest row it should
// have produced, and the maximum age that row may reach before the loop is
// declared stale. The cron (api/cron/sniper-loops-health.js) runs the queries
// and alerts on what this classifier returns; nothing in the alert path trusts
// a status code.
//
// Max ages are cadence * ~4 + slack: late enough to never page on one slow or
// skipped run, early enough that "dead for two days" can never happen again.

/**
 * Every autonomous loop the fleet's learning depends on. `table`/`column` name
 * the freshest-row probe (the cron builds `select max(column) from table`
 * with an optional network filter); `maxAgeMs` is the staleness verdict line.
 *
 * A loop only belongs here when its writer is UNCONDITIONAL, i.e. a healthy run
 * always advances the probed column. That is why oracle-realized-labels
 * (oracle_realized_outcomes) is deliberately absent: it derives one row per mint
 * the fleet actually closed a REAL position on, so a paper-only or simply idle
 * fleet leaves the table empty and a probe here would page forever about a loop
 * that is working correctly. Its liveness is already implied by the loops that
 * feed it (llm-judging, oracle-scoring) plus oracle-calibration below, which
 * upserts all five conviction bands on every pass regardless of sample count.
 */
export const LOOPS = [
	{
		name: 'intel-weight-training',
		table: 'pump_intel_weights',
		column: 'trained_at',
		networkColumn: 'network',
		maxAgeMs: 2 * 3600_000, // cron every 15 min
		why: 'The scorer trades on these weights; stale weights mean every intel entry is judged by an old market.',
	},
	{
		name: 'outcome-labeling',
		table: 'pump_coin_outcomes',
		column: 'labeled_at',
		networkColumn: null, // mainnet-only table
		maxAgeMs: 2 * 3600_000, // labeling runs with intel-learn every 15 min
		why: 'Ground truth. Every learning loop downstream (weights, Oracle, evolution fitness) starves without new labels.',
	},
	{
		name: 'llm-judging',
		table: 'sniper_llm_verdicts',
		column: 'created_at',
		networkColumn: 'network',
		maxAgeMs: 2 * 3600_000, // continuous while the firehose runs
		why: 'The LLM arms are the experiment. No new verdicts while the feed is live means the judge chain is down.',
	},
	{
		name: 'optimizer',
		table: 'agent_sniper_optimizer_runs',
		column: 'created_at',
		networkColumn: 'network',
		maxAgeMs: 26 * 3600_000, // cron every 6h; a full quiet day is legitimate when no arm has proposals
		why: 'The intra-arm tuning loop. This is one of the two loops that silently died in the audit window.',
	},
	{
		name: 'evolution',
		table: 'sniper_evolution_log',
		column: 'created_at',
		networkColumn: 'network',
		maxAgeMs: 26 * 3600_000, // cron every 12h
		why: 'The budget-reallocation loop. The other silent death: proposals logged nothing for two days.',
	},
	{
		name: 'oracle-scoring',
		table: 'oracle_conviction',
		column: 'scored_at',
		networkColumn: 'network',
		maxAgeMs: 30 * 60_000, // cron every 2 min
		why: 'The conviction score gates entries and the oracle_crossing trigger polls it; a stale table blinds both.',
	},
	{
		name: 'oracle-calibration',
		table: 'oracle_calibration',
		column: 'updated_at',
		networkColumn: 'network',
		maxAgeMs: 13 * 3600_000, // cron every 6h, so this is two consecutive misses
		why: 'Bridge 3: is an 80-conviction coin actually winning 80% of the time? A stale table means the optimizer\'s Rule O is tuning entry thresholds against a correction factor nobody is re-measuring.',
	},
];

/**
 * Classify each loop's freshest-row age. Pure.
 *
 * @param {Array<{name:string, lastAt:string|Date|null}>} probes one per LOOPS entry
 * @param {number} now epoch ms
 * @returns {{ ok: Array, stale: Array }} stale entries carry ageMs + the loop's why
 */
export function classifyLoopHealth(probes, now) {
	const byName = new Map(LOOPS.map((l) => [l.name, l]));
	const ok = [];
	const stale = [];
	for (const probe of probes || []) {
		const loop = byName.get(probe.name);
		if (!loop) continue;
		const t = probe.lastAt ? new Date(probe.lastAt).getTime() : null;
		// A loop with NO rows at all is the worst case of stale, not a pass: it has
		// never produced a side effect. Report age as Infinity so it sorts first.
		const ageMs = t == null || !Number.isFinite(t) ? Infinity : now - t;
		const entry = { name: loop.name, ageMs, maxAgeMs: loop.maxAgeMs, why: loop.why, lastAt: probe.lastAt ?? null };
		(ageMs > loop.maxAgeMs ? stale : ok).push(entry);
	}
	stale.sort((a, b) => b.ageMs - a.ageMs);
	return { ok, stale };
}

/**
 * Fleet integrity: an ENABLED strategy whose agent holds no Solana wallet is a
 * zombie arm. It passes every status check, receives budget from the evolution
 * loop, generates candidates, and then every single buy dies at no_wallet. This
 * is how oracle-strict sat armed on the conviction-50 crossing (the strongest
 * signal in the July 2026 dataset) for two days without a trade. Pure.
 *
 * @param {Array<{label:string|null, strategy_id:string, wallet:string|null, enabled:boolean, daily_budget_lamports?:string|number|null}>} rows
 * @returns {Array<{label:string, strategy_id:string, budgetSol:number}>} zombie arms
 */
export function findWalletlessArms(rows) {
	const out = [];
	for (const r of rows || []) {
		if (r.enabled !== true) continue;
		if (r.wallet != null && String(r.wallet).trim() !== '') continue;
		out.push({
			label: r.label || r.strategy_id,
			strategy_id: r.strategy_id,
			budgetSol: Number(r.daily_budget_lamports || 0) / 1e9,
		});
	}
	return out;
}

/**
 * Is one verdict row a fallback answer? The ledger stores the REQUESTED model
 * in `model` (the experiment arm's identity, also the on-conflict key), so a
 * `fallback:` prefix never reaches that column. What the worker's judge writes
 * on the two paths (workers/agent-sniper/llm-judge.js):
 *   OpenRouter answered  -> answered_by === model (same string, same variable)
 *   free-chain fallback  -> answered_by = the raw free model name ("llama-3.1-8b-instant")
 * So the truth test is a MISMATCH between answered_by and model, not a prefix.
 * The first probe shipped prefix-only and read 0/225 fallbacks during a full
 * OpenRouter outage: a false negative from exactly the silence class this
 * watchdog exists to catch. Pure.
 *
 * @param {string|null|undefined} model      requested model recorded on the row
 * @param {string|null|undefined} answeredBy who actually replied (null on pre-column rows)
 * @returns {boolean}
 */
export function isFallbackAnswer(model, answeredBy) {
	const req = String(model || '').trim().toLowerCase();
	const ans = String(answeredBy || '').trim().toLowerCase();
	if (req.startsWith('fallback:') || ans.startsWith('fallback:')) return true;
	// No answered_by (legacy row) = unknown; never count unknowns as fallbacks,
	// a false page teaches operators to ignore the real one.
	if (!ans) return false;
	return ans !== req;
}

/**
 * Named-model routing health. The July 2026 audit note "the failover chain
 * answering most calls muddied the model-vs-model comparison" turned out to be
 * an OpenRouter account sitting at zero credits for weeks: the key stayed
 * valid, every completion 402'd, the free chain silently absorbed the traffic,
 * and no check anywhere measured it. This one does: given the last hour's
 * verdict counts (fallbacks classified per isFallbackAnswer), alarm when
 * fallbacks answered nearly everything. Pure.
 *
 * @param {{ total:number, fallback:number }} counts verdicts in the window
 * @param {{ minSample?:number, maxShare?:number }} [opts]
 * @returns {{ degraded:boolean, share:number|null, detail:string }}
 */
export function classifyLlmRouting(counts, { minSample = 20, maxShare = 0.9 } = {}) {
	const total = Number(counts?.total) || 0;
	const fallback = Number(counts?.fallback) || 0;
	if (total < minSample) return { degraded: false, share: null, detail: `only ${total} verdicts in window (need ${minSample})` };
	const share = fallback / total;
	const degraded = share >= maxShare;
	return {
		degraded,
		share: Number(share.toFixed(3)),
		detail: `${fallback}/${total} verdicts answered by fallback models (${Math.round(share * 100)}%). ` +
			(degraded
				? 'The named models are not answering: check OpenRouter credits/keys. Strict arms are paused until this clears; verdicts still record for calibration.'
				: 'Named-model routing is healthy.'),
	};
}

/** Human line for one stale loop, used in the ops alert body. */
export function describeStale(entry) {
	const age = entry.ageMs === Infinity
		? 'has NEVER produced a row'
		: `last row ${Math.round(entry.ageMs / 3600_000 * 10) / 10}h ago (limit ${Math.round(entry.maxAgeMs / 3600_000 * 10) / 10}h)`;
	return `${entry.name}: ${age}. ${entry.why}`;
}
