// Treasury — reads and writes the unstoppable_treasury singleton row.
//
// USDC uses 6 decimal places: $1.00 = 1_000_000 atomics.
// The treasury row is always id=1 (enforced by a CHECK constraint).
// All mutations are upserts so a missing row is created on first write.

import { sql } from '../../../api/_lib/db.js';

// Agent halts paid actions when balance drops below this floor ($0.10).
export const HARD_FLOOR_ATOMICS = 100_000;

// Daily burn above which conservation mode is activated (2x floor/day).
const CONSERVATION_THRESHOLD_ATOMICS = 50_000;

// Returns the current treasury state.
// Falls back to a zeroed object if the row doesn't exist yet.
export async function getTreasury() {
	try {
		const [row] = await sql`
			SELECT
				balance_usdc_atomics,
				lifetime_earned_atomics,
				lifetime_spent_atomics,
				runway_days,
				mode,
				updated_at
			FROM unstoppable_treasury
			WHERE id = 1
		`;
		if (!row) {
			return {
				balance_usdc_atomics: 0,
				lifetime_earned_atomics: 0,
				lifetime_spent_atomics: 0,
				runway_days: 0,
				mode: 'normal',
				updated_at: null,
			};
		}
		return {
			balance_usdc_atomics: Number(row.balance_usdc_atomics),
			lifetime_earned_atomics: Number(row.lifetime_earned_atomics),
			lifetime_spent_atomics: Number(row.lifetime_spent_atomics),
			runway_days: Number(row.runway_days),
			mode: row.mode,
			updated_at: row.updated_at,
		};
	} catch (err) {
		console.error('[treasury] getTreasury failed:', err.message);
		return {
			balance_usdc_atomics: 0,
			lifetime_earned_atomics: 0,
			lifetime_spent_atomics: 0,
			runway_days: 0,
			mode: 'normal',
			updated_at: null,
		};
	}
}

// Seeds the treasury row with a starting balance if it doesn't exist.
// Safe to call repeatedly — does nothing if the row already exists.
export async function seedTreasuryIfEmpty(startingAtomics = 50_000) {
	await sql`
		INSERT INTO unstoppable_treasury (id, balance_usdc_atomics, mode)
		VALUES (1, ${startingAtomics}, 'normal')
		ON CONFLICT (id) DO NOTHING
	`;
}

// Records an earning event: increments balance + lifetime_earned.
export async function recordEarning(amountAtomics) {
	const amount = BigInt(Math.round(amountAtomics));
	await sql`
		INSERT INTO unstoppable_treasury (
			id,
			balance_usdc_atomics,
			lifetime_earned_atomics,
			updated_at
		)
		VALUES (
			1,
			${amount},
			${amount},
			now()
		)
		ON CONFLICT (id) DO UPDATE SET
			balance_usdc_atomics   = unstoppable_treasury.balance_usdc_atomics + ${amount},
			lifetime_earned_atomics = unstoppable_treasury.lifetime_earned_atomics + ${amount},
			updated_at             = now()
	`;
}

// Records a spend event: decrements balance + increments lifetime_spent.
// Balance is clamped to 0 — never goes negative.
export async function recordSpend(amountAtomics) {
	const amount = BigInt(Math.round(amountAtomics));
	await sql`
		INSERT INTO unstoppable_treasury (
			id,
			balance_usdc_atomics,
			lifetime_spent_atomics,
			updated_at
		)
		VALUES (
			1,
			0,
			${amount},
			now()
		)
		ON CONFLICT (id) DO UPDATE SET
			balance_usdc_atomics  = GREATEST(0, unstoppable_treasury.balance_usdc_atomics - ${amount}),
			lifetime_spent_atomics = unstoppable_treasury.lifetime_spent_atomics + ${amount},
			updated_at            = now()
	`;
}

// Recomputes runway from last-24h burn rate and updates the treasury mode:
//   - 'normal'       → runway > 7 days or no burn history
//   - 'conservation' → runway ≤ 7 days but balance > HARD_FLOOR_ATOMICS
//   - 'halted'       → balance ≤ HARD_FLOOR_ATOMICS
export async function recalcRunway() {
	try {
		// Burn rate = total costs in last 24h, annualised to a daily rate.
		const [burnRow] = await sql`
			SELECT COALESCE(SUM(cost_atomics), 0)::BIGINT AS burn_24h
			FROM unstoppable_activity
			WHERE created_at > now() - INTERVAL '24 hours'
		`;
		const burn24h = Number(burnRow?.burn_24h ?? 0);

		const treasury = await getTreasury();
		const balance = treasury.balance_usdc_atomics;

		let runwayDays = 0;
		if (burn24h > 0) {
			runwayDays = balance / burn24h;
		} else if (balance > 0) {
			// No burn — arbitrary large runway
			runwayDays = 9999;
		}

		let mode = 'normal';
		if (balance <= HARD_FLOOR_ATOMICS) {
			mode = 'halted';
		} else if (runwayDays < 7 || burn24h > CONSERVATION_THRESHOLD_ATOMICS) {
			mode = 'conservation';
		}

		await sql`
			INSERT INTO unstoppable_treasury (id, runway_days, mode, updated_at)
			VALUES (1, ${runwayDays.toFixed(2)}, ${mode}, now())
			ON CONFLICT (id) DO UPDATE SET
				runway_days = ${runwayDays.toFixed(2)},
				mode        = ${mode},
				updated_at  = now()
		`;

		return { runwayDays, mode, burn24h };
	} catch (err) {
		console.error('[treasury] recalcRunway failed:', err.message);
		return { runwayDays: 0, mode: 'normal', burn24h: 0 };
	}
}
