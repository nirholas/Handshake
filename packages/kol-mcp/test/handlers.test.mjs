// Handler behavior for @three-ws/kol-mcp: request building, response shaping,
// and error normalization. Global fetch is stubbed for every test, so nothing
// here touches the network.
//
// Env is pinned BEFORE the dynamic imports because src/config.js reads
// process.env at module load.
//
// Run: node --test packages/kol-mcp/test/handlers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.THREE_WS_BASE = 'https://kol.test/';
delete process.env.THREE_WS_TIMEOUT_MS;

const { def: getWalletPortfolio } = await import('../src/tools/get-wallet-portfolio.js');
const { def: getWalletTrades } = await import('../src/tools/get-wallet-trades.js');
const { apiRequest } = await import('../src/lib/api.js');
const { THREE_WS_BASE } = await import('../src/config.js');

// Synthetic wallets: shaped like Solana addresses, owned by nobody.
const WALLET = 'THREEwa11etAudit1111111111111111111111111111';
const OTHER = 'THREEwa11etOther1111111111111111111111111111';
// The one coin this platform promotes.
const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

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

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function recordingFetch(body, log, status = 200) {
	return async (url, init) => {
		log.push({ url: String(url), init });
		return jsonResponse(body, status);
	};
}

test('config strips trailing slashes off THREE_WS_BASE', () => {
	assert.equal(THREE_WS_BASE, 'https://kol.test');
});

// -- get_wallet_portfolio ---------------------------------------------------

test('get_wallet_portfolio asks /api/kol/wallets for exactly the requested address', async () => {
	const log = [];
	const body = { data: [{ address: WALLET, totalUsd: 1200.5, holdings: 3 }] };
	await withFetch(recordingFetch(body, log), () => getWalletPortfolio.handler({ wallet: `  ${WALLET}  ` }));
	const url = new URL(log[0].url);
	assert.equal(url.origin + url.pathname, 'https://kol.test/api/kol/wallets');
	assert.equal(url.searchParams.get('addresses'), WALLET, 'the wallet is trimmed before it is sent');
	assert.equal(log[0].init.method, 'GET');
});

test('get_wallet_portfolio maps the proxy row onto the documented card', async () => {
	const body = {
		data: [
			{
				address: WALLET,
				totalUsd: 38120,
				holdings: 14,
				topToken: { symbol: 'THREE', valueUsd: 21500 },
				realizedPnl: 124300,
				winRate: 0.64,
				totalTrades: 412,
				volumeUsd: 2840000,
				pnlSource: 'onchain-fifo',
				pnlWindow: '30d',
			},
		],
	};
	const out = await withFetch(async () => jsonResponse(body), () =>
		getWalletPortfolio.handler({ wallet: WALLET }),
	);
	assert.deepEqual(out, {
		ok: true,
		wallet: WALLET,
		has_activity: true,
		portfolio_value_usd: 38120,
		holdings: 14,
		top_token: { symbol: 'THREE', valueUsd: 21500 },
		realized_pnl_usd: 124300,
		win_rate: 0.64,
		total_trades: 412,
		volume_usd: 2840000,
		pnl_source: 'onchain-fifo',
		pnl_window: '30d',
	});
});

test('a wallet with no holdings and no trades is has_activity:false, never a fake zero P&L', async () => {
	const body = { data: [{ address: WALLET, totalUsd: 0, holdings: 0, topToken: null, pnlWindow: '30d' }] };
	const out = await withFetch(async () => jsonResponse(body), () =>
		getWalletPortfolio.handler({ wallet: WALLET }),
	);
	assert.equal(out.has_activity, false);
	assert.equal(out.holdings, 0);
	for (const field of ['realized_pnl_usd', 'win_rate', 'total_trades', 'volume_usd', 'pnl_source']) {
		assert.equal(out[field], null, `${field} is an honest unknown, not 0`);
	}
});

test('holdings alone (no trade history) still counts as activity', async () => {
	const body = { data: [{ address: WALLET, totalUsd: 40, holdings: 2, totalTrades: null }] };
	const out = await withFetch(async () => jsonResponse(body), () =>
		getWalletPortfolio.handler({ wallet: WALLET }),
	);
	assert.equal(out.has_activity, true);
	assert.equal(out.total_trades, null);
});

test('a missing row is reported as an outage, not as an empty wallet', async () => {
	// The proxy omits an address whose holdings fetch failed rather than
	// inventing a row, so an empty `data` for a requested wallet is an outage.
	await withFetch(async () => jsonResponse({ data: [] }), () =>
		assert.rejects(getWalletPortfolio.handler({ wallet: WALLET }), (err) => {
			assert.equal(err.code, 'upstream_unavailable');
			assert.equal(err.status, 503);
			assert.match(err.message, /not an empty wallet/);
			return true;
		}),
	);
});

test("another wallet's row is never substituted for the one that was asked for", async () => {
	await withFetch(async () => jsonResponse({ data: [{ address: OTHER, holdings: 9 }] }), () =>
		assert.rejects(
			getWalletPortfolio.handler({ wallet: WALLET }),
			(err) => err.code === 'upstream_unavailable',
		),
	);
});

