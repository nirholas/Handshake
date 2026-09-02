// Sniper evolution engine: the fleet improves itself from its own results.
//
//   node scripts/sniper-evolve.mjs            # dry-run: print the proposals, write nothing
//   node scripts/sniper-evolve.mjs --apply    # apply the mutations to the DB
//
// Autonomous cadence: api/cron/sniper-evolve.js calls runEvolve() on a schedule
// (dry-run unless SNIPER_EVOLVE_APPLY=1), so the portfolio layer evolves without
// a human running the script. The exported runEvolve() is the single source of
// truth for both the CLI and the cron.
//
// This is the PORTFOLIO layer of the fleet's self-improvement loop. It is the
// complement to the intra-arm optimizer (api/_lib/sniper-optimizer.js +
// api/cron/sniper-optimize.js), which tunes each arm's OWN knobs (stops,
// take-profit, hold, sizing) inward. Evolve works ACROSS arms: it decides which
// arms deserve capital and which should stop trading, against the ground-truth
// base rate. Division of labor is deliberate: evolve never touches a per-arm
// entry/exit knob, the optimizer never moves budget between arms.
//
// Reads each labeled arm's REAL + paper trading evidence and the base rate
// (pump_coin_outcomes: what fraction of launches actually win), scores every arm,
// and mutates the fleet's ALLOCATION. Three moves, all bounded and reversible:
//
//   retire      an arm with enough samples whose win rate is provably below the
//               base rate (Wilson 95% upper bound < base rate): stop paying to be wrong.
//   revive      a retired arm once enough time has passed to re-test it (exploration).
//   reallocate  shift the fixed fleet daily budget toward higher-fitness arms,
//               with a floor so no arm starves and the experiment keeps exploring.
//               Fitness is scaled by the arm's earned-autonomy tier
//               (api/_lib/sniper-autonomy.js), so an arm with a proven profit
//               concentrates more of the fleet budget and one that bleeds
//               concentrates less. The fleet total and the per-arm floor are
//               unchanged: this only decides how the same pot is divided.
//
// SAFETY BY CONSTRUCTION. The engine writes ONLY the fields in WRITABLE below.
// It can never touch stop_loss_pct, firewall_level, max_price_impact, the daily
// loss cap, or push a size past the fleet ceiling: those are code-enforced in
// executeBuy and out of reach. The worst an evolved param can do is a bad,
// stop-loss-protected, firewall-vetted, budget-bounded trade. Every proposal is
// journaled to sniper_evolution_log (before/after + the evidence) so the whole
// autonomous history is auditable and one UPDATE can roll any change back.

import './lib/gcloud-path.mjs';
import { createRequire } from 'node:module';
import { budgetWeightFor, classifyAutonomy } from '../api/_lib/sniper-autonomy.js';
import { resolveDatabaseUrl as resolveConfiguredDatabaseUrl } from '../api/_lib/env.js';
import { requireServiceEnvValue } from './lib/service-env.mjs';
const require = createRequire(import.meta.url);
const { Pool } = require('@neondatabase/serverless');

const NETWORK = 'mainnet';
const LAMPORTS = 1e9;

// ── tunables (env-overridable; the optimizer's own guardrails) ────────────────
const num = (k, d) => (process.env[k] ? Number(process.env[k]) : d);
const FLEET_DAILY_SOL = num('EVOLVE_FLEET_DAILY_SOL', 0.5);       // total budget shared across active arms
const PER_ARM_FLOOR_SOL = num('EVOLVE_ARM_FLOOR_SOL', 0.02);      // no active arm starves below this (keeps exploring)
const MIN_SAMPLES_RETIRE = num('EVOLVE_MIN_SAMPLES', 15);         // don't retire on noise
const REVIVE_AFTER_HOURS = num('EVOLVE_REVIVE_HOURS', 24);        // re-test a retired arm after this long

// The ONLY columns evolve may write: the portfolio surface. Per-arm entry/exit
// knobs are intentionally absent: those belong to the intra-arm optimizer. A
// safety field appearing here would be a bug; the list is short and reviewed.
const WRITABLE = new Set(['enabled', 'daily_budget_lamports']);

// Ask the platform's own resolver first. It reads every DATABASE_URL alias and
// the .env file, which is how the connection string is configured everywhere
// except a bare shell, so the cron (api/cron/sniper-evolve.js) resolves without
// ever reaching for a CLI. That mattered: a raw `process.env.DATABASE_URL` read
// missed the alias set, and the gcloud fallback below then ran inside the
// request, where it either fails on expired local credentials or, in the Cloud
// Run container that has no gcloud binary, turns the whole cron into an error
// response. The shellout survives only as the last resort for an operator
// running the CLI on a machine with no env configured at all.
function resolveDatabaseUrl() {
	const configured = resolveConfiguredDatabaseUrl();
	if (configured) return configured;
	// Production's copy is a Secret Manager reference, not a literal on the
	// service, so this has to resolve the reference rather than read `.value`.
	return requireServiceEnvValue('DATABASE_URL');
}

