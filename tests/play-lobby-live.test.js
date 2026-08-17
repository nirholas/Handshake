// @vitest-environment jsdom
//
// The /play lobby's live browse surface (src/game/coincommunities-ui.js).
//
// The lobby is the front door: the one page that has to answer "which of these
// worlds is worth walking into" before anyone has entered anything. Three
// promises make that answer trustworthy, and each is easy to break by accident:
//
//   1. A headcount on a card is MEASURED or ABSENT, never invented. No live
//      read, an unreachable multiplayer server, or a server that predates the
//      per-coin breakdown all render the same way: no counts, and the ordering
//      that depends on them disabled rather than silently sorting by something
//      else.
//   2. A poll repaints the counts IN PLACE. Rebuilding the grid every 20s would
//      throw away hover, keyboard focus and scroll position, which is worse than
//      a slightly stale number.
//   3. Every sort is a real reorder of a real field, and a coin badge appears
//      only when it is true of that coin.
//
// The scene (coincommunities.js) owns WebGL and hands this module its data, so
// nothing here needs a canvas: the module runs directly against jsdom with its
// network stubbed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Portrait rendering downloads and renders a real GLB: irrelevant here and
// impossible in jsdom. The chips keep their fallback glyph, exactly as they do
// in a browser that cannot render one.
vi.mock('../src/game/avatar-thumb.js', () => ({ renderAvatarThumb: vi.fn(async () => null) }));
vi.mock('../src/game/avatar-rig.js', () => ({ resolveAvatarUrl: vi.fn(async (u) => u) }));
vi.mock('../src/account.js', () => ({ getMe: vi.fn(async () => null) }));

const { CommunityUI } = await import('../src/game/coincommunities-ui.js');

const MINT_A = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const MINT_B = 'THREEsynthetic1111111111111111111111111111B';
const MINT_C = 'THREEsynthetic1111111111111111111111111111C';

const COINS = [
	{ mint: MINT_A, name: 'Alpha', symbol: 'ALPHA', image: '', marketCap: 1_000_000 },
	{ mint: MINT_B, name: 'Bravo', symbol: 'BRAVO', image: '', marketCap: 5_000_000 },
	{ mint: MINT_C, name: 'Charlie', symbol: 'CHARLIE', image: '', marketCap: 2_000_000 },
];

// Route every fetch the lobby makes on boot. The population read is the one
// under test; the rest answer empty so nothing else reaches the network.
function stubNetwork({ population } = {}) {
	return vi.fn(async (url) => {
		const u = String(url);
		if (u.startsWith('/api/play/population')) {
			if (!population) return { ok: false, status: 503, json: async () => ({}) };
			return { ok: true, status: 200, json: async () => population };
		}
		return { ok: true, status: 200, json: async () => ({ items: [], data: [] }) };
	});
}

/** Build a lobby with the coins loaded and the first population read settled. */
async function mountLobby({ population } = {}) {
	vi.stubGlobal('fetch', stubNetwork({ population }));
	const ui = new CommunityUI({ onEnter: vi.fn(), onSearch: vi.fn(async () => []) });
	ui.setCoins(COINS);
	// Let the boot reads (population, presets, enrichment) settle.
	for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
	return ui;
}

const cardMints = (ui) => [...ui.grid.querySelectorAll('.cc-card[data-mint]')].map((c) => c.dataset.mint);
const cardFor = (ui, mint) => ui.grid.querySelector(`.cc-card[data-mint="${mint}"]`);
// The pill's parts are separate elements spaced by CSS, so read them as parts
// rather than as one run of text.
const popText = (card) => {
	const pill = card.querySelector('.cc-card-pop');
	if (pill.hidden) return null;
	return [...pill.children].map((n) => n.textContent).filter(Boolean).join(' ').trim();
};

