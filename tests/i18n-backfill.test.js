/**
 * i18n backfill, unit tests.
 *
 * The backfill exists because `i18n:translate` only fills keys that are MISSING.
 * When the translation backend is unreachable the pipeline bakes the English
 * source into the locale, and because those keys are then present, every later
 * run skips them: the language reads as English forever while lint stays green.
 * The backfill clears those values so the translator sees them as missing again.
 *
 * Clearing keys out of a shipped catalog is the risky half, so these tests pin
 * the two properties that make it safe:
 *   1. it only removes values that are genuinely untranslated (byte-identical to
 *      English AND multi-word), never a real translation and never a single word
 *      that legitimately matches ("Avatar", "Solana", "3D");
 *   2. it is structure-preserving and idempotent: nothing else in the catalog
 *      moves, and a second pass over pruned output is a no-op.
 */

import { describe, expect, it } from 'vitest';

import {
	flatten,
	prune,
	translatableWords,
	translatingLocales,
	untranslated,
} from '../scripts/i18n-backfill.mjs';

describe('flatten', () => {
	it('maps a nested catalog to dot paths', () => {
		expect(flatten({ a: { b: 'x' }, c: 'y' })).toEqual({ 'a.b': 'x', c: 'y' });
	});

	it('ignores values that are not strings', () => {
		expect(flatten({ n: 1, ok: true, s: 'keep', nested: { z: null } })).toEqual({ s: 'keep' });
	});

	it('tolerates a missing catalog', () => {
		expect(flatten(null)).toEqual({});
	});
});

describe('untranslated', () => {
	it('flags a multi-word phrase identical to English', () => {
		expect(untranslated('Sign in with your wallet', 'Sign in with your wallet')).toBe(true);
	});

	it('leaves a real translation alone', () => {
		expect(untranslated('Mit Wallet anmelden', 'Sign in with your wallet')).toBe(false);
	});

	// A single word matching English is usually correct, and re-translating it
	// risks replacing a right answer with a worse one.
	it('leaves a single word alone even when identical', () => {
		expect(untranslated('Avatar', 'Avatar')).toBe(false);
		expect(untranslated('Solana', 'Solana')).toBe(false);
		expect(untranslated('3D', '3D')).toBe(false);
	});

	it('ignores keys the source does not have', () => {
		expect(untranslated('anything at all', undefined)).toBe(false);
	});
});

describe('prune', () => {
	const english = {
		nav: { home: 'Home', signIn: 'Sign in with your wallet' },
		hero: { title: 'Build an agent in minutes' },
		brand: { name: 'three.ws' },
	};

	it('drops baked English but keeps real translations', () => {
		const locale = {
			nav: { home: 'Home', signIn: 'Sign in with your wallet' },
			hero: { title: 'Baue in Minuten einen Agenten' },
			brand: { name: 'three.ws' },
		};
		expect(prune(locale, english)).toEqual({
			// nav.signIn was the baked phrase and is gone; nav.home is one word,
			// so it stays even though it matches.
			nav: { home: 'Home' },
			hero: { title: 'Baue in Minuten einen Agenten' },
			brand: { name: 'three.ws' },
		});
	});

	it('removes a branch that is emptied, rather than leaving {}', () => {
		const locale = { hero: { title: 'Build an agent in minutes' } };
		expect(prune(locale, english)).toEqual({});
	});

	it('is idempotent: a second pass changes nothing', () => {
		const locale = {
			nav: { home: 'Home', signIn: 'Sign in with your wallet' },
			hero: { title: 'Baue in Minuten einen Agenten' },
		};
		const once = prune(locale, english);
		expect(prune(once, english)).toEqual(once);
	});

	it('keeps a locale that needs no repair byte-identical', () => {
		const clean = {
			nav: { home: 'Startseite', signIn: 'Mit Wallet anmelden' },
			hero: { title: 'Baue in Minuten einen Agenten' },
		};
		expect(prune(clean, english)).toEqual(clean);
	});

	it('never invents keys the locale did not have', () => {
		const sparse = { hero: { title: 'Baue in Minuten einen Agenten' } };
		expect(Object.keys(prune(sparse, english))).toEqual(['hero']);
	});

	it('passes non-string values through untouched', () => {
		expect(prune({ count: 3, flag: false }, {})).toEqual({ count: 3, flag: false });
	});
});

describe('translatingLocales', () => {
	const PS = [
		'/usr/bin/node /repo/scripts/i18n-translate.mjs --locale=de --concurrency=8',
		'/usr/bin/node /repo/scripts/i18n-translate.mjs --repair --locale=he',
		'/usr/bin/node /repo/scripts/i18n-extract.mjs',
		'grep --color i18n-translate.mjs',
	].join('\n');

	it('reads the locales other translate processes are writing', () => {
		expect(translatingLocales(PS)).toEqual(new Set(['de', 'he']));
	});

	it('ignores lines that are not a translate run', () => {
		expect(translatingLocales('node /repo/scripts/i18n-backfill.mjs --locale=fr')).toEqual(new Set());
	});

	it('returns nothing when no run is active, so the backfill is not blocked', () => {
		expect(translatingLocales('')).toEqual(new Set());
	});
});

describe('translatableWords', () => {
	const GLOSSARY = ['three.ws', 'USDC', 'Solana', 'MCP'];

	it('discounts brand terms, leaving too little to call a translation', () => {
		// Not zero necessarily: what matters is that fewer than two real words
		// survive, which is the threshold `untranslated` uses.
		expect(translatableWords('three.ws 3D API', GLOSSARY).length).toBeLessThan(2);
		expect(translatableWords('USDC (Solana)', GLOSSARY)).toHaveLength(0);
	});

	it('discounts markup, entities, numbers and URLs', () => {
		expect(translatableWords('<b id="ad-rewards">0</b> SOL')).toEqual(['SOL']);
		expect(translatableWords('OpenAPI 3.1')).toEqual(['OpenAPI']);
		expect(translatableWords('SDP &middot; platform.solana.com')).toEqual(['SDP']);
	});

	it('keeps the real words of a genuine sentence', () => {
		expect(translatableWords('Sign in with your wallet to continue', GLOSSARY)).toEqual([
			'Sign', 'in', 'with', 'your', 'wallet', 'to', 'continue',
		]);
	});
});

describe('untranslated: strings that correctly stay English', () => {
	const GLOSSARY = ['three.ws', 'USDC', 'Solana'];
	// Each of these matches English in every language. Flagging them would clear
	// and re-translate the same bytes on every run, forever.
	const KEEP = [
		'three.ws 3D API',
		'OpenAPI 3.1',
		'USDC (Solana)',
		'\u00a9 2026 three.ws',
		'A \u2192 Z',
		'<b id="ad-rewards">0</b> SOL',
	];

	for (const value of KEEP) {
		it(`leaves ${JSON.stringify(value)} alone`, () => {
			expect(untranslated(value, value, GLOSSARY)).toBe(false);
		});
	}

	it('still flags a real sentence that never got translated', () => {
		const phrase = 'Your avatar speaks sign language';
		expect(untranslated(phrase, phrase, GLOSSARY)).toBe(true);
	});

	it('keeps a brand-heavy string out of prune', () => {
		const en = { footer: { copy: '\u00a9 2026 three.ws', cta: 'Start building today' } };
		expect(prune(en, en, GLOSSARY)).toEqual({ footer: { copy: '\u00a9 2026 three.ws' } });
	});
});
