// USE-21: tests for the auth-hints extension declarator + request
// authenticator. Uses real jose + real ed25519 verification — only mocks the
// db and rate-limit modules to keep the tests offline.

import { describe, it, expect, vi, beforeAll } from 'vitest';

process.env.PUBLIC_APP_ORIGIN ||= 'https://app.test';
process.env.JWT_SECRET ||= 'test-auth-hints-secret-at-least-32-chars-long';
process.env.VERCEL_ENV ||= 'production';
// Allow the in-process memory store for the idempotency cache so tests run
// without Upstash credentials even when VERCEL_ENV=production is set.
process.env.X402_ALLOW_MEMORY_FALLBACK ||= '1';

// Sql stub — auth.js touches it for API-key lookups but JWT verification
// hits jwtVerify directly (no DB).
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async () => []),
}));

// SIWX storage stub — record nonces in memory so duplicate-nonce checks work.
const siwxNonceState = new Set();
vi.mock('../../api/_lib/siwx-storage.js', () => ({
	siwxStorage: {
		hasUsedNonce: vi.fn(async (n) => siwxNonceState.has(n)),
		recordNonce: vi.fn(async (n) => {
			siwxNonceState.add(n);
		}),
		hasPaid: vi.fn(async () => false),
		recordPayment: vi.fn(async () => {}),
	},
	normalizeAddress: (chain, address) => {
		if (typeof chain === 'string' && chain.startsWith('eip155'))
			return String(address).toLowerCase();
		return String(address);
	},
}));

const { declareAuthHintsExtension, freeEvmAcceptForAuth, authenticateAuthHintsRequest } =
	await import('../../api/_lib/x402/auth-hints.js');
const { mintAccessToken } = await import('../../api/_lib/auth.js');
const { env } = await import('../../api/_lib/env.js');

// ── declareAuthHintsExtension ─────────────────────────────────────────────────

describe('declareAuthHintsExtension', () => {
	it('emits an `auth-hints` extension entry with the spec schema', () => {
		const ext = declareAuthHintsExtension({
			oauth2: { acceptIndexes: [3], requiredScope: 'read:agent-reputation' },
			siwx: { acceptIndexes: [4] },
		});
		expect(ext['auth-hints']).toBeDefined();
		expect(ext['auth-hints'].info.authRequirements).toHaveLength(2);
		expect(ext['auth-hints'].schema.required).toContain('authRequirements');
	});

	it('expands the oauth2 shorthand into a full method entry', () => {
		const ext = declareAuthHintsExtension({
			oauth2: { acceptIndexes: [0], tokenType: 'Bearer' },
		});
		const [requirement] = ext['auth-hints'].info.authRequirements;
		expect(requirement.acceptIndexes).toEqual([0]);
		const [method] = requirement.methods;
		expect(method.type).toBe('oauth2');
		expect(method.tokenType).toBe('Bearer');
		expect(method.tokenEndpoint).toMatch(/\/api\/oauth\/token$/);
		expect(method.authorizationServer).toBe(env.APP_ORIGIN);
	});

	it('expands the siwx shorthand into a sign-in-with-x method entry', () => {
		const ext = declareAuthHintsExtension({ siwx: { acceptIndexes: [1] } });
		const [requirement] = ext['auth-hints'].info.authRequirements;
		expect(requirement.acceptIndexes).toEqual([1]);
		expect(requirement.methods[0].type).toBe('sign-in-with-x');
	});

	it('accepts a verbatim authRequirements array', () => {
		const ext = declareAuthHintsExtension({
			authRequirements: [
				{
					acceptIndexes: [2],
					methods: [
						{
							type: 'oauth2',
							tokenType: 'DPoP',
							authorizationServer: 'https://as.example.com',
							tokenEndpoint: 'https://as.example.com/token',
						},
					],
				},
			],
		});
		expect(ext['auth-hints'].info.authRequirements[0].methods[0].tokenType).toBe('DPoP');
	});

	it('rejects empty authRequirements', () => {
		expect(() => declareAuthHintsExtension({})).toThrow(/non-empty/);
		expect(() => declareAuthHintsExtension({ authRequirements: [] })).toThrow(/non-empty/);
	});

	it('rejects acceptIndexes that are not non-negative integers', () => {
		expect(() => declareAuthHintsExtension({ oauth2: { acceptIndexes: [-1] } })).toThrow();
		expect(() => declareAuthHintsExtension({ oauth2: { acceptIndexes: ['x'] } })).toThrow();
	});
});

