/**
 * public/animations/registry.json is the developer-facing catalogue of every
 * animation asset, and its own header tells the reader to consult it first.
 * A registry that has drifted is worse than none: it drifted to 37 of 112 built
 * clips, with `source_fbx` paths pointing into a directory that has held no FBX
 * since the sources moved to animation-sources/, and `agent_slots` recording
 * slot assignments that had moved to other clips.
 *
 * scripts/sync-animation-registry.mjs derives the whole block from the manifest,
 * the clip config and the live slot map. These tests fail if the committed file
 * is not what that script would produce, so the catalogue cannot silently rot.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DEFAULT_ANIMATION_MAP, SLOTS } from '../src/runtime/animation-slots.js';
import { buildRows } from '../scripts/sync-animation-registry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(resolve(__dirname, p), 'utf8'));

const registry = readJson('../public/animations/registry.json');
const manifest = readJson('../public/animations/manifest.json');
const items = registry.collections.clips.items;

describe('animation registry: clips collection', () => {
	it('lists every clip in the built manifest, exactly once', () => {
		expect(items.map((r) => r.name)).toEqual(manifest.map((c) => c.name));
	});

	it('matches what the sync script derives (run npm run sync:animation-registry)', () => {
		expect(items).toEqual(buildRows());
	});

	it('records no slot on more than one clip', () => {
		const seen = new Map();
		for (const row of items) {
			for (const slot of row.agent_slots) {
				expect(seen.has(slot), `slot "${slot}" recorded on both ${seen.get(slot)} and ${row.name}`).toBe(false);
				seen.set(slot, row.name);
			}
		}
	});

	it('records exactly the slot assignments the runtime map makes', () => {
		const fromRegistry = new Map();
		for (const row of items) for (const slot of row.agent_slots) fromRegistry.set(slot, row.name);
		expect(Object.fromEntries([...fromRegistry].sort())).toEqual(
			Object.fromEntries(Object.entries(DEFAULT_ANIMATION_MAP).sort()),
		);
	});

	it('points every source_fbx at the directory the build actually reads', () => {
		for (const row of items) {
			if (row.source_fbx === null) continue;
			expect(row.source_fbx, `${row.name} has a stale source path`).toMatch(/^animation-sources\//);
		}
	});
});

describe('animation registry: agent_slots section', () => {
	const slots = registry.agent_slots.slots;

	it('documents every slot in the vocabulary and nothing else', () => {
		expect(Object.keys(slots)).toEqual(SLOTS);
	});

	it('documents the same default clip the runtime resolves', () => {
		for (const [slot, def] of Object.entries(slots)) {
			expect(def.default_clip, `registry disagrees with the runtime on "${slot}"`).toBe(
				DEFAULT_ANIMATION_MAP[slot],
			);
		}
	});
});
