// Node operator client tests: identity round-trips, the wire codec, the
// coordinator client, the BPE tokenizer + greedy generation against the real
// distilgpt2 weights, and a full selftest loop against the in-process
// coordinator. Run from the repo root: npm test -- tests/node-operator.test.js

import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	decodeNodeSecret,
	generateKeypair,
	loadKeypair,
	signPayload,
	verifyPayload,
} from '../node-operator/src/identity.js';
import {
	PROTOCOL,
	JOB_TYPE,
	sha256Hex,
	normalizeJob,
	canonicalResult,
	buildResultRecord,
	verifyResult,
} from '../node-operator/src/codec.js';
import { CoordinatorClient, CLIENT_VERSION } from '../node-operator/src/client.js';
import { NodeRunner } from '../node-operator/src/runner.js';
import { createLocalCoordinator } from '../node-operator/src/cli.js';
import { BpeTokenizer, ensureModel, loadEngine } from '../node-operator/src/engine.js';

const CACHE = process.env.NODE_OPERATOR_MODEL_CACHE || path.join(mkdtempSync(path.join(tmpdir(), 'node-op-')), 'model');
const MODEL_ID = 'Xenova/distilgpt2';

describe('identity', () => {
	it('generates a keypair whose secret decodes to the same address', () => {
		const kp = generateKeypair();
		expect(kp.address).toMatch(/^[A-HJ-NP-Za-km-z1-9]{32,44}$/);
		expect(kp.secretBase58).toBeTruthy();
		const loaded = loadKeypair(kp.secretBase58);
		expect(loaded.address).toBe(kp.address);
		expect(Buffer.from(loaded.secretKey).equals(Buffer.from(kp.secretKey))).toBe(true);
	});

	it('decodes base64 and JSON-array encodings to the same key', () => {
		const kp = generateKeypair();
		const b64 = Buffer.from(kp.secretKey).toString('base64');
		expect(loadKeypair(b64).address).toBe(kp.address);
		const json = JSON.stringify([...kp.secretKey]);
		expect(loadKeypair(json).address).toBe(kp.address);
		// A 32-byte seed expands to the same 64-byte key.
		const seed58 = (() => {
			// base58 of the first 32 bytes
			const bytes = kp.secretKey.slice(0, 32);
			return decodeNodeSecretFromSeed(bytes);
		})();
		function decodeNodeSecretFromSeed(bytes) {
			// round-trip through the module: base58-encode via generate path
			// is tested above; here we call decodeNodeSecret with JSON of 32 bytes
			const decoded = decodeNodeSecret(JSON.stringify([...bytes]));
			return decoded;
		}
		expect(seed58.length).toBe(64);
		expect(loadKeypair(JSON.stringify([...kp.secretKey.slice(0, 32)])).address).toBe(kp.address);
	});

	it('signs and verifies payloads against the public address', () => {
		const kp = generateKeypair();
		const sig = signPayload(kp.secretKey, 'hello three.ws');
		expect(verifyPayload(kp.address, 'hello three.ws', sig)).toBe(true);
		expect(verifyPayload(kp.address, 'tampered', sig)).toBe(false);
		const other = generateKeypair();
		expect(verifyPayload(other.address, 'hello three.ws', sig)).toBe(false);
	});

	it('accepts base64 signatures from external verifiers', () => {
		const kp = generateKeypair();
		const sig58 = signPayload(kp.secretKey, 'payload');
		// bs58 -> bytes -> base64 (what some wallets emit)
		const bs58 = { decode: (s) => {
			const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
			const bytes = [0];
			for (const c of s) {
				const p = ALPHABET.indexOf(c);
				let carry = p;
				for (let j = 0; j < bytes.length; j++) {
					carry += bytes[j] * 58;
					bytes[j] = carry & 0xff;
					carry >>= 8;
				}
				while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
			}
			for (const c of s) { if (c === '1') bytes.push(0); else break; }
			return Uint8Array.from(bytes.reverse());
		} };
		const b64 = Buffer.from(bs58.decode(sig58)).toString('base64');
		expect(verifyPayload(kp.address, 'payload', b64)).toBe(true);
	});

	it('rejects malformed secrets and signatures', () => {
		expect(decodeNodeSecret('')).toBeNull();
		expect(decodeNodeSecret('not-a-key')).toBeNull();
		expect(decodeNodeSecret('[1,2,3]')).toBeNull();
		expect(() => loadKeypair('not-a-key')).toThrow(/NODE_SECRET_KEY/);
		expect(verifyPayload('bad', 'x', 'bad')).toBe(false);
	});
});

