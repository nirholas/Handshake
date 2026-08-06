/**
 * Agora task supply (Task 03) — unit tests for the pure economic logic.
 *
 * These cover the decisions that make the board's AgenC lane real demand: the
 * profession bitmap, the career-ladder claim gate, the patron demand policy
 * (incl. honest scarcity), agent-to-agent hiring, the reconcile state mapping,
 * and the narration. All pure — no SDK build, no DB, no RPC — so they run in CI
 * regardless of whether @three-ws/solana-agent's dist/ exists.
 */

import { describe, it, expect } from 'vitest';
import {
	professionBits,
	capabilitiesSatisfy,
	primaryProfession,
	buildRoster,
} from '../workers/agora-citizens/roster.js';
import {
	citizenCanClaim,
	ineligibilityReason,
	minReputationForTier,
	REPUTATION_BASELINE,
	REPUTATION_PER_COMPLETION,
	pickTier,
	decidePatronPost,
	decideHire,
	reconcileTransition,
	BOARD_TERMINAL_KINDS,
	REPUTATION_LADDER,
} from '../workers/agora-citizens/policy.js';
import { rewardLabel, postedTaskNarrative, hiredNarrative } from '../workers/agora-citizens/narrative.js';

describe('professions / capability bitmap', () => {
	it('maps profession keys to stable bits', () => {
		expect(professionBits(['fetcher'])).toBe(1n);
		expect(professionBits(['sculptor'])).toBe(2n);
		expect(professionBits(['fetcher', 'scribe'])).toBe(5n); // bit0 | bit2
	});

	it('capability subset test (required ⊆ worker)', () => {
		expect(capabilitiesSatisfy(1n, 1n)).toBe(true); // fetcher can do fetcher work
		expect(capabilitiesSatisfy(1n, 0n)).toBe(true); // anyone can do an unrestricted task
		expect(capabilitiesSatisfy(1n, 2n)).toBe(false); // fetcher can't do sculptor work
		expect(capabilitiesSatisfy(5n, 1n)).toBe(true); // fetcher+scribe can do fetcher work
	});

	it('primary profession is the lowest set bit', () => {
		expect(primaryProfession(5n)).toBe('fetcher');
		expect(primaryProfession(4n)).toBe('scribe');
		expect(primaryProfession(0n)).toBe(null);
	});
});

describe('career-ladder claim gate', () => {
	const fetcher = (reputation) => ({ capabilityBits: 1n, reputation });

	it('lets a qualified citizen claim', () => {
		expect(citizenCanClaim(fetcher(0), { requiredCapabilities: 1n, minReputation: 0 })).toBe(true);
		expect(citizenCanClaim(fetcher(20), { requiredCapabilities: 1n, minReputation: 20 })).toBe(true);
	});

	it('blocks a low-reputation citizen from a gated bounty (the ladder)', () => {
		const task = { requiredCapabilities: 1n, minReputation: 20 };
		expect(citizenCanClaim(fetcher(2), task)).toBe(false);
		expect(ineligibilityReason(fetcher(2), task)).toBe('below_min_reputation');
	});

	it('blocks a citizen missing the capability', () => {
		const sculptJob = { requiredCapabilities: 2n, minReputation: 0 };
		expect(citizenCanClaim(fetcher(99), sculptJob)).toBe(false);
		expect(ineligibilityReason(fetcher(99), sculptJob)).toBe('missing_capability');
	});

	it('ladder tiers are documented and gate as published', () => {
		expect(minReputationForTier('apprentice')).toBe(REPUTATION_BASELINE);
		expect(minReputationForTier('journeyman')).toBe(REPUTATION_BASELINE + 200);
		expect(minReputationForTier('master')).toBe(REPUTATION_BASELINE + 500);
		expect(REPUTATION_LADDER.map((t) => t.tier)).toEqual(['apprentice', 'journeyman', 'master']);
	});

	// The bug this pins: AgenC registers every agent at REPUTATION_BASELINE, so a
	// ladder written in absolute numbers (0/5/20) gated nothing at all. A citizen
	// that has never completed a task must be shut out of the upper tiers.
	it('gates a freshly registered citizen out of the upper tiers', () => {
		const fresh = fetcher(REPUTATION_BASELINE);
		const proven = fetcher(REPUTATION_BASELINE + 5 * REPUTATION_PER_COMPLETION);

		const apprentice = { requiredCapabilities: 1n, minReputation: minReputationForTier('apprentice') };
		const master = { requiredCapabilities: 1n, minReputation: minReputationForTier('master') };

		expect(citizenCanClaim(fresh, apprentice)).toBe(true);
		expect(citizenCanClaim(fresh, master)).toBe(false);
		expect(ineligibilityReason(fresh, master)).toBe('below_min_reputation');
		expect(citizenCanClaim(proven, master)).toBe(true);
	});
});

