// Handler behavior for @three-ws/vanity-mcp: which endpoint and view each tool
// requests, how it shapes the query, what it returns to the MCP client, and how
// an upstream failure is normalized. Global fetch is replaced for every test, so
// nothing here touches the network.
//
// Env is pinned BEFORE the dynamic imports because src/config.js reads
// process.env at module load.
//
// Run: node --test packages/vanity-mcp/test/handlers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.THREE_WS_BASE = 'https://vanity.test';
delete process.env.THREE_WS_TIMEOUT_MS;

const { TOOLS, buildServer } = await import('../src/index.js');

// The $THREE mint: a real, public, verifiable Solana address to appraise.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

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

// Answer every fetch with `body`, recording each invocation for assertions.
function recordingFetch(body, log, status = 200) {
	return async (url, init) => {
		log.push({ url: new URL(String(url)), init });
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' },
		});
	};
}

// Every tool maps to exactly one endpoint + view; a drifted view silently
// returns the wrong dataset, which is why this is asserted per tool.
const ENDPOINTS = [
	{ tool: 'vanity_quote', args: { prefix: 'THREE' }, path: '/api/vanity/bounties', view: 'quote' },
	{ tool: 'vanity_board', args: {}, path: '/api/vanity/bounties', view: 'board' },
	{ tool: 'vanity_open', args: {}, path: '/api/vanity/bounties', view: 'open' },
	{ tool: 'vanity_stats', args: {}, path: '/api/vanity/bounties', view: 'stats' },
	{ tool: 'vanity_leaderboard', args: {}, path: '/api/vanity/bounties', view: 'leaderboard' },
	{ tool: 'vanity_config', args: {}, path: '/api/vanity/bounties', view: 'config' },
	{ tool: 'vanity_gallery', args: {}, path: '/api/vanity/gallery', view: 'gallery' },
	{ tool: 'vanity_appraise', args: { address: THREE_MINT }, path: '/api/vanity/gallery', view: 'appraise' },
];

test('every tool reads its own endpoint and view on the configured base', async () => {
	for (const { tool, args, path, view } of ENDPOINTS) {
		const log = [];
		await withFetch(recordingFetch({ appraisal: {} }, log), () => byName[tool].handler(args));

		assert.equal(log.length, 1, `${tool} should make exactly one request`);
		assert.equal(log[0].url.origin, 'https://vanity.test', `${tool} must honour THREE_WS_BASE`);
		assert.equal(log[0].url.pathname, path, `${tool} hits the wrong endpoint`);
		assert.equal(log[0].url.searchParams.get('view'), view, `${tool} requests the wrong view`);
		assert.equal(log[0].init.method, 'GET', `${tool} is read-only and must use GET`);
	}
});

test('vanity_quote sends the pattern and returns the oracle blocks', async () => {
	const log = [];
	const body = {
		pattern: { prefix: 'THREE', suffix: null, ignoreCase: true },
		difficulty: { expectedAttempts: 11308763834, rarityBits: 39, tier: 'mythic', tierLabel: 'Mythic' },
		oracle: { floorAtomics: 50000, suggestedAtomics: 2094216 },
		band: { floorAtomics: 50000, maxAtomics: 5000000000, decimals: 6, asset: 'USDC' },
		ignored: 'field the tool does not forward',
	};
	const result = await withFetch(recordingFetch(body, log), () =>
		byName.vanity_quote.handler({ prefix: 'THREE', ignoreCase: true }),
	);

	assert.equal(log[0].url.searchParams.get('prefix'), 'THREE');
	assert.equal(log[0].url.searchParams.get('ignoreCase'), '1');
	assert.equal(log[0].url.searchParams.get('suffix'), null, 'an empty suffix is omitted, not sent blank');

	assert.equal(result.ok, true);
	assert.deepEqual(result.difficulty, body.difficulty);
	assert.deepEqual(result.oracle, body.oracle);
	assert.deepEqual(result.band, body.band);
	assert.equal('ignored' in result, false, 'quote forwards only the documented blocks');
});

test('vanity_quote refuses an empty pattern before any request', async () => {
	const log = [];
	await withFetch(recordingFetch({}, log), () =>
		assert.rejects(() => byName.vanity_quote.handler({ prefix: '  ' }), (err) => {
			assert.equal(err.code, 'validation_error');
			assert.equal(err.status, 400);
			return true;
		}),
	);
	assert.equal(log.length, 0, 'no network call for an unusable pattern');
});

