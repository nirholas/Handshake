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
// reset. We import the spec module once for the whole file — a fresh import
// per test would re-walk @coinbase/x402 + @x402/extensions (cold-load > 30s
// on a CI worker) for no behavioural benefit.
//
// The cold-import alone routinely exceeds 60s on a fresh Codespace because it
// transitively pulls @coinbase/x402, @x402/extensions, the BSC direct-payment
// module, and (through that) the full ethers core. We warm the import in
// `beforeAll` so individual tests start with the spec already resolved, and
// give the warmup itself a generous 120s window. Tests still get 30s each —
// that's plenty for the synchronous fast paths we actually exercise.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

const specPromise = import('../../api/_lib/x402-spec.js');
let spec;
beforeAll(async () => {
	spec = await specPromise;
});

const ORIG_ENV = { ...process.env };

beforeEach(() => {
	// Baseline env every test sees; individual tests may toggle CDP credentials.
	process.env.X402_PAY_TO_SOLANA = 'BUrwd1nK6tFeeJMyzRHDo6AuVbnSfUULfvwq21X93nSN';
	process.env.X402_PAY_TO_BASE = '0x4022de2d36c334e73c7a108805cea11c0564f402';
	process.env.X402_ASSET_MINT_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
	process.env.X402_ASSET_ADDRESS_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
	process.env.X402_MAX_AMOUNT_REQUIRED = '1000';
	process.env.X402_FEE_PAYER_SOLANA = '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4';
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
				payTo: 'BUrwd1nK6tFeeJMyzRHDo6AuVbnSfUULfvwq21X93nSN',
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
		const body = build402Body({
			resourceUrl: 'https://three.ws/api/x402/foo',
			accepts: [baseAccept],
		});
		expect(Object.keys(body.extensions)).toEqual(['bazaar']);
	});

	it('auto-declares eip2612GasSponsoring + erc20ApprovalGasSponsoring when a Permit2 accept is present', async () => {
		const { build402Body, EIP2612_EXTENSION_KEY, ERC20_APPROVAL_EXTENSION_KEY } =
			await loadSpec();
		const body = build402Body({
			resourceUrl: 'https://three.ws/api/x402/foo',
			accepts: [baseAccept, permit2Accept],
		});
		expect(body.extensions[EIP2612_EXTENSION_KEY]).toBeDefined();
		expect(body.extensions[EIP2612_EXTENSION_KEY].info.version).toBe('1');
		expect(body.extensions[ERC20_APPROVAL_EXTENSION_KEY]).toBeDefined();
	});

	it('passes caller-supplied extensions through (last-write-wins)', async () => {
		const { build402Body } = await loadSpec();
		const body = build402Body({
			resourceUrl: 'https://three.ws/api/x402/foo',
			accepts: [baseAccept],
			extensions: { customSentinel: { hello: 'world' } },
		});
		expect(body.extensions.customSentinel).toEqual({ hello: 'world' });
		expect(body.extensions.bazaar).toBeDefined();
	});

	it('emits the v2 envelope shape required by the spec', async () => {
		const { build402Body, X402_VERSION } = await loadSpec();
		const body = build402Body({
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
		send402(res, {
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
});
