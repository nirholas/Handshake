// Handler behavior for @three-ws/clash-mcp: request building, the full enlist
// proof (real ed25519 signing, verified in-test), response shaping, and error
// normalization. Global fetch is stubbed for every test, so nothing here touches
// the network. The signing is NOT stubbed: every signature below is produced by
// the package's own signer and verified against the challenge bytes with
// tweetnacl, which is the whole point of the write path.
//
// Env is pinned BEFORE the dynamic imports because src/config.js reads
// process.env at module load. SOLANA_SECRET_KEY is deliberately left unset so
// the missing-signer path is exercised as it ships.
//
// Run: node --test packages/clash-mcp/test/handlers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

process.env.THREE_WS_BASE = 'https://clash.test';
delete process.env.SOLANA_SECRET_KEY;
delete process.env.CLASH_SOLANA_SECRET;
delete process.env.THREE_WS_TIMEOUT_MS;

const { def: state } = await import('../src/tools/get-clash-state.js');
const { def: leaderboard } = await import('../src/tools/get-clash-leaderboard.js');
const { def: enlistFaction } = await import('../src/tools/enlist-faction.js');
const { def: rallyFaction } = await import('../src/tools/rally-faction.js');
const { loadSigner, signMessage } = await import('../src/lib/signer.js');

const bs58encode = bs58.default ? bs58.default.encode : bs58.encode;

// A real, throwaway ed25519 keypair. The 64-byte secret is exactly the base58
// form the tools accept, so the signatures below are the ones a soldier's
// wallet would produce.
const KEYPAIR = nacl.sign.keyPair();
const SECRET = bs58encode(KEYPAIR.secretKey);
const WALLET = bs58encode(KEYPAIR.publicKey);

// A synthetic faction mint. Never a real third-party token.
const FACTION = 'THREEsynthetic1111111111111111111111111111';

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

// A scripted fetch: route by pathname, record every call. Each route is either a
// literal body (answered 200) or `{ status, body }`.
function routedFetch(routes, log) {
	return async (url, init) => {
		const u = new URL(String(url));
		const body = init?.body ? JSON.parse(init.body) : null;
		log.push({ path: u.pathname, search: u.searchParams, method: init?.method || 'GET', body });
		const route = routes[u.pathname];
		if (!route) throw new Error(`routedFetch: no route for ${u.pathname}`);
		const answer = typeof route === 'function' ? route(body) : route;
		const { status = 200, body: payload = answer } = answer?.status ? answer : { body: answer };
		return new Response(JSON.stringify(payload), {
			status,
			headers: { 'content-type': 'application/json' },
		});
	};
}

const STATE_ENVELOPE = {
	data: {
		epoch: 412,
		endsAt: 1770000000000,
		msLeft: 128000,
		epochMs: 900000,
		factionCount: 3,
		arena: [
			{
				a: { token: FACTION, symbol: 'THREE', power: 120, momentum: 1.4 },
				b: { token: `${FACTION}b`, symbol: 'OTHER', power: 80, momentum: 1 },
				aShare: 0.6,
				leader: FACTION,
			},
		],
		bye: null,
	},
};

// ── read tools ────────────────────────────────────────────────────────────────

test('get_clash_state reads the board and shapes the envelope', async () => {
	const log = [];
	const out = await withFetch(routedFetch({ '/api/clash/state': STATE_ENVELOPE }, log), () => state.handler());

	assert.equal(log.length, 1);
	assert.equal(log[0].path, '/api/clash/state');
	assert.equal(log[0].method, 'GET');
	assert.equal(out.ok, true);
	assert.equal(out.epoch, 412);
	assert.equal(out.msLeft, 128000);
	assert.equal(out.factionCount, 3);
	assert.equal(out.arena[0].leader, FACTION);
});

test('get_clash_state defaults every field when the round has no data yet', async () => {
	const out = await withFetch(routedFetch({ '/api/clash/state': { data: {} } }, []), () => state.handler());
	assert.deepEqual(out, {
		ok: true,
		epoch: null,
		endsAt: null,
		msLeft: null,
		epochMs: null,
		factionCount: 0,
		arena: [],
		bye: null,
	});
});

test('get_clash_leaderboard omits the faction query when none is asked for', async () => {
	const log = [];
	const board = [{ token: FACTION, symbol: 'THREE', w: 3, l: 1, d: 0, battles: 4, power: 900, winRate: 75 }];
	const out = await withFetch(routedFetch({ '/api/clash/leaderboard': { data: { board, soldiers: null } } }, log), () =>
		leaderboard.handler({}),
	);

	assert.equal(log[0].search.get('faction'), null);
	assert.equal(out.board[0].winRate, 75);
	assert.equal(out.soldiers, null);
});

