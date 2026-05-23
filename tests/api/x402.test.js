/**
 * Tests for the x402 helper. Pure-logic only — no DB, no fetch.
 *
 * verifyPaid touches the DB (via _lib/db.js); we exercise emit402 and
 * manifestOnly, which are stateless transformations of agent + skill.
 */

import { describe, it, expect } from 'vitest';
import { emit402, manifestOnly, X402_VERSION } from '../../api/_lib/x402.js';

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(name, value) {
			this.headers[name.toLowerCase()] = value;
		},
		end(body) {
			this.body = body;
		},
	};
}

function makeAgent(overrides = {}) {
	return {
		id: 'agent-uuid',
		name: 'Test Agent',
		meta: {
			payments: {
				configured: true,
				provider: 'pumpfun',
				mint: 'MintPubkey1111111111111111111111111111111',
				receiver: 'OwnerWallet111111111111111111111111111111',
				cluster: 'mainnet',
			},
			...overrides,
		},
	};
}

describe('emit402', () => {
	it('returns 402 with a canonical manifest', async () => {
		const res = makeRes();
		await emit402(res, {
			agent: makeAgent(),
			skill: 'summarize',
			amount: '10000',
			currency: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
		});
		expect(res.statusCode).toBe(402);
		expect(res.headers['content-type']).toBe('application/json');
		expect(res.headers['cache-control']).toBe('no-store');
		expect(res.headers['link']).toMatch(/payment-manifest/);

		const body = JSON.parse(res.body);
		expect(body.version).toBe(X402_VERSION);
		expect(body.kind).toBe('agent-skill');
		expect(body.agent_id).toBe('agent-uuid');
		expect(body.skill).toBe('summarize');
		expect(body.amount).toBe('10000');
		expect(body.currency).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
		expect(body.recipient).toBe('OwnerWallet111111111111111111111111111111');
		expect(body.intent_url).toBe('/api/agents/payments/pay-prep');
		expect(body.verify_url).toBe('/api/agents/payments/pay-confirm');
		expect(body.retry_with_header).toBe('x-payment-intent');
		expect(typeof body.valid_until).toBe('number');
		expect(body.valid_until).toBeGreaterThan(Date.now() / 1000);
	});

	it('refuses to 402 when payments are not configured', async () => {
		const res = makeRes();
		const agent = { id: 'x', name: 'x', meta: { payments: { configured: false } } };
		// emit402 should fall through to error() — we just assert it didn't 402.
		await emit402(res, { agent, skill: 's', amount: '1', currency: 'X' });
		expect(res.statusCode).not.toBe(402);
	});

	it('honors validForSec', async () => {
		const res = makeRes();
		const before = Math.floor(Date.now() / 1000);
		await emit402(res, {
			agent: makeAgent(),
			skill: 's',
			amount: '1',
			currency: 'X',
			validForSec: 60,
		});
		const body = JSON.parse(res.body);
		expect(body.valid_until - before).toBeGreaterThanOrEqual(59);
		expect(body.valid_until - before).toBeLessThanOrEqual(61);
	});
});

describe('manifestOnly', () => {
	it('returns the same manifest shape with status 200', async () => {
		// We mock just enough of the http json() helper to get a captured body.
		const captured = {};
		const res = {
			statusCode: 0,
			headers: {},
			setHeader(k, v) {
				this.headers[k.toLowerCase()] = v;
			},
			end(body) {
				captured.body = body;
				captured.status = this.statusCode;
			},
		};
		await manifestOnly(res, {
			agent: makeAgent(),
			skill: 'echo',
			amount: '5000',
			currency: 'CURRENCY-MINT',
		});
		expect(captured.status).toBe(200);
		const body = JSON.parse(captured.body);
		expect(body.version).toBe(X402_VERSION);
		expect(body.skill).toBe('echo');
		expect(body.amount).toBe('5000');
	});
});
