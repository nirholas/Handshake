import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReputation, SUPPORTED_CHAINS, ThreeWsError } from '../src/index.js';

// A scripted fetch double: each call shifts the next queued response and records
// the request. No network, no real endpoints, we assert on request shaping and
// response parsing, which is all the SDK is responsible for.
function stubFetch(responses) {
	const calls = [];
	const queue = [...responses];
	const fetch = async (url, init) => {
		calls.push({ url: new URL(url), init });
		const next = queue.shift();
		if (!next) throw new Error('stubFetch: no more queued responses');
		const { status = 200, body = {}, headers = {} } = next;
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: { get: (k) => headers[k.toLowerCase()] ?? null },
			text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
		};
	};
	return { fetch, calls };
}

// A synthetic Solana asset address (base58): never a real third-party mint.
const SYNTH_ASSET = 'THREEsynthetic1111111111111111111111111111';
const AGENT_UUID = '7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55';

test('reputation(UUID) reads the wallet-trust endpoint and camelCases the score', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { agent_id: AGENT_UUID, name: 'Helios', score: 78, max: 100, tier: 'trusted', tierLabel: 'Trusted', isNew: false, is_owner: false, totals: { x: 1 }, computed_at: '2026-06-23T00:00:00Z' } },
	]);
	const client = createReputation({ fetch, baseUrl: 'https://three.ws' });
	const rep = await client.reputation(AGENT_UUID);

	assert.equal(calls[0].url.pathname, `/api/agents/${AGENT_UUID}/reputation`);
	assert.equal(calls[0].init.method, 'GET');
	assert.equal(rep.kind, 'wallet');
	assert.equal(rep.score, 78);
	assert.equal(rep.tierLabel, 'Trusted');
	assert.equal(rep.isOwner, false);
	assert.equal(rep.raw.agent_id, AGENT_UUID);
});

test('reputation(asset) reads the Solana attestation endpoint with network query', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { agent: SYNTH_ASSET, network: 'mainnet', feedback: { total: 6, verified: 4, event_attested: 1, unique_attesters: 3, score_avg: 4.2, score_avg_weighted: 4.5 }, stake: { total_lamports: '0', count: 0, unique_stakers: 0, top_stakers: [] }, validation: { self_passed: 2 }, disputes_filed: 0, revoked_count: 0, last_indexed_at: '2026-06-23T00:00:00Z' } },
	]);
	const client = createReputation({ fetch });
	const rep = await client.reputation(SYNTH_ASSET, { network: 'mainnet' });

	assert.equal(calls[0].url.pathname, '/api/agents/solana-reputation');
	assert.equal(calls[0].url.searchParams.get('asset'), SYNTH_ASSET);
	assert.equal(calls[0].url.searchParams.get('network'), 'mainnet');
	assert.equal(rep.kind, 'solana');
	assert.equal(rep.feedback.total, 6);
	assert.equal(rep.feedback.scoreAvg, 4.2);
	assert.equal(rep.feedback.eventAttested, 1);
	assert.equal(rep.stake.totalLamports, '0');
});

test('reputation() rejects a non-UUID, non-asset id before any network call', async () => {
	const { fetch, calls } = stubFetch([]);
	const client = createReputation({ fetch });
	await assert.rejects(() => client.reputation('not-an-id'), (e) => {
		assert.ok(e instanceof ThreeWsError);
		assert.equal(e.code, 'invalid_input');
		return true;
	});
	await assert.rejects(() => client.reputation(''), /needs an agent id/);
	assert.equal(calls.length, 0);
});

test('leaderboard() clamps limit and shapes ranked agents', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { generated_at: '2026-06-23T00:00:00Z', count: 1, scored: 12, agents: [{ rank: 1, id: AGENT_UUID, name: 'Helios', score: 91, tier: 'elite', tier_label: 'Elite', agent_url: 'https://three.ws/agent/x', breakdown_url: 'https://three.ws/agent/x/wallet#reputation' }] } },
	]);
	const client = createReputation({ fetch });
	const lb = await client.leaderboard({ limit: 500 });

	assert.equal(calls[0].url.pathname, '/api/reputation/leaderboard');
	assert.equal(calls[0].url.searchParams.get('limit'), '50'); // clamped from 500
	assert.equal(lb.generatedAt, '2026-06-23T00:00:00Z');
	assert.equal(lb.agents[0].tierLabel, 'Elite');
	assert.equal(lb.agents[0].breakdownUrl, 'https://three.ws/agent/x/wallet#reputation');
});

