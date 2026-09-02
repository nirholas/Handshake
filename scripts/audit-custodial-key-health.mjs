#!/usr/bin/env node
// Audit every custodial Solana wallet the platform stores, and report how much
// SOL sits behind a secret we can no longer decrypt.
//
// Why this exists: the treasury self-heal (api/cron/treasury-topup.js) reclaims
// idle SOL from platform-owned agent wallets back to the master fee wallet when
// the master runs short. A wallet whose `encrypted_solana_secret` fails AES-GCM
// decryption cannot be signed for, so its balance is invisible to that self-heal
// and to every other spend path. The failure is silent by construction: the
// reclaim leg reports a failed SEND, and a WebCrypto OperationError wearing a
// Solana costume sends operators after RPC health and funding for a key problem
// no amount of either can fix (2026-08-01: the entire reclaimable balance the
// engine planned to pull was behind two such wallets).
//
// A key rotation is the usual cause. `scripts/rekey-stale-launch-wallets.mjs`
// documents one: the WALLET_ENCRYPTION_KEY changed during the Vercel to Cloud
// Run migration in 2026-07, and every wallet written under the retired key
// became unreadable. This script measures the blast radius of that class;
// `docs/ops/stranded-wallets.md` carries the standing owner decision on the
// customer balances it finds.
//
// READ-ONLY. It decrypts in memory to test the key, never writes, never signs,
// never broadcasts. Balances are read with getMultipleAccounts (100 per call) so
// a full fleet sweep costs a handful of RPC requests rather than one per wallet.
//
// Usage:
//   node scripts/audit-custodial-key-health.mjs
//   node scripts/audit-custodial-key-health.mjs --json
//   node scripts/audit-custodial-key-health.mjs --platform-only
//
// Env (read from .env / .env.local, or the process env):
//   DATABASE_URL, WALLET_ENCRYPTION_KEY, JWT_SECRET, SOLANA_RPC_URL
//
// Exits 3 without touching the database when no decryption key is configured:
// a keyless run can only report 100% undecryptable, which says nothing about
// production. Exit 0 otherwise, stranded fleet or not.

import { readFileSync } from 'node:fs';

const AS_JSON = process.argv.includes('--json');
const PLATFORM_ONLY = process.argv.includes('--platform-only');

// In --json mode stdout carries ONE value: the report. The Solana connection
// lane logs its failovers ("[solana-rpc] ... demoting that method") on stdout,
// and a single such line ahead of the payload makes the whole thing unparseable
// to anything reading stdout as JSON. That is not hypothetical: it is what left
// the gcp-triage custodial-keys probe blind with "unparseable custodial audit
// output" while the audit itself was working fine. Diagnostics belong on stderr
// here, so a human still sees them and the parser still gets clean JSON. The
// report is written through emitJson, which keeps the real stdout writer.
const emitJson = console.log.bind(console);
if (AS_JSON) console.log = (...args) => console.error(...args);


// Where an operator actually gets the key. The playbook order in CLAUDE.md:
// local dotfiles first, then the running service, then Secret Manager.
const KEY_FIX_HINT = [
	'  Set WALLET_ENCRYPTION_KEY (>=32 chars) and re-run. Where to find it:',
	'    .env / .env.local in this repo, or',
	'    gcloud run services describe three-ws-api --region us-central1 \\',
	'      --project aerial-vehicle-466722-p5 --format=yaml, or',
	'    gcloud secrets versions access latest --secret=WALLET_ENCRYPTION_KEY',
].join('\n');

for (const file of ['.env', '.env.local']) {
	let text;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		continue;
	}
	for (const line of text.split('\n')) {
		const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
	}
}

// The measurement itself lives in api/_lib/custodial-key-health.js, shared with
// the ops board (`stranded_custody` in /api/ops/payment-outcomes), so the number
// an operator reads here and the number the board renders cannot drift apart.
// This file is the CLI around it: env loading, the key guard, and rendering.
const { secretBoxKeyCandidates } = await import('../api/_lib/secret-box.js');
const { gatherCustodialKeyHealth } = await import('../api/_lib/custodial-key-health.js');

