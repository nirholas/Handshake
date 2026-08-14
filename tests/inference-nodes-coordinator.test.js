/**
 * Coordinator data layer for the open inference network (api/_lib/inference-nodes.js).
 *
 * These run against the REAL Upstash REST client pointed at the in-process
 * shim from packages/node-operator/tests/redis-shim.js, not a hand-written
 * fake of the client. That distinction is the entire point of the file: the
 * bug this suite locks down was a mismatch between what the client returns
 * and what the data layer assumed it returns, which no stub of the client can
 * reproduce, and which took out every read path in the job queue.
 *
 * Spec: specs/inference-nodes.md
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRedisShim } from '../packages/node-operator/tests/redis-shim.js';
import { createIdentity } from '../packages/node-operator/src/identity.js';
import { signResult } from '../packages/node-operator/src/signing.js';

let shim;
let nodes;

beforeAll(async () => {
	shim = createRedisShim();
	const url = await shim.listen();
	process.env.UPSTASH_REDIS_REST_URL = url;
	process.env.UPSTASH_REDIS_REST_TOKEN = 'shim-token';
	// No DATABASE_URL: the registry falls back to Redis, which is also the
	// path a fresh operator hits on a bare local stack.
	delete process.env.DATABASE_URL;
	nodes = await import('../api/_lib/inference-nodes.js');
});

afterAll(async () => {
	await shim?.close();
});

describe('node registry', () => {
	it('registers and reads back a node with no database configured', async () => {
		const identity = createIdentity();
		const stored = await nodes.registerNode({
			publicKey: identity.publicKey,
			label: 'atlas-test',
			capabilities: [{ capability: 'text-embedding', model: 'Xenova/all-MiniLM-L6-v2' }],
		});
		expect(stored.public_key).toBe(identity.publicKey);

		// The regression: @upstash/redis deserializes JSON on read, so this
		// value comes back as an object. JSON.parse on it throws
		// `"[object Object]" is not valid JSON`, which made every node look
		// unregistered and every poll answer 404.
		const found = await nodes.getNode(identity.publicKey);
		expect(found).not.toBeNull();
		expect(found.public_key).toBe(identity.publicKey);
		expect(found.capabilities[0].capability).toBe('text-embedding');
	});

	it('returns null for a key that never registered', async () => {
		expect(await nodes.getNode(createIdentity().publicKey)).toBeNull();
	});

	it('rejects a malformed public key before it reaches storage', async () => {
		await expect(nodes.registerNode({ publicKey: 'not-a-key', capabilities: [] })).rejects.toThrow(/invalid node public key/);
	});
});

describe('job queue', () => {
	let identity;

	beforeEach(() => {
		identity = createIdentity();
	});

	it('claims a queued job exactly once', async () => {
		const job = await nodes.enqueueJob({
			capability: 'text-embedding',
			model: 'Xenova/all-MiniLM-L6-v2',
			input: { text: 'claim me' },
			jobId: `job_claim_${Math.random().toString(36).slice(2)}`,
		});

		const claimed = await nodes.claimJob({ capability: 'text-embedding', publicKey: identity.publicKey });
		expect(claimed?.id).toBe(job.id);
		expect(claimed.status).toBe('running');
		expect(claimed.claimedBy).toBe(identity.publicKey);

		// A second node polling the same capability finds nothing: the pop is
		// what makes a claim exclusive.
		expect(await nodes.claimJob({ capability: 'text-embedding', publicKey: createIdentity().publicKey })).toBeNull();
	});

	it('reads a job record back without double-parsing it', async () => {
		const job = await nodes.enqueueJob({
			capability: 'text-embedding',
			model: 'm',
			input: { text: 'read me' },
			jobId: `job_read_${Math.random().toString(36).slice(2)}`,
		});
		const read = await nodes.getJob(job.id);
		expect(read.id).toBe(job.id);
		expect(read.input.text).toBe('read me');
	});

	it('completes a job only for the claiming node, and only once', async () => {
		const jobId = `job_done_${Math.random().toString(36).slice(2)}`;
		await nodes.enqueueJob({ capability: 'cap-done', model: 'm', input: { text: 'hi' }, jobId });
		await nodes.claimJob({ capability: 'cap-done', publicKey: identity.publicKey });

		const stranger = createIdentity();
		expect(await nodes.completeJob(jobId, { publicKey: stranger.publicKey, output: {}, receipt: {}, startedAt: 1, finishedAt: 2 }))
			.toMatchObject({ ok: false, status: 403, error: 'not_job_owner' });

		const ok = await nodes.completeJob(jobId, { publicKey: identity.publicKey, output: { a: 1 }, receipt: { r: 1 }, startedAt: 1, finishedAt: 2 });
		expect(ok.ok).toBe(true);
		expect(ok.job.status).toBe('done');

		// A replayed submit cannot overwrite a landed result.
		expect(await nodes.completeJob(jobId, { publicKey: identity.publicKey, output: { a: 2 }, receipt: {}, startedAt: 1, finishedAt: 2 }))
			.toMatchObject({ ok: false, status: 409, error: 'job_not_running' });
	});

	it('records a signed failure report', async () => {
		const jobId = `job_fail_${Math.random().toString(36).slice(2)}`;
		await nodes.enqueueJob({ capability: 'cap-fail', model: 'm', input: { text: 'hi' }, jobId });
		await nodes.claimJob({ capability: 'cap-fail', publicKey: identity.publicKey });
		const res = await nodes.failJob(jobId, { publicKey: identity.publicKey, error: 'out of memory' });
		expect(res.ok).toBe(true);
		expect((await nodes.getJob(jobId)).status).toBe('failed');
	});

	it('404s a result for a job that never existed', async () => {
		expect(await nodes.completeJob('job_nope', { publicKey: identity.publicKey, output: {}, receipt: {}, startedAt: 1, finishedAt: 2 }))
			.toMatchObject({ ok: false, status: 404 });
	});

	it('does not leak unhandled rejections when the counter rollup has no database', async () => {
		// bumpNodeCounter is fire-and-forget. With no DATABASE_URL its query
		// rejects, and the version that interpolated the column name with
		// `sql(column)` produced a second, uncaught promise per call: two
		// unhandled rejections for every completed job.
		const leaked = [];
		const onRejection = (err) => leaked.push(err);
		process.on('unhandledRejection', onRejection);
		try {
			const jobId = `job_rollup_${Math.random().toString(36).slice(2)}`;
			await nodes.enqueueJob({ capability: 'cap-rollup', model: 'm', input: { text: 'hi' }, jobId });
			await nodes.claimJob({ capability: 'cap-rollup', publicKey: identity.publicKey });
			await nodes.completeJob(jobId, { publicKey: identity.publicKey, output: {}, receipt: {}, startedAt: 1, finishedAt: 2 });
			// Rejections surface on the next macrotask, not synchronously.
			await new Promise((r) => setTimeout(r, 50));
			expect(leaked).toEqual([]);
		} finally {
			process.off('unhandledRejection', onRejection);
		}
	});
});

describe('receipt verification', () => {
	it('accepts a receipt the operator client actually produced', async () => {
		// Cross-implementation check: the client signs it, the coordinator
		// recomputes the payload from its own view and verifies. If either side
		// changes the canonical string, this fails.
		const identity = createIdentity();
		const facts = {
			jobId: 'job-x',
			model: 'Xenova/all-MiniLM-L6-v2',
			prompt: 'three.ws open inference network',
			output: { kind: 'text-embedding', dimensions: 3, embedding: [0.1, 0.2, 0.3] },
			startedAt: 1786690713952,
			finishedAt: 1786690720689,
		};
		const receipt = await signResult(identity, facts);
		expect(await nodes.verifyResultReceipt(facts, receipt)).toBe(true);
	});

	it('rejects a receipt whose facts were altered after signing', async () => {
		const identity = createIdentity();
		const facts = { jobId: 'job-y', model: 'm', prompt: 'p', output: { v: 1 }, startedAt: 1, finishedAt: 2 };
		const receipt = await signResult(identity, facts);
		expect(await nodes.verifyResultReceipt({ ...facts, prompt: 'other prompt' }, receipt)).toBe(false);
		expect(await nodes.verifyResultReceipt({ ...facts, output: { v: 2 } }, receipt)).toBe(false);
		expect(await nodes.verifyResultReceipt({ ...facts, finishedAt: 999 }, receipt)).toBe(false);
	});

	it('rejects a receipt signed by a key other than the one it claims', async () => {
		const signer = createIdentity();
		const impostor = createIdentity();
		const facts = { jobId: 'job-z', model: 'm', prompt: 'p', output: { v: 1 }, startedAt: 1, finishedAt: 2 };
		const receipt = await signResult(signer, facts);
		expect(await nodes.verifyResultReceipt(facts, { ...receipt, publicKey: impostor.publicKey })).toBe(false);
	});

	it('rejects a receipt with a non-ed25519 algorithm tag', async () => {
		const identity = createIdentity();
		const facts = { jobId: 'job-w', model: 'm', prompt: 'p', output: {}, startedAt: 1, finishedAt: 2 };
		const receipt = await signResult(identity, facts);
		expect(await nodes.verifyResultReceipt(facts, { ...receipt, algorithm: 'secp256k1' })).toBe(false);
	});
});

describe('node signature verification', () => {
	it('verifies a domain-separated message and rejects a cross-call replay', () => {
		const identity = createIdentity();
		const ts = 1786690709863;
		const registerMsg = `threews-node-register:${identity.publicKey}:${ts}`;
		const sig = identity.signText(registerMsg);
		expect(nodes.verifyNodeSignature(identity.publicKey, registerMsg, sig)).toBe(true);
		// The same signature must not authenticate a poll at the same instant.
		expect(nodes.verifyNodeSignature(identity.publicKey, `threews-node-poll:${identity.publicKey}:${ts}`, sig)).toBe(false);
	});

	it('returns false rather than throwing on garbage input', () => {
		expect(nodes.verifyNodeSignature('not-a-key', 'msg', 'sig')).toBe(false);
		expect(nodes.verifyNodeSignature(createIdentity().publicKey, 'msg', 'not-base64!!')).toBe(false);
	});
});
