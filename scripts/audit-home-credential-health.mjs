#!/usr/bin/env node
// Can we still open the homes people connected?
//
// `home_connections.access_token_enc` is the platform's SECOND class of at-rest
// ciphertext under WALLET_ENCRYPTION_KEY, alongside the custodial wallet secrets
// that scripts/audit-custodial-key-health.mjs measures. A key rotation that loses
// the outgoing value seals both, and the two failures look nothing alike:
//
//   * a sealed wallet destroys custody. The SOL stays visible on chain and can
//     never be signed for again (docs/ops/wallet-key-migration.md).
//   * a sealed home token destroys REACH. No money is lost and nothing is
//     unrecoverable: the house is simply unreachable until its owner pastes a
//     fresh long-lived token. The cost is every connected home going dark at
//     once, with no signal anywhere that says why.
//
// That second failure has no on-chain balance to notice it by, which is exactly
// why it needs its own reading. Run this alongside the wallet audit on every
// rotation (step 3 of the runbook).
//
// Read-only: it decrypts in memory to test the key and writes nothing.
//
//   node scripts/audit-home-credential-health.mjs
//   node scripts/audit-home-credential-health.mjs --json
//
// Env: DATABASE_URL, plus a decryption key (WALLET_ENCRYPTION_KEY, or a retired
// one in WALLET_ENCRYPTION_KEY_PREVIOUS). Reads .env.local then .env.
// Exit codes: 2 no DATABASE_URL, 3 no decryption key at all, 1 something sealed.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

for (const file of ['.env.local', '.env']) {
	try {
		for (const line of readFileSync(path.join(ROOT, file), 'utf8').split('\n')) {
			const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
			if (!m || process.env[m[1]]) continue;
			let value = m[2].trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			process.env[m[1]] = value;
		}
	} catch { /* not present */ }
}

const json = process.argv.includes('--json');

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL is not set. Add it to .env.local or export it.');
	process.exit(2);
}

const { decryptSecret, secretBoxKeyCandidates } = await import('../api/_lib/secret-box.js');
const { sql } = await import('../api/_lib/db.js');

// The same guard the custodial audit learned to carry: a run with no key at all
// reports 100% sealed and means nothing. Say so instead of printing a verdict.
const keyCount = secretBoxKeyCandidates().length;
if (keyCount === 0) {
	console.error('No decryption key is configured, so every home would report as sealed regardless of');
	console.error('production state. Set WALLET_ENCRYPTION_KEY (Cloud Run service three-ws-api holds it:');
	console.error("  node scripts/read-service-env.mjs '^WALLET_ENCRYPTION_KEY$' --raw");
	process.exit(3);
}

const rows = await sql`
	select id, user_id, label, base_url, transport, status, last_ok_at, access_token_enc
	from home_connections
	where revoked_at is null
	order by created_at asc
`;

const sealed = [];
let readable = 0;
let pairing = 0;
for (const row of rows) {
	if (!row.access_token_enc) {
		// A relay home that has never handshaked holds an empty credential BY
		// DESIGN: the row is created before the add-on inside the house dials out
		// and there is nothing to encrypt yet (api/_lib/home/relay.js). Counting
		// those as sealed would make a healthy pairing queue read as an incident.
		if (row.transport === 'relay' && !row.last_ok_at) {
			pairing++;
			continue;
		}
		// Anywhere else an empty ciphertext on a LIVE row is a bug in revoke.
		sealed.push({ id: row.id, label: row.label, base_url: row.base_url, reason: 'empty ciphertext on a live row' });
		continue;
	}
	try {
		const plain = await decryptSecret(row.access_token_enc);
		if (plain) readable++;
		else sealed.push({ id: row.id, label: row.label, base_url: row.base_url, reason: 'decrypted to nothing' });
	} catch (err) {
		sealed.push({ id: row.id, label: row.label, base_url: row.base_url, reason: err?.message || 'decrypt failed' });
	}
}

const report = {
	homes: rows.length,
	readable,
	awaiting_pairing: pairing,
	sealed: sealed.length,
	key_candidates: keyCount,
	// Never the token, never a prefix of it: this report is safe to paste.
	sealed_homes: sealed.slice(0, 20),
	measured_at: new Date().toISOString(),
};

if (json) {
	console.log(JSON.stringify(report, null, 2));
} else {
	console.log('Home credential health');
	console.log(`  live homes          ${report.homes}`);
	console.log(`  openable            ${report.readable}`);
	console.log(`  awaiting pairing    ${report.awaiting_pairing} (relay homes whose add-on has not dialled out yet)`);
	console.log(`  sealed              ${report.sealed}`);
	console.log(`  keys tried          ${report.key_candidates}`);
	for (const home of report.sealed_homes) {
		console.log(`    ${home.base_url}  "${home.label}"  ${home.reason}`);
	}
	// "Every home is sealed" only means a wrong key when the failures are DECRYPT
	// failures. A live row with an empty ciphertext is a revoke bug, and telling an
	// operator to go hunt a retired key over one of those wastes the incident.
	const allDecryptFailures = sealed.length > 0 && sealed.every((h) => !h.reason.startsWith('empty ciphertext'));
	if (report.sealed > 0 && report.sealed === report.homes && allDecryptFailures) {
		console.log('');
		console.log('EVERY home is sealed. That is one wrong key for this deployment, not a fleet of');
		console.log('separately broken homes. Put the outgoing key in WALLET_ENCRYPTION_KEY_PREVIOUS');
		console.log('before concluding anything (docs/ops/wallet-key-migration.md).');
	} else if (report.sealed > 0) {
		console.log('');
		console.log('Sealed homes stay listed in the product and fail on connect. Nothing is lost:');
		console.log('their owners reconnect with a fresh long-lived token. Tell them, do not wait for');
		console.log('them to notice their lights stopped answering.');
	}
}

process.exit(report.sealed > 0 ? 1 : 0);
