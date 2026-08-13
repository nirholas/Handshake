// Contract tests for the two Bitcoin inscription handlers, api/forever/inscribe.js
// and api/forever/status.js.
//
// OrdinalsBot is stubbed at `fetch` with the exact response shapes the live API
// returns (verified against api.ordinalsbot.com), so every layer under it runs
// for real: validation, upstream status mapping, state derivation, and the
// Esplora confirmation lookup. These cover the defects the audit found:
//   - OrdinalsBot reports failures as HTTP 200 with {status:"error"}. inscribe
//     propagated that 200 verbatim, so an error envelope shipped under a success
//     status and the pay screen rendered an order that was never created.
//   - It answers a rejected payload with a bare 404 and an internal axios
//     string, and would answer a key/quota fault with 401/403. Those were
//     propagated too, telling an authenticated caller they were unauthorized.
//   - status mapped only an upstream HTTP 404 to a 404, but an unknown id comes
//     back as HTTP 200 + "invalid orderId", so every dead order id surfaced as a
//     502 (confirmed against production).
//   - `paid` was derived as "not waiting-payment", which reported an expired or
//     cancelled order the user never paid for as paid.
//   - A malformed receiveAddress passed the shape regex with a broken checksum
//     and was only caught upstream, as an opaque proxy error.
//   - `id` was unbounded and status was unlimited, so both spent the platform's
//     metered upstream budget on arbitrary input.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// Synthetic, deliberately unspendable P2TR program. Checksum-valid so it
// exercises the real bech32m decode, owned by nobody.
const TAPROOT = 'bc1pqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpqqenm';
// Same address with the final checksum character flipped.
const TAPROOT_BAD_CHECKSUM = 'bc1pqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpqqenq';
const REVEAL_TXID = 'a'.repeat(64);

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: async () => (authed ? { id: 'user-1' } : null),
	authenticateBearer: async () => null,
	extractBearer: () => null,
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	clientIp: () => '198.51.100.7',
	limits: {
		inscribeIp: async () => rateLimit,
		inscribeStatusIp: async () => rateLimit,
	},
}));

let authed = true;
let rateLimit = { success: true, limit: 10, remaining: 9, reset: 0 };
let ordinalsbot = null;
let esplora = null;
let ordinalsbotCalls = [];

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_VAULT = process.env.BTC_INSCRIPTION_RECEIVE_ADDRESS;
delete process.env.ORDINALSBOT_BASE_URL;

globalThis.fetch = async (input, init = {}) => {
	const url = typeof input === 'string' ? input : input.url;
	if (url.includes('api.ordinalsbot.com')) {
		ordinalsbotCalls.push({ url, body: init.body ? JSON.parse(init.body) : null });
		if (!ordinalsbot) throw new Error(`unstubbed OrdinalsBot call: ${url}`);
		return ordinalsbot(url);
	}
	if (url.includes('blockstream.info')) {
		if (!esplora) throw new Error(`unstubbed Esplora call: ${url}`);
		return esplora(url);
	}
	throw new Error(`unexpected fetch: ${url}`);
};

const { default: inscribeHandler } = await import('../../api/forever/inscribe.js');
const { default: statusHandler } = await import('../../api/forever/status.js');
const { clearEsploraCache } = await import('../../api/_lib/esplora.js');

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
			this.headersSent = true;
		},
	};
}

async function invoke(handler, { url, method, body }) {
	const req = {
		method,
		url,
		headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
		socket: { remoteAddress: '198.51.100.7' },
	};
	if (body !== undefined) req.body = body;
	const res = makeRes();
	await handler(req, res);
	let payload = null;
	if (res.body) {
		try {
			payload = JSON.parse(res.body);
		} catch {
			payload = res.body;
		}
	}
	return { status: res.statusCode, payload, headers: res.headers };
}

const inscribe = (body, method = 'POST') =>
	invoke(inscribeHandler, { url: '/api/forever/inscribe', method, body });
const status = (id, method = 'GET') =>
	invoke(statusHandler, {
		url: id === undefined ? '/api/forever/status' : `/api/forever/status?id=${encodeURIComponent(id)}`,
		method,
	});

