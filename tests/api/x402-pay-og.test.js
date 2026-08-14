// /api/x402-pay/og: the share card for a /pay/calls/<tx> permalink.
//
// This endpoint is read by unfurlers (X, Slack, Discord, Telegram), never by a
// signed-in user, so its failure modes are silent: a 405 on a HEAD probe, an
// hour of CDN-cached generic card after a transient Redis blip, or a "NaNd ago"
// stat all ship a broken preview that nothing in the app surfaces. Cover the
// resolved card, every unresolved path, and the caller-controlled text that
// lands inside the SVG.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const redisGet = vi.fn(async () => null);
let redisAvailable = true;
vi.mock('../../api/_lib/redis.js', () => ({
	getRedis: () => (redisAvailable ? { get: (...a) => redisGet(...a) } : null),
}));

vi.mock('../../api/_lib/usage.js', () => ({
	logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
	recordEvent: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async () => []),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: async () => ({ pressured: false }),
}));

const { default: handler } = await import('../../api/x402-pay/og.js');

const MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
// Synthetic 88-char base58 signature: the right shape, no real settlement.
const TX = '3'.repeat(88);
const PAYER = 'THREEsynthetic1111111111111111111111111111';

function makeRes() {
	const res = {
		statusCode: 200,
		headers: {},
		body: '',
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = String(v); },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(chunk) {
			if (chunk) this.body += chunk;
			this.headersSent = true;
			this.writableEnded = true;
			return this;
		},
	};
	return res;
}

async function call(url, { method = 'GET', headers = {} } = {}) {
	const req = { url, method, headers: { host: 'three.ws', ...headers }, query: {} };
	const res = makeRes();
	await handler(req, res);
	return res;
}

function record(over = {}) {
	return {
		ts: Date.now() - 90_000,
		tool: 'solana_balance',
		argsSummary: 'address=THREEsynthetic…',
		tx: TX,
		network: MAINNET,
		amount: 1000,
		payer: PAYER,
		...over,
	};
}

beforeEach(() => {
	redisAvailable = true;
	redisGet.mockReset();
	redisGet.mockResolvedValue(null);
});

describe('GET /api/x402-pay/og: resolved card', () => {
	it('renders the settled call from the persisted record', async () => {
		redisGet.mockResolvedValue(JSON.stringify(record()));
		const res = await call(`/api/x402-pay/og?tx=${TX}`);

		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toBe('image/svg+xml; charset=utf-8');
		expect(redisGet).toHaveBeenCalledWith(`x402:pay:call:${TX}`);
		expect(res.body).toContain('solana_balance');
		expect(res.body).toContain('0.001000 USDC');
		expect(res.body).toContain('Solana mainnet');
		expect(res.body).toContain('1m ago');
		expect(res.body).toContain(`${PAYER.slice(0, 6)}…${PAYER.slice(-4)}`);
		// An immutable settled record is safe to cache at the edge for an hour.
		expect(res.headers['cache-control']).toContain('max-age=3600');
		expect(res.headers['content-length']).toBe(String(Buffer.byteLength(res.body)));
	});

	it('captions a devnet receipt as devnet instead of hardcoding mainnet', async () => {
		redisGet.mockResolvedValue(JSON.stringify(record({ network: DEVNET })));
		const res = await call(`/api/x402-pay/og?tx=${TX}`);
		expect(res.body).toContain('Solana devnet');
		expect(res.body).not.toContain('Solana mainnet');
	});

	it('escapes caller-controlled text instead of letting it into the markup', async () => {
		redisGet.mockResolvedValue(JSON.stringify(record({
			tool: '<script>alert(1)</script>',
			argsSummary: 'q="a"&b=\'c\'',
		})));
		const res = await call(`/api/x402-pay/og?tx=${TX}`);
		expect(res.body).not.toContain('<script>');
		expect(res.body).toContain('&lt;script&gt;');
		expect(res.body).toContain('&quot;');
		expect(res.body).toContain('&apos;');
		expect(res.headers['content-security-policy']).toContain("default-src 'none'");
	});

	it('clamps an unbounded tool name so it cannot paint over the card', async () => {
		redisGet.mockResolvedValue(JSON.stringify(record({ tool: 'z'.repeat(400) })));
		const res = await call(`/api/x402-pay/og?tx=${TX}`);
		expect(res.body).not.toContain('z'.repeat(60));
		expect(res.body).toContain(`${'z'.repeat(37)}…`);
	});

	it('renders a corrupt record without NaN or a fabricated amount', async () => {
		redisGet.mockResolvedValue(JSON.stringify(record({
			ts: 'not-a-time', amount: 'not-a-number', tx: 12345, payer: null, network: undefined,
		})));
		const res = await call(`/api/x402-pay/og?tx=${TX}`);
		expect(res.statusCode).toBe(200);
		expect(res.body).not.toContain('NaN');
		expect(res.body).toContain('unknown');
		expect(res.body).not.toContain('0.001000');
		expect(res.body).toContain('Solana');
	});
});

