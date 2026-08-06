import { describe, it, expect } from 'vitest';
import { rankBoardItems, MARKER_BUDGET, ROSTER_BUDGET } from '../src/agora/board-rank.js';

// The board merges a scarce on-chain lane with the x402 bazaar catalog, which is
// large and grows on its own (573 live services against a maxItems=60 request is
// what prompted this module). These tests pin the two properties the Commons
// depends on: the 3D marker pool stays bounded, and the overflow is reported
// rather than swallowed.

const magnitudeOf = (reward) => Number(reward?.amountAtomic || 0);

function service(name, amountAtomic) {
	return { source: 'x402', title: name, resource: `https://x.test/${name}`, reward: { amountAtomic } };
}
function bounty(name, amountAtomic) {
	return { taskPda: `pda-${name}`, title: name, profession: 'sculptor', reward: { amountAtomic } };
}

describe('rankBoardItems', () => {
	it('bounds the marker set to the budget while keeping the roster larger', () => {
		const items = Array.from({ length: 573 }, (_, i) => service(`svc-${i}`, 1000 + i));
		const ranked = rankBoardItems(items, { magnitudeOf });

		expect(ranked.markers).toHaveLength(MARKER_BUDGET);
		expect(ranked.roster).toHaveLength(ROSTER_BUDGET);
		expect(ranked.total).toBe(573);
		expect(ranked.hiddenFromBoard).toBe(573 - MARKER_BUDGET);
		expect(ranked.hiddenFromRoster).toBe(573 - ROSTER_BUDGET);
	});

	it('gives on-chain bounties the slots ahead of every x402 service', () => {
		// The services are far richer on paper; the scarce lane still outranks them.
		const items = [
			service('rich-a', 10_000_000),
			service('rich-b', 9_000_000),
			bounty('small-bounty', 5),
		];
		const ranked = rankBoardItems(items, { magnitudeOf, markerBudget: 2 });

		expect(ranked.markers[0].title).toBe('small-bounty');
		expect(ranked.markers[1].title).toBe('rich-a');
	});

	it('orders within a lane by reward, biggest first', () => {
		const items = [service('a', 10), service('b', 900), service('c', 50)];
		const ranked = rankBoardItems(items, { magnitudeOf });
		expect(ranked.markers.map((m) => m.title)).toEqual(['b', 'c', 'a']);
	});

	it('keeps server order on ties so a steady board does not reshuffle', () => {
		const items = [service('a', 100), service('b', 100), service('c', 100)];
		const first = rankBoardItems(items, { magnitudeOf }).markers.map((m) => m.title);
		const second = rankBoardItems(items, { magnitudeOf }).markers.map((m) => m.title);
		expect(first).toEqual(['a', 'b', 'c']);
		expect(second).toEqual(first);
	});

	it('treats a missing or unparseable reward as zero, never NaN ordering', () => {
		const items = [service('no-reward'), service('paid', 42)];
		items[0].reward = null;
		const ranked = rankBoardItems(items, { magnitudeOf });
		expect(ranked.markers.map((m) => m.title)).toEqual(['paid', 'no-reward']);
	});

	it('returns an honest empty shape for an empty board', () => {
		const ranked = rankBoardItems([], { magnitudeOf });
		expect(ranked.markers).toEqual([]);
		expect(ranked.roster).toEqual([]);
		expect(ranked.total).toBe(0);
		expect(ranked.hiddenFromBoard).toBe(0);
	});

	it('tolerates a non-array payload and null entries', () => {
		expect(rankBoardItems(null, { magnitudeOf }).total).toBe(0);
		expect(rankBoardItems([null, service('a', 1), undefined], { magnitudeOf }).total).toBe(1);
	});
});
