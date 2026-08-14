#!/usr/bin/env node
/**
 * three.ws node operator client: entry point.
 *
 *   node src/index.js                  register (if needed) and run the job loop
 *   node src/index.js --register-only  register with the platform and exit
 *   node src/index.js --self-test      run the proof workload locally and exit
 *   node src/index.js --pubkey         print this node's public key and exit
 *
 * All configuration is env-first (see README.md); nothing here prompts.
 */

import { join } from 'node:path';
import { loadConfig } from './config.js';
import { resolveIdentity, defaultIdentityPath } from './identity.js';
import { createPlatformClient } from './platform.js';
import { createJobLoop } from './loop.js';
import { selfTest } from './inference.js';

const args = new Set(process.argv.slice(2));
const MODELS_DIR = join(process.cwd(), 'models');

async function main() {
	const cfg = loadConfig();
	const identityPath = cfg.identityPath.startsWith('/')
		? cfg.identityPath
		: join(process.cwd(), cfg.identityPath);
	const { identity, source } = resolveIdentity({
		envSecret: cfg.secretKey,
		identityPath,
	});

	if (args.has('--pubkey')) {
		console.log(identity.publicKey);
		return;
	}

	console.log(`[node] identity ${identity.publicKey} (${source === 'generated' ? `generated, saved to ${identityPath}` : `from ${source}`})`);
	console.log(`[node] platform ${cfg.platformUrl} · capability ${cfg.capability} · model ${cfg.model} · device ${cfg.device}`);

	if (args.has('--self-test')) {
		console.log('[node] running proof workload self-test (first run downloads the model)...');
		const result = await selfTest({ cacheDir: MODELS_DIR, device: cfg.device, dtype: cfg.dtype });
		console.log(`[node] self-test ${result.ok ? 'OK' : 'FAILED'}: ${result.model}, ${result.dimensions} dims, ran on ${result.device} (${result.dtype}) in ${result.elapsedMs}ms`);
		process.exit(result.ok ? 0 : 1);
	}

	const client = createPlatformClient({ platformUrl: cfg.platformUrl, identity });
	const capabilities = [{ capability: cfg.capability, model: cfg.model }];

	console.log('[node] registering with platform...');
	const reg = await client.register({ label: cfg.label, capabilities });
	console.log(`[node] registered as node ${reg?.node?.id ?? '(id assigned by platform)'}`);

	if (args.has('--register-only')) return;

	const loop = createJobLoop({
		client,
		identity,
		capability: cfg.capability,
		pollIntervalMs: cfg.pollIntervalMs,
		maxConcurrency: cfg.maxConcurrency,
		jobTimeoutMs: cfg.jobTimeoutMs,
		cacheDir: MODELS_DIR,
		device: cfg.device,
		dtype: cfg.dtype,
	});

	const shutdown = (signal) => {
		console.log(`[node] ${signal} received; finishing in-flight jobs and shutting down`);
		loop.stop();
	};
	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));

	console.log(`[node] polling every ${cfg.pollIntervalMs / 1000}s (max ${cfg.maxConcurrency} concurrent). Ctrl+C to stop.`);
	await loop.run();
	console.log(`[node] stopped. completed=${loop.stats.completed} failed=${loop.stats.failed}`);
}

main().catch((err) => {
	console.error(`[node] fatal: ${err.message}`);
	process.exit(1);
});
