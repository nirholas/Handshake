// Unit tests for the v2 x402 wire helpers in api/_lib/x402-spec.js. Covers:
//
//   - permit2VariantOf: emits a Permit2 sibling for EVM `exact` accepts only,
//     gated on CDP credentials; returns null for Solana SPL / BSC direct /
//     non-`exact` / non-EVM entries.
//   - paymentRequirements: orders EIP-3009 first, Permit2 sibling second per
//     EVM network; CDP-credentialed vs not.
//   - build402Body: auto-declares eip2612GasSponsoring + erc20ApprovalGasSponsoring
//     in `extensions` whenever any accept opts into Permit2; passes them through
//     untouched otherwise.
//   - send402: writes a base64 PAYMENT-REQUIRED header that round-trips through
//     JSON.parse with the same extensions set.

import { afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';

// env.js exposes process.env via getters, so each test's env mutations are
// picked up immediately by api/_lib/x402-spec.js without needing a module
// reset.
//
// Cold-loading the real x402-spec module transitively pulls @coinbase/x402,
// @x402/extensions, and x402-bsc-direct (which loads the full ethers core).
// On a fresh Codespace that chain alone can exceed 2 minutes, which is well
// past any reasonable test timeout. None of the tests in this file actually
// invoke those upstream deps — they exercise pure wire-format helpers
// (permit2VariantOf, paymentRequirements, build402Body, send402). So we mock
// the heavy upstream modules with the minimum shape the spec module needs at
// *import time*, then run the real spec logic against it.
vi.mock('@coinbase/x402', () => ({
	createCdpAuthHeaders: vi.fn(async () => ({})),
}));
vi.mock('@x402/extensions', () => ({
	EIP2612_GAS_SPONSORING: { key: 'eip2612GasSponsoring' },
	ERC20_APPROVAL_GAS_SPONSORING: { key: 'erc20ApprovalGasSponsoring' },
	OFFER_RECEIPT: 'offer-receipt',
	declareEip2612GasSponsoringExtension: () => ({
		eip2612GasSponsoring: {
			info: { description: 'EIP-2612 gas sponsoring', version: '1' },
			schema: {},
		},
	}),
	declareErc20ApprovalGasSponsoringExtension: () => ({
		erc20ApprovalGasSponsoring: {
			info: { description: 'ERC-20 approval gas sponsoring', version: '1' },
			schema: {},
		},
	}),
}));
vi.mock('../../api/_lib/x402-bsc-direct.js', () => ({
	PAYMENT_EVENT_TOPIC: '0x' + 'a'.repeat(64),
	settleDirectPayment: vi.fn(async () => ({ success: true })),
	verifyDirectPayment: vi.fn(async () => ({ isValid: true })),
}));
vi.mock('../../api/_lib/x402-builder-code.js', () => ({
	BUILDER_CODE: 'three.ws',
	declareBuilderCodeExtension: () => ({ builderCode: { code: 'three.ws' } }),
	verifyClientEcho: vi.fn(() => true),
}));
vi.mock('../../api/_lib/x402/offer-receipt-server.js', () => ({
	buildOffersExtension: vi.fn(async () => null),
}));
vi.mock('../../api/_lib/x402-offer-receipt.js', () => ({
	offerReceiptDeclaration: vi.fn(() => null),
}));

vi.setConfig({ testTimeout: 10_000, hookTimeout: 60_000 });

const specPromise = import('../../api/_lib/x402-spec.js');
let spec;
// Explicit per-hook timeout — vi.setConfig is honored, but spelling it out
// at the call-site survives any future hoisting/ordering surprises.
beforeAll(async () => {
	spec = await specPromise;
}, 60_000);

const ORIG_ENV = { ...process.env };

beforeEach(() => {
	// Baseline env every test sees; individual tests may toggle CDP credentials.
	process.env.X402_PAY_TO_SOLANA = 'THREEsynthetic1111111111111111111111111PayTo';
	process.env.X402_PAY_TO_BASE = '0x4022de2d36c334e73c7a108805cea11c0564f402';
	process.env.X402_ASSET_MINT_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
	process.env.X402_ASSET_ADDRESS_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
	process.env.X402_MAX_AMOUNT_REQUIRED = '1000';
	process.env.X402_FEE_PAYER_SOLANA = 'PayeRNCipcerPHCsYMTrX9pAYDm1LnPGzgb66NUDG5a';
	delete process.env.X402_PAY_TO_BSC;
	delete process.env.CDP_API_KEY_ID;
	delete process.env.CDP_API_KEY_SECRET;
});

afterEach(() => {
	for (const k of Object.keys(process.env)) {
		if (!(k in ORIG_ENV)) delete process.env[k];
	}
	Object.assign(process.env, ORIG_ENV);
});

async function loadSpec() {
	// `spec` is populated in beforeAll, so this returns synchronously after
	// the module's been warmed up. The await is kept so any straggling
	// edge-case where a test runs before beforeAll completes still works.
	return spec ?? (await specPromise);
}

describe('permit2VariantOf', () => {
	it('returns null when CDP credentials are absent', async () => {
		const { permit2VariantOf } = await loadSpec();
		const accept = {
			scheme: 'exact',
			network: 'eip155:8453',
			amount: '1000',
			payTo: '0x4022de2d36c334e73c7a108805cea11c0564f402',
			asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
			extra: { name: 'USD Coin', version: '2', decimals: 6 },
		};
		expect(permit2VariantOf(accept)).toBeNull();
	});

	it('emits a sibling for EVM exact accepts when CDP creds are set', async () => {
		process.env.CDP_API_KEY_ID = 'x';
		process.env.CDP_API_KEY_SECRET = 'y';
		const { permit2VariantOf } = await loadSpec();
		const accept = {
			scheme: 'exact',
			network: 'eip155:8453',
			amount: '1000',
			payTo: '0x4022de2d36c334e73c7a108805cea11c0564f402',
			asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
			extra: { name: 'USD Coin', version: '2', decimals: 6 },
		};
		const sibling = permit2VariantOf(accept);
		expect(sibling).not.toBeNull();
		expect(sibling.scheme).toBe('exact');
		expect(sibling.network).toBe('eip155:8453');
		expect(sibling.amount).toBe('1000');
		expect(sibling.payTo).toBe(accept.payTo);
		expect(sibling.asset).toBe(accept.asset);
		expect(sibling.extra.assetTransferMethod).toBe('permit2');
		expect(sibling.extra.supportsEip2612).toBe(true);
		expect(sibling.extra.name).toBe('USD Coin');
	});

	it('does not mutate the source accept', async () => {
		process.env.CDP_API_KEY_ID = 'x';
		process.env.CDP_API_KEY_SECRET = 'y';
		const { permit2VariantOf } = await loadSpec();
		const accept = {
			scheme: 'exact',
			network: 'eip155:8453',
			amount: '1000',
			payTo: '0x4022de2d36c334e73c7a108805cea11c0564f402',
			asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
			extra: { name: 'USD Coin', version: '2', decimals: 6 },
		};
		permit2VariantOf(accept);
		expect(accept.extra.assetTransferMethod).toBeUndefined();
		expect(accept.extra.supportsEip2612).toBeUndefined();
	});

	it('returns null for non-EVM (Solana) accepts', async () => {
		process.env.CDP_API_KEY_ID = 'x';
		process.env.CDP_API_KEY_SECRET = 'y';
		const { permit2VariantOf } = await loadSpec();
		expect(
			permit2VariantOf({
				scheme: 'exact',
				network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
				amount: '1000',
				payTo: 'THREEsynthetic1111111111111111111111111PayTo',
				asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
				extra: { name: 'USDC', decimals: 6, feePayer: 'x' },
			}),
		).toBeNull();
	});

	it('returns null for non-exact (BSC direct) accepts', async () => {
		process.env.CDP_API_KEY_ID = 'x';
		process.env.CDP_API_KEY_SECRET = 'y';
		const { permit2VariantOf } = await loadSpec();
		expect(
			permit2VariantOf({
				scheme: 'direct',
				network: 'eip155:56',
				amount: '1000',
				payTo: '0x00000000381f09742a30a5a49975514AeC1B72Cc',
				asset: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
				extra: { name: 'Binance-Peg USD Coin', decimals: 6 },
			}),
		).toBeNull();
	});

	it('returns null for malformed / falsy input', async () => {
		process.env.CDP_API_KEY_ID = 'x';
		process.env.CDP_API_KEY_SECRET = 'y';
		const { permit2VariantOf } = await loadSpec();
		expect(permit2VariantOf(null)).toBeNull();
		expect(permit2VariantOf(undefined)).toBeNull();
		expect(permit2VariantOf({})).toBeNull();
		expect(permit2VariantOf({ scheme: 'exact', network: 'btc:1' })).toBeNull();
	});
});

describe('paymentRequirements', () => {
	it('emits EIP-3009 first then Permit2 sibling for Base when CDP is set', async () => {
		process.env.CDP_API_KEY_ID = 'x';
		process.env.CDP_API_KEY_SECRET = 'y';
		const { paymentRequirements } = await loadSpec();
		const reqs = paymentRequirements('https://three.ws/api/foo');
		const baseEntries = reqs.filter((r) => r.network === 'eip155:8453');
		expect(baseEntries.length).toBe(2);
		expect(baseEntries[0].extra.assetTransferMethod).toBeUndefined();
		expect(baseEntries[1].extra.assetTransferMethod).toBe('permit2');
	});

	it('omits the Permit2 sibling without CDP credentials', async () => {
		const { paymentRequirements } = await loadSpec();
		const reqs = paymentRequirements('https://three.ws/api/foo');
		const permit2Entry = reqs.find((r) => r.extra?.assetTransferMethod === 'permit2');
		expect(permit2Entry).toBeUndefined();
	});

	it('keeps Solana + BSC entries untouched regardless of CDP', async () => {
		process.env.CDP_API_KEY_ID = 'x';
		process.env.CDP_API_KEY_SECRET = 'y';
		process.env.X402_PAY_TO_BSC = '0x00000000381f09742a30a5a49975514AeC1B72Cc';
		process.env.X402_ASSET_ADDRESS_BSC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
		const { paymentRequirements } = await loadSpec();
		const reqs = paymentRequirements('https://three.ws/api/foo');
		const solana = reqs.find((r) => r.network.startsWith('solana:'));
		expect(solana).toBeDefined();
		expect(solana.extra.assetTransferMethod).toBeUndefined();
		const bsc = reqs.find((r) => r.network === 'eip155:56');
		expect(bsc).toBeDefined();
		expect(bsc.scheme).toBe('direct');
		expect(bsc.extra.assetTransferMethod).toBeUndefined();
	});

	it('embeds the resource URL on every entry when provided', async () => {
		const { paymentRequirements } = await loadSpec();
		const reqs = paymentRequirements('https://three.ws/api/x402/foo');
		for (const r of reqs) {
			expect(r.resource).toBe('https://three.ws/api/x402/foo');
		}
	});

	it('advertises USDC and THREE on Solana by default when fee payer is configured', async () => {
		// X402_ACCEPT_THREE_SOLANA defaults to true — $THREE is the platform token
		// and is always offered alongside USDC on the Solana rail.
		const { paymentRequirements } = await loadSpec();
		const solana = paymentRequirements('https://three.ws/api/foo').filter((r) =>
			r.network.startsWith('solana:'),
		);
		expect(solana.length).toBe(2);
		expect(solana[0].extra.name).toBe('USDC');
		expect(solana[1].extra.name).toBe('THREE');
	});

	it('adds a THREE Solana accept after USDC when X402_ACCEPT_THREE_SOLANA is on', async () => {
		process.env.X402_ACCEPT_THREE_SOLANA = 'true';
		const { paymentRequirements } = await loadSpec();
		const solana = paymentRequirements('https://three.ws/api/foo').filter((r) =>
			r.network.startsWith('solana:'),
		);
		expect(solana.length).toBe(2);
		// USDC stays first so first-accept clients keep settling USDC.
		expect(solana[0].extra.name).toBe('USDC');
		expect(solana[1].extra.name).toBe('THREE');
		expect(solana[1].asset).toBe('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump');
		expect(solana[1].payTo).toBe(solana[0].payTo);
		expect(solana[1].extra.feePayer).toBe(solana[0].extra.feePayer);
		// Default: X402_THREE_AMOUNT_SOLANA defaults to 10_000_000 (10 THREE).
		expect(solana[1].amount).toBe('10000000');
	});

	it('lets X402_THREE_AMOUNT_SOLANA price the THREE accept independently', async () => {
		process.env.X402_ACCEPT_THREE_SOLANA = 'true';
		process.env.X402_THREE_AMOUNT_SOLANA = '5000000';
		const { paymentRequirements } = await loadSpec();
		const three = paymentRequirements('https://three.ws/api/foo').find(
			(r) => r.extra?.name === 'THREE',
		);
		expect(three.amount).toBe('5000000');
	});

	it('skips the THREE accept when no Solana fee payer is configured', async () => {
		process.env.X402_ACCEPT_THREE_SOLANA = 'true';
		delete process.env.X402_FEE_PAYER_SOLANA;
		const { paymentRequirements } = await loadSpec();
		const three = paymentRequirements('https://three.ws/api/foo').find(
			(r) => r.extra?.name === 'THREE',
		);
		expect(three).toBeUndefined();
	});
});

describe('build402Body extensions', () => {
	const baseAccept = {
		scheme: 'exact',
		network: 'eip155:8453',
		amount: '1000',
		payTo: '0x4022de2d36c334e73c7a108805cea11c0564f402',
		asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
		extra: { name: 'USD Coin', version: '2', decimals: 6 },
	};
	const permit2Accept = {
		...baseAccept,
		extra: { ...baseAccept.extra, assetTransferMethod: 'permit2', supportsEip2612: true },
	};

	it('emits only the bazaar extension when no accept opts into Permit2', async () => {
		const { build402Body } = await loadSpec();
		const body = await build402Body({
			resourceUrl: 'https://three.ws/api/x402/foo',
			accepts: [baseAccept],
		});
		expect(Object.keys(body.extensions)).toEqual(['bazaar']);
	});

	it('auto-declares eip2612GasSponsoring + erc20ApprovalGasSponsoring when a Permit2 accept is present', async () => {
		const { build402Body, EIP2612_EXTENSION_KEY, ERC20_APPROVAL_EXTENSION_KEY } =
			await loadSpec();
		const body = await build402Body({
			resourceUrl: 'https://three.ws/api/x402/foo',
			accepts: [baseAccept, permit2Accept],
		});
		expect(body.extensions[EIP2612_EXTENSION_KEY]).toBeDefined();
		expect(body.extensions[EIP2612_EXTENSION_KEY].info.version).toBe('1');
		expect(body.extensions[ERC20_APPROVAL_EXTENSION_KEY]).toBeDefined();
	});

	it('passes caller-supplied extensions through (last-write-wins)', async () => {
		const { build402Body } = await loadSpec();
		const body = await build402Body({
			resourceUrl: 'https://three.ws/api/x402/foo',
			accepts: [baseAccept],
			extensions: { customSentinel: { hello: 'world' } },
		});
		expect(body.extensions.customSentinel).toEqual({ hello: 'world' });
		expect(body.extensions.bazaar).toBeDefined();
	});

	it('emits the v2 envelope shape required by the spec', async () => {
		const { build402Body, X402_VERSION } = await loadSpec();
		const body = await build402Body({
			resourceUrl: 'https://three.ws/api/x402/foo',
			accepts: [baseAccept],
			description: 'demo',
			mimeType: 'application/json',
		});
		expect(body.x402Version).toBe(X402_VERSION);
		expect(body.error).toBe('X-PAYMENT header is required');
		expect(body.resource).toEqual({
			url: 'https://three.ws/api/x402/foo',
			description: 'demo',
			mimeType: 'application/json',
		});
		expect(Array.isArray(body.accepts)).toBe(true);
		expect(body.accepts.length).toBe(1);
	});
});

describe('callFacilitator transient retry (via verify/settle)', () => {
	const REAL_FETCH = global.fetch;

	function fetchResponse({ ok, status, body }) {
		return {
			ok,
			status,
			text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
		};
	}

	beforeEach(() => {
		process.env.X402_FACILITATOR_URL_SOLANA = 'https://facilitator.test';
		process.env.X402_FACILITATOR_TOKEN_SOLANA = 'tok';
		// Keep the inter-attempt backoff from slowing the suite — a 1ms timeout
		// still exercises the real retry loop without a half-second wait.
		process.env.X402_FACILITATOR_TIMEOUT_MS = '5000';
	});

	afterEach(() => {
		global.fetch = REAL_FETCH;
	});

	function solanaPaymentHeader() {
		const payload = {
			x402Version: 2,
			scheme: 'exact',
			network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
			payload: { transaction: 'AAAA' },
		};
		return Buffer.from(JSON.stringify(payload)).toString('base64');
	}

	it('retries /verify once on a transient 503 then succeeds', async () => {
		const { verifyPayment, paymentRequirements } = await loadSpec();
		const calls = [];
		global.fetch = vi.fn(async (url) => {
			calls.push(url);
			if (calls.length === 1) return fetchResponse({ ok: false, status: 503, body: { error: 'upstream down' } });
			return fetchResponse({ ok: true, status: 200, body: { isValid: true, payer: 'PAYER1' } });
		});
		const result = await verifyPayment({
			paymentHeader: solanaPaymentHeader(),
			requirements: paymentRequirements(),
			builderCode: null,
		});
		expect(result.payer).toBe('PAYER1');
		expect(global.fetch).toHaveBeenCalledTimes(2);
	});

	it('does NOT retry a 400 invalid-payment — passes the rejection through once', async () => {
		const { verifyPayment, paymentRequirements } = await loadSpec();
		global.fetch = vi.fn(async () =>
			fetchResponse({ ok: false, status: 400, body: { isValid: false, invalidReason: 'bad sig' } }),
		);
		await expect(
			verifyPayment({
				paymentHeader: solanaPaymentHeader(),
				requirements: paymentRequirements(),
				builderCode: null,
			}),
		).rejects.toMatchObject({ code: 'invalid_payment', status: 402 });
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});

	it('stops after a single retry when the 5xx persists', async () => {
		const { verifyPayment, paymentRequirements } = await loadSpec();
		global.fetch = vi.fn(async () => fetchResponse({ ok: false, status: 503, body: { error: 'still down' } }));
		await expect(
			verifyPayment({
				paymentHeader: solanaPaymentHeader(),
				requirements: paymentRequirements(),
				builderCode: null,
			}),
		).rejects.toMatchObject({ code: 'facilitator_error', status: 502 });
		expect(global.fetch).toHaveBeenCalledTimes(2);
	});

	it('retries /settle on a transient 504 with the SAME idempotency key', async () => {
		const { settlePayment } = await loadSpec();
		const requirement = {
			scheme: 'exact',
			network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
			payTo: 'THREEsynthetic1111111111111111111111111PayTo',
			asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
			amount: '1000',
		};
		const verified = {
			paymentPayload: { network: requirement.network, payload: { transaction: 'AAAA' } },
			requirement,
			payer: 'PAYER2',
		};
		const idemKeys = [];
		global.fetch = vi.fn(async (_url, opts) => {
			idemKeys.push(opts.headers['Idempotency-Key']);
			if (idemKeys.length === 1) return fetchResponse({ ok: false, status: 504, body: { error: 'timeout' } });
			return fetchResponse({
				ok: true,
				status: 200,
				body: { success: true, transaction: 'TX123', network: requirement.network, payer: 'PAYER2' },
			});
		});
		const result = await settlePayment({ verified });
		expect(result.transaction).toBe('TX123');
		expect(global.fetch).toHaveBeenCalledTimes(2);
		expect(idemKeys[0]).toBeTruthy();
		expect(idemKeys[0]).toBe(idemKeys[1]);
	});
});

describe('send402 PAYMENT-REQUIRED header', () => {
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

	it('base64-encodes the same body that ships in JSON, including Permit2 extensions', async () => {
		process.env.CDP_API_KEY_ID = 'x';
		process.env.CDP_API_KEY_SECRET = 'y';
		const { send402, paymentRequirements, EIP2612_EXTENSION_KEY } = await loadSpec();
		const res = makeRes();
		const accepts = paymentRequirements('https://three.ws/api/x402/foo');
		await send402(res, {
			resourceUrl: 'https://three.ws/api/x402/foo',
			accepts,
			description: 'demo',
		});
		expect(res.statusCode).toBe(402);
		const header = res.headers['payment-required'];
		expect(typeof header).toBe('string');
		const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
		expect(decoded.x402Version).toBe(2);
		expect(decoded.extensions[EIP2612_EXTENSION_KEY]).toBeDefined();
		// v2 spec: body carries the full envelope. The PAYMENT-REQUIRED header
		// is a base64 mirror so Bazaar crawlers can read it off the headers
		// alone, but the body is the canonical place SDK clients read.
		const body = JSON.parse(res.body);
		expect(body.x402Version).toBe(2);
		expect(body.error).toBe('X-PAYMENT header is required');
		expect(body.extensions[EIP2612_EXTENSION_KEY]).toBeDefined();
		expect(Array.isArray(body.accepts)).toBe(true);
		// Header and body must agree byte-for-byte to satisfy the validator.
		expect(JSON.stringify(decoded)).toBe(JSON.stringify(body));
	});

	// Endpoints with rich bazaar schemas + per-accept signed offers were
	// emitting 11–17 KB header mirrors; the production LB dropped them
	// outright and x402scan flagged HEADERS_OVERFLOW on registration. The
	// header is capped at 8 KB. Because agent-discovery crawlers (agentcash,
	// x402scan's Bazaar) read the challenge from THIS header — not the JSON
	// body — the overflow fallback KEEPS the `bazaar` discovery extension while
	// shedding the heavy payment-execution extensions, degrading it in tiers
	// (full bazaar → drop `info` examples → compact `{type:'object'}` field
	// schemas) so input/output schema presence survives even for big schemas.
	// Only when no bazaar tier fits do we fall to an extension-less slim mirror,
	// then to no header. The JSON body always carries the complete envelope.
	describe('paymentRequiredHeaderValue cap', () => {
		function envelopeWithExtensions(extBytes, acceptsCount = 1) {
			return {
				x402Version: 2,
				error: 'X-PAYMENT header is required',
				resource: { url: 'https://three.ws/api/x402/foo', description: 'demo', mimeType: 'application/json' },
				accepts: Array.from({ length: acceptsCount }, (_, i) => ({
					scheme: 'exact',
					network: 'eip155:8453',
					amount: '1000',
					payTo: `0x000000000000000000000000000000000000000${i}`,
					asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
				})),
				extensions: { bazaar: { blob: 'x'.repeat(extBytes) } },
			};
		}

		// A realistic schema-bearing bazaar. `infoBytes` pads the human-facing
		// `info` examples; `fieldBytes` pads the per-field JSON Schemas inside
		// `schema` — letting a test force each degradation tier deterministically.
		function envelopeWithBazaarSchema({ infoBytes = 0, fieldBytes = 0 } = {}) {
			const pad = (n) => (n > 0 ? { description: 'x'.repeat(n) } : {});
			const queryParams = {
				type: 'object',
				properties: { id: { type: 'string', ...pad(fieldBytes) } },
			};
			const example = {
				type: 'object',
				properties: { ok: { type: 'boolean', ...pad(fieldBytes) } },
			};
			return {
				x402Version: 2,
				error: 'X-PAYMENT header is required',
				resource: { url: 'https://three.ws/api/x402/foo', description: 'demo', mimeType: 'application/json' },
				accepts: [{
					scheme: 'exact',
					network: 'eip155:8453',
					amount: '1000',
					payTo: '0x0000000000000000000000000000000000000000',
					asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
				}],
				extensions: {
					bazaar: {
						discoverable: true,
						info: {
							input: { type: 'http', method: 'GET', ...pad(infoBytes) },
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
										method: { type: 'string' },
										queryParams,
									},
									required: ['type', 'method'],
									additionalProperties: false,
								},
								output: {
									type: 'object',
									properties: { type: { type: 'string' }, example },
									required: ['type'],
								},
							},
							required: ['input'],
						},
					},
					eip2612GasSponsoring: { info: { version: '1' } },
				},
			};
		}

		// Mirror of the agentcash validator's extractSchemas2: the discovery
		// crawler considers a challenge complete when it can read an input schema
		// (`schema.properties.input.properties.{body|queryParams}`) and an output
		// schema (`schema.properties.output.properties.example`).
		function discoverySchemasResolvable(decoded) {
			const schema = decoded?.extensions?.bazaar?.schema;
			const inProps = schema?.properties?.input?.properties;
			const input = inProps?.body ?? inProps?.queryParams;
			const output = schema?.properties?.output?.properties?.example;
			const isRec = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
			return isRec(input) && isRec(output);
		}

		it('mirrors the full envelope when it fits', async () => {
			const { paymentRequiredHeaderValue } = await loadSpec();
			const body = envelopeWithExtensions(100);
			const header = paymentRequiredHeaderValue(body);
			expect(JSON.parse(Buffer.from(header, 'base64').toString('utf8'))).toEqual(body);
		});

		it('keeps the full bazaar (info + schema) when a schema-bearing envelope fits', async () => {
			const { paymentRequiredHeaderValue } = await loadSpec();
			const body = envelopeWithBazaarSchema();
			const header = paymentRequiredHeaderValue(body);
			expect(header.length).toBeLessThanOrEqual(8 * 1024);
			const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
			// Full envelope fit — bazaar and its info both survive verbatim.
			expect(decoded.extensions.bazaar.info).toBeDefined();
			expect(decoded.extensions.eip2612GasSponsoring).toBeDefined();
			expect(discoverySchemasResolvable(decoded)).toBe(true);
		});

		it('drops the bazaar info examples (keeping the real schema) when the full mirror overflows', async () => {
			const { paymentRequiredHeaderValue } = await loadSpec();
			const body = envelopeWithBazaarSchema({ infoBytes: 20_000 });
			const header = paymentRequiredHeaderValue(body);
			expect(header.length).toBeLessThanOrEqual(8 * 1024);
			const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
			// Heavy payment extensions and the bloated info are gone; the machine
			// schema the discovery crawler needs stays, verbatim.
			expect(decoded.extensions.bazaar.info).toBeUndefined();
			expect(decoded.extensions.eip2612GasSponsoring).toBeUndefined();
			expect(decoded.extensions.bazaar.schema.properties.input.properties.queryParams.properties)
				.toBeDefined();
			expect(discoverySchemasResolvable(decoded)).toBe(true);
		});

		it('compacts the bazaar field schemas when even the schema alone overflows', async () => {
			const { paymentRequiredHeaderValue } = await loadSpec();
			const body = envelopeWithBazaarSchema({ fieldBytes: 20_000 });
			const header = paymentRequiredHeaderValue(body);
			expect(header.length).toBeLessThanOrEqual(8 * 1024);
			const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
			// Field schemas collapse to a compact `{type:'object'}` placeholder,
			// but input/output presence — all the crawler keys on — survives.
			expect(decoded.extensions.bazaar.schema.properties.input.properties.queryParams)
				.toEqual({ type: 'object' });
			expect(decoded.extensions.bazaar.schema.properties.output.properties.example)
				.toEqual({ type: 'object' });
			expect(discoverySchemasResolvable(decoded)).toBe(true);
		});

		it('falls to an extension-less slim mirror when no bazaar tier fits', async () => {
			const { paymentRequiredHeaderValue } = await loadSpec();
			// Schema-less bazaar that is itself far too big — no discovery tier
			// can shrink it, so only the payable slim envelope survives.
			const body = envelopeWithExtensions(20_000);
			const header = paymentRequiredHeaderValue(body);
			expect(header.length).toBeLessThanOrEqual(8 * 1024);
			const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
			expect(decoded.extensions).toBeUndefined();
			// Everything a header-only payer needs survives.
			expect(decoded.x402Version).toBe(2);
			expect(decoded.accepts).toEqual(body.accepts);
			expect(decoded.resource).toEqual(body.resource);
		});

		it('returns null when even the slim envelope overflows', async () => {
			const { paymentRequiredHeaderValue } = await loadSpec();
			const body = envelopeWithExtensions(100, 80); // ~80 accepts ≫ 8 KB alone
			expect(paymentRequiredHeaderValue(body)).toBeNull();
		});

		it('send402 omits the header instead of emitting an oversized one', async () => {
			const { send402 } = await loadSpec();
			const res = makeRes();
			await send402(res, {
				resourceUrl: 'https://three.ws/api/x402/foo',
				accepts: Array.from({ length: 80 }, (_, i) => ({
					scheme: 'exact',
					network: 'eip155:8453',
					amount: '1000',
					payTo: `0x000000000000000000000000000000000000000${i}`,
					asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
				})),
				description: 'demo',
			});
			expect(res.statusCode).toBe(402);
			expect(res.headers['payment-required']).toBeUndefined();
			// The body still ships the complete envelope.
			const body = JSON.parse(res.body);
			expect(body.accepts).toHaveLength(80);
		});
	});
});

