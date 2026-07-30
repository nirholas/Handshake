/**
 * public/agent-hints.json is the attribution behind the /gestures page: which
 * skills drive which animation slot. It is generated from the skill sources by
 * scripts/build-agent-hints.mjs, so it can only be true if it is regenerated
 * when a skill changes its hint.
 *
 * These tests fail when the committed file is stale, when a declared hint
 * resolves to no slot, or when a slot's clip is not baked in the manifest.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { build, collect } from '../scripts/build-agent-hints.mjs';
import { DEFAULT_ANIMATION_MAP } from '../src/runtime/animation-slots.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(resolve(__dirname, p), 'utf8'));

const committed = readJson('../public/agent-hints.json');
const manifest = readJson('../public/animations/manifest.json');
const CLIP_NAMES = new Set(manifest.map((c) => c.name));

describe('agent-hints.json', () => {
	it('matches the skill sources (run npm run build:agent-hints)', () => {
		expect(committed).toEqual(build());
	});

	it('resolves every declared hint to a slot with a baked clip', () => {
		for (const row of committed.hints) {
			expect(row.slot, `hint "${row.hint}" resolves to no slot`).toBeTruthy();
			expect(row.clip).toBe(DEFAULT_ANIMATION_MAP[row.slot]);
			expect(CLIP_NAMES.has(row.clip), `hint "${row.hint}" → "${row.clip}" is not baked`).toBe(true);
		}
	});

	it('attributes every hint to at least one named skill', () => {
		for (const row of committed.hints) {
			expect(row.skills.length, `hint "${row.hint}" has no skill`).toBeGreaterThan(0);
		}
	});

	it('finds the hints where they are actually declared', () => {
		const rows = collect();
		expect(rows.length).toBeGreaterThan(40);
		expect(rows.every((r) => r.skill)).toBe(true);
	});

	it('counts each skill declaration exactly once per hint', () => {
		for (const row of committed.hints) {
			expect(new Set(row.skills).size).toBe(row.skills.length);
		}
	});
});
