/**
 * Motion seeding: gate, publishing shape, free rotation, lane assertion.
 *
 * Clips are built in-memory from the canonical rest skeleton, so the suite is
 * fast, deterministic and needs no fixtures on disk. The synthetic clips are
 * built the way the text2motion worker builds real ones (a quaternion track per
 * canonical body bone plus a Hips.position track), which is what lets these
 * tests assert the gate's real behaviour rather than a simplified stand-in.
 *
 * The thresholds these tests pin were derived from a 60-clip sample of the
 * authored Mixamo library: see docs/animation-seeding.md.
 */

import { describe, it, expect } from 'vitest';
import {
	gateMotionClip,
	MOTION_GATE,
	worldMotionMetrics,
	footContactMetrics,
	toLibraryClip,
	manifestEntryFor,
	mergeManifest,
	libraryClipName,
	isGeneratedClipName,
	freeClipNames,
	rotationEpoch,
	motionPrompts,
	motionPromptById,
} from '../api/_lib/motion-seed.js';
import { assertSelfHostedLane, decodeJobEnvelope } from '../scripts/gcp/seed-motion.mjs';

const BODY_BONES = [
	'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
	'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
	'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
	'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
	'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
];

/** A rotation of `angle` radians about X, as [x,y,z,w]. */
function quatX(angle) {
	return [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)];
}

/**
 * Build a clip whose bones swing smoothly, so it reads as real motion.
 * `swing` scales how far the limbs travel; `hipsTravel` moves the root forward.
 */
function buildClip({
	frames = 120,
	fps = 30,
	swing = 0.35,
	hipsTravel = 0,
	bones = BODY_BONES,
	mutate = null,
} = {}) {
	const times = Array.from({ length: frames }, (_, i) => i / fps);
	const tracks = [];
	for (const bone of bones) {
		const values = [];
		for (let i = 0; i < frames; i += 1) {
			// Each bone gets its own phase so the whole body is not one rigid unit.
			const phase = (bone.length % 7) * 0.4;
			values.push(...quatX(swing * Math.sin((i / frames) * Math.PI * 4 + phase)));
		}
		tracks.push({ type: 'quaternion', name: `${bone}.quaternion`, times: [...times], values });
	}
	const hips = [];
	for (let i = 0; i < frames; i += 1) {
		hips.push(0, 0.984 + 0.02 * Math.sin((i / frames) * Math.PI * 4), (hipsTravel * i) / frames);
	}
	tracks.push({ type: 'vector', name: 'Hips.position', times: [...times], values: hips });

	const clip = {
		name: 'synthetic',
		duration: (frames - 1) / fps,
		tracks,
		uuid: '11111111-2222-3333-4444-555555555555',
		blendMode: 0,
	};
	if (mutate) mutate(clip);
	return clip;
}

