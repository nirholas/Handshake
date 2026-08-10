// api/agents/sns.js, the .sol domain surface for an agent identity.
//
// Reached only through the dispatcher: /api/agents/:id/sns[/...] ->
// api/agents/[id].js -> this module. /api/agents/sns is swallowed by the
// /api/agents/([^/]+) catch-all, so these tests invoke the handler the same way
// the dispatcher does, with (req, res, id, action).
//
// Bonfida is a real upstream HTTP API and the registry read is a real on-chain
// lookup, so both are stubbed at their module / fetch boundary. Everything else
// (domain normalization, ownership resolution, meta writes) runs for real.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { Keypair } from '@solana/web3.js';

const AGENT_ADDR = Keypair.generate().publicKey.toBase58();
const LINKED_ADDR = Keypair.generate().publicKey.toBase58();

const authState = { session: null };
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

vi.mock('../../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));

const sqlState = { agent: null, linked: [], writes: [] };
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...vals) => {
		const q = (typeof strings === 'string' ? strings : strings.join('?')).toLowerCase();
		if (/update agent_identities/.test(q)) {
			sqlState.writes.push(JSON.parse(vals[0]));
			return [];
		}
		if (/from user_wallets/.test(q)) return sqlState.linked;
		if (/from agent_identities/.test(q)) return sqlState.agent ? [sqlState.agent] : [];
		return [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: true })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../api/_lib/execution-engine.js', () => ({
	submitProtected: vi.fn(async () => ({ signature: 'SIG'.padEnd(88, 'x') })),
}));

vi.mock('../../api/_lib/agent-pumpfun.js', () => ({
	loadAgentForSigning: vi.fn(async () => ({ error: { status: 409, code: 'conflict', msg: 'no keypair' } })),
	solanaConnection: vi.fn(() => ({})),
}));

const registryState = { owner: null };
vi.mock('@bonfida/spl-name-service', () => ({
	getDomainKeySync: vi.fn(() => ({ pubkey: 'PK' })),
	NameRegistryState: {
		retrieve: vi.fn(async () => {
			if (!registryState.owner) throw new Error('account not found');
			return { registry: { owner: { toBase58: () => registryState.owner } } };
		}),
	},
	registerDomainNameV2: vi.fn(async () => []),
}));

const { default: handler } = await import('../../api/agents/sns.js');

const AGENT_ID = '11111111-2222-4333-8444-666666666666';

const fetchState = { byAddress: {}, favByAddress: {}, fail: false };
beforeEach(() => {
	authState.session = { id: 'owner-1' };
	sqlState.agent = { id: AGENT_ID, user_id: 'owner-1', meta: { solana_address: AGENT_ADDR } };
	sqlState.linked = [];
	sqlState.writes = [];
	registryState.owner = null;
	fetchState.byAddress = {};
	fetchState.favByAddress = {};
	fetchState.fail = false;

	vi.stubGlobal('fetch', vi.fn(async (url) => {
		if (fetchState.fail) return { ok: false, status: 503, json: async () => ({}) };
		const u = String(url);
		const address = u.split('/').pop();
		if (u.includes('/fav-domains/')) {
			return { ok: true, status: 200, json: async () => ({ [address]: fetchState.favByAddress[address] ?? null }) };
		}
		return { ok: true, status: 200, json: async () => ({ [address]: fetchState.byAddress[address] ?? [] }) };
	}));
});

function makeReq(method, { body = null, url = `/api/agents/${AGENT_ID}/sns` } = {}) {
	const req = Readable.from(body === null ? [] : [Buffer.from(JSON.stringify(body))]);
	req.method = method;
	req.url = url;
	req.headers = { host: 'localhost', 'content-type': 'application/json', origin: 'http://localhost' };
	return req;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(c) { if (c !== undefined) this.body += c; this.writableEnded = true; },
	};
}

