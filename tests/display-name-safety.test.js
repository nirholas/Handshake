// api/_lib/display-name-safety.js — hate-slur gate for third-party indexed text.
//
// The ERC-8004 crawler renders display names pulled straight from attacker-controlled
// on-chain metadata. Whether a row appeared on three.ws used to be decided by the
// agent's own `meta.active` flag, so a Base-registered agent whose name was a racial
// slur was active, `has_3d`, and rendered on /marketplace.
//
// Two failure modes matter equally:
//   1. A slur slips through (the bug this closes), including obvious evasions.
//   2. A false positive silently delists a legitimate third-party agent.
// Both are pinned below.
//
// The offending strings are constructed from character codes rather than written out,
// so this file does not itself contain the slurs it guards against.

import { describe, it, expect } from 'vitest';
import { containsHateSlur, matchedSlurStem, normalizeForSlurMatch } from '../api/_lib/display-name-safety.js';

// Build a term without writing it literally.
const S = (...codes) => String.fromCharCode(...codes);
const N_WORD = S(110, 105, 103, 103, 101, 114); // n-word, "-er"
const N_WORD_A = S(110, 105, 103, 103, 97); // n-word, "-a"
const F_SLUR = S(102, 97, 103, 103, 111, 116);
const T_SLUR = S(116, 114, 97, 110, 110, 121);

describe('normalizeForSlurMatch', () => {
	it('folds case and leetspeak', () => {
		expect(normalizeForSlurMatch('N1GG3R')).toBe(N_WORD);
		expect(normalizeForSlurMatch('F@GGOT')).toBe(F_SLUR);
	});

	it('collapses long repeated runs to two', () => {
		expect(normalizeForSlurMatch('niiiiigger')).toContain(S(110, 105, 105, 103, 103));
	});

	it('is empty for nullish input', () => {
		expect(normalizeForSlurMatch(null)).toBe('');
		expect(normalizeForSlurMatch(undefined)).toBe('');
		expect(normalizeForSlurMatch('')).toBe('');
	});

	it('symbol-only text can never reach a stem', () => {
		expect(containsHateSlur('123 !!! 🚀')).toBe(false);
		expect(containsHateSlur('!!!!!!!!!!')).toBe(false);
		expect(containsHateSlur('@@@@ $$$$ 0000')).toBe(false);
	});
});

describe('containsHateSlur — catches the real thing and its evasions', () => {
	it('catches the exact name that shipped to /marketplace', () => {
		expect(containsHateSlur(`Real Hood ${N_WORD} Shit`)).toBe(true);
	});

	it('catches slurs regardless of case, leet, and separators', () => {
		for (const variant of [
			N_WORD.toUpperCase(),
			`  ${N_WORD_A}  `,
			F_SLUR,
			T_SLUR,
			'N1GG3R',
			'f@ggot',
			'n.i.g.g.a',
			`token ${F_SLUR.toUpperCase()} coin`,
		]) {
			expect(containsHateSlur(variant), JSON.stringify(variant)).toBe(true);
		}
	});

	it('reports which stem matched, for logging', () => {
		expect(matchedSlurStem(`x ${F_SLUR} y`)).toBe(F_SLUR);
		expect(matchedSlurStem('perfectly fine agent')).toBeNull();
	});
});

describe('containsHateSlur — never delists a legitimate agent', () => {
	it('passes ordinary agent and token names', () => {
		for (const ok of [
			'Real Hood Trading Bot',
			'Base Agent #4211',
			'Autonomous Yield Optimizer',
			'DeFi Sentinel',
			'agent.eth',
			'🤖 Market Maker',
			'',
			null,
			undefined,
		]) {
			expect(containsHateSlur(ok), JSON.stringify(ok)).toBe(false);
		}
	});

	it('does not fire on benign superstrings of a stem', () => {
		// Whole-word matching is what makes these safe: substring matching flags them.
		for (const ok of ['Raccoon Finance', 'Cocoon Protocol', 'Tycoon DAO', 'raccoon', 'Coonhound Capital']) {
			expect(containsHateSlur(ok), ok).toBe(false);
		}
	});

	// These are the ACTUAL names of live, legitimate on-chain agents that a naive
	// substring + global-leet matcher flagged. Each one would have been silently
	// delisted. They are the regression suite for precision.
	it('does not delist the real agents an earlier matcher wrongly flagged', () => {
		for (const ok of [
			'kikel-jina69 by Olas', // substring "kike" inside a generated name
			'Pick5 Scout', // "5"→"s" folding produced a bogus stem
			'Surf AI for 0x2666ccb276dbf6fe71f73d026e0db021a01ad4c0', // hex → letter soup
			'Surf AI for 0xb13591631ed10b40ce6d8e1ec8eba80b9d2ac606',
			'Surf AI for 0xdb6b887289c380648db6b6ab32d37f47e032a6c0',
			'quench',
		]) {
			expect(containsHateSlur(ok), ok).toBe(false);
		}
	});

	it('never manufactures a match out of an address or long hash', () => {
		// Fold 0x…→letters and a long enough run contains almost any short stem.
		const addrs = [
			'0xdb6b887289c380648db6b6ab32d37f47e032a6c0',
			'agent for 0xc0000000000000000000000000000000000000ee',
			'tx 0x9e5c1f0aa3b7d84e6c2f19b0d7a4e83c5f61b29d0e4a7c8b3f5d6e1a2b9c4d70',
		];
		for (const a of addrs) expect(containsHateSlur(a), a).toBe(false);
	});

	it('is not a general profanity filter — crude names still pass', () => {
		// Agent/coin names are crude by nature; blocking them is not our business
		// and would delist legitimate on-chain identities.
		for (const ok of ['Shit Coin Index', 'Damn Good Agent', 'Hell Yeah Bot', 'Assassin Protocol', 'Scunthorpe DAO']) {
			expect(containsHateSlur(ok), ok).toBe(false);
		}
	});

	it('does not fire on "spice"/"spicy" (why the list uses the longer stem)', () => {
		expect(containsHateSlur('Spicy Trades')).toBe(false);
		expect(containsHateSlur('Spice DAO')).toBe(false);
	});
});

describe('the crawler applies the gate', () => {
	it('hydration withholds a slur row instead of trusting meta.active', async () => {
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const src = readFileSync(resolve(__dirname, '../api/cron/[name].js'), 'utf8');
		// active must depend on the gate, not on attacker-supplied meta.active alone.
		expect(src).toMatch(/const active = meta\.active !== false && !slur;/);
		expect(src).toMatch(/matchedSlurStem\(`\$\{name\} \$\{description\}`\)/);
		expect(src).toMatch(/from '\.\.\/_lib\/display-name-safety\.js'/);
	});
});
