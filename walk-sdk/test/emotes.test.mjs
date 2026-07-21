// @three-ws/walk — emote resolution.
// ===================================
// The playground's emote rail renders one button per emote the current rig
// supports; a rendered button must ALWAYS visibly perform. That guarantee
// rests on two invariants tested here:
//   1. resolveEmotes drops any emote whose clip doesn't exist (no dead buttons,
//      no silent idle fallback).
//   2. Every clip named in DEFAULT_EMOTES (and every roster entry's `emotes`
//      override) actually exists in the platform's animation manifest, so the
//      default cast performs out of the box.
// Pure logic; `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveEmotes } from '../src/internal/load-avatar.js';
import { DEFAULT_EMOTES, WALK_AVATARS } from '../src/roster.js';

const manifestPath = fileURLToPath(
	new URL('../../public/animations/manifest.json', import.meta.url),
);
const manifestNames = new Set(JSON.parse(readFileSync(manifestPath, 'utf8')).map((d) => d.name));

test('resolveEmotes keeps only emotes whose clip exists', () => {
	const out = resolveEmotes(['dance', 'wave'], {
		dance: 'dance',
		punch: 'av-muay-thai',
		wave: 'wave',
	});
	assert.deepEqual(out, { dance: 'dance', wave: 'wave' });
});

test('resolveEmotes never falls back to another clip for a missing one', () => {
	const out = resolveEmotes(['idle'], DEFAULT_EMOTES);
	assert.deepEqual(out, {});
});

test('resolveEmotes defaults to DEFAULT_EMOTES', () => {
	const out = resolveEmotes(Object.values(DEFAULT_EMOTES));
	assert.deepEqual(out, DEFAULT_EMOTES);
});

test('every DEFAULT_EMOTES clip exists in the shared animation manifest', () => {
	for (const [emote, clip] of Object.entries(DEFAULT_EMOTES)) {
		assert.ok(manifestNames.has(clip), `emote "${emote}" names missing clip "${clip}"`);
	}
});

test('every roster emote override names a real manifest clip', () => {
	for (const entry of WALK_AVATARS) {
		if (!entry.emotes) continue;
		for (const [emote, clip] of Object.entries(entry.emotes)) {
			assert.ok(
				manifestNames.has(clip),
				`roster "${entry.id}" emote "${emote}" names missing clip "${clip}"`,
			);
		}
	}
});
