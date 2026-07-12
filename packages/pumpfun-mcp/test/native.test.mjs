// Behavior tests for the native composed tool (pumpfun_token_3d) and its pure
// helpers. The backend `call` function and global fetch are stubbed in-process
// — these tests never touch the network.
//
// Run: node --test packages/pumpfun-mcp/test/native.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildNativeRegistry, NATIVE_TOOLS } from '../src/native.js';

const BACKEND = 'https://three.ws/api/pump-fun-mcp';
const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

// A stubbed backend `call` that records invocations and answers from a fixture
// map. A tool name absent from the map rejects, like a failed backend read.
function stubCall(fixtures, log = []) {
	return async (name, args) => {
		log.push({ name, args });
		if (!(name in fixtures)) throw new Error(`${name} unavailable`);
		const v = fixtures[name];
		if (v instanceof Error) throw v;
		return v;
	};
}

// Swap globalThis.fetch for the duration of fn, always restoring it.
async function withFetch(stub, fn) {
	const original = globalThis.fetch;
	globalThis.fetch = stub;
	try {
		return await fn();
	} finally {
		globalThis.fetch = original;
	}
}

const noFetch = () => {
	throw new Error('unexpected network call');
};

test('buildNativeRegistry exposes pumpfun_token_3d with a bound handler', () => {
	const { defs, handlers } = buildNativeRegistry(BACKEND, async () => ({}));
	assert.deepEqual(
		defs.map((d) => d.name),
		NATIVE_TOOLS.map((t) => t.def.name),
	);
	assert.ok(handlers.has('pumpfun_token_3d'));
	assert.equal(typeof handlers.get('pumpfun_token_3d'), 'function');
});

test('pumpfun_token_3d requires a non-blank mint (invalid params → rpcCode -32602)', async () => {
	const { handlers } = buildNativeRegistry(BACKEND, stubCall({}));
	const handler = handlers.get('pumpfun_token_3d');
	for (const args of [{}, { mint: '' }, { mint: '   ' }]) {
		await assert.rejects(handler(args), (err) => {
			assert.match(err.message, /mint is required/);
			assert.equal(err.rpcCode, -32602);
			return true;
		});
	}
});

test('success path composes the three backend reads with the exact args', async () => {
	const log = [];
	const call = stubCall(
		{
			getTokenDetails: { name: 'Three', symbol: 'three', image: 'https://cdn.example/logo.png' },
			getBondingCurve: { complete: false, graduationProgress: 55 },
			getTokenHolders: { topHolderPercent: 12.5, holders: [{ address: 'A', percent: 12.5 }] },
		},
		log,
	);
	const { handlers } = buildNativeRegistry(BACKEND, call);
	const out = await withFetch(noFetch, () => handlers.get('pumpfun_token_3d')({ mint: MINT }));

	assert.deepEqual(log, [
		{ name: 'getTokenDetails', args: { mint: MINT } },
		{ name: 'getBondingCurve', args: { mint: MINT, network: 'mainnet' } },
		{ name: 'getTokenHolders', args: { mint: MINT, limit: 12, network: 'mainnet' } },
	]);

	assert.equal(out.mint, MINT);
	assert.equal(out.network, 'mainnet');
	assert.equal(out.name, 'Three');
	assert.equal(out.symbol, 'THREE', 'symbol must be uppercased');
	assert.equal(out.image, 'https://cdn.example/logo.png');
	assert.equal(out.graduated, false);
	// 55 > 1 → interpreted as a percentage and normalized to 0–1.
	assert.equal(out.graduationProgress, 0.55);
	assert.equal(out.topHolderPercent, 12.5);
	assert.deepEqual(out.topHolders, [{ address: 'A', percent: 12.5 }]);
	assert.equal(out.viewerUrl, `https://three.ws/coin3d?mint=${MINT}`);
	assert.ok(out.embedHtml.includes(out.viewerUrl), 'embed iframe must point at the viewer');
	assert.match(out.rendering.coin, /token logo/);
	assert.match(out.rendering.holderGalaxy, /^1 top holders/);
	assert.match(out.rendering.graduationRing, /arc filled/);
});

test('devnet network propagates to every read and into the viewer link', async () => {
	const log = [];
	const call = stubCall(
		{
			getTokenDetails: { name: 'Dev', symbol: 'dev' },
			getBondingCurve: { complete: true },
			getTokenHolders: { holders: [] },
		},
		log,
	);
	const { handlers } = buildNativeRegistry(BACKEND, call);
	const out = await withFetch(noFetch, () =>
		handlers.get('pumpfun_token_3d')({ mint: MINT, network: 'devnet' }),
	);
	assert.equal(out.network, 'devnet');
	for (const entry of log.slice(1)) assert.equal(entry.args.network, 'devnet');
	assert.equal(out.viewerUrl, `https://three.ws/coin3d?mint=${MINT}&network=devnet`);
	assert.equal(out.graduated, true, 'complete:true means graduated');
	assert.match(out.rendering.graduationRing, /full ring/);
});

test('an unrecognized network value coerces to mainnet, never a third network', async () => {
	const log = [];
	const call = stubCall({ getTokenDetails: { name: 'X' } }, log);
	const { handlers } = buildNativeRegistry(BACKEND, call);
	const out = await withFetch(noFetch, () =>
		handlers.get('pumpfun_token_3d')({ mint: MINT, network: 'testnet' }),
	);
	assert.equal(out.network, 'mainnet');
	assert.equal(log[1].args.network, 'mainnet');
});

