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
//   boost group: event-driven — buy the pump AMM at migration and sell into
//                  pump.fun's 5-minute BOOST buyback window (live 2026-07-21)
//
// The boost-ride arm is PROVISIONED here too (agent identity + custodial wallet
// + strategy row) because unlike the first ten arms it has no pre-existing
// strategy to reshape. Provisioning is idempotent (keyed by agent name + owner).
// NOTE the wallet secret is encrypted with the process env's WALLET_ENCRYPTION_KEY
// (JWT_SECRET fallback) — run this with the SAME key material the agent-sniper
// service decrypts with, or the worker will load a wallet it cannot open.

import './lib/gcloud-path.mjs';
import { createRequire } from 'node:module';
import { requireServiceEnvValue } from './lib/service-env.mjs';

const require = createRequire(import.meta.url);
const { Pool } = require('@neondatabase/serverless');

const APPLY = process.argv.includes('--apply');
// --only <label>: touch a single arm (and skip the rest entirely). Use this for
// late-added arms so a re-run can never clobber params the live optimizer has
// evolved on the original fleet since the first seeding.
const _onlyIdx = process.argv.indexOf('--only');
const ONLY = _onlyIdx >= 0 ? process.argv[_onlyIdx + 1] : null;
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
			// Audit findings (blog/autonomous-trading-experiment): 0.9+ confidence
			// verdicts went winless -> ceiling; fallback models answered most named
			// calls -> strict, this arm trades only on Grok's own judgment.
			llm_max_confidence: 0.9, llm_strict_model: true,
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
			// Same audit rationale as llm-grok: confidence ceiling + named-model
			// strictness. This arm was the one most answered by fallbacks.
			llm_max_confidence: 0.9, llm_strict_model: true,
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
			// Ceiling applies (overconfidence is model-agnostic); strictness does
			// NOT: this arm is any-model by design, a fallback IS its router pick.
			llm_max_confidence: 0.9, llm_strict_model: false,
			require_socials: false, min_market_cap_usd: null, max_market_cap_usd: null,
			min_oracle_score: null, per_trade_lamports: '10000000', daily_budget_lamports: '50000000',
			max_concurrent_positions: 1,
		},
	},
];

// ── boost-ride: the 11th arm (provisioned, not reshaped) ─────────────────────
// pump.fun BOOST mode injects ~17.6 SOL of buyback+burn TWAP over the 5 minutes
// after every non-Mayhem migration. The arm buys the fresh AMM pool at the
// migration event and exits INSIDE that window:
//   max_hold_seconds 240  — the timed sell into the TWAP (the play itself)
//   trailing_stop 8%      — locks the pop if it front-runs the window
//   take_profit 20%       — ceiling; a bigger pop than BOOST alone explains
//   stop_loss 15%         — hard cap; migration dumps overwhelm the TWAP
// Owner is the same user that owns the core arms; sizing matches the fleet.
const BOOST_ARM = {
	label: 'boost-ride',
	group: 'boost',
	agentName: 'Sniper Arm: Boost Ride',
	agentDescription: 'Autonomous sniper experiment arm: buys the pump AMM at migration and sells into the BOOST buyback window.',
	note: 'buy the AMM at migration, sell into the 5-min BOOST buyback window',
	ownerUser: 'a6a6aed1-9ecc-40cd-889b-340895ee4d8c',
	strategy: {
		enabled: true,
		kill_switch: false,
		trigger: 'graduation_ride',
		decision_mode: 'rules',
		require_socials: false,
		require_sol_quote: true,
		min_market_cap_usd: null,
		max_market_cap_usd: null,
		min_oracle_score: null,
		per_trade_lamports: '10000000',
		daily_budget_lamports: '50000000',
		max_concurrent_positions: 1,
		slippage_bps: 500,
		max_price_impact_pct: 10,
		stop_loss_pct: 15,
		trailing_stop_pct: 8,
		take_profit_pct: 20,
		max_hold_seconds: 240,
		// Owner directive 2026-07-25: EVERY arm sells its initial buy-in at 2x
		// and rides the rest. Even a 4-minute boost ride keeps the moon-bag.
		initials_out_multiple: 2,
		auto_fund_enabled: true,
	},
};

// ── llm-kimi: the multi-model bracket begins (postmortem roadmap) ────────────
// The published audit promised new frontier-model pilots "starting with
// Moonshot's Kimi K3" once named-model routing held. llm_strict_model makes the
// slot safe to open: if the model id is wrong or the router falls back, the arm
// records verdicts for calibration but never spends, so a misrouted pilot costs
// exactly nothing. Sizing and exits mirror the other LLM arms at the budget
// floor; the evolution loop reallocates from there on evidence.
const KIMI_ARM = {
	label: 'llm-kimi',
	group: 'llm',
	agentName: 'Sniper Arm: Kimi Judge',
	agentDescription: 'Autonomous sniper experiment arm: Moonshot Kimi K3 judges every observed launch; no rule shields, strict named-model integrity.',
	note: 'no shields; Kimi K3 judges every launch (strict: fallback verdicts never trade)',
	ownerUser: 'a6a6aed1-9ecc-40cd-889b-340895ee4d8c',
	strategy: {
		enabled: true,
		kill_switch: false,
		trigger: 'intel_confirmed',
		decision_mode: 'llm',
		llm_model: 'moonshotai/kimi-k3',
		llm_min_confidence: 0.65,
		llm_max_confidence: 0.9,
		llm_strict_model: true,
		require_socials: false,
		require_sol_quote: true,
		min_market_cap_usd: null,
		max_market_cap_usd: null,
		min_oracle_score: null,
		per_trade_lamports: '10000000',
		daily_budget_lamports: '20000000',
		max_concurrent_positions: 1,
		slippage_bps: 500,
		max_price_impact_pct: 10,
		stop_loss_pct: 30,
		trailing_stop_pct: 20,
		take_profit_pct: 60,
		max_hold_seconds: 1800,
		initials_out_multiple: 2, // owner directive: initials out at 2x, ride the rest
		auto_fund_enabled: true,
	},
};

