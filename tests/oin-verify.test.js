// Tests for the OIN v0.1 verifier: specs/OPEN_INFERENCE_PROTOCOL.md rules 1-6.
// Every rule gets a happy path and a named-verdict failure path; the signing
// helpers double as the node side of the loop, so these tests prove the spec's
// reference implementation round-trips.

import { describe, it, expect } from 'vitest';
import { createHash, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerifyRaw } from 'node:crypto';
import {
	canonicalize,
	digestJob,
	pubkeyB64FromSecret,
	signAdvertisement,
	signResponse,
	verifyOutput,
	verifyResponse,
} from '../api/_lib/oin-verify.js';

// Deterministic Ed25519 seed (32 bytes of 0x07) so keys in this file are stable.
const SEED_B64 = Buffer.alloc(32, 7).toString('base64');
const OTHER_SEED_B64 = Buffer.alloc(32, 9).toString('base64');
const NODE_PUBKEY = `ed25519:${pubkeyB64FromSecret(SEED_B64)}`;

function makeJob(overrides = {}) {
	return {
		spec: 'oin/0.1',
		job_id: 'j_test_0001',
		capability: 'mesh.stylize',
		created_at: '2026-08-12T00:00:00.000Z',
		deadline: 1800,
		input: { model: 'voxel', data: 'https://example.com/box.glb' },
		params: { resolution: 16, output_format: 'glb' },
		...overrides,
	};
}

function makeSignedResponse(job, overrides = {}) {
	const unsigned = {
		spec: 'oin/0.1',
		job_digest: digestJob(job),
		node_pubkey: NODE_PUBKEY,
		completed_at: '2026-08-12T00:00:10.000Z',
		status: 'done',
		output: {
			url: 'https://storage.googleapis.com/bucket/oin/job.glb',
			sha256: 'a'.repeat(64),
			bytes: 1234,
		},
		usage: { elapsed_ms: 9500, units: 1 },
		...overrides,
	};
	return signResponse(unsigned, SEED_B64);
}

describe('canonicalize (RFC 8785 JCS)', () => {
	it('sorts object keys and drops whitespace', () => {
		expect(canonicalize({ b: 1, a: { d: [true, null], c: 'x' } }))
			.toBe('{"a":{"c":"x","d":[true,null]},"b":1}');
	});

	it('serializes numbers with ECMAScript toString semantics', () => {
		expect(canonicalize({ n: 1e21 })).toBe('{"n":1e+21}');
		expect(canonicalize({ n: -0 })).toBe('{"n":0}');
		expect(canonicalize({ n: 3.5 })).toBe('{"n":3.5}');
	});

	it('rejects non-finite numbers', () => {
		expect(() => canonicalize({ n: NaN })).toThrow(TypeError);
		expect(() => canonicalize({ n: Infinity })).toThrow(TypeError);
	});

	it('is stable across key insertion order (same digest for reordered envelopes)', () => {
		const a = digestJob(makeJob());
		const shuffled = makeJob();
		const reordered = {
			params: shuffled.params,
			input: shuffled.input,
			created_at: shuffled.created_at,
			deadline: shuffled.deadline,
			capability: shuffled.capability,
			job_id: shuffled.job_id,
			spec: shuffled.spec,
		};
		expect(digestJob(reordered)).toBe(a);
	});
});

