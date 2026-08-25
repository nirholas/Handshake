import { describe, it, expect } from 'vitest';

import {
	networkIdentity,
	networkLabel,
	resolveNetworkFilter,
	revenueTxUrl,
	foldNetworkRows,
} from '../api/_lib/x402/revenue-networks.js';

// The exact values the live settlement ledger stores (read off x402_audit_log on
// 2026-08-13): CAIP-2 ids, not the bare chain names the creator ledger used to
// compare against. Filtering by the bare name matched zero rows, which is what these
// tests pin down.
const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const BASE_MAINNET = 'eip155:8453';
const SOL_SIG =
	'3ZARJ7836FfMZQzGNn73SToAgFqdqwSYALkR7WA6fSaBS8Lg6McBavUoUSiADiL3e8Df4TiX7sGNzswrrAVWwN4';
const EVM_TX = '0x389dea3d9cd25ddaeb52187cd579e5c98c89204dd718c3948028f235926c6417';

describe('revenue networks: identity', () => {
	it('folds the ledger CAIP-2 ids to a family slug and a readable label', () => {
		expect(networkIdentity(SOLANA_MAINNET)).toMatchObject({
			family: 'solana',
			label: 'Solana',
			cluster: null,
		});
		expect(networkIdentity(BASE_MAINNET)).toMatchObject({
			family: 'base',
			label: 'Base',
			chainId: 8453,
		});
		expect(networkLabel('eip155:56')).toBe('BNB Chain');
	});

	it('keeps the legacy bare names on the same family as their CAIP-2 form', () => {
		expect(networkIdentity('solana').family).toBe(networkIdentity(SOLANA_MAINNET).family);
		expect(networkIdentity('base').family).toBe(networkIdentity(BASE_MAINNET).family);
		expect(networkIdentity('devnet').family).toBe('solana-devnet');
	});

	it('resolves an EVM chain it has no entry for from the chain table', () => {
		expect(networkIdentity('eip155:42161')).toMatchObject({
			family: 'arbitrum',
			label: 'Arbitrum One',
		});
		expect(networkIdentity('eip155:987654')).toMatchObject({
			family: 'eip155-987654',
			label: 'EVM chain 987654',
			explorer: null,
		});
	});

	it('never throws on a missing or malformed value', () => {
		for (const v of [null, undefined, '', '   ', 'nonsense', 42]) {
			expect(networkIdentity(v).family).toBe('unknown');
		}
	});
});

describe('revenue networks: filter resolution', () => {
	it('selects the raw ids the ledger actually holds for a family', () => {
		const solana = resolveNetworkFilter('solana');
		expect(solana.family).toBe('solana');
		expect(solana.ids).toContain(SOLANA_MAINNET);

		const base = resolveNetworkFilter('base');
		expect(base.family).toBe('base');
		expect(base.ids).toContain(BASE_MAINNET);
	});

	it('accepts a family slug, a legacy name, or a full CAIP-2 id', () => {
		for (const input of ['solana', 'SOLANA', ' mainnet ', SOLANA_MAINNET]) {
			expect(resolveNetworkFilter(input).family).toBe('solana');
		}
		expect(resolveNetworkFilter('eip155-8453').family).toBe('base');
		expect(resolveNetworkFilter('eip155:8453').family).toBe('base');
	});

	it('returns null for an unknown value so the caller drops the filter', () => {
		for (const v of [null, '', 'not-a-chain', '../../etc']) {
			expect(resolveNetworkFilter(v)).toBeNull();
		}
	});

	it('round-trips: every id a family selects folds back to that family', () => {
		for (const family of ['solana', 'solana-devnet', 'base', 'bsc', 'ethereum', 'xlayer']) {
			for (const id of resolveNetworkFilter(family).ids) {
				expect(networkIdentity(id).family).toBe(family);
			}
		}
	});
});

describe('revenue networks: explorer links', () => {
	it('sends each chain to its own explorer', () => {
		expect(revenueTxUrl(SOL_SIG, SOLANA_MAINNET)).toBe(`https://solscan.io/tx/${SOL_SIG}`);
		expect(revenueTxUrl(EVM_TX, BASE_MAINNET)).toBe(`https://basescan.org/tx/${EVM_TX}`);
		expect(revenueTxUrl(EVM_TX, 'eip155:56')).toBe(`https://bscscan.com/tx/${EVM_TX}`);
	});

	it('carries the cluster for non-mainnet Solana', () => {
		expect(revenueTxUrl(SOL_SIG, 'solana:devnet')).toBe(
			`https://solscan.io/tx/${SOL_SIG}?cluster=devnet`,
		);
	});

	it('returns null rather than a link that lands on the wrong chain', () => {
		expect(revenueTxUrl(EVM_TX, 'eip155:987654')).toBeNull();
		expect(revenueTxUrl(EVM_TX, null)).toBeNull();
		expect(revenueTxUrl('', SOLANA_MAINNET)).toBeNull();
		expect(revenueTxUrl(null, SOLANA_MAINNET)).toBeNull();
	});
});

describe('revenue networks: by-network folding', () => {
	it('collapses raw ids into one row per chain, richest first', () => {
		const folded = foldNetworkRows([
			{ network: SOLANA_MAINNET, count: 116657, gross_usd: 2145.706 },
			{ network: BASE_MAINNET, count: 45, gross_usd: 0.076 },
			{ network: 'solana', count: 3, gross_usd: 0.03 },
		]);
		expect(folded).toHaveLength(2);
		expect(folded[0]).toMatchObject({ network: 'solana', label: 'Solana', count: 116660 });
		expect(folded[0].gross_usd).toBeCloseTo(2145.736, 6);
		expect(folded[0].caip).toEqual([SOLANA_MAINNET, 'solana']);
		expect(folded[1]).toMatchObject({ network: 'base', label: 'Base', count: 45 });
	});

	it('handles an empty ledger window', () => {
		expect(foldNetworkRows([])).toEqual([]);
		expect(foldNetworkRows(null)).toEqual([]);
	});
});
