// Behavioural cover for api/agents/_id/_sub.js.
//
// That module is not a route: the underscore prefix makes it unreachable by the
// filesystem router on purpose, and every one of its handlers is reached only by
// the dispatcher in api/agents/[id].js. The tests that mentioned it before this
// file read its SOURCE TEXT (tests/agent-animation-slots.test.js,
// tests/agent-choreography-wiring.test.js) to assert that certain strings appear
// in it, which cannot catch a handler that returns the wrong status or leaks
// another user's data. This file runs the handlers.
//
// What it pins, per handler, is the main path plus the failure that matters:
//
//   handleManifest     public contract every embed and SDK reads. A malformed id
//                      is a 400 and a missing agent a 404, never a half-built
//                      manifest, because consumers cache what they get.
//   handleEmbedPolicy  GET is deliberately fail-open (a public embed booting on
//                      an agent with no policy must not log a 404 every load),
//                      while a write without a session is a 401.
//   handleActions      the signed action log is owner-only: a signed-in stranger
//                      gets 403, not somebody else's ledger.
//   handleMemories     anonymous GET answers an empty list rather than 401 (same
//                      embed-console reasoning), but writing still needs a user.
//
// DB, auth, CSRF, limiter, avatar resolution and R2 are mocked so the suite runs
// offline; the schema validation, the response shapes and the branching are real.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeReq, makeRes } from '../_helpers/monetization.js';

const AGENT_ID = '00000000-0000-4000-8000-0000000000a1';
const OWNER_ID = 'user-owner';
const STRANGER_ID = 'user-stranger';

// Content-addressed SQL mock: classify by query text, so call order is free.
let agentRow = null;
let actionRows = [];
let memoryRows = [];
const calls = [];

