#!/usr/bin/env node
// The economy wallet registry: generate fresh platform wallets, and keep a
// permanent log of every wallet the economy has ever used.
// ---------------------------------------------------------------------------
// Before this script the only record of a platform wallet was the env var
// holding its secret. Rotating a signer overwrote that var, and the previous
// address survived nowhere: reconciling an old settle or a July fee meant
// reading the chain and guessing. `economy_wallet_registry` (migration
// 20260819010000) is the durable log, and this is its operator surface.
//
// Roles are the signer names in api/_lib/solana-signers.js, which stays the
// source of truth for what each wallet pays for and the SOL floor it must hold.
//
// SECRET HANDLING: a generated secret is written to ONE file outside the repo
// with mode 0600 and is never printed, never logged, and never stored in the
// database. The registry records only the public address and WHERE the secret
// lives. Nothing here reads or writes Secret Manager or Cloud Run; the cutover
// command is printed for an operator to run, because putting a live signing key
// into production is a deliberate human act.
//
// Usage:
//   npm run economy:wallets -- list
//   npm run economy:wallets -- record --role economy-master --address <pubkey> --status active
//   npm run economy:wallets -- new --role economy-master [--vanity www] [--out <dir>]
//   npm run economy:wallets -- activate --role economy-master --address <pubkey>
//   npm run economy:wallets -- retire --role economy-master --address <pubkey>
//
// `new` never touches production. It generates, logs the address as `pending`,
// and prints the two steps that make it live (fund it, then set the env var).

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { SOLANA_SIGNERS } from '../api/_lib/solana-signers.js';
import { sql } from '../api/_lib/db.js';

const NETWORK = 'solana-mainnet';

// Some roles are ONE physical wallet read through several env vars. Rotating the
// role means moving every var in the set in the same cutover: the x402 ring
// advertises its receiver publicly (X402_PAY_TO_SOLANA) and co-signs with the
// matching secret, and a challenge that advertises one address while the server
// signs with another fails every settle against it. api/_lib/solana-signers.js
// documents the shared identity; this map is what an operator must not forget.
const ROLE_ALIAS_VARS = {
	'pump-x402-launcher': ['X402_PAY_TO_SOLANA (public address)', 'X402_TREASURY_SECRET_BASE58 (same secret, base58)'],
	'economy-master': ['X402_FEE_PAYER_SOLANA (public address, advertised on every 402 challenge)'],
};
const SERVICE = 'three-ws-api';
const REGION = 'us-central1';
const PROJECT = 'aerial-vehicle-466722-p5';

function parseArgs(argv) {
	const [command, ...rest] = argv;
	const flags = {};
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i];
		if (!token.startsWith('--')) continue;
		const eq = token.indexOf('=');
		if (eq > 2) {
			flags[token.slice(2, eq)] = token.slice(eq + 1);
			continue;
		}
		const name = token.slice(2);
		// Collect every following token up to the next flag, so an unquoted
		// multi-word value (npm strips one layer of quoting) survives intact.
		const words = [];
		while (i + 1 < rest.length && !rest[i + 1].startsWith('--')) words.push(rest[++i]);
		flags[name] = words.length ? words.join(' ') : true;
	}
	return { command, flags };
}

function specFor(role) {
	const spec = SOLANA_SIGNERS.find((s) => s.name === role);
	if (!spec) {
		const names = SOLANA_SIGNERS.map((s) => s.name).join(', ');
		throw new Error(`unknown role "${role}". Known roles: ${names}`);
	}
	return spec;
}

/** Encode a 64-byte secret key the way the role's env var is named. */
function encodeSecret(envVar, secretKey) {
	if (envVar.endsWith('_BASE58')) return bs58.encode(secretKey);
	return Buffer.from(secretKey).toString('base64');
}

/**
 * Grind a keypair until its address starts with `prefix` (case-insensitive).
 * Base58 has no vowel-free shortcuts, so a 3-character prefix is the practical
 * ceiling for an interactive run; anything longer is left to a dedicated tool.
 */
