// Pure airdrop-eligibility evaluator behind /api/crypto/airdrops and the
// /airdrops page. Scores a wallet's on-chain activity against a registry of
// airdrop criteria and explains exactly what is met, what is missing, and what
// to do next. No fetch, no env: the activity summary comes from
// api/_lib/wallet-activity.js and the registry from data/airdrops.json, so
// tests/airdrop-eligibility.test.js can pin the scoring with hand fixtures.
//
// Criteria speak a small check DSL: "<field> <op> <number>", ops >= > <= < ==,
// fields limited to the activity summary's numeric keys. A criterion whose
// field the scan could not measure (null) is reported as "unknown" and counts
// as unmet, never as met: a wallet is told what we could not see, not given
// credit for it.

// Score thresholds shared by the API and the page: >= QUALIFIED is eligible,
// >= IN_PROGRESS is worth finishing, below that is not eligible.
export const QUALIFIED_SCORE = 80;
export const IN_PROGRESS_SCORE = 30;

// The measurable activity fields. Anything else in a check string is a
// registry bug and evaluates to unmet-with-reason rather than a throw.
export const ACTIVITY_FIELDS = new Set([
	'tx_count',
	'days_active',
	'account_age_days',
	'last_active_days',
	'unique_tokens',
	'contract_interactions',
	'chains_active',
	'volume_usd',
]);

const CHECK_RE = /^([a-z_]+)\s*(>=|>|<=|<|==)\s*([\d.]+)$/;

/**
 * Evaluate one criterion against an activity summary.
 * @param {{ check: string, description: string }} criterion
 * @param {Record<string, number|null>} activity
 * @returns {{ met: boolean, unknown: boolean, field: string|null, target: number|null, actual: number|null }}
 */
export function evaluateCriterion(criterion, activity) {
	const m = CHECK_RE.exec(String(criterion?.check || '').trim());
	if (!m) return { met: false, unknown: true, field: null, target: null, actual: null };
	const [, field, op, rawTarget] = m;
	const target = Number(rawTarget);
	if (!ACTIVITY_FIELDS.has(field) || !Number.isFinite(target)) {
		return { met: false, unknown: true, field, target: null, actual: null };
	}
	const actual = activity?.[field];
	if (actual == null || !Number.isFinite(actual)) {
		return { met: false, unknown: true, field, target, actual: null };
	}
	const met =
		op === '>=' ? actual >= target
		: op === '>' ? actual > target
		: op === '<=' ? actual <= target
		: op === '<' ? actual < target
		: actual === target;
	return { met, unknown: false, field, target, actual };
}

// Plain-language next step for a missing criterion, keyed by activity field.
// Interpolates the airdrop's name so the checklist reads as instructions, not
// as schema.
function recommendationFor(field, target, name) {
	switch (field) {
		case 'tx_count':
			return `Make more transactions on ${name}'s chain; ${target} total puts you over this bar.`;
		case 'days_active':
			return `Spread activity across more days; ${target} distinct active days is the bar.`;
		case 'account_age_days':
			return `This favors older wallets (${target}+ days). Keep using this wallet rather than rotating to a fresh one.`;
		case 'last_active_days':
			return `The wallet has been idle too long; any recent transaction restores this.`;
		case 'unique_tokens':
			return `Hold or trade a wider set of tokens; ${target}+ distinct tokens counts here.`;
		case 'contract_interactions':
			return `Interact with more on-chain programs and contracts; ${target}+ contract calls is the bar.`;
		case 'chains_active':
			return `Be active on more chains; ${target}+ chains with real activity counts.`;
		case 'volume_usd':
			return `Move more total value through the wallet; about $${Number(target).toLocaleString('en-US')} in volume is the bar.`;
		default:
			return `Complete: ${name}'s remaining criteria.`;
	}
}

/**
 * Evaluate one registry entry.
 *
 * Criteria come in two kinds. A criterion WITH a `check` string is scored
 * against the measured activity. A criterion WITHOUT one is a manual step
 * (protocol-specific actions a wallet scan cannot see, like staking in a
 * specific program): it is surfaced as a to-do and deliberately excluded from
 * the score, so the score only ever claims what was actually measured.
 *
 * @param {object} entry registry entry with `criteria: [{check?, description}]`
 * @param {Record<string, number|null>} activity
 */
export function evaluateAirdrop(entry, activity) {
	const scored = (entry.criteria || []).filter((c) => c.check);
	const manual = (entry.criteria || []).filter((c) => !c.check).map((c) => ({ description: c.description }));
	const results = scored.map((c) => ({
		description: c.description,
		...evaluateCriterion(c, activity),
	}));
	const met = results.filter((r) => r.met);
	const missing = results
		.filter((r) => !r.met)
		.map((r) => ({
			...r,
			recommendation: r.unknown && r.field == null
				? 'This criterion could not be evaluated; treat it as open.'
				: recommendationFor(r.field, r.target, entry.name),
		}));
	const score = results.length ? Math.round((met.length / results.length) * 100) : 0;
	return {
		id: entry.id,
		name: entry.name,
		chain: entry.chain,
		family: entry.family,
		status: entry.status,
		icon: entry.icon || null,
		estimatedValue: entry.estimatedValue || null,
		deadline: entry.deadline || null,
		source: entry.source,
		note: entry.note || null,
		score,
		eligibility:
			score >= QUALIFIED_SCORE ? 'qualified'
			: score >= IN_PROGRESS_SCORE ? 'in_progress'
			: 'not_eligible',
		met,
		missing,
		manual,
	};
}

/**
 * Evaluate the whole registry for one wallet family. Entries for the other
 * chain family are returned unevaluated (score null) so the page can say
 * "check this with your Solana wallet" instead of showing a fake zero.
 * @param {Array<object>} registry
 * @param {Record<string, number|null>} activity
 * @param {'solana'|'evm'} family activity's chain family
 */
export function evaluateRegistry(registry, activity, family) {
	const evaluated = [];
	const otherFamily = [];
	for (const entry of registry) {
		if (entry.family === family) evaluated.push(evaluateAirdrop(entry, activity));
		else otherFamily.push({
			id: entry.id,
			name: entry.name,
			chain: entry.chain,
			family: entry.family,
			status: entry.status,
			icon: entry.icon || null,
			estimatedValue: entry.estimatedValue || null,
			deadline: entry.deadline || null,
			source: entry.source,
			note: entry.note || null,
			score: null,
			eligibility: 'other_family',
			met: [],
			missing: [],
			manual: [],
		});
	}
	evaluated.sort((a, b) => b.score - a.score);
	return { evaluated, otherFamily };
}

/**
 * Roll evaluated opportunities up into the hero numbers.
 * Estimated value range sums only QUALIFIED entries' declared ranges; a
 * registry entry with no estimate contributes nothing, and no range is ever
 * invented.
 */
export function summarize(evaluated) {
	const counts = { qualified: 0, in_progress: 0, not_eligible: 0 };
	let lo = 0;
	let hi = 0;
	let priced = 0;
	for (const o of evaluated) {
		counts[o.eligibility] += 1;
		if (o.eligibility === 'qualified' && o.estimatedValue) {
			const nums = String(o.estimatedValue).match(/[\d,]+/g)?.map((n) => Number(n.replace(/,/g, ''))) || [];
			if (nums.length >= 1 && nums.every(Number.isFinite)) {
				lo += nums[0];
				hi += nums.length > 1 ? nums[1] : nums[0];
				priced += 1;
			}
		}
	}
	return {
		tracked: evaluated.length,
		...counts,
		estimatedValue: priced > 0 ? { lo, hi, entries: priced } : null,
	};
}
