import { describe, it, expect } from 'vitest';
import { __test__ } from '../../api/marketplace/animations.js';

const { shape, encodeCursor, decodeCursor, SORTS } = __test__;

const UUID = '11111111-2222-3333-4444-555555555555';

const baseRow = {
	id: UUID,
	slug: 'spin-kick',
	name: 'Spin Kick',
	description: 'A crisp roundhouse loop.',
	kind: 'loop',
	duration_ms: 2400,
	frame_count: 6,
	fps: 30,
	loop: true,
	tags: ['combat', 'loop'],
	thumbnail_key: null,
	price_amount: '2.5',
	price_currency: 'USDC',
	artifact_bytes: '248400',
	play_count: '12',
	purchase_count: '3',
	created_at: '2026-06-15T00:00:00.000Z',
	creator_name: 'Mira',
	creator_username: 'mira',
	creator_avatar: null,
};

describe('marketplace/animations shape', () => {
	it('projects a paid listing with price + download route', () => {
		const out = shape(baseRow);
		expect(out.id).toBe(UUID);
		expect(out.price).toEqual({ amount: '2.5', currency: 'USDC' });
		expect(out.free).toBe(false);
		expect(out.duration).toBe(2.4);
		expect(out.size_bytes).toBe(248400);
		expect(out.play_count).toBe(12);
		expect(out.purchase_count).toBe(3);
		expect(out.download_url).toBe(`/api/x402/animation-download?id=${UUID}`);
		expect(out.creator).toEqual({ name: 'Mira', username: 'mira', avatar_url: null });
	});

	it('marks a free listing and never leaks the baked clip', () => {
		const out = shape({ ...baseRow, price_amount: null, price_currency: null });
		expect(out.free).toBe(true);
		expect(out.price).toBeNull();
		// The feed surface must only ever carry metadata — never the motion data.
		expect(out).not.toHaveProperty('clip');
		expect(out).not.toHaveProperty('editor_doc');
	});

	it('defaults currency to USDC and falls back to a creator name', () => {
		const out = shape({ ...baseRow, price_currency: null, creator_name: null });
		expect(out.price.currency).toBe('USDC');
		expect(out.creator.name).toBe('mira');
		const anon = shape({ ...baseRow, creator_name: null, creator_username: null });
		expect(anon.creator.name).toBe('Anonymous');
	});
});

describe('marketplace/animations cursor', () => {
	it('round-trips a created_at cursor', () => {
		const cur = encodeCursor({ createdAt: baseRow.created_at });
		const back = decodeCursor(cur);
		expect(back.createdAt.toISOString()).toBe(baseRow.created_at);
	});
	it('returns null for a malformed cursor', () => {
		expect(decodeCursor('@@not-base64@@')).toBeNull();
	});
	// A cursor that decodes cleanly but carries an unparseable timestamp used to
	// become an Invalid Date, reach Postgres as a bind parameter, and take the
	// whole feed down with a 500. It is a bad cursor: drop it, serve page one.
	it('returns null for a well-formed cursor holding an unparseable date', () => {
		for (const bad of ['not-a-date', '', null, {}]) {
			const cur = Buffer.from(JSON.stringify({ c: bad })).toString('base64url');
			expect(decodeCursor(cur), `cursor carrying ${JSON.stringify(bad)}`).toBeNull();
		}
	});
});

describe('marketplace/animations sort whitelist', () => {
	it('exposes the four sortable orders', () => {
		expect(Object.keys(SORTS).sort()).toEqual(['popular', 'price_high', 'price_low', 'recent']);
	});
});