// ── freeEvmAcceptForAuth ──────────────────────────────────────────────────────

describe('freeEvmAcceptForAuth', () => {
	it('emits a zero-amount EIP-3009 accept marked with the auth type', () => {
		const accept = freeEvmAcceptForAuth({
			network: 'eip155:8453',
			asset: '0xUSDC',
			payTo: '0xWallet',
			authType: 'oauth2',
		});
		expect(accept.amount).toBe('0');
		expect(accept.scheme).toBe('exact');
		expect(accept.network).toBe('eip155:8453');
		expect(accept.extra.authRequired).toBe('oauth2');
		expect(accept.extra.name).toBe('USD Coin');
	});
});

// ── authenticateAuthHintsRequest: OAuth Bearer ────────────────────────────────

describe('authenticateAuthHintsRequest — OAuth Bearer', () => {
	let goodToken;
	let scopedToken;
	beforeAll(async () => {
		goodToken = await mintAccessToken({
			userId: 'user-42',
			clientId: 'mcp_test',
			scope: 'profile',
		});
		scopedToken = await mintAccessToken({
			userId: 'user-99',
			clientId: 'mcp_test',
			scope: 'read:agent-reputation profile',
		});
	});

	it('returns ok with an OAuth2 principal when the Bearer is valid', async () => {
		const req = { headers: { authorization: `Bearer ${goodToken}` } };
		const out = await authenticateAuthHintsRequest(req, {});
		expect(out).not.toBeNull();
		expect(out.ok).toBe(true);
		expect(out.principal.method).toBe('oauth2');
		expect(out.principal.userId).toBe('user-42');
	});

	it('rejects when the requiredScope is missing from the token scope', async () => {
		const req = { headers: { authorization: `Bearer ${goodToken}` } };
		const out = await authenticateAuthHintsRequest(req, {
			requiredScope: 'read:agent-reputation',
		});
		expect(out).toEqual(expect.objectContaining({ ok: false, reason: 'insufficient_scope' }));
	});

	it('accepts when the token scope satisfies requiredScope', async () => {
		const req = { headers: { authorization: `Bearer ${scopedToken}` } };
		const out = await authenticateAuthHintsRequest(req, {
			requiredScope: 'read:agent-reputation',
		});
		expect(out.ok).toBe(true);
		expect(out.principal.scope).toContain('read:agent-reputation');
	});

	it('rejects an unparseable Bearer with reason=invalid_token', async () => {
		const req = { headers: { authorization: 'Bearer not.a.valid.jwt' } };
		const out = await authenticateAuthHintsRequest(req, {});
		expect(out).toEqual(expect.objectContaining({ ok: false, reason: 'invalid_token' }));
	});

	it('returns null when no Authorization header is present', async () => {
		const req = { headers: {} };
		const out = await authenticateAuthHintsRequest(req, {});
		expect(out).toBeNull();
	});
});

// ── authenticateAuthHintsRequest: SIWX (EVM) ──────────────────────────────────
//
// The @x402/extensions sign-in-with-x parser expects a base64-encoded JSON
// envelope built by encodeSIWxHeader. We construct a real EVM signature via
// ethers' Wallet so the verifier (which delegates to viem.verifyMessage in
// the smart-wallet path, or recoverAddress for EOAs) accepts it.

