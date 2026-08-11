import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgenc, ThreeWsError, AgenCError } from '../src/index.js';

// A scripted fetch double: each call shifts the next queued response and records
// the request. No network, no real endpoints — we assert on request shaping and
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

// A synthetic creator that still base58-decodes to exactly 32 bytes, so the
// same string works verbatim against the live bridge's pubkey validation.
const CREATOR = 'THREEsynthetic11111111111111111111111111111';

test('listTasks() shapes the bridge response and defaults to mainnet', async () => {
	const { fetch, calls } = stubFetch([
		{
			body: {
				ok: true,
				cluster: 'mainnet',
				programId: 'AgenCprog1111111111111111111111111111111111',
				creator: CREATOR,
				count: 1,
				tasks: [
					{
						taskId: 'ab'.repeat(32),
						taskPda: 'TaskPda11111111111111111111111111111111111',
						state: 'Open',
						stateRaw: 0,
						rewardAmount: '5000000',
						rewardMint: null,
						deadline: '1750000000',
						currentWorkers: 0,
						maxWorkers: 1,
						completedAt: null,
						private: false,
					},
				],
				fetchedAt: '2026-06-23T00:00:00.000Z',
			},
		},
	]);
	const client = createAgenc({ fetch, baseUrl: 'https://three.ws' });
	const res = await client.listTasks(CREATOR);

	assert.equal(calls[0].url.pathname, '/api/agenc/list-tasks');
	assert.equal(calls[0].init.method ?? 'GET', 'GET');
	assert.equal(calls[0].url.searchParams.get('creator'), CREATOR);
	assert.equal(calls[0].url.searchParams.get('cluster'), 'mainnet');
	assert.equal(res.count, 1);
	assert.equal(res.tasks[0].state, 'Open');
	assert.equal(res.tasks[0].rewardAmount, '5000000');
	assert.equal(res.tasks[0].private, false);
	assert.ok(res.raw, 'keeps a .raw escape hatch');
});

test('getTask() resolves a (creator, taskId) pair with lifecycle and cluster', async () => {
	const { fetch, calls } = stubFetch([
		{
			body: {
				ok: true,
				cluster: 'devnet',
				programId: '6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab',
				taskPda: 'TaskPda22222222222222222222222222222222222',
				task: {
					taskId: 'cd'.repeat(32),
					state: 'Claimed',
					stateRaw: 1,
					creator: CREATOR,
					rewardAmount: '5000000',
					rewardMint: null,
					deadline: '1750000000',
					currentWorkers: 1,
					maxWorkers: 1,
					completedAt: null,
					constraintHash: null,
					private: false,
				},
				lifecycle: {
					currentState: 'Claimed',
					createdAt: '1749990000',
					currentWorkers: 1,
					maxWorkers: 1,
					timeline: [
						{ eventName: 'Created', timestamp: '1749990000', txSignature: 'sig1', actor: CREATOR },
						{ eventName: 'Claimed', timestamp: '1749991000', txSignature: 'sig2', actor: 'Worker11111111111111111111111111111111111' },
					],
				},
				fetchedAt: '2026-06-23T00:00:00.000Z',
			},
		},
	]);
	const client = createAgenc({ fetch });
	const res = await client.getTask({ creator: CREATOR, taskId: 'render-greeting' }, { lifecycle: true, cluster: 'devnet' });

	assert.equal(calls[0].url.pathname, '/api/agenc/get-task');
	assert.equal(calls[0].url.searchParams.get('creator'), CREATOR);
	assert.equal(calls[0].url.searchParams.get('taskId'), 'render-greeting');
	assert.equal(calls[0].url.searchParams.get('lifecycle'), '1');
	assert.equal(calls[0].url.searchParams.get('cluster'), 'devnet');
	assert.equal(res.task.state, 'Claimed');
	assert.equal(res.task.creator, CREATOR);
	assert.equal(res.lifecycle.timeline.length, 2);
	assert.equal(res.lifecycle.timeline[0].eventName, 'Created');
});

test('getTask() by bare PDA string omits lifecycle when not requested', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { ok: true, taskPda: 'TaskPda33333333333333333333333333333333333', task: { state: 'Open' }, lifecycle: null } },
	]);
	const client = createAgenc({ fetch });
	const res = await client.getTask('TaskPda33333333333333333333333333333333333');

	assert.equal(calls[0].url.searchParams.get('taskPda'), 'TaskPda33333333333333333333333333333333333');
	assert.equal(calls[0].url.searchParams.has('lifecycle'), false);
	assert.equal(res.lifecycle, null);
	assert.equal(res.task.state, 'Open');
});

test('getAgent() treats a bare string as an agentId label', async () => {
	const { fetch, calls } = stubFetch([
		{
			body: {
				ok: true,
				cluster: 'mainnet',
				agentPda: 'AgentPda1111111111111111111111111111111111',
				agent: {
					agentId: 'ef'.repeat(32),
					authority: CREATOR,
					capabilities: '1',
					status: 'Active',
					statusRaw: 1,
					endpoint: 'https://three.ws/agents/demo-worker',
					metadataUri: null,
					stakeAmount: '1000000',
					activeTasks: 0,
					reputation: 0,
					registeredAt: '1749990000',
				},
			},
		},
	]);
	const client = createAgenc({ fetch });
	const res = await client.getAgent('three-ws-worker-demo');

	assert.equal(calls[0].url.pathname, '/api/agenc/get-agent');
	assert.equal(calls[0].url.searchParams.get('agentId'), 'three-ws-worker-demo');
	assert.equal(calls[0].url.searchParams.has('agentPda'), false);
	assert.equal(res.agent.status, 'Active');
	assert.equal(res.agent.capabilities, '1');
	assert.equal(res.agent.reputation, 0);
});

test('a 404 from the bridge surfaces as a typed not_found ThreeWsError', async () => {
	const { fetch } = stubFetch([
		{ status: 404, body: { ok: false, error: 'not_found', error_description: 'no task account at that PDA', cluster: 'mainnet' } },
	]);
	const client = createAgenc({ fetch });
	await assert.rejects(() => client.getTask('TaskPdaMissing1111111111111111111111111111'), (e) => {
		assert.ok(e instanceof ThreeWsError);
		assert.ok(e instanceof AgenCError, 'the README-documented AgenCError alias must match thrown errors');
		assert.equal(e.code, 'not_found');
		assert.equal(e.status, 404);
		return true;
	});
});

test('a 429 maps to rate_limited and carries retryAfter', async () => {
	const { fetch } = stubFetch([
		{ status: 429, body: { error: 'rate_limited', error_description: 'too many requests', retry_after: 7 }, headers: { 'retry-after': '7' } },
	]);
	const client = createAgenc({ fetch });
	await assert.rejects(() => client.listTasks(CREATOR), (e) => {
		assert.ok(e instanceof ThreeWsError);
		assert.equal(e.code, 'rate_limited');
		assert.equal(e.status, 429);
		assert.equal(e.retryAfter, 7);
		return true;
	});
});

test('invalid inputs are rejected before any network call', async () => {
	const { fetch, calls } = stubFetch([]);
	const client = createAgenc({ fetch });
	await assert.rejects(() => client.listTasks(''), /needs a base58 creator/);
	await assert.rejects(() => client.listTasks('not a base58 wallet!'), /not a valid base58/);
	await assert.rejects(() => client.listTasks(CREATOR, { cluster: 'testnet' }), /Invalid cluster/);
	await assert.rejects(() => client.getTask({}), /needs a taskPda/);
	await assert.rejects(() => client.getAgent({}), /needs an agentPda or agentId/);
	assert.equal(calls.length, 0);
});
