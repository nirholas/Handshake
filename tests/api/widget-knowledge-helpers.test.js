// Unit tests for the pure helpers behind the widget-knowledge + transcripts
// features. No DB, no network — these guarantee the chunker, redactor,
// cosine + id helpers behave the way the chat/knowledge routes assume.

import { describe, it, expect } from 'vitest';

import { chunk, estimateTokens } from '../../api/_lib/chunker.js';
import { redactPii } from '../../api/_lib/pii.js';
import { cosine } from '../../api/_lib/embeddings.js';
import { shortId, isShortId } from '../../api/_lib/ids.js';

describe('chunker', () => {
	it('returns one chunk for short text', () => {
		const out = chunk('hello world');
		expect(out).toHaveLength(1);
		expect(out[0].content).toBe('hello world');
		expect(out[0].token_count).toBeGreaterThan(0);
	});

	it('produces multiple overlapping chunks for long text', () => {
		const para = 'Sentence one is here. ' + 'Sentence two follows. '.repeat(400);
		const out = chunk(para);
		expect(out.length).toBeGreaterThan(1);
		// All chunks under ~the 512-token cap (chars / 4 ≈ tokens, with a
		// little headroom for sentence-boundary slop).
		for (const c of out) {
			expect(c.token_count).toBeLessThanOrEqual(640);
		}
	});

	it('normalizes runs of whitespace', () => {
		const out = chunk('a\r\n\r\n\r\nb  c\t\td');
		expect(out[0].content).toMatch(/^a\n\nb c {0,2}d$/);
	});

	it('returns empty for empty input', () => {
		expect(chunk('')).toEqual([]);
		expect(chunk('   ')).toEqual([]);
	});

	it('estimateTokens scales with length', () => {
		expect(estimateTokens('abcd'.repeat(100))).toBe(100);
		expect(estimateTokens('')).toBe(0);
	});
});

describe('pii redactor', () => {
	it('replaces email addresses', () => {
		const { content, redacted } = redactPii('reach me at alice@example.com please');
		expect(redacted).toBe(true);
		expect(content).toBe('reach me at [email] please');
	});

	it('replaces credit card numbers', () => {
		const { content, redacted } = redactPii('card is 4111 1111 1111 1111 right?');
		expect(redacted).toBe(true);
		expect(content).toContain('[card]');
	});

	it('replaces api keys', () => {
		const { content, redacted } = redactPii('use sk_live_abc123xyz456 to call');
		expect(redacted).toBe(true);
		expect(content).toContain('[key]');
	});

	it('leaves clean text untouched', () => {
		const { content, redacted } = redactPii('hello world');
		expect(redacted).toBe(false);
		expect(content).toBe('hello world');
	});

	it('handles null safely', () => {
		const { content, redacted } = redactPii(null);
		expect(redacted).toBe(false);
		expect(content).toBe('');
	});
});

describe('cosine similarity', () => {
	it('returns 1 for identical vectors', () => {
		const v = [0.1, 0.2, 0.3, 0.4];
		expect(cosine(v, v)).toBeCloseTo(1, 6);
	});

	it('returns 0 for orthogonal vectors', () => {
		expect(cosine([1, 0], [0, 1])).toBe(0);
	});

	it('returns 0 when either side is zero-length', () => {
		expect(cosine([0, 0], [1, 1])).toBe(0);
		expect(cosine([1, 1], [0, 0])).toBe(0);
	});

	it('handles plain arrays from JSONB and Float64Arrays interchangeably', () => {
		const a = [1, 2, 3];
		const b = Float64Array.from([1, 2, 3]);
		expect(cosine(a, b)).toBeCloseTo(1, 6);
	});
});

describe('shortId', () => {
	it('mints prefixed url-safe ids', () => {
		const id = shortId('wkd');
		expect(id.startsWith('wkd_')).toBe(true);
		expect(isShortId(id, 'wkd')).toBe(true);
		expect(id).toMatch(/^wkd_[A-Za-z0-9_-]+$/);
	});

	it('two calls produce different ids', () => {
		expect(shortId('x')).not.toBe(shortId('x'));
	});

	it('isShortId rejects mismatched prefixes', () => {
		const id = shortId('a');
		expect(isShortId(id, 'b')).toBe(false);
		expect(isShortId('garbage', 'a')).toBe(false);
		expect(isShortId(null, 'a')).toBe(false);
	});
});