// Wilson score interval for a binomial proportion. Gives a conservative lower
// AND upper bound on the true win rate from a small sample, so we act on evidence
// not noise: retire only when even the OPTIMISTIC bound is below the base rate.
function wilson(wins, n, z = 1.96) {
	if (n === 0) return { lo: 0, hi: 1, p: 0 };
	const p = wins / n;
	const d = 1 + (z * z) / n;
	const c = p + (z * z) / (2 * n);
	const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
	return { lo: Math.max(0, (c - s) / d), hi: Math.min(1, (c + s) / d), p };
}

function castParam(field, v) {
	if (field === 'enabled') return v === 'true';
	if (['llm_min_confidence', 'min_oracle_score', 'min_market_cap_usd', 'max_market_cap_usd'].includes(field)) {
		return v === 'null' ? null : Number(v);
	}
	return v;
}

/**
 * One evolution pass over the fleet. Pure of side effects unless `apply` is true,
 * in which case it enacts the portfolio mutations (only WRITABLE fields) and logs
 * every proposal to sniper_evolution_log. Returns a summary for the caller (CLI
 * or cron). `log` defaults to console.log; the cron passes a no-op to stay quiet.
 *
 * @param {{ apply?: boolean, log?: (msg:string)=>void }} [opts]
 * @returns {Promise<{ runId:string, baseRate:number, activeArms:number, proposals:Array, applied:boolean }>}
 */
