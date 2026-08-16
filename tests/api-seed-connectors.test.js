// Unit coverage for the public memory-seed connectors under api/seed/.
//
// Three behaviours are locked here because each one was a real defect:
//   * the Farcaster connector shipped a "connector not configured" card on any
//     deployment without NEYNAR_API_KEY, even though the platform's shared
//     client has a keyless hub lane. shapeCasts is the boundary that turns that
//     lane's raw messages into the connector's payload, and it must report an
//     unknown engagement as null rather than 0.
//   * a hub answers "no such fname" with HTTP 400 and a NotFound detail, so
//     without the mapping below a typo'd handle read as an upstream outage.
//   * the X topic extractor carried a no-op replace that claimed to preserve
//     hashtags and handles. It now really does, and this pins that.

import { describe, it, expect, vi, afterEach } from 'vitest';

import { shapeCasts } from '../api/seed/farcaster.js';
import { extractTopTopics } from '../api/seed/x.js';

describe('shapeCasts (Farcaster connector payload)', () => {
	const neynarCasts = [
		{ text: 'Shipping the new retargeting pipeline today', timestamp: 1_700_000_000_000, isReply: false, engagement: 42 },
		{ text: 'https://example.com', timestamp: 1_700_000_100_000, isReply: false, engagement: 99 },
		{ text: 'A reply that should never be seeded here', timestamp: 1_700_000_200_000, isReply: true, engagement: 500 },
		{ text: 'Second substantive cast about avatars', timestamp: 1_700_000_300_000, isReply: false, engagement: 7 },
	];

	it('keeps substantive top-level casts, ranked by engagement', () => {
		const out = shapeCasts(neynarCasts);
		expect(out.map((c) => c.text)).toEqual([
			'Shipping the new retargeting pipeline today',
			'Second substantive cast about avatars',
		]);
		expect(out[0].engagement).toBe(42);
		expect(out[0].timestamp).toBe(new Date(1_700_000_000_000).toISOString());
	});

	it('reports engagement as null on the keyless hub lane instead of zero', () => {
		const out = shapeCasts([
			{ text: 'A cast served by a public hub, no reaction counts', timestamp: 1_700_000_000_000, isReply: false, engagement: null },
		]);
		expect(out).toHaveLength(1);
		expect(out[0].engagement).toBeNull();
	});

	it('drops casts with an unusable timestamp to a null rather than an invalid date', () => {
		const out = shapeCasts([
			{ text: 'A cast whose hub timestamp did not parse at all', timestamp: null, isReply: false, engagement: null },
		]);
		expect(out[0].timestamp).toBeNull();
	});

	it('honours the return limit', () => {
		const many = Array.from({ length: 30 }, (_, i) => ({
			text: `Cast number ${i} with enough substance to survive`,
			timestamp: 1_700_000_000_000 + i,
			isReply: false,
			engagement: i,
		}));
		expect(shapeCasts(many, 5)).toHaveLength(5);
	});
});

describe('extractTopTopics (X connector)', () => {
	it('ranks repeated substantive tokens and preserves hashtags and handles', () => {
		const topics = extractTopTopics([
			'Building #solana agents with @three_ws today',
			'More #solana agents, always #solana',
			'agents everywhere',
		]);
		const byTopic = Object.fromEntries(topics.map((t) => [t.topic, t.count]));
		expect(byTopic['#solana']).toBe(3);
		expect(byTopic.agents).toBe(3);
		expect(byTopic['@three_ws']).toBe(1);
		expect(topics[0].topic).toMatch(/^(#solana|agents)$/);
	});

	it('strips URLs and stopwords, and survives an empty timeline', () => {
		const topics = extractTopTopics(['the a of to https://example.com/deep/link', '', null]);
		expect(topics).toEqual([]);
		expect(extractTopTopics([])).toEqual([]);
	});

	it('caps the result at the requested limit', () => {
		const text = 'avatars rigging retarget skeleton animation blender mixamo vrm glb meshopt';
		expect(extractTopTopics([text, text], 4)).toHaveLength(4);
	});
});

describe('farcaster hub lane not-found mapping', () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
		vi.resetModules();
	});

	it('maps a hub 400 carrying a NotFound detail to a 404 error', async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response(
				JSON.stringify({
					error: 'Failed to get username proof',
					error_detail: 'status: NotFound, message: "Username proof not found"',
				}),
				{ status: 400, headers: { 'content-type': 'application/json' } },
			),
		);
		const { resolveFarcasterUser } = await import('../api/_lib/farcaster-client.js');
		await expect(resolveFarcasterUser({ fname: 'definitely-not-a-real-fname' })).rejects.toMatchObject({
			status: 404,
			code: 'farcaster_user_not_found',
		});
	});

	it('leaves a genuine hub failure as an upstream error', async () => {
		globalThis.fetch = vi.fn(async () => new Response('gateway blew up', { status: 502 }));
		const { resolveFarcasterUser } = await import('../api/_lib/farcaster-client.js');
		await expect(resolveFarcasterUser({ fname: 'dwr' })).rejects.toMatchObject({ status: 502 });
	});
});
