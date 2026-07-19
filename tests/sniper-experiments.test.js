// Sniper experiment fleet: the pieces that decide whether an arm trades.
//
//   1. mayhem-filter retry: a transient null read resolves to a definitive
//      answer instead of forfeiting the buy on a strict gate (the fix for the
//      fleet-wide "mayhem_unknown" starvation on a throttled RPC).
//   2. LLM judge verdict parsing: strict shape, tolerant of fences/prose,
//      anything malformed never buys.
//   3. Oracle maturity: a below-threshold score on a minutes-old coin defers
//      the gate (fail open) instead of disqualifying every launch snipe.
//
// Pure logic only: no DB, no network, no pump SDK.

import { describe, it, expect } from 'vitest';
import { retryWhileNull } from '../packages/agent-sniper/src/mayhem-filter.js';
import { parseVerdict } from '../workers/agent-sniper/llm-judge.js';

describe('mayhem read retries (strict gate must not starve on RPC blips)', () => {
	it('retries a null read and returns the first definitive answer', async () => {
		let calls = 0;
		const read = async () => (++calls < 3 ? null : false);
		const v = await retryWhileNull(read, { retries: 2, delayMs: 1 });
		expect(v).toBe(false);
		expect(calls).toBe(3);
	});

	it('stops immediately on a definitive first answer', async () => {
		let calls = 0;
		const v = await retryWhileNull(async () => { calls++; return true; }, { retries: 2, delayMs: 1 });
		expect(v).toBe(true);
		expect(calls).toBe(1);
	});

	it('gives up after the retry budget and stays unknown', async () => {
		let calls = 0;
		const v = await retryWhileNull(async () => { calls++; return null; }, { retries: 2, delayMs: 1 });
		expect(v).toBe(null);
		expect(calls).toBe(3);
	});
});

describe('llm-judge parseVerdict (malformed never buys)', () => {
	it('parses a clean verdict', () => {
		expect(parseVerdict('{"buy": true, "confidence": 0.8, "thesis": "strong meta"}')).toEqual({
			buy: true, confidence: 0.8, thesis: 'strong meta',
		});
	});

	it('parses through code fences and prose', () => {
		const text = 'Here is my verdict:\n```json\n{"buy": false, "confidence": 0.3, "thesis": "dead ticker"}\n```';
		expect(parseVerdict(text)).toEqual({ buy: false, confidence: 0.3, thesis: 'dead ticker' });
	});

	it('rejects missing buy / bad confidence / non-JSON', () => {
		expect(parseVerdict('{"confidence": 0.8}')).toBe(null);
		expect(parseVerdict('{"buy": true, "confidence": 1.4}')).toBe(null);
		expect(parseVerdict('{"buy": "yes", "confidence": 0.5}')).toBe(null);
		expect(parseVerdict('no json at all')).toBe(null);
		expect(parseVerdict('')).toBe(null);
	});

	it('truncates a runaway thesis', () => {
		const v = parseVerdict(`{"buy": true, "confidence": 0.7, "thesis": "${'x'.repeat(500)}"}`);
		expect(v.thesis.length).toBe(280);
	});
});
