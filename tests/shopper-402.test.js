import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// /shopper runs a real paid x402 endpoint, so a 402 is the normal first answer
// for anyone who has not paid. These cover how the page reads that challenge:
// which payment option it quotes, and where it finds the challenge when a proxy
// has rewritten one of the two carriers (JSON body, `payment-required` header).

const { readAccepts, pickAccept, formatAmount, networkLabel } = await import(
	'../src/shopper-app.js'
);

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

// The exact envelope the deployed route answers with, captured from the live
// endpoint so the parsing is held to the real wire format.
const CHALLENGE = {
	x402Version: 2,
	error: 'X-PAYMENT header is required',
	accepts: [
		{
			scheme: 'exact',
			amount: '10000',
			network: 'eip155:8453',
			payTo: '0x4022de2d36c334e73c7a108805cea11c0564f402',
			asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
			extra: { name: 'USD Coin', version: '2', decimals: 6 },
		},
		{
			scheme: 'exact',
			amount: '10000',
			network: 'eip155:8453',
			payTo: '0x4022de2d36c334e73c7a108805cea11c0564f402',
			asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
			extra: {
				name: 'USD Coin',
				version: '2',
				decimals: 6,
				assetTransferMethod: 'permit2',
				supportsEip2612: true,
			},
		},
		{
			scheme: 'exact',
			amount: '10000',
			network: SOLANA,
			payTo: 'wwwwwDxFWRn7grgr3Esrsg5C6NvDoDHSA4gaCffccrU',
			asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
			extra: { name: 'USDC', decimals: 6 },
		},
		{
			scheme: 'exact',
			amount: '10000000',
			network: SOLANA,
			payTo: 'wwwwwDxFWRn7grgr3Esrsg5C6NvDoDHSA4gaCffccrU',
			asset: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
			extra: { name: 'THREE', decimals: 6 },
		},
	],
};

const HEADER = Buffer.from(JSON.stringify(CHALLENGE), 'utf8').toString('base64');

describe('reading the 402 challenge', () => {
	it('prefers the JSON body', () => {
		expect(readAccepts(CHALLENGE, null)).toHaveLength(4);
	});

	it('falls back to the base64 payment-required header when the body is stripped', () => {
		const accepts = readAccepts({ x402Version: 2, error: 'X-PAYMENT header is required' }, HEADER);
		expect(accepts).toHaveLength(4);
		expect(accepts[0].network).toBe('eip155:8453');
	});

	it('returns nothing when neither carrier holds a challenge', () => {
		expect(readAccepts({}, null)).toEqual([]);
		expect(readAccepts({}, 'not-base64-at-all!!')).toEqual([]);
	});
});

describe('choosing the requirement to sign', () => {
	it('skips the Permit2 sibling on EVM, which the wallet flow cannot sign', () => {
		const base = pickAccept(CHALLENGE.accepts, 'base');
		expect(base.network).toBe('eip155:8453');
		expect(base.extra.assetTransferMethod).toBeUndefined();
	});

	it('quotes the stablecoin option on Solana, not the alternative asset', () => {
		const sol = pickAccept(CHALLENGE.accepts, 'solana');
		expect(sol.network).toBe(SOLANA);
		expect(sol.extra.name).toBe('USDC');
	});

	it('returns null for a network the challenge does not offer', () => {
		const evmOnly = CHALLENGE.accepts.filter((a) => a.network.startsWith('eip155:'));
		expect(pickAccept(evmOnly, 'solana')).toBeNull();
	});
});

describe('quoting the price', () => {
	it('renders atomic USDC as a trimmed decimal', () => {
		expect(formatAmount('10000', 6)).toBe('0.01');
		expect(formatAmount('1000000', 6)).toBe('1');
		expect(formatAmount('1500000', 6)).toBe('1.5');
	});

	it('survives a missing or unparseable amount instead of printing NaN', () => {
		expect(formatAmount(undefined, 6)).toBe('0');
		expect(formatAmount('abc', 6)).toBe('0');
	});

	it('names the chains it quotes', () => {
		expect(networkLabel('eip155:8453')).toBe('Base');
		expect(networkLabel(SOLANA)).toBe('Solana');
	});
});

describe('the page no longer hands the challenge to the generic paywall', () => {
	// The paywall decodes `?req=` as a base64 requirements ARRAY and replays the
	// resource as a bodyless GET. This route's challenge is an envelope and its
	// resource is a POST that needs the task body, so both assumptions broke:
	// the buyer saw an empty paywall, and a payment would have unlocked nothing.
	it('builds no paywall.html URL', () => {
		const source = readFileSync(new URL('../src/shopper-app.js', import.meta.url), 'utf8');
		expect(source).not.toMatch(/\/paywall\.html\?/);
	});
});
