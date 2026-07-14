import { describe, it, expect } from 'vitest';
import {
	buildModelName,
	buildDescription,
	buildTags,
	showcaseLink,
	GLB_MAX_BYTES,
} from '../api/_lib/sketchfab.js';

describe('buildModelName', () => {
	it('title-cases the first clause and strips the leading article', () => {
		expect(buildModelName('a crystal dragon, perched on obsidian')).toBe('Crystal Dragon');
	});

	it('never exceeds the 48-char Sketchfab name limit and cuts on a word boundary', () => {
		const name = buildModelName(
			'an intricately detailed victorian steampunk locomotive with brass fittings everywhere',
		);
		expect(name.length).toBeLessThanOrEqual(48);
		expect(name.endsWith(' ')).toBe(false);
		// A word-boundary cut never ends mid-word relative to the source.
		expect(name).toBe('Intricately Detailed Victorian Steampunk');
	});

	it('falls back sanely on empty input', () => {
		expect(buildModelName('')).toBe('3D Model');
	});
});

describe('buildTags', () => {
	it('always includes the AI disclosure tag first', () => {
		expect(buildTags()[0]).toBe('ai-generated');
	});

	it('appends the model category as a slug', () => {
		expect(buildTags('Sci-Fi Vehicle')).toContain('sci-fi-vehicle');
	});

	it('does not duplicate a category that matches a base tag', () => {
		const tags = buildTags('threews');
		expect(tags.filter((t) => t === 'threews')).toHaveLength(1);
	});
});

describe('buildDescription', () => {
	const base = { prompt: 'a crystal dragon', creationId: 'abc-123', source: 'board_winner' };

	it('carries the prompt, AI disclosure, and both UTM backlinks', () => {
		const desc = buildDescription(base);
		expect(desc).toContain('Prompt: "a crystal dragon"');
		expect(desc).toContain('AI-generated');
		expect(desc).toContain('/forge/share/abc-123?utm_source=sketchfab');
		expect(desc).toContain('/forge?utm_source=sketchfab');
		expect(desc).toContain('utm_campaign=showcase');
	});

	it('names the curation source', () => {
		expect(buildDescription(base)).toContain('Forge-Off winner');
		expect(buildDescription({ ...base, source: 'top_voted' })).toContain('top-voted');
	});

	it('clamps a huge prompt without ever losing the backlinks', () => {
		const desc = buildDescription({ ...base, prompt: 'x'.repeat(5000) });
		expect(desc.length).toBeLessThanOrEqual(1024);
		expect(desc).toContain('/forge/share/abc-123?utm_source=sketchfab');
		expect(desc).toContain('utm_campaign=showcase');
	});
});

describe('showcaseLink', () => {
	it('appends UTM params with ? on a bare path and & when a query exists', () => {
		expect(showcaseLink('/forge')).toMatch(/\/forge\?utm_source=sketchfab/);
		expect(showcaseLink('/viewer?src=x')).toMatch(/\/viewer\?src=x&utm_source=sketchfab/);
	});
});

describe('GLB_MAX_BYTES', () => {
	it('stays under the Sketchfab basic-plan 50 MB cap', () => {
		expect(GLB_MAX_BYTES).toBeLessThan(50 * 1024 * 1024);
	});
});