test('validation() resolves the chain by name and reads the ERC-8004 validation', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { validation: { chainId: 8453, agentId: '1', kind: 'glb-schema', registry: '0x8004Cb', available: true, exists: true, passed: true, proofHash: '0xabc', validator: '0xdef', validatedAt: '2026-06-23T00:00:00Z' } } },
	]);
	const client = createReputation({ fetch });
	const v = await client.validation('base', 1);

	assert.equal(calls[0].url.pathname, '/api/erc8004/validation');
	assert.equal(calls[0].url.searchParams.get('chainId'), '8453');
	assert.equal(calls[0].url.searchParams.get('agentId'), '1');
	assert.equal(v.chain, 'Base');
	assert.equal(v.exists, true);
	assert.equal(v.passed, true);
});

test('validation() rejects an unsupported chain before any network call', async () => {
	const { fetch, calls } = stubFetch([]);
	const client = createReputation({ fetch });
	await assert.rejects(() => client.validation('dogechain', 1), (e) => {
		assert.equal(e.code, 'unsupported_chain');
		return true;
	});
	assert.equal(calls.length, 0);
});

test('attest() on a Solana asset posts to the Solana validate lane', async () => {
	const { fetch, calls } = stubFetch([
		{ status: 201, body: { ok: true, passed: true, signature: 'sig123', proof_hash: '0xph', proof_uri: 'ipfs://x', validator: 'VAL', network: 'mainnet', asset_pubkey: SYNTH_ASSET, deduped: false, kind: 'threews.validation.v1', explorer: 'https://explorer.solana.com/tx/sig123' } },
	]);
	const client = createReputation({ fetch, apiKey: 'token_with_avatars_write' });
	const receipt = await client.attest({ agent: SYNTH_ASSET, kind: 'validation' });

	assert.equal(calls[0].url.pathname, '/api/agents/solana-validate');
	assert.equal(calls[0].init.method, 'POST');
	assert.equal(JSON.parse(calls[0].init.body).asset_pubkey, SYNTH_ASSET);
	assert.equal(calls[0].init.headers.authorization, 'Bearer token_with_avatars_write');
	assert.equal(receipt.lane, 'solana');
	assert.equal(receipt.status, 'minted');
	assert.equal(receipt.signature, 'sig123');
});

test('attest() on a uint agentId posts to the ERC-8004 validate lane with the chainId', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { ok: true, validation: { chainId: 8453, agentId: '42', passed: true, kind: 'glb-schema', txHash: '0xtx', txExplorer: 'https://basescan.org/tx/0xtx', proofHash: '0xph', validator: '0xval', validatedAt: '2026-06-23T00:00:00Z' } } },
	]);
	const client = createReputation({ fetch });
	const receipt = await client.attest({ agent: '42', chain: 8453 });

	const body = JSON.parse(calls[0].init.body);
	assert.equal(calls[0].url.pathname, '/api/erc8004/validate');
	assert.equal(body.chainId, 8453);
	assert.equal(body.agentId, '42');
	assert.equal(receipt.lane, 'evm');
	assert.equal(receipt.signature, '0xtx');
	assert.equal(receipt.passed, true);
});

test('attest() rejects an invalid kind before any network call', async () => {
	const { fetch, calls } = stubFetch([]);
	const client = createReputation({ fetch });
	await assert.rejects(() => client.attest({ agent: SYNTH_ASSET, kind: 'vouch' }), /Invalid kind/);
	await assert.rejects(() => client.attest({ agent: '', kind: 'feedback' }), /needs a target/);
	assert.equal(calls.length, 0);
});

test('a typed error code (401 unauthorized) surfaces as a ThreeWsError', async () => {
	const { fetch } = stubFetch([{ status: 401, body: { error: 'unauthorized', message: 'sign in required' } }]);
	const client = createReputation({ fetch });
	await assert.rejects(() => client.attest({ agent: SYNTH_ASSET }), (e) => {
		assert.ok(e instanceof ThreeWsError);
		assert.equal(e.code, 'unauthorized');
		assert.equal(e.status, 401);
		return true;
	});
});

test('SUPPORTED_CHAINS is the frozen ERC-8004 chain list (Base is the mainnet default)', () => {
	assert.ok(Object.isFrozen(SUPPORTED_CHAINS));
	const base = SUPPORTED_CHAINS.find((c) => c.id === 8453);
	assert.equal(base.name, 'Base');
	assert.equal(base.testnet, false);
	assert.ok(SUPPORTED_CHAINS.some((c) => c.id === 84532 && c.testnet === true));
});
