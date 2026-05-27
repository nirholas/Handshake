// GET /api/agents/unstoppable-status
//
// Paid endpoint ($0.01 USDC). Returns the live state of the Unstoppable Agent:
// treasury balance, runway, 24h earnings/costs, recent activity, and latest
// daily reflection.
//
// Revenue from this endpoint funds the agent's own operations — every status
// check extends the agent's runway.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import { sql } from '../_lib/db.js';
import { getTreasury, seedTreasuryIfEmpty } from '../../agents/unstoppable/src/treasury.js';
import { recordRevenue, getEarnings24h, getCosts24h, getRecentActivity } from '../../agents/unstoppable/src/earnings.js';
import { getLatestReflection } from '../../agents/unstoppable/src/reflection.js';

const ROUTE = '/api/agents/unstoppable-status';
const PRICE_ATOMICS = priceFor('unstoppable-status', '10000'); // $0.01 default

const DESCRIPTION =
	'Unstoppable Agent Status — live treasury balance, runway, 24h P&L, ' +
	'recent activity feed, and daily reflection from the self-sustaining AI ' +
	'agent running on three.ws. Every paid query directly funds the agent\'s ' +
	'continued operation.';

const OUTPUT_EXAMPLE = {
	status: 'running',
	treasury: {
		balance_usdc: '0.42',
		balance_usdc_atomics: 420000,
		runway_days: 12.4,
		lifetime_earned_usdc: '1.85',
		lifetime_spent_usdc: '1.43',
	},
	activity_24h: {
		earnings_usdc: '0.05',
		costs_usdc: '0.02',
		net_usdc: '0.03',
		action_count: 288,
	},
	recent_activity: [
		{ action_type: 'think', description: 'Strategic planning complete.', cost_usdc: '0.000000', created_at: '2026-05-27T12:00:00Z' },
	],
	latest_reflection: { date: '2026-05-27', summary: 'Today was profitable.', strategy_notes: 'Continue status-check monetization.' },
	agent_info: {
		name: 'Unstoppable',
		purpose: 'Self-sustaining autonomous agent on three.ws',
		service: 'Paid status checks via x402',
		wallet: 'earned by serving /api/agents/unstoppable-status',
	},
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['status', 'treasury', 'activity_24h', 'recent_activity', 'agent_info'],
	properties: {
		status: { type: 'string', enum: ['running', 'conservation', 'halted'] },
		treasury: { type: 'object' },
		activity_24h: { type: 'object' },
		recent_activity: { type: 'array' },
		latest_reflection: { type: ['object', 'null'] },
		agent_info: { type: 'object' },
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'GET' },
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'GET',
		outputSchema: OUTPUT_SCHEMA,
	}),
};

// Ensures the DB tables exist and the treasury row is seeded.
// Safe to call on every request — fast no-op after first invocation.
async function ensureBootstrapped() {
	try {
		// Create tables if they don't exist (idempotent).
		await sql`
			CREATE TABLE IF NOT EXISTS unstoppable_treasury (
				id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
				balance_usdc_atomics BIGINT NOT NULL DEFAULT 0,
				lifetime_earned_atomics BIGINT NOT NULL DEFAULT 0,
				lifetime_spent_atomics BIGINT NOT NULL DEFAULT 0,
				runway_days NUMERIC(6,2) NOT NULL DEFAULT 0,
				mode TEXT NOT NULL DEFAULT 'normal',
				updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
			)
		`;
		await sql`
			CREATE TABLE IF NOT EXISTS unstoppable_activity (
				id BIGSERIAL PRIMARY KEY,
				tick_id TEXT NOT NULL,
				action_type TEXT NOT NULL,
				description TEXT NOT NULL,
				cost_atomics BIGINT NOT NULL DEFAULT 0,
				revenue_atomics BIGINT NOT NULL DEFAULT 0,
				metadata JSONB,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now()
			)
		`;
		await sql`
			CREATE INDEX IF NOT EXISTS unstoppable_activity_created_at
				ON unstoppable_activity (created_at DESC)
		`;
		await sql`
			CREATE TABLE IF NOT EXISTS unstoppable_reflections (
				id BIGSERIAL PRIMARY KEY,
				date DATE NOT NULL UNIQUE,
				summary TEXT NOT NULL,
				earnings_24h_atomics BIGINT NOT NULL DEFAULT 0,
				costs_24h_atomics BIGINT NOT NULL DEFAULT 0,
				actions_count INTEGER NOT NULL DEFAULT 0,
				strategy_notes TEXT,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now()
			)
		`;
		// Seed the treasury with a $0.05 starting donation from the team.
		await seedTreasuryIfEmpty(50_000);
	} catch (err) {
		// Non-fatal — if tables already exist this is just a no-op.
		console.warn('[unstoppable-status] bootstrap warning:', err.message);
	}
}

