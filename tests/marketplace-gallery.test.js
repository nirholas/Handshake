import { describe, it, expect } from 'vitest';
import {
	fmtTokenPrice,
	isPaidToken,
	fmtCount,
	makeRating,
	normalizeFilterKey,
	normalizeAgent,
	normalizeAvatar,
	normalizeSkill,
	interleave,
	FILTERS,
	PAGE_SIZE,
} from '../src/marketplace-gallery-data.js';

describe('fmtTokenPrice', () => {
	it('reads missing / zero / unparseable amounts as Free', () => {
		expect(fmtTokenPrice(null)).toBe('Free');
		expect(fmtTokenPrice({})).toBe('Free');
		expect(fmtTokenPrice({ amount: 0, mint_decimals: 6 })).toBe('Free');
		expect(fmtTokenPrice({ amount: 'nope', mint_decimals: 6 })).toBe('Free');
	});

	it('formats sub-$1 amounts to two decimals', () => {
		expect(fmtTokenPrice({ amount: '500000', mint_decimals: 6 })).toBe('$0.50');
	});

	it('formats whole amounts with thousands separators and trimmed decimals', () => {
		expect(fmtTokenPrice({ amount: '1500000', mint_decimals: 6 })).toBe('$1.5');
		expect(fmtTokenPrice({ amount: '1000000000', mint_decimals: 6 })).toBe('$1,000');
	});

	it('defaults to 6 decimals when none provided', () => {
		expect(fmtTokenPrice({ amount: '2000000' })).toBe('$2');
	});
});

describe('isPaidToken', () => {
	it('is true only for a positive on-chain amount', () => {
		expect(isPaidToken({ amount: '1', mint_decimals: 6 })).toBe(true);
		expect(isPaidToken({ amount: 0 })).toBe(false);
		expect(isPaidToken(null)).toBe(false);
		expect(isPaidToken({})).toBe(false);
	});
});

describe('fmtCount', () => {
	it('omits empty counts', () => {
		expect(fmtCount(0)).toBe(null);
		expect(fmtCount(-5)).toBe(null);
		expect(fmtCount('x')).toBe(null);
	});

	it('passes through small counts and compacts large ones', () => {
		expect(fmtCount(340)).toBe('340');
		expect(fmtCount(1240)).toBe('1.2k');
		expect(fmtCount(12000)).toBe('12k');
		expect(fmtCount(150000)).toBe('150k');
		expect(fmtCount(2300000)).toBe('2.3M');
	});
});

describe('makeRating', () => {
	it('requires both a positive average and at least one vote', () => {
		expect(makeRating(0, 10)).toBe(null);
		expect(makeRating(4.5, 0)).toBe(null);
		expect(makeRating(null, 3)).toBe(null);
	});

	it('rounds the average to one decimal and keeps the vote count', () => {
		expect(makeRating(4.84, 12)).toEqual({ avg: 4.8, count: 12 });
		expect(makeRating('4.2', '7')).toEqual({ avg: 4.2, count: 7 });
	});
});

describe('normalizeFilterKey', () => {
	it('maps singular and plural aliases to a canonical key', () => {
		expect(normalizeFilterKey('skill')).toBe('skill');
		expect(normalizeFilterKey('skills')).toBe('skill');
		expect(normalizeFilterKey('Agents')).toBe('agent');
		expect(normalizeFilterKey('AVATAR')).toBe('avatar');
		expect(normalizeFilterKey('all')).toBe('all');
	});

	it('returns null for unknown or empty input', () => {
		expect(normalizeFilterKey('tools')).toBe(null);
		expect(normalizeFilterKey('')).toBe(null);
		expect(normalizeFilterKey(null)).toBe(null);
		expect(normalizeFilterKey(undefined)).toBe(null);
	});
});

