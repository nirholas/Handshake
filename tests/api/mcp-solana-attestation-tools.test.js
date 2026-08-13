// Solana attestation MCP tools (api/_mcp/tools/solana.js), registered in
// api/_mcp/catalog.js and re-used by api/_lib/persona-wallet.js through the
// exported solanaReputation().
//
// Verifies: a cold agent is crawled once before its first read and a warm agent
// is never re-crawled; a crawl fault degrades to the cached (empty) index
// instead of failing the tool; reputation rounds its score averages and keeps
// the verified-only average separate from the raw one; the attestation list
// honors the kind filter through KIND_MAP and passes "all" straight through;
// and the passport answers for an agent that is not in our identity index
// (agent_off_index) rather than throwing. The DB and the chain crawler are
// mocked at their module boundary; the tool defs run real.

import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.PUBLIC_APP_ORIGIN ||= 'https://three.ws';

const ASSET = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

const dbState = {
	cursor: [{ '?column?': 1 }],
	agent: [],
	feedback: [{ total: 0, verified: 0, disputed: 0, score_avg: 0, score_avg_verified: 0 }],
	validation: [{ passed: 0, failed: 0 }],
	attestations: [],
	queries: [],
};

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		const q = strings.join('?');
		dbState.queries.push({ q, values });
		if (q.includes('solana_attestations_cursor')) return dbState.cursor;
		if (q.includes('from agent_identities')) return dbState.agent;
		if (q.includes('with feedback as')) return dbState.feedback;
		if (q.includes('threews.validation.v1')) return dbState.validation;
		if (q.includes('select signature, slot')) return dbState.attestations;
		throw new Error(`unexpected query: ${q}`);
	}),
}));

const crawlMock = vi.fn(async () => ({ inserted: 0 }));
vi.mock('../../api/_lib/solana-attestations.js', () => ({
	crawlAgentAttestations: (...a) => crawlMock(...a),
	KIND_MAP: {
		feedback: 'threews.feedback.v1',
		validation: 'threews.validation.v1',
		task: 'threews.task.v1',
		accept: 'threews.accept.v1',
		revoke: 'threews.revoke.v1',
		dispute: 'threews.dispute.v1',
	},
}));

const { toolDefs, solanaReputation } = await import('../../api/_mcp/tools/solana.js');

const AUTH = { userId: null, rateKey: 'solana-test', scope: '', source: 'x402' };
const call = (name, args) => toolDefs.find((t) => t.name === name).handler(args, AUTH, {});

beforeEach(() => {
	dbState.cursor = [{ '?column?': 1 }];
	dbState.agent = [];
	dbState.feedback = [{ total: 0, verified: 0, disputed: 0, score_avg: 0, score_avg_verified: 0 }];
	dbState.validation = [{ passed: 0, failed: 0 }];
	dbState.attestations = [];
	dbState.queries = [];
	crawlMock.mockClear();
	crawlMock.mockResolvedValue({ inserted: 0 });
});

describe('solana attestation MCP tools: registration', () => {
	it('registers three public read tools with explicit non-destructive annotations', () => {
		expect(toolDefs.map((t) => t.name)).toEqual([
			'solana_agent_reputation',
			'solana_agent_attestations',
			'solana_agent_passport',
		]);
		for (const t of toolDefs) {
			expect(t.scope).toBeUndefined();
			expect(t.annotations).toEqual({
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			});
			expect(t.inputSchema.required).toEqual(['asset']);
		}
	});
});

