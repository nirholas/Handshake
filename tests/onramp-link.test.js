// GET /api/onramp/link: the fiat onramp checkout link handed to the "Add funds"
// overlay (src/shared/add-funds.js), plus the CDP session-token module behind it.
//
// The two behaviours worth pinning are the contract with Coinbase (a hosted
// checkout URL is only valid when it carries a freshly minted sessionToken) and
// the promise that funding never hard-fails: if Coinbase is down or the CDP key
// is rotated, the caller still gets a usable buy page instead of a 5xx.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let rlOk = true;
let callerIp = '203.0.113.7';
vi.mock('../api/_lib/rate-limit.js', () => ({
	clientIp: () => callerIp,
	limits: {
		onrampLinkIp: vi.fn(async () => ({
			success: rlOk,
			limit: 20,
			remaining: rlOk ? 19 : 0,
			reset: Date.now() + 300_000,
		})),
	},
}));

const generateJwtMock = vi.fn(async () => 'signed.jwt.value');
vi.mock('@coinbase/cdp-sdk/auth', () => ({ generateJwt: (...a) => generateJwtMock(...a) }));

const createTokenMock = vi.fn();
vi.mock('../api/_lib/coinbase-onramp.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, createOnrampSessionToken: (...a) => createTokenMock(...a) };
});

const { default: handler } = await import('../api/onramp/link.js');
const { isPublicIp, onrampClientIp, onrampConfigured, CoinbaseOnrampError } = await import(
	'../api/_lib/coinbase-onramp.js'
);
const { createOnrampSessionToken } = await vi.importActual('../api/_lib/coinbase-onramp.js');

const ADDRESS = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

function mkReq({ method = 'GET', query = '', headers = {} } = {}) {
	return {
		method,
		url: `/api/onramp/link${query}`,
		headers: { host: 'three.ws', ...headers },
		socket: { remoteAddress: '203.0.113.7' },
	};
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(b) { this.body = b; this.writableEnded = true; },
	};
}

const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

