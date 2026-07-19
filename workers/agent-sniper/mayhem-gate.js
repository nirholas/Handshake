// agent-sniper — Mayhem exclusion gate (owner rule).
//
// Owner rule: the autonomous sniper must NEVER buy pump.fun "Mayhem" tokens —
// only the regular (non-Mayhem) launches. Mayhem is a higher-fee, buyback-less
// "degen" mode flagged on the on-chain bonding curve as `isMayhemMode`; the
// new-mint firehose does NOT carry the flag, so it's read from the curve (one
// cached RPC read per mint, shared across every agent evaluating that mint).
//
// This wires the already-tested filter from @three-ws/agent-sniper
// (packages/agent-sniper/src/mayhem-filter.js) into the DB-coupled worker's
// buy chokepoint (executor.executeBuy), so EVERY trigger path — new_mint, intel,
// alpha, first_claim, radar, swarm — is covered, not just the standalone fleet.
//
//   SNIPER_MAYHEM_FILTER=0  — disable the gate entirely (default: on)
//   SNIPER_MAYHEM_STRICT=0: allow-on-unknown (default: strict, skip the buy
//                             when the curve can't be read even after retries;
//                             the owner rule is NEVER buy Mayhem, not "buy when
//                             unsure"). Reads rotate the platform RPC chain and
//                             retry, so unknowns are rare, not the common case.

import { createMayhemFilter } from '../../packages/agent-sniper/src/mayhem-filter.js';
import { getConnection } from '../../api/_lib/pump.js';
import { log } from './log.js';

/**
 * Pure verdict from a resolved isMayhemMode read. Extracted so the decision is
 * unit-testable without an RPC/SDK. `null` = couldn't read the curve (unknown).
 * @param {boolean|null} isMayhem
 * @param {{ strict?: boolean }} [opts]
 * @returns {{ pass: boolean, reason?: string, unknown?: boolean }}
 */
export function mayhemVerdict(isMayhem, { strict = false } = {}) {
	if (isMayhem === true) return { pass: false, reason: 'mayhem_excluded' };
	if (isMayhem === null || isMayhem === undefined) {
		return strict ? { pass: false, reason: 'mayhem_unknown', unknown: true } : { pass: true, unknown: true };
	}
	return { pass: true };
}

let _filter = null;
function getFilter(cfg) {
	if (_filter) return _filter;
	// Use the platform's rotating multi-endpoint connection (same chain as the
	// trade path), NOT a raw Connection pinned to one provider: a single throttled
	// endpoint used to fail every read into "unknown", which on a strict gate
	// skipped every buy fleet-wide. Retries are safe; the flag is immutable.
	_filter = createMayhemFilter({
		connection: getConnection({ network: cfg?.network || 'mainnet' }),
		strictOnUnknown: !!cfg?.mayhemStrict,
	});
	return _filter;
}

/**
 * Gate one mint. Returns { pass, reason }. Never throws — an internal failure is
 * treated as "unknown" and resolved by the strict flag, so the gate can't stall
 * the trader. No-op pass-through when the filter is disabled.
 * @param {string} mint
 * @param {object} cfg  worker config (uses cfg.mayhemFilter, cfg.mayhemStrict, cfg.rpcUrl)
 * @returns {Promise<{ pass: boolean, reason?: string }>}
 */
export async function mayhemGate(mint, cfg) {
	if (!cfg?.mayhemFilter) return { pass: true };
	try {
		const isMayhem = await getFilter(cfg).isMayhem(mint);
		const v = mayhemVerdict(isMayhem, { strict: !!cfg.mayhemStrict });
		if (v.unknown) log.info('mayhem unknown', { mint, strict: !!cfg.mayhemStrict, pass: v.pass });
		return { pass: v.pass, reason: v.reason };
	} catch (err) {
		const v = mayhemVerdict(null, { strict: !!cfg.mayhemStrict });
		log.warn('mayhem check failed', { mint, err: err?.message, pass: v.pass });
		return { pass: v.pass, reason: v.reason };
	}
}

/** Test seam: reset the memoized filter singleton. */
export function _resetMayhemFilter() { _filter = null; }