describe('baseSettleable', () => {
	// Base is settleable ONLY via CDP or a deliberate operator opt-in. A bare
	// facilitator URL being set is NOT enough — prod pointed it at a facilitator host
	// that answers /verify with 404, so a URL string is no proof the endpoint works.
	// baseSettleable() is the gate that
	// keeps an unsettleable Base accept out of both the live 402 (buildRequirements)
	// and the discovery catalog (wk.js), so buyers never pick a Base rail that 502s.
	beforeEach(() => {
		delete process.env.CDP_API_KEY_ID;
		delete process.env.CDP_API_KEY_SECRET;
		delete process.env.X402_FACILITATOR_URL_BASE;
		delete process.env.X402_FACILITATOR_URL;
		delete process.env.X402_ADVERTISE_BASE;
	});

	it('is false with no CDP creds and no opt-in (default)', async () => {
		const { baseSettleable } = await loadSpec();
		expect(baseSettleable()).toBe(false);
	});

	it('is FALSE even when a facilitator URL is set but not opted in (the dead-host trap)', async () => {
		process.env.X402_FACILITATOR_URL_BASE = 'https://dead-facilitator.example.test';
		const { baseSettleable } = await loadSpec();
		expect(baseSettleable()).toBe(false);
	});

	it('is true when CDP credentials are configured (Base settles via CDP)', async () => {
		process.env.CDP_API_KEY_ID = 'x';
		process.env.CDP_API_KEY_SECRET = 'y';
		const { baseSettleable } = await loadSpec();
		expect(baseSettleable()).toBe(true);
	});

	it('is true when the operator explicitly opts in via X402_ADVERTISE_BASE=true', async () => {
		process.env.X402_ADVERTISE_BASE = 'true';
		const { baseSettleable } = await loadSpec();
		expect(baseSettleable()).toBe(true);
	});

	it('treats any non-"true" opt-in value as off', async () => {
		process.env.X402_ADVERTISE_BASE = '1';
		const { baseSettleable } = await loadSpec();
		expect(baseSettleable()).toBe(false);
	});

	it('requires BOTH CDP keys — one alone is not enough', async () => {
		process.env.CDP_API_KEY_ID = 'x';
		const { baseSettleable } = await loadSpec();
		expect(baseSettleable()).toBe(false);
	});
});

