// Integrity coverage for api/_lib/news-sources.js — the crypto-news source
// registry. No network here: these assertions guard the registry's shape and
// the invariants the aggregator (api/_lib/news.js) relies on. Liveness is a
// separate, networked concern — see scripts/news-sources-probe.mjs.

import { describe, it, expect } from 'vitest';

const { NEWS_SOURCES, NEWS_CATEGORIES, NEWS_LANGUAGES, sourcesForCategory, sourcesForLanguage, sourcePriority } =
	await import('../api/_lib/news-sources.js');

const entries = Object.entries(NEWS_SOURCES);

describe('registry shape', () => {
	it('is substantial and every entry carries name, url, category', () => {
		expect(entries.length).toBeGreaterThan(150);
		for (const [key, src] of entries) {
			expect(key, `${key}: key must be snake_case`).toMatch(/^[a-z0-9_]+$/);
			expect(src.name, `${key}: name`).toBeTruthy();
			expect(src.category, `${key}: category`).toBeTruthy();
			expect(() => new URL(src.url), `${key}: url must parse`).not.toThrow();
			expect(new URL(src.url).protocol, `${key}: must be https`).toBe('https:');
		}
	});

	it('has no duplicate feed urls', () => {
		const seen = new Map();
		for (const [key, src] of entries) {
			const norm = src.url.replace(/\/+$/, '').toLowerCase();
			expect(seen.has(norm), `${key} duplicates ${seen.get(norm)}`).toBe(false);
			seen.set(norm, key);
		}
	});

	it('only uses categories declared in NEWS_CATEGORIES', () => {
		for (const [key, src] of entries) {
			expect(NEWS_CATEGORIES, `${key}: category "${src.category}"`).toContain(src.category);
		}
	});

	it('declares every category it lists', () => {
		const used = new Set(entries.map(([, s]) => s.category));
		for (const c of NEWS_CATEGORIES) expect(used, `category "${c}" has no sources`).toContain(c);
	});

	it('tags international feeds with a declared language', () => {
		for (const [key, src] of entries) {
			if (!src.language) continue;
			expect(NEWS_LANGUAGES, `${key}: language "${src.language}"`).toContain(src.language);
			expect(src.language, `${key}: ISO 639-1`).toMatch(/^[a-z]{2}$/);
		}
		// English feeds are the untagged default — never spelled out explicitly.
		expect(entries.filter(([, s]) => s.language === 'en')).toHaveLength(0);
	});
});

describe('hosts we must not regress onto', () => {
	// substack.com and mirror.xyz sit behind a Cloudflare bot challenge: every
	// feed on them answers 403 to server-side fetches, so they can never be
	// served from Cloud Run. They read as plausible sources, which is exactly
	// why this guard exists.
	it('lists no substack.com or mirror.xyz feeds', () => {
		const blocked = entries.filter(([, s]) => /(^|\.)(substack\.com|mirror\.xyz)$/.test(new URL(s.url).hostname));
		expect(blocked.map(([k]) => k)).toEqual([]);
	});

	it('lists no known parked domain', () => {
		const parked = entries.filter(([, s]) => new URL(s.url).hostname.replace(/^www\./, '') === 'legendarynames.com');
		expect(parked.map(([k]) => k)).toEqual([]);
	});
});

describe('non-RSS sources', () => {
	it('every kind:json source has an adapter in the aggregator', async () => {
		const jsonSources = entries.filter(([, s]) => s.kind === 'json').map(([k]) => k);
		if (!jsonSources.length) return;
		const src = await import('node:fs').then((fs) => fs.readFileSync('api/_lib/news.js', 'utf8'));
		for (const key of jsonSources) {
			expect(src, `JSON_ADAPTERS.${key} missing`).toContain(`${key}(data, key)`);
		}
	});

	it('marks only json sources with a kind', () => {
		for (const [key, src] of entries) {
			if (src.kind) expect(src.kind, `${key}`).toBe('json');
		}
	});
});

describe('sourcesForCategory', () => {
	it('returns every key for "all" and for no argument', () => {
		expect(sourcesForCategory('all')).toHaveLength(entries.length);
		expect(sourcesForCategory()).toHaveLength(entries.length);
	});

	it('filters to the requested category', () => {
		const defi = sourcesForCategory('defi');
		expect(defi.length).toBeGreaterThan(0);
		for (const k of defi) expect(NEWS_SOURCES[k].category).toBe('defi');
	});

	it('returns nothing for an unknown category', () => {
		expect(sourcesForCategory('does-not-exist')).toEqual([]);
	});
});

describe('sourcesForLanguage', () => {
	it('"en" selects exactly the untagged feeds', () => {
		const en = sourcesForLanguage('en');
		expect(en.length).toBeGreaterThan(0);
		for (const k of en) expect(NEWS_SOURCES[k].language).toBeUndefined();
	});

	it('selects tagged feeds by language', () => {
		for (const lang of NEWS_LANGUAGES) {
			const keys = sourcesForLanguage(lang);
			expect(keys.length, `no sources for ${lang}`).toBeGreaterThan(0);
			for (const k of keys) expect(NEWS_SOURCES[k].language).toBe(lang);
		}
	});

	it('"all" and no argument return everything', () => {
		expect(sourcesForLanguage('all')).toHaveLength(entries.length);
		expect(sourcesForLanguage()).toHaveLength(entries.length);
	});
});

describe('sourcePriority', () => {
	it('ranks every source into a finite band', () => {
		for (const [key] of entries) {
			const p = sourcePriority(key);
			expect(Number.isInteger(p), `${key}`).toBe(true);
			expect(p, `${key}`).toBeGreaterThanOrEqual(0);
			expect(p, `${key}`).toBeLessThanOrEqual(4);
		}
	});

	it('puts tier1 newsrooms ahead of the untiered long tail', () => {
		const tier1 = entries.filter(([, s]) => s.tier === 'tier1').map(([k]) => k);
		const untiered = entries.filter(([, s]) => !s.tier && !s.language).map(([k]) => k);
		expect(tier1.length).toBeGreaterThan(0);
		expect(untiered.length).toBeGreaterThan(0);
		const worstTier1 = Math.max(...tier1.map(sourcePriority));
		const bestUntiered = Math.min(...untiered.map(sourcePriority));
		expect(worstTier1).toBeLessThan(bestUntiered);
	});

	it('ranks international feeds behind the English long tail', () => {
		const intl = entries.filter(([, s]) => s.language && !s.tier).map(([k]) => k);
		if (!intl.length) return;
		for (const k of intl) expect(sourcePriority(k)).toBe(4);
	});

	it('is stable for an unknown key', () => {
		expect(sourcePriority('no_such_source')).toBe(3);
	});
});
