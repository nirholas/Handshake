// Every per-page `fetchJson` helper in the browser bundle is its own copy of
// the same three lines, and nine of them shipped with no deadline: the page
// painted a skeleton, called fetch(), and had no way back if the edge never
// answered. A user on a captive-portal Wi-Fi or behind a black-holing proxy sat
// on a spinner forever, with no error and no retry.
//
// The fix is per-file, so nothing stops the next copy-paste from dropping the
// signal again. This test pins the invariant on the source: each named helper
// must bound its own request, and the module-level ones must accept a
// caller-supplied override so a genuinely slow endpoint can ask for more.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// file -> the helper every network read on that surface goes through.
const HELPERS = [
	['src/agent-detail.js', 'fetchJson'],
	['src/launch-detail.js', 'fetchJson'],
	['src/seeker.js', 'fetchJson'],
	['src/gestures-page.js', 'fetchJson'],
	['src/agent-skills-nfts.js', 'fetchJson'],
	['src/agent-skills-pumpfun-watch.js', 'fetchJson'],
	['src/shared/wallet-card.js', 'fetchJson'],
	['src/game/npc/npc-aixbt.js', 'fetchJson'],
	['src/mission-control/enrich.js', 'fetchJson'],
	['src/markets-page.js', 'getJson'],
	// The reference implementation these were modelled on.
	['src/theater.js', 'fetchJson'],
];

/** The source of `name`'s declaration, up to the first blank line after it. */
function helperSource(file, name) {
	const src = readFileSync(join(ROOT, file), 'utf8');
	const at = src.indexOf(`async function ${name}(`);
	expect(at, `${file}: no "async function ${name}(" found`).toBeGreaterThan(-1);
	const end = src.indexOf('\n\n', at);
	return src.slice(at, end === -1 ? src.length : end);
}

describe('per-page fetch helpers are time-bounded', () => {
	for (const [file, name] of HELPERS) {
		it(`${file}: ${name}() bounds its request`, () => {
			const body = helperSource(file, name);
			const bounded = /AbortSignal\.timeout\(/.test(body) || /new AbortController\(/.test(body);
			expect(bounded, `${file}: ${name}() must pass an abort signal`).toBe(true);
			expect(/signal/.test(body), `${file}: ${name}() must hand the signal to fetch`).toBe(true);
		});

		it(`${file}: ${name}() lets the caller change the deadline`, () => {
			// A hardcoded constant is fine until one endpoint is legitimately slow
			// (an on-chain verify, a cold worker) and the only escape is editing
			// the helper. Every copy takes an override in its options object.
			const body = helperSource(file, name);
			expect(/\btimeout\b/.test(body), `${file}: ${name}() must accept a timeout option`).toBe(true);
		});
	}

	it('covers every helper the audit found, so a deletion here is visible', () => {
		expect(HELPERS).toHaveLength(11);
		expect(new Set(HELPERS.map(([f]) => f)).size).toBe(HELPERS.length);
	});
});
