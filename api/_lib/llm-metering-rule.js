// The one rule the LLM spend ledger has to obey: a lane that spends money must
// never report exactly $0.
//
// It lives here, next to the pricing it judges, rather than inside the audit
// script, so it is unit-testable without a database. The rule caught nothing
// for months precisely because it existed only as an assumption: `openrouter`
// was on the blanket free-provider list while the platform key routed paid
// vendor mirrors, and the dashboard read "served free" while a real $30 balance
// drained to nothing.
//
// Classification, in order:
//   fail  tokens served with no provider recorded (unattributable traffic)
//   skip  a zero-token event with no provider (nothing reached an upstream, so
//         there is no lane to meter)
//   fail  any call in the window recorded an UNKNOWN cost (null), the model
//         reached production with no price; the fix is one table entry
//   fail  a spending lane served tokens and reported exactly $0
//   fail  a lane classified free that somehow booked spend (the inverse lie)
//   ok    everything else, flagged `free` when $0 is the honest answer

import { isFreeLane } from './llm-pricing.js';

/**
 * Judge one aggregated lane of usage_events.
 *
 * @param {object} lane
 * @param {string|null} lane.provider      usage_events.provider
 * @param {string|null} lane.model         usage_events.model
 * @param {number} lane.tokens             input + output tokens over the window
 * @param {number} lane.costMicroUsd       summed cost, nulls counted as 0 by SQL
 * @param {number} lane.unpricedCalls      calls whose cost_micro_usd was NULL
 * @returns {{ status: 'ok'|'fail'|'skip', free: boolean, reason: string|null }}
 */
export function classifyMeteringLane({ provider, model, tokens = 0, costMicroUsd = 0, unpricedCalls = 0 }) {
	const free = provider ? isFreeLane(provider, model) : false;
	if (!provider && tokens > 0) {
		return { status: 'fail', free, reason: 'tokens served with no provider recorded: this traffic cannot be attributed to a lane' };
	}
	if (!provider) {
		return { status: 'skip', free, reason: 'no upstream call (zero tokens): nothing to meter' };
	}
	if (unpricedCalls > 0) {
		return {
			status: 'fail',
			free,
			reason: `${unpricedCalls} call(s) recorded an UNKNOWN cost: add ${model} to PRICE_PER_MTOK in api/_lib/llm-pricing.js`,
		};
	}
	if (!free && tokens > 0 && costMicroUsd === 0) {
		return { status: 'fail', free, reason: 'spending lane reported exactly $0 across every call in the window' };
	}
	if (free && costMicroUsd > 0) {
		return { status: 'fail', free, reason: 'lane is classified free but recorded a cost above $0' };
	}
	return { status: 'ok', free, reason: null };
}