// A shell with NO decryption key configured cannot tell "sealed under a retired
// key" from "this machine was never given the key". Without this check the
// script decrypts nothing, reports 100% undecryptable, and prints the customer
// escalation banner on any developer machine missing WALLET_ENCRYPTION_KEY: a
// confident number that sends operators after the wrong problem, which is the
// same class of failure the unread-balance handling below exists to prevent.
// secret-box exports its candidate list precisely so this cannot drift from the
// precedence decryptSecret() actually uses.
const keyCandidates = secretBoxKeyCandidates();
if (keyCandidates.length === 0) {
	const blocked = {
		checked_at: new Date().toISOString(),
		error: 'no_decryption_key',
		detail:
			'No custodial decryption key is configured, so every wallet would read as ' +
			'undecryptable here regardless of production state. This run proves nothing ' +
			'about stranded funds.',
		fix: KEY_FIX_HINT,
	};
	if (AS_JSON) {
		emitJson(JSON.stringify(blocked, null, 2));
		process.exit(3);
	}
	console.error('custodial key health  ABORTED: no decryption key configured');
	console.error('');
	console.error('  Every wallet would report as undecryptable here regardless of production');
	console.error('  state, so this run cannot tell you anything about stranded funds.');
	console.error('');
	console.error(KEY_FIX_HINT);
	process.exit(3);
}

// One fleet scan: read every stored wallet, test every key, read every balance
// through the rotating multi-lane connection production uses. Totals sum only
// CONFIRMED balance reads, so an RPC failure reports `stranded_unread` instead of
// a confident zero (the 2026-08-09 blind spot).
const report = await gatherCustodialKeyHealth({
	platformOnly: PLATFORM_ONLY,
	keyCandidates: keyCandidates.length,
});

if (AS_JSON) {
	emitJson(JSON.stringify(report, null, 2));
	process.exit(0);
}

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');
console.log(`custodial key health  (${report.checked_at})`);
console.log(`  rpc                 ${report.rpc}`);
console.log(`  wallets             ${report.wallets} (${report.counts.platform} platform, ${report.counts.customer} customer)`);
console.log(`  decryptable         ${report.decryptable} (${pct(report.decryptable, report.wallets)})`);
console.log(`  undecryptable       ${report.undecryptable} (${pct(report.undecryptable, report.wallets)}), ${report.counts.stranded_funded} confirmed funded, ${report.counts.stranded_unread} unread`);
console.log(`  read errors         ${report.read_errors}`);
console.log('');
if (report.counts.stranded_unread > 0) {
	console.log(`  SOL stranded        UNKNOWN: ${report.counts.stranded_unread} undecryptable wallet(s) never got a balance read`);
	console.log('                      (RPC failed for their chunk). Do NOT read this as "0 stranded".');
	console.log('                      Re-run once the RPC lane recovers, or set SOLANA_RPC_URL to a working lane.');
} else {
	console.log(`  SOL total           ${report.sol.total}`);
	console.log(`  SOL spendable       ${report.sol.decryptable}`);
	console.log(`  SOL stranded        ${report.sol.stranded}  (platform ${report.sol.stranded_platform}, customer ${report.sol.stranded_customer})`);
}
if (report.top_stranded.length) {
	console.log('');
	console.log('  largest stranded wallets');
	for (const w of report.top_stranded) {
		console.log(`    ${String(w.sol).padStart(14)} SOL  ${w.address}  ${w.platform ? 'platform' : 'customer'}  ${w.name || ''} (${w.reason})`);
	}
}
// A fleet-wide 100% failure is almost never 725 separately sealed wallets: it is
// one wrong key. Saying so here keeps the escalation banner below from reading as
// a mass customer incident when the real fix is a one-line env correction.
if (report.wallets > 0 && report.undecryptable === report.wallets) {
	console.log('');
	console.log(`  EVERY wallet failed to decrypt under the ${report.key_candidates} configured key(s).`);
	console.log('  A fleet-wide 100% failure almost always means the key is wrong for this');
	console.log('  deployment, not that every wallet is sealed. Confirm the key matches');
	console.log('  production before treating this as a customer incident.');
	console.log('');
	console.log(KEY_FIX_HINT);
} else if (report.sol.stranded_customer > 0) {
	console.log('');
	console.log('  Customer funds are stranded. This is a support obligation, not just an');
	console.log('  ops number: those users cannot withdraw. Escalate before anything else.');
	console.log('  Decision brief: docs/ops/stranded-wallets.md');
}
process.exit(0);
