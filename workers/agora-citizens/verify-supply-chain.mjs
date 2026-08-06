#!/usr/bin/env node
// verify-supply-chain — exercise a single profession's WORK module end-to-end
// against the REAL three.ws APIs, then re-derive its proof the way a Verifier
// citizen (or the UI's Verify button) would. This is the Task 04 evidence path:
// it produces a real artifact, prints its deliverable URL + on-chain-shaped
// proofHash, and proves that re-downloading the deliverable reproduces the hash —
// the verifiable supply chain — WITHOUT needing devnet funds or the full loop.
//
//   node verify-supply-chain.mjs --profession sculptor --prompt "a low-poly fox"
//   node verify-supply-chain.mjs --profession scribe   --prompt "..."
//   node verify-supply-chain.mjs --profession sculptor --no-verify
//
// Env: THREE_WS_BASE_URL (default https://three.ws), S3_* (optional — without R2
// text/JSON deliverables are inline and binary ones fall back to the provider's
// durable URL, still re-downloadable).

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Load the repo .env when running from a checkout, BEFORE work/ (and through it
// api/_lib/r2.js) reads credentials at import time. Without this the harness
// silently degrades every deliverable to inline / provider-hosted and reads as
// "R2 is broken" when the keys were simply never loaded. Best effort: in the
// container there is no .env and the real environment already carries the vars.
const dotenv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(dotenv)) {
	try {
		process.loadEnvFile(dotenv);
	} catch {
		// malformed or unreadable .env: fall through to the ambient environment
	}
}

const { runProfession, hasRunner, ACTIVE_PROFESSIONS } = await import('./work/index.js');
const { runVerifier } = await import('./work/verifier.js');

function parseArgs(argv) {
	const args = { profession: 'sculptor', verify: true };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--profession' || a === '-p') args.profession = argv[++i];
		else if (a === '--prompt') args.prompt = argv[++i];
		else if (a === '--mint') args.mint = argv[++i];
		else if (a === '--name') args.name = argv[++i];
		else if (a === '--no-verify') args.verify = false;
		else if (a === '--base') args.base = argv[++i];
	}
	return args;
}

function hex(buf) {
	return Buffer.from(buf).toString('hex');
}

async function main() {
	const args = parseArgs(process.argv);
	if (!hasRunner(args.profession)) {
		console.error(`unknown profession "${args.profession}". Active: ${ACTIVE_PROFESSIONS.join(', ')}`);
		process.exit(2);
	}

	const apiBase = (args.base || process.env.THREE_WS_BASE_URL || 'https://three.ws').replace(/\/+$/, '');
	const cfg = { apiBase, log: (m) => console.error(`  · ${m}`) };
	// A synthetic worker identity (a real run derives this from the AgenC id).
	const citizen = { agentIdHex: hex(createHash('sha256').update(`verify:${args.profession}`).digest()), displayName: 'Verifier-Harness', pubkey: null };
	const job = {};
	if (args.prompt) job.prompt = args.prompt;
	if (args.mint) job.mint = args.mint;
	if (args.name) job.name = args.name;

	console.error(`\n▶ ${args.profession} working against ${apiBase} …`);
	const t0 = Date.now();
	let work;
	try {
		work = await runProfession(args.profession, { cfg, citizen, job });
	} catch (err) {
		console.error(`\n✗ ${args.profession} job FAILED (a real failure, honestly surfaced):\n  ${err?.message || err}`);
		process.exit(1);
	}

	console.log('\n── deliverable ─────────────────────────────────────────────');
	console.log(`profession      ${args.profession}`);
	console.log(`summary         ${work.summary}`);
	console.log(`deliverableUrl  ${work.deliverableUrl || '(inline — no R2 configured)'}`);
	console.log(`proofHash       ${work.proofHashHex}`);
	console.log(`resultData      ${hex(work.resultData).replace(/00+$/, '')}  (${work.resultData.length} bytes)`);
	console.log(`bytes           ${work.bytes?.toLocaleString?.() ?? work.bytes}`);
	console.log(`elapsed         ${((Date.now() - t0) / 1000).toFixed(1)}s`);

	if (work.deliverableUrl) {
		console.log('\n── verify command (re-download + re-hash) ──────────────────');
		const ext = args.profession === 'sculptor' ? 'glb' : args.profession === 'crier' ? 'bin' : 'txt';
		console.log(`curl -sL "${work.deliverableUrl}" -o /tmp/d.${ext} && sha256sum /tmp/d.${ext}`);
		console.log(`# expect: ${work.proofHashHex}`);
	}

	if (args.verify && work.deliverableUrl) {
		console.error('\n▶ Verifier re-deriving the proof …');
		const vCitizen = { agentIdHex: hex(createHash('sha256').update('citizen:vera').digest()), displayName: 'Vera' };
		const vouch = await runVerifier({
			cfg,
			citizen: vCitizen,
			job: { target: { deliverableUrl: work.deliverableUrl, proofHash: work.proofHashHex, profession: args.profession } },
		});
		console.log('\n── attestation (the trust loop) ────────────────────────────');
		console.log(`verdict         ${vouch.vouch.verdict.toUpperCase()}`);
		console.log(`recomputed      ${vouch.vouch.recomputed}`);
		console.log(`on-chain claim  ${vouch.vouch.claimed}`);
		console.log(`match           ${vouch.vouch.match ? '✓ proof re-derived' : '✗ MISMATCH'}`);
		if (!vouch.vouch.match) process.exit(1);
	}

	console.error('\n✓ done.\n');
}

main().catch((err) => {
	console.error('fatal:', err?.stack || err?.message || err);
	process.exit(1);
});
