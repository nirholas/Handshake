// Assertions for a degraded response, for your own test suite.
//
// The assertion that matters is not "it returned 200". It is "the upstream I
// broke was actually reached, AND the response said what it was". A test that
// skips the first half passes whenever a cache happens to be warm, which is
// precisely when it is telling you nothing.

import { parseProvenance, failedSources } from './provenance.js';
import { chaosOutcome } from './chaos.js';

export class BrownoutAssertionError extends Error {
	constructor(message, detail = {}) {
		super(message);
		this.name = 'BrownoutAssertionError';
		Object.assign(this, detail);
	}
}

/**
 * Assert that a response degraded the way you expect.
 *
 * @param {Response} res
 * @param {object} [expect]
 * @param {number|number[]} [expect.status=200]        acceptable status codes
 * @param {string|string[]} [expect.tier]              acceptable freshness tiers
 * @param {string[]} [expect.exercised]                upstreams that MUST appear as failed
 * @param {boolean} [expect.degraded]                  whether the response must report degradation
 * @returns {import('./provenance.js').Provenance|null} the parsed provenance, for further checks
 * @throws {BrownoutAssertionError}
 */
export function assertDegraded(res, expect = {}) {
	const outcome = chaosOutcome(res);
	const prov = parseProvenance(res);

	if (expect.exercised?.length) {
		if (!outcome.applied) {
			throw new BrownoutAssertionError(
				`the server did not apply the fault (${outcome.reason}), so nothing about the fallback was tested`,
				{ outcome },
			);
		}
		const failed = failedSources(prov).map((e) => e.name.toLowerCase());
		for (const name of expect.exercised) {
			const want = String(name).toLowerCase();
			const hit = failed.some((got) => got === want || got.startsWith(`${want}:`));
			if (!hit) {
				throw new BrownoutAssertionError(
					`\`${name}\` never failed during this request, so the fallback under test never ran. ` +
						'A warm cache almost certainly answered first: vary a parameter so the request misses it.',
					{ failed, provenance: prov },
				);
			}
		}
	}

	const wantStatus = [].concat(expect.status ?? 200);
	if (!wantStatus.includes(res.status)) {
		throw new BrownoutAssertionError(`status ${res.status}, expected ${wantStatus.join(' or ')}`, { provenance: prov });
	}

	if (expect.tier) {
		const wantTier = [].concat(expect.tier);
		if (!prov?.tier || !wantTier.includes(prov.tier)) {
			throw new BrownoutAssertionError(`tier ${prov?.tier ?? 'none'}, expected ${wantTier.join(' or ')}`, {
				provenance: prov,
			});
		}
	}

	if (expect.degraded === true && !prov?.degraded) {
		throw new BrownoutAssertionError('the response did not report itself as degraded', { provenance: prov });
	}

	return prov;
}