test('get_clash_leaderboard forwards a faction mint and returns its soldiers', async () => {
	const log = [];
	const soldiers = [{ wallet: WALLET, power: 240 }];
	const out = await withFetch(
		routedFetch({ '/api/clash/leaderboard': { data: { board: [], soldiers } } }, log),
		() => leaderboard.handler({ faction: `  ${FACTION}  ` }),
	);

	assert.equal(log[0].search.get('faction'), FACTION, 'the mint is trimmed before it is sent');
	assert.deepEqual(out.soldiers, soldiers);
});

test('an upstream rejection becomes a typed upstream_error carrying the status', async () => {
	const routes = { '/api/clash/state': { status: 503, body: { error: 'cc_unconfigured', message: 'Coin Clash is not configured.' } } };
	await withFetch(routedFetch(routes, []), async () => {
		await assert.rejects(() => state.handler(), (err) => {
			assert.equal(err.code, 'upstream_error');
			assert.equal(err.status, 503);
			assert.equal(err.message, 'Coin Clash is not configured.');
			assert.equal(err.body.error, 'cc_unconfigured');
			return true;
		});
	});
});

// ── signer ────────────────────────────────────────────────────────────────────

test('loadSigner derives the wallet from the secret and signs verifiably', () => {
	const { wallet } = loadSigner(SECRET);
	assert.equal(wallet, WALLET);

	const message = 'three.ws Coin Clash enlistment\nwallet: ' + WALLET;
	const { signature } = signMessage(message, SECRET);
	const ok = nacl.sign.detached.verify(
		new TextEncoder().encode(message),
		bs58.default ? bs58.default.decode(signature) : bs58.decode(signature),
		KEYPAIR.publicKey,
	);
	assert.ok(ok, 'the detached signature must verify against the challenge bytes');
});

test('loadSigner refuses a missing, non-base58, or wrong-length secret', () => {
	assert.throws(() => loadSigner(), (err) => err.code === 'no_signer');
	assert.throws(() => loadSigner('not base58 0OIl'), (err) => err.code === 'invalid_secret');
	// Valid base58, but a 32-byte key rather than the 64-byte secret key.
	assert.throws(
		() => loadSigner(bs58encode(KEYPAIR.publicKey)),
		(err) => err.code === 'invalid_secret' && /64 bytes/.test(err.message),
	);
});

// ── enlist ────────────────────────────────────────────────────────────────────

const CHALLENGE = `three.ws Coin Clash\nfaction: ${FACTION}\nnonce: 8f2c`;

function enlistRoutes({ verify } = {}) {
	return {
		'/api/clash/enlist': { data: { message: CHALLENGE, expiresAt: 1770000300000 } },
		'/api/clash/enlist-verify':
			verify ?? { data: { eligible: true, wallet: WALLET, amount: 125000, usd: 42.5, warPass: 'pass_abc' } },
	};
}

test('enlist_faction runs challenge, real signature, and verify in order', async () => {
	const log = [];
	const out = await withFetch(routedFetch(enlistRoutes(), log), () =>
		enlistFaction.handler({ token: FACTION, secret: SECRET }),
	);

	assert.deepEqual(log.map((c) => c.path), ['/api/clash/enlist', '/api/clash/enlist-verify']);
	assert.deepEqual(log[0].body, { token: FACTION, wallet: WALLET }, 'the challenge is bound to the derived wallet');

	const submitted = log[1].body;
	assert.equal(submitted.token, FACTION);
	assert.equal(submitted.wallet, WALLET);
	assert.equal(submitted.message, CHALLENGE, 'the exact challenge text is echoed back');
	const verified = nacl.sign.detached.verify(
		new TextEncoder().encode(CHALLENGE),
		bs58.default ? bs58.default.decode(submitted.signature) : bs58.decode(submitted.signature),
		KEYPAIR.publicKey,
	);
	assert.ok(verified, 'the submitted signature must verify against the challenge');

	assert.equal(out.ok, true);
	assert.equal(out.eligible, true);
	assert.equal(out.warPass, 'pass_abc');
	assert.equal(out.amount, 125000);
	assert.equal(out.usd, 42.5);
	assert.equal(out.reason, null);
	assert.equal(out.challengeExpiresAt, 1770000300000);
});