describe('motion prompt library', () => {
	it('loads prompts as data, each with the fields the seeder needs', () => {
		const prompts = motionPrompts();
		expect(prompts.length).toBeGreaterThan(50);
		for (const p of prompts) {
			expect(typeof p.id).toBe('string');
			expect(p.prompt.length).toBeGreaterThan(10);
			expect(typeof p.category).toBe('string');
		}
	});

	it('ids are unique, so a checkpoint can key on them', () => {
		const ids = motionPrompts().map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('looks a prompt up by id', () => {
		const first = motionPrompts()[0];
		expect(motionPromptById(first.id)).toEqual(first);
		expect(motionPromptById('no-such-prompt')).toBeNull();
	});
});

describe('gateMotionClip', () => {
	it('accepts a smooth, lively clip', () => {
		const verdict = gateMotionClip(buildClip({ hipsTravel: 1.2 }), { expectedDuration: 4 });
		expect(verdict.reasons).toEqual([]);
		expect(verdict.ok).toBe(true);
	});

	it('rejects a clip with no tracks', () => {
		expect(gateMotionClip({ duration: 4, tracks: [] }).reasons).toContain('no_tracks');
	});

	it('rejects NaN keyframes rather than publishing an avatar-breaking clip', () => {
		const clip = buildClip({
			mutate: (c) => {
				c.tracks[0].values[8] = Number.NaN;
			},
		});
		expect(gateMotionClip(clip).reasons).toContain('non_finite_keyframes');
	});

	it('rejects a clip missing the body chain a retarget needs', () => {
		const clip = buildClip({ bones: ['Hips', 'Spine', 'Head'] });
		const verdict = gateMotionClip(clip);
		expect(verdict.ok).toBe(false);
		expect(verdict.reasons.some((r) => r.startsWith('missing_bones'))).toBe(true);
	});

	it('rejects tracks naming bones the canonical skeleton does not have', () => {
		const clip = buildClip();
		clip.tracks.push({ type: 'quaternion', name: 'Tail.quaternion', times: [0], values: [0, 0, 0, 1] });
		expect(gateMotionClip(clip).reasons.some((r) => r.startsWith('foreign_bones'))).toBe(true);
	});

	it('rejects a frozen clip, measured in world space', () => {
		const clip = buildClip({ swing: 0 });
		expect(gateMotionClip(clip).reasons).toContain('frozen_clip');
	});

	it('rejects a clip the sampler returned at the wrong length', () => {
		const verdict = gateMotionClip(buildClip({ frames: 120 }), { expectedDuration: 9 });
		expect(verdict.reasons).toContain('duration_mismatch');
	});

	it('rejects quaternions that drifted off the unit sphere', () => {
		const clip = buildClip({
			mutate: (c) => {
				for (let i = 0; i < c.tracks[0].values.length; i += 1) c.tracks[0].values[i] *= 1.2;
			},
		});
		expect(gateMotionClip(clip).reasons).toContain('quaternions_not_normalized');
	});

	it('rejects a real world-space discontinuity', () => {
		// Teleport the root mid-clip: every joint jumps together, which is exactly
		// the visible defect the continuity test exists to catch.
		const clip = buildClip({
			mutate: (c) => {
				const hips = c.tracks.find((t) => t.name === 'Hips.position');
				for (let i = 60; i < hips.values.length / 3; i += 1) hips.values[i * 3] += 3;
			},
		});
		const verdict = gateMotionClip(clip);
		expect(verdict.ok).toBe(false);
		expect(verdict.reasons.some((r) => r.startsWith('world_discontinuity'))).toBe(true);
	});

	it('does NOT reject a 180 degree local twist the child bone cancels', () => {
		// The sampler emits these constantly. They are invisible on the mesh, so a
		// gate that rejects them rejects everything: this test pins that lesson.
		const clip = buildClip({ hipsTravel: 1.2 });
		const shoulder = clip.tracks.find((t) => t.name === 'LeftShoulder.quaternion');
		const forearm = clip.tracks.find((t) => t.name === 'LeftForeArm.quaternion');
		for (const track of [shoulder, forearm]) {
			for (let i = 40; i < track.values.length / 4; i += 2) {
				// Rotate a half turn about the bone's own axis on alternating frames.
				const [x, y, z, w] = track.values.slice(i * 4, i * 4 + 4);
				const half = quatX(Math.PI);
				track.values[i * 4] = w * half[0] + x * half[3];
				track.values[i * 4 + 1] = y * half[3] + z * half[0];
				track.values[i * 4 + 2] = z * half[3] - y * half[0];
				track.values[i * 4 + 3] = w * half[3] - x * half[0];
			}
		}
		const verdict = gateMotionClip(clip);
		expect(verdict.reasons.some((r) => r.startsWith('world_discontinuity'))).toBe(false);
	});

	it('reports metrics even when it rejects, so a batch can be tuned', () => {
		const verdict = gateMotionClip(buildClip({ swing: 0 }));
		expect(verdict.metrics.frames).toBe(120);
		expect(verdict.metrics.trackCount).toBeGreaterThan(20);
		expect(typeof verdict.metrics.worldTravel).toBe('number');
	});
});

describe('foot contact', () => {
	it('ignores floor work, where no foot bears weight', () => {
		// Hips pinned below the upright height: a fall or a breakdance flair. The
		// feet may travel freely without that counting as skating.
		const clip = buildClip({ hipsTravel: 2 });
		const hips = clip.tracks.find((t) => t.name === 'Hips.position');
		for (let i = 0; i < hips.values.length / 3; i += 1) hips.values[i * 3 + 1] = 0.15;
		expect(footContactMetrics(clip).plantedFrames).toBe(0);
	});

	it('derives the floor from the clip rather than assuming y = 0', () => {
		const metrics = footContactMetrics(buildClip());
		expect(Number.isFinite(metrics.floorY)).toBe(true);
	});
});

describe('worldMotionMetrics', () => {
	it('is scale free: a fast clip is not punished for being fast', () => {
		const slow = worldMotionMetrics(buildClip({ swing: 0.15 }));
		const fast = worldMotionMetrics(buildClip({ swing: 0.6 }));
		expect(fast.travel).toBeGreaterThan(slow.travel);
		expect(fast.continuity).toBeLessThan(MOTION_GATE.MAX_WORLD_STEP_RATIO);
		expect(slow.continuity).toBeLessThan(MOTION_GATE.MAX_WORLD_STEP_RATIO);
	});

	it('degrades safely on a clip too short to measure', () => {
		expect(worldMotionMetrics({ tracks: [] }).continuity).toBe(0);
	});
});

describe('publishing shape', () => {
	it('names generated clips apart from the mixamo import', () => {
		const name = libraryClipName('walk-forward-relaxed', 'task-abc');
		expect(name.startsWith('gen-')).toBe(true);
		expect(isGeneratedClipName(name)).toBe(true);
		expect(isGeneratedClipName('mx-135-degree-left-turn-c9cd')).toBe(false);
	});

	it('is stable for the same task and distinct across tasks', () => {
		expect(libraryClipName('a', 't1')).toBe(libraryClipName('a', 't1'));
		expect(libraryClipName('a', 't1')).not.toBe(libraryClipName('a', 't2'));
	});

	it('keeps the exact top-level shape the library already serves', () => {
		const raw = buildClip();
		const out = toLibraryClip(raw, {
			name: 'gen-x-1',
			promptId: 'x',
			prompt: 'a person waves',
			category: 'emote',
			loop: true,
			taskId: 't1',
		});
		expect(Object.keys(out).sort()).toEqual(['blendMode', 'duration', 'name', 'tracks', 'userData', 'uuid']);
		expect(out.tracks).toBe(raw.tracks);
		expect(out.userData.source).toBe('text2motion');
	});

	it('builds a manifest row matching the served entry shape', () => {
		const clip = toLibraryClip(buildClip(), {
			name: 'gen-x-1', promptId: 'x', prompt: 'p', category: 'emote', loop: false, taskId: 't',
		});
		const entry = manifestEntryFor(clip, { label: 'Wave', icon: '👋', loop: false, bytes: 10, url: 'https://cdn/x.json', thumb: null });
		expect(Object.keys(entry).sort()).toEqual(['bytes', 'duration', 'icon', 'label', 'loop', 'name', 'thumb', 'url']);
	});
});

describe('mergeManifest', () => {
	it('appends new rows and leaves the existing order untouched', () => {
		const existing = [{ name: 'mx-a' }, { name: 'mx-b' }];
		const merged = mergeManifest(existing, [{ name: 'gen-c' }]);
		expect(merged.map((e) => e.name)).toEqual(['mx-a', 'mx-b', 'gen-c']);
	});

	it('replaces a row in place on a re-run rather than duplicating it', () => {
		const merged = mergeManifest([{ name: 'gen-a', bytes: 1 }], [{ name: 'gen-a', bytes: 2 }]);
		expect(merged).toEqual([{ name: 'gen-a', bytes: 2 }]);
	});

	it('survives a missing manifest', () => {
		expect(mergeManifest(null, [{ name: 'gen-a' }])).toEqual([{ name: 'gen-a' }]);
	});
});

describe('rotating free subset', () => {
	const names = Array.from({ length: 60 }, (_, i) => `gen-clip-${i}`);

	it('picks a fixed-size subset', () => {
		expect(freeClipNames(names, { size: 12 })).toHaveLength(12);
	});

	it('is stable within an epoch, so a price does not flicker on reload', () => {
		const now = Date.UTC(2026, 8, 2);
		expect(freeClipNames(names, { now })).toEqual(freeClipNames(names, { now }));
	});

	it('rotates between epochs', () => {
		const a = freeClipNames(names, { now: Date.UTC(2026, 8, 2) });
		const b = freeClipNames(names, { now: Date.UTC(2026, 9, 2) });
		expect(a).not.toEqual(b);
	});

	it('never returns a name that is not in the collection', () => {
		for (const name of freeClipNames(names, { size: 12 })) expect(names).toContain(name);
	});

	it('advances the epoch weekly', () => {
		const t = Date.UTC(2026, 8, 2);
		expect(rotationEpoch(t + 7 * 24 * 3600 * 1000)).toBe(rotationEpoch(t) + 1);
	});
});

describe('lane assertion', () => {
	const envelope = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

	it('accepts our own text2motion Cloud Run worker', () => {
		const id = envelope({ mode: 'text2motion', taskId: 't1', baseUrl: 'https://model-text2motion-9374185604.us-east4.run.app' });
		expect(assertSelfHostedLane(id)).toEqual({ host: 'model-text2motion-9374185604.us-east4.run.app', taskId: 't1' });
	});

	it('refuses a paid third-party lane so bulk spend cannot leave the credits', () => {
		const id = envelope({ mode: 'text2motion', taskId: 't1', baseUrl: 'https://api.some-vendor.com' });
		expect(() => assertSelfHostedLane(id)).toThrow(/not a self-hosted Cloud Run lane/);
	});

	it('refuses another Cloud Run service that is not the motion worker', () => {
		const id = envelope({ mode: 'text2motion', taskId: 't1', baseUrl: 'https://model-trellis-123.us-central1.run.app' });
		expect(() => assertSelfHostedLane(id)).toThrow(/unexpected worker/);
	});

	it('refuses a job that is not a motion job', () => {
		const id = envelope({ mode: 'text23d', taskId: 't1', baseUrl: 'https://model-text2motion-1.us-east4.run.app' });
		expect(() => assertSelfHostedLane(id)).toThrow(/mode text23d/);
	});

	it('refuses an unreadable job id', () => {
		expect(decodeJobEnvelope('not-base64-json')).toBeNull();
		expect(() => assertSelfHostedLane('not-base64-json')).toThrow(/not a provider envelope/);
	});
});
