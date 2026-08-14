// The Solana lane definitions the whole x402 rail shares, plus the two lane
// bugs found while running the phase-4 settlement proof (see
// specs/inference-receipts.md):
//
//   1. The rail carried three inlined copies of `isSolanaNetwork`. They agreed
//      by luck, not by construction, and only the copy in x402-spec.js was
//      exercised by the settle path.
//   2. The receipt verifiers matched the devnet CAIP-2 id by a substring that
//      was missing a character, so it never matched: every devnet receipt was
//      looked up on MAINNET and reported as mainnet.

import { describe, it, expect, afterEach } from 'vitest';

import {
	NETWORK_SOLANA_MAINNET,
	NETWORK_SOLANA_DEVNET,
	caip2ForGenesisHash,
	isSolanaNetwork,
	solanaLocalTestNetwork,
} from '../api/_lib/x402/solana-networks.js';

const LOCAL_GENESIS = '8p5TJ23ZcDXq5QA3vGbpf2sXZ25f69YWJbpxS6dhE1Mr';
const LOCAL_ID = 'solana:8p5TJ23ZcDXq5QA3vGbpf2sXZ25f69YW';

afterEach(() => {
	delete process.env.X402_SOLANA_LOCAL_NETWORK;
});

describe('Solana CAIP-2 ids', () => {
	it('are the truncated genesis hashes the x402 spec advertises', () => {
		expect(NETWORK_SOLANA_MAINNET).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
		expect(NETWORK_SOLANA_DEVNET).toBe('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1');
	});

	it('derives a lane id from a genesis hash by truncating to 32 base58 chars', () => {
		expect(caip2ForGenesisHash(LOCAL_GENESIS)).toBe(LOCAL_ID);
		expect(caip2ForGenesisHash(LOCAL_ID.slice('solana:'.length))).toBe(LOCAL_ID);
		expect(() => caip2ForGenesisHash('')).toThrow(/genesis hash is required/);
	});

	// The bug this guards: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' lowercased
	// contains "imfey", and both verifiers searched for "imey". A devnet receipt
	// therefore fell through to the mainnet branch, was queried against the
	// mainnet RPC, and was reported to the operator as a mainnet settlement.
	it('lowercases devnet to an id containing imfey, not imey', () => {
		const lower = NETWORK_SOLANA_DEVNET.toLowerCase();
		expect(lower).toBe('solana:etwtrabzayq6imfeykouru166vu2xqa1');
		expect(lower.includes('etwtrabzayq6imeykouru166vu2xqa1')).toBe(false);
	});
});

describe('isSolanaNetwork', () => {
	it('accepts the two public lanes and the bare alias', () => {
		expect(isSolanaNetwork(NETWORK_SOLANA_MAINNET)).toBe(true);
		expect(isSolanaNetwork(NETWORK_SOLANA_DEVNET)).toBe(true);
		expect(isSolanaNetwork('solana')).toBe(true);
	});

	it('rejects EVM networks, junk, and empty values', () => {
		expect(isSolanaNetwork('eip155:8453')).toBe(false);
		expect(isSolanaNetwork('base')).toBe(false);
		expect(isSolanaNetwork('')).toBe(false);
		expect(isSolanaNetwork(null)).toBe(false);
		expect(isSolanaNetwork(undefined)).toBe(false);
	});

	it('rejects an unconfigured local lane, which is how production runs', () => {
		expect(solanaLocalTestNetwork()).toBe(null);
		expect(isSolanaNetwork(LOCAL_ID)).toBe(false);
	});

	it('accepts exactly the configured local lane, and nothing else', () => {
		process.env.X402_SOLANA_LOCAL_NETWORK = LOCAL_ID;
		expect(solanaLocalTestNetwork()).toBe(LOCAL_ID);
		expect(isSolanaNetwork(LOCAL_ID)).toBe(true);
		expect(isSolanaNetwork('solana:someOtherLedgerId111111111111')).toBe(false);
		// A null network must never match a null local lane by accident.
		delete process.env.X402_SOLANA_LOCAL_NETWORK;
		expect(isSolanaNetwork(null)).toBe(false);
	});

	it('ignores a malformed local lane rather than widening the rail', () => {
		for (const bad of ['not-a-caip2', 'solana:', 'eip155:1', 'solana:has spaces', '   ']) {
			process.env.X402_SOLANA_LOCAL_NETWORK = bad;
			expect(solanaLocalTestNetwork()).toBe(null);
			expect(isSolanaNetwork(bad)).toBe(false);
		}
	});
});

describe('one definition, shared by every module on the rail', () => {
	it('x402-spec, x402-solana-confirm and a2a-client agree on ids and predicate', async () => {
		const spec = await import('../api/_lib/x402-spec.js');
		const confirm = await import('../api/_lib/x402-solana-confirm.js');
		const client = await import('../api/_lib/x402/a2a-client.js');

		expect(spec.NETWORK_SOLANA_MAINNET).toBe(NETWORK_SOLANA_MAINNET);
		expect(spec.NETWORK_SOLANA_DEVNET).toBe(NETWORK_SOLANA_DEVNET);
		expect(client.NETWORK_SOLANA_MAINNET).toBe(NETWORK_SOLANA_MAINNET);
		expect(client.NETWORK_SOLANA_DEVNET).toBe(NETWORK_SOLANA_DEVNET);

		process.env.X402_SOLANA_LOCAL_NETWORK = LOCAL_ID;
		for (const pred of [confirm.isSolanaNetwork, client.isSolanaNetwork]) {
			expect(pred(NETWORK_SOLANA_MAINNET)).toBe(true);
			expect(pred(LOCAL_ID)).toBe(true);
			expect(pred('eip155:8453')).toBe(false);
		}
	});

	it('routes the local lane to the Solana facilitator, and only when configured', async () => {
		const { facilitatorFor } = await import('../api/_lib/x402-spec.js');
		// Unconfigured: an unknown solana: id is not a network at all, so routing
		// fails closed rather than quietly settling it somewhere.
		expect(() => facilitatorFor(LOCAL_ID)).toThrow(/unsupported network/);
		process.env.X402_SOLANA_LOCAL_NETWORK = LOCAL_ID;
		expect(facilitatorFor(LOCAL_ID).url).toBe(facilitatorFor(NETWORK_SOLANA_MAINNET).url);
	});
});
