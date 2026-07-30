/**
 * The /club dance picker (src/club-dances.js) and the paid endpoint that books
 * the performance (api/x402/dance-tip.js STYLES) are two lists of the same
 * thing, maintained by hand in two files. They drifted: the picker offered
 * "Climb + Invert" long after that routine was re-choreographed, and a style
 * added to the endpoint stayed invisible in the UI.
 *
 * These tests hold them together, and hold both against what actually ships:
 * every clip a style names is baked in the manifest, and every audio track it
 * names exists in public/club/audio/ with a mapping in src/club-audio.js.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DANCES, DANCE_KEYS, danceLabel } from '../src/club-dances.js';
import { STYLES } from '../api/x402/dance-tip.js';
import { styleAudioFor } from '../src/club-audio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'public/animations/manifest.json'), 'utf8'));
const CLIP_NAMES = new Set(manifest.map((c) => c.name));

describe('club dance picker', () => {
	it('offers exactly the styles the paid endpoint books', () => {
		expect([...DANCE_KEYS].sort()).toEqual(Object.keys(STYLES).sort());
	});

	it('shows the same label the settled ticket will display', () => {
		for (const { key, label } of DANCES) {
			expect(label, `picker label for "${key}" disagrees with the endpoint`).toBe(STYLES[key].label);
		}
	});

	it('has no duplicate keys', () => {
		expect(new Set(DANCE_KEYS).size).toBe(DANCE_KEYS.length);
	});

	it('danceLabel resolves a known key and passes an unknown one through', () => {
		expect(danceLabel('offabean')).toBe('Offabean');
		expect(danceLabel('nope')).toBe('nope');
	});
});

describe('club dance styles', () => {
	it('every clip named by a style is baked in the manifest', () => {
		for (const [key, style] of Object.entries(STYLES)) {
			const clips = style.sequence ? style.sequence.map((s) => s.clip) : [style.clip];
			for (const clip of clips) {
				expect(CLIP_NAMES.has(clip), `style "${key}" names unbaked clip "${clip}"`).toBe(true);
			}
		}
	});

	it('every style has an audio track that exists on disk', () => {
		for (const [key, style] of Object.entries(STYLES)) {
			const track = styleAudioFor(key);
			expect(track, `style "${key}" has no entry in TRACK_BY_DANCE`).toBeTruthy();
			expect(style.track, `style "${key}" declares a different track than the client resolves`).toBe(track);
			const hasAudio = ['mp3', 'ogg'].some((ext) =>
				existsSync(resolve(ROOT, `public/club/audio/${track}.${ext}`)),
			);
			expect(hasAudio, `no public/club/audio/${track}.{mp3,ogg}`).toBe(true);
		}
	});

	it('a sequence style declares the duration its steps add up to', () => {
		for (const [key, style] of Object.entries(STYLES)) {
			if (!style.sequence) continue;
			const sum = style.sequence.reduce((n, s) => n + s.durationSec, 0);
			expect(sum, `style "${key}" durationSec does not match its steps`).toBe(style.durationSec);
		}
	});

	it('a single-clip style never runs longer than the clip it loops', () => {
		const durationOf = new Map(manifest.map((c) => [c.name, c.duration]));
		for (const [key, style] of Object.entries(STYLES)) {
			if (style.sequence) continue;
			if (style.loop) continue; // a looping clip can be held for any duration
			expect(style.durationSec, `non-looping style "${key}" outlasts its clip`).toBeLessThanOrEqual(
				Math.ceil(durationOf.get(style.clip)),
			);
		}
	});
});
