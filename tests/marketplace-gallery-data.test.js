/**
 * marketplace-gallery-data — unit tests for the Walk-Browse data layer.
 *
 * These pure helpers normalise three different marketplace APIs
 * (/api/marketplace/agents, /api/explore, /api/skills) into ONE listing shape
 * the 3D hall (src/marketplace-gallery.js) and the deep-link router consume. A
 * regression here silently corrupts every plinth — a wrong detail href dead-ends
 * the "View listing" CTA, a mis-formatted price shows "$NaN" floating in the
 * hall, a broken alias map drops shared ?type links to the default tab. Pin the
 * contract.
 */

import { describe, it, expect } from 'vitest';
import {
	PAGE_SIZE,
	FILTERS,
	normalizeFilterKey,
	fmtTokenPrice,
	isPaidToken,
	fmtCount,
	makeRating,
	normalizeAgent,
	normalizeAvatar,
	normalizeSkill,
	interleave,
} from '../src/marketplace-gallery-data.js';

describe('config', () => {
	it('exposes a sane page size and the four canonical filters', () => {
		expect(PAGE_SIZE).toBeGreaterThan(0);
		expect(FILTERS.map((f) => f.key)).toEqual(['all', 'agent', 'avatar', 'skill']);
	});
});

describe('normalizeFilterKey — shared-link ?type alias map', () => {
	it('maps singular and plural forms to the canonical key', () => {
		expect(normalizeFilterKey('skill')).toBe('skill');
		expect(normalizeFilterKey('skills')).toBe('skill');
		expect(normalizeFilterKey('agents')).toBe('agent');
		expect(normalizeFilterKey('avatars')).toBe('avatar');
		expect(normalizeFilterKey('all')).toBe('all');
	});
	it('is case- and whitespace-insensitive', () => {
		expect(normalizeFilterKey('  Skills ')).toBe('skill');
		expect(normalizeFilterKey('AGENT')).toBe('agent');
	});
	it('returns null for unknown / empty so the caller defaults to all', () => {
		expect(normalizeFilterKey('widgets')).toBeNull();
		expect(normalizeFilterKey('')).toBeNull();
		expect(normalizeFilterKey(undefined)).toBeNull();
		expect(normalizeFilterKey(null)).toBeNull();
	});
});

describe('fmtTokenPrice — base-unit integer + mint decimals', () => {
	it('formats whole and sub-dollar amounts', () => {
		expect(fmtTokenPrice({ amount: '1000000', mint_decimals: 6 })).toBe('$1');
		expect(fmtTokenPrice({ amount: '500000', mint_decimals: 6 })).toBe('$0.50');
		expect(fmtTokenPrice({ amount: '2500000000', mint_decimals: 6 })).toBe('$2,500');
	});
	it('defaults to 6 decimals when mint_decimals is absent', () => {
		expect(fmtTokenPrice({ amount: '1000000' })).toBe('$1');
	});
	it('reads missing / zero / unparseable as Free, never "$0" or "$NaN"', () => {
		expect(fmtTokenPrice(null)).toBe('Free');
		expect(fmtTokenPrice({})).toBe('Free');
		expect(fmtTokenPrice({ amount: 0, mint_decimals: 6 })).toBe('Free');
		expect(fmtTokenPrice({ amount: 'xyz', mint_decimals: 6 })).toBe('Free');
	});
});

describe('isPaidToken', () => {
	it('is true only for a positive amount', () => {
		expect(isPaidToken({ amount: '1' })).toBe(true);
		expect(isPaidToken({ amount: 0 })).toBe(false);
		expect(isPaidToken(null)).toBe(false);
		expect(isPaidToken({})).toBe(false);
	});
});

describe('fmtCount — compact human counts', () => {
	it('passes small counts through', () => {
		expect(fmtCount(340)).toBe('340');
		expect(fmtCount(1)).toBe('1');
	});
	it('compacts thousands and millions at the right boundaries', () => {
		expect(fmtCount(1240)).toBe('1.2k');
		expect(fmtCount(1000)).toBe('1k');
		expect(fmtCount(99_900)).toBe('99.9k');
		expect(fmtCount(120_000)).toBe('120k');
		expect(fmtCount(2_300_000)).toBe('2.3M');
	});
	it('returns null for nothing-to-show so the chip is omitted', () => {
		expect(fmtCount(0)).toBeNull();
		expect(fmtCount(-5)).toBeNull();
		expect(fmtCount('nope')).toBeNull();
	});
});

