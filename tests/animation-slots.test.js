/**
 * Regression guard for the fixed agent animation-slot vocabulary
 * (src/runtime/animation-slots.js). Pins three contracts:
 *
 *  1. every slot in SLOTS has a DEFAULT_ANIMATION_MAP entry.
 *  2. every DEFAULT_ANIMATION_MAP value names a clip that actually exists in
 *     public/animations/manifest.json — a mismatch (e.g. the historic
 *     `fidget: 'Fidget'`, capitalized and never baked — see
 *     public/animations/registry.json known_issues: broken-fidget-slot)
 *     silently no-ops the gesture on every agent that hits it instead of
 *     failing loudly.
 *  3. every `animationHint` a skill declares anywhere in src/ resolves through
 *     resolveHint() to a slot, and that slot resolves to a baked clip. This is
 *     the guard for the whole class of bug that made `inspect`, `gesture`,
 *     `present`, `sign`, `curiosity` and `patience` no-op: a hint nobody wired
 *     up reads exactly like a working one at the call site.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
	SLOTS,
	DEFAULT_ANIMATION_MAP,
	HINT_ALIASES,
	resolveSlot,
	resolveHint,
} from '../src/runtime/animation-slots.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(__dirname, '../src');
const manifest = JSON.parse(
	readFileSync(resolve(__dirname, '../public/animations/manifest.json'), 'utf8'),
);
const CLIP_NAMES = new Set(manifest.map((c) => c.name));

/** Every `animationHint: '<name>'` literal declared under src/, with its file. */
function collectDeclaredHints(dir = SRC_DIR, out = new Map()) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			collectDeclaredHints(path, out);
			continue;
		}
		if (!entry.name.endsWith('.js')) continue;
		// The vocabulary's own module documents the field shape (`'<name>'`); it
		// declares no hints.
		if (path === resolve(SRC_DIR, 'runtime/animation-slots.js')) continue;
		const src = readFileSync(path, 'utf8');
		for (const m of src.matchAll(/animationHint:\s*'([^']+)'/g)) {
			if (!out.has(m[1])) out.set(m[1], entry.name);
		}
	}
	return out;
}

describe('animation-slots', () => {
	it('every declared slot has a default clip mapping', () => {
		for (const slot of SLOTS) {
			expect(DEFAULT_ANIMATION_MAP[slot], `slot "${slot}" has no default mapping`).toBeTruthy();
		}
	});

	it('every default mapping names a clip that is actually baked in the manifest', () => {
		for (const [slot, clip] of Object.entries(DEFAULT_ANIMATION_MAP)) {
			expect(CLIP_NAMES.has(clip), `slot "${slot}" → "${clip}" missing from manifest`).toBe(true);
		}
	});

	it('the map has no entry for a slot outside the vocabulary', () => {
		for (const slot of Object.keys(DEFAULT_ANIMATION_MAP)) {
			expect(SLOTS, `"${slot}" is mapped but not declared in SLOTS`).toContain(slot);
		}
	});

	it('the slots with a dedicated clip of the same name use it', () => {
		// These five borrowed `reaction`/`pray`/`defeated` until their own clips
		// were baked, then kept borrowing. Pin the fix.
		for (const slot of ['wave', 'nod', 'point', 'think', 'shrug']) {
			expect(DEFAULT_ANIMATION_MAP[slot], `slot "${slot}" should play its own clip`).toBe(slot);
		}
	});

	it('resolveSlot prefers an agent override over the default map', () => {
		expect(resolveSlot('wave', { wave: 'av-joy' })).toBe('av-joy');
		expect(resolveSlot('wave', null)).toBe(DEFAULT_ANIMATION_MAP.wave);
		expect(resolveSlot('wave', {})).toBe(DEFAULT_ANIMATION_MAP.wave);
	});

	it('falls back to the slot name itself for an unmapped slot', () => {
		expect(resolveSlot('not-a-real-slot', null)).toBe('not-a-real-slot');
	});
});

describe('animation hints', () => {
	const declared = collectDeclaredHints();

	it('finds the skill hints in the source tree', () => {
		// Sanity check on the scanner itself: if the regex ever stops matching,
		// every assertion below would pass vacuously.
		expect(declared.size).toBeGreaterThan(5);
		expect([...declared.keys()]).toContain('inspect');
	});

	it('every hint a skill declares resolves to a slot with a baked clip', () => {
		for (const [hint, file] of declared) {
			const slot = resolveHint(hint);
			expect(slot, `hint "${hint}" (${file}) resolves to no slot`).toBeTruthy();
			const clip = resolveSlot(slot, null);
			expect(CLIP_NAMES.has(clip), `hint "${hint}" → slot "${slot}" → "${clip}" missing from manifest`).toBe(true);
		}
	});

	it('every alias target is a real slot', () => {
		for (const [hint, slot] of Object.entries(HINT_ALIASES)) {
			expect(SLOTS, `alias "${hint}" → unknown slot "${slot}"`).toContain(slot);
		}
	});

	it('slot names pass through unchanged and are case/space tolerant', () => {
		expect(resolveHint('wave')).toBe('wave');
		expect(resolveHint('  Celebrate ')).toBe('celebrate');
	});

	it('an unknown hint in a known family falls back to that family', () => {
		expect(resolveHint('gesture-something-new')).toBe(HINT_ALIASES.gesture);
	});

	it('returns null rather than guessing for an unrelated hint', () => {
		expect(resolveHint('teleport')).toBe(null);
		expect(resolveHint('')).toBe(null);
		expect(resolveHint(null)).toBe(null);
	});
});