describe('solanaSettleable', () => {
	// The Solana mirror of baseSettleable(): never advertise a Solana accept the
	// facilitator will reject AFTER the buyer pays. When settlement routes to our
	// self-hosted facilitator, sponsor-mode settle co-signs with
	// X402_FEE_PAYER_SECRET_BASE58 — without it every settle throws
	// sponsor_key_unconfigured (the 80× prod 502 this gate closes). An external
	// facilitator co-signs with its own key, so the secret is irrelevant there.
	beforeEach(() => {
		delete process.env.X402_SELF_FACILITATOR_ENABLED;
		delete process.env.X402_FACILITATOR_URL_SOLANA;
		delete process.env.X402_FACILITATOR_URL;
		delete process.env.X402_FEE_PAYER_SECRET_BASE58;
		delete process.env.PUBLIC_APP_ORIGIN;
	});

	it('is true by default (external PayAI facilitator co-signs with its own key)', async () => {
		const { solanaSettleable } = await loadSpec();
		expect(solanaSettleable()).toBe(true);
	});

	it('is FALSE when self-routing without the co-signing secret (the 502 trap)', async () => {
		process.env.X402_SELF_FACILITATOR_ENABLED = 'true';
		const { solanaSettleable } = await loadSpec();
		expect(solanaSettleable()).toBe(false);
	});

	it('is true when self-routing WITH the co-signing secret present', async () => {
		process.env.X402_SELF_FACILITATOR_ENABLED = 'true';
		process.env.X402_FEE_PAYER_SECRET_BASE58 = 'z'.repeat(88);
		const { solanaSettleable } = await loadSpec();
		expect(solanaSettleable()).toBe(true);
	});

	it('is true when an explicit EXTERNAL URL wins even with the flag on and no secret', async () => {
		process.env.X402_SELF_FACILITATOR_ENABLED = 'true';
		process.env.X402_FACILITATOR_URL_SOLANA = 'https://ext.example.test';
		const { solanaSettleable } = await loadSpec();
		expect(solanaSettleable()).toBe(true);
	});

	it('withholds the Solana accept from paymentRequirements when self-routing without the secret', async () => {
		process.env.X402_SELF_FACILITATOR_ENABLED = 'true';
		const { paymentRequirements } = await loadSpec();
		const solana = paymentRequirements('https://three.ws/api/foo').filter((r) =>
			r.network.startsWith('solana:'),
		);
		expect(solana).toEqual([]);
	});

	it('advertises the Solana accept again once the secret is set (self-heals)', async () => {
		process.env.X402_SELF_FACILITATOR_ENABLED = 'true';
		process.env.X402_FEE_PAYER_SECRET_BASE58 = 'z'.repeat(88);
		const { paymentRequirements } = await loadSpec();
		const solana = paymentRequirements('https://three.ws/api/foo').filter((r) =>
			r.network.startsWith('solana:'),
		);
		expect(solana.length).toBeGreaterThanOrEqual(1);
		expect(solana[0].extra.name).toBe('USDC');
	});
});

