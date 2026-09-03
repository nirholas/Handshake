/**
 * Unit tests for the Avatar Studio pure utility helpers.
 *
 * Tests cover:
 *   - collapseAppearance: empty, partial, and full appearance collapsing
 *   - hydrateAppearance: null/missing inputs, valid inputs, field defaults
 *   - cloneAppearance: deep isolation — mutations don't bleed between copies
 *   - appearanceEqual: identity, structural equality, inequality
 *   - parseEditId: URL params with and without the `edit` key
 *   - readDraft / writeDraft / clearDraft: localStorage round-trips + expiry
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	collapseAppearance,
	hydrateAppearance,
	cloneAppearance,
	appearanceEqual,
	parseEditId,
	readDraft,
	writeDraft,
	clearDraft,
	DRAFT_KEY,
	DRAFT_MAX_AGE_MS,
} from '../src/avatar-studio-utils.js';

// ── collapseAppearance ────────────────────────────────────────────────────────

describe('collapseAppearance', () => {
	it('returns null for a fully empty appearance', () => {
		expect(collapseAppearance(hydrateAppearance(null))).toBeNull();
	});

	it('returns null for null/undefined input', () => {
		expect(collapseAppearance(null)).toBeNull();
		expect(collapseAppearance(undefined)).toBeNull();
	});

	it('includes accessories when non-empty', () => {
		const result = collapseAppearance({ accessories: ['hat-01'], morphs: {}, colors: {}, hidden: [] });
		expect(result).toEqual({ accessories: ['hat-01'] });
	});

	it('includes morphs when non-empty', () => {
		const result = collapseAppearance({ accessories: [], morphs: { jawOpen: 0.3 }, colors: {}, hidden: [] });
		expect(result).toEqual({ morphs: { jawOpen: 0.3 } });
	});

	it('includes colors when non-empty', () => {
		const result = collapseAppearance({ accessories: [], morphs: {}, colors: { skin: '#f3c1a3' }, hidden: [] });
		expect(result).toEqual({ colors: { skin: '#f3c1a3' } });
	});

	it('includes hidden when non-empty', () => {
		const result = collapseAppearance({ accessories: [], morphs: {}, colors: {}, hidden: ['outfit'] });
		expect(result).toEqual({ hidden: ['outfit'] });
	});

	it('includes all non-empty fields together', () => {
		const input = {
			accessories: ['hat-01', 'earrings-02'],
			morphs: { jawOpen: 0.2 },
			colors: { hair: '#3b2417', skin: '#e0a878' },
			hidden: ['glasses'],
		};
		const result = collapseAppearance(input);
		expect(result).toEqual(input);
	});

	it('copies arrays — mutations to result do not affect input', () => {
		const input = { accessories: ['hat-01'], morphs: {}, colors: {}, hidden: [] };
		const result = collapseAppearance(input);
		result.accessories.push('mutated');
		expect(input.accessories).toHaveLength(1);
	});

	// Studio has no UI for `outfit` or `garments`, but a PATCH replaces the whole
	// appearance record, so dropping them here silently undresses the avatar.
	it('carries the baked outfit preset through', () => {
		const result = collapseAppearance({ ...hydrateAppearance(null), outfit: 'outfit-formal' });
		expect(result).toEqual({ outfit: 'outfit-formal' });
	});

	it('carries catalog garments through', () => {
		const garments = [{ slot: 'top', id: 'denim-jacket' }, { slot: 'footwear', id: 'hi-tops' }];
		const result = collapseAppearance({ ...hydrateAppearance(null), garments });
		expect(result).toEqual({ garments });
	});

	it('keeps garments alongside the fields Studio does edit', () => {
		const raw = {
			outfit: 'outfit-casual',
			accessories: ['hat-beanie'],
			morphs: { jawOpen: 0.2 },
			colors: { hair: '#3b2417' },
			hidden: ['glasses'],
			garments: [{ slot: 'top', id: 'denim-jacket' }],
		};
		expect(collapseAppearance(hydrateAppearance(raw))).toEqual(raw);
	});

	it('deep-copies garment entries, so mutating the result cannot reach the input', () => {
		const input = { ...hydrateAppearance(null), garments: [{ slot: 'top', id: 'tee' }] };
		const result = collapseAppearance(input);
		result.garments[0].id = 'mutated';
		result.garments.push({ slot: 'bottom', id: 'jeans' });
		expect(input.garments).toEqual([{ slot: 'top', id: 'tee' }]);
	});

	it('ignores an empty outfit string and an empty garment list', () => {
		expect(collapseAppearance({ ...hydrateAppearance(null), outfit: '', garments: [] })).toBeNull();
	});
});

// ── hydrateAppearance ─────────────────────────────────────────────────────────

// `proportions` is the skeleton-space body build (src/avatar-proportions.js).
// hydrateAppearance normalizes it like every other field, so the empty shape
// carries it too: a saved record from before the parametric editor shipped
// hydrates to `{}` rather than to a missing key.
const EMPTY = {
	outfit: null,
	accessories: [],
	morphs: {},
	colors: {},
	hidden: [],
	garments: [],
	proportions: {},
	// Free-sculpt deltas (src/avatar-sculpt-doc.js). null, not {}, because the
	// field is one document or nothing: an empty one would collapse away anyway.
	sculpt: null,
};

describe('hydrateAppearance', () => {
	it('returns defaults for null', () => {
		expect(hydrateAppearance(null)).toEqual(EMPTY);
	});

	it('returns defaults for undefined', () => {
		expect(hydrateAppearance(undefined)).toEqual(EMPTY);
	});

	it('returns defaults for a non-object (string)', () => {
		expect(hydrateAppearance('bad')).toEqual(EMPTY);
	});

	it('fills in missing fields with defaults', () => {
		const result = hydrateAppearance({ colors: { skin: '#abc123' } });
		expect(result.accessories).toEqual([]);
		expect(result.morphs).toEqual({});
		expect(result.hidden).toEqual([]);
		expect(result.colors).toEqual({ skin: '#abc123' });
	});

	it('round-trips a full appearance', () => {
		const raw = {
			outfit: 'outfit-sporty',
			accessories: ['hat-01'],
			morphs: { browDownLeft: 0.5 },
			colors: { hair: '#0e0e0e' },
			hidden: ['outfit'],
			garments: [{ slot: 'outerwear', id: 'parka' }],
			proportions: { height: 1.08 },
			sculpt: null,
		};
		expect(hydrateAppearance(raw)).toEqual(raw);
	});

	it('normalises proportions: neutral values drop out, unknown params are ignored', () => {
		// normalizeProportions keeps only known params that differ from neutral
		// (1), so a body saved at its defaults hydrates to {} rather than to a
		// record full of 1s that would compare unequal to "no build set".
		expect(hydrateAppearance({ proportions: { height: 1 } }).proportions).toEqual({});
		expect(hydrateAppearance({ proportions: { notAParam: 1.4 } }).proportions).toEqual({});
		expect(hydrateAppearance({ proportions: 'nope' }).proportions).toEqual({});
	});

	it('copies arrays — mutations do not affect the source', () => {
		const raw = { accessories: ['hat-01'], morphs: {}, colors: {}, hidden: [] };
		const result = hydrateAppearance(raw);
		result.accessories.push('mutated');
		expect(raw.accessories).toHaveLength(1);
	});

	it('deep-copies garment entries, so mutations do not affect the source', () => {
		const raw = { garments: [{ slot: 'top', id: 'tee' }] };
		const result = hydrateAppearance(raw);
		result.garments[0].id = 'mutated';
		expect(raw.garments).toEqual([{ slot: 'top', id: 'tee' }]);
	});

	it('normalises a missing or blank outfit to null and drops junk garment entries', () => {
		expect(hydrateAppearance({ outfit: '' }).outfit).toBeNull();
		expect(hydrateAppearance({ garments: 'nope' }).garments).toEqual([]);
		expect(hydrateAppearance({ garments: [null, { slot: 'top', id: 'tee' }] }).garments)
			.toEqual([{ slot: 'top', id: 'tee' }]);
	});
});

// ── cloneAppearance ───────────────────────────────────────────────────────────

describe('cloneAppearance', () => {
	it('produces an identical but distinct object', () => {
		const a = hydrateAppearance({
			accessories: ['hat-01'], morphs: { jawOpen: 0.1 }, colors: { skin: '#fff' }, hidden: ['glasses'],
		});
		const b = cloneAppearance(a);
		expect(b).toEqual(a);
		expect(b).not.toBe(a);
	});

	it('accessories mutation does not affect clone source', () => {
		const a = { accessories: ['hat-01'], morphs: {}, colors: {}, hidden: [] };
		const b = cloneAppearance(a);
		b.accessories.push('new');
		expect(a.accessories).toHaveLength(1);
	});

	it('morphs mutation does not affect clone source', () => {
		const a = { accessories: [], morphs: { jawOpen: 0.5 }, colors: {}, hidden: [] };
		const b = cloneAppearance(a);
		b.morphs.extra = 1;
		expect(a.morphs.extra).toBeUndefined();
	});

	it('carries outfit + garments and isolates each garment entry', () => {
		const a = hydrateAppearance({
			outfit: 'outfit-formal',
			garments: [{ slot: 'top', id: 'blazer' }],
		});
		const b = cloneAppearance(a);
		expect(b.outfit).toBe('outfit-formal');
		expect(b.garments).toEqual([{ slot: 'top', id: 'blazer' }]);
		b.garments[0].id = 'mutated';
		expect(a.garments[0].id).toBe('blazer');
	});
});

// ── appearanceEqual ───────────────────────────────────────────────────────────

describe('appearanceEqual', () => {
	it('empty appearances are equal', () => {
		const a = { accessories: [], morphs: {}, colors: {}, hidden: [] };
		const b = { accessories: [], morphs: {}, colors: {}, hidden: [] };
		expect(appearanceEqual(a, b)).toBe(true);
	});

	it('identical full appearances are equal', () => {
		const a = { accessories: ['hat-01'], morphs: { jawOpen: 0.3 }, colors: { skin: '#fff' }, hidden: ['outfit'] };
		expect(appearanceEqual(a, cloneAppearance(a))).toBe(true);
	});

	it('appearances with different accessories are not equal', () => {
		const a = { accessories: ['hat-01'], morphs: {}, colors: {}, hidden: [] };
		const b = { accessories: ['hat-02'], morphs: {}, colors: {}, hidden: [] };
		expect(appearanceEqual(a, b)).toBe(false);
	});

	it('appearances with different colors are not equal', () => {
		const a = { accessories: [], morphs: {}, colors: { skin: '#fff' }, hidden: [] };
		const b = { accessories: [], morphs: {}, colors: { skin: '#000' }, hidden: [] };
		expect(appearanceEqual(a, b)).toBe(false);
	});

	// Studio never edits the wardrobe, so carrying it through must not make an
	// untouched avatar look dirty the moment it loads.
	it('a hydrated garment-wearing avatar is equal to its own clone', () => {
		const a = hydrateAppearance({
			outfit: 'outfit-casual',
			colors: { skin: '#e0a878' },
			garments: [{ slot: 'top', id: 'denim-jacket' }],
		});
		expect(appearanceEqual(a, cloneAppearance(a))).toBe(true);
	});

	it('losing the garments is a real difference, not a no-op', () => {
		const dressed = hydrateAppearance({ garments: [{ slot: 'top', id: 'denim-jacket' }] });
		expect(appearanceEqual(dressed, hydrateAppearance(null))).toBe(false);
	});
});

// ── parseEditId ───────────────────────────────────────────────────────────────

describe('parseEditId', () => {
	it('returns null when no edit param', () => {
		expect(parseEditId(new URLSearchParams(''))).toBeNull();
	});

	it('returns null when edit param is empty', () => {
		expect(parseEditId(new URLSearchParams('edit='))).toBeNull();
	});

	it('returns null when edit param is whitespace', () => {
		expect(parseEditId(new URLSearchParams('edit=   '))).toBeNull();
	});

	it('returns the ID when edit param is present', () => {
		const params = new URLSearchParams('edit=abc-123-def');
		expect(parseEditId(params)).toBe('abc-123-def');
	});

	it('trims whitespace from the ID', () => {
		const params = new URLSearchParams('edit=  abc-123  ');
		expect(parseEditId(params)).toBe('abc-123');
	});

	it('accepts a raw query string', () => {
		expect(parseEditId('?edit=my-id')).toBe('my-id');
	});
});

// ── draft storage ─────────────────────────────────────────────────────────────

function makeStorage(initial = {}) {
	const store = { ...initial };
	return {
		getItem: (k) => store[k] ?? null,
		setItem: (k, v) => { store[k] = v; },
		removeItem: (k) => { delete store[k]; },
		_store: store,
	};
}

describe('writeDraft / readDraft / clearDraft', () => {
	it('writes and reads back a draft', () => {
		const storage = makeStorage();
		const appearance = { accessories: ['hat-01'], morphs: {}, colors: { skin: '#fff' }, hidden: [] };
		writeDraft(storage, appearance, 'My Avatar');
		const draft = readDraft(storage);
		expect(draft).not.toBeNull();
		expect(draft.appearance).toEqual(appearance);
		expect(draft.name).toBe('My Avatar');
		expect(typeof draft.ts).toBe('number');
	});

	it('clearDraft removes the entry', () => {
		const storage = makeStorage();
		writeDraft(storage, { accessories: [] }, 'test');
		clearDraft(storage);
		expect(readDraft(storage)).toBeNull();
	});

	it('returns null for missing key', () => {
		expect(readDraft(makeStorage())).toBeNull();
	});

	it('returns null and removes expired drafts', () => {
		const storage = makeStorage();
		const oldTs = Date.now() - DRAFT_MAX_AGE_MS - 1000;
		storage.setItem(DRAFT_KEY, JSON.stringify({ appearance: {}, name: 'x', ts: oldTs }));
		expect(readDraft(storage)).toBeNull();
		expect(storage._store[DRAFT_KEY]).toBeUndefined();
	});

	it('returns null for malformed JSON', () => {
		const storage = makeStorage({ [DRAFT_KEY]: 'not-json{{{' });
		expect(readDraft(storage)).toBeNull();
	});

	it('returns null for draft without ts field', () => {
		const storage = makeStorage({ [DRAFT_KEY]: JSON.stringify({ appearance: {} }) });
		expect(readDraft(storage)).toBeNull();
	});

	it('allows null appearance in the draft (collapseAppearance returns null for empty)', () => {
		const storage = makeStorage();
		writeDraft(storage, null, 'Empty');
		const draft = readDraft(storage);
		expect(draft).not.toBeNull();
		expect(draft.appearance).toBeNull();
	});
});
