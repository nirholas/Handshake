import { describe, it, expect } from 'vitest';

import { capabilityKey, tailFromUrl, venueSpreadListings } from '../api/bazaar/arbitrage.js';

const listing = (over = {}) => ({
	type: 'http',
	resource: 'https://api.example.com/api/weather-forecast',
	facilitator: 'https://facilitator.example.com',
	serviceName: '',
	toolName: '',
	...over,
});

const entry = (resource, facilitator, usdc) => ({ it: listing({ resource, facilitator }), usdc });

describe('arbitrage capability keys from URLs', () => {
	it('reads the last literal segment as the capability', () => {
		expect(tailFromUrl('https://api.example.com/api/weather-forecast')).toBe('weather-forecast');
	});

	it('strips a trailing hash-like suffix so the same capability collapses across hosts', () => {
		expect(tailFromUrl('https://a.example.com/proxy/who-to-contact-api-97ccc0')).toBe('who-to-contact-api');
		expect(tailFromUrl('https://a.example.com/proxy/inbox-ac248a2b')).toBe('inbox');
	});

	it('keeps an all-letter suffix, which is part of the capability name and not a hash', () => {
		expect(tailFromUrl('https://a.example.com/api/token-safety')).toBe('token-safety');
		expect(tailFromUrl('https://a.example.com/api/weather-forecast')).toBe('weather-forecast');
	});

	it('skips a colon route placeholder and uses the segment that names the capability', () => {
		expect(tailFromUrl('https://api.deepnets.ai/api/token-safety/:solana_address')).toBe('token-safety');
		expect(tailFromUrl('https://api.deepnets.ai/api/holder-analysis/:solana_address')).toBe('holder-analysis');
	});

	it('skips brace, angle, and bracket placeholder spellings too', () => {
		expect(tailFromUrl('https://api.example.com/v1/token-details/{mint}')).toBe('token-details');
		expect(tailFromUrl('https://api.example.com/v1/token-details/<mint>')).toBe('token-details');
		expect(tailFromUrl('https://api.example.com/v1/token-details/[mint]')).toBe('token-details');
	});

	it('skips consecutive placeholders', () => {
		expect(tailFromUrl('https://api.paysponge.com/v0/inboxes/:inbox_id/threads/:thread_id')).toBe('threads');
	});

	it('returns empty for a malformed URL', () => {
		expect(tailFromUrl('not a url')).toBe('');
	});

	it('does not group two different products that take the same argument', () => {
		const safety = capabilityKey(listing({ resource: 'https://api.deepnets.ai/api/token-safety/:solana_address' }));
		const holders = capabilityKey(listing({ resource: 'https://api.deepnets.ai/api/holder-analysis/:solana_address' }));
		expect(safety).toBe('http:token-safety');
		expect(holders).toBe('http:holder-analysis');
		expect(safety).not.toBe(holders);
	});

	it('prefers an explicit service name over the URL', () => {
		expect(capabilityKey(listing({ serviceName: 'Chain ID Lookup', resource: 'https://api.delx.ai/api/v1/x402/chain-id-lookup' })))
			.toBe('http:chain-id-lookup');
	});

	it('keys MCP listings by tool name', () => {
		expect(capabilityKey(listing({ type: 'mcp', toolName: 'get_weather' }))).toBe('mcp:getweather');
	});

	it('refuses a single short URL token that would collide across unrelated services', () => {
		expect(capabilityKey(listing({ resource: 'https://api.example.com/buy' }))).toBe(null);
	});
});

describe('cross-venue spread detection', () => {
	it('keeps only listings where one resource is quoted by two facilitators at two prices', () => {
		const shared = 'https://one.example.com/api/quote';
		const group = [
			entry(shared, 'https://facilitator-a.example.com', 20000),
			entry(shared, 'https://facilitator-b.example.com', 100000),
			entry('https://one.example.com/api/other', 'https://facilitator-a.example.com', 5000),
		];
		const kept = venueSpreadListings(group);
		expect(kept).toHaveLength(2);
		expect(kept.every((e) => e.it.resource === shared)).toBe(true);
	});

	it('rejects a vendor pricing its own distinct endpoints differently', () => {
		const group = [
			entry('https://conc-exe.xyz/api/concierge-intel-whales', 'https://facilitator-a.example.com', 20000),
			entry('https://conc-exe.xyz/api/concierge-intel-airdrop', 'https://facilitator-b.example.com', 100000),
		];
		expect(venueSpreadListings(group)).toHaveLength(0);
	});

	it('rejects the same resource on two facilitators at the same price', () => {
		const shared = 'https://one.example.com/api/quote';
		const group = [
			entry(shared, 'https://facilitator-a.example.com', 20000),
			entry(shared, 'https://facilitator-b.example.com', 20000),
		];
		expect(venueSpreadListings(group)).toHaveLength(0);
	});

	it('rejects one facilitator quoting one resource at two prices', () => {
		const shared = 'https://one.example.com/api/quote';
		const group = [
			entry(shared, 'https://facilitator-a.example.com', 20000),
			entry(shared, 'https://facilitator-a.example.com', 100000),
		];
		expect(venueSpreadListings(group)).toHaveLength(0);
	});
});
