// Two guards that keep the Arena from looking dead when it is not.
//
// Production ran for weeks with exactly one row on https://three.ws/arena: a
// bracket named "test", zero entrants, window closed in June, never finalized,
// while the homepage's primary CTA sent holders straight at it. The house keeper
// (api/_lib/arena-house.js) fixes the supply side. These two guard the display
// side of the same failure:
//
//   1. A finished bracket nobody entered is not rendered at all. It has no result
//      to show, and a Finished tab full of husks reads as an abandoned product.
//   2. Finalizing an empty bracket does not broadcast an attestation. Committing
//      an empty board to Solana burns a real signature and real lamports to prove
//      nothing, and hands the UI an attestation link that attests to no one.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { visibleTournaments } from '../api/tournaments/index.js';

describe('visibleTournaments', () => {
	it('hides a finished bracket nobody entered', () => {
		const rows = [
			{ id: 'husk', phase: 'finished', entrant_count: 0 },
			{ id: 'real', phase: 'finished', entrant_count: 4 },
		];
		expect(visibleTournaments(rows).map((r) => r.id)).toEqual(['real']);
	});

	it('keeps live and upcoming brackets that are still joinable at zero entrants', () => {
		const rows = [
			{ id: 'live', phase: 'live', entrant_count: 0 },
			{ id: 'next', phase: 'upcoming', entrant_count: 0 },
		];
		expect(visibleTournaments(rows).map((r) => r.id)).toEqual(['live', 'next']);
	});

	it('treats a missing entrant_count as zero rather than as content', () => {
		expect(visibleTournaments([{ id: 'husk', phase: 'finished' }])).toEqual([]);
	});
});

const attestSpy = vi.fn(async () => ({ status: 'attested', signature: 'sig111', kind: 'threews.tournament.v1' }));
const setStatusSpy = vi.fn(async (_id, status) => ({ status }));
const entriesRef = { rows: [] };

vi.mock('../api/_lib/db.js', () => ({ sql: async () => [] }));
vi.mock('../api/_lib/avatar-wallet.js', () => ({ solUsdPrice: async () => 150 }));
vi.mock('../api/_lib/tournament-settlement.js', () => ({
	settleTournament: async () => [],
	settlementBlockReason: () => null,
	prizeWalletConfigured: () => false,
}));
vi.mock('../api/_lib/tournament-attest.js', () => ({
	attestTournamentStandings: (...args) => attestSpy(...args),
	attestationUrl: (sig) => `https://solscan.io/tx/${sig}`,
	TournamentAttestError: class extends Error {},
}));
vi.mock('../api/_lib/tournament-store.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		listEntries: async () => entriesRef.rows,
		setTournamentStatus: (...args) => setStatusSpy(...args),
		persistFinalStanding: async () => {},
		getTournament: async () => null,
	};
});

const { finalizeTournament } = await import('../api/_lib/tournament-engine.js');

const ENDED = {
	id: 't1',
	name: 'test',
	network: 'mainnet',
	scoring: 'score',
	bracket: 'practice',
	entry_rules: {},
	prize_pool_three: '0',
	prize_splits: [],
	status: 'upcoming',
	attestation_sig: null,
	starts_at: '2026-06-26T07:12:00.000Z',
	ends_at: '2026-06-27T07:07:00.000Z',
};

describe('finalizeTournament with no entrants', () => {
	beforeEach(() => {
		attestSpy.mockClear();
		setStatusSpy.mockClear();
		entriesRef.rows = [];
	});

	it('closes without broadcasting an attestation', async () => {
		const result = await finalizeTournament(ENDED, { now: Date.parse('2026-08-14T00:00:00.000Z') });

		expect(attestSpy).not.toHaveBeenCalled();
		expect(result.standings).toEqual([]);
		expect(result.attestation).toMatchObject({ status: 'skipped', reason: 'no_entrants', signature: null });
		expect(result.status).toBe('closed');
		expect(setStatusSpy).toHaveBeenCalledWith('t1', 'closed');
	});

	it('still refuses to finalize a window that has not ended', async () => {
		await expect(finalizeTournament(ENDED, { now: Date.parse('2026-06-26T08:00:00.000Z') })).rejects.toThrow(
			/has not ended/,
		);
		expect(attestSpy).not.toHaveBeenCalled();
	});
});
