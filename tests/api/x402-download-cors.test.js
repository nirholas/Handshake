// CORS contract for the two x402 download handlers.
//
// api/x402/asset-download.js and api/x402/animation-download.js are the only
// endpoints in api/x402/ that answer requests themselves before delegating to
// paidEndpoint: they serve the discovery 402, the 400/404/502 errors, and (for
// animation-download) the free-listing 200 from their own code. paidEndpoint is
// what installs CORS for every other endpoint in the directory, so these two
// shipped with none: on production an OPTIONS preflight fell straight through
// to a 402 carrying no Access-Control-Allow-Origin, which left every browser
// x402 client (the drop-in modal, x402-fetch) unable to even read the challenge
// it was supposed to pay. These tests pin the headers on both handlers.

import { describe, it, expect } from 'vitest';
import assetDownload from '../../api/x402/asset-download.js';
import animationDownload from '../../api/x402/animation-download.js';

function makeRes() {
	const headers = {};
	return {
		headers,
		statusCode: 200,
		ended: false,
		body: undefined,
		setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return headers[String(k).toLowerCase()]; },
		status(code) { this.statusCode = code; return this; },
		json(payload) { this.body = payload; this.ended = true; return this; },
		end(payload) { this.body = payload; this.ended = true; return this; },
	};
}

const HANDLERS = [
	['asset-download', assetDownload],
	['animation-download', animationDownload],
];

describe.each(HANDLERS)('%s CORS', (name, handler) => {
	it('answers an OPTIONS preflight with 204 and the wildcard origin', async () => {
		const res = makeRes();
		await handler({ method: 'OPTIONS', headers: { origin: 'https://example.com' }, query: {} }, res);

		expect(res.statusCode).toBe(204);
		expect(res.ended).toBe(true);
		expect(res.getHeader('access-control-allow-origin')).toBe('*');
		expect(res.getHeader('access-control-allow-methods')).toBe('GET,HEAD,OPTIONS');
	});

	it('exposes the x402 payment headers a cross-origin client must read', async () => {
		const res = makeRes();
		await handler({ method: 'OPTIONS', headers: {}, query: {} }, res);

		const exposed = String(res.getHeader('access-control-expose-headers'));
		expect(exposed).toContain('PAYMENT-REQUIRED');
		expect(exposed).toContain('x-payment-response');
	});

	it('sets the origin header on the bare-route discovery challenge too', async () => {
		const res = makeRes();
		// No slug / no id: the discovery-probe branch, which builds its own 402
		// without ever reaching paidEndpoint.
		await handler({ method: 'GET', headers: {}, query: {} }, res);

		expect(res.getHeader('access-control-allow-origin')).toBe('*');
		expect(res.statusCode).toBe(402);
	});
});