// -- get_wallet_trades ------------------------------------------------------

test('get_wallet_trades pulls the upstream max and narrows the feed to one wallet', async () => {
	const log = [];
	const body = {
		mint: MINT,
		trades: [
			{ wallet: WALLET, side: 'buy', amountSol: 4.2 },
			{ wallet: OTHER, side: 'sell', amountSol: 1 },
			{ wallet: WALLET, side: 'sell', amountSol: 2.1 },
		],
	};
	const out = await withFetch(recordingFetch(body, log), () =>
		getWalletTrades.handler({ wallet: WALLET, mint: MINT }),
	);
	const url = new URL(log[0].url);
	assert.equal(url.origin + url.pathname, 'https://kol.test/api/kol/trades');
	assert.equal(url.searchParams.get('mint'), MINT);
	assert.equal(url.searchParams.get('limit'), '100', 'always pulls the upstream max before narrowing');
	assert.equal(out.count, 2);
	assert.deepEqual(
		out.trades.map((t) => t.side),
		['buy', 'sell'],
		'feed order is preserved, newest first',
	);
	assert.equal(out.wallet, WALLET);
	assert.equal(out.mint, MINT);
});

test('get_wallet_trades clamps limit into 1-100 and applies it after filtering', async () => {
	const trades = Array.from({ length: 30 }, (_, i) => ({ wallet: i % 2 ? OTHER : WALLET, i }));
	for (const [limit, expected] of [
		[3, 3],
		[undefined, 15],
		[500, 15],
		[0, 15],
	]) {
		const out = await withFetch(async () => jsonResponse({ trades }), () =>
			getWalletTrades.handler({ wallet: WALLET, mint: MINT, limit }),
		);
		assert.equal(out.count, expected, `limit ${limit}`);
	}
});

test('get_wallet_trades answers a wallet with no trades on that mint with an empty page', async () => {
	const out = await withFetch(async () => jsonResponse({ trades: [{ wallet: OTHER }] }), () =>
		getWalletTrades.handler({ wallet: WALLET, mint: MINT }),
	);
	assert.deepEqual(out, { ok: true, wallet: WALLET, mint: MINT, count: 0, trades: [] });
});

test('a malformed upstream body shapes into an empty page, never a crash', async () => {
	for (const body of [{}, { trades: 'not-an-array' }, { trades: null }]) {
		const out = await withFetch(async () => jsonResponse(body), () =>
			getWalletTrades.handler({ wallet: WALLET, mint: MINT }),
		);
		assert.deepEqual(out.trades, []);
		assert.equal(out.count, 0);
	}
});

// -- apiRequest -------------------------------------------------------------

test('apiRequest identifies itself and asks for JSON', async () => {
	const log = [];
	await withFetch(recordingFetch({ data: [] }, log), () => apiRequest('/api/kol/wallets'));
	assert.equal(log[0].init.headers.accept, 'application/json');
	assert.equal(log[0].init.headers['user-agent'], '@three-ws/kol-mcp');
	assert.equal(log[0].init.body, undefined, 'GET carries no body');
});

test('apiRequest surfaces the platform error_description, not just the bare code', async () => {
	// api/_lib/http.js answers { error, error_description }; the sentence is the
	// half a caller can act on.
	const body = {
		error: 'provider_unavailable',
		error_description: 'KOL trade provider unavailable: upstream 429',
	};
	await withFetch(async () => jsonResponse(body, 502), () =>
		assert.rejects(apiRequest('/api/kol/trades'), (err) => {
			assert.equal(err.code, 'upstream_error');
			assert.equal(err.status, 502);
			assert.equal(err.message, 'KOL trade provider unavailable: upstream 429');
			assert.deepEqual(err.body, body);
			return true;
		}),
	);
});

test('apiRequest falls back to a generic message when the error body is not JSON', async () => {
	await withFetch(async () => new Response('<html>oops</html>', { status: 500 }), () =>
		assert.rejects(apiRequest('/api/kol/wallets'), (err) => {
			assert.equal(err.code, 'upstream_error');
			assert.match(err.message, /returned HTTP 500/);
			assert.deepEqual(err.body, { raw: '<html>oops</html>' });
			return true;
		}),
	);
});

test('apiRequest maps a transport failure to network_error and an abort to timeout', async () => {
	await withFetch(
		async () => {
			throw new TypeError('fetch failed');
		},
		() => assert.rejects(apiRequest('/api/kol/wallets'), (err) => err.code === 'network_error'),
	);
	await withFetch(
		async () => {
			throw Object.assign(new Error('aborted'), { name: 'AbortError' });
		},
		() => assert.rejects(apiRequest('/api/kol/wallets'), (err) => err.code === 'timeout'),
	);
});

test('apiRequest skips undefined/null/empty query values but keeps zero', async () => {
	const log = [];
	await withFetch(recordingFetch({ data: [] }, log), () =>
		apiRequest('/api/kol/trades', { query: { a: undefined, b: null, c: '', d: 0, e: 'x' } }),
	);
	const url = new URL(log[0].url);
	assert.deepEqual(
		[...url.searchParams.entries()],
		[
			['d', '0'],
			['e', 'x'],
		],
	);
});
