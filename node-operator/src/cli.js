#!/usr/bin/env node
// three.ws inference node operator client.
//
//   node src/cli.js generate-key                 print a fresh node keypair
//   node src/cli.js register                     register this node, then exit
//   node src/cli.js run                          register, then run the job loop
//   node src/cli.js verify <file>                verify a signed result record
//   node src/cli.js selftest [--keep-server]     local end-to-end proof:
//                                                spins up a real HTTP
//                                                coordinator, registers,
//                                                serves one job, verifies the
//                                                signed result, exits
//
// Config is env-only (see README.md):
//   BASE_URL            coordinator base URL (default https://three.ws)
//   NODE_SECRET_KEY     node keypair (base58/base64/JSON; generate-key makes one)
//   NODE_WORKER_SECRET  shared worker secret for the coordinator (16+ chars)
//   MODEL_CACHE_DIR     model download cache (default ./.model-cache)
//   MODEL_ID            Hugging Face model id (default Xenova/distilgpt2)
//   MODEL_REVISION      revision/branch to pin (default main)
//   POLL_MS             job poll cadence (default 3000)
//   MAX_JOBS            stop after N jobs (default: run forever)
//   NODE_ENDPOINT_URL   public callback URL advertised at registration (optional)

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { generateKeypair, loadKeypair, verifyPayload } from './identity.js';
import { loadEngine } from './engine.js';
import { CoordinatorClient, CLIENT_VERSION } from './client.js';
import { NodeRunner } from './runner.js';
import { buildResultRecord, canonicalResult, normalizeJob, verifyResult, sha256Hex } from './codec.js';

const log = (...a) => console.log(`[node ${new Date().toISOString()}]`, ...a);

function env(name, fallback) {
	const v = process.env[name];
	return v === undefined || v === '' ? fallback : v;
}

function requireKeypair() {
	const secret = env('NODE_SECRET_KEY');
	if (!secret) {
		console.error('NODE_SECRET_KEY is not set. Run `node src/cli.js generate-key` first.');
		process.exit(1);
	}
	try {
		return loadKeypair(secret);
	} catch (err) {
		console.error(String(err.message || err));
		process.exit(1);
	}
}

function makeClient(keypair) {
	return new CoordinatorClient({
		baseUrl: env('BASE_URL', 'https://three.ws'),
		secret: env('NODE_WORKER_SECRET'),
		nodeAddress: keypair.address,
		log,
	});
}

function capabilities() {
	return {
		protocol: 'threews-inference-v1',
		jobTypes: ['llm.completion'],
		gpu: process.env.CUDA_VISIBLE_DEVICES !== undefined && process.env.CUDA_VISIBLE_DEVICES !== '',
		clientVersion: CLIENT_VERSION,
		platform: process.platform,
		arch: process.arch,
	};
}

async function cmdGenerateKey() {
	const kp = generateKeypair();
	console.log('Node address (public, safe to share):');
	console.log(`  ${kp.address}`);
	console.log('Node secret key (keep private; set as NODE_SECRET_KEY):');
	console.log(`  ${kp.secretBase58}`);
}

async function cmdRegister() {
	const keypair = requireKeypair();
	const client = makeClient(keypair);
	const modelId = env('MODEL_ID', 'Xenova/distilgpt2');
	const res = await client.register({
		capabilities: capabilities(),
		models: [modelId],
		endpoint: env('NODE_ENDPOINT_URL'),
	});
	log('registered as', keypair.address, JSON.stringify(res));
}

async function cmdRun() {
	const keypair = requireKeypair();
	const client = makeClient(keypair);
	const cacheDir = env('MODEL_CACHE_DIR', new URL('../.model-cache', import.meta.url).pathname);

	log('node address:', keypair.address);
	await client.register({
		capabilities: capabilities(),
		models: [env('MODEL_ID', 'Xenova/distilgpt2')],
		endpoint: env('NODE_ENDPOINT_URL'),
	});
	log('registered with coordinator');

	const engine = await loadEngine({
		cacheDir,
		modelId: env('MODEL_ID', 'Xenova/distilgpt2'),
		revision: env('MODEL_REVISION', 'main'),
		log,
	});

	const runner = new NodeRunner({
		client,
		engine,
		keypair,
		pollMs: Number(env('POLL_MS', 3000)),
		maxJobs: Number(env('MAX_JOBS', Infinity)),
		onEvent: (e) => log(e.type, JSON.stringify(e)),
	});
	process.on('SIGINT', () => runner.stop());
	process.on('SIGTERM', () => runner.stop());
	const { completed } = await runner.run();
	log(`stopped after ${completed} job(s)`);
}

async function cmdVerify(file) {
	const doc = JSON.parse(await readFile(file, 'utf8'));
	const { job, result, signature } = doc;
	if (!job || !result || !signature) {
		console.error('verify expects { job, result, signature } as produced by selftest or a coordinator receipt');
		process.exit(1);
	}
	const normalized = normalizeJob(job);
	const ok = verifyResult({ job: normalized, record: result, signature, verify: verifyPayload });
	if (!ok) {
		console.error('INVALID: signature, hashes, or job binding do not check out');
		process.exit(1);
	}
	console.log('VALID');
	console.log(`  node:      ${result.node}`);
	console.log(`  job:       ${result.jobId}`);
	console.log(`  model:     ${result.model}`);
	console.log(`  input:     sha256 ${result.inputHash}`);
	console.log(`  output:    sha256 ${result.outputHash}`);
	console.log(`  tokens:    ${result.result.tokens}, latency: ${result.result.latencyMs} ms`);
	console.log(`  signature: ${signature.slice(0, 24)}...`);
}