describe('codec', () => {
	it('normalizes a claimed job and clamps maxTokens', () => {
		const job = normalizeJob({
			jobId: 'j1',
			type: 'llm.completion',
			model: 'Xenova/distilgpt2',
			input: { prompt: 'hi' },
			maxTokens: 99999,
		});
		expect(job.jobId).toBe('j1');
		expect(job.maxTokens).toBe(512);
		expect(normalizeJob({ jobId: 'j2', input: { prompt: '' } })).toBeNull();
		expect(normalizeJob({ jobId: 'j3', type: 'image.gen', input: { prompt: 'x' } })).toBeNull();
		expect(normalizeJob(null)).toBeNull();
	});

	it('builds a canonical result string with a stable field order', () => {
		const s = canonicalResult({
			jobId: 'j', node: 'n', model: 'm',
			inputHash: 'ih', outputHash: 'oh', latencyMs: 12.6, completedAt: 't',
		});
		expect(s).toBe([PROTOCOL, 'j', 'n', 'm', 'ih', 'oh', '13', 't'].join('\n'));
		expect(s.startsWith('threews-inference-v1\n')).toBe(true);
	});

	it('verifies a signed result and rejects tampering', () => {
		const kp = generateKeypair();
		const job = normalizeJob({ jobId: 'j9', input: { prompt: 'the prompt' }, model: 'm' });
		const record = buildResultRecord({
			job, node: kp.address, model: 'm', text: 'the output', tokens: 3,
			latencyMs: 42, completedAt: '2026-08-12T00:00:00.000Z',
		});
		const payload = canonicalResult({
			jobId: record.jobId, node: record.node, model: record.model,
			inputHash: record.inputHash, outputHash: record.outputHash,
			latencyMs: record.result.latencyMs, completedAt: record.completedAt,
		});
		const sig = signPayload(kp.secretKey, payload);
		expect(verifyResult({ job, record, signature: sig, verify: verifyPayload })).toBe(true);
		// Tampered output hash.
		expect(verifyResult({ job, record: { ...record, outputHash: sha256Hex('evil') }, signature: sig, verify: verifyPayload })).toBe(false);
		// Tampered job binding.
		expect(verifyResult({ job: { ...job, jobId: 'other' }, record, signature: sig, verify: verifyPayload })).toBe(false);
		// Wrong signer.
		const wrong = generateKeypair();
		expect(verifyResult({ job, record: { ...record, node: wrong.address }, signature: sig, verify: verifyPayload })).toBe(false);
		// Tampered text no longer matches the signed output hash.
		expect(verifyResult({ job, record: { ...record, result: { ...record.result, text: 'changed' } }, signature: sig, verify: verifyPayload })).toBe(false);
	});
});

describe('coordinator client', () => {
	it('sends bearer auth and normalizes claim responses', async () => {
		const seen = [];
		const fetchImpl = async (url, init) => {
			seen.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
			if (url.endsWith('/jobs/claim')) {
				return new Response(JSON.stringify({ job: { jobId: 'j1', input: { prompt: 'p' } } }), { status: 200 });
			}
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		};
		const client = new CoordinatorClient({
			baseUrl: 'https://example.test/', secret: 's', nodeAddress: 'nodeAddr', fetchImpl,
		});
		await client.register({ capabilities: {}, models: ['m'] });
		const job = await client.claimJob();
		await client.submitResult({ jobId: 'j1' }, 'sig');
		expect(seen[0].auth).toBe('Bearer s');
		expect(seen[0].url).toBe('https://example.test/api/inference/nodes/register');
		expect(seen[0].body.node).toBe('nodeAddr');
		expect(seen[0].body.version).toBe(CLIENT_VERSION);
		expect(seen[1].url).toBe('https://example.test/api/inference/jobs/claim');
		expect(job.jobId).toBe('j1');
		expect(seen[2].url).toBe('https://example.test/api/inference/jobs/submit');
		expect(seen[2].body.signature).toBe('sig');
	});

	it('returns null on an empty queue and throws on HTTP errors', async () => {
		const empty = new CoordinatorClient({
			baseUrl: 'https://example.test', nodeAddress: 'n',
			fetchImpl: async () => new Response(JSON.stringify({ job: null }), { status: 200 }),
		});
		expect(await empty.claimJob()).toBeNull();
		const failing = new CoordinatorClient({
			baseUrl: 'https://example.test', nodeAddress: 'n',
			fetchImpl: async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }),
		});
		await expect(failing.claimJob()).rejects.toThrow(/500 boom/);
	});
});