test('a wallet that holds none of the coin is answered, not thrown', async () => {
	const routes = enlistRoutes({ verify: { data: { eligible: false, wallet: WALLET, amount: 0, usd: 0, reason: 'not_a_holder' } } });
	const out = await withFetch(routedFetch(routes, []), () => enlistFaction.handler({ token: FACTION, secret: SECRET }));

	assert.equal(out.ok, true);
	assert.equal(out.eligible, false);
	assert.equal(out.warPass, null);
	assert.equal(out.reason, 'not_a_holder');
});

test('enlist_faction rejects an empty faction and a missing signer before any request', async () => {
	const log = [];
	await withFetch(routedFetch({}, log), async () => {
		await assert.rejects(() => enlistFaction.handler({ token: '   ', secret: SECRET }), (err) => err.code === 'validation_error');
		await assert.rejects(() => enlistFaction.handler({ token: FACTION }), (err) => err.code === 'no_signer');
	});
	assert.equal(log.length, 0, 'neither failure should reach the network');
});

test('a challenge with no message to sign is an upstream_error', async () => {
	const routes = { '/api/clash/enlist': { data: {} } };
	await withFetch(routedFetch(routes, []), async () => {
		await assert.rejects(
			() => enlistFaction.handler({ token: FACTION, secret: SECRET }),
			(err) => err.code === 'upstream_error' && /challenge/.test(err.message),
		);
	});
});

// ── rally ─────────────────────────────────────────────────────────────────────

const RALLY_ENVELOPE = {
	data: {
		epoch: 412,
		mint: FACTION,
		added: 14,
		momentum: 1.4,
		walletPower: 140,
		walletCap: 500,
		capped: false,
		factionPower: 1340,
		msLeft: 96000,
	},
};

test('rally_faction spends a war pass directly and shapes the round result', async () => {
	const log = [];
	const out = await withFetch(routedFetch({ '/api/clash/rally': RALLY_ENVELOPE }, log), () =>
		rallyFaction.handler({ pass: '  pass_abc  ', taps: 10 }),
	);

	assert.equal(log.length, 1, 'a supplied pass skips the enlist round trip entirely');
	assert.equal(log[0].path, '/api/clash/rally');
	assert.deepEqual(log[0].body, { pass: 'pass_abc', taps: 10 });
	assert.equal(out.ok, true);
	assert.equal(out.added, 14);
	assert.equal(out.factionPower, 1340);
	assert.equal(out.capped, false);
	assert.equal(out.enlisted, undefined, 'no auto-enlist happened, so no enlistment is reported');
});

test('rally_faction auto-enlists from a token and reports the enlistment', async () => {
	const log = [];
	const out = await withFetch(routedFetch({ ...enlistRoutes(), '/api/clash/rally': RALLY_ENVELOPE }, log), () =>
		rallyFaction.handler({ token: FACTION, secret: SECRET, taps: 10 }),
	);

	assert.deepEqual(log.map((c) => c.path), ['/api/clash/enlist', '/api/clash/enlist-verify', '/api/clash/rally']);
	assert.equal(log[2].body.pass, 'pass_abc', 'the freshly minted pass is what gets spent');
	assert.deepEqual(out.enlisted, { wallet: WALLET, amount: 125000, usd: 42.5 });
	assert.equal(out.added, 14);
});

test('rally_faction needs either a pass or a token', async () => {
	const log = [];
	await withFetch(routedFetch({}, log), async () => {
		await assert.rejects(() => rallyFaction.handler({ taps: 5 }), (err) => err.code === 'validation_error');
	});
	assert.equal(log.length, 0);
});

test('auto-enlisting a non-holder throws not_eligible with the wallet and reason', async () => {
	const routes = {
		...enlistRoutes({ verify: { data: { eligible: false, wallet: WALLET, amount: 0, usd: 0, reason: 'not_a_holder' } } }),
		'/api/clash/rally': RALLY_ENVELOPE,
	};
	const log = [];
	await withFetch(routedFetch(routes, log), async () => {
		await assert.rejects(
			() => rallyFaction.handler({ token: FACTION, secret: SECRET, taps: 5 }),
			(err) => {
				assert.equal(err.code, 'not_eligible');
				assert.deepEqual(err.detail, { wallet: WALLET, faction: FACTION, reason: 'not_a_holder' });
				return true;
			},
		);
	});
	assert.ok(
		!log.some((c) => c.path === '/api/clash/rally'),
		'an ineligible wallet must never reach the rally endpoint',
	);
});
