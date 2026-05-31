import { describe, it, expect } from 'vitest';
import { Quaternion, Euler, AnimationClip } from 'three';
import {
	createDocument,
	upsertKeyframe,
	removeKeyframe,
	moveKeyframe,
	setKeyframeEasing,
	clampKeyframesToDuration,
	sampleAtTime,
	bakeClip,
	serializeClip,
	EASINGS,
	DEFAULT_EASING,
} from '../src/pose-animation.js';

// Build a canonical pose with a single rotated bone (rest = identity elsewhere).
function poseWithArm(angle) {
	const q = new Quaternion().setFromEuler(new Euler(0, 0, angle, 'XYZ'));
	return {
		bones: {
			Hips: [0, 0, 0, 1],
			LeftArm: [q.x, q.y, q.z, q.w],
		},
		rootPosition: { x: 0, y: 0, z: 0 },
	};
}

describe('pose-animation document model', () => {
	it('upsert keeps keyframes sorted and dedupes by time', () => {
		const doc = createDocument({ duration: 4 });
		upsertKeyframe(doc, 2, poseWithArm(0.5));
		upsertKeyframe(doc, 0, poseWithArm(0));
		expect(doc.keyframes.map((k) => k.time)).toEqual([0, 2]);

		// Re-dropping at ~the same time updates the existing keyframe, no new slot.
		const before = doc.keyframes.length;
		upsertKeyframe(doc, 2.0005, poseWithArm(1.2));
		expect(doc.keyframes.length).toBe(before);
	});

	it('clamps keyframe times to the document duration', () => {
		const doc = createDocument({ duration: 4 });
		upsertKeyframe(doc, 3.9, poseWithArm(1));
		doc.duration = 2;
		clampKeyframesToDuration(doc);
		expect(doc.keyframes[0].time).toBeLessThanOrEqual(2);
	});

	it('remove and retime work by id', () => {
		const doc = createDocument({ duration: 4 });
		const a = upsertKeyframe(doc, 0, poseWithArm(0));
		const b = upsertKeyframe(doc, 1, poseWithArm(1));
		moveKeyframe(doc, a.id, 3); // a now after b → must re-sort
		expect(doc.keyframes[0].id).toBe(b.id);
		expect(removeKeyframe(doc, b.id)).toBe(true);
		expect(doc.keyframes).toHaveLength(1);
	});
});

describe('sampleAtTime interpolation', () => {
	it('returns null with no keyframes, the pose with one', () => {
		const doc = createDocument();
		expect(sampleAtTime(doc, 0)).toBeNull();
		upsertKeyframe(doc, 1, poseWithArm(0.7));
		const p = sampleAtTime(doc, 0.3);
		expect(p.bones.LeftArm).toBeDefined();
	});

	it('slerps the midpoint to a unit quaternion between the two keyframes', () => {
		const doc = createDocument({ duration: 2 });
		upsertKeyframe(doc, 0, poseWithArm(0), 'linear');
		upsertKeyframe(doc, 2, poseWithArm(Math.PI / 2), 'linear');

		const mid = sampleAtTime(doc, 1);
		const q = new Quaternion(...mid.bones.LeftArm);
		// Unit length preserved (no lerp drift).
		expect(q.length()).toBeCloseTo(1, 5);

		// Halfway slerp of a 90° z-rotation is exactly 45°.
		const expected = new Quaternion().setFromEuler(new Euler(0, 0, Math.PI / 4, 'XYZ'));
		expect(Math.abs(q.dot(expected))).toBeCloseTo(1, 4);
	});

	it('holds the endpoints outside the keyframe range', () => {
		const doc = createDocument({ duration: 4 });
		upsertKeyframe(doc, 1, poseWithArm(0.2), 'linear');
		upsertKeyframe(doc, 3, poseWithArm(0.9), 'linear');
		const start = sampleAtTime(doc, 0);
		const end = sampleAtTime(doc, 4);
		expect(start.bones.LeftArm).toEqual(doc.keyframes[0].pose.bones.LeftArm);
		expect(end.bones.LeftArm).toEqual(doc.keyframes[1].pose.bones.LeftArm);
	});

	it('easing changes the timing without changing the endpoints', () => {
		const lin = createDocument({ duration: 2 });
		upsertKeyframe(lin, 0, poseWithArm(0), 'linear');
		upsertKeyframe(lin, 2, poseWithArm(Math.PI / 2), 'linear');

		const eased = createDocument({ duration: 2 });
		upsertKeyframe(eased, 0, poseWithArm(0), 'ease-in');
		upsertKeyframe(eased, 2, poseWithArm(Math.PI / 2), 'ease-in');

		const angle = (p) => 2 * Math.acos(Math.min(1, Math.abs(p.bones.LeftArm[3])));
		// Ease-in lags behind linear at the first quarter (t²=0.0625 < 0.25).
		expect(angle(sampleAtTime(eased, 0.5))).toBeLessThan(angle(sampleAtTime(lin, 0.5)));
		// Endpoints identical regardless of easing.
		expect(angle(sampleAtTime(eased, 2))).toBeCloseTo(angle(sampleAtTime(lin, 2)), 5);
	});

	it('every easing maps 0→0 and 1→1', () => {
		for (const fn of Object.values(EASINGS)) {
			expect(fn(0)).toBeCloseTo(0, 6);
			expect(fn(1)).toBeCloseTo(1, 6);
		}
		expect(EASINGS[DEFAULT_EASING]).toBeTypeOf('function');
	});
});