function atomicsToUsdc(atomics) {
	return (Number(atomics) / 1_000_000).toFixed(6);
}

function statusFromMode(mode) {
	if (mode === 'halted') return 'halted';
	if (mode === 'conservation') return 'conservation';
	return 'running';
}

async function loadStatus() {
	await ensureBootstrapped();

	const [treasury, earnings24h, costs24h, recentActivity, latestReflection] = await Promise.all([
		getTreasury(),
		getEarnings24h(),
		getCosts24h(),
		getRecentActivity(20),
		getLatestReflection(),
	]);

	// Count actions in last 24h
	let actionCount = 0;
	try {
		const [countRow] = await sql`
			SELECT COUNT(*)::INT AS n
			FROM unstoppable_activity
			WHERE created_at > now() - INTERVAL '24 hours'
		`;
		actionCount = countRow?.n ?? 0;
	} catch {
		actionCount = recentActivity.length;
	}

	const status = statusFromMode(treasury.mode);

	return {
		status,
		treasury: {
			balance_usdc: atomicsToUsdc(treasury.balance_usdc_atomics),
			balance_usdc_atomics: treasury.balance_usdc_atomics,
			runway_days: Number(treasury.runway_days),
			lifetime_earned_usdc: atomicsToUsdc(treasury.lifetime_earned_atomics),
			lifetime_spent_usdc: atomicsToUsdc(treasury.lifetime_spent_atomics),
		},
		activity_24h: {
			earnings_usdc: atomicsToUsdc(earnings24h),
			costs_usdc: atomicsToUsdc(costs24h),
			net_usdc: atomicsToUsdc(earnings24h - costs24h),
			action_count: actionCount,
		},
		recent_activity: recentActivity.map((a) => ({
			action_type: a.action_type,
			description: a.description,
			cost_usdc: atomicsToUsdc(a.cost_atomics),
			revenue_usdc: atomicsToUsdc(a.revenue_atomics),
			created_at: a.created_at,
		})),
		latest_reflection: latestReflection
			? {
					date: latestReflection.date,
					summary: latestReflection.summary,
					strategy_notes: latestReflection.strategy_notes,
				}
			: null,
		agent_info: {
			name: 'Unstoppable',
			purpose: 'Self-sustaining autonomous agent on three.ws',
			service: 'Paid status checks via x402',
			wallet: 'earned by serving /api/agents/unstoppable-status',
		},
	};
}

export default paidEndpoint({
	route: ROUTE,
	method: 'GET',
	priceAtomics: PRICE_ATOMICS,
	networks: ['base', 'solana'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Unstoppable',
		tags: ['agent', 'autonomous', 'treasury', 'x402', 'self-sustaining'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
	async handler({ req }) {
		const data = await loadStatus();

		// Record the revenue from this paid query — every call funds the agent.
		// Fire-and-forget: a logging failure must not break the paid response.
		recordRevenue({
			amountAtomics: Number(PRICE_ATOMICS),
			source: 'status_check',
			metadata: { route: ROUTE },
		}).catch((err) => {
			console.error('[unstoppable-status] recordRevenue failed:', err.message);
		});

		return data;
	},
});
