// The consolidation sweep's plan-only mode (api/_lib/economy-sweepback.js).
//
// treasury-sweepback moves real mainnet SOL and, unlike its mirror
// treasury-topup, had no way to be inspected or exercised without doing so: the
// only reachable branches were the auth gate and the drain confirm guard. ?dry=1
// closes that, and the property that makes it worth anything is negative: a dry
// sweep must read balances, apply the same floors, and then sign and broadcast
// NOTHING. These tests assert exactly that by mocking the two send paths and
// failing if either is ever reached.
import { test, expect, vi, beforeEach } from 'vitest';
import { Keypair } from '@solana/web3.js';

const sendSol = vi.fn(async () => 'live-signature');
const submitProtected = vi.fn(async () => ({ signature: 'live-token-signature' }));

const ENGINE = Keypair.generate();

vi.mock('../api/_lib/solana-signers.js', () => ({
	SOLANA_SIGNERS: [{ name: 'test-engine', minSol: 0.1, refillTo: 0.3, network: 'mainnet', holdsTokens: false }],
	loadSignerKeypair: async () => ({ keypair: ENGINE, configured: true, decodeError: null }),
}));
vi.mock('../api/_lib/avatar-wallet.js', () => ({
	sendSol: (...args) => sendSol(...args),
	LAMPORTS_PER_SOL: 1_000_000_000,
}));
vi.mock('../api/_lib/execution-engine.js', () => ({
	submitProtected: (...args) => submitProtected(...args),
}));

const { sweepBack } = await import('../api/_lib/economy-sweepback.js');

// One idle engine holding `engineSol` against a 0.3 float, plus one SPL balance
// worth consolidating. Everything a real sweep would act on is present.
function connectionWith({ engineSol = 2 }) {
	return {
		getBalance: async () => Math.round(engineSol * 1_000_000_000),
		getParsedTokenAccountsByOwner: async () => ({
			value: [
				{
					pubkey: Keypair.generate().publicKey,
					account: {
						data: {
							parsed: {
								info: {
									mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
									tokenAmount: { amount: '1250000', decimals: 6 },
								},
							},
						},
					},
				},
			],
		}),
	};
}

beforeEach(() => {
	sendSol.mockClear();
	submitProtected.mockClear();
});

test('a dry sweep plans the SOL move without signing or sending it', async () => {
	const result = await sweepBack({ connection: connectionWith({ engineSol: 2 }), network: 'mainnet', dryRun: true });

	expect(sendSol).not.toHaveBeenCalled();
	expect(result.dryRun).toBe(true);
	// 2 SOL against a 0.3 float leaves 1.7 above it.
	expect(result.sweptSol).toHaveLength(1);
	expect(result.sweptSol[0]).toMatchObject({ sol: 1.7, signature: null, dryRun: true });
	expect(result.receivedSol).toBe(1.7);
});

test('a dry sweep plans the token move without broadcasting it', async () => {
	const result = await sweepBack({ connection: connectionWith({ engineSol: 2 }), network: 'mainnet', dryRun: true });

	expect(submitProtected).not.toHaveBeenCalled();
	// Both SPL programs are walked, so the same holding is planned once per program.
	expect(result.sweptTokens.length).toBeGreaterThan(0);
	for (const t of result.sweptTokens) {
		expect(t).toMatchObject({ amount: '1250000', decimals: 6, signature: null, dryRun: true });
	}
});

test('a dry sweep still applies the float, so an engine at its floor is skipped', async () => {
	const result = await sweepBack({ connection: connectionWith({ engineSol: 0.25 }), network: 'mainnet', dryRun: true });

	expect(sendSol).not.toHaveBeenCalled();
	expect(result.sweptSol).toHaveLength(0);
	expect(result.skipped.map((s) => s.reason)).toContain('at_or_below_float');
});

test('the default (non-dry) sweep still sends, so dry mode is opt-in only', async () => {
	const result = await sweepBack({ connection: connectionWith({ engineSol: 2 }), network: 'mainnet' });

	expect(sendSol).toHaveBeenCalledTimes(1);
	expect(result.dryRun).toBe(false);
	expect(result.sweptSol[0]).toMatchObject({ sol: 1.7, signature: 'live-signature' });
});