function generate(prefix) {
	if (!prefix) return Keypair.generate();
	const want = String(prefix).toLowerCase();
	if (want.length > 4) throw new Error('--vanity longer than 4 characters takes too long here');
	for (;;) {
		const kp = Keypair.generate();
		if (kp.publicKey.toBase58().toLowerCase().startsWith(want)) return kp;
	}
}

async function list(flags) {
	const role = flags.role || null;
	const rows = role
		? await sql`select * from economy_wallet_registry where role = ${role} order by role, created_at desc`
		: await sql`select * from economy_wallet_registry order by role, created_at desc`;
	if (!rows.length) {
		console.log('registry is empty. Record the live wallets first:');
		console.log('  npm run economy:wallets -- record --role <role> --address <pubkey> --status active');
		return;
	}
	console.log(`economy wallet registry (${rows.length} row(s))`);
	console.log('='.repeat(78));
	let currentRole = null;
	for (const r of rows) {
		if (r.role !== currentRole) {
			currentRole = r.role;
			console.log(`\n${r.role}`);
		}
		const mark = r.status === 'active' ? '●' : r.status === 'pending' ? '○' : '·';
		const when = (r.activated_at || r.created_at).toISOString().slice(0, 10);
		console.log(`  ${mark} ${r.status.padEnd(7)} ${r.address}  ${when}${r.rotated_from ? `  (rotated from ${r.rotated_from})` : ''}`);
		if (r.env_var) console.log(`      secret: ${r.secret_location || r.env_var}`);
	}
}

async function record(flags) {
	const role = requireFlag(flags, 'role');
	const address = requireFlag(flags, 'address');
	const spec = specFor(role);
	const status = flags.status || 'active';
	if (!['pending', 'active', 'retired'].includes(status)) throw new Error(`bad --status "${status}"`);
	if (status === 'active') await retireActive(role, address);
	const rows = await sql`
		insert into economy_wallet_registry
			(role, address, network, status, env_var, secret_location, purpose, notes, activated_at)
		values (
			${role}, ${address}, ${NETWORK}, ${status}, ${spec.env},
			${flags['secret-location'] || `cloud-run env ${spec.env}`},
			${spec.purpose}, ${flags.notes || null},
			${status === 'active' ? new Date().toISOString() : null}
		)
		on conflict (role, address, network) do update
			set status          = excluded.status,
			    env_var         = excluded.env_var,
			    secret_location = coalesce(excluded.secret_location, economy_wallet_registry.secret_location),
			    purpose         = excluded.purpose,
			    notes           = coalesce(excluded.notes, economy_wallet_registry.notes),
			    activated_at    = coalesce(economy_wallet_registry.activated_at, excluded.activated_at)
		returning id, status`;
	console.log(`recorded ${role} ${address} as ${rows[0].status}`);
}

/** Retire whatever currently holds the active slot for a role. */
async function retireActive(role, except) {
	const rows = await sql`
		update economy_wallet_registry
		   set status = 'retired', retired_at = now()
		 where role = ${role} and network = ${NETWORK} and status = 'active'
		   and address <> ${except || ''}
		returning address`;
	for (const r of rows) console.log(`retired previous ${role} wallet ${r.address}`);
	return rows.map((r) => r.address)[0] || null;
}

