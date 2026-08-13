import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
	hasThreeWsMark,
	assertThreeWsMark,
	UnbrandedMintError,
	THREE_WS_VANITY,
	THREE_WS_MARK,
} from '../src/solana/vanity/brand.js';
import { grindVanityNode } from '../src/solana/vanity/grinder-node.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── hasThreeWsMark ─────────────────────────────────────────────────────────

describe('hasThreeWsMark', () => {
	it('true for 3ws... (lowercase prefix)', () => {
		expect(hasThreeWsMark('3wsABCDEFGHIJKLMNOPQRST')).toBe(true);
	});

	it('true for 3WS... (uppercase prefix)', () => {
		expect(hasThreeWsMark('3WSxyz12345678901234567')).toBe(true);
	});

	it('true for mixed-case 3wS...', () => {
		expect(hasThreeWsMark('3wSXYZ1234567890123456')).toBe(true);
	});

	it('false for x3ws... (mark not at position 0)', () => {
		expect(hasThreeWsMark('x3wsABCDEFG')).toBe(false);
	});

	it('false for empty string', () => {
		expect(hasThreeWsMark('')).toBe(false);
	});

	it('false for null', () => {
		expect(hasThreeWsMark(null)).toBe(false);
	});

	it('false for 2-char string (shorter than mark)', () => {
		expect(hasThreeWsMark('3w')).toBe(false);
	});

	it('false for undefined', () => {
		expect(hasThreeWsMark(undefined)).toBe(false);
	});

	it('false for a non-3ws address', () => {
		expect(hasThreeWsMark('MintPubkey1111111111111111111111111111')).toBe(false);
	});
});

// ── assertThreeWsMark ──────────────────────────────────────────────────────

describe('assertThreeWsMark', () => {
	it('throws UnbrandedMintError on an unbranded address', () => {
		expect(() => assertThreeWsMark('BadMintAddress111111111')).toThrow(UnbrandedMintError);
	});

	it('throws with code === unbranded_mint', () => {
		let caught;
		try {
			assertThreeWsMark('SomeOtherMint1111111111');
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeDefined();
		expect(caught.code).toBe('unbranded_mint');
		expect(caught.name).toBe('UnbrandedMintError');
	});

	it('throws on null', () => {
		expect(() => assertThreeWsMark(null)).toThrow(UnbrandedMintError);
	});

	it('throws on empty string', () => {
		expect(() => assertThreeWsMark('')).toThrow(UnbrandedMintError);
	});

	it('does not throw on a valid 3ws address', () => {
		expect(() => assertThreeWsMark('3wsValidMint111111111111111111111111')).not.toThrow();
	});

	it('does not throw on a 3WS-uppercase address', () => {
		expect(() => assertThreeWsMark('3WSValidMint111111111111111111111111')).not.toThrow();
	});
});

// ── THREE_WS_VANITY ────────────────────────────────────────────────────────

describe('THREE_WS_VANITY', () => {
	it('is frozen (cannot be mutated)', () => {
		expect(Object.isFrozen(THREE_WS_VANITY)).toBe(true);
	});

	it('prefix is "3ws" (the canonical mark)', () => {
		expect(THREE_WS_VANITY.prefix).toBe('3ws');
	});

	it('prefix equals THREE_WS_MARK', () => {
		expect(THREE_WS_VANITY.prefix).toBe(THREE_WS_MARK);
	});

	it('ignoreCase is true (keeps grind sub-second)', () => {
		expect(THREE_WS_VANITY.ignoreCase).toBe(true);
	});
});

// ── grindVanityNode with THREE_WS_VANITY ───────────────────────────────────
// Real CPU grind: sub-second for a 3-char case-insensitive prefix on an idle
// core, but this suite runs it alongside 1500+ other files, so the WASM thread
// may only see a fraction of a core. The grind budget must stay BELOW the test
// timeout: that way a slow box fails with GrindExhaustedError (which carries
// the attempt count and duration) instead of vitest's opaque wall-clock kill.

describe('grindVanityNode({ ...THREE_WS_VANITY })', () => {
	it('returns a publicKey that carries the three.ws mark', { timeout: 120_000 }, () => {
		const result = grindVanityNode({ ...THREE_WS_VANITY, timeBudgetMs: 90_000 });
		expect(typeof result.publicKey).toBe('string');
		expect(hasThreeWsMark(result.publicKey)).toBe(true);
		expect(result.secretKey).toBeInstanceOf(Uint8Array);
		expect(result.secretKey).toHaveLength(64);
		expect(result.attempts).toBeGreaterThan(0);
	});
});

// ── Regression guard ───────────────────────────────────────────────────────
// The literal '3ws' must live ONLY in brand.js. Any other file in src/ that
// hardcodes the mark string bypasses the single source of truth and will
// silently drift if the mark ever changes.

describe('regression: "3ws" literal belongs only in brand.js', () => {
	it("no file in src/ outside brand.js contains the string literal '3ws'", () => {
		let output = '';
		try {
			output = execSync(
				"grep -rl \"'3ws'\" src/ --include='*.js'",
				{ encoding: 'utf8', cwd: ROOT },
			).trim();
		} catch {
			output = '';
		}

		const files = output.split('\n').filter(Boolean);
		const outliers = files.filter((f) => !f.replace(/\\/g, '/').endsWith('solana/vanity/brand.js'));
		expect(
			outliers,
			`These src/ files hardcode '3ws' outside brand.js: ${outliers.join(', ')}`,
		).toHaveLength(0);
		// brand.js itself must contain the mark definition
		expect(files.some((f) => f.includes('brand.js'))).toBe(true);
	});
});