describe('makeRating — social proof gating', () => {
	it('requires at least one rater', () => {
		expect(makeRating(4.7, 0)).toBeNull();
		expect(makeRating(5, 12)).toEqual({ avg: 5, count: 12 });
	});
	it('rounds the average to one decimal', () => {
		expect(makeRating(4.66, 3)).toEqual({ avg: 4.7, count: 3 });
	});
	it('drops zero / unparseable averages', () => {
		expect(makeRating(0, 4)).toBeNull();
		expect(makeRating('x', 4)).toBeNull();
	});
});

describe('normalizers — one listing shape across three APIs', () => {
	it('normalizeAgent maps to the agent detail route and owner count', () => {
		const out = normalizeAgent({
			id: 'a 1/b',
			name: 'Risk Auditor 9',
			description: 'Tracks grants',
			thumbnail_url: 'https://x/y.png',
			price: { amount: '1000000', mint_decimals: 6 },
			category: 'trading',
			rating_avg: 4.5,
			rating_count: 2,
			buyers_total: 1240,
			tags: ['nft-lookup', ' trending ', '', 'a', 'b', 'c'],
		});
		expect(out.type).toBe('agent');
		expect(out.href).toBe('/agents/a%201%2Fb'); // encoded, no dead link
		expect(out.price).toBe('$1');
		expect(out.paid).toBe(true);
		expect(out.rating).toEqual({ avg: 4.5, count: 2 });
		expect(out.uses).toEqual({ label: 'owners', count: 1240 });
		expect(out.tags).toEqual(['nft-lookup', 'trending', 'a', 'b']); // trimmed, blanks dropped, capped at 4
	});

	it('normalizeAgent falls back gracefully on a sparse record', () => {
		const out = normalizeAgent({ id: 'x' });
		expect(out.name).toBe('Untitled agent');
		expect(out.price).toBe('Free');
		expect(out.paid).toBe(false);
		expect(out.rating).toBeNull();
		expect(out.uses).toBeNull();
		expect(out.tags).toEqual([]);
	});

	it('normalizeAvatar uses avatarId for id + href and author display name', () => {
		const out = normalizeAvatar({
			avatarId: 'av-9',
			name: 'Nova',
			image: 'https://x/n.png',
			modelCategory: 'humanoid',
			author: { displayName: 'Dana' },
			viewCount: 2_300_000,
			featured: true,
		});
		expect(out.href).toBe('/marketplace/avatars/av-9');
		expect(out.author).toBe('Dana');
		expect(out.uses).toEqual({ label: 'views', count: 2_300_000 });
		expect(out.featured).toBe(true);
		expect(out.category).toBe('humanoid');
	});

	it('normalizeSkill prefers slug for the detail route and prices per call', () => {
		const paid = normalizeSkill({
			slug: 'whale-tracking',
			id: 'uuid-1',
			name: 'Whale Tracking',
			price_per_call_usd: 0.25,
			avg_rating: 5,
			rating_count: 1,
			install_count: 8,
		});
		expect(paid.id).toBe('whale-tracking');
		expect(paid.href).toBe('/marketplace/skills/whale-tracking');
		expect(paid.price).toBe('$0.25/call');
		expect(paid.paid).toBe(true);
		expect(paid.uses).toEqual({ label: 'installs', count: 8 });

		const free = normalizeSkill({ id: 'uuid-2', name: 'Free Skill', price_per_call_usd: 0 });
		expect(free.id).toBe('uuid-2'); // falls back to id when no slug
		expect(free.href).toBe('/marketplace/skills/uuid-2');
		expect(free.price).toBe('Free');
		expect(free.paid).toBe(false);
	});
});

describe('interleave — varied "All" hall', () => {
	it('round-robins across lanes and skips empties', () => {
		expect(interleave([[1, 2, 3], ['a', 'b'], []])).toEqual([1, 'a', 2, 'b', 3]);
	});
	it('handles a single lane and no lanes', () => {
		expect(interleave([[1, 2]])).toEqual([1, 2]);
		expect(interleave([])).toEqual([]);
		expect(interleave(null)).toEqual([]);
	});
});
