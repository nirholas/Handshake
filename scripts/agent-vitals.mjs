#!/usr/bin/env node
// scripts/agent-vitals.mjs
//
// "Why is this armed agent not doing anything?" answered in one command.
//
// Attests every armed sniper arm against live systems (strategies table,
// position ledger, Solana RPC, launch feed, model chain, deployed image) and
// prints the ROOT blocker per arm plus the command that fixes it. Symptoms are
// suppressed: an arm blocked by a dead model chain that is itself caused by a
// stale deployment reports the deployment, not the chain.
//
// Read-only. It never signs, funds, deploys, or closes anything.
//
// Usage:
//   npm run agent:vitals                    # attest the mainnet fleet
//   node scripts/agent-vitals.mjs --json    # machine-readable
//   node scripts/agent-vitals.mjs --no-llm  # skip the model probe (it costs a token or two)
//   node scripts/agent-vitals.mjs --network devnet
//
// Env: DATABASE_URL (.env.local). SOLANA_RPC_URL and Google credentials are
// optional: without them those probes report `unknown`, never a false verdict.

import { readFileSync } from 'node:fs';

for (const file of ['.env.local', '.env']) {
	try {
		for (const line of readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split('\n')) {
			const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
			if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
		}
	} catch { /* file absent: env may already be exported */ }
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const skipLlm = args.includes('--no-llm');
const networkArg = args.indexOf('--network');
const network = networkArg >= 0 && args[networkArg + 1] ? args[networkArg + 1] : 'mainnet';

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL is not set. It lives in .env.local (Neon) or on the Cloud Run service.');
	process.exit(1);
}

const { attestFleet, summarizeFleet, SNIPER_SERVICE } = await import('../api/_lib/agent-vitals/sniper-probe.js');

// The in-process image probe needs a platform credential (metadata server or a
// service-account key). An operator running this from a laptop usually has only
// a gcloud CLI login, so read it from gcloud when that is what is available.
// This is the single most valuable reading in the report and losing it to a
// credential shape would gut the tool.
async function imageBuiltAtFromGcloud() {
	try {
		const { execFile } = await import('node:child_process');
		const { promisify } = await import('node:util');
		const { stdout } = await promisify(execFile)('gcloud', [
			'artifacts', 'docker', 'images', 'list',
			`us-central1-docker.pkg.dev/aerial-vehicle-466722-p5/workers/${SNIPER_SERVICE}`,
			'--sort-by=~CREATE_TIME', '--limit=1',
			'--project', 'aerial-vehicle-466722-p5',
			'--format=value(createTime)',
		], { timeout: 90_000 });
		const line = String(stdout).trim().split('\n')[0];
		return line && Number.isFinite(Date.parse(line)) ? new Date(line).toISOString() : null;
	} catch {
		return null;
	}
}

const { probeDeployedImageAge } = await import('../api/_lib/agent-vitals/sniper-probe.js');
const imageBuiltAt = (await probeDeployedImageAge()) ?? (await imageBuiltAtFromGcloud());

const fleet = await attestFleet({ network, includeCognition: !skipLlm, imageBuiltAt });
const summary = summarizeFleet(fleet.arms);

if (asJson) {
	console.log(JSON.stringify({ ...fleet, arms: fleet.arms.map((a) => ({ ...a, verdict: a.verdict.toJSON() })), summary }, null, 2));
	process.exit(0);
}

const MARK = { ready: 'CAN ACT', unable: 'CANNOT ACT', unknown: 'UNKNOWN' };
const statusOf = (arm) => (arm.verdict.can.enter === true ? 'ready' : arm.verdict.can.enter === false ? 'unable' : 'unknown');

console.log(`\nAGENT VITALS  ·  ${network}  ·  ${fleet.at.slice(0, 16).replace('T', ' ')} UTC`);
console.log('Capability attestation, not liveness: can each armed arm actually open a position right now?\n');

console.log('SHARED READINGS (taken once for the whole fleet)');
console.log(`  RPC        ${fleet.shared.rpc.ok === true ? 'up' : fleet.shared.rpc.ok === false ? 'DOWN' : 'unknown'}  ${fleet.shared.rpc.detail}`);
console.log(`  model      ${fleet.shared.cognition.ok === true ? 'up' : fleet.shared.cognition.ok === false ? 'DOWN' : 'unknown'}  ${fleet.shared.cognition.detail}`);
console.log(`  feed       newest launch ${fleet.shared.feed_fresh_at ? `at ${fleet.shared.feed_fresh_at.slice(0, 16).replace('T', ' ')}` : 'unread'}`);
console.log(`  image      ${fleet.shared.image_built_at ? `built ${fleet.shared.image_built_at.slice(0, 10)}` : 'unread (no Google credential in this environment)'}`);

console.log('\nPER ARM');
for (const arm of fleet.arms) {
	const status = statusOf(arm);
	console.log(`\n  ${arm.name}${arm.label ? `  [${arm.label}]` : ''}  ${MARK[status]}`);
	console.log(`    ${arm.activity}${arm.stalled ? '  (STALLED)' : ''}`);
	if (status === 'ready') {
		// Nothing is broken, so the entry filters are the answer. Saying that
		// plainly stops an operator hunting infrastructure that is already fine.
		console.log(arm.stalled
			? '    every precondition is up: this arm is capable and its entry filters are simply not matching'
			: '    every precondition is up');
	} else {
		for (const root of arm.verdict.rootCauses) {
			console.log(`    ROOT  ${root.id} is ${root.status}${root.detail ? `: ${root.detail}` : ''}`);
			if (root.remedy) console.log(`          fix: ${root.remedy}`);
		}
		const symptoms = arm.verdict.vitals.filter((v) => v.status === 'blocked').map((v) => v.id);
		if (symptoms.length) console.log(`    (blocked downstream, not probed: ${symptoms.join(', ')})`);
	}
	if (arm.verdict.can.exit !== true) console.log('    cannot close open positions either');
	// The ledger gets a vote. If it disproves the verdict, say so here rather
	// than letting a wrong model quietly win the argument against reality.
	if (arm.contradiction) console.log(`    CONTRADICTION  ${arm.contradiction}`);
}

console.log('\nFLEET');
console.log(`  ${summary.ready}/${summary.total} arms can open a position now · ${summary.unable} cannot · ${summary.unknown} unreadable`);
console.log(`  ${summary.canExit}/${summary.total} can still close an open position`);
if (summary.stalledButCapable.length) {
	console.log(`  Capable but silent (filters, not faults): ${summary.stalledButCapable.join(', ')}`);
}

if (summary.contradictions.length) {
	console.log('\nMODEL CONTRADICTED BY THE LEDGER');
	for (const line of summary.contradictions) console.log(`  ${line}`);
}

if (summary.rootCauses.length) {
	console.log('\nWORK QUEUE (deduplicated across the fleet, widest blast radius first)');
	for (const cause of summary.rootCauses) {
		console.log(`  ${cause.id}  blocks ${cause.arms.length} arm${cause.arms.length === 1 ? '' : 's'}: ${cause.arms.join(', ')}`);
		// One shared cause does not mean one shared fix. Five starved wallets are
		// five transfers, so every distinct remedy is printed, not a representative.
		for (const remedy of cause.remedies) console.log(`    ${remedy}`);
	}
} else {
	console.log('\nWORK QUEUE  empty: nothing is blocking the fleet.');
}
console.log('');
