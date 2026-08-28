// @three-ws/brownout
//
// Read where an API's data came from, and break its providers on purpose to
// prove your integration survives it.

export {
	TIERS,
	parseProvenance,
	isStale,
	failedSources,
	describeProvenance,
} from './provenance.js';

export {
	CHAOS_HEADER,
	CHAOS_TOKEN_HEADER,
	CHAOS_STATUS_HEADER,
	chaosDirective,
	chaosHeaders,
	withChaos,
	chaosOutcome,
} from './chaos.js';

export { assertDegraded, BrownoutAssertionError } from './assert.js';