beforeEach(() => {
	rlOk = true;
	callerIp = '203.0.113.7';
	createTokenMock.mockReset();
	generateJwtMock.mockClear();
	vi.stubEnv('CDP_API_KEY_ID', '');
	vi.stubEnv('CDP_API_KEY_SECRET', '');
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe('GET /api/onramp/link', () => {
	it('mints a session token and returns a hosted Coinbase checkout when CDP is configured', async () => {
		vi.stubEnv('CDP_API_KEY_ID', 'key-id');
		vi.stubEnv('CDP_API_KEY_SECRET', 'key-secret');
		createTokenMock.mockResolvedValue('session-token-abc');

		const res = mkRes();
		await handler(mkReq({ query: `?address=${ADDRESS}&amount=50&asset=USDC` }), res);

		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(body.mode).toBe('coinbase-onramp');
		expect(body.address).toBe(ADDRESS);
		expect(body.amount).toBe(50);

		const url = new URL(body.url);
		expect(url.origin + url.pathname).toBe('https://pay.coinbase.com/buy/select-asset');
		expect(url.searchParams.get('sessionToken')).toBe('session-token-abc');
		expect(url.searchParams.get('defaultNetwork')).toBe('solana');
		expect(url.searchParams.get('defaultAsset')).toBe('USDC');
		expect(url.searchParams.get('presetFiatAmount')).toBe('50');
		expect(url.searchParams.get('fiatCurrency')).toBe('USD');
		// The deprecated pre-session-token parameters must never come back: Coinbase
		// stopped honouring them, so a URL carrying them lands the buyer on an error.
		expect(url.searchParams.get('appId')).toBeNull();
		expect(url.searchParams.get('destinationWallets')).toBeNull();

		// The destination wallet reaches Coinbase through the token call, not the URL.
		expect(createTokenMock).toHaveBeenCalledWith({
			address: ADDRESS,
			blockchains: ['solana'],
			assets: ['USDC'],
			clientIp: '203.0.113.7',
		});
	});

	it('binds the token to the SOL ticker when SOL is requested', async () => {
		vi.stubEnv('CDP_API_KEY_ID', 'key-id');
		vi.stubEnv('CDP_API_KEY_SECRET', 'key-secret');
		createTokenMock.mockResolvedValue('session-token-sol');

		const res = mkRes();
		await handler(mkReq({ query: `?address=${ADDRESS}&asset=sol` }), res);

		const body = parse(res);
		expect(body.asset).toBe('SOL');
		expect(createTokenMock.mock.calls[0][0].assets).toEqual(['SOL']);
		expect(new URL(body.url).searchParams.get('defaultAsset')).toBe('SOL');
	});

	it('falls back to the Coinbase buy page (still 200) when the token call fails', async () => {
		vi.stubEnv('CDP_API_KEY_ID', 'key-id');
		vi.stubEnv('CDP_API_KEY_SECRET', 'key-secret');
		createTokenMock.mockRejectedValue(
			new CoinbaseOnrampError('onramp_rejected', 'CDP session token request returned 401'),
		);

		const res = mkRes();
		await handler(mkReq({ query: `?address=${ADDRESS}` }), res);

		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(body.mode).toBe('coinbase-fallback');
		expect(body.url).toBe('https://www.coinbase.com/price/usd-coin');
	});

	it('uses the fallback without calling CDP when no credentials are configured', async () => {
		const res = mkRes();
		await handler(mkReq({ query: `?address=${ADDRESS}&asset=SOL` }), res);

		expect(parse(res)).toMatchObject({
			mode: 'coinbase-fallback',
			url: 'https://www.coinbase.com/price/solana',
			asset: 'SOL',
		});
		expect(createTokenMock).not.toHaveBeenCalled();
	});

	it('clamps the preset amount and defaults an unparseable one', async () => {
		const res = mkRes();
		await handler(mkReq({ query: `?address=${ADDRESS}&amount=99999` }), res);
		expect(parse(res).amount).toBe(500);

		const res2 = mkRes();
		await handler(mkReq({ query: `?address=${ADDRESS}&amount=abc` }), res2);
		expect(parse(res2).amount).toBe(25);

		const res3 = mkRes();
		await handler(mkReq({ query: `?address=${ADDRESS}&amount=1` }), res3);
		expect(parse(res3).amount).toBe(10);
	});

	it('rejects anything that is not a Solana public key', async () => {
		for (const q of ['', `?address=`, '?address=nope', '?address=0x1234567890123456789012345678901234567890']) {
			const res = mkRes();
			await handler(mkReq({ query: q }), res);
			expect(res.statusCode).toBe(400);
			expect(parse(res).error).toBe('invalid_address');
		}
	});

	it('answers 405 to a non-GET method', async () => {
		const res = mkRes();
		await handler(mkReq({ method: 'POST', query: `?address=${ADDRESS}` }), res);
		expect(res.statusCode).toBe(405);
		expect(parse(res).error).toBe('method_not_allowed');
	});

	it('rate limits before it ever reaches Coinbase', async () => {
		vi.stubEnv('CDP_API_KEY_ID', 'key-id');
		vi.stubEnv('CDP_API_KEY_SECRET', 'key-secret');
		rlOk = false;

		const res = mkRes();
		await handler(mkReq({ query: `?address=${ADDRESS}` }), res);

		expect(res.statusCode).toBe(429);
		expect(createTokenMock).not.toHaveBeenCalled();
	});
});

describe('createOnrampSessionToken', () => {
	beforeEach(() => {
		vi.stubEnv('CDP_API_KEY_ID', 'key-id');
		vi.stubEnv('CDP_API_KEY_SECRET', 'key-secret');
	});

	it('posts the destination wallet to the CDP token API and returns the token', async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ token: 'tok_live', channel_id: '' }),
		}));
		vi.stubGlobal('fetch', fetchMock);

		const token = await createOnrampSessionToken({
			address: ADDRESS,
			blockchains: ['solana'],
			assets: ['USDC'],
			clientIp: '203.0.113.7',
		});

		expect(token).toBe('tok_live');
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://api.developer.coinbase.com/onramp/v1/token');
		expect(init.method).toBe('POST');
		expect(init.headers.authorization).toBe('Bearer signed.jwt.value');
		expect(JSON.parse(init.body)).toEqual({
			addresses: [{ address: ADDRESS, blockchains: ['solana'] }],
			assets: ['USDC'],
			clientIp: '203.0.113.7',
		});
		// The JWT must be scoped to the exact method + host + path CDP verifies.
		expect(generateJwtMock.mock.calls[0][0]).toMatchObject({
			requestMethod: 'POST',
			requestHost: 'api.developer.coinbase.com',
			requestPath: '/onramp/v1/token',
		});
	});

	it('throws a typed error when CDP rejects the request', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => ({
			ok: false,
			status: 401,
			text: async () => 'Unauthorized',
		})));

		await expect(
			createOnrampSessionToken({
				address: ADDRESS,
				blockchains: ['solana'],
				clientIp: '203.0.113.7',
			}),
		).rejects.toMatchObject({ code: 'onramp_rejected' });
	});

	it('refuses to call CDP at all when credentials are missing', async () => {
		vi.stubEnv('CDP_API_KEY_ID', '');
		vi.stubEnv('CDP_API_KEY_SECRET', '');
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			createOnrampSessionToken({ address: ADDRESS, blockchains: ['solana'], clientIp: '203.0.113.7' }),
		).rejects.toMatchObject({ code: 'onramp_not_configured' });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('client IP handling', () => {
	it('classifies routable and unroutable addresses', () => {
		for (const ip of ['203.0.113.7', '8.8.8.8', '::ffff:8.8.8.8', '2606:4700::1111']) {
			expect(isPublicIp(ip), ip).toBe(true);
		}
		for (const ip of ['10.1.2.3', '127.0.0.1', '192.168.1.9', '172.20.0.4', '169.254.1.1', '::1', 'fd00::1', '', 'not-an-ip']) {
			expect(isPublicIp(ip), ip).toBe(false);
		}
	});

	it('substitutes the documentation address when the caller IP is unroutable', () => {
		callerIp = '127.0.0.1';
		expect(onrampClientIp({ headers: {} })).toBe('192.0.2.1');
		callerIp = '203.0.113.7';
		expect(onrampClientIp({ headers: {} })).toBe('203.0.113.7');
	});

	it('reports configuration state from the CDP env pair', () => {
		vi.stubEnv('CDP_API_KEY_ID', '');
		vi.stubEnv('CDP_API_KEY_SECRET', '');
		expect(onrampConfigured()).toBe(false);
		vi.stubEnv('CDP_API_KEY_ID', 'key-id');
		expect(onrampConfigured()).toBe(false);
		vi.stubEnv('CDP_API_KEY_SECRET', 'key-secret');
		expect(onrampConfigured()).toBe(true);
	});
});
