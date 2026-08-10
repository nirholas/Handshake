// POST /api/agents/:id/brain/import: the merge must be idempotent.
//
// The regression this file exists to stop. A merge dedupes an incoming bundle
// entry against the target agent's stored memories by content hash, but a
// memory's `content_hash` is the digest of THAT ROW, and memoryDigest folds in
// the row id and created_at. An imported copy is therefore a different row with
// a different hash than the bundle entry it came from, so re-importing the same
// bundle matched nothing and inserted a fresh duplicate of every memory. Run a
// sync twice and the agent's mind doubled; run it in a loop and it grew without
// bound, while the response cheerfully reported `duplicates: 0`.
//
// The fix records the digest actually matched on in the row's provenance and
// dedupes against both keys. The tests below import the same bundle three times
// and require the second and third to insert nothing.
//
// The bundle itself is real (built by api/_lib/brain-bundle.js and verified by
// its own verifyBundle) so the integrity gates the handler runs before importing
// are exercised rather than stubbed. Only the DB, auth, CSRF and the custodial
// key vault are mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeReq, makeRes } from '../_helpers/monetization.js';

const AGENT_ID = '00000000-0000-4000-8000-0000000000b1';
const SOURCE_AGENT_ID = '00000000-0000-4000-8000-0000000000b2';
const OWNER_ID = 'user-owner';

// A tiny in-memory stand-in for agent_memories, so "did the second import insert
// a row?" is answerable rather than inferred from the response body alone.
let stored = [];
let agentRow = null;

