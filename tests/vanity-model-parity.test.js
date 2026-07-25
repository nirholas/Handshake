// The Base58 difficulty model exists in three independently-shipped artifacts:
//
//   1. src/solana/vanity/base58-distribution.js  — the site + API
//   2. solana-agent-sdk/src/vanity/verify.ts     — the published TS SDK verifier
//   3. mcp-server/src/lib/base58-distribution.js — the standalone MCP npm package
//
// Each is zero-dependency by design and cannot import the others, so the code is
// deliberately duplicated. Duplication without a parity check is how the three
// drift apart, and a verifier that disagrees with the issuer about difficulty
// rejects honest receipts. These tests are the thing that keeps them honest.

import { describe, it, expect } from 'vitest';

import {
	prefixProbability as sitePrefixProbability,
	BASE58_ALPHABET,
} from '../src/solana/vanity/base58-distribution.js';
import {
	expectedAttempts as siteExpectedAttempts,
	expectedAttemptsUniform as siteUniform,
	difficultyModel as siteDifficultyModel,
	DIFFICULTY_MODEL,
	DIFFICULTY_MODEL_V1,
} from '../src/solana/vanity/validation.js';
import {
	expectedAttempts as sdkExpectedAttempts,
	expectedAttemptsUniform as sdkUniform,
	difficultyModel as sdkDifficultyModel,
	DIFFICULTY_MODEL as SDK_DIFFICULTY_MODEL,
	DIFFICULTY_MODEL_V1 as SDK_DIFFICULTY_MODEL_V1,
} from '../solana-agent-sdk/src/vanity/verify.ts';
import { expectedAttempts as mcpExpectedAttempts } from '../mcp-server/src/lib/base58-distribution.js';

/** Patterns chosen to hit every band and edge case of the encoding. */
const VECTORS = [
	{ prefix: 'A', suffix: '', ignoreCase: false }, // easy band
	{ prefix: '2', suffix: '', ignoreCase: false }, // 44-digit-only band
	{ prefix: '4', suffix: '', ignoreCase: false }, // boundary symbol
	{ prefix: 'J', suffix: '', ignoreCase: false }, // partial band
	{ prefix: 'z', suffix: '', ignoreCase: false }, // hard band
	{ prefix: '1', suffix: '', ignoreCase: false }, // leading zero byte
	{ prefix: '11', suffix: '', ignoreCase: false }, // two zero bytes
	{ prefix: '1a', suffix: '', ignoreCase: false }, // zero byte then a digit
	{ prefix: 'cat', suffix: '', ignoreCase: false },
	{ prefix: 'MOON', suffix: '', ignoreCase: true }, // the live-inventory shape
	{ prefix: '', suffix: 'z', ignoreCase: false }, // suffix only
	{ prefix: '', suffix: 'Az', ignoreCase: true },
	{ prefix: 'So', suffix: 'ana', ignoreCase: false }, // both ends
	{ prefix: 'I', suffix: '', ignoreCase: true }, // no valid uppercase form
];

const label = (v) => `${v.prefix || '-'}…${v.suffix || '-'}${v.ignoreCase ? ' (ci)' : ''}`;

describe('all three implementations agree on the exact model', () => {
	for (const v of VECTORS) {
		it(`agrees on ${label(v)}`, () => {
			const site = siteExpectedAttempts(v.prefix, v.suffix, v.ignoreCase);
			const sdk = sdkExpectedAttempts(v.prefix, v.suffix, v.ignoreCase);
			const mcp = mcpExpectedAttempts(v);
			// Relative comparison: these span 1e1 … 1e10, so an absolute epsilon
			// would be meaninglessly loose at the top and impossible at the bottom.
			expect(sdk / site).toBeCloseTo(1, 12);
			expect(mcp / site).toBeCloseTo(1, 12);
		});
	}

	it('agrees on the superseded v1 model too, so old receipts verify anywhere', () => {
		for (const v of VECTORS) {
			expect(sdkUniform(v.prefix, v.suffix, v.ignoreCase)).toBeCloseTo(
				siteUniform(v.prefix, v.suffix, v.ignoreCase),
				9,
			);
		}
	});

	it('uses identical model identifiers, so dispatch cannot silently diverge', () => {
		expect(SDK_DIFFICULTY_MODEL).toBe(DIFFICULTY_MODEL);
		expect(SDK_DIFFICULTY_MODEL_V1).toBe(DIFFICULTY_MODEL_V1);
	});

	it('dispatches to the same function for a given model id', () => {
		for (const model of [DIFFICULTY_MODEL, DIFFICULTY_MODEL_V1, undefined]) {
			expect(sdkDifficultyModel(model)('cat', '', false)).toBeCloseTo(
				siteDifficultyModel(model)('cat', '', false),
				6,
			);
		}
	});

	it('agrees across the entire alphabet, not just the sampled vectors', () => {
		for (const ch of BASE58_ALPHABET) {
			const site = 1 / sitePrefixProbability(ch);
			expect(sdkExpectedAttempts(ch, '', false) / site).toBeCloseTo(1, 12);
			expect(mcpExpectedAttempts({ prefix: ch }) / site).toBeCloseTo(1, 12);
		}
	});
});

describe('the correction is not cosmetic', () => {
	it('differs from the superseded model by more than a rounding error', () => {
		// If these ever coincide, someone has quietly reverted the model.
		expect(siteExpectedAttempts('z', '', false) / siteUniform('z', '', false)).toBeGreaterThan(15);
		expect(siteExpectedAttempts('A', '', false) / siteUniform('A', '', false)).toBeLessThan(0.35);
	});
});
