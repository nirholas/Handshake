import { describe, it, expect } from 'vitest';

import {
	WARMUP_QUERIES,
	extractWarmValue,
	run,
} from '../api/_lib/x402/pipelines/avatar-search-warmup.js';
import { getFullRegistry } from '../api/_lib/x402/autonomous-registry.js';

const avatar = (over = {}) => ({
	id: '11111111-1111-1111-1111-111111111111',
	name: 'Robo',
	slug: 'robo',
	thumbnail_url: 'https://three.ws/cdn/t/robo.png',
	...over,
});

describe('avatar search warmup — query set', () => {
	it('warms exactly 20 distinct queries', () => {
		expect(WARMUP_QUERIES).toHaveLength(20);
		expect(new Set(WARMUP_QUERIES).size).toBe(20); // no duplicates
	});
});

describe('avatar search warmup — MCP response parsing', () => {
	it('extracts the ranked slice and thumbnails from structuredContent', () => {
		const body = {
			result: {
				structuredContent: {
					avatars: [avatar(), avatar({ id: '2', slug: 'r2', thumbnail_url: null }), avatar({ id: '3', slug: 'r3' })],
				},
			},
		};
		const out = extractWarmValue(body);
		expect(out.hasResult).toBe(true);
		expect(out.resultCount).toBe(3);
		expect(out.topResults).toHaveLength(3);
		// Only non-null thumbnails are surfaced (validates the pipeline resolved imagery).
		expect(out.thumbnails).toEqual([
			'https://three.ws/cdn/t/robo.png',
			'https://three.ws/cdn/t/robo.png',
		]);
		expect(out.topResults[0]).toMatchObject({ id: avatar().id, name: 'Robo', slug: 'robo' });
	});

	it('caps the stored slice at 8 results even when more are returned', () => {
		const avatars = Array.from({ length: 12 }, (_, i) => avatar({ id: String(i), slug: `a${i}` }));
		const out = extractWarmValue({ result: { structuredContent: { avatars } } });
		expect(out.resultCount).toBe(12);
		expect(out.topResults).toHaveLength(8);
	});

	it('returns hasResult=false (not throw) on a malformed/error body', () => {
		expect(extractWarmValue(null).hasResult).toBe(false);
		expect(extractWarmValue({ error: { code: -32000 } }).hasResult).toBe(false);
		expect(extractWarmValue({ result: {} }).hasResult).toBe(false);
		expect(extractWarmValue({ result: { structuredContent: { avatars: [] } } })).toMatchObject({
			hasResult: true,
			resultCount: 0,
			thumbnails: [],
		});
	});
});

describe('avatar search warmup — registry wiring', () => {
	it('is registered as an enabled, 6-hourly, run()-style discovery entry on /api/mcp', () => {
		const entry = getFullRegistry().find((e) => e.id === 'avatar-search-index-warmup');
		expect(entry).toBeTruthy();
		expect(entry.enabled).toBe(true);
		expect(entry.pipeline).toBe('discovery');
		expect(entry.cooldown_s).toBe(21600);
		expect(typeof entry.run).toBe('function');
		expect(entry.path).toBe('/api/mcp');
	});
});

describe('avatar search warmup — graceful degradation', () => {
	it('never throws when the DB/wallet are unconfigured; returns a skipped outcome', async () => {
		const out = await run({ runId: '00000000-0000-0000-0000-000000000003' });
		expect(out).toMatchObject({ success: false, skipped: true });
		expect(out.amountAtomic).toBe(0);
		expect(typeof out.errorMsg).toBe('string');
	});
});