beforeEach(() => {
	authed = true;
	rateLimit = { success: true, limit: 10, remaining: 9, reset: 0 };
	ordinalsbot = null;
	esplora = null;
	ordinalsbotCalls = [];
	process.env.BTC_INSCRIPTION_RECEIVE_ADDRESS = TAPROOT;
	clearEsploraCache();
});

afterAll(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	if (ORIGINAL_VAULT === undefined) delete process.env.BTC_INSCRIPTION_RECEIVE_ADDRESS;
	else process.env.BTC_INSCRIPTION_RECEIVE_ADDRESS = ORIGINAL_VAULT;
});

describe('POST /api/forever/inscribe', () => {
	it('creates a real order and shapes the charge for the pay screen', async () => {
		ordinalsbot = () =>
			jsonResponse({
				status: 'ok',
				id: 'order-abc',
				charge: {
					address: TAPROOT,
					amount: 24500,
					lightning_invoice: { payreq: 'lnbc245u1p' },
					expires_at: 1786582273,
				},
			});

		const r = await inscribe({ message: 'hello forever', feeRate: 12 });

		expect(r.status).toBe(200);
		expect(r.payload.orderId).toBe('order-abc');
		expect(r.payload.charge.amount).toBe(24500);
		expect(r.payload.charge.amountBtc).toBeCloseTo(0.000245, 9);
		expect(r.payload.charge.lightningInvoice).toBe('lnbc245u1p');
		expect(r.payload.feeRate).toBe(12);
		expect(r.payload.sizeBytes).toBe(13);
		expect(r.payload.receiveAddress).toBe(TAPROOT);

		// The message reaches OrdinalsBot as a real base64 text/plain data URL.
		const sent = ordinalsbotCalls[0].body;
		expect(sent.fee).toBe(12);
		expect(Buffer.from(sent.files[0].dataURL.split('base64,')[1], 'base64').toString('utf8')).toBe(
			'hello forever',
		);
	});

	it('rejects a non-POST method', async () => {
		const r = await inscribe(undefined, 'GET');
		expect(r.status).toBe(405);
		expect(ordinalsbotCalls).toHaveLength(0);
	});

	it('requires a signed-in user or bearer token', async () => {
		authed = false;
		const r = await inscribe({ message: 'hello' });
		expect(r.status).toBe(401);
		expect(r.payload.error).toBe('unauthorized');
		expect(ordinalsbotCalls).toHaveLength(0);
	});

	it('returns 429 when the per-IP ceiling is hit', async () => {
		rateLimit = { success: false, limit: 10, remaining: 0, reset: Date.now() + 60_000 };
		const r = await inscribe({ message: 'hello' });
		expect(r.status).toBe(429);
		expect(ordinalsbotCalls).toHaveLength(0);
	});

	it('rejects a body that is not a JSON object', async () => {
		for (const body of ['a string', [1, 2]]) {
			const r = await inscribe(body);
			expect(r.status).toBe(400);
			expect(r.payload.error).toBe('bad_request');
		}
		// A literal JSON `null` body is normalized to `{}` by the server's body
		// parser before the handler sees it, so it lands on the message check.
		// Either way it is a designed 400, never a crash on `body.message`.
		const nullBody = await inscribe(null);
		expect(nullBody.status).toBe(400);
		expect(ordinalsbotCalls).toHaveLength(0);
	});

	it('rejects an empty, non-string, or oversized message', async () => {
		expect((await inscribe({ message: '   ' })).status).toBe(400);
		expect((await inscribe({ message: 42 })).status).toBe(400);
		const long = await inscribe({ message: 'x'.repeat(1501) });
		expect(long.status).toBe(400);
		expect(long.payload.error).toBe('invalid_message');
		expect(ordinalsbotCalls).toHaveLength(0);
	});

	it('rejects an address that is not Taproot, and one whose checksum is broken', async () => {
		const shape = await inscribe({ message: 'hi', receiveAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' });
		expect(shape.status).toBe(400);
		expect(shape.payload.error).toBe('invalid_receive_address');

		// Correct bc1p… shape, wrong bech32m checksum: only the real decode catches
		// this, and before the fix it reached OrdinalsBot as an opaque proxy error.
		const checksum = await inscribe({ message: 'hi', receiveAddress: TAPROOT_BAD_CHECKSUM });
		expect(checksum.status).toBe(400);
		expect(checksum.payload.error).toBe('invalid_receive_address');
		expect(checksum.payload.error_description).toMatch(/checksum/i);

		expect(ordinalsbotCalls).toHaveLength(0);
	});

	it('rejects a fee rate that is not an integer in range', async () => {
		for (const feeRate of [0, 201, 1.5, 'fast']) {
			const r = await inscribe({ message: 'hi', feeRate });
			expect(r.status).toBe(400);
			expect(r.payload.error).toBe('invalid_fee_rate');
		}
		expect(ordinalsbotCalls).toHaveLength(0);
	});

	it('defaults the fee rate and falls back to the configured vault address', async () => {
		ordinalsbot = () => jsonResponse({ id: 'order-def', charge: { address: TAPROOT, amount: 1000 } });
		const r = await inscribe({ message: 'hi' });
		expect(r.status).toBe(200);
		expect(r.payload.feeRate).toBe(8);
		expect(ordinalsbotCalls[0].body.receiveAddress).toBe(TAPROOT);
	});

	it('returns 503 when no address is provided and none is configured', async () => {
		delete process.env.BTC_INSCRIPTION_RECEIVE_ADDRESS;
		const r = await inscribe({ message: 'hi' });
		expect(r.status).toBe(503);
		expect(r.payload.error).toBe('no_receive_address');
		expect(ordinalsbotCalls).toHaveLength(0);
	});

	it('returns 503 rather than inscribing into a misconfigured vault address', async () => {
		process.env.BTC_INSCRIPTION_RECEIVE_ADDRESS = TAPROOT_BAD_CHECKSUM;
		const r = await inscribe({ message: 'hi' });
		expect(r.status).toBe(503);
		expect(r.payload.error).toBe('invalid_vault_address');
		expect(ordinalsbotCalls).toHaveLength(0);
	});

	it('never returns 2xx when OrdinalsBot fails with HTTP 200 + status:error', async () => {
		// The live API's actual failure shape. Propagating its 200 made the client
		// treat an error envelope as a created order.
		ordinalsbot = () => jsonResponse({ status: 'error', error: ['Request failed with status code 404'] });
		const r = await inscribe({ message: 'hi' });
		expect(r.status).toBe(502);
		expect(r.payload.error).toBe('inscription_failed');
		expect(r.payload.error_description).toMatch(/Request failed with status code 404/);
	});

	it('maps an upstream 404 and an upstream auth fault to 502, never to the caller', async () => {
		for (const upstreamStatus of [404, 401, 403]) {
			ordinalsbot = () => jsonResponse({ status: 'error', error: 'nope' }, upstreamStatus);
			const r = await inscribe({ message: 'hi' });
			expect(r.status).toBe(502);
			expect(r.payload.error).toBe('inscription_failed');
		}
	});

	it('relays an upstream throttle as 429', async () => {
		ordinalsbot = () => jsonResponse({ status: 'error', error: 'rate limited' }, 429);
		const r = await inscribe({ message: 'hi' });
		expect(r.status).toBe(429);
		expect(r.payload.error).toBe('upstream_rate_limited');
	});

	it('returns 502 when OrdinalsBot answers with non-JSON', async () => {
		ordinalsbot = () => new Response('<html>502 Bad Gateway</html>', { status: 502 });
		const r = await inscribe({ message: 'hi' });
		expect(r.status).toBe(502);
		expect(r.payload.error).toBe('inscription_failed');
		expect(r.payload.error_description).toMatch(/non-JSON/);
	});
});

describe('GET /api/forever/status', () => {
	it('reports a waiting order as unpaid with its charge and no inscription', async () => {
		ordinalsbot = () =>
			jsonResponse({ id: 'order-abc', status: 'waiting-payment', charge: { address: TAPROOT, amount: 24500 } });

		const r = await status('order-abc');

		expect(r.status).toBe(200);
		expect(r.payload.state).toBe('waiting-payment');
		expect(r.payload.paid).toBe(false);
		expect(r.payload.inscribed).toBe(false);
		expect(r.payload.charge.amountBtc).toBeCloseTo(0.000245, 9);
		expect(r.payload.inscription).toBeNull();
		expect(r.payload.links.chargeAddress).toBe(`https://mempool.space/address/${TAPROOT}`);
	});

	it('reports a completed order with real chain confirmations from Esplora', async () => {
		ordinalsbot = () =>
			jsonResponse({
				id: 'order-abc',
				status: 'completed',
				inscriptionId: `${REVEAL_TXID}i0`,
				tx: { reveal: REVEAL_TXID, commit: 'b'.repeat(64) },
			});
		esplora = (url) =>
			url.endsWith('/blocks/tip/height')
				? new Response('900010', { status: 200, headers: { 'content-type': 'text/plain' } })
				: jsonResponse({ confirmed: true, block_height: 900000, block_time: 1786582273 });

		const r = await status('order-abc');

		expect(r.status).toBe(200);
		expect(r.payload.state).toBe('inscribed');
		expect(r.payload.paid).toBe(true);
		expect(r.payload.inscribed).toBe(true);
		expect(r.payload.inscription.revealTxid).toBe(REVEAL_TXID);
		expect(r.payload.inscription.onchain).toEqual({
			confirmed: true,
			confirmations: 11,
			blockHeight: 900000,
			blockTime: 1786582273,
			source: 'esplora',
		});
		expect(r.payload.links.inscription).toBe(`https://ordinals.com/inscription/${REVEAL_TXID}i0`);
	});

	it('degrades onchain to null when Esplora is down, without failing the response', async () => {
		ordinalsbot = () =>
			jsonResponse({ id: 'order-abc', status: 'completed', inscriptionId: `${REVEAL_TXID}i0` });
		esplora = () => new Response('gateway timeout', { status: 504 });

		const r = await status('order-abc');

		expect(r.status).toBe(200);
		expect(r.payload.state).toBe('inscribed');
		expect(r.payload.inscription.onchain).toBeNull();
	});

	it('does not report a failed order as paid', async () => {
		// An expired or cancelled order is normally one the user never paid for.
		ordinalsbot = () => jsonResponse({ id: 'order-abc', status: 'expired' });
		const r = await status('order-abc');
		expect(r.payload.state).toBe('failed');
		expect(r.payload.paid).toBe(false);
		expect(r.payload.inscribed).toBe(false);
	});

	it('returns 404 for an unknown order id, which OrdinalsBot reports as HTTP 200', async () => {
		ordinalsbot = () => jsonResponse({ status: 'error', error: 'invalid orderId' });
		const r = await status('order-that-never-existed');
		expect(r.status).toBe(404);
		expect(r.payload.error).toBe('order_not_found');
	});

	it('returns 502 for a genuine upstream fault', async () => {
		ordinalsbot = () => jsonResponse({ status: 'error', error: 'internal server error' }, 500);
		const r = await status('order-abc');
		expect(r.status).toBe(502);
		expect(r.payload.error).toBe('status_lookup_failed');
	});

	it('rejects a missing or malformed id before spending an upstream call', async () => {
		const missing = await status(undefined);
		expect(missing.status).toBe(400);
		expect(missing.payload.error).toBe('missing_id');

		for (const id of ['x'.repeat(129), 'has spaces', '../../etc/passwd']) {
			const r = await status(id);
			expect(r.status).toBe(400);
			expect(r.payload.error).toBe('invalid_id');
		}
		expect(ordinalsbotCalls).toHaveLength(0);
	});

	it('rejects a non-GET method', async () => {
		const r = await status('order-abc', 'POST');
		expect(r.status).toBe(405);
		expect(ordinalsbotCalls).toHaveLength(0);
	});

	it('caps polling per IP so the shared upstream budget cannot be drained', async () => {
		rateLimit = { success: false, limit: 200, remaining: 0, reset: Date.now() + 60_000 };
		const r = await status('order-abc');
		expect(r.status).toBe(429);
		expect(ordinalsbotCalls).toHaveLength(0);
	});
});
