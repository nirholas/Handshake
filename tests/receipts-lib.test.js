// /receipts page helpers. The critical contract: buildReceiptsMessage must be
// byte-identical to buildExpectedMessage() in api/x402/my-receipts.js, or
// buyer signatures stop verifying server-side.
import { describe, it, expect } from 'vitest';

import {
	buildReceiptsMessage,
	signatureStillFresh,
	SIGNATURE_TTL_SECONDS,
	networkLabel,
	explorerTxUrl,
	shortAddress,
	resourceDisplay,
	receiptsToCsv,
	summarizeReceipts,
} from '../src/receipts-lib.js';

const SOL_ADDR = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const EVM_ADDR = '0xAbCdEf0123456789aBcDeF0123456789ABCDEF01';

describe('buildReceiptsMessage', () => {
	// Mirror of the server's buildExpectedMessage, copied verbatim from
	// api/x402/my-receipts.js so a drift on either side fails this test.
	function serverExpectedMessage(address, issuedAt, network) {
		const normalized = network === 'solana' ? address : address.toLowerCase();
		return `three.ws x402 receipts read\nNetwork: ${network}\nAddress: ${normalized}\nIssued At: ${issuedAt}`;
	}

	it('matches the server contract for Solana (verbatim base58)', () => {
		const issuedAt = '2026-07-28T12:00:00.000Z';
		expect(buildReceiptsMessage(SOL_ADDR, issuedAt, 'solana')).toBe(
			serverExpectedMessage(SOL_ADDR, issuedAt, 'solana'),
		);
		expect(buildReceiptsMessage(SOL_ADDR, issuedAt, 'solana')).toContain(SOL_ADDR);
	});

	it('matches the server contract for EVM (lowercased address)', () => {
		const issuedAt = '2026-07-28T12:00:00.000Z';
		const msg = buildReceiptsMessage(EVM_ADDR, issuedAt, 'evm');
		expect(msg).toBe(serverExpectedMessage(EVM_ADDR, issuedAt, 'evm'));
		expect(msg).toContain(EVM_ADDR.toLowerCase());
		expect(msg).not.toContain(EVM_ADDR);
	});
});

describe('signatureStillFresh', () => {
	const now = Date.parse('2026-07-28T12:00:00.000Z');

	it('accepts a signature issued moments ago', () => {
		expect(signatureStillFresh(new Date(now - 10_000).toISOString(), now)).toBe(true);
	});

	it('rejects one older than the TTL minus the safety margin', () => {
		const old = new Date(now - (SIGNATURE_TTL_SECONDS - 10) * 1000).toISOString();
		expect(signatureStillFresh(old, now)).toBe(false);
	});

	it('rejects future timestamps and garbage', () => {
		expect(signatureStillFresh(new Date(now + 60_000).toISOString(), now)).toBe(false);
		expect(signatureStillFresh('not-a-date', now)).toBe(false);
		expect(signatureStillFresh(undefined, now)).toBe(false);
	});
});

describe('networkLabel + explorerTxUrl', () => {
	it('handles CAIP-2 and plain network strings', () => {
		expect(networkLabel('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe('Solana');
		expect(networkLabel('solana')).toBe('Solana');
		expect(networkLabel('eip155:8453')).toBe('Base');
		expect(networkLabel('base')).toBe('Base');
		expect(networkLabel('eip155:56')).toBe('BNB Chain');
		expect(networkLabel('weird-chain')).toBe('weird-chain');
	});

	it('routes txs to the right explorer', () => {
		expect(explorerTxUrl('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'abc123')).toBe(
			'https://solscan.io/tx/abc123',
		);
		expect(explorerTxUrl('base', '0xdeadbeef')).toBe('https://basescan.org/tx/0xdeadbeef');
		expect(explorerTxUrl('eip155:1', '0xdeadbeef')).toBe('https://etherscan.io/tx/0xdeadbeef');
	});

	it('returns null with no tx or no mapped explorer', () => {
		expect(explorerTxUrl('solana', null)).toBe(null);
		expect(explorerTxUrl('unknown-chain', 'abc')).toBe(null);
	});
});

describe('display helpers', () => {
	it('shortAddress truncates long addresses only', () => {
		expect(shortAddress(SOL_ADDR)).toBe('FeMbDo…pump');
		expect(shortAddress('short')).toBe('short');
	});

	it('resourceDisplay strips the three.ws origin, keeps foreign hosts', () => {
		expect(resourceDisplay('https://three.ws/api/x402/d/prices')).toBe('/api/x402/d/prices');
		expect(resourceDisplay('https://api.example.com/data?x=1')).toBe('api.example.com/data?x=1');
		expect(resourceDisplay('not a url')).toBe('not a url');
	});
});

describe('receiptsToCsv', () => {
	it('emits a stable header and escapes quoted cells', () => {
		const csv = receiptsToCsv([
			{
				id: 1,
				issuedAt: '2026-07-28T00:00:00.000Z',
				network: 'solana',
				resourceUrl: 'https://three.ws/api/x402/d/prices?a="x",b',
				transaction: 'sig1',
				format: 'jws',
				payer: SOL_ADDR,
			},
		]);
		const [header, row] = csv.split('\n');
		expect(header).toBe('id,issued_at,network,resource_url,transaction,format,payer');
		expect(row).toContain('"https://three.ws/api/x402/d/prices?a=""x"",b"');
		expect(row).toContain(SOL_ADDR);
	});

	it('handles empty input', () => {
		expect(receiptsToCsv([])).toBe('id,issued_at,network,resource_url,transaction,format,payer');
	});
});

describe('summarizeReceipts', () => {
	it('counts endpoints, networks, and the time range', () => {
		const s = summarizeReceipts([
			{ resourceUrl: 'https://three.ws/a', network: 'solana', issuedAt: '2026-07-01T00:00:00Z' },
			{ resourceUrl: 'https://three.ws/a', network: 'solana', issuedAt: '2026-07-02T00:00:00Z' },
			{ resourceUrl: 'https://three.ws/b', network: 'base', issuedAt: '2026-07-03T00:00:00Z' },
		]);
		expect(s.total).toBe(3);
		expect(s.endpoints).toBe(2);
		expect(s.networks).toEqual(['Solana', 'Base']);
		expect(s.firstAt).toBe('2026-07-01T00:00:00.000Z');
		expect(s.lastAt).toBe('2026-07-03T00:00:00.000Z');
	});

	it('handles the empty vault', () => {
		const s = summarizeReceipts([]);
		expect(s.total).toBe(0);
		expect(s.firstAt).toBe(null);
	});
});
