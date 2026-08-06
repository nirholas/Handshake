/**
 * /api/agenc/get-task?lifecycle=1 — the tx-signature + deliverable enrichment.
 *
 * A Solana task account records WHAT happened but not the signature of the
 * transaction that wrote it, so `getTaskLifecycleSummary` hands back a timeline
 * with `txSignature: null` on every event. The Agora job-detail panel renders
 * those as an honest "no tx recorded", which means the trust surface's Explorer
 * links were dead for real work — even though three.ws journals the real
 * signature (and the completion's proofHash + deliverableUrl) into
 * `agora_activity` on every write through the Agora rail.
 *
 * These tests pin the enrichment that closes that gap:
 *   • journalled signatures fill the chain's blanks, in event order;
 *   • the chain stays authoritative (an existing signature is never overwritten);
 *   • a completion carries its proofHash + deliverableUrl, hoisted to the
 *     lifecycle so a deep link (/agora?task=<pda>) can run the verifier;
 *   • one journal row is consumed at most once, so a multi-worker task's second
 *     claim can't inherit the first claim's signature;
 *   • a DB outage degrades to the chain's own timeline — never a fabricated link.
 *
 * We drive the REAL wrapped handler and mock only the I/O boundary (DB, rate
 * limiter, on-chain SDK), so the handler's own shaping runs unchanged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const CREATOR = '7u5S18DyHgjovCH3dE9sFZVWDbmFiE7uazB9F7gx4hJv';
const TASK_PDA = 'CaxgSpW8YY8F9AM7DcBCM6NzbWv8YGSZPbwvnbVn1qnj';
const SIG_CREATE = '3azuehpfmSrXU1F2CnqR95FL4JJrcoHHCquTQmypSk7U12rSQp8k2V2yz6TzCCwQLWTxXrLCjaRryT6pH6XctYa4';
const SIG_DONE = '4XcU1JAc6Jd21NJYxqgeV9nXQV2wJ7hGDtTCYRJKpcXT51YtoEBAwsw6h3Gjb6q63Ds89xZm2btjT77Yg4fFJ4PL';
const PROOF = 'eed7876bf990aae26939aba2c52ec381dfa49245dfb1d884b892030f2df1d8f0';
const DELIVERABLE = `https://pub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev/agora/deliverables/fetcher/${PROOF}.json`;

const H = vi.hoisted(() => ({
	activity: [],
	dbThrows: false,
	timeline: [],
}));

vi.mock('../api/_lib/db.js', () => {
	const sql = (strings) => {
		if (!Array.isArray(strings)) return { __frag: true };
		if (H.dbThrows) return Promise.reject(new Error('db_unavailable'));
		return Promise.resolve(H.activity);
	};
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

vi.mock('../api/_lib/rate-limit.js', () => ({
	clientIp: () => '1.2.3.4',
	limits: { publicIp: async () => ({ success: true, limit: 60, remaining: 59, reset: Date.now() + 1000 }) },
}));

vi.mock('@tetsuo-ai/sdk', () => ({
	getTask: async () => ({
		taskId: new Uint8Array(32),
		state: 2,
		creator: CREATOR,
		rewardAmount: '2000000',
		rewardMint: null,
		deadline: 1785990416,
		currentWorkers: 1,
		maxWorkers: 1,
		completedAt: 1785986919,
		constraintHash: null,
	}),
	getTaskLifecycleSummary: async () => ({
		currentState: 2,
		createdAt: 1785986816,
		currentWorkers: 1,
		maxWorkers: 1,
		timeline: H.timeline,
	}),
	getTasksByCreator: async () => [],
	getAgent: async () => null,
	deriveTaskPda: () => ({ toBase58: () => TASK_PDA }),
	deriveAgentPda: () => ({ toBase58: () => TASK_PDA }),
}));

const handler = (await import('../api/agenc/[action].js')).default;

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		ended: false,
		setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return this.headers[String(k).toLowerCase()]; },
		removeHeader(k) { delete this.headers[String(k).toLowerCase()]; },
		end(b) { this.body = b; this.ended = true; },
		get headersSent() { return this.ended; },
		get writableEnded() { return this.ended; },
	};
}

async function getTask(query = {}) {
	const res = makeRes();
	await handler({
		method: 'GET',
		url: '/api/agenc/get-task',
		headers: { host: 'three.ws' },
		query: { action: 'get-task', taskPda: TASK_PDA, cluster: 'devnet', lifecycle: '1', ...query },
	}, res);
	return { res, json: JSON.parse(res.body) };
}

beforeEach(() => {
	H.dbThrows = false;
	H.timeline = [
		{ eventName: 'taskCreated', timestamp: 1785986816, txSignature: null, actor: { toBase58: () => CREATOR } },
		{ eventName: 'taskCompleted', timestamp: 1785986919, txSignature: null, actor: null },
	];
	H.activity = [
		{ kind: 'posted_task', tx_signature: SIG_CREATE, proof_hash: null, deliverable_url: null, created_at: '2026-08-06T03:26:58Z' },
		{ kind: 'completed_task', tx_signature: SIG_DONE, proof_hash: PROOF, deliverable_url: DELIVERABLE, created_at: '2026-08-06T03:28:39Z' },
	];
});

describe('get-task lifecycle enrichment', () => {
	it('fills the chain\'s null signatures from the journal, matched by event', async () => {
		const { json } = await getTask();
		expect(json.ok).toBe(true);
		const [created, completed] = json.lifecycle.timeline;
		expect(created.txSignature).toBe(SIG_CREATE);
		expect(completed.txSignature).toBe(SIG_DONE);
	});

	it('carries the completion\'s deliverable proof and hoists it for deep links', async () => {
		const { json } = await getTask();
		const completed = json.lifecycle.timeline[1];
		expect(completed.proofHash).toBe(PROOF);
		expect(completed.deliverableUrl).toBe(DELIVERABLE);
		// Hoisted: a client holding only the PDA can verify without walking events.
		expect(json.lifecycle.proofHash).toBe(PROOF);
		expect(json.lifecycle.deliverableUrl).toBe(DELIVERABLE);
	});

	it('never overwrites a signature the chain itself reported', async () => {
		const onChainSig = '5'.repeat(64);
		H.timeline[0].txSignature = onChainSig;
		const { json } = await getTask();
		expect(json.lifecycle.timeline[0].txSignature).toBe(onChainSig);
	});

	it('consumes each journal row once so a second claim can\'t reuse the first\'s tx', async () => {
		const claimA = 'A'.repeat(64);
		const claimB = 'B'.repeat(64);
		H.timeline = [
			{ eventName: 'taskClaimed', timestamp: 1, txSignature: null, actor: null },
			{ eventName: 'taskClaimed', timestamp: 2, txSignature: null, actor: null },
		];
		H.activity = [
			{ kind: 'claimed_task', tx_signature: claimA, proof_hash: null, deliverable_url: null, created_at: '2026-08-06T03:27:00Z' },
			{ kind: 'claimed_task', tx_signature: claimB, proof_hash: null, deliverable_url: null, created_at: '2026-08-06T03:27:30Z' },
		];
		const { json } = await getTask();
		expect(json.lifecycle.timeline.map((e) => e.txSignature)).toEqual([claimA, claimB]);
	});

	it('invents nothing when the journal has no row for an event', async () => {
		H.activity = [];
		const { json } = await getTask();
		expect(json.lifecycle.timeline.every((e) => e.txSignature === null)).toBe(true);
		expect(json.lifecycle.proofHash).toBeUndefined();
	});

	it('degrades to the chain\'s own timeline when the DB is unreachable', async () => {
		H.dbThrows = true;
		const { res, json } = await getTask();
		expect(res.statusCode).toBe(200);
		expect(json.lifecycle.timeline).toHaveLength(2);
		expect(json.lifecycle.timeline.every((e) => e.txSignature === null)).toBe(true);
	});
});
