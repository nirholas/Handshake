// @ts-check
// Brownout: the platform's degradation layer.
//
//   provenance  what answered this request, and how fresh it was
//   chaos       break a named upstream on purpose, for one request, safely
//
// Both are re-exported here so a caller (including the isomorphic
// src/shared/failover-fetch.js, which loads this lazily on the server only)
// needs a single import.

export {
	TIERS,
	worstTier,
	withProvenance,
	currentLedger,
	recordSource,
	provenanceSummary,
	provenanceHeaders,
} from './provenance.js';

export {
	CHAOS_HEADER,
	CHAOS_TOKEN_HEADER,
	CHAOS_STATUS_HEADER,
	parseChaosDirective,
	chaosDecision,
	withChaos,
	faultFor,
	chaosActive,
	applyFault,
} from './chaos.js';
