import { describe, it, expect, vi } from 'vitest';
import { __test__ as idTest } from '../../api/animations/[id].js';
import { validateClipTrackStrides, materializeClip, __test__ as clipsTest } from '../../api/animations/clips.js';

const { patchSchema } = idTest;
const { MAX_BYTES_INLINE } = clipsTest;

// A minimal valid baked AnimationClip.toJSON() payload.
const validClip = {
	name: 'wave',
	duration: 2,
	tracks: [
		{ name: 'LeftArm.quaternion', type: 'quaternion', times: [0, 1, 2], values: new Array(12).fill(0) },
		{ name: 'Hips.position', type: 'vector', times: [0, 2], values: [0, 0, 0, 0, 0, 0] },
	],
};

const validEditorDoc = {
	duration: 2,
	fps: 30,
	loop: true,
	keyframes: [
		{ id: 'kf_1', time: 0, easing: 'ease-in-out', pose: { bones: { Hips: [0, 0, 0, 1] } } },
		{ time: 2, pose: { bones: { Hips: [0, 0, 0, 1] }, rootPosition: { x: 0, y: 1, z: 0 } } },
	],
};

describe('animation PATCH schema — re-saving edited keyframes (regression)', () => {
	it('accepts a metadata-only patch', () => {
		const r = patchSchema.safeParse({ name: 'Renamed', visibility: 'public' });
		expect(r.success).toBe(true);
	});

	it('accepts clip + editor_doc + fps so edits persist (previously stripped → data loss)', () => {
		const r = patchSchema.safeParse({ name: 'Updated', clip: validClip, editor_doc: validEditorDoc, fps: 24 });
		expect(r.success).toBe(true);
		expect(r.data.clip).toBeDefined();
		expect(r.data.editor_doc).toBeDefined();
		expect(r.data.fps).toBe(24);
	});

	it('rejects a malformed clip (no tracks) on update', () => {
		expect(patchSchema.safeParse({ clip: { name: 'a', duration: 1, tracks: [] } }).success).toBe(false);
	});

	it('allows nulling fps and avatar_id', () => {
		const r = patchSchema.safeParse({ fps: null, avatar_id: null });
		expect(r.success).toBe(true);
	});
});

describe('validateClipTrackStrides', () => {
	it('passes a clip with correct quaternion (×4) and position (×3) strides', () => {
		expect(validateClipTrackStrides(validClip)).toBeNull();
	});

	it('rejects a quaternion track whose values are not times×4', () => {
		const bad = {
			...validClip,
			tracks: [{ name: 'Hips.quaternion', type: 'quaternion', times: [0, 1], values: [0, 0, 0] }],
		};
		expect(validateClipTrackStrides(bad)).toMatch(/Hips\.quaternion/);
	});
});

describe('materializeClip', () => {
	it('inlines a small clip as JSON with no R2 key', async () => {
		const { inlineClip, storageKey, error } = await materializeClip(validClip, { userId: 'u1', slug: 'wave' });
		expect(error).toBeUndefined();
		expect(storageKey).toBeNull();
		expect(typeof inlineClip).toBe('string');
		expect(JSON.parse(inlineClip).name).toBe('wave');
	});

	it('keeps the inline ceiling sane (R2 offload threshold is in bytes)', () => {
		expect(MAX_BYTES_INLINE).toBeGreaterThan(100_000);
	});
});
