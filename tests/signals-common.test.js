/**
 * Shared helpers behind the signal-marketplace endpoints (api/signals/_common.js).
 *
 * These are small, but three of them sit directly on a money path: parseRowId
 * decides whether a caller typo becomes an honest 400 or a Postgres bigint cast
 * error surfaced as a 500, feedSlug is the public identity a paid feed is sold
 * and linked under, and loadOwnedAgent is the ownership gate every publisher and
 * subscriber write runs through.
 */

import { describe, it, expect } from 'vitest';
import { parseRowId, normNetwork, NETWORKS, slugify, feedSlug, loadOwnedAgent } from '../api/signals/_common.js';

function captureRes() {
	return {
		statusCode: 200,
		_headers: {},
		_body: '',
		setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
		getHeader(k) { return this._headers[k.toLowerCase()]; },
		end(b) { this._body = b || ''; },
		get headersSent() { return false; },
		get writableEnded() { return false; },
		get json() {
			try { return JSON.parse(this._body); } catch { return null; }
		},
	};
}

describe('parseRowId', () => {
	it('accepts a positive integer id as a string or a number', () => {
		expect(parseRowId('1')).toBe(1);
		expect(parseRowId('  42 ')).toBe(42);
		expect(parseRowId(9007199254740991)).toBe(9007199254740991);
	});

	it('rejects everything Postgres would reject as a bigint', () => {
		for (const bad of ['abc', '', '  ', '1.5', '-3', '0', '1e3', '12abc', '0x10', '9007199254740993']) {
			expect(parseRowId(bad), `expected ${JSON.stringify(bad)} to be rejected`).toBeNull();
		}
	});

	it('rejects non-scalar and empty inputs rather than stringifying them', () => {
		expect(parseRowId(null)).toBeNull();
		expect(parseRowId(undefined)).toBeNull();
		expect(parseRowId(true)).toBeNull();
		expect(parseRowId(['1'])).toBeNull();
		expect(parseRowId({ id: 1 })).toBeNull();
	});
});

describe('normNetwork', () => {
	it('passes through the two supported networks', () => {
		expect(normNetwork('mainnet')).toBe('mainnet');
		expect(normNetwork('devnet')).toBe('devnet');
		expect([...NETWORKS].sort()).toEqual(['devnet', 'mainnet']);
	});

	it('falls back to mainnet for anything else', () => {
		expect(normNetwork(null)).toBe('mainnet');
		expect(normNetwork('testnet')).toBe('mainnet');
		expect(normNetwork('DEVNET')).toBe('mainnet');
	});
});

describe('slugify', () => {
	it('kebabs arbitrary text and trims the edges', () => {
		expect(slugify('Alpha Trader 9000')).toBe('alpha-trader-9000');
		expect(slugify('  !!Ape Signals!!  ')).toBe('ape-signals');
	});

	it('bounds the length and never returns an empty slug', () => {
		expect(slugify('x'.repeat(200)).length).toBe(40);
		expect(slugify('a'.repeat(200), 10)).toBe('a'.repeat(10));
		expect(slugify('!!!')).toBe('feed');
		expect(slugify(null)).toBe('feed');
	});
});

describe('feedSlug', () => {
	const agentId = 'b3e99b4f-13e8-4c00-9d59-b90e22bac9b4';

	it('binds the publisher name to the agent id so two feeds cannot collide', () => {
		expect(feedSlug('Alpha Trader', agentId, 'mainnet')).toBe('alpha-trader-b3e99b4f');
		expect(feedSlug('Alpha Trader', '11111111-2222-3333-4444-555555555555', 'mainnet'))
			.toBe('alpha-trader-11111111');
	});

	it('keeps the devnet feed on its own slug', () => {
		expect(feedSlug('Alpha Trader', agentId, 'devnet')).toBe('alpha-trader-b3e99b4f-dev');
	});
});

describe('loadOwnedAgent', () => {
	it('rejects a missing agent id with a 400 before it ever reaches the database', async () => {
		const res = captureRes();
		const result = await loadOwnedAgent({}, res, 'user-1', undefined);
		expect(result).toEqual({ error: true });
		expect(res.statusCode).toBe(400);
		expect(res.json).toMatchObject({ error: 'invalid_agent' });
		expect(res.getHeader('cache-control')).toBe('no-store');
	});
});
