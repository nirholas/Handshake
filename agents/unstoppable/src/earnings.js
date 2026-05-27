// Earnings — tracks revenue and costs for the unstoppable agent.
//
// Revenue comes from paid status-check requests to /api/agents/unstoppable-status.
// Every payment triggers recordRevenue() which writes an activity row and
// updates the treasury balance.

import { sql } from '../../../api/_lib/db.js';
import { recordEarning } from './treasury.js';

// Records a revenue event: activity log row + treasury update.
export async function recordRevenue({ amountAtomics, source = 'unknown', metadata = null, tickId = null }) {
	const amount = Math.round(amountAtomics);
	const resolvedTickId = tickId || `earn-${Date.now()}`;

	try {
		await sql`
			INSERT INTO unstoppable_activity (
				tick_id,
				action_type,
				description,
				cost_atomics,
				revenue_atomics,
				metadata,
				created_at
			) VALUES (
				${resolvedTickId},
				'earn',
				${'Revenue from ' + source + ': $' + (amount / 1_000_000).toFixed(6) + ' USDC'},
				0,
				${amount},
				${metadata ? JSON.stringify(metadata) : null},
				now()
			)
		`;
		await recordEarning(amount);
	} catch (err) {
		console.error('[earnings] recordRevenue failed:', err.message);
		// Re-throw so caller knows the revenue wasn't recorded — important for
		// idempotency tracking at the endpoint level.
		throw err;
	}
}

// Returns total revenue_atomics from the last 24 hours.
export async function getEarnings24h() {
	try {
		const [row] = await sql`
			SELECT COALESCE(SUM(revenue_atomics), 0)::BIGINT AS total
			FROM unstoppable_activity
			WHERE created_at > now() - INTERVAL '24 hours'
		`;
		return Number(row?.total ?? 0);
	} catch (err) {
		console.error('[earnings] getEarnings24h failed:', err.message);
		return 0;
	}
}

// Returns total cost_atomics from the last 24 hours.
export async function getCosts24h() {
	try {
		const [row] = await sql`
			SELECT COALESCE(SUM(cost_atomics), 0)::BIGINT AS total
			FROM unstoppable_activity
			WHERE created_at > now() - INTERVAL '24 hours'
		`;
		return Number(row?.total ?? 0);
	} catch (err) {
		console.error('[earnings] getCosts24h failed:', err.message);
		return 0;
	}
}

// Returns the N most recent activity rows (default 20).
export async function getRecentActivity(limit = 20) {
	try {
		const rows = await sql`
			SELECT
				id,
				tick_id,
				action_type,
				description,
				cost_atomics,
				revenue_atomics,
				metadata,
				created_at
			FROM unstoppable_activity
			ORDER BY created_at DESC
			LIMIT ${limit}
		`;
		return rows.map((r) => ({
			id: String(r.id),
			tick_id: r.tick_id,
			action_type: r.action_type,
			description: r.description,
			cost_atomics: Number(r.cost_atomics),
			revenue_atomics: Number(r.revenue_atomics),
			metadata: r.metadata || null,
			created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
		}));
	} catch (err) {
		console.error('[earnings] getRecentActivity failed:', err.message);
		return [];
	}
}

// Logs a generic activity entry (used by loop.js for non-revenue actions).
export async function logActivity({ tickId, action_type, description, cost_atomics = 0, revenue_atomics = 0, metadata = null }) {
	try {
		await sql`
			INSERT INTO unstoppable_activity (
				tick_id,
				action_type,
				description,
				cost_atomics,
				revenue_atomics,
				metadata,
				created_at
			) VALUES (
				${tickId},
				${action_type},
				${description},
				${Math.round(cost_atomics)},
				${Math.round(revenue_atomics)},
				${metadata ? JSON.stringify(metadata) : null},
				now()
			)
		`;
	} catch (err) {
		console.error('[earnings] logActivity failed:', err.message);
	}
}