beforeEach(() => {
	document.body.innerHTML = '';
	localStorage.clear();
	// jsdom ships no matchMedia; the lobby asks it whether the pointer hovers and
	// whether motion is reduced. Answer as a plain desktop browser would.
	vi.stubGlobal('matchMedia', (q) => ({
		matches: /hover: hover/.test(q), media: q,
		addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
	}));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('the lobby never invents a headcount', () => {
	it('shows no per-card count and disables the headcount sort when the read fails', async () => {
		const ui = await mountLobby();
		expect(ui.popByCoin).toBeNull();
		for (const mint of cardMints(ui)) expect(popText(cardFor(ui, mint))).toBeNull();
		expect(ui.sortRow.querySelector('[data-sort="people"]').disabled).toBe(true);
		// The hero stat is absent rather than showing a zero nobody measured.
		expect(ui.statPeopleWrap.hidden).toBe(true);
	});

	it('treats an upstream without the per-coin breakdown as unknown, not as zero', async () => {
		// A multiplayer server that predates `?by=coin` still answers a total.
		const ui = await mountLobby({ population: { ok: true, players: 12, rooms: 3 } });
		expect(ui.popByCoin).toBeNull();
		expect(ui.sortRow.querySelector('[data-sort="people"]').disabled).toBe(true);
		// The total IS measured, so the hero stat is real and shown.
		expect(ui.statPeopleWrap.hidden).toBe(false);
		expect(ui.statPeople.dataset.v).toBe('12');
	});

	it('paints only the coins that actually have someone standing in them', async () => {
		const ui = await mountLobby({
			population: { ok: true, players: 4, rooms: 2, byCoin: { [MINT_B]: 3, [MINT_C]: 1 } },
		});
		expect(popText(cardFor(ui, MINT_A))).toBeNull();
		expect(popText(cardFor(ui, MINT_B))).toBe('3 people inside');
		// One person is one person, not "1 people inside".
		expect(popText(cardFor(ui, MINT_C))).toBe('1 person inside');
		expect(ui.sortRow.querySelector('[data-sort="people"]').disabled).toBe(false);
	});

	it('keeps the last measured numbers when a later poll fails', async () => {
		const ui = await mountLobby({ population: { ok: true, players: 4, rooms: 1, byCoin: { [MINT_B]: 4 } } });
		vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
		await ui._readPopulation();
		expect(popText(cardFor(ui, MINT_B))).toBe('4 people inside');
	});
});

describe('a poll repaints in place', () => {
	it('updates the counts without rebuilding the cards', async () => {
		const ui = await mountLobby({ population: { ok: true, players: 1, rooms: 1, byCoin: { [MINT_B]: 1 } } });
		const before = cardFor(ui, MINT_B);
		before.focus();

		vi.stubGlobal('fetch', stubNetwork({
			population: { ok: true, players: 9, rooms: 2, byCoin: { [MINT_B]: 9 } },
		}));
		await ui._readPopulation();

		expect(cardFor(ui, MINT_B)).toBe(before); // the same node, not a re-render
		expect(document.activeElement).toBe(before);
		expect(popText(before)).toBe('9 people inside');
	});
});

describe('sorting reorders real fields', () => {
	it('ranks by market cap', async () => {
		const ui = await mountLobby();
		ui._setSort('mcap');
		expect(cardMints(ui)).toEqual([MINT_B, MINT_C, MINT_A]);
	});

	it('ranks by live headcount, breaking ties on market cap', async () => {
		const ui = await mountLobby({
			population: { ok: true, players: 5, rooms: 2, byCoin: { [MINT_A]: 5 } },
		});
		ui._setSort('people');
		expect(cardMints(ui)).toEqual([MINT_A, MINT_B, MINT_C]);
	});

	it('ranks by launch time and sorts coins with no known launch time last', async () => {
		const ui = await mountLobby();
		ui.enriched.set(MINT_C, { createdAt: Date.now() - 60_000, replies: 0, graduated: true });
		ui.enriched.set(MINT_A, { createdAt: Date.now() - 86_400_000 * 9, replies: 0, graduated: true });
		ui._setSort('new');
		expect(cardMints(ui)).toEqual([MINT_C, MINT_A, MINT_B]);
	});

	it('falls back off the headcount sort when live counts are not available', async () => {
		localStorage.setItem('cc-sort', 'people');
		const ui = await mountLobby();
		expect(ui.sort).toBe('trending');
	});
});

describe('coin badges say something only when true of that coin', () => {
	it('marks a coin launched in the last day, and one still on its curve', async () => {
		const ui = await mountLobby();
		ui.enriched.set(MINT_A, { createdAt: Date.now() - 3 * 3600_000, replies: 1200, graduated: false });
		ui.enriched.set(MINT_B, { createdAt: Date.now() - 86_400_000 * 30, replies: 0, graduated: true });
		ui._renderGrid();

		const a = cardFor(ui, MINT_A);
		expect([...a.querySelectorAll('.cc-tag')].map((t) => t.textContent)).toEqual(['NEW', 'On curve', '1.2K replies']);
		expect(a.querySelector('.cc-card-age').textContent).toBe('3h old');

		// A graduated coin with a quiet board earns no badges at all: a badge on
		// every card is noise, not information.
		expect(cardFor(ui, MINT_B).querySelector('.cc-card-tags')).toBeNull();
	});

	it('says nothing about age or curve state for a coin the enrichment pass never covered', async () => {
		const ui = await mountLobby();
		const card = cardFor(ui, MINT_A);
		expect(card.querySelector('.cc-card-age')).toBeNull();
		expect(card.querySelector('.cc-card-tags')).toBeNull();
	});
});

describe('search', () => {
	it('filters the loaded grid and reports how many worlds match', async () => {
		const ui = await mountLobby();
		ui.searchInput.value = 'brav';
		ui._onSearchInput();
		expect(cardMints(ui)).toEqual([MINT_B]);
		expect(ui.feedCount.textContent).toBe('1 world matching');
		expect(ui.searchClear.hidden).toBe(false);
	});

	it('restores the full grid when the query is cleared', async () => {
		const ui = await mountLobby();
		ui.searchInput.value = 'brav';
		ui._onSearchInput();
		ui._clearSearch();
		expect(cardMints(ui)).toHaveLength(COINS.length);
		expect(ui.searchClear.hidden).toBe(true);
		expect(ui.searchInput.value).toBe('');
	});
});

describe('identity', () => {
	it('opens the avatar picker for a first-time visitor and folds it away for a returning one', async () => {
		const first = await mountLobby();
		expect(first.idBody.hidden).toBe(false);
		expect(first.idToggle.getAttribute('aria-expanded')).toBe('true');

		document.body.innerHTML = '';
		localStorage.setItem('cc-avatar', '/avatars/default.glb');
		localStorage.setItem('cc-name', 'jessica');
		const returning = await mountLobby();
		expect(returning.idBody.hidden).toBe(true);
		expect(returning.idToggle.getAttribute('aria-expanded')).toBe('false');
		returning._toggleIdentity();
		expect(returning.idBody.hidden).toBe(false);
	});
});
