/**
 * End-to-end local proof for the node operator client:
 *
 *   1. boot an in-process Redis shim (Upstash wire format)
 *   2. boot the real platform server (server/index.mjs) against it
 *   3. enqueue a real inference job into the platform queue
 *   4. run the real operator client (register -> poll -> execute -> sign -> submit)
 *   5. read the job back and cryptographically verify the result receipt
 *
 * Run: node scripts/e2e-local.mjs
 * Exits 0 only when every step above succeeded and the receipt verified.
 *
 * The proof uses the REAL model (Xenova/all-MiniLM-L6-v2) so the "job" is
 * genuine inference, not a stub. First run downloads ~90MB of weights into
 * ./models; subsequent runs reuse the cache.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRedisShim } from '../tests/redis-shim.js';
import { createIdentity } from '../src/identity.js';
import { verifyResult } from '../src/signing.js';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dirname, '..');
const PORT = 3199;
const PLATFORM = `http://127.0.0.1:${PORT}`;

const log = (...a) => console.log('[e2e]', ...a);

async function waitFor(url, tries = 60) {
	for (let i = 0; i < tries; i++) {
		try {
			const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
			if (r.status > 0) return true;
		} catch { /* not up yet */ }
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`server at ${url} did not come up`);
}

async function main() {
	// 1. Redis shim.
	const shim = createRedisShim();
	const redisUrl = await shim.listen();
	log('redis shim up at', redisUrl);

	// 2. Platform server against the shim.
	const server = spawn(process.execPath, [join(PKG, '../../server/index.mjs')], {
		env: {
			...process.env,
			PORT: String(PORT),
			UPSTASH_REDIS_REST_URL: redisUrl,
			UPSTASH_REDIS_REST_TOKEN: 'local-shim-token',
			// The node registry falls back to Redis-only when DATABASE_URL is
			// absent; leave it unset so this proof needs no Postgres.
			DATABASE_URL: '',
			NODE_ENV: 'production',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
	const serverUp = waitFor(`${PLATFORM}/api/version`).catch(() => waitFor(`${PLATFORM}/`));
	try {
		await serverUp;
		log('platform server up at', PLATFORM);

		// 3. Enqueue a real job directly into the queue the poll endpoint drains.
		//    (enqueueJob is the same function the agent runtime calls.)
		const shimClient = new (require('@upstash/redis').Redis)({ url: redisUrl, token: 'local-shim-token' });
		const jobId = `job_e2e_${Date.now()}`;
		const prompt = 'three.ws open inference network end-to-end proof';
		const job = {
			id: jobId,
			capability: 'text-embedding',
			model: 'Xenova/all-MiniLM-L6-v2',
			input: { text: prompt },
			status: 'queued',
			enqueuedAt: Date.now(),
			deadlineAt: Date.now() + 3600_000,
		};
		await shimClient.set(`ijob:${jobId}`, JSON.stringify(job), { ex: 3600 });
		await shimClient.rpush('iqueue:text-embedding', jobId);
		log('enqueued job', jobId);

		// 4. Run the real client. It registers, polls, runs the model, signs,
		//    and submits. Poll fast so the proof finishes quickly, then stop it
		//    once the job lands.
		const { createPlatformClient } = await import('../src/platform.js');
		const { createJobLoop } = await import('../src/loop.js');
		const identity = createIdentity();
		const client = createPlatformClient({ platformUrl: PLATFORM, identity });

		log('registering node', identity.publicKey);
		const reg = await client.register({ label: 'e2e-proof-node', capabilities: [{ capability: 'text-embedding', model: job.model }] });
		if (!reg?.ok) throw new Error('registration failed: ' + JSON.stringify(reg));
		log('registered:', JSON.stringify(reg.node));

		const loop = createJobLoop({
			client,
			identity,
			capability: 'text-embedding',
			pollIntervalMs: 250,
			cacheDir: join(PKG, 'models'),
			log,
		});
		const runP = loop.run();
		// Wait until the job completes (poll stats) or time out.
		const deadline = Date.now() + 300_000; // first run downloads the model
		while (loop.stats.completed === 0 && loop.stats.failed === 0 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 500));
		}
		loop.stop();
		await runP;
		if (loop.stats.completed !== 1) {
			throw new Error(`expected 1 completed job, got completed=${loop.stats.completed} failed=${loop.stats.failed}`);
		}
		log('client completed the job');

		// 5. Read the job back and verify the receipt cryptographically.
		const stored = JSON.parse(await shimClient.get(`ijob:${jobId}`));
		if (stored.status !== 'done') throw new Error(`job status is ${stored.status}, expected done`);
		const { output, receipt, startedAt, finishedAt } = stored;
		const verified = await verifyResult(
			{ jobId, model: output.model, prompt, output, startedAt, finishedAt },
			receipt,
		);
		if (!verified) throw new Error('receipt failed cryptographic verification');
		if (receipt.publicKey !== identity.publicKey) throw new Error('receipt pubkey mismatch');
		if (!Array.isArray(output.embedding) || output.embedding.length !== output.dimensions) {
			throw new Error('output embedding shape is wrong');
		}

		log('RESULT VERIFIED');
		console.log('\n--- e2e transcript ---');
		console.log('node public key :', identity.publicKey);
		console.log('job id          :', jobId);
		console.log('model           :', output.model);
		console.log('prompt          :', JSON.stringify(prompt));
		console.log('embedding dims  :', output.dimensions);
		console.log('embedding head  :', output.embedding.slice(0, 5).map((v) => v.toFixed(6)).join(', '), '...');
		console.log('inference time  :', finishedAt - startedAt, 'ms');
		console.log('receipt payload :', receipt.payload);
		console.log('receipt sig     :', receipt.signature.slice(0, 40) + '...');
		console.log('verified        :', verified, '(recomputed payload + ed25519 against node key)');
	} finally {
		server.kill('SIGTERM');
		await shim.close();
	}
}

main().then(() => {
	console.log('\nE2E PASS');
	process.exit(0);
}).catch((err) => {
	console.error('\nE2E FAIL:', err.message);
	process.exit(1);
});
