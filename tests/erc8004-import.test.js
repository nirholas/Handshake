// POST /api/erc8004/import: pulling an ERC-8004 agent the caller already owns
// on-chain into their three.ws account.
//
// Three properties are pinned here, each of them a bug this endpoint shipped:
//
//  1. An unreachable registration manifest must NOT block the import. The
//     handler treated ANY `resolved.error` as fatal and answered 400, so a
//     throttled ipfs.io gateway locked owners out of agents whose registry read
//     had already succeeded. The row only needs a name, and there is an on-chain
//     fallback for that.
//  2. Ownership is re-checked against the LIVE registry answer. The index row is
//     crawler state and goes stale, so an agent transferred after the last crawl
//     would otherwise still import for its former owner.
//  3. A chain-read failure answers 502 with a fixed message. The old code echoed
//     the raw upstream text, which on an Alchemy-backed chain embeds the keyed
//     provider URL (…g.alchemy.com/v2/<key>) straight into the response body.
//
// I/O is mocked at the module seams (db.js, auth.js, onchain.js): the test never
// touches a real database or RPC endpoint.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const CHAIN_ID = 8453;
const AGENT_ID = '4242';
// Synthetic EVM addresses; nothing is ever sent to them.
const OWNER = '0x00000000000000000000000000000000000000a1';
const OTHER = '0x00000000000000000000000000000000000000b2';

let indexOwner = OWNER;
let userWallets = [OWNER];
let alreadyImported = false;
const statements = [];

function sqlMock(strings, ...values) {
	const text = strings.join('?');
	statements.push({ text, values });
	if (text.includes('FROM agent_identities')) {
		return Promise.resolve(alreadyImported ? [{ id: 'existing-row' }] : []);
	}
	if (text.includes('FROM erc8004_agents_index')) {
		return Promise.resolve([{ owner: indexOwner, agent_uri: 'ipfs://bafyagentmanifest' }]);
	}
	if (text.includes('FROM user_wallets')) {
		return Promise.resolve(userWallets.map((address) => ({ address })));
	}
	if (text.includes('INSERT INTO agent_identities')) {
		return Promise.resolve([{ id: 'new-agent-row' }]);
	}
	return Promise.resolve([]);
}
vi.mock('../api/_lib/db.js', () => ({ sql: sqlMock, isDbUnavailableError: () => false, isDbCapacityError: () => false, isStoragePressured: async () => ({ pressured: false }) }));

vi.mock('../api/_lib/auth.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, getSessionUser: async () => ({ id: 'user-1' }) };
});

vi.mock('../api/_lib/rate-limit.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		clientIp: () => '203.0.113.9',
		limits: { ...actual.limits, authIp: async () => ({ success: true }) },
	};
});

let resolveResult = null;
let resolveThrows = null;
vi.mock('../api/_lib/onchain.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		resolveOnChainAgent: async () => {
			if (resolveThrows) throw resolveThrows;
			return resolveResult;
		},
	};
});

const handler = (await import('../api/erc8004/[action].js')).default;

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		removeHeader(k) {
			delete this.headers[k.toLowerCase()];
		},
		writeHead(code) {
			this.statusCode = code;
			return this;
		},
		end(payload) {
			if (payload !== undefined && this.body === null) this.body = payload;
			this.finished = true;
			return this;
		},
	};
}

async function importAgent(body = { chainId: CHAIN_ID, agentId: AGENT_ID }) {
	const res = makeRes();
	await handler(
		{
			method: 'POST',
			url: '/api/erc8004/import',
			headers: { 'content-type': 'application/json' },
			query: { action: 'import' },
			body,
		},
		res,
	);
	let parsed = null;
	try {
		parsed = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
	} catch {
		parsed = res.body;
	}
	return { status: res.statusCode, body: parsed };
}

// The shape resolveOnChainAgent returns when the registry read succeeded.
function resolvedAgent(overrides = {}) {
	return {
		chainId: CHAIN_ID,
		agentId: AGENT_ID,
		owner: OWNER,
		name: 'Courier',
		description: 'A delivery agent',
		image: 'https://cdn.example/agent.png',
		bodyURI: null,
		error: null,
		...overrides,
	};
}

beforeEach(() => {
	statements.length = 0;
	indexOwner = OWNER;
	userWallets = [OWNER];
	alreadyImported = false;
	resolveResult = resolvedAgent();
	resolveThrows = null;
});

describe('POST /api/erc8004/import', () => {
	it('imports an owned agent and returns the new row', async () => {
		const { status, body } = await importAgent();
		expect(status).toBe(201);
		expect(body.agent).toMatchObject({
			id: 'new-agent-row',
			erc8004_agent_id: AGENT_ID,
			erc8004_agent_id_chain_id: CHAIN_ID,
			name: 'Courier',
		});
		expect(statements.some((s) => s.text.includes('INSERT INTO agent_identities'))).toBe(true);
	});

	it('still imports when the registration manifest could not be fetched', async () => {
		// Registry read fine, off-chain manifest host down: the agent exists and is
		// owned, so the import proceeds with the on-chain fallback name.
		resolveResult = resolvedAgent({
			name: null,
			description: null,
			image: null,
			error: 'manifest_fetch: fetch failed',
		});
		const { status, body } = await importAgent();
		expect(status).toBe(201);
		expect(body.agent.name).toBe(`Agent #${AGENT_ID}`);
	});

	it('rejects the former owner when the index row is stale', async () => {
		// The crawler still lists this wallet as owner, but the live registry says
		// the agent was transferred away.
		resolveResult = resolvedAgent({ owner: OTHER });
		const { status, body } = await importAgent();
		expect(status).toBe(403);
		expect(body.error).toBe('forbidden');
		expect(statements.some((s) => s.text.includes('INSERT INTO agent_identities'))).toBe(false);
	});

	it('rejects a wallet that never owned the agent', async () => {
		indexOwner = OTHER;
		const { status, body } = await importAgent();
		expect(status).toBe(403);
		expect(body.error).toBe('forbidden');
	});

	it('answers 502 without echoing the keyed RPC URL when the chain read fails', async () => {
		resolveResult = resolvedAgent({
			owner: null,
			error: 'chain_read: could not reach https://base-mainnet.g.alchemy.com/v2/SUPERSECRETKEY',
		});
		const { status, body } = await importAgent();
		expect(status).toBe(502);
		expect(body.error).toBe('resolve_failed');
		expect(JSON.stringify(body)).not.toContain('SUPERSECRETKEY');
		expect(JSON.stringify(body)).not.toContain('alchemy');
	});

	it('answers 502 without echoing the message when the resolver throws', async () => {
		resolveThrows = new Error('connect ECONNREFUSED https://base-mainnet.g.alchemy.com/v2/SUPERSECRETKEY');
		const { status, body } = await importAgent();
		expect(status).toBe(502);
		expect(body.error).toBe('resolve_failed');
		expect(JSON.stringify(body)).not.toContain('SUPERSECRETKEY');
	});

	it('refuses a second import of the same agent', async () => {
		alreadyImported = true;
		const { status, body } = await importAgent();
		expect(status).toBe(409);
		expect(body.error).toBe('conflict');
	});

	it('rejects an unsupported chain before touching the database', async () => {
		const { status, body } = await importAgent({ chainId: 999_999, agentId: AGENT_ID });
		expect(status).toBe(400);
		expect(body.error_description).toContain('unsupported chain');
		expect(statements).toHaveLength(0);
	});

	it('rejects a non-numeric agentId', async () => {
		const { status } = await importAgent({ chainId: CHAIN_ID, agentId: 'not-a-number' });
		expect(status).toBe(400);
	});
});