describe('bakeClip → toJSON → parse round-trip', () => {
	function walkDoc() {
		const doc = createDocument({ name: 'wave', duration: 2, fps: 24, loop: true });
		upsertKeyframe(doc, 0, poseWithArm(0));
		upsertKeyframe(doc, 1, poseWithArm(Math.PI / 3));
		upsertKeyframe(doc, 2, poseWithArm(0));
		return doc;
	}

	it('bakes canonical track names matching the three.ws clip schema', () => {
		const clip = bakeClip(walkDoc());
		expect(clip).toBeInstanceOf(AnimationClip);
		expect(clip.name).toBe('wave');
		expect(clip.duration).toBeGreaterThan(0);

		const names = clip.tracks.map((t) => t.name);
		expect(names).toContain('LeftArm.quaternion');
		expect(names).toContain('Hips.position');
		// Track name = "<CanonicalBone>.<property>".
		for (const t of clip.tracks) expect(t.name).toMatch(/^[A-Za-z0-9]+\.(quaternion|position)$/);
	});

	it('produces JSON that AnimationClip.parse accepts and round-trips', () => {
		const json = serializeClip(walkDoc());
		expect(json).toHaveProperty('name', 'wave');
		expect(json).toHaveProperty('duration');
		expect(Array.isArray(json.tracks)).toBe(true);

		const reparsed = AnimationClip.parse(json);
		expect(reparsed).toBeInstanceOf(AnimationClip);
		expect(reparsed.tracks.length).toBe(json.tracks.length);
		// No NaN leaked into any keyframe value.
		for (const t of reparsed.tracks) {
			for (const v of t.values) expect(Number.isNaN(v)).toBe(false);
		}
	});

	it('honors a custom bone-name resolver (for GLB embedding)', () => {
		const clip = bakeClip(walkDoc(), {
			resolveBoneName: (k) => (k === 'LeftArm' ? 'mixamorigLeftArm' : null),
			rootName: 'mannequin-root',
		});
		const names = clip.tracks.map((t) => t.name);
		expect(names).toContain('mixamorigLeftArm.quaternion');
		expect(names).toContain('mannequin-root.position');
		// Hips was resolved to null → dropped.
		expect(names.some((n) => n.startsWith('Hips.'))).toBe(false);
	});

	it('throws when baking an empty document', () => {
		expect(() => bakeClip(createDocument())).toThrow(/keyframe/i);
	});
});
