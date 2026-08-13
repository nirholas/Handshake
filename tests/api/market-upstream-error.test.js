// Unit tests for the shared market-data upstream contract
// (api/_lib/market/upstream-error.js), which every Granite market handler
// (api/ibm/oracle.js, twin.js, attest.js) answers GeckoTerminal failures with.

import { describe, it, expect } from 'vitest';
import {
	classifyMarketError,
	marketUpstreamError,
	callMarket,
	isMarketUpstreamError,
} from '../../api/_lib/market/upstream-error.js';

const fault = (status) =>
	Object.assign(new Error(`GeckoTerminal ${status}: {"meta":{"ref_id":"abc"}}`), { status });

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
		},
	};
}

describe('classifyMarketError', () => {
	it('maps a missing pool to a non-retryable 404', () => {
		expect(classifyMarketError(fault(404))).toMatchObject({
			status: 404,
			code: 'pool_not_found',
			retryable: false,
		});
	});

	it('maps a throttle to a retryable 503', () => {
		expect(classifyMarketError(fault(429))).toMatchObject({
			status: 503,
			code: 'upstream_rate_limited',
			retryable: true,
		});
	});

	it('maps an upstream outage to 502', () => {
		expect(classifyMarketError(fault(502))).toMatchObject({
			status: 502,
			code: 'upstream_error',
		});
	});

	it('maps an error with no status to 502 rather than guessing', () => {
		expect(classifyMarketError(new Error('socket hang up'))).toMatchObject({
			status: 502,
			code: 'upstream_error',
		});
		expect(classifyMarketError(undefined).status).toBe(502);
	});

	it('never echoes the upstream body', () => {
		for (const status of [404, 429, 502]) {
			expect(classifyMarketError(fault(status)).message).not.toMatch(/ref_id|GeckoTerminal/);
		}
	});
});

describe('marketUpstreamError', () => {
	it('writes the mapped status, code, and retryable flag', () => {
		const res = makeRes();
		marketUpstreamError(res, fault(429));
		expect(res.statusCode).toBe(503);
		const body = JSON.parse(res.body);
		// Always a real error code. An upstream error carries a status but never a
		// code, so forwarding `err.code` produced a body with no `error` field.
		expect(body.error).toBe('upstream_rate_limited');
		expect(body.retryable).toBe(true);
	});

	it('never caches an error response', () => {
		const res = makeRes();
		marketUpstreamError(res, fault(502));
		expect(res.headers['cache-control']).toBe('no-store');
	});
});

describe('callMarket', () => {
	it('passes a successful result straight through', async () => {
		await expect(callMarket(async () => ['pool'])).resolves.toEqual(['pool']);
	});

	it('tags whatever the call throws as an upstream fault', async () => {
		const err = await callMarket(async () => {
			throw fault(429);
		}).catch((e) => e);
		expect(isMarketUpstreamError(err)).toBe(true);
		expect(err.status).toBe(429); // the real status survives for classification
	});

	it('tags a non-Error rejection too', async () => {
		const err = await callMarket(async () => {
			throw 'upstream exploded';
		}).catch((e) => e);
		expect(isMarketUpstreamError(err)).toBe(true);
		expect(err).toBeInstanceOf(Error);
	});

	it('does not tag errors raised outside a market call', () => {
		expect(isMarketUpstreamError(new Error('bad_token'))).toBe(false);
		expect(isMarketUpstreamError(null)).toBe(false);
	});
});