describe('normalizeAgent', () => {
	it('maps fields, trust signals, and an encoded detail href', () => {
		const out = normalizeAgent({
			id: 'a 1/b',
			name: 'Trader',
			description: 'Trades',
			thumbnail_url: 'https://x/t.png',
			price: { amount: '5000000', mint_decimals: 6 },
			category: 'finance',
			rating_avg: 4.7,
			rating_count: 9,
			buyers_total: 1200,
			tags: [' defi ', '', 'solana', 'a', 'b', 'c'],
		});
		expect(out.type).toBe('agent');
		expect(out.id).toBe('a 1/b');
		expect(out.price).toBe('$5');
		expect(out.paid).toBe(true);
		expect(out.rating).toEqual({ avg: 4.7, count: 9 });
		expect(out.uses).toEqual({ label: 'owners', count: 1200 });
		expect(out.tags).toEqual(['defi', 'solana', 'a', 'b']); // trimmed, blanks dropped, capped at 4
		expect(out.href).toBe('/agents/a%201%2Fb');
	});

	it('falls back to a placeholder name and Free price', () => {
		const out = normalizeAgent({ id: 'x' });
		expect(out.name).toBe('Untitled agent');
		expect(out.price).toBe('Free');
		expect(out.paid).toBe(false);
		expect(out.rating).toBe(null);
		expect(out.uses).toBe(null);
		expect(out.tags).toEqual([]);
	});
});

describe('normalizeAvatar', () => {
	it('maps explore fields including views, featured, and author', () => {
		const out = normalizeAvatar({
			avatarId: 'av9',
			name: 'Nova',
			image: 'https://x/a.png',
			modelCategory: 'humanoid',
			viewCount: 5400,
			featured: true,
			price: { amount: '0', mint_decimals: 6 },
			author: { displayName: 'Mia', handle: 'mia' },
		});
		expect(out.type).toBe('avatar');
		expect(out.price).toBe('Free');
		expect(out.uses).toEqual({ label: 'views', count: 5400 });
		expect(out.featured).toBe(true);
		expect(out.rating).toBe(null);
		expect(out.author).toBe('Mia');
		expect(out.href).toBe('/marketplace/avatars/av9');
	});

	it('falls back to the handle when no display name', () => {
		const out = normalizeAvatar({ avatarId: 'av1', author: { handle: 'solo' } });
		expect(out.author).toBe('solo');
		expect(out.featured).toBe(false);
	});
});

describe('normalizeSkill', () => {
	it('formats a per-call price and maps installs + rating', () => {
		const out = normalizeSkill({
			slug: 'web-search',
			name: 'Web Search',
			description: 'Searches',
			category: 'research',
			price_per_call_usd: 0.01,
			avg_rating: 4.9,
			rating_count: 40,
			install_count: 880,
			author: { display_name: 'Dev' },
		});
		expect(out.type).toBe('skill');
		expect(out.price).toBe('$0.01/call');
		expect(out.paid).toBe(true);
		expect(out.uses).toEqual({ label: 'installs', count: 880 });
		expect(out.rating).toEqual({ avg: 4.9, count: 40 });
		expect(out.author).toBe('Dev');
		expect(out.image).toBe(null);
		expect(out.href).toBe('/marketplace/skills/web-search');
	});

	it('reads a zero price as Free and falls back to id for the href', () => {
		const out = normalizeSkill({ id: 'sk-7', name: 'Free Tool', price_per_call_usd: 0 });
		expect(out.price).toBe('Free');
		expect(out.paid).toBe(false);
		expect(out.href).toBe('/marketplace/skills/sk-7');
	});
});

describe('interleave', () => {
	it('round-robins across lanes so types alternate', () => {
		expect(interleave([['a1', 'a2'], ['b1', 'b2'], ['c1']])).toEqual([
			'a1',
			'b1',
			'c1',
			'a2',
			'b2',
		]);
	});

	it('skips empty / non-array lanes', () => {
		expect(interleave([[], ['b1', 'b2'], null, undefined])).toEqual(['b1', 'b2']);
		expect(interleave([])).toEqual([]);
		expect(interleave(null)).toEqual([]);
	});
});

describe('module constants', () => {
	it('exposes the four canonical filters and a sane page size', () => {
		expect(FILTERS.map((f) => f.key)).toEqual(['all', 'agent', 'avatar', 'skill']);
		expect(PAGE_SIZE).toBeGreaterThan(0);
	});
});