// A real, self-contained coordinator for the local end-to-end proof. It
// implements the same wire contract the platform coordinator uses (register,
// claim, submit with bearer auth), holds one in-memory job, and cryptographi-
// cally verifies the node's signed result before accepting it. This is the
// proof workload harness, not a production coordinator: it keeps everything
// in process memory and serves exactly the jobs it was constructed with.
export function createLocalCoordinator({ secret, jobs }) {
	const registered = new Map();
	const queue = [...jobs];
	const submitted = new Map();
	const server = createServer((req, res) => {
		const send = (code, obj) => {
			res.writeHead(code, { 'content-type': 'application/json' });
			res.end(JSON.stringify(obj));
		};
		if (req.method !== 'POST') return send(405, { error: 'method_not_allowed' });
		const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
		if (!secret || bearer !== secret) return send(401, { error: 'unauthorized' });
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			let parsed = null;
			try {
				parsed = JSON.parse(body || '{}');
			} catch {
				return send(400, { error: 'invalid_json' });
			}
			if (req.url === '/api/inference/nodes/register') {
				if (!parsed.node) return send(400, { error: 'node required' });
				registered.set(parsed.node, parsed);
				log('coordinator: registered node', parsed.node);
				return send(200, { ok: true, node: parsed.node });
			}
			if (req.url === '/api/inference/jobs/claim') {
				const job = queue.shift() || null;
				return send(200, { job });
			}
			if (req.url === '/api/inference/jobs/submit') {
				const { signature, ...record } = parsed;
				const job = record?.jobId ? jobs.find((j) => (j.jobId || j.job_id) === record.jobId) : null;
				const normalized = job ? normalizeJob(job) : null;
				if (!normalized) return send(404, { error: 'unknown_job' });
				const ok = verifyResult({ job: normalized, record, signature, verify: verifyPayload });
				if (!ok) return send(422, { error: 'invalid_signature' });
				submitted.set(record.jobId, { record, signature });
				return send(200, { ok: true, verified: true, jobId: record.jobId });
			}
			return send(404, { error: 'not_found' });
		});
	});
	return { server, registered, submitted };
}

async function cmdSelftest() {
	const secret = env('NODE_WORKER_SECRET', 'selftest-worker-secret-0123456789');
	process.env.NODE_WORKER_SECRET = secret;

	const keypair = requireKeypair();
	const jobs = [
		{
			jobId: `selftest-${Date.now()}`,
			type: 'llm.completion',
			model: env('MODEL_ID', 'Xenova/distilgpt2'),
			input: { prompt: env('SELFTEST_PROMPT', 'The three.ws open inference network lets anyone') },
			maxTokens: Number(env('SELFTEST_MAX_TOKENS', 16)),
			issuedAt: new Date().toISOString(),
		},
	];

	const { server, registered, submitted } = createLocalCoordinator({ secret, jobs });
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;
	const baseUrl = `http://127.0.0.1:${port}`;
	log('local coordinator listening on', baseUrl);

	try {
		const client = new CoordinatorClient({ baseUrl, secret, nodeAddress: keypair.address, log });
		const modelId = env('MODEL_ID', 'Xenova/distilgpt2');
		await client.register({ capabilities: capabilities(), models: [modelId] });
		log('register: accepted =', registered.has(keypair.address));

		const engine = await loadEngine({
			cacheDir: env('MODEL_CACHE_DIR', new URL('../.model-cache', import.meta.url).pathname),
			modelId,
			revision: env('MODEL_REVISION', 'main'),
			log,
		});

		const runner = new NodeRunner({ client, engine, keypair, pollMs: 250, maxJobs: 1, onEvent: (e) => log(e.type, JSON.stringify({ ...e, signature: e.signature ? `${e.signature.slice(0, 20)}...` : undefined })) });
		const { completed } = await runner.run();

		const entry = submitted.get(jobs[0].jobId);
		if (completed !== 1 || !entry) {
			console.error('selftest failed: job was not completed and verified');
			process.exitCode = 1;
			return;
		}

		// Independent verification pass: recompute the canonical payload and the
		// output hash from the submitted record, then check the signature with
		// only the node's public address.
		const record = entry.record;
		const recomputed = canonicalResult({
			jobId: record.jobId,
			node: record.node,
			model: record.model,
			inputHash: record.inputHash,
			outputHash: record.outputHash,
			latencyMs: record.result.latencyMs,
			completedAt: record.completedAt,
		});
		const sigOk = verifyPayload(record.node, recomputed, entry.signature);
		const hashOk = record.outputHash === sha256Hex(record.result.text);
		log('verified: signature =', sigOk, ', output hash =', hashOk);
		console.log('\n--- selftest receipt ---');
		console.log(JSON.stringify({ job: jobs[0], result: record, signature: entry.signature }, null, 2));
		if (!sigOk || !hashOk) process.exitCode = 1;
	} finally {
		server.close();
	}
}

const cmd = process.argv[2];
// Only run the CLI when invoked directly (`node src/cli.js ...`), not when a
// test imports createLocalCoordinator from this module.
const isMain = (() => {
	try {
		return process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
	} catch {
		return false;
	}
})();

if (isMain) {
	try {
		switch (cmd) {
			case 'generate-key':
				await cmdGenerateKey();
				break;
			case 'register':
				await cmdRegister();
				break;
			case 'run':
				await cmdRun();
				break;
			case 'verify':
				await cmdVerify(process.argv[3]);
				break;
			case 'selftest':
				await cmdSelftest();
				break;
			default:
				console.error('usage: node src/cli.js <generate-key|register|run|verify|selftest>');
				process.exit(cmd ? 1 : 0);
		}
	} catch (err) {
		console.error('fatal:', err?.message || err);
		process.exit(1);
	}
}
