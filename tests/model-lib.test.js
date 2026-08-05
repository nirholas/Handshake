// Pure helpers behind the model detail page (/m/:id). These shape a public
// page's title, counts, and embed snippet, so the edges matter: a hostile
// prompt must not break out of an attribute, and the id parser must never
// match a non-uuid path segment.
import { describe, it, expect } from 'vitest';

import {
	modelIdFromPath,
	titleFromPrompt,
	formatCount,
	formatBytes,
	timeAgo,
	embedSnippet,
	chipsFor,
} from '../src/model-lib.js';

const ID = '0b8f3c2a-1d4e-4f6a-9b7c-2e5d8a1f0c3b';

describe('modelIdFromPath', () => {
	it('extracts the uuid from /m/<uuid>', () => {
		expect(modelIdFromPath(`/m/${ID}`)).toBe(ID);
		expect(modelIdFromPath(`/m/${ID}/`)).toBe(ID);
	});
	it('rejects anything that is not exactly /m/<uuid>', () => {
		expect(modelIdFromPath('/m/not-a-uuid')).toBeNull();
		expect(modelIdFromPath(`/model/${ID}`)).toBeNull();
		expect(modelIdFromPath(`/m/${ID}/extra`)).toBeNull();
		expect(modelIdFromPath('/m/')).toBeNull();
		expect(modelIdFromPath('')).toBeNull();
		expect(modelIdFromPath(null)).toBeNull();
	});
});

describe('titleFromPrompt', () => {
	it('uses the first line, sentence-cased', () => {
		expect(titleFromPrompt('a wooden barrel with tap\nmore detail')).toBe('A wooden barrel with tap');
	});
	it('caps long prompts on a word boundary with an ellipsis', () => {
		const long = 'a '.repeat(120).trim();
		const t = titleFromPrompt(long);
		expect(t.length).toBeLessThanOrEqual(92);
		expect(t.endsWith('…')).toBe(true);
	});
	it('falls back for empty prompts', () => {
		expect(titleFromPrompt('')).toBe('Untitled model');
		expect(titleFromPrompt(null)).toBe('Untitled model');
	});
});

describe('formatCount', () => {
	it('keeps small numbers verbatim and compacts thousands/millions', () => {
		expect(formatCount(0)).toBe('0');
		expect(formatCount(999)).toBe('999');
		expect(formatCount(1000)).toBe('1k');
		expect(formatCount(13400)).toBe('13.4k');
		expect(formatCount(1200000)).toBe('1.2M');
	});
	it('treats junk as zero', () => {
		expect(formatCount(undefined)).toBe('0');
		expect(formatCount('nope')).toBe('0');
	});
});

describe('formatBytes', () => {
	it('renders KB and MB', () => {
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(2048)).toBe('2 KB');
		expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB');
	});
	it('returns null for missing sizes', () => {
		expect(formatBytes(null)).toBeNull();
		expect(formatBytes(0)).toBeNull();
	});
});

describe('timeAgo', () => {
	const now = Date.parse('2026-08-05T12:00:00Z');
	it('walks the ladder from minutes to years', () => {
		expect(timeAgo('2026-08-05T11:59:40Z', now)).toBe('just now');
		expect(timeAgo('2026-08-05T11:30:00Z', now)).toBe('30 minutes ago');
		expect(timeAgo('2026-08-05T06:00:00Z', now)).toBe('6 hours ago');
		expect(timeAgo('2026-08-01T12:00:00Z', now)).toBe('4 days ago');
		expect(timeAgo('2025-11-05T12:00:00Z', now)).toBe('8 months ago');
		expect(timeAgo('2024-06-05T12:00:00Z', now)).toBe('2 years ago');
	});
	it('returns empty for unparseable input', () => {
		expect(timeAgo('nope', now)).toBe('');
	});
});

describe('embedSnippet', () => {
	it('builds a /viewer iframe with the glb url encoded', () => {
		const html = embedSnippet('https://cdn.three.ws/x.glb', 'Barrel');
		expect(html).toContain('https://three.ws/viewer?src=https%3A%2F%2Fcdn.three.ws%2Fx.glb');
		expect(html).toContain('title="Barrel"');
		expect(html).toContain('xr-spatial-tracking');
	});
	it('escapes hostile titles out of the attribute', () => {
		const html = embedSnippet('https://cdn.three.ws/x.glb', '"><script>alert(1)</script>');
		expect(html).not.toContain('"><script>');
	});
});

describe('chipsFor', () => {
	it('emits only real stored attributes, never invented tags', () => {
		const chips = chipsFor({
			model_category: 'item',
			backend: 'nvidia',
			tier: 'draft',
			path: 'geometry',
			multiview: false,
			remixable: true,
			parent_creation_id: null,
		});
		expect(chips.map((c) => c.label)).toEqual(['item', 'nvidia', 'draft', 'geometry-first', 'remixable']);
	});
	it('hides the noise category and empty fields', () => {
		expect(chipsFor({ model_category: 'other' })).toEqual([]);
		expect(chipsFor(null)).toEqual([]);
	});
});