describe('GET /api/x402-pay/og: unresolved paths', () => {
	it('serves the generic card with a long cache when no tx is asked for', async () => {
		const res = await call('/api/x402-pay/og');
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('pay-per-call (x402)');
		expect(redisGet).not.toHaveBeenCalled();
		expect(res.headers['cache-control']).toContain('max-age=3600');
	});

	it('does not query Redis for a tx that is not a Solana signature', async () => {
		const res = await call('/api/x402-pay/og?tx=notavalidsignature');
		expect(res.statusCode).toBe(200);
		expect(redisGet).not.toHaveBeenCalled();
		expect(res.body).toContain('pay-per-call (x402)');
	});

	it('short-caches a well-formed tx it could not resolve, so a blip self-heals', async () => {
		const res = await call(`/api/x402-pay/og?tx=${TX}`);
		expect(res.statusCode).toBe(200);
		expect(res.headers['cache-control']).toBe('public, max-age=60, s-maxage=60');
	});

	it('falls back to the generic card when Redis is unavailable', async () => {
		redisAvailable = false;
		const res = await call(`/api/x402-pay/og?tx=${TX}`);
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('pay-per-call (x402)');
		expect(res.headers['cache-control']).toBe('public, max-age=60, s-maxage=60');
	});

	it('falls back to the generic card when a Redis read throws', async () => {
		redisGet.mockRejectedValue(new Error('upstream timeout'));
		const res = await call(`/api/x402-pay/og?tx=${TX}`);
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('pay-per-call (x402)');
	});

	it('rejects a stored row that parses to a scalar rather than a record', async () => {
		redisGet.mockResolvedValue('"corrupted"');
		const res = await call(`/api/x402-pay/og?tx=${TX}`);
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('pay-per-call (x402)');
	});

	it('falls back when the stored row is not valid JSON', async () => {
		redisGet.mockResolvedValue('{not json');
		const res = await call(`/api/x402-pay/og?tx=${TX}`);
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('pay-per-call (x402)');
	});
});

describe('/api/x402-pay/og: methods and CORS', () => {
	it('answers a HEAD probe with the card headers and no body', async () => {
		redisGet.mockResolvedValue(JSON.stringify(record()));
		const res = await call(`/api/x402-pay/og?tx=${TX}`, { method: 'HEAD' });
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toBe('image/svg+xml; charset=utf-8');
		expect(Number(res.headers['content-length'])).toBeGreaterThan(0);
		expect(res.body).toBe('');
	});

	it('answers a preflight with 204 and an open origin', async () => {
		const res = await call('/api/x402-pay/og', { method: 'OPTIONS' });
		expect(res.statusCode).toBe(204);
		expect(res.headers['access-control-allow-origin']).toBe('*');
		expect(res.headers['access-control-allow-methods']).toBe('GET,HEAD,OPTIONS');
	});

	it('rejects a write method with a JSON 405 and an Allow header', async () => {
		const res = await call('/api/x402-pay/og', { method: 'POST' });
		expect(res.statusCode).toBe(405);
		expect(res.headers.allow).toBe('GET, HEAD, OPTIONS');
		expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
		expect(JSON.parse(res.body).error).toBe('method_not_allowed');
	});

	it('sets an open CORS origin on the card itself', async () => {
		const res = await call('/api/x402-pay/og');
		expect(res.headers['access-control-allow-origin']).toBe('*');
	});
});