describe('buildExactRequirements', () => {
	// Shared accept builder for the hand-rolled endpoints (model-check, mint-to-mesh,
	// vanity, vanity-verifiable, mint-to-mesh-batch). Solana always leads; Base only rides
	// along when settleable, so a dead Base facilitator is never advertised.
	const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
	const BASE = 'eip155:8453';

	beforeEach(() => {
		delete process.env.CDP_API_KEY_ID;
		delete process.env.CDP_API_KEY_SECRET;
		delete process.env.X402_ADVERTISE_BASE;
	});

	it('is Solana-only when Base is not settleable (default)', async () => {
		const { buildExactRequirements } = await loadSpec();
		const reqs = buildExactRequirements('https://three.ws/api/x402/x');
		expect(reqs.map((r) => r.network)).toEqual([SOLANA]);
		expect(reqs[0].amount).toBe(process.env.X402_MAX_AMOUNT_REQUIRED);
	});

	it('lists Solana first, then Base, when opted in (no CDP → no Permit2 sibling)', async () => {
		process.env.X402_ADVERTISE_BASE = 'true';
		const { buildExactRequirements } = await loadSpec();
		const reqs = buildExactRequirements('https://three.ws/api/x402/x');
		expect(reqs.map((r) => r.network)).toEqual([SOLANA, BASE]);
	});

	it('appends the Permit2 sibling after Base when CDP is configured', async () => {
		process.env.CDP_API_KEY_ID = 'x';
		process.env.CDP_API_KEY_SECRET = 'y';
		const { buildExactRequirements } = await loadSpec();
		const reqs = buildExactRequirements('https://three.ws/api/x402/x');
		expect(reqs.map((r) => r.network)).toEqual([SOLANA, BASE, BASE]);
		expect(reqs[2].extra.assetTransferMethod).toBe('permit2');
	});

	it('honors an explicit amount override on every accept', async () => {
		process.env.X402_ADVERTISE_BASE = 'true';
		const { buildExactRequirements } = await loadSpec();
		const reqs = buildExactRequirements('https://three.ws/api/x402/x', '250000');
		expect(reqs.every((r) => r.amount === '250000')).toBe(true);
	});
});