export async function runEvolve({ apply = false, log = console.log } = {}) {
	const runId = `evolve-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
	const pool = new Pool({ connectionString: resolveDatabaseUrl() });
	try {
		// Ground truth: the base rate every arm has to beat to be worth funding.
		const [{ base_rate }] = (await pool.query(`
			select coalesce(
				count(*) filter (where outcome in ('pumped','graduated'))::float / nullif(count(*),0),
				0.12) as base_rate
			from pump_coin_outcomes`)).rows;
		const baseRate = Number(base_rate);

		// Every labeled arm + its real and paper evidence. Paper fills still teach
		// which coins WOULD have won, so they count (discounted) when real fills are thin.
		const arms = (await pool.query(`
			select s.id, s.label, s.experiment_group, s.decision_mode, s.enabled, s.llm_model,
			       s.llm_min_confidence, s.min_oracle_score, s.min_market_cap_usd, s.max_market_cap_usd,
			       s.daily_budget_lamports, s.updated_at,
			       count(p.id) filter (where p.status='closed' and p.buy_sig<>'SIMULATED') real_n,
			       count(p.id) filter (where p.status='closed' and p.buy_sig<>'SIMULATED' and p.realized_pnl_lamports>0) real_w,
			       coalesce(avg(p.realized_pnl_pct) filter (where p.status='closed' and p.buy_sig<>'SIMULATED'),0) real_avg_pct,
			       coalesce(sum(p.realized_pnl_lamports) filter (where p.status='closed' and p.buy_sig<>'SIMULATED'),0) real_net_lamports,
			       count(p.id) filter (where p.status='closed' and p.buy_sig='SIMULATED') paper_n,
			       count(p.id) filter (where p.status='closed' and p.buy_sig='SIMULATED' and p.realized_pnl_lamports>0) paper_w
			from agent_sniper_strategies s
			left join agent_sniper_positions p on p.strategy_id=s.id and p.network=s.network
			where s.network=$1 and s.label is not null
			group by s.id
			order by s.label`, [NETWORK])).rows;

		// Fitness: conservative win-edge over the base rate (Wilson lower bound) plus
		// a realized-ROI term, real fills at full weight and paper at 1/3. An arm with
		// no evidence yet gets a neutral exploration fitness so it keeps a budget floor.
		//
		// The earned-autonomy tier then scales the result. Win rate alone underrates
		// an arm that hits rarely but pays well when it does, which is the normal
		// shape of a profitable momentum arm; the tier is computed from realized net
		// P&L and average edge, so an arm that actually makes money concentrates more
		// of the fixed fleet budget and one that bleeds concentrates less. The fleet
		// total never changes and the per-arm floor still keeps exploration alive.
		const fitness = (a) => {
			const realN = +a.real_n, realW = +a.real_w;
			const paperN = +a.paper_n, paperW = +a.paper_w;
			const n = realN + paperN / 3;
			const w = realW + paperW / 3;
			const autonomy = classifyAutonomy({
				closed: realN,
				wins: realW,
				netPnlLamports: Number(a.real_net_lamports) || 0,
				avgPnlPct: Number(a.real_avg_pct) || 0,
			});
			const weight = budgetWeightFor(autonomy.tier);
			if (n < 1) return { score: baseRate, samples: 0, edge: 0, wl: wilson(0, 0), tier: autonomy.tier, weight };
			const wl = wilson(w, Math.max(1, Math.round(n)));
			const edge = wl.lo - baseRate;                    // provable edge over ground truth
			const roi = Math.max(-1, Math.min(2, Number(a.real_avg_pct) / 100));
			const score = Math.max(0, (baseRate + edge * 2 + roi * 0.05) * weight);
			return { score, samples: Math.round(n), edge, wl, roi, tier: autonomy.tier, weight };
		};

		const proposals = [];
		const propose = (a, action, field, before, after, fit, evidence) => {
			proposals.push({ id: a.id, label: a.label, action, field, before, after, fitness: fit.score, evidence });
		};

		// 1. RETIRE arms proven worse than a coin flip, and REVIVE stale retirees to re-test.
		for (const a of arms) {
			const fit = fitness(a);
			if (a.enabled && fit.samples >= MIN_SAMPLES_RETIRE && fit.wl.hi < baseRate) {
				propose(a, 'retire', 'enabled', 'true', 'false', fit,
					{ samples: fit.samples, win_hi: +fit.wl.hi.toFixed(3), base_rate: +baseRate.toFixed(3), reason: 'upper bound below base rate' });
			} else if (!a.enabled) {
				const ageH = (Date.now() - new Date(a.updated_at).getTime()) / 3.6e6;
				if (ageH >= REVIVE_AFTER_HOURS) {
					propose(a, 'revive', 'enabled', 'false', 'true', fit,
						{ retired_hours: Math.round(ageH), reason: 're-test after cooldown' });
				}
			}
		}

		// 2. REALLOCATE the fixed fleet budget across active arms, fitness-weighted with
		//    a floor. The core "put money where it works" move, bounded so the total can
		//    never grow and exploration never dies.
		const active = arms.filter((a) => a.enabled && !proposals.find((p) => p.id === a.id && p.action === 'retire'));
		if (active.length) {
			const fits = active.map((a) => ({ a, f: fitness(a) }));
			const floor = PER_ARM_FLOOR_SOL;
			const floorTotal = floor * active.length;
			const discretionary = Math.max(0, FLEET_DAILY_SOL - floorTotal);
			const sumScore = fits.reduce((s, x) => s + x.f.score, 0) || 1;
			for (const { a, f } of fits) {
				const share = floor + discretionary * (f.score / sumScore);
				const nextLamports = String(Math.round(share * LAMPORTS));
				const cur = String(a.daily_budget_lamports);
				if (nextLamports !== cur) propose(a, 'reallocate', 'daily_budget_lamports', cur, nextLamports, f,
					{ share_sol: +share.toFixed(4), fleet_sol: FLEET_DAILY_SOL, fitness: +f.score.toFixed(4), tier: f.tier, tier_weight: f.weight });
			}
		}

		// ── report + (optional) apply ────────────────────────────────────────────
		log(`\nEvolution run ${runId}: base rate ${(baseRate * 100).toFixed(1)}% (fraction of launches that win)`);
		log(`Fleet daily budget ${FLEET_DAILY_SOL} SOL across ${active.length} active arms. ${apply ? 'APPLYING' : 'DRY-RUN (no writes)'}.\n`);
		for (const a of arms) {
			const f = fitness(a);
			log(`  ${(a.label || '?').padEnd(17)} ${a.enabled ? 'ON ' : 'off'} ${f.tier.padEnd(10)} (x${f.weight}) fitness ${f.score.toFixed(4)} · ${f.samples} samples · edge ${(f.edge * 100).toFixed(1)}pt`);
		}
		log(`\n${proposals.length} proposed mutation(s):`);
		for (const p of proposals) {
			const fmt = (v) => p.field?.includes('lamports') ? (Number(v) / LAMPORTS).toFixed(3) + ' SOL' : v;
			log(`  [${p.action}] ${p.label}: ${p.field} ${fmt(p.before)} -> ${fmt(p.after)}  ${JSON.stringify(p.evidence)}`);
		}

		// The WRITABLE guard is the safety contract, not a formality: a field outside
		// the set is refused loudly before any write.
		for (const p of proposals) {
			if (p.field && !WRITABLE.has(p.field)) {
				throw new Error(`REFUSED: ${p.action} tried to write non-writable field '${p.field}'`);
			}
		}
		if (apply) {
			for (const p of proposals) {
				await pool.query(
					`update agent_sniper_strategies set ${p.field} = $1, updated_at = now() where id = $2 and network = $3`,
					[p.action === 'reallocate' || p.field?.includes('lamports') ? p.after : castParam(p.field, p.after), p.id, NETWORK],
				);
			}
		}
		for (const p of proposals) {
			await pool.query(
				`insert into sniper_evolution_log (run_id, network, strategy_id, label, action, field, before_val, after_val, fitness, evidence, applied)
				 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
				[runId, NETWORK, p.id, p.label, p.action, p.field, String(p.before), String(p.after), p.fitness, JSON.stringify(p.evidence), apply],
			);
		}

		log(`\n${apply ? 'Applied and logged' : 'Logged (dry-run)'} ${proposals.length} mutation(s) as ${runId}.`);
		if (!apply) log('Re-run with --apply to let the fleet evolve.');
		return { runId, baseRate, activeArms: active.length, proposals, applied: apply };
	} finally {
		await pool.end();
	}
}

// CLI entrypoint: run directly with `node scripts/sniper-evolve.mjs [--apply]`.
if (process.argv[1] && process.argv[1].endsWith('sniper-evolve.mjs')) {
	runEvolve({ apply: process.argv.includes('--apply') }).catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