describe('patron demand policy', () => {
	const tiers = [
		{ tier: 'apprentice', profession: 'fetcher', rewardAtomic: 1_000_000n, minReputation: 0 },
		{ tier: 'journeyman', profession: 'fetcher', rewardAtomic: 2_000_000n, minReputation: 5 },
	];
	const patron = () => ({ patron: { tiers, minPostIntervalMs: 1_000 } });

	it('rotates tiers by post count', () => {
		expect(pickTier(tiers, 0).tier).toBe('apprentice');
		expect(pickTier(tiers, 1).tier).toBe('journeyman');
		expect(pickTier(tiers, 2).tier).toBe('apprentice');
	});

	it('posts when funded and outside the interval', () => {
		const d = decidePatronPost({ citizen: patron(), now: 10_000, lastPostAt: 0, balanceAtomic: 50_000_000n, postedCount: 0 });
		expect(d.post).toBe(true);
		expect(d.plan.profession).toBe('fetcher');
		expect(d.plan.requiredCapabilities).toBe(1n);
		expect(d.plan.rewardAtomic).toBe(1_000_000n);
		expect(d.plan.minReputation).toBe(0);
	});

	it('honest scarcity — stops posting when the budget cannot cover reward + headroom', () => {
		const d = decidePatronPost({
			citizen: patron(),
			now: 10_000,
			lastPostAt: 0,
			balanceAtomic: 1_000_000n, // exactly the reward, but headroom pushes need above it
			headroomAtomic: 12_000_000n,
			postedCount: 0,
		});
		expect(d.post).toBe(false);
		expect(d.reason).toBe('insufficient_funds');
	});

	it('respects the post interval', () => {
		const d = decidePatronPost({ citizen: patron(), now: 10_500, lastPostAt: 10_000, balanceAtomic: 50_000_000n, postedCount: 0 });
		expect(d.post).toBe(false);
		expect(d.reason).toBe('interval_guard');
	});

	it('a non-patron never posts', () => {
		expect(decidePatronPost({ citizen: {}, now: 1, balanceAtomic: 9_999_999_999n }).post).toBe(false);
	});
});

describe('agent-to-agent hiring', () => {
	it('hires a sub-agent when funded', () => {
		const d = decideHire({ neededProfession: 'fetcher', balanceAtomic: 50_000_000n, subRewardAtomic: 1_000_000n });
		expect(d.hire).toBe(true);
		expect(d.plan.requiredCapabilities).toBe(1n);
		expect(d.plan.minReputation).toBe(0);
	});

	it('declines to hire when out of funds (scarcity)', () => {
		const d = decideHire({ neededProfession: 'fetcher', balanceAtomic: 100n, subRewardAtomic: 1_000_000n });
		expect(d.hire).toBe(false);
		expect(d.reason).toBe('insufficient_funds');
	});

	it('rejects an unknown profession', () => {
		expect(decideHire({ neededProfession: 'wizard', balanceAtomic: 1n, subRewardAtomic: 0n }).hire).toBe(false);
	});
});

