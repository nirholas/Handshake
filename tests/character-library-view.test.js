import { describe, it, expect } from 'vitest';
import {
	SORTS,
	cardMeta,
	characterName,
	filterCharacters,
	formatBytes,
	sortCharacters,
	viewState,
	viewerLinks,
	visibleCharacters,
} from '../src/shared/character-library-view.js';

// Rows shaped like a real GET /api/avatars/library payload.
const AJ = {
	name: 'aj',
	label: 'Aj',
	url: '/r2-proxy/avatars/mixamo/glb/aj.glb',
	thumb: '/r2-proxy/avatars/mixamo/thumbs/aj.png',
	bytes: 5918024,
	source: 'mixamo',
};
const ABE = { name: 'abe', label: 'Abe', url: '/r2-proxy/avatars/mixamo/glb/abe.glb', bytes: 35947032, source: 'mixamo' };
const ALIEN = { name: 'alien-soldier', label: 'Alien Soldier', url: '/r2-proxy/avatars/mixamo/glb/alien-soldier.glb', bytes: 4101348, source: 'mixamo' };
const LIBRARY = [AJ, ABE, ALIEN];

describe('character name', () => {
	it('prefers the curated label over the manifest key', () => {
		expect(characterName(AJ)).toBe('Aj');
	});

	it('falls back to the manifest key when a row carries no label', () => {
		expect(characterName({ name: 'x-bot' })).toBe('x-bot');
	});

	it('is empty rather than "undefined" for a row with neither', () => {
		expect(characterName({})).toBe('');
		expect(characterName(null)).toBe('');
	});
});

describe('size formatting', () => {
	it('renders megabytes to one decimal above 1 MB', () => {
		expect(formatBytes(35947032)).toBe('34.3 MB');
		expect(formatBytes(5918024)).toBe('5.6 MB');
	});

	it('renders whole kilobytes below 1 MB', () => {
		expect(formatBytes(831488)).toBe('812 KB');
	});

	it('says nothing when the manifest omits the size', () => {
		expect(formatBytes(0)).toBe('');
		expect(formatBytes(undefined)).toBe('');
	});
});

describe('card meta line', () => {
	it('pairs the source with the size', () => {
		expect(cardMeta(AJ)).toBe('Mixamo · 5.6 MB');
	});

	// The separator used to render unconditionally, so a row with no size showed
	// "Mixamo · " with the bullet dangling off the end of the line.
	it('drops the separator when there is no size to separate', () => {
		expect(cardMeta({ name: 'aj', source: 'mixamo' })).toBe('Mixamo');
	});

	it('names a non-Mixamo source rather than mislabelling it', () => {
		expect(cardMeta({ name: 'k', source: 'avaturn', bytes: 2097152 })).toBe('avaturn · 2.0 MB');
	});
});

describe('viewer deep links', () => {
	it('points the three actions at the viewers that take a raw model URL', () => {
		const links = viewerLinks(AJ);
		expect(links.preview).toBe('/app#model=%2Fr2-proxy%2Favatars%2Fmixamo%2Fglb%2Faj.glb');
		expect(links.use).toBe('/studio?model=%2Fr2-proxy%2Favatars%2Fmixamo%2Fglb%2Faj.glb');
		expect(links.animate).toBe('/pose?src=%2Fr2-proxy%2Favatars%2Fmixamo%2Fglb%2Faj.glb&title=Aj');
	});

	it('encodes a name with a space so the Animation Studio title survives', () => {
		expect(viewerLinks(ALIEN).animate).toContain('title=Alien%20Soldier');
	});

	// A row with no GLB must render no action at all: an href="#" is a dead
	// control, and every one of these links needs a model to open.
	it('offers nothing for a row that carries no model', () => {
		expect(viewerLinks({ name: 'ghost' })).toBeNull();
		expect(viewerLinks({ name: 'ghost', url: '' })).toBeNull();
	});
});