test('viewer origin derives from the backend URL; a bad URL falls back to three.ws', async () => {
	const fixtures = { getTokenDetails: { name: 'X' } };
	const selfHosted = buildNativeRegistry('https://staging.example.com/api/pump-fun-mcp', stubCall(fixtures));
	const out1 = await withFetch(noFetch, () =>
		selfHosted.handlers.get('pumpfun_token_3d')({ mint: MINT }),
	);
	assert.ok(out1.viewerUrl.startsWith('https://staging.example.com/coin3d?'));

	const broken = buildNativeRegistry('not a url', stubCall(fixtures));
	const out2 = await withFetch(noFetch, () =>
		broken.handlers.get('pumpfun_token_3d')({ mint: MINT }),
	);
	assert.ok(out2.viewerUrl.startsWith('https://three.ws/coin3d?'));
});

test('all three sources failing surfaces one -32004 error naming the mint', async () => {
	const { handlers } = buildNativeRegistry(BACKEND, stubCall({}));
	await assert.rejects(handlers.get('pumpfun_token_3d')({ mint: MINT }), (err) => {
		assert.equal(err.rpcCode, -32004);
		assert.ok(err.message.includes(MINT));
		return true;
	});
});

test('a single failed source degrades gracefully instead of failing the snapshot', async () => {
	const call = stubCall({
		// getTokenDetails missing → rejected
		getBondingCurve: { complete: false, graduationProgress: 0.4 },
		getTokenHolders: { holders: [{ address: 'B' }, { address: 'C' }] },
	});
	const { handlers } = buildNativeRegistry(BACKEND, call);
	const out = await withFetch(noFetch, () => handlers.get('pumpfun_token_3d')({ mint: MINT }));
	assert.equal(out.name, null);
	assert.equal(out.symbol, null);
	assert.equal(out.image, null);
	assert.equal(out.graduationProgress, 0.4, 'values already in 0–1 pass through');
	assert.match(out.rendering.holderGalaxy, /^2 top holders/);
	assert.match(out.rendering.coin, /no logo found/);
});

test('graduationProgress is clamped to [0,1] and marketCapUsd rejects non-numbers', async () => {
	const cases = [
		{ progress: 150, expected: 1 },
		{ progress: -5, expected: 0 },
		{ progress: 'not-a-number', expected: null },
	];
	for (const { progress, expected } of cases) {
		const call = stubCall({
			getTokenDetails: { name: 'X', market_cap: 'NaN-ish' },
			getBondingCurve: { graduationProgress: progress },
		});
		const { handlers } = buildNativeRegistry(BACKEND, call);
		const out = await withFetch(noFetch, () => handlers.get('pumpfun_token_3d')({ mint: MINT }));
		assert.equal(out.graduationProgress, expected, `progress ${progress}`);
		assert.equal(out.marketCapUsd, null);
	}
});

test('marketCapUsd falls back across the alternate field spellings', async () => {
	for (const details of [{ marketCapUsd: 100 }, { usdMarketCap: 200 }, { market_cap: '300' }]) {
		const call = stubCall({ getTokenDetails: details });
		const { handlers } = buildNativeRegistry(BACKEND, call);
		const out = await withFetch(noFetch, () => handlers.get('pumpfun_token_3d')({ mint: MINT }));
		assert.equal(out.marketCapUsd, Object.values(details).map(Number)[0]);
	}
});

test('a direct ipfs:// image field is rewritten to an HTTP gateway without fetching', async () => {
	const call = stubCall({ getTokenDetails: { image: 'ipfs://QmHash/logo.png' } });
	const { handlers } = buildNativeRegistry(BACKEND, call);
	const out = await withFetch(noFetch, () => handlers.get('pumpfun_token_3d')({ mint: MINT }));
	assert.equal(out.image, 'https://ipfs.io/ipfs/QmHash/logo.png');
});

test('the image resolves through the metadata uri JSON when no direct field exists', async () => {
	const fetched = [];
	const fetchStub = async (url) => {
		fetched.push(String(url));
		return new Response(JSON.stringify({ image: 'ipfs://QmMeta/img.png' }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	};
	const call = stubCall({ getTokenDetails: { uri: 'ipfs://QmJson/meta.json' } });
	const { handlers } = buildNativeRegistry(BACKEND, call);
	const out = await withFetch(fetchStub, () => handlers.get('pumpfun_token_3d')({ mint: MINT }));
	assert.deepEqual(fetched, ['https://ipfs.io/ipfs/QmJson/meta.json']);
	assert.equal(out.image, 'https://ipfs.io/ipfs/QmMeta/img.png');
});

test('metadata uri failures (HTTP error, network error) yield image:null, not a throw', async () => {
	const call = stubCall({ getTokenDetails: { uri: 'https://meta.example/x.json' } });
	const { handlers } = buildNativeRegistry(BACKEND, call);

	const on404 = await withFetch(
		async () => new Response('nope', { status: 404 }),
		() => handlers.get('pumpfun_token_3d')({ mint: MINT }),
	);
	assert.equal(on404.image, null);

	const onNetworkError = await withFetch(
		async () => {
			throw new Error('ECONNREFUSED');
		},
		() => handlers.get('pumpfun_token_3d')({ mint: MINT }),
	);
	assert.equal(onNetworkError.image, null);
});