describe('reconcile state mapping', () => {
	it('leaves an open task on the board', () => {
		expect(reconcileTransition('Open')).toBe(null);
		expect(reconcileTransition(0)).toBe(null);
	});

	it('maps each terminal state to a board-closing projection kind', () => {
		expect(reconcileTransition('Claimed').kind).toBe('claimed_task');
		expect(reconcileTransition('Completed').kind).toBe('completed_task');
		expect(reconcileTransition('Cancelled').kind).toBe('cancelled_task');
		expect(reconcileTransition('Expired').kind).toBe('expired_task');
		expect(reconcileTransition('Disputed').kind).toBe('slashed');
	});

	it('maps the REAL AgenC formatTaskState labels (spaced) that the chain emits', () => {
		// @tetsuo-ai/sdk formatTaskState → "Open" | "In Progress" | "Pending Validation"
		// | "Completed" | "Cancelled" | "Disputed". These are what reconcile actually
		// receives; a claimed task is "In Progress", not "Claimed".
		expect(reconcileTransition('In Progress').kind).toBe('claimed_task');
		expect(reconcileTransition('Pending Validation').kind).toBe('claimed_task');
		expect(reconcileTransition('Completed').kind).toBe('completed_task');
		expect(reconcileTransition('Cancelled').kind).toBe('cancelled_task');
		expect(reconcileTransition('Disputed').kind).toBe('slashed');
	});

	it('decodes the raw AgenC enum numbers in the correct order (SDK fallback path)', () => {
		// TaskState: 0 Open, 1 InProgress, 2 PendingValidation, 3 Completed, 4 Cancelled, 5 Disputed.
		expect(reconcileTransition(0)).toBe(null);
		expect(reconcileTransition(1).kind).toBe('claimed_task');
		expect(reconcileTransition(2).kind).toBe('claimed_task');
		expect(reconcileTransition(3).kind).toBe('completed_task');
		expect(reconcileTransition(4).kind).toBe('cancelled_task');
		expect(reconcileTransition(5).kind).toBe('slashed');
	});

	it('every transition kind is in the board terminal set', () => {
		for (const label of ['In Progress', 'Completed', 'Cancelled', 'Expired', 'Disputed']) {
			expect(BOARD_TERMINAL_KINDS).toContain(reconcileTransition(label).kind);
		}
		expect(BOARD_TERMINAL_KINDS).toEqual(
			expect.arrayContaining(['claimed_task', 'completed_task', 'slashed', 'cancelled_task', 'expired_task']),
		);
	});
});

describe('narration', () => {
	it('formats SOL and $THREE rewards', () => {
		expect(rewardLabel({ amountAtomic: 5_000_000n, mint: null, decimals: 9 })).toBe('0.0050 SOL');
		expect(rewardLabel({ amountAtomic: 25_000_000_000n, mint: '$THREE', decimals: 6 })).toBe('25,000 $THREE');
	});

	it('writes a real story line for a posting and a hire', () => {
		expect(postedTaskNarrative({ poster: 'Aria', profession: 'fetcher', reward: '0.0010 SOL', minReputation: 5 }))
			.toMatch(/Aria posted a Fetcher bounty worth 0.0010 SOL \(needs reputation 5\)\./);
		expect(hiredNarrative({ poster: 'Koa', profession: 'fetcher', reward: '0.0010 SOL', parentLabel: 'Fetcher job ab12cd34' }))
			.toMatch(/Koa hired a Fetcher to help finish/);
	});
});

describe('roster assembly', () => {
	it('fills to the cap with standalone citizens on an empty DB', () => {
		const specs = buildRoster([], { maxCitizens: 4 });
		expect(specs.length).toBe(4);
		expect(specs.every((s) => s.kind === 'agent')).toBe(true);
		// Each standalone citizen works a specialty (Task 04) but ALWAYS carries the
		// Fetcher bit, so it satisfies the devnet dispatcher's task gate and never
		// idles for lack of work.
		expect(specs.every((s) => capabilitiesSatisfy(s.professionBits, 1n))).toBe(true);
	});

	it('respects the citizen cap', () => {
		expect(buildRoster([], { maxCitizens: 2 }).length).toBe(2);
	});
});