describe('verifyResponse', () => {
	it('accepts a well-formed signed response (verified)', () => {
		const job = makeJob();
		const res = makeSignedResponse(job);
		const out = verifyResponse(job, res);
		expect(out.ok).toBe(true);
		expect(out.verdict).toBe('verified');
		expect(out.nodePubkey).toBe(NODE_PUBKEY);
	});

	it('round-trips with Node-generated Ed25519 keys (interop with stock keygen)', () => {
		const { publicKey, privateKey } = generateKeyPairSync('ed25519');
		const spki = publicKey.export({ format: 'der', type: 'spki' });
		const pubField = `ed25519:${Buffer.from(spki).subarray(-32).toString('base64')}`;
		const job = makeJob();
		const unsigned = {
			spec: 'oin/0.1',
			job_digest: digestJob(job),
			node_pubkey: pubField,
			completed_at: '2026-08-12T00:00:10.000Z',
			status: 'failed',
			error: { code: 'bad_input', message: 'nope' },
		};
		const bytes = Buffer.from(canonicalize(unsigned), 'utf8');
		const signature = cryptoSign(null, bytes, privateKey).toString('base64');
		const out = verifyResponse(job, { ...unsigned, signature });
		expect(out.ok).toBe(true);
		expect(out.status).toBe('failed');
	});

	it('bad_shape: wrong spec', () => {
		const job = makeJob();
		const res = makeSignedResponse(job, { spec: 'oin/9.9' });
		expect(verifyResponse(job, res).verdict).toBe('bad_shape');
	});

	it('bad_shape: missing signature', () => {
		const job = makeJob();
		const res = makeSignedResponse(job);
		delete res.signature;
		expect(verifyResponse(job, res).verdict).toBe('bad_shape');
	});

	it('bad_shape: unknown status', () => {
		const job = makeJob();
		const res = makeSignedResponse(job, { status: 'running' });
		expect(verifyResponse(job, res).verdict).toBe('bad_shape');
	});

	it('job_digest_mismatch: response answers a different job', () => {
		const job = makeJob();
		const res = makeSignedResponse(makeJob({ job_id: 'j_other' }));
		expect(verifyResponse(job, res).verdict).toBe('job_digest_mismatch');
	});

	it('bad_pubkey: malformed node_pubkey', () => {
		const job = makeJob();
		const res = makeSignedResponse(job);
		// Re-sign is impossible without a parseable key; corrupt after signing and
		// expect the key parse to fail before signature verification runs.
		res.node_pubkey = 'secp256k1:AAAA';
		expect(verifyResponse(job, res).verdict).toBe('bad_pubkey');
	});

	it('untrusted_node: key differs from the pinned advertisement key', () => {
		const job = makeJob();
		const res = makeSignedResponse(job);
		const out = verifyResponse(job, res, { expectedPubkey: `ed25519:${pubkeyB64FromSecret(OTHER_SEED_B64)}` });
		expect(out.verdict).toBe('untrusted_node');
	});

	it('bad_signature: tampered output after signing', () => {
		const job = makeJob();
		const res = makeSignedResponse(job);
		res.output = { ...res.output, bytes: 9999 };
		expect(verifyResponse(job, res).verdict).toBe('bad_signature');
	});

	it('bad_signature: signed by a different key than advertised in the response', () => {
		const job = makeJob();
		const unsigned = {
			spec: 'oin/0.1',
			job_digest: digestJob(job),
			node_pubkey: `ed25519:${pubkeyB64FromSecret(OTHER_SEED_B64)}`,
			completed_at: '2026-08-12T00:00:10.000Z',
			status: 'done',
			output: { url: 'https://x.example/o.glb', sha256: 'b'.repeat(64), bytes: 1 },
		};
		// Sign with SEED but claim OTHER's pubkey.
		const res = signResponse(unsigned, SEED_B64);
		expect(verifyResponse(job, res).verdict).toBe('bad_signature');
	});

	it('stale_response: completed after the job deadline', () => {
		const job = makeJob({ deadline: 5 });
		const res = makeSignedResponse(job); // completed_at is 10s after created_at
		expect(verifyResponse(job, res).verdict).toBe('stale_response');
	});

	it('future_response: completed_at implausibly far ahead of the verifier clock', () => {
		const job = makeJob({ deadline: 10_000_000 });
		const res = makeSignedResponse(job, { completed_at: '2026-08-12T00:00:10.000Z' });
		const out = verifyResponse(job, res, { now: new Date('2026-08-01T00:00:00.000Z') });
		expect(out.verdict).toBe('future_response');
	});

	it('passes when completed just inside the deadline', () => {
		const job = makeJob({ created_at: '2026-08-12T00:00:00.000Z', deadline: 60 });
		const res = makeSignedResponse(job, { completed_at: '2026-08-12T00:00:59.000Z' });
		expect(verifyResponse(job, res, { now: new Date('2026-08-12T00:01:00.000Z') }).verdict).toBe('verified');
	});
});

describe('verifyOutput (rule 6)', () => {
	const body = Buffer.from('glb-bytes-for-the-test');
	const sha = createHash('sha256').update(body).digest('hex');

	function resWithOutput() {
		const job = makeJob();
		return makeSignedResponse(job, {
			output: { url: 'https://storage.googleapis.com/bucket/oin/job.glb', sha256: sha, bytes: body.length },
		});
	}

	it('verified_with_output when fetched bytes match the declared digest', async () => {
		const res = resWithOutput();
		const fetchImpl = async () => ({
			ok: true,
			headers: { get: () => String(body.length) },
			arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
		});
		const out = await verifyOutput(res, fetchImpl);
		expect(out.ok).toBe(true);
		expect(out.verdict).toBe('verified_with_output');
	});

	it('output_digest_mismatch when the artifact bytes differ', async () => {
		const res = resWithOutput();
		const other = Buffer.from('tampered');
		const fetchImpl = async () => ({
			ok: true,
			headers: { get: () => String(other.length) },
			arrayBuffer: async () => other.buffer.slice(other.byteOffset, other.byteOffset + other.length),
		});
		const out = await verifyOutput(res, fetchImpl);
		expect(out.ok).toBe(false);
		expect(out.verdict).toBe('output_digest_mismatch');
	});

	it('output_digest_mismatch when the fetch fails', async () => {
		const res = resWithOutput();
		const out = await verifyOutput(res, async () => ({ ok: false, status: 403, headers: { get: () => null } }));
		expect(out.verdict).toBe('output_digest_mismatch');
	});
});

describe('advertisement signing', () => {
	it('a signed advertisement verifies against its own node key', () => {
		const ad = {
			spec: 'oin/0.1',
			node_id: 'node_test',
			node_pubkey: NODE_PUBKEY,
			generated_at: '2026-08-12T00:00:00.000Z',
			capabilities: [{ key: 'mesh.stylize', version: '0.1', models: ['voxel'] }],
			endpoints: { submit: '/oin/jobs', poll: '/oin/jobs/:id', health: '/health' },
			auth: 'bearer',
		};
		const signed = signAdvertisement(ad, SEED_B64);
		expect(typeof signed.signature).toBe('string');
		// The advertisement uses the same signature rule as a response minus the
		// job binding, so verify it by hand with the same primitives.
		const { signature, ...unsigned } = signed;
		const pub = pubkeyB64FromSecret(SEED_B64);
		expect(signed.node_pubkey).toBe(`ed25519:${pub}`);
		const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pub, 'base64')]);
		const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
		expect(cryptoVerifyRaw(null, Buffer.from(canonicalize(unsigned), 'utf8'), key, Buffer.from(signature, 'base64'))).toBe(true);
	});
});
