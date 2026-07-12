import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the LLM so synthesizeCoin is deterministic and network-free.
const H = vi.hoisted(() => ({
	configured: true,
	responses: /** @type {string[]} */ ([]),
	prompts: /** @type {string[]} */ ([]),
	fail: false,
}));

vi.mock('../api/_lib/llm.js', () => ({
	llmConfigured: () => H.configured,
	llmComplete: vi.fn(async ({ user }) => {
		H.prompts.push(user);
		if (H.fail) throw new Error('all providers exhausted');
		return { text: H.responses.shift() ?? '{"name":"Fresh Coin","symbol":"FRESH","description":"a fresh one"}' };
	}),
}));

// gatherNarratives pulls launcher-trends (db + cache) — not under test here.
vi.mock('../api/_lib/launcher-trends.js', () => ({
	rankNarratives: vi.fn(async () => ({ terms: [], themes: [], top: null, providers: [] })),
}));

import { synthesizeCoin, isRepeatPick } from '../api/_lib/launcher-sources.js';

beforeEach(() => {
	H.configured = true;
	H.responses = [];
	H.prompts = [];
	H.fail = false;
});

describe('isRepeatPick', () => {
	const avoid = [{ symbol: 'KEKWZ', name: 'LurkLord' }, { symbol: 'GLAMZ', name: 'Starlet' }];

	it('matches a repeated symbol case- and punctuation-blind', () => {
		expect(isRepeatPick({ name: 'Anything', symbol: 'kekwz' }, avoid)).toBe(true);
		expect(isRepeatPick({ name: 'Anything', symbol: 'KEK-WZ' }, avoid)).toBe(true);
	});

	it('matches a repeated name even under a new ticker', () => {
		expect(isRepeatPick({ name: 'Lurk Lord', symbol: 'NEWTKR' }, avoid)).toBe(true);
	});

	it('passes a genuinely new identity', () => {
		expect(isRepeatPick({ name: 'Orbit Drip', symbol: 'ODRIP' }, avoid)).toBe(false);
		expect(isRepeatPick({ name: 'Orbit Drip', symbol: 'ODRIP' }, [])).toBe(false);
	});
});

describe('synthesizeCoin novelty guard', () => {
	const avoid = [{ symbol: 'KEKWZ', name: 'LurkLord' }];

	it('feeds recent tickers into the prompt so the model avoids them up front', async () => {
		await synthesizeCoin({ flavor: 'meme', avoid });
		expect(H.prompts[0]).toContain('KEKWZ');
	});

	it('retries once when the model repeats itself, and returns the fresh retry', async () => {
		H.responses = [
			'{"name":"LurkLord","symbol":"KEKWZ","description":"again"}',
			'{"name":"Orbit Drip","symbol":"ODRIP","description":"new angle"}',
		];
		const coin = await synthesizeCoin({ flavor: 'meme', avoid });
		expect(H.prompts.length).toBe(2);
		expect(H.prompts[1]).toMatch(/already minted "LurkLord"/);
		expect(coin.symbol).toBe('ODRIP');
		expect(coin.degraded).toBeUndefined();
	});

	it('degrades (never returns the repeat) when the retry repeats too', async () => {
		H.responses = [
			'{"name":"LurkLord","symbol":"KEKWZ","description":"again"}',
			'{"name":"Lurk Lord","symbol":"KEKWZ","description":"still again"}',
		];
		const coin = await synthesizeCoin({ flavor: 'meme', avoid });
		expect(coin.degraded).toBe('repeat_pick');
		expect(coin.kind).toBe('random');
	});

	it('marks LLM failure as degraded so live scopes can refuse to launch filler', async () => {
		H.fail = true;
		const coin = await synthesizeCoin({ flavor: 'meme', avoid });
		expect(coin.degraded).toBe('llm_error');
		expect(coin.kind).toBe('random');
	});

	it('keeps descriptions past 32 chars (only the NAME has the pump.fun 32 cap)', async () => {
		const desc = 'A memecoin so long-winded its description sails right past the old truncation point.';
		H.responses = [JSON.stringify({ name: 'Windbag', symbol: 'WNDBG', description: desc })];
		const coin = await synthesizeCoin({ flavor: 'meme' });
		expect(coin.description).toBe(desc);
		expect(coin.description.length).toBeGreaterThan(32);
	});
});