const PROVISIONED_ARMS = [BOOST_ARM, KIMI_ARM];

async function provisionArm(pool, arm) {
	// 1. find-or-create the agent identity (idempotent on name + owner).
	const { rows: agents } = await pool.query(
		'select id from agent_identities where user_id = $1 and name = $2 and deleted_at is null',
		[arm.ownerUser, arm.agentName],
	);
	let agentId = agents[0]?.id;
	console.log(`${APPLY ? 'APPLY' : 'PLAN '} ${arm.label.padEnd(16)} ${agentId ? `agent ${agentId.slice(0, 8)} exists` : 'create agent + wallet'}: ${arm.note}`);
	for (const [k, v] of Object.entries(arm.strategy)) console.log(`        ${k} = ${JSON.stringify(v)}`);
	if (!APPLY) return;

	if (!agentId) {
		const { rows: created } = await pool.query(
			`insert into agent_identities (user_id, name, description, is_public)
			 values ($1, $2, $3, false) returning id`,
			[arm.ownerUser, arm.agentName, arm.agentDescription],
		);
		agentId = created[0].id;
		console.log(`        created agent ${agentId}`);
	}

	// 2. custodial Solana wallet (idempotent — ensureAgentWallet no-ops when the
	// agent already holds a valid address + encrypted secret).
	const { ensureAgentWallet } = await import('../api/_lib/agent-wallet.js');
	const wallet = await ensureAgentWallet(agentId, arm.ownerUser, { reason: 'sniper_experiment_seed' });
	console.log(`        wallet ${wallet.address}${wallet.created ? ' (new — auto-funder will top it up)' : ''}`);

	// 3. strategy upsert (same shape as the arm API's upsert).
	const s = { ...arm.strategy, agent_id: agentId, user_id: arm.ownerUser, network: NETWORK, label: arm.label, experiment_group: arm.group };
	const cols = Object.keys(s);
	const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
	const updates = cols.filter((c) => !['agent_id', 'network'].includes(c)).map((c) => `${c} = excluded.${c}`).join(', ');
	const { rows: [row] } = await pool.query(
		`insert into agent_sniper_strategies (${cols.join(', ')}, updated_at)
		 values (${placeholders}, now())
		 on conflict (agent_id, network) do update set ${updates}, updated_at = now()
		 returning id, enabled`,
		cols.map((c) => s[c]),
	);
	console.log(`        strategy ${row.id} armed (enabled=${row.enabled})`);
}

function resolveDatabaseUrl() {
	if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
	// Production's copy is a Secret Manager reference, not a literal on the
	// service, so this has to resolve the reference rather than read `.value`.
	return requireServiceEnvValue('DATABASE_URL');
}

const pool = new Pool({ connectionString: resolveDatabaseUrl() });

const { rows: existing } = await pool.query(
	'select agent_id, label, decision_mode, llm_model, per_trade_lamports, daily_budget_lamports, enabled from agent_sniper_strategies where network = $1',
	[NETWORK],
);
const byAgent = new Map(existing.map((r) => [r.agent_id, r]));

let updated = 0;
for (const arm of ARMS) {
	if (ONLY && arm.label !== ONLY) continue;
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

	// Wallet backfill. The reshape path used to assume every armed agent already
	// held a wallet, and oracle-strict proved it wrong: the arm sat enabled on the
	// strongest signal in the dataset (the conviction-50 crossing) for two days
	// while every candidate died at no_wallet, because its agent had no Solana
	// address. ensureAgentWallet is idempotent (no-ops on a healthy wallet), so
	// every applied reshape now heals this class of arm instead of skipping it.
	const { rows: [ident] } = await pool.query(
		"select user_id, meta->>'solana_address' as addr from agent_identities where id = $1 and deleted_at is null",
		[arm.agent],
	);
	if (ident && !ident.addr) {
		const { ensureAgentWallet } = await import('../api/_lib/agent-wallet.js');
		const wallet = await ensureAgentWallet(arm.agent, ident.user_id, { reason: 'sniper_experiment_seed_backfill' });
		console.log(`        wallet BACKFILLED ${wallet.address} (agent was armed but walletless — auto-funder will top it up)`);
	}
	updated++;
}

for (const arm of PROVISIONED_ARMS) {
	if (!ONLY || ONLY === arm.label) await provisionArm(pool, arm);
}

if (APPLY) console.log(`\nDone: ${updated} strategies updated.`);
else console.log('\nDry-run only. Re-run with --apply to write.');
await pool.end();
