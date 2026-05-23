// api/_lib/threews-sns.js — pure-function tests for the API-side facade over
// the canonical SNS-subdomain helper. We avoid touching Solana or the
// database; everything tested here is local-only.

import { describe, it, expect, beforeAll } from 'vitest';

// Set the parent domain env var before the module is imported so PARENT_LABEL
// derives from a predictable value. Without this, the tests would depend on
// whatever the shell happened to export.
beforeAll(() => {
	process.env.THREEWS_SOL_PARENT_DOMAIN = 'threews.sol';
});

const mod = await import('../../api/_lib/threews-sns.js');

describe('PARENT_LABEL', () => {
	it('derives from THREEWS_SOL_PARENT_DOMAIN without the .sol suffix', () => {
		expect(mod.PARENT_LABEL).toBe('threews');
	});
});

describe('fullDomain()', () => {
	it('appends the parent + .sol suffix', () => {
		expect(mod.fullDomain('nich')).toBe('nich.threews.sol');
		expect(mod.fullDomain('a')).toBe('a.threews.sol');
	});
});

describe('normalizeLabel()', () => {
	it('lowercases and trims valid labels', () => {
		expect(mod.normalizeLabel('Nich')).toBe('nich');
		expect(mod.normalizeLabel('  vernington  ')).toBe('vernington');
	});

	it('accepts digits and hyphens in the middle', () => {
		expect(mod.normalizeLabel('agent-007')).toBe('agent-007');
		expect(mod.normalizeLabel('a1b2c3')).toBe('a1b2c3');
	});

	it('strips a .sol suffix if the user pasted the whole name', () => {
		expect(mod.normalizeLabel('nich.sol')).toBe('nich');
	});

	it('rejects empty input', () => {
		expect(mod.normalizeLabel('')).toBeNull();
		expect(mod.normalizeLabel(null)).toBeNull();
		expect(mod.normalizeLabel(undefined)).toBeNull();
	});

	it('rejects labels with disallowed characters', () => {
		expect(mod.normalizeLabel('nich!')).toBeNull();
		expect(mod.normalizeLabel('nich.foo')).toBeNull();
		expect(mod.normalizeLabel('nich foo')).toBeNull();
		expect(mod.normalizeLabel('niçh')).toBeNull();
	});

	it('rejects leading or trailing hyphens', () => {
		expect(mod.normalizeLabel('-nich')).toBeNull();
		expect(mod.normalizeLabel('nich-')).toBeNull();
		expect(mod.normalizeLabel('-')).toBeNull();
	});

	it('rejects labels longer than 63 characters', () => {
		const sixtyThree = 'a'.repeat(63);
		const sixtyFour = 'a'.repeat(64);
		expect(mod.normalizeLabel(sixtyThree)).toBe(sixtyThree);
		expect(mod.normalizeLabel(sixtyFour)).toBeNull();
	});

	it('rejects reserved app-path labels regardless of case', () => {
		// Sampling the denylist — these would otherwise pass the regex but get
		// stopped by the reserved-word set in the API-side facade.
		for (const reserved of ['admin', 'root', 'api', 'www', 'threews', 'claude', 'login']) {
			expect(mod.normalizeLabel(reserved), `denylist should reject ${reserved}`).toBeNull();
			expect(mod.normalizeLabel(reserved.toUpperCase())).toBeNull();
		}
	});

	it('still accepts legitimate labels that merely contain a reserved substring', () => {
		// "admin-tools" contains "admin" but isn't on the denylist, so it passes.
		expect(mod.normalizeLabel('admin-tools')).toBe('admin-tools');
		expect(mod.normalizeLabel('claudette')).toBe('claudette');
	});
});

describe('hasOwnerKey()', () => {
	it('returns false when THREEWS_SOL_PARENT_SECRET_BASE58 is unset', () => {
		const saved = process.env.THREEWS_SOL_PARENT_SECRET_BASE58;
		delete process.env.THREEWS_SOL_PARENT_SECRET_BASE58;
		expect(mod.hasOwnerKey()).toBe(false);
		if (saved !== undefined) process.env.THREEWS_SOL_PARENT_SECRET_BASE58 = saved;
	});

	it('returns true when THREEWS_SOL_PARENT_SECRET_BASE58 is set', () => {
		const saved = process.env.THREEWS_SOL_PARENT_SECRET_BASE58;
		process.env.THREEWS_SOL_PARENT_SECRET_BASE58 = 'placeholder';
		expect(mod.hasOwnerKey()).toBe(true);
		if (saved === undefined) delete process.env.THREEWS_SOL_PARENT_SECRET_BASE58;
		else process.env.THREEWS_SOL_PARENT_SECRET_BASE58 = saved;
	});
});

describe('storefrontUrlForLabel()', () => {
	it('builds an /u/<label> URL on the configured storefront origin', () => {
		const saved = process.env.STOREFRONT_ORIGIN;
		process.env.STOREFRONT_ORIGIN = 'https://three.ws';
		expect(mod.storefrontUrlForLabel('nich')).toBe('https://three.ws/u/nich');
		// Special characters in the label are URL-encoded — defence in depth even
		// though normalizeLabel would already have rejected them.
		expect(mod.storefrontUrlForLabel('a b')).toBe('https://three.ws/u/a%20b');
		if (saved === undefined) delete process.env.STOREFRONT_ORIGIN;
		else process.env.STOREFRONT_ORIGIN = saved;
	});

	it('strips a trailing slash on the configured origin', () => {
		const saved = process.env.STOREFRONT_ORIGIN;
		process.env.STOREFRONT_ORIGIN = 'https://three.ws/';
		expect(mod.storefrontUrlForLabel('nich')).toBe('https://three.ws/u/nich');
		if (saved === undefined) delete process.env.STOREFRONT_ORIGIN;
		else process.env.STOREFRONT_ORIGIN = saved;
	});
});
