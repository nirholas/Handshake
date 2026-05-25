import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Polyfill required for three's AnimationClip.parse in node.
globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.document = { createElementNS: () => ({}) };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const MANIFEST = resolve(ROOT, 'public/animations/manifest.json');
const CLIPS_DIR = resolve(ROOT, 'public/animations/clips');

// Canonical Avaturn bone set — strip prefix to match track target names.
// Derived from cz.glb (scripts/build-animations.mjs reference rig).
const AVATURN_BONES = new Set([
	'Hips',
	'LeftUpLeg',
	'LeftLeg',
	'LeftFoot',
	'LeftToeBase',
	'Spine',
	'Spine1',
	'Spine2',
	'Neck',
	'Head',
	'LeftShoulder',
	'LeftArm',
	'LeftForeArm',
	'LeftHand',
	'LeftHandIndex1',
	'LeftHandIndex2',
	'LeftHandIndex3',
	'LeftHandMiddle1',
	'LeftHandMiddle2',
	'LeftHandMiddle3',
	'LeftHandPinky1',
	'LeftHandPinky2',
	'LeftHandPinky3',
	'LeftHandRing1',
	'LeftHandRing2',
	'LeftHandRing3',
	'LeftHandThumb1',
	'LeftHandThumb2',
	'LeftHandThumb3',
	'RightShoulder',
	'RightArm',
	'RightForeArm',
	'RightHand',
	'RightHandIndex1',
	'RightHandIndex2',
	'RightHandIndex3',
	'RightHandMiddle1',
	'RightHandMiddle2',
	'RightHandMiddle3',
	'RightHandPinky1',
	'RightHandPinky2',
	'RightHandPinky3',
	'RightHandRing1',
	'RightHandRing2',
	'RightHandRing3',
	'RightHandThumb1',
	'RightHandThumb2',
	'RightHandThumb3',
	'RightUpLeg',
	'RightLeg',
	'RightFoot',
	'RightToeBase',
]);

let manifest;
let AnimationClip;
let parsedClips; // pre-parsed cache: { name, clip }[] — loaded once for all clip tests

beforeAll(async () => {
	expect(existsSync(MANIFEST), `manifest not found — run npm run build:animations`).toBe(true);
	manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
	({ AnimationClip } = await import('three'));

	// Parse all 67+ JSON animation files once so each test suite doesn't repeat
	// the ~80 MB parse. Total parse time is ~60s on a cold Codespace — captured
	// in beforeAll's hookTimeout rather than individual test timeouts.
	parsedClips = manifest.map((entry) => {
		const file = resolve(ROOT, 'public', entry.url.replace(/^\//, ''));
		const json = JSON.parse(readFileSync(file, 'utf8'));
		return { name: entry.name, clip: AnimationClip.parse(json) };
	});
}, 120_000);

describe('animation manifest', () => {
	it('has at least one clip', () => {
		expect(manifest.length).toBeGreaterThan(0);
	});

	it('every entry has required fields', () => {
		for (const entry of manifest) {
			expect(entry.name, `entry missing name`).toBeTruthy();
			expect(entry.url, `${entry.name} missing url`).toBeTruthy();
			expect(entry.label, `${entry.name} missing label`).toBeTruthy();
			expect(typeof entry.loop, `${entry.name} loop must be boolean`).toBe('boolean');
		}
	});

	it('every url points at an existing file', () => {
		for (const entry of manifest) {
			const file = resolve(ROOT, 'public', entry.url.replace(/^\//, ''));
			expect(existsSync(file), `${entry.name}: file not found at ${entry.url}`).toBe(true);
		}
	});
});

describe('animation clips', () => {
	it('every clip parses as a valid AnimationClip', () => {
		for (const { name, clip } of parsedClips) {
			expect(clip.name, `${name}: clip.name`).toBe(name);
			expect(clip.duration, `${name}: duration must be > 0`).toBeGreaterThan(0);
			expect(clip.tracks.length, `${name}: must have tracks`).toBeGreaterThan(0);
		}
	});

	it('every track target resolves to a bone in the Avaturn reference rig', () => {
		const mismatches = [];
		for (const { name, clip } of parsedClips) {
			for (const track of clip.tracks) {
				const boneName = track.name.split('.')[0];
				if (!AVATURN_BONES.has(boneName)) {
					mismatches.push(`${name}: unknown bone "${boneName}"`);
				}
			}
		}
		expect(mismatches, mismatches.join('\n')).toHaveLength(0);
	});

	it('no track contains NaN keyframe values', () => {
		const nanTracks = [];
		for (const { name, clip } of parsedClips) {
			for (const track of clip.tracks) {
				for (const v of track.values) {
					if (Number.isNaN(v)) {
						nanTracks.push(`${name} / ${track.name}`);
						break;
					}
				}
			}
		}
		expect(nanTracks, `NaN found in: ${nanTracks.join(', ')}`).toHaveLength(0);
	});

	it('Hips.position values are in meter range (< 10m)', () => {
		for (const { name, clip } of parsedClips) {
			const hipsPos = clip.tracks.find((t) => t.name === 'Hips.position');
			if (!hipsPos) continue;

			const maxVal = Math.max(...hipsPos.values.map(Math.abs));
			expect(
				maxVal,
				`${name}: Hips.position max=${maxVal.toFixed(2)}m — avatar will float (scale issue)`,
			).toBeLessThan(10);
		}
	});
});
