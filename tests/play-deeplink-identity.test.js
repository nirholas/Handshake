// A shared /play?coin=<mint> link must build the same world as the lobby card it
// came from. The name, symbol and image on that URL are optional decoration the
// sharer's client appended, and they go missing constantly (a hand-typed link, a
// chat client that truncated the query, an unfurl that kept only the mint); the
// market cap was never on the URL at all, because a number that moves cannot be
// baked into a shareable link. Before this, a link short of that decoration built
// a real district with no identity: a totem reading COMMUNITY, a welcome card
// offering "the Community community", a tab titled Community, and a blank market
// cap on both the jumbotron and the in-world chart screen.
//
// enter() now backfills the blanks from the same pump.fun record the lobby cards
// are built from. What the link DID carry stays authoritative: it is what every
// peer already on that link sees, so the feed must never overwrite it.
//
// mergeCoinIdentity() is module-private inside a browser module that cannot be
// imported under node, so it is re-derived from its source text the way
// play-deeplink-safety.test.js re-derives its guards. The call-site assertions
// below cover what a pure function cannot: that entry stays cancellable and
// cannot be held open by a slow upstream.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

function extractFn(source, name) {
	const start = source.indexOf(`function ${name}(`);
	if (start === -1) throw new Error(`${name}() is no longer defined; update this test with the code that replaced it`);
	let depth = 0, i = source.indexOf('{', start);
	for (; i < source.length; i++) {
		if (source[i] === '{') depth++;
		else if (source[i] === '}' && --depth === 0) break;
	}
	return source.slice(start, i + 1);
}

const ccSrc = read('../src/game/coincommunities.js');
// eslint-disable-next-line no-new-func
const mergeCoinIdentity = new Function(`${extractFn(ccSrc, 'mergeCoinIdentity')}; return mergeCoinIdentity;`)();

const TCAR = { name: 'TRENCH CAR', symbol: 'TCAR', image: '/api/img?url=x', marketCap: 41699 };

describe('mergeCoinIdentity: a bare mint still opens a named world', () => {
	it('names a link that carried nothing but the mint', () => {
		const out = mergeCoinIdentity({ mint: 'm' }, TCAR);
		expect(out).toMatchObject({ mint: 'm', ...TCAR });
	});

	it('never overwrites what the link carried', () => {
		const link = { mint: 'm', name: 'Shared name', symbol: 'SHARE', image: '/api/img?url=shared', marketCap: 1 };
		expect(mergeCoinIdentity(link, TCAR)).toEqual(link);
	});

	it('fills only the missing halves of a partial link', () => {
		const out = mergeCoinIdentity({ mint: 'm', name: 'Shared name' }, TCAR);
		expect(out.name).toBe('Shared name');
		expect(out.symbol).toBe('TCAR');
		expect(out.marketCap).toBe(41699);
	});

	it('leaves the coin untouched when the lookup missed', () => {
		const link = { mint: 'm', name: '', symbol: '' };
		expect(mergeCoinIdentity(link, null)).toBe(link);
		expect(mergeCoinIdentity(link, undefined)).toBe(link);
	});

	it('keeps world-shaping fields the caller already decided', () => {
		// The flagship town pins its biome and its official badge before the
		// lookup runs; a feed record must not be able to strip either.
		const home = { mint: 'm', biome: 'hometown', official: true };
		const out = mergeCoinIdentity(home, TCAR);
		expect(out.biome).toBe('hometown');
		expect(out.official).toBe(true);
	});

	it('never turns a missing field into the string "undefined"', () => {
		const out = mergeCoinIdentity({ mint: 'm' }, { name: undefined, symbol: null });
		expect(out.name).toBe('');
		expect(out.symbol).toBe('');
		expect(out.image).toBe('');
		expect(out.marketCap).toBe(0);
	});
});

describe('the lookup cannot strand or outlive the entry it serves', () => {
	const fn = ccSrc.slice(ccSrc.indexOf('async _fetchCoinIdentity('));

	it('bounds the request so a slow upstream cannot hold the loading screen', () => {
		expect(fn).toMatch(/new AbortController\(\)/);
		expect(fn).toMatch(/setTimeout\(\(\) => ctrl\.abort\(\), COIN_IDENTITY_TIMEOUT_MS\)/);
		expect(fn).toMatch(/clearTimeout\(timer\)/);
		expect(ccSrc).toMatch(/const COIN_IDENTITY_TIMEOUT_MS = \d+;/);
	});

	it('resolves to null on any failure rather than throwing into entry', () => {
		expect(fn.slice(0, fn.indexOf('\n\t}'))).toMatch(/catch \(err\)[\s\S]*return null;/);
	});

	it('skips the round trip for an EVM world, which pump.fun cannot answer for', () => {
		expect(fn).toMatch(/SOLANA_MINT_RE\.test\([\s\S]{0,60}return null;/);
	});

	it('re-checks phase and epoch after awaiting, so backing out mid-lookup bails', () => {
		const call = ccSrc.slice(ccSrc.indexOf('const fetched = await this._fetchCoinIdentity('));
		const guard = call.slice(0, call.indexOf('mergeCoinIdentity'));
		expect(guard).toMatch(/this\.phase !== 'loading'/);
		expect(guard).toMatch(/epoch !== this\._enterEpoch/);
		expect(guard).toMatch(/return;/);
	});

	it('runs only for a coin that arrived short of an identity', () => {
		expect(ccSrc).toMatch(/if \(!coin\.name \|\| !coin\.symbol \|\| !coin\.marketCap\) \{/);
	});
});
