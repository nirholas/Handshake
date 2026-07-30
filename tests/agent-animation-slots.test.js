/**
 * PUT /api/agents/:id/animations accepts `animationSlots`: the agent's own
 * bindings for the gesture vocabulary, persisted at meta.edits.animations.
 *
 * That path is the producer half of a feature that shipped with neither half
 * wired: the runtime read meta.edits.animations, docs described it, and nothing
 * could write it (no UI, no API field) while nothing applied it either
 * (setAnimationMap was never called). These tests pin the validation contract of
 * the write path, so a slot typo or a hostile clip name fails at the boundary
 * rather than persisting into a gesture that silently never plays.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { SLOTS, DEFAULT_ANIMATION_MAP } from '../src/runtime/animation-slots.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUB = readFileSync(resolve(__dirname, '../api/agents/_id/_sub.js'), 'utf8');

// The handler's schema, rebuilt here from the same source of truth. Importing
// the handler itself would pull in the DB client and the session layer.
const schema = z
	.record(
		z.enum(/** @type {[string, ...string[]]} */ (SLOTS)),
		z
			.string()
			.trim()
			.min(1)
			.max(60)
			.regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'clip name must be alphanumeric with - or _'),
	)
	.refine((map) => Object.keys(map).length <= SLOTS.length, 'too many slot overrides');

describe('animationSlots validation', () => {
	it('accepts a real slot pointed at a real clip', () => {
		expect(schema.parse({ dance: 'av-offabean-dance' })).toEqual({ dance: 'av-offabean-dance' });
	});

	it('accepts an empty map, which clears every override', () => {
		expect(schema.parse({})).toEqual({});
	});

	it('accepts every slot at once', () => {
		const all = Object.fromEntries(SLOTS.map((s) => [s, DEFAULT_ANIMATION_MAP[s]]));
		expect(Object.keys(schema.parse(all))).toHaveLength(SLOTS.length);
	});

	it('rejects a slot outside the vocabulary', () => {
		expect(() => schema.parse({ backflip: 'av-back-flip' })).toThrow();
	});

	it('rejects a path, a query string, or a quote in a clip name', () => {
		for (const bad of ['../../etc/passwd', 'clip?x=1', "clip'; drop", 'clip name', '/absolute']) {
			expect(() => schema.parse({ dance: bad }), `accepted ${bad}`).toThrow();
		}
	});

	it('rejects an empty or over-long clip name', () => {
		expect(() => schema.parse({ dance: '' })).toThrow();
		expect(() => schema.parse({ dance: 'a'.repeat(61) })).toThrow();
	});
});

describe('the animations handler wiring', () => {
	it('derives its slot vocabulary from the runtime module', () => {
		expect(SUB).toMatch(/from '\.\.\/\.\.\/\.\.\/src\/runtime\/animation-slots\.js'/);
		expect(SUB).toMatch(/z\.enum\(\/\*\* @type \{\[string, \.\.\.string\[\]\]\} \*\/ \(SLOTS\)\)/);
	});

	it('writes the map where the runtime reads it', () => {
		expect(SUB).toContain("'{edits,animations}'");
	});

	it('leaves the map alone when the request omits the field', () => {
		// The guard that makes a clip-list save non-destructive to the overrides.
		expect(SUB).toContain("has('animationSlots')");
	});

	it('reads the stored map back into the response', () => {
		expect(SUB).toMatch(/meta->'edits'->'animations' AS slots/);
	});
});

describe('the consumers apply it', () => {
	const read = (p) => readFileSync(resolve(__dirname, p), 'utf8');

	it('the agent page applies the override map to the avatar', () => {
		const app = read('../src/app.js');
		expect(app).toContain('this.identity?.meta?.edits?.animations');
		expect(app).toContain('this.avatar.setAnimationMap(slotOverrides)');
	});

	it('the embed component applies the manifest map to the avatar', () => {
		const element = read('../src/element.js');
		expect(element).toContain('manifest.animationSlots');
		expect(element).toContain('this._avatar.setAnimationMap(_slots)');
	});

	it('the manifest endpoint publishes the map for embeds', () => {
		expect(SUB).toContain('animationSlots:');
	});

	it('the editor offers a row per slot and posts them', () => {
		const editor = read('../src/agent-edit.js');
		expect(editor).toContain('renderAnimSlotsPicker');
		expect(editor).toContain('animationSlots: buildAnimSlotsPayload()');
	});
});