test('vanity_appraise echoes the address and passes length overrides through', async () => {
	const log = [];
	const appraisal = { address: THREE_MINT, prefix: 'FeMb', suffix: null, score: 2166, tier: 'epic' };
	const result = await withFetch(recordingFetch({ appraisal }, log), () =>
		byName.vanity_appraise.handler({ address: ` ${THREE_MINT} `, prefixLen: 4, suffixLen: 0 }),
	);

	assert.equal(log[0].url.searchParams.get('address'), THREE_MINT, 'the address is trimmed');
	assert.equal(log[0].url.searchParams.get('prefixLen'), '4');
	assert.equal(result.address, THREE_MINT);
	assert.deepEqual(result.appraisal, appraisal);
	assert.equal(result.published, null, 'an unpublished address reports null, never a fabricated entry');
});

test('vanity_board defaults status and sort, and forwards pagination', async () => {
	const log = [];
	const body = { bounties: [], total: 0, hasMore: false, status: 'settled', sort: 'reward' };
	const result = await withFetch(recordingFetch(body, log), () =>
		byName.vanity_board.handler({ status: 'settled', sort: 'reward', limit: 5, offset: 10 }),
	);

	assert.equal(log[0].url.searchParams.get('status'), 'settled');
	assert.equal(log[0].url.searchParams.get('sort'), 'reward');
	assert.equal(log[0].url.searchParams.get('limit'), '5');
	assert.equal(log[0].url.searchParams.get('offset'), '10');
	assert.equal(result.ok, true);
	assert.equal(result.total, 0);
	assert.deepEqual(result.bounties, []);

	const defaults = [];
	await withFetch(recordingFetch(body, defaults), () => byName.vanity_board.handler({}));
	assert.equal(defaults[0].url.searchParams.get('status'), 'open');
	assert.equal(defaults[0].url.searchParams.get('sort'), 'recency');
});

test('vanity_gallery forwards every filter it advertises', async () => {
	const log = [];
	await withFetch(recordingFetch({ entries: [], total: 0 }, log), () =>
		byName.vanity_gallery.handler({ sort: 'recency', tier: 'mythic', minLength: 4, contains: 'THR', limit: 3, offset: 6 }),
	);

	const q = log[0].url.searchParams;
	assert.equal(q.get('sort'), 'recency');
	assert.equal(q.get('tier'), 'mythic');
	assert.equal(q.get('minLength'), '4');
	assert.equal(q.get('contains'), 'THR');
	assert.equal(q.get('limit'), '3');
	assert.equal(q.get('offset'), '6');
});

test('an empty market reads as zeroes, not as an error', async () => {
	const stats = await withFetch(
		recordingFetch({ open: 0, openEscrowAtomics: 0, settled: 0, paidOutAtomics: 0, total: 0 }, []),
		() => byName.vanity_stats.handler({}),
	);
	assert.equal(stats.ok, true);
	assert.equal(stats.open, 0);
	assert.equal(stats.paidOutAtomics, 0);

	const board = await withFetch(recordingFetch({ grinders: [], count: 0 }, []), () =>
		byName.vanity_leaderboard.handler({ limit: 3 }),
	);
	assert.equal(board.ok, true);
	assert.deepEqual(board.grinders, []);
});

test('an upstream failure becomes a typed error carrying the HTTP status', async () => {
	const failing = recordingFetch({ error: 'validation_error', message: 'prefix is not Base58' }, [], 400);
	await withFetch(failing, () =>
		assert.rejects(() => byName.vanity_quote.handler({ prefix: 'O0' }), (err) => {
			assert.equal(err.code, 'upstream_error');
			assert.equal(err.status, 400);
			assert.match(err.message, /prefix is not Base58/);
			return true;
		}),
	);
});

test('the server wrapper renders results and failures as MCP content blocks', async () => {
	const server = buildServer();
	const registered = server._registeredTools.vanity_stats;

	const ok = await withFetch(recordingFetch({ open: 2, total: 7 }, []), () => registered.handler({}, {}));
	assert.equal(ok.isError, undefined);
	assert.equal(JSON.parse(ok.content[0].text).total, 7);

	const failing = recordingFetch({ error: 'upstream', message: 'market unavailable' }, [], 503);
	const bad = await withFetch(failing, () => registered.handler({}, {}));
	assert.equal(bad.isError, true);
	const payload = JSON.parse(bad.content[0].text);
	assert.equal(payload.ok, false);
	assert.equal(payload.status, 503);
});
