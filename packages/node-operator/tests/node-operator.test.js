/**
 * Unit tests for the node operator client's pure layers: identity, signing,
 * config, and the job loop. The wire client is exercised against a stub
 * fetch; the inference model itself is covered by the end-to-end proof
 * (scripts/e2e-local.mjs) rather than re-downloading weights in unit tests.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { deviceCandidates, defaultDtype, hasNvidiaDriver, DEVICES } from '../src/inference.js';
import { createRedisShim } from './redis-shim.js';
import {
	base58Encode,
	base58Decode,
	createIdentity,
	createIdentityFromSeed,
	parseSecretKey,
} from '../src/identity.js';
import { receiptPayload, signResult, verifyReceipt, verifyResult, sha256Hex } from '../src/signing.js';
import { loadConfig } from '../src/config.js';
import { createPlatformClient } from '../src/platform.js';
import { createJobLoop } from '../src/loop.js';

describe('identity', () => {
	it('round-trips base58 against a real ed25519 keypair', () => {
		// A real generated keypair's secret key must survive a base58 round
		// trip byte-for-byte; that is the persistence format.
		const identity = createIdentity();
		const bytes = identity.secretKey;
		expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
	});

	it('preserves leading zero bytes (Solana address convention)', () => {
		const bytes = new Uint8Array([0, 0, 0, 5, 6, 7]);
		expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
	});

	it('derives a stable base58 pubkey from a fixed secret key', () => {
		const seed = new Uint8Array(32).fill(0).map((_, i) => (i * 31 + 1) % 256);
		const a = createIdentityFromSeed(seed);
		const b = createIdentityFromSeed(seed);
		expect(a.publicKey).toBe(b.publicKey);
		expect(a.publicKey.length).toBeGreaterThanOrEqual(32);
		expect(a.publicKey.length).toBeLessThanOrEqual(44);
	});

	it('parses base58 and base64 secret keys identically', () => {
		const seed = new Uint8Array(32).fill(0).map((_, i) => (i * 17 + 3) % 256);
		const real = createIdentityFromSeed(seed);
		const secret = real.secretKey;
		const from58 = parseSecretKey(base58Encode(secret));
		const from64 = parseSecretKey(Buffer.from(secret).toString('base64'));
		expect(from58).toEqual(secret);
		expect(from64).toEqual(secret);
		// And both decode to a key that reproduces the same identity.
		expect(createIdentity(from58).publicKey).toBe(real.publicKey);
		expect(createIdentity(from64).publicKey).toBe(real.publicKey);
	});

	it('rejects malformed secret keys', () => {
		expect(() => parseSecretKey('not-a-key')).toThrow();
		expect(() => parseSecretKey(Buffer.from('short').toString('base64'))).toThrow();
	});
});

	function seedKey(tag) {
		const naclSeed = new Uint8Array(32).fill(0).map((_, i) => (i * 11 + tag) % 256);
		return createIdentityFromSeed(naclSeed);
	}

	describe('signing', () => {
	const identity = seedKey(5);
	const job = {
		jobId: 'job-123',
		model: 'Xenova/all-MiniLM-L6-v2',
		prompt: 'hello world',
		output: { kind: 'text-embedding', embedding: [0.1, 0.2] },
		startedAt: 1000,
		finishedAt: 1500,
	};

	it('sha256Hex matches the known empty-string digest', async () => {
		expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
	});

	it('produces a receipt that verifies against the node pubkey', async () => {
		const receipt = await signResult(identity, job);
		expect(receipt.algorithm).toBe('ed25519');
		expect(receipt.publicKey).toBe(identity.publicKey);
		expect(verifyReceipt(receipt, identity.publicKey)).toBe(true);
	});

	it('fails verification for a different claimed pubkey', async () => {
		const receipt = await signResult(identity, job);
		const other = createIdentity();
		expect(verifyReceipt(receipt, other.publicKey)).toBe(false);
	});

	it('fails verification when any job field is tampered with', async () => {
		const receipt = await signResult(identity, job);
		expect(await verifyResult(job, receipt)).toBe(true);
		expect(await verifyResult({ ...job, output: { kind: 'text-embedding', embedding: [9, 9] } }, receipt)).toBe(false);
		expect(await verifyResult({ ...job, jobId: 'job-999' }, receipt)).toBe(false);
		expect(await verifyResult({ ...job, prompt: 'tampered' }, receipt)).toBe(false);
	});

	it('is deterministic: same inputs produce the same payload', async () => {
		const p1 = await receiptPayload(job);
		const p2 = await receiptPayload({ ...job });
		expect(p1).toBe(p2);
	});

	it('rejects receipts with a wrong algorithm tag', async () => {
		const receipt = await signResult(identity, job);
		expect(verifyReceipt({ ...receipt, algorithm: 'secp256k1' }, identity.publicKey)).toBe(false);
	});
});

describe('config', () => {
	it('applies defaults when nothing is set', () => {
		const cfg = loadConfig({ env: {}, cwd: '/nonexistent-dir-that-has-no-config' });
		expect(cfg.platformUrl).toBe('https://three.ws');
		expect(cfg.capability).toBe('text-embedding');
		expect(cfg.pollIntervalMs).toBe(5000);
	});

	it('prefers env over file over defaults', () => {
		const cfg = loadConfig({
			env: { PLATFORM_URL: 'http://localhost:3101', POLL_INTERVAL_MS: '2000' },
			cwd: '/nonexistent-dir-that-has-no-config',
		});
		expect(cfg.platformUrl).toBe('http://localhost:3101');
		expect(cfg.pollIntervalMs).toBe(2000);
	});

	it('strips a trailing slash from platformUrl', () => {
		const cfg = loadConfig({ env: { PLATFORM_URL: 'https://three.ws/' }, cwd: '/nonexistent-dir-that-has-no-config' });
		expect(cfg.platformUrl).toBe('https://three.ws');
	});

	it('rejects a non-URL platformUrl', () => {
		expect(() => loadConfig({ env: { PLATFORM_URL: 'three.ws' }, cwd: '/nonexistent-dir-that-has-no-config' })).toThrow(/absolute http/);
	});

	it('rejects a too-small poll interval', () => {
		expect(() => loadConfig({ env: { POLL_INTERVAL_MS: '100' }, cwd: '/nonexistent-dir-that-has-no-config' })).toThrow(/POLL_INTERVAL_MS/);
	});

	it('defaults DEVICE to auto and accepts every documented device', () => {
		const cwd = '/nonexistent-dir-that-has-no-config';
		expect(loadConfig({ env: {}, cwd }).device).toBe('auto');
		for (const device of DEVICES) {
			expect(loadConfig({ env: { DEVICE: device.toUpperCase() }, cwd }).device).toBe(device);
		}
	});

	it('rejects an unknown DEVICE at boot rather than mid-job', () => {
		expect(() => loadConfig({ env: { DEVICE: 'tpu' }, cwd: '/nonexistent-dir-that-has-no-config' }))
			.toThrow(/DEVICE must be one of/);
	});
});

describe('device selection', () => {
	it('honors an explicit device with no fallback', () => {
		// An operator who asked for CUDA must get a hard failure on a host that
		// cannot do CUDA, not a silent month of CPU-speed earnings.
		expect(deviceCandidates('cuda', { platform: 'linux', arch: 'x64', gpu: false })).toEqual(['cuda']);
		expect(deviceCandidates('cpu', { platform: 'linux', arch: 'x64', gpu: true })).toEqual(['cpu']);
	});

	it('auto reaches for the GPU only when a driver is attached', () => {
		expect(deviceCandidates('auto', { platform: 'linux', arch: 'x64', gpu: true })).toEqual(['cuda', 'cpu']);
		// Without the probe this would try CUDA first and pull the 90MB fp32
		// graph on every CPU-only host before failing over.
		expect(deviceCandidates('auto', { platform: 'linux', arch: 'x64', gpu: false })).toEqual(['cpu']);
	});

	it('auto picks the platform-native accelerator elsewhere', () => {
		expect(deviceCandidates('auto', { platform: 'darwin', arch: 'arm64' })).toEqual(['coreml', 'cpu']);
		expect(deviceCandidates('auto', { platform: 'win32', arch: 'x64' })).toEqual(['dml', 'cpu']);
		expect(deviceCandidates('auto', { platform: 'linux', arch: 'arm64' })).toEqual(['cpu']);
	});

	it('detects the NVIDIA driver from the device nodes the container toolkit mounts', () => {
		const seen = [];
		const exists = (p) => { seen.push(p); return p === '/dev/nvidia0'; };
		expect(hasNvidiaDriver({ platform: 'linux', arch: 'x64', exists })).toBe(true);
		expect(seen).toContain('/dev/nvidiactl');
		expect(hasNvidiaDriver({ platform: 'linux', arch: 'x64', exists: () => false })).toBe(false);
		// CUDA on the bundled runtime is linux/x64 only; never probe elsewhere.
		expect(hasNvidiaDriver({ platform: 'darwin', arch: 'arm64', exists: () => true })).toBe(false);
	});

	it('matches weight precision to the device', () => {
		expect(defaultDtype('cpu')).toBe('q8');
		expect(defaultDtype('cuda')).toBe('fp32');
	});
});

describe('redis shim (the e2e harness itself)', () => {
	const require = createRequire(import.meta.url);

	/**
	 * The shim is test infrastructure, but two of its bugs cost a full debugging
	 * session each and both were invisible from the outside: the real Upstash
	 * client auto-pipelines (so every command arrived as POST /pipeline and came
	 * back "unknown command 'pipeline'"), and it base64-DECODES every string it
	 * receives (so a plain-text "job1" decoded to mojibake and the queue drained
	 * into nothing). Testing through the real client is the only way to catch
	 * either, so that is what this does.
	 */
	it('serves the real Upstash client over its auto-pipelined, base64 wire format', async () => {
		const shim = createRedisShim();
		const url = await shim.listen();
		try {
			const { Redis } = require('@upstash/redis');
			const client = new Redis({ url, token: 'shim' });

			await client.set('ijob:j1', JSON.stringify({ id: 'j1', status: 'queued' }), { ex: 60 });
			await client.rpush('iqueue:text-embedding', 'job1');

			// "job1" is itself valid base64, which is exactly what made the
			// encoding bug look like data corruption rather than a protocol bug.
			expect(await client.rpop('iqueue:text-embedding')).toBe('job1');
			expect(await client.rpop('iqueue:text-embedding')).toBeNull();

			const stored = await client.get('ijob:j1');
			const job = typeof stored === 'string' ? JSON.parse(stored) : stored;
			expect(job).toEqual({ id: 'j1', status: 'queued' });

			expect(await client.del('ijob:j1')).toBe(1);
			expect(await client.get('ijob:j1')).toBeNull();
		} finally {
			await shim.close();
		}
	});

	it('expires keys so a stale job cannot be claimed forever', async () => {
		const shim = createRedisShim();
		const url = await shim.listen();
		try {
			const { Redis } = require('@upstash/redis');
			const client = new Redis({ url, token: 'shim' });
			await client.set('ijob:gone', 'x', { ex: 60 });
			expect(shim._peek('ijob:gone').expiresAt).toBeGreaterThan(Date.now());
			shim._peek('ijob:gone').expiresAt = Date.now() - 1;
			expect(await client.get('ijob:gone')).toBeNull();
		} finally {
			await shim.close();
		}
	});
});

