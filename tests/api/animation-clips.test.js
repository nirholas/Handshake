import { describe, it, expect } from 'vitest';
import { __test__ } from '../../api/animations/clips.js';

const { createSchema, clipSchema, editorDocSchema, autoSlug, encodeCursor, decodeCursor, listItem } = __test__;

// A minimal valid baked AnimationClip.toJSON() payload.
const validClip = {
	name: 'wave',
	duration: 2,
	tracks: [
		{ name: 'LeftArm.quaternion', type: 'quaternion', times: [0, 1, 2], values: new Array(12).fill(0) },
		{ name: 'Hips.position', type: 'vector', times: [0, 2], values: [0, 0, 0, 0, 0, 0] },
	],
};

describe('animation-clips create schema', () => {
	it('accepts a well-formed create payload', () => {
		const r = createSchema.safeParse({
			name: 'My Wave',
			visibility: 'public',
			tags: ['greeting', 'loop'],
			fps: 30,
			loop: true,
			clip: validClip,
		});
		expect(r.success).toBe(true);
	});

	it('rejects empty name and a clip with no tracks', () => {
		expect(createSchema.safeParse({ name: '', clip: validClip }).success).toBe(false);
		expect(createSchema.safeParse({ name: 'x', clip: { name: 'a', duration: 1, tracks: [] } }).success).toBe(false);
	});

	it('rejects bad slug, bad visibility, and oversized fps', () => {
		expect(createSchema.safeParse({ name: 'x', slug: 'Has Spaces', clip: validClip }).success).toBe(false);
		expect(createSchema.safeParse({ name: 'x', visibility: 'secret', clip: validClip }).success).toBe(false);
		expect(createSchema.safeParse({ name: 'x', fps: 9999, clip: validClip }).success).toBe(false);
	});

	it('rejects a non-uuid avatar_id', () => {
		expect(createSchema.safeParse({ name: 'x', avatar_id: 'not-a-uuid', clip: validClip }).success).toBe(false);
	});

	it('accepts an optional editor_doc and validates its keyframes', () => {
		const ok = createSchema.safeParse({
			name: 'x',
			clip: validClip,
			editor_doc: {
				duration: 2,
				fps: 30,
				loop: true,
				keyframes: [
					{ id: 'kf_1', time: 0, easing: 'ease-in-out', pose: { bones: { Hips: [0, 0, 0, 1] } } },
					{ time: 2, pose: { bones: { Hips: [0, 0, 0, 1] }, rootPosition: { x: 0, y: 1, z: 0 } } },
				],
			},
		});
		expect(ok.success).toBe(true);
	});
});

describe('clipSchema track validation', () => {
	it('requires name/type/times/values on every track', () => {
		expect(clipSchema.safeParse({ name: 'a', duration: 1, tracks: [{ name: 'X.quaternion' }] }).success).toBe(false);
	});
});

describe('editorDocSchema', () => {
	it('requires a duration and a pose.bones map per keyframe', () => {
		expect(editorDocSchema.safeParse({ keyframes: [] }).success).toBe(false); // no duration
		expect(editorDocSchema.safeParse({ duration: 1, keyframes: [{ time: 0 }] }).success).toBe(false); // no pose
	});
});

describe('autoSlug', () => {
	it('lowercases, hyphenates, and suffixes', () => {
		const s = autoSlug('My Cool Walk Cycle!');
		expect(s).toMatch(/^my-cool-walk-cycle-[a-z0-9]{4}$/);
	});
	it('falls back to "animation" for empty input', () => {
		expect(autoSlug('!!!')).toMatch(/^animation-[a-z0-9]{4}$/);
	});
});

describe('cursor round-trip', () => {
	it('encodes and decodes a created_at cursor', () => {
		const now = new Date('2026-05-31T12:00:00.000Z');
		const cur = encodeCursor({ createdAt: now });
		const back = decodeCursor(cur);
		expect(back.createdAt.toISOString()).toBe(now.toISOString());
	});
	it('returns null for a garbage cursor', () => {
		expect(decodeCursor('@@@not-base64@@@')).toBeNull();
	});
});

describe('listItem projection', () => {
	const row = {
		id: 'id-1', owner_id: 'owner-1', slug: 'wave', name: 'Wave', description: null,
		kind: 'loop', format: 'three.ws.animation.v1', duration_ms: 2000, frame_count: 3,
		fps: 30, loop: true, tags: ['hi'], visibility: 'public', avatar_id: null,
		thumbnail_key: null, price_amount: null, price_currency: null, listed: false,
		play_count: 5, purchase_count: 0, created_at: 'now', updated_at: 'now',
	};

	it('marks the owner as self and hides price when unpriced', () => {
		const item = listItem(row, { userId: 'owner-1' });
		expect(item.owner).toBe('self');
		expect(item.price).toBeNull();
		expect(item.duration).toBe(2);
		expect(item.thumbnail_url).toBeNull();
	});

	it('marks non-owner as other and surfaces a price when set', () => {
		const priced = { ...row, price_amount: '1.5', price_currency: 'USDC', listed: true };
		const item = listItem(priced, { userId: 'someone-else' });
		expect(item.owner).toBe('other');
		expect(item.price).toEqual({ amount: '1.5', currency: 'USDC' });
		expect(item.listed).toBe(true);
	});
});
