// Dynamic pricing rules engine.
//
// Rules are evaluated in ascending priority order. First matching rule wins.
// If no rule matches, falls back to the base price from agent_skill_prices.
//
// Rule types:
//   first_n_purchases  — discounted price for the first N confirmed purchases
//   after_n_purchases  — higher price once N total confirmed purchases exist
//   time_window        — price applies only between start_at and end_at

import { sql } from './db.js';

/**
 * Resolve the effective price for a skill, taking any active dynamic pricing
 * rules into account.
 *
 * Returns null when the skill has no base price (free).
 * Returns { amount, currency_mint, chain } with the applicable price.
 */
export async function resolveSkillPrice(agentId, skillName) {
	// Base price — always need this to know currency_mint / chain.
	const [base] = await sql`
		SELECT amount, currency_mint, chain
		FROM agent_skill_prices
		WHERE agent_id = ${agentId} AND skill = ${skillName} AND is_active = true
	`;
	if (!base) return null; // skill is free

	// Active rules sorted by priority asc (lowest number = highest priority).
	const rules = await sql`
		SELECT rule_type, threshold, price_amount, start_at, end_at
		FROM skill_pricing_rules
		WHERE agent_id = ${agentId}
		  AND skill_name = ${skillName}
		  AND is_active = true
		ORDER BY priority ASC, created_at ASC
	`;

	if (!rules.length) return base;

	// Current confirmed sale count for this skill.
	const [{ count }] = await sql`
		SELECT COUNT(*)::int AS count
		FROM skill_purchases
		WHERE agent_id = ${agentId} AND skill = ${skillName} AND status = 'confirmed'
	`;
	const saleCount = count;

	const now = new Date();

	for (const rule of rules) {
		if (rule.rule_type === 'first_n_purchases') {
			if (saleCount < rule.threshold) {
				return { amount: rule.price_amount, currency_mint: base.currency_mint, chain: base.chain };
			}
		} else if (rule.rule_type === 'after_n_purchases') {
			if (saleCount >= rule.threshold) {
				return { amount: rule.price_amount, currency_mint: base.currency_mint, chain: base.chain };
			}
		} else if (rule.rule_type === 'time_window') {
			const start = rule.start_at ? new Date(rule.start_at) : null;
			const end = rule.end_at ? new Date(rule.end_at) : null;
			const inWindow = (!start || now >= start) && (!end || now <= end);
			if (inWindow) {
				return { amount: rule.price_amount, currency_mint: base.currency_mint, chain: base.chain };
			}
		}
	}

	return base;
}

/**
 * Public promo descriptor for a skill: powers proof-phase UI (spots-left
 * counters, strikethrough list prices) without duplicating rule evaluation.
 *
 * Returns null when the skill has no base price. `promo` is non-null only
 * while a `first_n_purchases` rule is the winning rule right now, and carries
 * the real confirmed-sale count so a rendered "N spots left" can never drift
 * from what the purchase quote will charge.
 */
export async function describeSkillPromo(agentId, skillName) {
	const [base] = await sql`
		SELECT amount, currency_mint, chain
		FROM agent_skill_prices
		WHERE agent_id = ${agentId} AND skill = ${skillName} AND is_active = true
	`;
	if (!base) return null;

	const effective = await resolveSkillPrice(agentId, skillName);

	const rules = await sql`
		SELECT rule_type, threshold, price_amount
		FROM skill_pricing_rules
		WHERE agent_id = ${agentId}
		  AND skill_name = ${skillName}
		  AND is_active = true
		  AND rule_type = 'first_n_purchases'
		ORDER BY priority ASC, created_at ASC
		LIMIT 1
	`;

	let promo = null;
	const rule = rules[0];
	if (rule && effective && String(effective.amount) === String(rule.price_amount)) {
		const [{ count }] = await sql`
			SELECT COUNT(*)::int AS count
			FROM skill_purchases
			WHERE agent_id = ${agentId} AND skill = ${skillName} AND status = 'confirmed'
		`;
		if (count < rule.threshold) {
			promo = {
				rule_type: 'first_n_purchases',
				threshold: rule.threshold,
				claimed: count,
				spots_left: rule.threshold - count,
				promo_amount: String(rule.price_amount),
				list_amount: String(base.amount),
			};
		}
	}

	return {
		base_amount: String(base.amount),
		effective_amount: String(effective?.amount ?? base.amount),
		currency_mint: base.currency_mint,
		chain: base.chain,
		promo,
	};
}