const sqlMock = vi.fn((strings, ...values) => {
	const q = Array.isArray(strings) ? strings.join(' ') : String(strings);

	if (/from agent_identities/i.test(q)) return Promise.resolve(agentRow ? [agentRow] : []);
	if (/update agent_identities/i.test(q)) return Promise.resolve([]);

	// The dedupe read: both the row's own hash and the provenance source hash.
	if (/select content_hash/i.test(q)) {
		return Promise.resolve(
			stored.map((r) => ({ content_hash: r.content_hash, source_hash: r.source_hash })),
		);
	}
	if (/delete from agent_memories/i.test(q)) {
		stored = [];
		return Promise.resolve([]);
	}
	if (/insert into agent_memories/i.test(q)) {
		// values: agent_id, type, content, tags, context, salience, tier, is_public
		const [, type, content, tags, contextJson] = values;
		const provenance = JSON.parse(contextJson).provenance || {};
		const row = {
			id: `row-${stored.length + 1}`,
			agent_id: AGENT_ID,
			type,
			content,
			tags,
			created_at: new Date('2026-03-03T00:00:00Z'),
			// Mirrors production: content_hash is only written later, by the
			// best-effort re-sign, and it is the NEW row's digest, not the source's.
			content_hash: `local-digest-${stored.length + 1}`,
			source_hash: provenance.source_content_hash ?? null,
		};
		stored.push(row);
		return Promise.resolve([row]);
	}
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

// The custodial key vault is not reachable offline; an agent with no wallet is
// also the case that exposed the bug, since unsigned rows are the ones whose
// content_hash never matches the bundle.
vi.mock('../../api/_lib/brain-sign.js', async (importOriginal) => ({
	...(await importOriginal()),
	loadAgentSigner: vi.fn(async () => null),
	signMemoryWithAgent: vi.fn(async () => ({ content_hash: null, signature: null })),
}));

vi.mock('../../api/_lib/brain-anchor.js', () => ({
	anchorBrain: vi.fn(async () => {
		throw new Error('not used');
	}),
	latestAnchor: vi.fn(async () => ({ anchor: null, currentBrainHash: null, inSync: false })),
	BrainAnchorError: class BrainAnchorError extends Error {},
}));

// Imported after the mocks: brain-bundle pulls in brain-sign, which pulls in the
// db module, and a static import would evaluate that chain before the factories
// above exist.
const { buildBundle, buildMemoryEntry } = await import('../../api/_lib/brain-bundle.js');
const { handleBrain } = await import('../../api/agents/_id/brain.js');

async function makeSourceBundle() {
	const rows = [
		{
			id: '11111111-1111-4111-8111-111111111111',
			agent_id: SOURCE_AGENT_ID,
			type: 'reference',
			content: 'Solana is the home chain.',
			tags: ['audit'],
			salience: 0.5,
			tier: 'recall',
			is_public: true,
			content_hash: null,
			signature: null,
			signer_address: null,
			signed_at: null,
			created_at: new Date('2026-02-02T00:00:00Z'),
		},
		{
			id: '22222222-2222-4222-8222-222222222222',
			agent_id: SOURCE_AGENT_ID,
			type: 'project',
			content: 'The promoted coin is $THREE.',
			tags: ['audit'],
			salience: 0.6,
			tier: 'recall',
			is_public: true,
			content_hash: null,
			signature: null,
			signer_address: null,
			signed_at: null,
			created_at: new Date('2026-02-02T00:01:00Z'),
		},
	];
	return buildBundle({
		agent: { id: SOURCE_AGENT_ID, name: 'Source Agent', description: '', avatar_id: null },
		persona: null,
		memoryEntries: rows.map((r) => buildMemoryEntry(r)),
		anchor: null,
		exportedAt: '2026-02-03T00:00:00.000Z',
		signerPrivKey: null,
	});
}

async function importBundle(bundle, strategy = 'merge') {
	const req = makeReq({
		method: 'POST',
		url: `/api/agents/${AGENT_ID}/brain/import`,
		body: { bundle, strategy },
	});
	const res = makeRes();
	await handleBrain(req, res, AGENT_ID, 'import');
	return { res, json: res.body ? JSON.parse(res.body) : null };
}

beforeEach(() => {
	stored = [];
	sessionUser = { id: OWNER_ID };
	agentRow = {
		id: AGENT_ID,
		user_id: OWNER_ID,
		name: 'Target Agent',
		wallet_address: null,
		memory_storage_mode: 'local',
		persona_prompt_hash: null,
		meta: {},
	};
});

describe('brain import merge', () => {
	it('imports every memory the first time', async () => {
		const bundle = await makeSourceBundle();
		const { res, json } = await importBundle(bundle);
		expect(res.statusCode).toBe(200);
		expect(json.imported).toBe(2);
		expect(json.duplicates).toBe(0);
		expect(stored).toHaveLength(2);
	});

	it('is idempotent: re-importing the same bundle inserts nothing', async () => {
		const bundle = await makeSourceBundle();
		await importBundle(bundle);
		const second = await importBundle(bundle);
		expect(second.res.statusCode).toBe(200);
		expect(second.json.imported).toBe(0);
		expect(second.json.duplicates).toBe(2);
		expect(stored).toHaveLength(2);

		const third = await importBundle(bundle);
		expect(third.json.imported).toBe(0);
		expect(stored).toHaveLength(2);
	});

	it('records the matched digest in provenance so the next import can match it', async () => {
		const bundle = await makeSourceBundle();
		await importBundle(bundle);
		// Every row carries a source hash, and it is the bundle entry's hash, not
		// the local row digest that the re-sign writes.
		for (const row of stored) {
			expect(row.source_hash).toMatch(/^[a-f0-9]{64}$/);
			expect(row.source_hash).not.toBe(row.content_hash);
		}
		const bundleHashes = bundle.memories.map((m) => m.content_hash.toLowerCase()).sort();
		expect(stored.map((r) => r.source_hash).sort()).toEqual(bundleHashes);
	});

	it('rejects a bundle whose brain_hash does not match its memory set', async () => {
		// brain_hash content-addresses the memory hash list, so swapping a memory in
		// or out after export breaks it. Nothing may be written on a failed gate.
		const bundle = await makeSourceBundle();
		bundle.memories.pop();
		const { res, json } = await importBundle(bundle);
		expect(res.statusCode).toBe(422);
		expect(json.error).toBe('integrity_failed');
		expect(stored).toHaveLength(0);
	});

	it('rejects a bundle that fails its own schema before touching the database', async () => {
		// parse() throws a 400-tagged error that wrap() in api/agents/[id].js turns
		// into the {error: validation_error} 400 the endpoint serves. What matters
		// here is that the throw happens before any write.
		await expect(importBundle({ version: 'brain/1' })).rejects.toMatchObject({
			status: 400,
			code: 'validation_error',
		});
		expect(stored).toHaveLength(0);
	});
});
