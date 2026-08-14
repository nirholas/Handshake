// Coverage for api/_lib/news-curation.js — the editorial display gate.
//
// The contract this protects: a crypto-native source always shows; a broad /
// mixed source (WSJ, Seeking Alpha, a world-news desk) shows an article ONLY if
// that article is itself about crypto; and a scored source below the credibility
// floor is dropped. It is a DISPLAY filter — ingestion is unaffected, which is
// asserted separately against getNews.

import { describe, it, expect } from 'vitest';

const { isCryptoRelevant, passesQualityFloor, isDisplayable, DEFAULT_MIN_CREDIBILITY } =
	await import('../api/_lib/news-curation.js');
const { NEWS_SOURCES } = await import('../api/_lib/news-sources.js');

// Anchor the tests to real registry keys so a category rename can't silently
// make them vacuous.
const NATIVE_KEY = 'coindesk'; // general, crypto-native
const BROAD_KEY = 'seekingalpha'; // mainstream, mixed content
const REG_KEY = 'sec_press'; // geopolitical, mixed content (regulator)

describe('registry assumptions', () => {
	it('the anchor sources exist and are the categories the tests assume', () => {
		expect(NEWS_SOURCES[NATIVE_KEY]?.category).toBe('general');
		expect(NEWS_SOURCES[BROAD_KEY]).toBeTruthy();
		expect(NEWS_SOURCES[BROAD_KEY].category).not.toBe('general');
	});
});

describe('isCryptoRelevant', () => {
	it('passes any article from a crypto-native source, even an off-topic-looking title', () => {
		expect(isCryptoRelevant({ source_key: NATIVE_KEY, title: 'Governance drama at a foundation' })).toBe(true);
	});

	it('passes a broad-source article that is about crypto (by keyword)', () => {
		expect(isCryptoRelevant({ source_key: BROAD_KEY, title: 'Ethereum staking yields climb after upgrade' })).toBe(true);
	});

	it('passes a broad-source article that carries a detected ticker', () => {
		expect(isCryptoRelevant({ source_key: BROAD_KEY, title: 'A quiet week', tickers: ['BTC'] })).toBe(true);
	});

	it('drops a broad-source article with no crypto signal', () => {
		expect(isCryptoRelevant({ source_key: BROAD_KEY, title: '3M stock jumps on raised outlook', tickers: [] })).toBe(false);
		expect(isCryptoRelevant({ source_key: BROAD_KEY, title: 'Ryanair broken window may have been caused by foreign object' })).toBe(false);
	});

	it('passes a regulator story about crypto, drops its non-crypto business', () => {
		expect(isCryptoRelevant({ source_key: REG_KEY, title: 'SEC charges firm over unregistered token sale' })).toBe(true);
		expect(isCryptoRelevant({ source_key: REG_KEY, title: 'Commission adopts new proxy voting rule' })).toBe(false);
	});

	it('matches on the description when the title is neutral', () => {
		expect(isCryptoRelevant({ source_key: BROAD_KEY, title: 'Markets today', description: 'Bitcoin led gains as the DeFi sector rebounded.' })).toBe(true);
	});

	it('does not misfire on generic finance words', () => {
		expect(isCryptoRelevant({ source_key: BROAD_KEY, title: 'Inflation cools, stocks rally, GDP revised up' })).toBe(false);
	});

	// Regression: the lexicon was matched as raw substrings, so "defi" fired
	// inside "defied" and three Economic Times equities headlines led the crypto
	// feed and the daily digest. Every entry here is an ordinary English word
	// that contains a lexicon term but is not about crypto.
	it('does not match a lexicon term buried inside an ordinary word', () => {
		const notCrypto = [
			'FIIs dumped nearly Rs 1 lakh crore worth of these 10 stocks but 8 defied the selloff',
			'Budget deficit widens as spending climbs',
			'The definition of a recession is contested',
			'Protesters show defiance outside parliament',
			'Whether the Fed cuts in September is still unclear',
			'Together, the two firms employ 40,000 people',
		];
		for (const title of notCrypto) {
			expect(isCryptoRelevant({ source_key: BROAD_KEY, title, tickers: [] })).toBe(false);
		}
	});

	// The other half of the same change: whole-word matching must not start
	// dropping real crypto coverage, including the prefix families and the
	// hyphenated compounds the beat is written in.
	it('still matches whole words, prefix families, plurals, and hyphenated compounds', () => {
		const crypto = [
			'Cryptocurrency exchange volumes surge',
			'Cryptoassets draw institutional flows',
			'Tokenized treasuries pass $5B',
			'Blockchain-based settlement goes live',
			'Wallet-to-wallet transfers are now instant',
			'DAOs vote on a treasury policy',
			'NFTs return to volume growth',
			'On-chain volume hits a record',
			'Tether clears its first KPMG audit',
			'USDC supply hits a record high',
		];
		for (const title of crypto) {
			expect(isCryptoRelevant({ source_key: BROAD_KEY, title, tickers: [] })).toBe(true);
		}
	});

	it('falls back to the content test for an unknown source key', () => {
		expect(isCryptoRelevant({ source_key: 'not_in_registry', title: 'Bitcoin surges' })).toBe(true);
		expect(isCryptoRelevant({ source_key: 'not_in_registry', title: 'A weather report' })).toBe(false);
	});

	it('is null-safe', () => {
		expect(isCryptoRelevant(null)).toBe(false);
		expect(isCryptoRelevant({})).toBe(false);
	});
});

describe('passesQualityFloor', () => {
	it('drops a scored source below the floor', () => {
		// Fabricate a below-floor article by pointing at a real low-cred source
		// only if one exists; otherwise assert the mechanism directly.
		const belowKey = Object.keys(NEWS_SOURCES).find((k) => typeof NEWS_SOURCES[k].credibility === 'number' && NEWS_SOURCES[k].credibility < DEFAULT_MIN_CREDIBILITY);
		if (belowKey) {
			expect(passesQualityFloor({ source_key: belowKey })).toBe(false);
		}
		// And with an explicit high floor, a mid-cred source fails.
		expect(passesQualityFloor({ source_key: 'coindesk' }, 0.99)).toBe(false);
	});

	it('passes a scored source at or above the floor', () => {
		expect(passesQualityFloor({ source_key: 'coindesk' })).toBe(true); // 0.95
	});

	it('presumes an unscored registry source is acceptable', () => {
		const unscored = Object.keys(NEWS_SOURCES).find((k) => NEWS_SOURCES[k].credibility == null);
		expect(passesQualityFloor({ source_key: unscored })).toBe(true);
	});

	it('never drops an article whose source is not in the registry', () => {
		expect(passesQualityFloor({ source_key: 'legacy_archive_row' })).toBe(true);
	});
});

describe('isDisplayable (combined gate)', () => {
	it('needs BOTH relevance and quality', () => {
		// Crypto but below an aggressive floor → dropped.
		expect(isDisplayable({ source_key: 'coindesk', title: 'Bitcoin news' }, { minCredibility: 0.99 })).toBe(false);
		// Above floor but off-topic from a broad source → dropped.
		expect(isDisplayable({ source_key: BROAD_KEY, title: '3M stock jumps' })).toBe(false);
		// Crypto-native + scored fine → shown.
		expect(isDisplayable({ source_key: 'coindesk', title: 'anything' })).toBe(true);
	});

	it('honours a runtime floor override', () => {
		const a = { source_key: 'coindesk', title: 'Bitcoin' }; // cred 0.95
		expect(isDisplayable(a, { minCredibility: 0.9 })).toBe(true);
		expect(isDisplayable(a, { minCredibility: 0.96 })).toBe(false);
	});
});
