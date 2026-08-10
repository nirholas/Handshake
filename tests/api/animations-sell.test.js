import { describe, it, expect } from 'vitest';
import { __test__ } from '../../api/animations/sell.js';

const { listSchema, delistSchema, shape, resolvePayto, resolveArtifactBytes } = __test__;

const UUID = '11111111-2222-3333-4444-555555555555';
const NS_KEY = `u/${UUID}/animations/spin-kick-12.glb`;
const BASE_ADDR = '0x' + 'a'.repeat(40);
const SOL_ADDR = 'So11111111111111111111111111111111111111112';

describe('animations/sell listSchema', () => {
	it('accepts a well-formed paid listing and applies defaults', () => {
		const r = listSchema.safeParse({ id: UUID, price: 2.5, artifact_key: NS_KEY });
		expect(r.success).toBe(true);
		expect(r.data.currency).toBe('USDC');
		expect(r.data.artifact_mime).toBe('model/gltf-binary');
		expect(r.data.listed).toBe(true);
	});

	it('accepts a free listing (price omitted / zero)', () => {
		expect(listSchema.safeParse({ id: UUID, artifact_key: NS_KEY }).success).toBe(true);
		expect(listSchema.safeParse({ id: UUID, price: 0, artifact_key: NS_KEY }).success).toBe(true);
	});

	it('accepts valid payout addresses', () => {
		const r = listSchema.safeParse({ id: UUID, artifact_key: NS_KEY, payto_base: BASE_ADDR, payto_solana: SOL_ADDR });
		expect(r.success).toBe(true);
	});

	it('rejects a non-uuid id and a missing artifact_key', () => {
		expect(listSchema.safeParse({ id: 'nope', artifact_key: NS_KEY }).success).toBe(false);
		expect(listSchema.safeParse({ id: UUID }).success).toBe(false);
	});

	it('rejects a negative price and a price over the ceiling', () => {
		expect(listSchema.safeParse({ id: UUID, price: -1, artifact_key: NS_KEY }).success).toBe(false);
		expect(listSchema.safeParse({ id: UUID, price: 100_001, artifact_key: NS_KEY }).success).toBe(false);
	});

	it('rejects an unsupported currency, bad mime, and malformed payout addresses', () => {
		expect(listSchema.safeParse({ id: UUID, artifact_key: NS_KEY, currency: 'SOL' }).success).toBe(false);
		expect(listSchema.safeParse({ id: UUID, artifact_key: NS_KEY, artifact_mime: 'image/png' }).success).toBe(false);
		expect(listSchema.safeParse({ id: UUID, artifact_key: NS_KEY, payto_base: '0x123' }).success).toBe(false);
		expect(listSchema.safeParse({ id: UUID, artifact_key: NS_KEY, payto_solana: 'not!base58!' }).success).toBe(false);
	});
});

describe('animations/sell delistSchema', () => {
	it('requires the delist action and a uuid', () => {
		expect(delistSchema.safeParse({ id: UUID, action: 'delist' }).success).toBe(true);
		expect(delistSchema.safeParse({ id: UUID, action: 'list' }).success).toBe(false);
		expect(delistSchema.safeParse({ id: 'nope', action: 'delist' }).success).toBe(false);
	});
});

describe('animations/sell shape projection', () => {
	const baseRow = {
		id: UUID, slug: 'spin-kick', name: 'Spin Kick', visibility: 'private', listed: true,
		artifact_bytes: '248400', artifact_mime: 'model/gltf-binary', thumbnail_key: null, purchase_count: '3',
	};
	const payto = { base: BASE_ADDR, solana: SOL_ADDR, bsc: null };

	it('surfaces a price object when priced and coerces numeric fields', () => {
		const out = shape({ ...baseRow, price_amount: '2.5', price_currency: 'USDC' }, payto);
		expect(out.price).toEqual({ amount: '2.5', currency: 'USDC' });
		expect(out.artifact_bytes).toBe(248400);
		expect(out.purchase_count).toBe(3);
		expect(out.payout).toEqual({ base: BASE_ADDR, solana: SOL_ADDR, bsc: null });
		expect(out.thumbnail_url).toBeNull();
	});

	it('returns a null price for a free listing', () => {
		const out = shape({ ...baseRow, price_amount: null, price_currency: null }, payto);
		expect(out.price).toBeNull();
		expect(out.listed).toBe(true);
	});
});

describe('animations/sell resolvePayto', () => {
	it('uses explicit overrides without touching the DB when all are supplied', async () => {
		const out = await resolvePayto(UUID, { payto_base: BASE_ADDR, payto_solana: SOL_ADDR, payto_bsc: BASE_ADDR });
		expect(out).toEqual({ base: BASE_ADDR, solana: SOL_ADDR, bsc: BASE_ADDR });
	});
});

describe('animations/sell resolveArtifactBytes', () => {
	const KEY = 'u/owner/animations/spin-1.glb';

	it('takes the size the caller measured', () => {
		expect(resolveArtifactBytes({ artifact_key: KEY, artifact_bytes: 4096 }, { artifact_key: KEY, artifact_bytes: 1024 })).toBe(4096);
	});

	it('keeps the stored size when a re-price re-sends the same key without one', () => {
		// Regression: a bare re-price blanked artifact_bytes, so the marketplace
		// card lost the download size a buyer decides on.
		expect(resolveArtifactBytes({ artifact_key: KEY }, { artifact_key: KEY, artifact_bytes: 1024 })).toBe(1024);
	});

	it('drops a stale size when the artifact itself changed', () => {
		expect(resolveArtifactBytes({ artifact_key: 'u/owner/animations/spin-2.glb' }, { artifact_key: KEY, artifact_bytes: 1024 })).toBeNull();
	});

	it('reports null when nothing has ever been measured', () => {
		expect(resolveArtifactBytes({ artifact_key: KEY }, { artifact_key: KEY, artifact_bytes: null })).toBeNull();
	});
});
