import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { PumpAgent, PumpAgentOffline } from '@three-ws/agent-payments';

// The SDK's online agent takes (mint, environment, connection) — the environment
// string sits BETWEEN the mint and the connection. api/_lib/pump.js once passed
// the Connection as the second argument, which left `this.connection` undefined
// and made every online read throw "Connection is required". That silently broke
// the buyback cron (~40k failed rows/day) and 502'd /api/pump/balances for a
// month before anyone noticed, because both paths recorded the failure instead
// of surfacing it.
//
// These tests pin the constructor contract the wrapper depends on. A future SDK
// bump that reorders or renames these arguments fails here rather than in prod.

const THREE_MINT = new PublicKey('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump');

// A structural stand-in for @solana/web3.js Connection: the SDK only stores it
// and reads `rpcEndpoint` in its fallback path, so no network access occurs.
const fakeConnection = { rpcEndpoint: 'https://api.mainnet-beta.solana.com' };

describe('PumpAgent constructor contract', () => {
	it('takes the connection as the THIRD argument, after environment', async () => {
		const agent = new PumpAgent(THREE_MINT, 'mainnet', fakeConnection);
		// getBalances() throws "Connection is required" when this is unset.
		expect(agent.connection).toBe(fakeConnection);
	});

	it('leaves connection undefined when it is passed in the environment slot', () => {
		// This is precisely the shape of the bug — proving the misuse is silent at
		// construction time and only explodes on the first online read.
		const agent = new PumpAgent(THREE_MINT, fakeConnection);
		expect(agent.connection).toBeUndefined();
	});

	it('rejects an online read when constructed without a connection', async () => {
		const agent = new PumpAgent(THREE_MINT, 'mainnet');
		await expect(agent.getBalances(THREE_MINT)).rejects.toThrow(/Connection is required/);
	});
});

describe('PumpAgentOffline.load contract', () => {
	it('takes the connection as the SECOND argument (no environment slot)', () => {
		const offline = PumpAgentOffline.load(THREE_MINT, fakeConnection);
		expect(offline).toBeInstanceOf(PumpAgentOffline);
	});
});
