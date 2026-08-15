// /api/native-launch/* dispatcher behavior: routing, auth gating, validation,
// and the two on-chain guards that decide whether a transaction is allowed to
// be recorded as a launch. The Solana/DBC layer is stubbed — the real curve is
// covered by native-launch-curve.test.js and by the devnet end-to-end script.

import { describe, it, expect, vi, beforeEach } from 'vitest';

let sessionUser = { id: 'user-1' };
const dbRows = { user_wallets: [], native_launches: [], pending: [] };
// Every SQL text the handler issued this test, so a validation guard can be
// proven to short-circuit before the query rather than merely returning 400.
const sqlCalls = [];

vi.mock('../api/_lib/http.js', () => ({
	wrap: (fn) => fn,
	cors: () => false,
	method: () => true,
	readJson: async (req) => req.body ?? {},
	rateLimited: (res) => {
		res._json = { status: 429, body: { error: 'rate_limited' } };
		return res;
	},
	error: (res, status, code, message, extra = {}) => {
		res._json = { status, body: { error: code, error_description: message, ...extra } };
		return res;
	},
	json: (res, status, body) => {
		res._json = { status, body };
		return res;
	},
}));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		authIp: vi.fn(async () => ({ success: true })),
		authedReadIp: vi.fn(async () => ({ success: true })),
		mcpIp: vi.fn(async () => ({ success: true })),
	},
	clientIp: () => '1.2.3.4',
}));
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => sessionUser),
}));
// A tagged-template stub that answers by inspecting the SQL text.
vi.mock('../api/_lib/db.js', () => ({
	sql: (strings) => {
		const text = strings.join(' ');
		sqlCalls.push(text);
		if (text.includes('from user_wallets')) return Promise.resolve(dbRows.user_wallets);
		if (text.includes('from native_launches')) return Promise.resolve(dbRows.native_launches);
		if (text.includes('from agent_registrations_pending')) return Promise.resolve(dbRows.pending);
		return Promise.resolve([]);
	},
}));
vi.mock('../api/_lib/r2.js', () => ({
	publicUrl: (k) => `https://cdn.test/${k}`,
	// The launch row resolves avatar thumbnails through thumbnailUrl(), which
	// drops the legacy origin-pointing keys that publicUrl() would happily emit.
	thumbnailUrl: (k) => (k ? `https://cdn.test/${k}` : null),
}));
vi.mock('../api/_lib/feed.js', () => ({ publishFeedEvent: vi.fn(async () => {}) }));
vi.mock('../api/_lib/agent-identity.js', () => ({
	resolveOrCreateAgentForAvatar: vi.fn(async () => ({ id: 'agent-1' })),
}));
vi.mock('../api/_lib/usage.js', () => ({
	logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const verifySignature = vi.fn();
vi.mock('../api/_lib/pump.js', () => ({
	verifySignature: (...a) => verifySignature(...a),
	// Accepts anything base58-ish and long enough to be a pubkey.
	solanaPubkey: (s) =>
		typeof s === 'string' && s.length >= 32 && s.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s)
			? { toBase58: () => s }
			: null,
}));

const txInvokesDbcProgram = vi.fn(() => true);
vi.mock('../api/_lib/native-launch/dbc.js', () => ({
	txInvokesDbcProgram: (...a) => txInvokesDbcProgram(...a),
	buildCreatePoolTx: vi.fn(async () => ({
		txBase64: 'AQID',
		pool: 'PoolAddress11111111111111111111111111111111',
		configKey: 'ConfigKey111111111111111111111111111111111',
	})),
	getPoolState: vi.fn(async () => ({ pool: 'PoolAddress11111111111111111111111111111111' })),
	quoteBuy: vi.fn(async () => ({ pool: 'p', sol_in: 1, tokens_out: 100 })),
}));

import handler from '../api/native-launch/[action].js';
import { configKeyFor } from '../api/_lib/native-launch/config.js';

const CONFIG_KEY = 'DevnetConfigKey11111111111111111111111111111';
const WALLET = 'FjRJ24ecvmPX488PcN3RpNPM9gq3xCxRjnju4LSr9M6f';
const MINT = '3wsr2fWnuQ4hFRPHsxWin9YWiUT4qGMhGpE1CrboX47J';
const SIG = 'x'.repeat(88);

function makeRes() {
	const res = { _json: null };
	res.setHeader = () => res;
	return res;
}
const call = (action, { method = 'GET', body, query = {} } = {}) => {
	const qs = new URLSearchParams({ action, ...query }).toString();
	const req = { url: `/api/native-launch/${action}?${qs}`, method, headers: { host: 'x' }, query: { action }, body };
	const res = makeRes();
	return handler(req, res).then(() => res._json);
};

beforeEach(() => {
	sessionUser = { id: 'user-1' };
	dbRows.user_wallets = [];
	dbRows.native_launches = [];
	dbRows.pending = [];
	sqlCalls.length = 0;
	verifySignature.mockReset();
	txInvokesDbcProgram.mockReset().mockReturnValue(true);
	process.env.NATIVE_LAUNCH_CONFIG_KEY_DEVNET = CONFIG_KEY;
	delete process.env.NATIVE_LAUNCH_CONFIG_KEY;
});

describe('dispatcher', () => {
	it('404s an unknown action', async () => {
		const r = await call('bogus');
		expect(r.status).toBe(404);
		expect(r.body.error).toBe('not_found');
	});
});

describe('config', () => {
	it('reports availability per network from the pinned config key', async () => {
		const dev = await call('config', { query: { network: 'devnet' } });
		expect(dev.status).toBe(200);
		expect(dev.body.available).toBe(true);
		expect(dev.body.config_key).toBe(CONFIG_KEY);

		// Mainnet has no key set in this test, so the lane must read as absent
		// rather than falling back to the devnet curve.
		const main = await call('config');
		expect(main.body.available).toBe(false);
		expect(main.body.config_key).toBeNull();
		expect(configKeyFor('mainnet')).toBeNull();
	});

	it('never advertises a fee split that does not add up', async () => {
		const { fee_split } = (await call('config')).body;
		expect(fee_split.creator_percent + fee_split.platform_percent).toBe(100);
	});
});

describe('quote', () => {
	it('rejects a malformed mint', async () => {
		const r = await call('quote', { query: { mint: 'not-a-mint', sol_in: '1' } });
		expect(r.status).toBe(400);
		expect(r.body.error).toBe('validation_error');
	});

	it('rejects a non-positive or oversized sol_in', async () => {
		for (const sol_in of ['0', '-1', '100000']) {
			const r = await call('quote', { query: { mint: MINT, sol_in } });
			expect(r.status).toBe(400);
		}
	});
});

describe('launch-prep', () => {
	const body = {
		avatar_id: '00000000-0000-0000-0000-000000000001',
		wallet_address: WALLET,
		name: 'Native Coin',
		symbol: 'NTV',
		uri: 'https://three.ws/meta.json',
		network: 'devnet',
	};

	it('requires a session', async () => {
		sessionUser = null;
		const r = await call('launch-prep', { method: 'POST', body });
		expect(r.status).toBe(401);
	});

	it('refuses a wallet the user has not linked', async () => {
		dbRows.user_wallets = [];
		const r = await call('launch-prep', { method: 'POST', body });
		expect(r.status).toBe(403);
		expect(r.body.error).toBe('forbidden');
	});

	it('503s when the lane has no curve deployed on the requested network', async () => {
		delete process.env.NATIVE_LAUNCH_CONFIG_KEY_DEVNET;
		dbRows.user_wallets = [{ id: 'w1' }];
		const r = await call('launch-prep', { method: 'POST', body });
		expect(r.status).toBe(503);
		expect(r.body.error).toBe('lane_not_configured');
	});

	it('returns an unsigned tx plus the derived pool for a linked wallet', async () => {
		dbRows.user_wallets = [{ id: 'w1' }];
		const r = await call('launch-prep', { method: 'POST', body });
		expect(r.status).toBe(201);
		expect(r.body.lane).toBe('native');
		expect(r.body.tx_base64).toBe('AQID');
		expect(r.body.pool).toBe('PoolAddress11111111111111111111111111111111');
		expect(r.body.prep_id).toBeTruthy();
		// A server-stamped mint must hand back its secret — the browser has to
		// co-sign with it — and the mint has to carry the three.ws mark.
		expect(r.body.mint_secret_key_b64).toBeTruthy();
		expect(r.body.mint.toLowerCase()).toContain('3ws');
	});
});

describe('launch-confirm', () => {
	const prepRow = {
		id: 'p1',
		metadata_uri: 'https://three.ws/meta.json',
		payload: {
			kind: 'native_launch',
			prep_id: 'prep123456',
			agent_id: 'agent-1',
			wallet_address: WALLET,
			creator_address: WALLET,
			mint: MINT,
			pool: 'PoolAddress11111111111111111111111111111111',
			config_key: CONFIG_KEY,
			name: 'Native Coin',
			symbol: 'NTV',
			network: 'devnet',
		},
	};
	const body = { prep_id: 'prep123456', tx_signature: SIG };

	it('404s an unknown or expired prep', async () => {
		dbRows.pending = [];
		const r = await call('launch-confirm', { method: 'POST', body });
		expect(r.status).toBe(404);
	});

	it('refuses a prep issued by the other lane', async () => {
		dbRows.pending = [{ ...prepRow, payload: { ...prepRow.payload, kind: 'pump_launch' } }];
		const r = await call('launch-confirm', { method: 'POST', body });
		expect(r.status).toBe(400);
		expect(r.body.error).toBe('wrong_kind');
	});

	it('refuses a transaction that does not contain the prepped mint', async () => {
		dbRows.pending = [prepRow];
		verifySignature.mockResolvedValue({
			transaction: { message: { accountKeys: [{ pubkey: 'SomeOtherAccount1111111111111111111111111' }] } },
		});
		const r = await call('launch-confirm', { method: 'POST', body });
		expect(r.status).toBe(422);
		expect(r.body.error).toBe('mint_not_in_tx');
	});

	it('refuses a transaction that never invoked the bonding-curve program', async () => {
		// The critical guard: a confirmed memo or transfer that merely touches the
		// new mint account must not be recordable as a launch.
		dbRows.pending = [prepRow];
		verifySignature.mockResolvedValue({
			transaction: { message: { accountKeys: [{ pubkey: MINT }] } },
		});
		txInvokesDbcProgram.mockReturnValue(false);
		const r = await call('launch-confirm', { method: 'POST', body });
		expect(r.status).toBe(422);
		expect(r.body.error).toBe('not_a_native_launch');
	});

	it('refuses a mint that is already recorded', async () => {
		dbRows.pending = [prepRow];
		dbRows.native_launches = [{ id: 'existing' }];
		verifySignature.mockResolvedValue({
			transaction: { message: { accountKeys: [{ pubkey: MINT }] } },
		});
		const r = await call('launch-confirm', { method: 'POST', body });
		expect(r.status).toBe(409);
	});

	it('surfaces an unverifiable signature as the RPC reported it', async () => {
		dbRows.pending = [prepRow];
		verifySignature.mockRejectedValue(
			Object.assign(new Error('tx not found'), { status: 422, code: 'tx_not_found' }),
		);
		const r = await call('launch-confirm', { method: 'POST', body });
		expect(r.status).toBe(422);
		expect(r.body.error).toBe('tx_not_found');
	});
});

describe('launches', () => {
	it('returns an empty, well-formed page when nothing has launched', async () => {
		const r = await call('launches', { query: { network: 'devnet' } });
		expect(r.status).toBe(200);
		expect(r.body.data).toEqual({
			launches: [],
			has_more: false,
			offset: 0,
			limit: 24,
			network: 'devnet',
		});
	});

	it('rejects a non-uuid agent_id before it ever reaches the uuid column', async () => {
		// agent_id is compared against a uuid column. Passing it through
		// unvalidated makes Postgres raise and the request answer 500.
		const r = await call('launches', { query: { agent_id: 'not-a-uuid' } });
		expect(r.status).toBe(400);
		expect(r.body.error).toBe('validation_error');
		expect(sqlCalls).toEqual([]);
	});

	it('shapes a launch row with its agent, and hides a private avatar thumbnail', async () => {
		dbRows.native_launches = [
			{
				mint: MINT,
				pool: 'PoolAddress11111111111111111111111111111111',
				network: 'devnet',
				name: 'Native Coin',
				symbol: 'NTV',
				metadata_uri: 'https://cf-ipfs.com/ipfs/bafkreiabc',
				status: 'live',
				created_at: '2026-08-13T00:00:00.000Z',
				agent_id: 'agent-1',
				agent_name: 'Scout',
				avatar_thumbnail_key: 'thumbs/a.png',
				avatar_visibility: 'public',
			},
			{
				mint: MINT,
				pool: 'PoolAddress11111111111111111111111111111111',
				network: 'devnet',
				name: 'Quiet Coin',
				symbol: 'QIT',
				metadata_uri: null,
				status: 'live',
				created_at: '2026-08-12T00:00:00.000Z',
				agent_id: 'agent-2',
				agent_name: 'Hidden',
				avatar_thumbnail_key: 'thumbs/b.png',
				avatar_visibility: 'private',
			},
		];
		const r = await call('launches', { query: { network: 'devnet', limit: '1' } });
		expect(r.status).toBe(200);
		// limit=1 with two rows back means the query overfetched by one: the
		// second row is the has_more probe, not a page entry.
		expect(r.body.data.has_more).toBe(true);
		expect(r.body.data.launches).toHaveLength(1);
		const [first] = r.body.data.launches;
		expect(first.lane).toBe('native');
		// cf-ipfs.com stopped resolving in 2024, so a stored URL on it has to be
		// rewritten onto a live gateway before it reaches a client.
		expect(first.metadata_uri).toBe('https://dweb.link/ipfs/bafkreiabc');
		expect(first.agent).toEqual({
			id: 'agent-1',
			name: 'Scout',
			url: '/agents/agent-1',
			avatar_thumbnail_url: 'https://cdn.test/thumbs/a.png',
		});

		dbRows.native_launches = [dbRows.native_launches[1]];
		const priv = await call('launches', { query: { network: 'devnet' } });
		expect(priv.body.data.launches[0].agent.avatar_thumbnail_url).toBeNull();
	});
});