describe('facilitatorFor Solana resolution matrix', () => {
	// The single seam every settle path routes through (task 02). Solana routing:
	//   1. an explicit X402_FACILITATOR_URL_SOLANA (or legacy X402_FACILITATOR_URL)
	//      ALWAYS wins — existing non-ring deploys never silently re-route;
	//   2. else X402_SELF_FACILITATOR_ENABLED=true defaults to this deploy's own
	//      /api/x402-facilitator;
	//   3. else the external PayAI default.
	const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
	const SELF_URL = 'https://three.ws/api/x402-facilitator';
	const PAYAI = 'https://facilitator.payai.network';

	beforeEach(() => {
		delete process.env.X402_SELF_FACILITATOR_ENABLED;
		delete process.env.X402_FACILITATOR_URL_SOLANA;
		delete process.env.X402_FACILITATOR_URL;
		// APP_ORIGIN default is https://three.ws, so the self URL resolves there.
		delete process.env.PUBLIC_APP_ORIGIN;
	});

	it('flag OFF, no URL → external PayAI default (byte-identical to today)', async () => {
		const { facilitatorFor } = await loadSpec();
		const cfg = facilitatorFor(SOLANA);
		expect(cfg.url).toBe(PAYAI);
		expect(cfg.self).toBe(false);
	});

	it('flag ON, no URL → routes to our own /api/x402-facilitator', async () => {
		process.env.X402_SELF_FACILITATOR_ENABLED = 'true';
		const { facilitatorFor } = await loadSpec();
		const cfg = facilitatorFor(SOLANA);
		expect(cfg.url).toBe(SELF_URL);
		expect(cfg.self).toBe(true);
	});

	it('explicit external URL wins even when the flag is ON (no surprise re-route)', async () => {
		process.env.X402_SELF_FACILITATOR_ENABLED = 'true';
		process.env.X402_FACILITATOR_URL_SOLANA = 'https://facilitator.example.test';
		const { facilitatorFor } = await loadSpec();
		const cfg = facilitatorFor(SOLANA);
		expect(cfg.url).toBe('https://facilitator.example.test');
		expect(cfg.self).toBe(false);
	});

	it('explicit self URL is recognized as self when the flag is ON', async () => {
		process.env.X402_SELF_FACILITATOR_ENABLED = 'true';
		process.env.X402_FACILITATOR_URL_SOLANA = 'https://preview.three.ws/api/x402-facilitator';
		const { facilitatorFor } = await loadSpec();
		const cfg = facilitatorFor(SOLANA);
		expect(cfg.url).toBe('https://preview.three.ws/api/x402-facilitator');
		expect(cfg.self).toBe(true);
	});

	it('explicit URL wins with the flag OFF too', async () => {
		process.env.X402_FACILITATOR_URL_SOLANA = 'https://facilitator.example.test';
		const { facilitatorFor } = await loadSpec();
		const cfg = facilitatorFor(SOLANA);
		expect(cfg.url).toBe('https://facilitator.example.test');
		expect(cfg.self).toBe(false);
	});

	it('legacy X402_FACILITATOR_URL is honored as an explicit URL', async () => {
		process.env.X402_SELF_FACILITATOR_ENABLED = 'true';
		process.env.X402_FACILITATOR_URL = 'https://legacy.example.test';
		const { facilitatorFor } = await loadSpec();
		const cfg = facilitatorFor(SOLANA);
		expect(cfg.url).toBe('https://legacy.example.test');
		expect(cfg.self).toBe(false);
	});

	it('a non-"true" flag value does not route to self', async () => {
		process.env.X402_SELF_FACILITATOR_ENABLED = '1';
		const { facilitatorFor } = await loadSpec();
		const cfg = facilitatorFor(SOLANA);
		expect(cfg.url).toBe(PAYAI);
		expect(cfg.self).toBe(false);
	});
});