describe('platform client', () => {
	const identity = createIdentity();

	function stubFetch(handlers) {
		const calls = [];
		const fetchImpl = async (url, opts) => {
			calls.push({ url, opts });
			const u = new URL(url);
			for (const h of handlers) {
				if (u.pathname.startsWith(h.match)) {
					return {
						ok: h.ok ?? true,
						status: h.status ?? 200,
						text: async () => JSON.stringify(h.body),
					};
				}
			}
			return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not_found' }) };
		};
		return { fetchImpl, calls };
	}

	it('registers with a signature over the domain-separated register string', async () => {
		const { fetchImpl, calls } = stubFetch([{ match: '/api/nodes/register', body: { ok: true, node: { id: 'n1', publicKey: identity.publicKey } } }]);
		const client = createPlatformClient({ platformUrl: 'http://localhost:3101', identity, fetchImpl });
		const res = await client.register({ label: 'test node', capabilities: [{ capability: 'text-embedding', model: 'm' }] });
		expect(res.node.id).toBe('n1');
		const body = JSON.parse(calls[0].opts.body);
		expect(body.publicKey).toBe(identity.publicKey);
		expect(identity.verify(`threews-node-register:${identity.publicKey}:${body.registeredAt}`, body.signature)).toBe(true);
	});

	it('polls with a signed timestamp and returns null on an empty queue', async () => {
		const { fetchImpl, calls } = stubFetch([{ match: '/api/nodes/jobs', body: { job: null } }]);
		const client = createPlatformClient({ platformUrl: 'http://localhost:3101', identity, fetchImpl });
		expect(await client.pollJob({ capability: 'text-embedding' })).toBeNull();
		const u = new URL(calls[0].url);
		const ts = u.searchParams.get('ts');
		expect(identity.verify(`threews-node-poll:${identity.publicKey}:${ts}`, u.searchParams.get('sig'))).toBe(true);
	});

	it('submits results to the job-scoped URL with the receipt attached', async () => {
		const receipt = await signResult(identity, { jobId: 'j1', model: 'm', prompt: 'p', output: {}, startedAt: 1, finishedAt: 2 });
		const { fetchImpl, calls } = stubFetch([{ match: '/api/nodes/jobs/j1/result', body: { ok: true, verified: true } }]);
		const client = createPlatformClient({ platformUrl: 'http://localhost:3101', identity, fetchImpl });
		const res = await client.submitResult('j1', { output: {}, startedAt: 1, finishedAt: 2, receipt });
		expect(res.verified).toBe(true);
		expect(calls[0].url).toContain('/api/nodes/jobs/j1/result');
	});

	it('surfaces platform error text on non-2xx', async () => {
		const { fetchImpl } = stubFetch([{ match: '/api/nodes/register', ok: false, status: 401, body: { error: 'bad_signature' } }]);
		const client = createPlatformClient({ platformUrl: 'http://localhost:3101', identity, fetchImpl });
		await expect(client.register({ capabilities: [] })).rejects.toThrow(/bad_signature/);
	});
});