describe('search', () => {
	it('matches case-insensitively on the display name', () => {
		expect(filterCharacters(LIBRARY, 'alien').map(characterName)).toEqual(['Alien Soldier']);
		expect(filterCharacters(LIBRARY, 'ALIEN').map(characterName)).toEqual(['Alien Soldier']);
	});

	it('matches inside the name, not only at the start', () => {
		expect(filterCharacters(LIBRARY, 'soldier').map(characterName)).toEqual(['Alien Soldier']);
	});

	it('returns the whole library for an empty or whitespace query', () => {
		expect(filterCharacters(LIBRARY, '')).toHaveLength(3);
		expect(filterCharacters(LIBRARY, '   ')).toHaveLength(3);
	});

	it('returns nothing for a query that matches nothing', () => {
		expect(filterCharacters(LIBRARY, 'zzzz')).toEqual([]);
	});

	it('never mutates the library it was handed', () => {
		const before = [...LIBRARY];
		filterCharacters(LIBRARY, 'a');
		expect(LIBRARY).toEqual(before);
	});
});

describe('sort', () => {
	it('sorts A to Z by default and for an unknown mode', () => {
		expect(sortCharacters(LIBRARY, 'az').map(characterName)).toEqual(['Abe', 'Aj', 'Alien Soldier']);
		expect(sortCharacters(LIBRARY, 'nonsense').map(characterName)).toEqual(['Abe', 'Aj', 'Alien Soldier']);
	});

	it('sorts Z to A', () => {
		expect(sortCharacters(LIBRARY, 'za').map(characterName)).toEqual(['Alien Soldier', 'Aj', 'Abe']);
	});

	it('sorts by file size in both directions', () => {
		expect(sortCharacters(LIBRARY, 'largest').map(characterName)).toEqual(['Abe', 'Aj', 'Alien Soldier']);
		expect(sortCharacters(LIBRARY, 'smallest').map(characterName)).toEqual(['Alien Soldier', 'Aj', 'Abe']);
	});

	it('sorts a sizeless row to the light end rather than dropping it', () => {
		const withUnknown = [...LIBRARY, { name: 'mystery', label: 'Mystery' }];
		expect(sortCharacters(withUnknown, 'smallest').map(characterName)[0]).toBe('Mystery');
		expect(sortCharacters(withUnknown, 'largest')).toHaveLength(4);
	});

	it('leaves the source array untouched', () => {
		const before = [...LIBRARY];
		sortCharacters(LIBRARY, 'za');
		expect(LIBRARY).toEqual(before);
	});

	it('covers every mode the sort select offers', () => {
		for (const mode of SORTS) expect(sortCharacters(LIBRARY, mode)).toHaveLength(3);
	});
});

describe('search and sort together', () => {
	it('filters first, then orders what survived', () => {
		expect(visibleCharacters(LIBRARY, { query: 'a', sort: 'smallest' }).map(characterName)).toEqual([
			'Alien Soldier',
			'Aj',
			'Abe',
		]);
	});

	it('defaults to the whole library, A to Z', () => {
		expect(visibleCharacters(LIBRARY).map(characterName)).toEqual(['Abe', 'Aj', 'Alien Soldier']);
	});

	it('survives a manifest that has not arrived yet', () => {
		expect(visibleCharacters(undefined, { query: 'a' })).toEqual([]);
	});
});

describe('which panel the page shows', () => {
	it('shows the skeleton until the manifest lands', () => {
		expect(viewState({ loaded: false, failed: false, total: 0, visible: 0 })).toBe('loading');
	});

	it('shows the error state when the fetch failed, whatever else is true', () => {
		expect(viewState({ loaded: true, failed: true, total: 3, visible: 3 })).toBe('error');
		expect(viewState({ loaded: false, failed: true, total: 0, visible: 0 })).toBe('error');
	});

	// The two empties are different messages: one says the library is being
	// staged, the other offers to clear the search.
	it('tells an empty library apart from a search that missed', () => {
		expect(viewState({ loaded: true, failed: false, total: 0, visible: 0 })).toBe('empty');
		expect(viewState({ loaded: true, failed: false, total: 3, visible: 0 })).toBe('empty-search');
	});

	it('shows the grid when there is something to render', () => {
		expect(viewState({ loaded: true, failed: false, total: 3, visible: 1 })).toBe('grid');
	});
});
