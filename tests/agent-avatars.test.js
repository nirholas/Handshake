// api/_lib/agent-avatars.js — the module that guarantees every agent has a body.
//
// Invariants under test:
//   1. An agent with avatar_id NULL (or dangling) gets a cloned public avatar
//      assigned, guarded so a concurrent link between claim and update wins —
//      the loser deletes its own orphan clone instead of clobbering the link.
//   2. An empty public pool stops the pass instead of spinning.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls = [];
let sqlRoutes = [];
const defaultSqlImpl = (strings, ...vals) => {
	const text = Array.isArray(strings) ? strings.join('?') : String(strings);
	sqlCalls.push({ text, vals });
	const handler = sqlRoutes.find((r) => r.match.test(text));
	const rows = handler ? (typeof handler.rows === 'function' ? handler.rows({ text, vals }) : handler.rows) : [];
	return Promise.resolve(rows);
};
const sqlMock = vi.fn(defaultSqlImpl);
vi.mock('../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a) }));

const cloneAvatarForMock = vi.fn();
vi.mock('../api/_lib/circulation.js', () => ({
	cloneAvatarFor: (...a) => cloneAvatarForMock(...a),
}));

const { backfillAgentAvatars } = await import('../api/_lib/agent-avatars.js');

const CANDIDATES = [
	{ id: 'agent-1', user_id: 'user-1', name: 'Risk Auditor 9', prev_avatar_id: null },
	{ id: 'agent-2', user_id: 'user-2', name: 'Yield Hunter 17', prev_avatar_id: 'deleted-avatar' },
];

beforeEach(() => {
	sqlCalls.length = 0;
	sqlRoutes = [];
	cloneAvatarForMock.mockReset();
});

describe('backfillAgentAvatars', () => {
	it('assigns a cloned avatar to agents without one (incl. dangling links)', async () => {
		sqlRoutes = [
			{ match: /select i\.id, i\.user_id/i, rows: CANDIDATES },
			{ match: /update agent_identities/i, rows: [{ id: 'x' }] },
		];
		cloneAvatarForMock.mockResolvedValueOnce('clone-1').mockResolvedValueOnce('clone-2');

		const r = await backfillAgentAvatars({ limit: 10 });

		expect(r).toEqual({ claimed: 2, assigned: 2, failed: 0 });
		expect(cloneAvatarForMock).toHaveBeenCalledWith('user-1', 'Risk Auditor 9');
		expect(cloneAvatarForMock).toHaveBeenCalledWith('user-2', 'Yield Hunter 17');
		const updates = sqlCalls.filter((c) => /update agent_identities/i.test(c.text));
		expect(updates).toHaveLength(2);
		// The guard binds the previously-seen avatar_id so a concurrent link wins.
		expect(updates[0].vals).toContain(null);
		expect(updates[1].vals).toContain('deleted-avatar');
	});

	it('deletes its orphan clone when the agent was linked concurrently', async () => {
		sqlRoutes = [
			{ match: /select i\.id, i\.user_id/i, rows: [CANDIDATES[0]] },
			{ match: /update agent_identities/i, rows: [] }, // guard lost the race
			{ match: /delete from avatars/i, rows: [] },
		];
		cloneAvatarForMock.mockResolvedValueOnce('clone-1');

		const r = await backfillAgentAvatars({ limit: 10 });

		expect(r.assigned).toBe(0);
		const deletes = sqlCalls.filter((c) => /delete from avatars/i.test(c.text));
		expect(deletes).toHaveLength(1);
		expect(deletes[0].vals).toContain('clone-1');
	});

	it('stops the pass when the public pool is empty instead of spinning', async () => {
		sqlRoutes = [{ match: /select i\.id, i\.user_id/i, rows: CANDIDATES }];
		cloneAvatarForMock.mockResolvedValue(null);

		const r = await backfillAgentAvatars({ limit: 10 });

		expect(cloneAvatarForMock).toHaveBeenCalledTimes(1);
		expect(r).toEqual({ claimed: 2, assigned: 0, failed: 2 });
	});

	it('no-ops cleanly when every agent already has an avatar', async () => {
		sqlRoutes = [{ match: /select i\.id, i\.user_id/i, rows: [] }];
		const r = await backfillAgentAvatars({ limit: 10 });
		expect(r).toEqual({ claimed: 0, assigned: 0, failed: 0 });
		expect(cloneAvatarForMock).not.toHaveBeenCalled();
	});
});
