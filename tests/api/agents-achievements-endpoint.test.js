// Tests for GET /api/agents/:id/achievements (api/agents/_id/achievements.js).
//
// The handler is a thin public shell over api/_lib/agent-achievements-data.js:
// rate-limit, uuid guard, then the shared gather+cache loader whose scoring is
// covered by tests/agent-achievements.test.js. What this pins at the boundary:
// a real agent returns the loader's body verbatim (with the cache marker
// stripped and surfaced as X-Cache), a missing agent is a 404, a non-uuid id is
// a 404 (never a Postgres 22P02 500), and non-GET methods are 405.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeReq, makeRes } from '../_helpers/monetization.js';

const AGENT_ID = '00000000-0000-4000-8000-0000000000a1';

let loaderBody = null;
const loadMock = vi.fn(async () => loaderBody);
vi.mock('../../api/_lib/agent-achievements-data.js', () => ({
	loadAgentAchievements: (...a) => loadMock(...a),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		agentProfileIp: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const { handleAchievements } = await import('../../api/agents/_id/achievements.js');

async function invoke({ method = 'GET', id = AGENT_ID } = {}) {
	const req = makeReq({ method, url: `/api/agents/${id}/achievements` });
	const res = makeRes();
	await handleAchievements(req, res, id);
	return res;
}

beforeEach(() => {
	vi.clearAllMocks();
	loaderBody = {
		agent_id: AGENT_ID,
		name: 'Audit Bot',
		achievements: [{ id: 'trailblazer', earned: true }],
		summary: { earned: 1, total: 12 },
		_cache: 'HIT',
	};
});

describe('GET /api/agents/:id/achievements', () => {
	it('returns the loader body with the cache marker stripped and X-Cache set', async () => {
		const res = await invoke();
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.agent_id).toBe(AGENT_ID);
		expect(body.achievements).toHaveLength(1);
		expect(body._cache).toBeUndefined();
		expect(res.headers['x-cache']).toBe('HIT');
		expect(res.headers['cache-control']).toContain('public');
		expect(loadMock).toHaveBeenCalledWith(AGENT_ID);
	});

	it('404s when the agent does not exist', async () => {
		loaderBody = null;
		const res = await invoke();
		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.body).error).toBe('not_found');
	});

	it('404s on a non-uuid id instead of leaking a Postgres error', async () => {
		const res = await invoke({ id: 'not-a-uuid' });
		expect(res.statusCode).toBe(404);
		expect(loadMock).not.toHaveBeenCalled();
	});

	it('405s on POST', async () => {
		const res = await invoke({ method: 'POST' });
		expect(res.statusCode).toBe(405);
	});

	it('429s when the rate limiter trips', async () => {
		const { limits } = await import('../../api/_lib/rate-limit.js');
		limits.agentProfileIp.mockResolvedValueOnce({
			success: false,
			reset: Date.now() + 60_000,
			limit: 60,
			remaining: 0,
		});
		const res = await invoke();
		expect(res.statusCode).toBe(429);
		expect(loadMock).not.toHaveBeenCalled();
	});
});