describe('authenticateAuthHintsRequest — SIWX (EOA)', () => {
	let header;
	let walletAddress;
	beforeAll(async () => {
		const { createSIWxPayload, encodeSIWxHeader } = await import(
			'@x402/extensions/sign-in-with-x'
		);
		const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts');
		const account = privateKeyToAccount(generatePrivateKey());
		walletAddress = account.address;
		// @x402/extensions signEVMMessage calls signer.signMessage({ message }).
		// Wrap the viem account so the call shape matches.
		const signer = {
			address: account.address,
			signMessage: ({ message }) => account.signMessage({ message }),
		};
		const serverExtension = {
			type: 'eip191',
			version: '1',
			signatureScheme: 'eip191',
			domain: 'app.test',
			uri: 'https://app.test/api/x402/agent-reputation',
			chainId: 'eip155:8453',
			statement: 'auth-hints test',
			nonce: 'authHintsTestNonce1234567890ab',
			issuedAt: new Date().toISOString(),
			expirationTime: new Date(Date.now() + 5 * 60_000).toISOString(),
		};
		const payload = await createSIWxPayload(serverExtension, signer);
		header = encodeSIWxHeader(payload);
	});

	it('authenticates a valid SIGN-IN-WITH-X header as a SIWX principal', async () => {
		const req = { headers: { 'sign-in-with-x': header } };
		const out = await authenticateAuthHintsRequest(req, {
			resourceUrl: 'https://app.test/api/x402/agent-reputation',
		});
		expect(out).not.toBeNull();
		expect(out.ok).toBe(true);
		expect(out.principal.method).toBe('sign-in-with-x');
		expect(out.principal.address).toBe(walletAddress.toLowerCase());
		expect(out.principal.network).toBe('eip155:8453');
	});

	it('returns null when no SIWX header and no Bearer is present', async () => {
		const req = { headers: {} };
		const out = await authenticateAuthHintsRequest(req, {
			resourceUrl: 'https://app.test/api/x402/agent-reputation',
		});
		expect(out).toBeNull();
	});

	it('rejects a malformed SIGN-IN-WITH-X header', async () => {
		const req = { headers: { 'sign-in-with-x': 'not-base64!@#' } };
		const out = await authenticateAuthHintsRequest(req, {
			resourceUrl: 'https://app.test/api/x402/agent-reputation',
		});
		expect(out).toEqual(expect.objectContaining({ ok: false }));
	});
});

// ── paidEndpoint end-to-end ───────────────────────────────────────────────────
//
// Builds a paidEndpoint(spec) with authHints enabled, then drives it through
// fake req/res objects to confirm:
//   1) The 402 challenge carries the `auth-hints` extension AND zero-amount
//      free entries mapping to each declared method.
//   2) An OAuth Bearer with the required scope bypasses payment.
//   3) A request without auth + without payment header returns the 402 again.