describe('job loop', () => {
	const identity = createIdentity();

	function makeClient(jobs) {
		const submitted = [];
		const failed = [];
		return {
			submitted,
			failed,
			pollJob: async () => jobs.shift() ?? null,
			submitResult: async (id, payload) => { submitted.push({ id, payload }); return { ok: true, verified: true }; },
			reportFailure: async (id, payload) => { failed.push({ id, payload }); return { ok: true }; },
		};
	}

	it('executes a polled job and submits a signed, verifiable result', async () => {
		const job = { id: 'j-loop-1', capability: 'text-embedding', model: 'm', input: { text: 'hi' } };
		const client = makeClient([job]);
		const loop = createJobLoop({
			client,
			identity,
			capability: 'text-embedding',
			pollIntervalMs: 10,
			// A deterministic stand-in for the real model: the loop contract is
			// what is under test here, not the tensor math.
			runJobImpl: async (j) => ({ output: { kind: 'text-embedding', model: j.model, embedding: [1, 2, 3], dimensions: 3 }, startedAt: 10, finishedAt: 20 }),
		});
		const run = loop.run();
		await new Promise((r) => setTimeout(r, 100));
		loop.stop();
		await run;

		expect(client.submitted).toHaveLength(1);
		expect(client.submitted[0].id).toBe('j-loop-1');
		expect(loop.stats.completed).toBe(1);
		const { payload } = client.submitted[0];
		expect(await verifyResult(
			{ jobId: 'j-loop-1', model: 'm', prompt: 'hi', output: payload.output, startedAt: 10, finishedAt: 20 },
			payload.receipt,
		)).toBe(true);
	});

	it('reports a failing job instead of crashing the loop', async () => {
		const client = makeClient([{ id: 'j-bad', capability: 'text-embedding', model: 'm', input: { text: '' } }]);
		const loop = createJobLoop({
			client,
			identity,
			capability: 'text-embedding',
			pollIntervalMs: 10,
			runJobImpl: async () => { throw new Error('input.text must be a non-empty string'); },
		});
		const run = loop.run();
		await new Promise((r) => setTimeout(r, 100));
		loop.stop();
		await run;

		expect(loop.stats.failed).toBe(1);
		expect(client.failed[0].payload.error).toMatch(/non-empty/);
		expect(client.submitted).toHaveLength(0);
	});
});
