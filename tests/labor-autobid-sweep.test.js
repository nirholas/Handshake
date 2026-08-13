// The auto-bid sweep runs on every labor tick for as long as a bounty stays
// open, so it has to be safe to repeat. Before the 2026-08-13 audit it was not:
// findAutoBidders returned every matching worker whether or not it had already
// bid, and upsertBid rewrote that worker's existing row. On a bounty waiting for
// its poster's min_bids that meant one LLM pitch per matching worker per minute,
// forever; each rewrite was reported to the economy heartbeat as a fresh bid; and
// a bid the worker had moved out of 'pending' was flipped back through the ON
// CONFLICT clause. These tests pin the fix: a worker is asked to bid once.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];
vi.mock('../api/_lib/db.js', () => ({
	sql: (strings, ...values) => {
		const text = Array.isArray(strings) ? strings.join(' ? ') : String(strings);
		calls.push({ text, values });
		return Promise.resolve([]);
	},
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const { findAutoBidders } = await import('../api/_lib/agent-labor.js');

const lastMatching = (re) => [...calls].reverse().find((c) => re.test(c.text));

beforeEach(() => { calls.length = 0; });

describe('findAutoBidders', () => {
	it('excludes workers that already hold a bid on the bounty', async () => {
		await findAutoBidders({
			requiredSkill: 'render', rewardAtomics: 1_000_000n,
			excludeAgentId: 'poster-agent', bountyId: 'bounty-1',
		});

		const q = lastMatching(/FROM agent_labor_policies/);
		expect(q).toBeTruthy();
		expect(q.text).toMatch(/NOT EXISTS/i);
		expect(q.text).toMatch(/FROM agent_bids/);
		expect(q.text).toMatch(/worker_agent_id = p\.agent_id/);
		expect(q.values).toContain('bounty-1');
	});

	it('still filters on the worker policy, not the poster policy', async () => {
		await findAutoBidders({
			requiredSkill: null, rewardAtomics: 5n, excludeAgentId: 'poster-agent', bountyId: 'bounty-1',
		});

		const q = lastMatching(/FROM agent_labor_policies/);
		expect(q.text).toMatch(/p\.worker_enabled = true/);
		expect(q.text).not.toMatch(/auto_award/);
		// The reward floor is compared as an exact integer string, never a float.
		expect(q.values).toContain('5');
	});

	it('keeps the call usable without a bounty id (the guard is null-tolerant)', async () => {
		await findAutoBidders({ requiredSkill: 'render', rewardAtomics: 1n, excludeAgentId: 'a' });

		const q = lastMatching(/FROM agent_labor_policies/);
		expect(q.values).toContain(null);
		expect(q.text).toMatch(/IS NULL OR NOT EXISTS/i);
	});
});

describe('autoBidForBounty', () => {
	const bounty = {
		id: 'bounty-1', status: 'open', required_skill: 'render',
		reward_atomics: '1000000', poster_agent_id: 'poster-agent', title: 'Render a scene',
		spec: 'Make a 3D scene',
	};

	async function loadWithBidders(bidders) {
		vi.resetModules();
		const findAutoBiddersMock = vi.fn(async () => bidders);
		const upsertBid = vi.fn(async () => ({ id: 'bid-1' }));
		vi.doMock('../api/_lib/agent-labor.js', () => ({
			scoreBid: () => 0.5,
			workerReputation: async () => ({ reputation: 0.5 }),
			findAutoBidders: findAutoBiddersMock,
			upsertBid,
			getBounty: vi.fn(), getLaborPolicy: vi.fn(), listBidsForBounty: vi.fn(),
			createJob: vi.fn(), markBidAwarded: vi.fn(), rejectOtherBids: vi.fn(),
			setBountyStatus: vi.fn(), getJobByBounty: vi.fn(), markJobDelivered: vi.fn(),
		}));
		const llmComplete = vi.fn(async () => ({ text: 'pitch' }));
		vi.doMock('../api/_lib/llm.js', () => ({ llmComplete, llmConfigured: () => true }));
		const mod = await import('../api/_lib/labor-match.js');
		return { autoBidForBounty: mod.autoBidForBounty, findAutoBiddersMock, upsertBid, llmComplete };
	}

	it('asks only for workers that have not bid on this bounty', async () => {
		const { autoBidForBounty, findAutoBiddersMock } = await loadWithBidders([]);
		await autoBidForBounty(bounty);
		expect(findAutoBiddersMock).toHaveBeenCalledWith(expect.objectContaining({ bountyId: 'bounty-1' }));
	});

	it('spends nothing on a repeat sweep where every worker already bid', async () => {
		const { autoBidForBounty, upsertBid, llmComplete } = await loadWithBidders([]);
		expect(await autoBidForBounty(bounty)).toBe(0);
		expect(upsertBid).not.toHaveBeenCalled();
		expect(llmComplete).not.toHaveBeenCalled();
	});

	it('bids once for a worker that has not been asked yet', async () => {
		const { autoBidForBounty, upsertBid } = await loadWithBidders([
			{ agent_id: 'w1', agent_name: 'Worker', owner_user_id: 'u1', max_bid_atomics: '900000' },
		]);
		expect(await autoBidForBounty(bounty)).toBe(1);
		expect(upsertBid).toHaveBeenCalledWith(expect.objectContaining({
			bountyId: 'bounty-1', workerAgentId: 'w1', auto: true,
		}));
	});

	it('never bids on a bounty that is no longer open', async () => {
		const { autoBidForBounty, findAutoBiddersMock } = await loadWithBidders([{ agent_id: 'w1' }]);
		expect(await autoBidForBounty({ ...bounty, status: 'working' })).toBe(0);
		expect(findAutoBiddersMock).not.toHaveBeenCalled();
	});
});