async function newWallet(flags) {
	const role = requireFlag(flags, 'role');
	const spec = specFor(role);
	const outDir = resolve(String(flags.out || join(homedir(), '.three-ws-wallets')));
	const kp = generate(flags.vanity === true ? null : flags.vanity);
	const address = kp.publicKey.toBase58();
	const encoded = encodeSecret(spec.env, kp.secretKey);

	mkdirSync(outDir, { recursive: true, mode: 0o700 });
	const outFile = join(outDir, `${role}.${address}.env`);
	writeFileSync(outFile, `${spec.env}=${encoded}\n`, { mode: 0o600 });
	chmodSync(outFile, 0o600);

	const [previous] = await sql`
		select address from economy_wallet_registry
		 where role = ${role} and network = ${NETWORK} and status = 'active' limit 1`;

	await sql`
		insert into economy_wallet_registry
			(role, address, network, status, env_var, secret_location, purpose, rotated_from, notes)
		values (${role}, ${address}, ${NETWORK}, 'pending', ${spec.env}, ${outFile}, ${spec.purpose},
		        ${previous?.address || null}, ${flags.notes || 'generated by scripts/economy-wallets.mjs'})
		on conflict (role, address, network) do nothing`;

	console.log(`\nfresh ${role} wallet`);
	console.log('='.repeat(78));
	console.log(`  address      ${address}`);
	console.log(`  secret file  ${outFile}  (mode 0600, outside the repo, never committed)`);
	console.log(`  env var      ${spec.env}`);
	console.log(`  needs        ${spec.minSol} SOL to clear its floor${spec.isMaster ? ' (funding root: fund it first)' : ''}`);
	if (previous) console.log(`  replaces     ${previous.address}`);
	console.log('\nlogged as pending. To make it live:');
	console.log(`  1. fund ${address} with at least ${spec.minSol} SOL`);
	console.log(`  2. gcloud run services update ${SERVICE} --region ${REGION} --project ${PROJECT} \\`);
	console.log(`       --update-env-vars "${spec.env}=$(cut -d= -f2- ${outFile})"`);
	console.log(`  3. npm run economy:wallets -- activate --role ${role} --address ${address}`);
	const aliases = ROLE_ALIAS_VARS[role];
	if (aliases) {
		console.log('\n  This role is read through more than one env var. Move them together,');
		console.log('  or the challenge advertises one address while the server signs with another:');
		for (const alias of aliases) console.log(`    ${alias}`);
	}
	if (spec.holdsTokens) {
		console.log('\n  This role HOLDS token balances. Sweep the old wallet before retiring it,');
		console.log('  or the float stays stranded at the previous address.');
	}
}

async function activate(flags) {
	const role = requireFlag(flags, 'role');
	const address = requireFlag(flags, 'address');
	specFor(role);
	const [row] = await sql`
		select status from economy_wallet_registry
		 where role = ${role} and address = ${address} and network = ${NETWORK} limit 1`;
	if (!row) throw new Error(`${role} ${address} is not in the registry. Record or generate it first.`);
	const previous = await retireActive(role, address);
	await sql`
		update economy_wallet_registry
		   set status = 'active', activated_at = coalesce(activated_at, now()), retired_at = null,
		       rotated_from = coalesce(rotated_from, ${previous})
		 where role = ${role} and address = ${address} and network = ${NETWORK}`;
	console.log(`${role} is now ${address}`);
	console.log('Confirm production agrees before trusting it:');
	console.log('  npm run audit:service-wallets');
}

async function retire(flags) {
	const role = requireFlag(flags, 'role');
	const address = requireFlag(flags, 'address');
	const rows = await sql`
		update economy_wallet_registry
		   set status = 'retired', retired_at = now()
		 where role = ${role} and address = ${address} and network = ${NETWORK}
		returning address`;
	if (!rows.length) throw new Error(`${role} ${address} is not in the registry`);
	console.log(`retired ${role} ${address}`);
}

function requireFlag(flags, name) {
	const value = flags[name];
	if (!value || value === true) throw new Error(`--${name} is required`);
	return String(value);
}

const { command, flags } = parseArgs(process.argv.slice(2));
const commands = { list, record, new: newWallet, activate, retire };
const run = commands[command];

if (!run) {
	console.error('usage: npm run economy:wallets -- <list|record|new|activate|retire> [flags]');
	console.error('       see the header of scripts/economy-wallets.mjs for every flag');
	process.exit(1);
}

try {
	await run(flags);
} catch (err) {
	console.error(`economy:wallets ${command}: ${err.message}`);
	process.exit(1);
}