describe('solana_agent_reputation', () => {
	it('rounds both score averages and keeps the verified average separate', async () => {
		dbState.feedback = [{
			total: 4, verified: 2, disputed: 1,
			score_avg: 3.666666666, score_avg_verified: 4.5,
		}];
		dbState.validation = [{ passed: 3, failed: 1 }];

		const r = await call('solana_agent_reputation', { asset: ASSET, network: 'mainnet' });
		expect(r.structuredContent).toEqual({
			agent: ASSET,
			network: 'mainnet',
			feedback: { total: 4, verified: 2, disputed: 1, score_avg: 3.667, score_avg_verified: 4.5 },
			validation: { passed: 3, failed: 1 },
		});
		expect(JSON.parse(r.content[0].text)).toEqual(r.structuredContent);
	});

	it('defaults to devnet and skips the crawl when the agent is already indexed', async () => {
		await call('solana_agent_reputation', { asset: ASSET });
		expect(crawlMock).not.toHaveBeenCalled();
		expect(dbState.queries.some((c) => c.values.includes('devnet'))).toBe(true);
	});

	it('crawls a cold agent once, seeding the owner wallet from our identity index', async () => {
		dbState.cursor = [];
		dbState.agent = [{ owner: 'OwnerWallet111' }];
		await call('solana_agent_reputation', { asset: ASSET, network: 'mainnet' });
		expect(crawlMock).toHaveBeenCalledWith({
			agentAsset: ASSET, network: 'mainnet', ownerWallet: 'OwnerWallet111',
		});
	});

	it('degrades to the cached index when the chain crawl fails', async () => {
		dbState.cursor = [];
		crawlMock.mockRejectedValue(new Error('RPC 429'));
		const r = await call('solana_agent_reputation', { asset: ASSET });
		expect(r.structuredContent.feedback.total).toBe(0);
		expect(r.isError).toBeUndefined();
	});

	it('is exported for reuse by the persona wallet surface', async () => {
		dbState.feedback = [{ total: 1, verified: 1, disputed: 0, score_avg: 5, score_avg_verified: 5 }];
		const rep = await solanaReputation(ASSET, 'mainnet');
		expect(rep.agent).toBe(ASSET);
		expect(rep.feedback.score_avg).toBe(5);
	});
});

describe('solana_agent_attestations', () => {
	it('maps a kind filter onto its on-chain schema id', async () => {
		dbState.attestations = [{ signature: 'sig1', slot: 10, kind: 'threews.feedback.v1', verified: true }];
		const r = await call('solana_agent_attestations', { asset: ASSET, kind: 'feedback', limit: 5, network: 'mainnet' });
		const rowQuery = dbState.queries.find((c) => c.q.includes('select signature, slot'));
		expect(rowQuery.values).toContain('threews.feedback.v1');
		expect(rowQuery.values).toContain(5);
		expect(r.structuredContent.count).toBe(1);
		expect(r.structuredContent.kind).toBe('feedback');
	});

	it('reads every kind when kind is "all" and defaults the limit', async () => {
		await call('solana_agent_attestations', { asset: ASSET });
		const rowQuery = dbState.queries.find((c) => c.q.includes('select signature, slot'));
		expect(rowQuery.values).not.toContain('threews.feedback.v1');
		expect(rowQuery.values).toContain(50);
	});

	it('returns an empty, non-error result for an agent with no attestations', async () => {
		const r = await call('solana_agent_attestations', { asset: ASSET, kind: 'dispute' });
		expect(r.isError).toBeUndefined();
		expect(r.structuredContent).toMatchObject({ agent: ASSET, count: 0, data: [] });
	});
});

describe('solana_agent_passport', () => {
	it('assembles identity, reputation, validation, and recent attestations', async () => {
		dbState.agent = [{
			id: 'agent-uuid', name: 'Three Agent', description: 'does things',
			owner: 'OwnerWallet111', meta: { network: 'mainnet' },
		}];
		dbState.feedback = [{ total: 2, verified: 1, disputed: 0, score_avg: 4, score_avg_verified: 5 }];
		dbState.validation = [{ passed: 1, failed: 0 }];
		dbState.attestations = [{ signature: 'sig1', slot: 11, kind: 'threews.feedback.v1' }];

		const r = await call('solana_agent_passport', { asset: ASSET, network: 'mainnet' });
		expect(r.structuredContent.identity).toEqual({
			id: 'agent-uuid', name: 'Three Agent', description: 'does things',
			owner: 'OwnerWallet111', asset_pubkey: ASSET, network: 'mainnet',
		});
		expect(r.structuredContent.reputation.score_avg).toBe(4);
		expect(r.structuredContent.validation).toEqual({ passed: 1, failed: 0 });
		expect(r.structuredContent.recent_attestations).toHaveLength(1);
		expect(r.structuredContent.schemas_url).toMatch(/\/\.well-known\/agent-attestation-schemas$/);
	});

	it('flags an agent that is not in our identity index instead of failing', async () => {
		dbState.agent = [];
		const r = await call('solana_agent_passport', { asset: ASSET });
		expect(r.isError).toBeUndefined();
		expect(r.structuredContent.identity).toEqual({
			agent_off_index: true, asset_pubkey: ASSET, network: 'devnet',
		});
	});
});