describe('engine (real model)', () => {
	let tokenizer;
	let engine;
	beforeAll(async () => {
		await ensureModel({ cacheDir: CACHE });
		tokenizer = await BpeTokenizer.load(CACHE);
		engine = await loadEngine({ cacheDir: CACHE, modelId: MODEL_ID });
	}, 300_000);

	it('tokenizer round-trips text and matches known GPT-2 ids', () => {
		// Ground truth from the GPT-2 tokenizer: "Hello" -> 15496, " world" -> 995.
		const ids = tokenizer.encode('Hello world');
		expect(ids).toEqual([15496, 995]);
		expect(tokenizer.decode(ids)).toBe('Hello world');
		// Contractions and punctuation exercise the pre-tokenizer branches.
		const roundTrip = "I'm testing: 3.14, don't split weirdly!";
		expect(tokenizer.decode(tokenizer.encode(roundTrip))).toBe(roundTrip);
	});

	it('generates deterministic text from the real distilgpt2 weights', async () => {
		const a = await engine.generate('The three.ws open inference network lets anyone', 8);
		const b = await engine.generate('The three.ws open inference network lets anyone', 8);
		expect(a.tokens).toBe(8);
		expect(a.text.length).toBeGreaterThan(0);
		expect(a.text).toBe(b.text);
		expect(sha256Hex(a.text)).toBe(sha256Hex(b.text));
		expect(a.latencyMs).toBeGreaterThan(0);
	}, 120_000);
});

describe('end-to-end loop (in-process coordinator)', () => {
	it('registers, claims one job, and the coordinator verifies the signature', async () => {
		const kp = generateKeypair();
		const secret = 'test-worker-secret-0123456789';
		const job = {
			jobId: `e2e-${Date.now()}`,
			type: JOB_TYPE,
			model: MODEL_ID,
			input: { prompt: 'A node operator proves honest inference by' },
			maxTokens: 6,
			issuedAt: new Date().toISOString(),
		};
		const { server, registered, submitted } = createLocalCoordinator({ secret, jobs: [job] });
		await new Promise((r) => server.listen(0, '127.0.0.1', r));
		const baseUrl = `http://127.0.0.1:${server.address().port}`;
		try {
			const engine = await loadEngine({ cacheDir: CACHE, modelId: MODEL_ID });
			const client = new CoordinatorClient({ baseUrl, secret, nodeAddress: kp.address });
			await client.register({ capabilities: { jobTypes: [JOB_TYPE] }, models: [MODEL_ID] });
			expect(registered.has(kp.address)).toBe(true);

			const events = [];
			const runner = new NodeRunner({
				client, engine, keypair: kp, pollMs: 50, maxJobs: 1, onEvent: (e) => events.push(e),
			});
			const { completed } = await runner.run();
			expect(completed).toBe(1);

			const entry = submitted.get(job.jobId);
			expect(entry).toBeTruthy();
			// Independent verification pass on the receipt.
			expect(verifyResult({ job: normalizeJob(job), record: entry.record, signature: entry.signature, verify: verifyPayload })).toBe(true);
			expect(entry.record.node).toBe(kp.address);
			expect(entry.record.result.text.length).toBeGreaterThan(0);
			expect(entry.record.inputHash).toBe(sha256Hex(job.input.prompt));
			expect(events.some((e) => e.type === 'claimed')).toBe(true);
			expect(events.some((e) => e.type === 'completed')).toBe(true);
		} finally {
			server.close();
		}
	}, 180_000);

	it('the coordinator rejects a forged signature', async () => {
		const kp = generateKeypair();
		const attacker = generateKeypair();
		const secret = 'test-worker-secret-0123456789';
		const job = { jobId: `forgery-${Date.now()}`, input: { prompt: 'p' }, maxTokens: 4 };
		const { server } = createLocalCoordinator({ secret, jobs: [job] });
		await new Promise((r) => server.listen(0, '127.0.0.1', r));
		const baseUrl = `http://127.0.0.1:${server.address().port}`;
		try {
			const client = new CoordinatorClient({ baseUrl, secret, nodeAddress: kp.address });
			const normalized = normalizeJob(job);
			const record = buildResultRecord({
				job: normalized, node: kp.address, model: MODEL_ID, text: 'x', tokens: 1,
				latencyMs: 1, completedAt: new Date().toISOString(),
			});
			// Sign with the WRONG key: must be refused.
			const payload = canonicalResult({
				jobId: record.jobId, node: record.node, model: record.model,
				inputHash: record.inputHash, outputHash: record.outputHash,
				latencyMs: record.result.latencyMs, completedAt: record.completedAt,
			});
			const forged = signPayload(attacker.secretKey, payload);
			await expect(client.submitResult(record, forged)).rejects.toThrow(/422/);
		} finally {
			server.close();
		}
	});
});