describe('paidEndpoint authHints integration', () => {
	let paidEndpoint;
	let mintAccessTokenFn;
	beforeAll(async () => {
		process.env.X402_PAY_TO_BASE = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
		process.env.X402_ASSET_ADDRESS_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
		process.env.X402_MAX_AMOUNT_REQUIRED = '10000';
		({ paidEndpoint } = await import('../../api/_lib/x402-paid-endpoint.js'));
		({ mintAccessToken: mintAccessTokenFn } = await import('../../api/_lib/auth.js'));
	});

	function makeReqRes({ method = 'GET', headers = {}, url = '/api/x402/test' } = {}) {
		const res = {
			statusCode: 200,
			headers: {},
			body: undefined,
			writableEnded: false,
			setHeader(name, value) {
				this.headers[name.toLowerCase()] = value;
			},
			getHeader(name) {
				return this.headers[name.toLowerCase()];
			},
			end(body) {
				this.body = body;
				this.writableEnded = true;
			},
		};
		const req = { method, url, headers, query: {} };
		return { req, res };
	}

	const BAZAAR = {
		discoverable: true,
		info: {
			input: { type: 'http', method: 'GET', queryParams: {} },
			output: { type: 'json', example: { ok: true } },
		},
		schema: {
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			type: 'object',
			properties: {
				input: {
					type: 'object',
					properties: {
						type: { type: 'string', const: 'http' },
						method: { type: 'string', enum: ['GET', 'HEAD', 'DELETE'] },
					},
					required: ['type', 'method'],
					additionalProperties: false,
				},
			},
			required: ['input'],
		},
	};

	it('declares auth-hints + free entries in the 402 challenge', async () => {
		const handler = paidEndpoint({
			route: '/api/x402/test',
			method: 'GET',
			priceAtomics: '10000',
			networks: ['base'],
			description: 'test endpoint',
			bazaar: BAZAAR,
			offerReceipt: false,
			authHints: {
				oauth2: { requiredScope: 'read:agent-reputation' },
				siwx: true,
			},
			async handler() {
				return { ok: true };
			},
		});

		const { req, res } = makeReqRes();
		await handler(req, res);

		expect(res.statusCode).toBe(402);
		const body = JSON.parse(
			Buffer.from(String(res.headers['payment-required']), 'base64').toString('utf8'),
		);
		const hints = body.extensions['auth-hints'];
		expect(hints).toBeDefined();
		expect(hints.info.authRequirements).toHaveLength(2);
		const [oauthReq, siwxReq] = hints.info.authRequirements;
		expect(oauthReq.methods[0].type).toBe('oauth2');
		expect(siwxReq.methods[0].type).toBe('sign-in-with-x');
		const oauthIdx = oauthReq.acceptIndexes[0];
		const siwxIdx = siwxReq.acceptIndexes[0];
		expect(body.accepts[oauthIdx].amount).toBe('0');
		expect(body.accepts[siwxIdx].amount).toBe('0');
		expect(body.accepts[oauthIdx].extra.authRequired).toBe('oauth2');
		expect(body.accepts[siwxIdx].extra.authRequired).toBe('sign-in-with-x');
	});

	it('bypasses payment when a valid OAuth Bearer is presented', async () => {
		const handler = paidEndpoint({
			route: '/api/x402/test',
			method: 'GET',
			priceAtomics: '10000',
			networks: ['base'],
			description: 'test endpoint',
			bazaar: BAZAAR,
			offerReceipt: false,
			authHints: { oauth2: { requiredScope: 'read:agent-reputation' } },
			async handler({ auth, bypass }) {
				return { ok: true, method: auth?.method, bypass: bypass?.reason };
			},
		});

		const token = await mintAccessTokenFn({
			userId: 'user-99',
			clientId: 'mcp_test',
			scope: 'read:agent-reputation profile',
		});
		const { req, res } = makeReqRes({
			headers: { authorization: `Bearer ${token}` },
		});
		await handler(req, res);

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.ok).toBe(true);
		expect(body.method).toBe('oauth2');
		expect(res.headers['x-payment-bypass']).toBe('auth-hints:oauth2');
	});

	it('still emits 402 when no auth and no payment are sent', async () => {
		const handler = paidEndpoint({
			route: '/api/x402/test',
			method: 'GET',
			priceAtomics: '10000',
			networks: ['base'],
			description: 'test endpoint',
			bazaar: BAZAAR,
			offerReceipt: false,
			authHints: { oauth2: { requiredScope: 'read:agent-reputation' } },
			async handler() {
				return { ok: true };
			},
		});

		const { req, res } = makeReqRes();
		await handler(req, res);
		expect(res.statusCode).toBe(402);
	});

	it('rejects an invalid Bearer instead of falling through to 402', async () => {
		const handler = paidEndpoint({
			route: '/api/x402/test',
			method: 'GET',
			priceAtomics: '10000',
			networks: ['base'],
			description: 'test endpoint',
			bazaar: BAZAAR,
			offerReceipt: false,
			authHints: { oauth2: { requiredScope: 'read:agent-reputation' } },
			async handler() {
				return { ok: true };
			},
		});

		const { req, res } = makeReqRes({
			headers: { authorization: 'Bearer not-a-jwt' },
		});
		await handler(req, res);
		expect(res.statusCode).toBe(401);
	});
});
