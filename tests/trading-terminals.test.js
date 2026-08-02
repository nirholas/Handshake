import { describe, it, expect } from 'vitest';
import {
	REFERRAL_CODES,
	TERMINAL_LABELS,
	gmgnTokenUrl,
	gmgnAddressUrl,
	axiomTokenUrl,
	padreTokenUrl,
	fomoTokenUrl,
	referralUrl,
	referralOffers,
	terminalLinks,
} from '../src/shared/trading-terminals.js';

// $THREE, the platform's own coin, as the sample mint.
const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const WALLET = '7rpqjHdf1111111111111111111111111111111111';

describe('referral codes', () => {
	// These four strings are the whole point of the module. A silent edit here
	// costs real referral revenue with no visible symptom, so pin them exactly.
	it('are the configured codes', () => {
		expect(REFERRAL_CODES).toEqual({
			gmgn: 'nichxbt',
			axiom: 'nich',
			padre: 'nichxbt',
			fomo: 'nichxbt',
		});
	});

	it('produces the documented signup link per terminal', () => {
		expect(referralUrl('gmgn')).toBe('https://gmgn.ai/r/nichxbt');
		expect(referralUrl('axiom')).toBe('https://axiom.trade/@nich');
		expect(referralUrl('padre')).toBe('https://trade.padre.gg/rk/nichxbt');
		expect(referralUrl('fomo')).toBe('https://fomo.family/r/nichxbt');
	});

	it('returns null for a terminal it does not know', () => {
		expect(referralUrl('bullx')).toBeNull();
		expect(referralUrl('')).toBeNull();
	});
});

describe('GMGN deep links carry the referral inline', () => {
	// GMGN documents {chain}/token/{code}_{contract}, so the referral and the
	// deep link travel together. If this stops matching, we are linking GMGN
	// for free.
	it('embeds the code in the token path', () => {
		expect(gmgnTokenUrl(MINT)).toBe(`https://gmgn.ai/sol/token/nichxbt_${MINT}`);
	});

	it('embeds the code in the address path', () => {
		expect(gmgnAddressUrl(WALLET)).toBe(`https://gmgn.ai/sol/address/nichxbt_${WALLET}`);
	});

	it('maps chains to GMGN slugs, defaulting to sol', () => {
		expect(gmgnAddressUrl('0xabc', 'bsc')).toContain('/bsc/address/');
		expect(gmgnAddressUrl('0xabc', 'ethereum')).toContain('/sol/address/');
		expect(gmgnTokenUrl(MINT, 'bsc')).toContain('/bsc/token/');
	});

	it('keeps the underscore separator unescaped so GMGN can split it', () => {
		const url = gmgnTokenUrl(MINT);
		expect(url).toContain(`nichxbt_${MINT}`);
		expect(url).not.toContain('%5F');
	});
});

describe('terminals with no documented deep-link referral', () => {
	// Axiom, Padre and FOMO document a signup-link referral only. The token deep
	// link deliberately wins over the referral on these. Asserting the absence
	// stops a future edit from bolting on an invented ?ref= parameter.
	it('links straight to the token with no referral parameter', () => {
		for (const url of [axiomTokenUrl(MINT), padreTokenUrl(MINT), fomoTokenUrl(MINT)]) {
			expect(url).toContain(MINT);
			expect(url).not.toContain('ref=');
			expect(url).not.toContain('nichxbt');
		}
	});

	it('uses the token-page host each terminal actually serves', () => {
		expect(axiomTokenUrl(MINT)).toBe(`https://axiom.trade/meme/${MINT}`);
		expect(padreTokenUrl(MINT)).toBe(`https://trade.padre.gg/trade/solana/${MINT}`);
		expect(fomoTokenUrl(MINT)).toBe(`https://fomo.family/token/${MINT}`);
	});
});

describe('referralOffers', () => {
	it('offers exactly the terminals that cannot carry a referral inline', () => {
		expect(referralOffers().map((o) => o.key)).toEqual(['axiom', 'padre', 'fomo']);
	});

	it('excludes GMGN, whose deep links already carry the code', () => {
		expect(referralOffers().some((o) => o.key === 'gmgn')).toBe(false);
	});

	it('gives every offer a label and a resolvable url', () => {
		for (const offer of referralOffers()) {
			expect(offer.label).toBe(TERMINAL_LABELS[offer.key]);
			expect(offer.url).toBe(referralUrl(offer.key));
			expect(offer.url.startsWith('https://')).toBe(true);
		}
	});
});

describe('terminalLinks', () => {
	it('covers every terminal with a label, short code and url', () => {
		const links = terminalLinks(MINT);
		expect(links.map((t) => t.key)).toEqual(['axiom', 'gmgn', 'padre', 'fomo']);
		for (const t of links) {
			expect(t.label).toBe(TERMINAL_LABELS[t.key]);
			expect(t.short).toHaveLength(3);
			expect(t.url).toContain(MINT);
		}
	});

	it('routes only GMGN through the referral', () => {
		const withCode = terminalLinks(MINT).filter((t) => t.url.includes('nichxbt'));
		expect(withCode.map((t) => t.key)).toEqual(['gmgn']);
	});

	it('escapes a mint containing url-unsafe characters', () => {
		const links = terminalLinks('abc/def?x=1');
		for (const t of links) {
			expect(t.url).toContain('abc%2Fdef%3Fx%3D1');
		}
	});
});
