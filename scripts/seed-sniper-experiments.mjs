// Seed the sniper experiment fleet: label every armed strategy and shape the
// A/B arms so different entry-condition philosophies trade side by side.
//
//   node scripts/seed-sniper-experiments.mjs           # dry-run (prints the plan)
//   node scripts/seed-sniper-experiments.mjs --apply   # write to the database
//
// DATABASE_URL is read from the environment; when unset, the script reads it
// from the production Cloud Run service (same source of truth the worker uses).
// Requires the 20260719120000_sniper_llm_experiments.sql migration.
//
// The arms (one strategy per agent, unique on (agent_id, network)):
//   rules group: shield-based entries at different strictness levels
//   oracle group: conviction-gated entries (bite after score maturity)
//   llm group: no rule shields; a model judges each launch (grok / claude /
//                  openrouter auto-router), safety rails still enforced

import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Pool } = require('@neondatabase/serverless');

const APPLY = process.argv.includes('--apply');
const NETWORK = 'mainnet';

// agent_id (unique per arm) → the experiment definition. `set` contains only
// the columns that arm changes; omitted columns keep their current values.
const ARMS = [
	{
		agent: '4c0e4d18-0544-4c95-a0db-a16896b029be',
		label: 'rules-proven',
		group: 'rules',
		note: 'the arm that landed the first profitable snipe; unchanged',
		set: {},
	},
	{
		agent: 'adba030a-2536-4476-a34d-7ce096d2e033',
		label: 'intel-quality',
		group: 'rules',
		note: 'intel_confirmed with quality/bundle gates; unchanged',
		set: {},
	},
	{
		agent: '0846c27e-6258-4859-bc1c-3148d59951c5',
		label: 'oracle-open',
		group: 'oracle',
		note: 'oracle >= 35 once the score matures; no other shields',
		set: {},
	},
	{
		agent: '6287faf3-d41b-43cb-97bb-d305c1ac6e45',
		label: 'oracle-strict',
		group: 'oracle',
		note: 'oracle >= 65 once the score matures; no other shields',
		set: {},
	},
	{
		agent: '15e98de5-2695-427b-b746-4558a0933a4e',
		label: 'rules-classic',
		group: 'rules',
		note: 'control: $10k-$100k band + socials + oracle 55, untouched',
		set: {},
	},
	{
		agent: '2b8a5101-6572-4dd5-8f11-d9fdb5e31490',
		label: 'rules-no-socials',
		group: 'rules',
		note: 'the proven band without the socials requirement',
		set: {
			require_socials: false, min_market_cap_usd: 5000, max_market_cap_usd: 25000,
			min_oracle_score: null, per_trade_lamports: '10000000', daily_budget_lamports: '50000000',
			max_concurrent_positions: 1,
		},
	},
	{
		agent: '781b75a3-86f9-44ee-b29b-6f71d1acad79',
		label: 'rules-wide-band',
		group: 'rules',
		note: 'socials + a wider $5k-$50k band, no oracle gate',
		set: {
			require_socials: true, min_market_cap_usd: 5000, max_market_cap_usd: 50000,
			min_oracle_score: null, per_trade_lamports: '10000000', daily_budget_lamports: '50000000',
			max_concurrent_positions: 1,
		},
	},
	{
		agent: 'bcb8c86f-92d2-496d-bb2c-b9442f97a4fa',
		label: 'llm-grok',
		group: 'llm',
		note: 'no shields; Grok judges every launch',
		set: {
			decision_mode: 'llm', llm_model: 'x-ai/grok-4.3', llm_min_confidence: 0.65,
			require_socials: false, min_market_cap_usd: null, max_market_cap_usd: null,
			min_oracle_score: null, per_trade_lamports: '10000000', daily_budget_lamports: '50000000',
			max_concurrent_positions: 1,
		},
	},
	{
		agent: 'c7b23f0f-a7fc-412d-81c8-2b2b06119af2',
		label: 'llm-claude',
		group: 'llm',
		note: 'no shields; Claude Haiku judges every launch',
		set: {
			decision_mode: 'llm', llm_model: 'anthropic/claude-haiku-4.5', llm_min_confidence: 0.65,
			require_socials: false, min_market_cap_usd: null, max_market_cap_usd: null,
			min_oracle_score: null, per_trade_lamports: '10000000', daily_budget_lamports: '50000000',
			max_concurrent_positions: 1,
		},
	},
	{
		agent: 'd10aae1b-c56f-4780-88cb-e9b7405ef29e',
		label: 'llm-auto',
		group: 'llm',
		note: 'no shields; the OpenRouter auto-router picks the judge',
		set: {
			decision_mode: 'llm', llm_model: 'openrouter/auto', llm_min_confidence: 0.65,
			require_socials: false, min_market_cap_usd: null, max_market_cap_usd: null,
			min_oracle_score: null, per_trade_lamports: '10000000', daily_budget_lamports: '50000000',
			max_concurrent_positions: 1,
		},
	},
];

function resolveDatabaseUrl() {
	if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
	const svc = JSON.parse(execSync(
		'gcloud run services describe three-ws-api --region us-central1 --project aerial-vehicle-466722-p5 --format=json',
		{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
	));
	const env = svc.spec.template.spec.containers[0].env || [];
	const url = env.find((e) => e.name === 'DATABASE_URL')?.value;
	if (!url) throw new Error('DATABASE_URL not found in env or on the Cloud Run service');
	return url;
}

const pool = new Pool({ connectionString: resolveDatabaseUrl() });

const { rows: existing } = await pool.query(
	'select agent_id, label, decision_mode, llm_model, per_trade_lamports, daily_budget_lamports, enabled from agent_sniper_strategies where network = $1',
	[NETWORK],
);
const byAgent = new Map(existing.map((r) => [r.agent_id, r]));

let updated = 0;
for (const arm of ARMS) {
	const cur = byAgent.get(arm.agent);
	if (!cur) {
		console.log(`SKIP  ${arm.label}: no ${NETWORK} strategy exists for agent ${arm.agent} (arms only reshape existing strategies)`);
		continue;
	}
	const set = {
		label: arm.label,
		experiment_group: arm.group,
		// Every experiment arm consents to auto top-ups from the launcher master so
		// an unfunded wallet can't silently sit out the experiment. The worker's
		// SNIPER_AUTO_FUND_* caps bound every transfer.
		auto_fund_enabled: true,
		...arm.set,
	};
	const cols = Object.keys(set);
	console.log(`${APPLY ? 'APPLY' : 'PLAN '} ${arm.label.padEnd(16)} agent ${arm.agent.slice(0, 8)}: ${arm.note}`);
	for (const c of cols) console.log(`        ${c} = ${JSON.stringify(set[c])}`);
	if (!APPLY) continue;
	const assignments = cols.map((c, i) => `${c} = $${i + 3}`).join(', ');
	await pool.query(
		`update agent_sniper_strategies set ${assignments}, updated_at = now() where agent_id = $1 and network = $2`,
		[arm.agent, NETWORK, ...cols.map((c) => set[c])],
	);
	updated++;
}

if (APPLY) console.log(`\nDone: ${updated} strategies updated.`);
else console.log('\nDry-run only. Re-run with --apply to write.');
await pool.end();
