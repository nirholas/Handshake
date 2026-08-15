// Platform-wide agent-to-agent economy roll-up (api/_lib/agent-economy.js →
// platformEconomyStats). This is the single read behind the public A2A volume
// dashboard, so its contract must hold: real aggregates over real `agent_hires`
// rows, shaped into a stable payload, with an unmigrated ledger folding to a
// real zero (never a 500, never a fabricated number).
//
// The DB is mocked: a tagged-template `sql` that returns whatever the test
// queued for each successive query, in call order.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const queue = [];
vi.mock('../api/_lib/db.js', () => {
	const sql = vi.fn(async () => (queue.length ? queue.shift() : []));
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});
// avatarThumb pulls in r2 publicUrl — stub it so a thumbnail key resolves to a
// deterministic URL without real R2 config.
vi.mock('../api/_lib/r2.js', () => ({
	publicUrl: (key) => (key ? `https://cdn.test/${key}` : null),
}));

import { sql } from '../api/_lib/db.js';
import { platformEconomyStats } from '../api/_lib/agent-economy.js';

beforeEach(() => {
	queue.length = 0;
	sql.mockClear();
});

describe('platformEconomyStats', () => {
	it('shapes real aggregates across totals, daily, leaderboards, and feed', async () => {
		queue.push(
			// totals
			[{
				volume_usd: 1234.5, hires: 420, unique_hirers: 50, unique_providers: 30,
				avg_hire_usd: 2.94, volume_24h_usd: 88.2, hires_24h: 30,
				volume_7d_usd: 410.1, hires_7d: 140, pending_hires: 4,
				last_hire_at: '2026-06-29T00:00:00.000Z',
			}],
			// daily
			[
				{ day: '2026-06-27', volume_usd: 100, hires: 40 },
				{ day: '2026-06-28', volume_usd: 250.25, hires: 90 },
			],
			// top providers (one public w/ avatar, one private)
			[
				{ agent_id: 'p1', name: 'Oracle', linkable: true, thumb_key: 'thumb/p1.png', avatar_vis: 'public', earned_usd: 800, hires: 200, avg_rating: 4.6 },
				{ agent_id: 'p2', name: 'Nova', linkable: false, thumb_key: 'thumb/p2.png', avatar_vis: 'private', earned_usd: 300, hires: 90, avg_rating: null },
			],
			// top hirers
			[
				{ agent_id: 'h1', name: 'Trader', linkable: true, thumb_key: null, avatar_vis: null, spent_usd: 500, hires: 120 },
			],
			// recent
			[
				{ id: 'r1', skill_name: 'market-analysis', service_slug: 'mkt', usd: 0.005, amount_atomics: '5000', currency: 'USDC', network: 'solana', payment_signature: 'SIG1', completed_at: '2026-06-29T00:00:00.000Z', hirer_agent_id: 'h1', provider_agent_id: 'p1', hirer_name: 'Trader', provider_name: 'Oracle', hirer_linkable: true, provider_linkable: false },
			],
		);

		const r = await platformEconomyStats({ windowDays: 30, topLimit: 10, recentLimit: 12 });

		expect(sql).toHaveBeenCalledTimes(5);

		expect(r.totals.volume_usd).toBe(1234.5);
		expect(r.totals.hires).toBe(420);
		expect(r.totals.unique_hirers).toBe(50);
		expect(r.totals.unique_providers).toBe(30);
		expect(r.totals.avg_hire_usd).toBeCloseTo(2.94);
		expect(r.totals.pending_hires).toBe(4);
		expect(r.window_days).toBe(30);

		expect(r.daily).toHaveLength(2);
		expect(r.daily[1]).toEqual({ day: '2026-06-28', volume_usd: 250.25, hires: 90 });

		// Public provider keeps its profile URL + resolves a thumbnail; private one
		// is gated to no URL and no leaked avatar.
		expect(r.top_providers[0]).toMatchObject({ agent_id: 'p1', name: 'Oracle', url: '/agent/p1', earned_usd: 800, hires: 200, avg_rating: 4.6 });
		expect(r.top_providers[0].avatar_thumbnail_url).toBe('https://cdn.test/thumb/p1.png');
		expect(r.top_providers[1].url).toBe(null);
		expect(r.top_providers[1].avatar_thumbnail_url).toBe(null);
		expect(r.top_providers[1].avg_rating).toBe(null);

		expect(r.top_hirers[0]).toMatchObject({ agent_id: 'h1', name: 'Trader', spent_usd: 500, hires: 120 });

		expect(r.recent[0]).toMatchObject({
			id: 'r1', skill_name: 'market-analysis', usd: 0.005, network: 'solana',
			payment_signature: 'SIG1',
		});
		// The feed links an agent exactly when the row says it is linkable (alive
		// and public), so a private or deleted agent is named but not linked.
		expect(r.recent[0].hirer).toEqual({ agent_id: 'h1', name: 'Trader', url: '/agent/h1' });
		expect(r.recent[0].provider).toEqual({ agent_id: 'p1', name: 'Oracle', url: null });
	});

	it('never links a leaderboard row whose agent identity is gone', async () => {
		// A deleted agent leaves no `agent_identities` row, so the LEFT JOIN yields
		// a NULL name and no `linkable` flag. Linking it anyway sent readers to a
		// hollow /agent/<id> page, the exact failure the settled-hire feed already
		// guarded against.
		queue.push(
			[{}], // totals
			[],   // daily
			[{ agent_id: 'ghost', name: 'Agent', linkable: false, thumb_key: null, avatar_vis: null, earned_usd: 12.5, hires: 1, avg_rating: null }],
			[{ agent_id: 'ghost', name: 'Agent', linkable: false, thumb_key: null, avatar_vis: null, spent_usd: 3, hires: 1 }],
			[],   // recent
		);
		const r = await platformEconomyStats();
		expect(r.top_providers[0]).toMatchObject({ agent_id: 'ghost', name: 'Agent', url: null, earned_usd: 12.5 });
		expect(r.top_hirers[0]).toMatchObject({ agent_id: 'ghost', name: 'Agent', url: null, spent_usd: 3 });
	});

	it('derives recent USD from atomics when the usd column is null', async () => {
		queue.push(
			[{}], // totals (all null → zeros)
			[],   // daily
			[],   // providers
			[],   // hirers
			[{ id: 'r9', skill_name: 's', service_slug: null, usd: null, amount_atomics: '2500000', currency: 'USDC', network: 'solana', payment_signature: null, completed_at: null, hirer_agent_id: 'h', provider_agent_id: 'p', hirer_name: null, provider_name: null }],
		);
		const r = await platformEconomyStats();
		expect(r.recent[0].usd).toBe(2.5); // 2_500_000 atomics / 1e6
		expect(r.recent[0].hirer.name).toBe('Agent'); // null name falls back
		expect(r.recent[0].hirer.url).toBe(null); // an unjoinable agent is never linked
	});

	it('clamps out-of-range params into safe bounds', async () => {
		queue.push([{}], [], [], [], []);
		const r = await platformEconomyStats({ windowDays: 99999, topLimit: -3, recentLimit: 9999 });
		expect(r.window_days).toBe(365); // capped at 365
	});

	it('folds an unmigrated ledger (42P01) to a real zero, not a throw', async () => {
		sql.mockImplementationOnce(async () => {
			const err = new Error('relation "agent_hires" does not exist');
			err.code = '42P01';
			throw err;
		});
		const r = await platformEconomyStats({ windowDays: 7 });
		expect(r.totals.volume_usd).toBe(0);
		expect(r.totals.hires).toBe(0);
		expect(r.daily).toEqual([]);
		expect(r.top_providers).toEqual([]);
		expect(r.recent).toEqual([]);
		expect(r.window_days).toBe(7);
	});

	it('rethrows non-missing-table errors (a real DB outage must not look like zero volume)', async () => {
		sql.mockImplementationOnce(async () => {
			const err = new Error('connection terminated');
			err.code = '08006';
			throw err;
		});
		await expect(platformEconomyStats()).rejects.toThrow('connection terminated');
	});
});