async function invoke(method, { action, ...opts } = {}) {
	const res = makeRes();
	await handler(makeReq(method, opts), res, AGENT_ID, action);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

describe('GET /api/agents/:id/sns', () => {
	it('lists the domains the agent wallet owns plus its favorite', async () => {
		fetchState.byAddress[AGENT_ADDR] = ['nova', 'oracle'];
		fetchState.favByAddress[AGENT_ADDR] = 'nova';

		const { status, body } = await invoke('GET');
		expect(status).toBe(200);
		expect(body.data.address).toBe(AGENT_ADDR);
		expect(body.data.domains).toEqual(['nova', 'oracle']);
		expect(body.data.favorite).toBe('nova');
		expect(body.data.sns_domain).toBeNull();
		expect(body.data.upstream_ok).toBe(true);
		expect(body.data.modes).toEqual({ agent_pays: true, user_pays: true });
	});

	it('degrades to an empty list, flagged, when Bonfida is down', async () => {
		fetchState.fail = true;
		const { status, body } = await invoke('GET');
		expect(status).toBe(200);
		expect(body.data.upstream_ok).toBe(false);
		expect(body.data.domains).toEqual([]);
	});

	it('rejects an unauthenticated caller', async () => {
		authState.session = null;
		expect((await invoke('GET')).status).toBe(401);
	});

	it('rejects a caller who does not own the agent', async () => {
		sqlState.agent = { ...sqlState.agent, user_id: 'someone-else' };
		expect((await invoke('GET')).status).toBe(403);
	});

	it('404s an agent that does not exist', async () => {
		sqlState.agent = null;
		expect((await invoke('GET')).status).toBe(404);
	});

	it('409s an agent with no Solana wallet yet', async () => {
		sqlState.agent = { ...sqlState.agent, meta: {} };
		const { status, body } = await invoke('GET');
		expect(status).toBe(409);
		expect(body.error_description).toMatch(/provision one first/);
	});
});

describe('POST /api/agents/:id/sns (attach)', () => {
	it('attaches a domain the agent wallet owns', async () => {
		fetchState.byAddress[AGENT_ADDR] = ['nova'];
		const { status, body } = await invoke('POST', { body: { domain: 'Nova.sol' } });
		expect(status).toBe(200);
		expect(body.data).toMatchObject({ ok: true, sns_domain: 'nova', owner: AGENT_ADDR });
		expect(sqlState.writes[0].sns_domain).toBe('nova');
		// Owned by the agent itself, so no separate owner wallet is recorded.
		expect(sqlState.writes[0].sns_owner_wallet).toBeUndefined();
	});

	it('accepts a domain owned by a Solana wallet linked to the caller', async () => {
		sqlState.linked = [{ address: LINKED_ADDR }];
		fetchState.byAddress[LINKED_ADDR] = ['nova'];
		const { status, body } = await invoke('POST', { body: { domain: 'nova' } });
		expect(status).toBe(200);
		expect(body.data.owner).toBe(LINKED_ADDR);
		expect(sqlState.writes[0].sns_owner_wallet).toBe(LINKED_ADDR);
	});

	it('refuses a domain no candidate wallet owns', async () => {
		fetchState.byAddress[AGENT_ADDR] = ['other'];
		const { status, body } = await invoke('POST', { body: { domain: 'nova' } });
		expect(status).toBe(403);
		expect(body.error_description).toMatch(/not owned/);
		expect(sqlState.writes).toHaveLength(0);
	});

	it('rejects a malformed domain', async () => {
		const { status, body } = await invoke('POST', { body: { domain: 'not a domain!' } });
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});
});

describe('DELETE /api/agents/:id/sns', () => {
	it('clears the attached domain and its owner wallet', async () => {
		sqlState.agent = {
			...sqlState.agent,
			meta: { solana_address: AGENT_ADDR, sns_domain: 'nova', sns_owner_wallet: LINKED_ADDR },
		};
		const { status, body } = await invoke('DELETE');
		expect(status).toBe(200);
		expect(body.data.sns_domain).toBeNull();
		expect(sqlState.writes[0].sns_domain).toBeUndefined();
		expect(sqlState.writes[0].sns_owner_wallet).toBeUndefined();
	});
});

describe('GET /api/agents/:id/sns/check', () => {
	it('reports an unregistered domain as available with its price', async () => {
		const { status, body } = await invoke('GET', { action: 'check', url: '/api/agents/x/sns/check?domain=nova' });
		expect(status).toBe(200);
		expect(body.data).toMatchObject({ domain: 'nova', available: true, owner: null, length: 4 });
		expect(body.data.price_usdc).toBe(160);
	});

	it('reports a registered domain as taken', async () => {
		registryState.owner = LINKED_ADDR;
		const { status, body } = await invoke('GET', { action: 'check', url: '/api/agents/x/sns/check?domain=nova' });
		expect(status).toBe(200);
		expect(body.data.available).toBe(false);
		expect(body.data.owner).toBe(LINKED_ADDR);
	});

	it('rejects a check with no domain', async () => {
		const { status, body } = await invoke('GET', { action: 'check', url: '/api/agents/x/sns/check' });
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
	});
});

describe('POST /api/agents/:id/sns/register-prep', () => {
	it('refuses a wallet that is not linked to the caller', async () => {
		const { status, body } = await invoke('POST', {
			action: 'register-prep',
			url: '/api/agents/x/sns/register-prep',
			body: { domain: 'nova', wallet_address: LINKED_ADDR },
		});
		expect(status).toBe(403);
		expect(body.error_description).toMatch(/not linked/);
	});

	it('rejects a missing wallet address', async () => {
		const { status, body } = await invoke('POST', {
			action: 'register-prep',
			url: '/api/agents/x/sns/register-prep',
			body: { domain: 'nova' },
		});
		expect(status).toBe(400);
		expect(body.error_description).toMatch(/wallet_address/);
	});
});
