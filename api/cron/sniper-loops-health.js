// GET/POST /api/cron/sniper-loops-health: the row-count watchdog over the
// fleet's autonomous learning loops.
//
// Born from the July 2026 audit's ugliest finding: the optimizer and evolution
// loops ran dead for two days behind green health checks, because every check
// looked at status codes and none looked at side effects. This cron asks each
// loop the one question that cannot lie — "when did you last write a row?" —
// and pages the ops channel (with per-signature dedup) when any answer is too
// old. The loop declarations and staleness policy are pure and unit-tested in
// api/_lib/sniper-loops-health.js.
//
// A degraded probe (table missing, query error) is reported as its own alert
// rather than swallowed: an unqueryable ledger is exactly the kind of silence
// this watchdog exists to catch.

import { json, method, wrapCron } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { LOOPS, classifyLlmRouting, classifyLoopHealth, describeStale, findWalletlessArms, isFallbackAnswer } from '../_lib/sniper-loops-health.js';
import { requireCron } from '../_lib/cron-auth.js';

const NETWORK = 'mainnet';

// One freshest-row probe per loop. Table/column names come from the static
// LOOPS declaration (never user input), so the interpolation here is safe; the
// only runtime value, the network, is parameterized.
async function probeLoop(loop) {
	try {
		const where = loop.networkColumn ? `where ${loop.networkColumn} = $1` : '';
		const params = loop.networkColumn ? [NETWORK] : [];
		const rows = await sql(
			`select max(${loop.column}) as last_at from ${loop.table} ${where}`,
			params,
		);
		return { name: loop.name, lastAt: rows?.[0]?.last_at ?? null };
	} catch (err) {
		return { name: loop.name, lastAt: null, probeError: err?.message || 'query failed' };
	}
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const probes = await Promise.all(LOOPS.map(probeLoop));
	const broken = probes.filter((p) => p.probeError);
	const { ok, stale } = classifyLoopHealth(probes.filter((p) => !p.probeError), Date.now());

	// Fleet integrity: enabled arms whose agent has no wallet. These pass every
	// status check and can never trade (every buy dies at no_wallet). Discovered
	// the hard way: oracle-strict sat armed on the conviction-50 crossing for two
	// days as exactly this kind of zombie.
	let zombies = [];
	try {
		const rows = await sql`
			select s.id as strategy_id, s.label, s.enabled, s.daily_budget_lamports,
			       a.meta->>'solana_address' as wallet
			from agent_sniper_strategies s
			join agent_identities a on a.id = s.agent_id and a.deleted_at is null
			where s.network = ${NETWORK} and s.enabled = true
		`;
		zombies = findWalletlessArms(rows);
	} catch (err) {
		broken.push({ name: 'fleet-integrity', probeError: err?.message || 'query failed' });
	}
	if (zombies.length) {
		await Promise.resolve(sendOpsAlert(
			`🎯 agent-sniper — ${zombies.length} armed strateg${zombies.length === 1 ? 'y' : 'ies'} have NO WALLET`,
			zombies.map((z) => `${z.label}: enabled with ${z.budgetSol.toFixed(3)} SOL/day budget and no Solana wallet — every buy dies at no_wallet. Heal with: node scripts/seed-sniper-experiments.mjs --apply --only ${z.label}`).join('\n'),
			{ signature: 'sniper:armed-walletless' },
		)).catch(() => {});
	}

	// Named-model routing: are the arms' named models actually answering, or is
	// the free fallback chain absorbing everything (as it silently did for weeks
	// on a zero-credit OpenRouter account)? The ledger keys rows by the REQUESTED
	// model, so fallback detection is answered_by vs model mismatch, classified
	// in JS by the tested isFallbackAnswer (a prefix-only SQL filter read 0%
	// during a real outage).
	let routing = { degraded: false, share: null, detail: 'not probed' };
	try {
		const rows = await sql`
			select model, answered_by, count(*)::int as n
			from sniper_llm_verdicts
			where network = ${NETWORK} and created_at > now() - interval '1 hour'
			group by model, answered_by
		`;
		let total = 0;
		let fallback = 0;
		for (const r of rows) {
			total += r.n;
			if (isFallbackAnswer(r.model, r.answered_by)) fallback += r.n;
		}
		routing = classifyLlmRouting({ total, fallback });
	} catch (err) {
		broken.push({ name: 'llm-routing', probeError: err?.message || 'query failed' });
	}
	if (routing.degraded) {
		await Promise.resolve(sendOpsAlert(
			'🎯 agent-sniper — named LLM judges are NOT answering (fallback chain absorbing calls)',
			routing.detail,
			{ signature: 'sniper:llm-routing-degraded' },
		)).catch(() => {});
	}

	if (stale.length) {
		// One alert per run covering every stale loop, deduped hourly on a stable
		// signature so a dead loop pages once an hour until it produces rows again.
		const body = stale.map(describeStale).join('\n');
		await Promise.resolve(sendOpsAlert(
			`🎯 agent-sniper — ${stale.length} learning loop(s) STALE (rows, not status codes)`,
			body,
			{ signature: 'sniper:loops-stale' },
		)).catch(() => {});
	}
	if (broken.length) {
		await Promise.resolve(sendOpsAlert(
			'🎯 agent-sniper — loops-health probe failed',
			broken.map((b) => `${b.name}: ${b.probeError}`).join('\n'),
			{ signature: 'sniper:loops-probe-failed' },
		)).catch(() => {});
	}

	return json(res, 200, {
		ok: stale.length === 0 && broken.length === 0 && zombies.length === 0 && !routing.degraded,
		checked: probes.length,
		stale: stale.map((s) => ({ name: s.name, last_at: s.lastAt, age_h: s.ageMs === Infinity ? null : Math.round(s.ageMs / 3600_000 * 10) / 10 })),
		healthy: ok.map((s) => s.name),
		walletless_arms: zombies.map((z) => z.label),
		llm_routing: routing,
		probe_errors: broken.map((b) => ({ name: b.name, error: b.probeError })),
	});
});