const sqlMock = vi.fn((strings, ...values) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);
	calls.push({ q, values });
	if (/from agent_identities/i.test(q)) return Promise.resolve(agentRow ? [agentRow] : []);
	if (/from agent_actions/i.test(q)) return Promise.resolve(actionRows);
	if (/from agent_memories/i.test(q)) return Promise.resolve(memoryRows);
	if (/from agent_activations/i.test(q)) return Promise.resolve([]);
	if (/update agent_identities/i.test(q)) return Promise.resolve([{ embed_policy: null }]);
	return Promise.resolve([]);
});
sqlMock.transaction = (queries) => Promise.all(queries);
vi.mock('../../api/_lib/db.js', () => ({
	sql: sqlMock,
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

let sessionUser = null;
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => sessionUser),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

vi.mock('../../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		authIp: vi.fn(async () => ({ success: true, reset: Date.now() + 1000, limit: 60, remaining: 59 })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

let storedPolicy = null;
vi.mock('../../api/_lib/embed-policy.js', () => ({
	readEmbedPolicy: vi.fn(async () => storedPolicy),
	validateEmbedPolicy: vi.fn((p) => p),
}));

vi.mock('../../api/_lib/avatars.js', () => ({
	resolveAvatarUrl: vi.fn(async () => ({ url: 'https://cdn.example/agent.glb' })),
}));

vi.mock('../../api/_lib/r2.js', () => ({ publicUrl: vi.fn((k) => `https://cdn.example/${k}`) }));

vi.mock('../../api/_lib/agent-wallet.js', () => ({ recoverAgentKey: vi.fn(async () => null) }));

const sub = await import('../../api/agents/_id/_sub.js');

function ownedAgent(overrides = {}) {
	return {
		id: AGENT_ID,
		user_id: OWNER_ID,
		name: 'Probe Agent',
		description: 'An agent used by the sub-resource tests.',
		wallet_address: null,
		avatar_id: null,
		avatar_db_id: null,
		storage_key: null,
		thumbnail_key: null,
		content_type: null,
		skills: ['chat'],
		meta: {},
		chain_id: null,
		erc8004_agent_id: null,
		erc8004_registry: null,
		registration_cid: null,
		created_at: new Date('2026-01-01T00:00:00Z'),
		voice_provider: null,
		voice_id: null,
		persona_prompt_hash: null,
		persona_tone_tags: null,
		persona_extracted_at: null,
		...overrides,
	};
}

async function run(handler, { method = 'GET', url = '/', body = null, id = AGENT_ID, extra } = {}) {
	const req = makeReq({ method, url, body });
	const res = makeRes();
	await handler(req, res, id, extra);
	return { res, json: res.body ? JSON.parse(res.body) : null };
}

beforeEach(() => {
	sessionUser = null;
	agentRow = null;
	actionRows = [];
	memoryRows = [];
	storedPolicy = null;
	calls.length = 0;
});

describe('_sub.js handleManifest', () => {
	it('serves the public manifest for a live agent', async () => {
		agentRow = ownedAgent();
		const { res, json } = await run(sub.handleManifest, {
			url: `/api/agents/${AGENT_ID}/manifest`,
		});
		expect(res.statusCode).toBe(200);
		expect(json.spec).toBe('agent-manifest/0.1');
		expect(json.id).toBe(AGENT_ID);
		expect(json.name).toBe('Probe Agent');
		expect(json.skills).toEqual(['chat']);
		expect(json.homeUrl).toContain(`/agent/${AGENT_ID}`);
		// No voice row configured: the manifest still names a provider so an embed
		// always has something to fall back to.
		expect(json.voice.provider).toBe('browser');
		expect(json.registrations).toEqual([]);
		// Public document: cacheable and readable cross-origin.
		expect(res.headers['access-control-allow-origin']).toBe('*');
		expect(res.headers['cache-control']).toContain('max-age');
	});

	it('404s for an agent that does not exist rather than emitting a hollow manifest', async () => {
		agentRow = null;
		const { res, json } = await run(sub.handleManifest, {
			url: `/api/agents/${AGENT_ID}/manifest`,
		});
		expect(res.statusCode).toBe(404);
		expect(json.error).toBe('not_found');
	});

	it('400s on an id that is not a uuid, before touching the database', async () => {
		const { res, json } = await run(sub.handleManifest, {
			url: '/api/agents/not-a-uuid/manifest',
			id: 'not-a-uuid',
		});
		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('invalid_request');
		expect(calls).toHaveLength(0);
	});
});

describe('_sub.js handleEmbedPolicy', () => {
	it('fails open on GET so a public embed boot never logs a 404', async () => {
		storedPolicy = null;
		const { res, json } = await run(sub.handleEmbedPolicy, {
			url: `/api/agents/${AGENT_ID}/embed-policy`,
		});
		expect(res.statusCode).toBe(200);
		expect(json.policy).toBeNull();
	});

	it('returns the stored policy when the agent has one', async () => {
		storedPolicy = { surfaces: ['web'], origins: ['https://example.com'] };
		const { res, json } = await run(sub.handleEmbedPolicy, {
			url: `/api/agents/${AGENT_ID}/embed-policy`,
		});
		expect(res.statusCode).toBe(200);
		expect(json.policy).toEqual(storedPolicy);
	});

	it('401s an unauthenticated write', async () => {
		sessionUser = null;
		const { res, json } = await run(sub.handleEmbedPolicy, {
			method: 'PUT',
			url: `/api/agents/${AGENT_ID}/embed-policy`,
			body: { surfaces: ['web'] },
		});
		expect(res.statusCode).toBe(401);
		expect(json.error).toBe('unauthorized');
	});

	it('403s a signed-in stranger writing another owner policy', async () => {
		sessionUser = { id: STRANGER_ID };
		agentRow = ownedAgent();
		const { res, json } = await run(sub.handleEmbedPolicy, {
			method: 'PUT',
			url: `/api/agents/${AGENT_ID}/embed-policy`,
			body: { surfaces: ['web'] },
		});
		expect(res.statusCode).toBe(403);
		expect(json.error).toBe('forbidden');
	});
});

describe('_sub.js handleActions', () => {
	it('returns the owner signed action log', async () => {
		sessionUser = { id: OWNER_ID };
		agentRow = { id: AGENT_ID, user_id: OWNER_ID, name: 'Probe Agent', wallet_address: null };
		actionRows = [
			{
				id: 7,
				type: 'trade',
				payload: { pair: 'SOL/USDC' },
				source_skill: 'trade',
				signature: null,
				signer_address: null,
				created_at: new Date('2026-02-02T00:00:00Z'),
			},
		];
		const { res, json } = await run(sub.handleActions, {
			url: `/api/agents/${AGENT_ID}/actions`,
		});
		expect(res.statusCode).toBe(200);
		expect(json.actions).toHaveLength(1);
		expect(json.actions[0].id).toBe('7');
		expect(json.actions[0].sourceSkill).toBe('trade');
		// Unsigned rows report `verified: null`, never a bare `false` that would
		// read as "signature checked and rejected".
		expect(json.actions[0].verified).toBeNull();
		expect(json.nextCursor).toBeNull();
	});

	it('403s a signed-in stranger instead of serving another agent ledger', async () => {
		sessionUser = { id: STRANGER_ID };
		agentRow = { id: AGENT_ID, user_id: OWNER_ID, name: 'Probe Agent', wallet_address: null };
		const { res, json } = await run(sub.handleActions, {
			url: `/api/agents/${AGENT_ID}/actions`,
		});
		expect(res.statusCode).toBe(403);
		expect(json.error).toBe('forbidden');
		// The ledger query never ran.
		expect(calls.some((c) => /from agent_actions/i.test(c.q))).toBe(false);
	});
});

describe('_sub.js handleMemories', () => {
	it('answers an anonymous GET with an empty list, not a 401', async () => {
		sessionUser = null;
		const { res, json } = await run(sub.handleMemories, {
			url: `/api/agents/${AGENT_ID}/memories`,
		});
		expect(res.statusCode).toBe(200);
		expect(json.data).toEqual([]);
	});

	it('401s an anonymous write', async () => {
		sessionUser = null;
		const { res, json } = await run(sub.handleMemories, {
			method: 'POST',
			url: `/api/agents/${AGENT_ID}/memories`,
			body: { type: 'reference', content: 'remember this' },
		});
		expect(res.statusCode).toBe(401);
		expect(json.error).toBe('unauthorized');
	});

	it('requires a memory id to delete', async () => {
		sessionUser = { id: OWNER_ID };
		agentRow = { id: AGENT_ID };
		const { res, json } = await run(sub.handleMemories, {
			method: 'DELETE',
			url: `/api/agents/${AGENT_ID}/memories`,
		});
		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('bad_request');
	});
});
