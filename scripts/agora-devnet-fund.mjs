#!/usr/bin/env node
// Spread devnet SOL across the agora-citizens fleet signers.
//
// Why this exists: the public devnet faucet is rate-limited per IP, so a fleet of
// N citizens cannot each call requestAirdrop (the worker's own ensureBalance()
// top-up gives up with a 429 after its backoff chain). Landing ONE airdrop into a
// single bank wallet and fanning it out with plain SystemProgram transfers gets
// the whole fleet funded from a single faucet grant.
//
// Usage:
//   node scripts/agora-devnet-fund.mjs <citizen-key> [<citizen-key> ...]
//   node scripts/agora-devnet-fund.mjs --list
//   node scripts/agora-devnet-fund.mjs --bank aria-sculpt echo-crier   # different bank
//   node scripts/agora-devnet-fund.mjs --sol 0.05 aria-sculpt          # amount per target
//
// A "citizen key" is the keypair cache name under workers/agora-citizens/.cache/
// (the roster key, e.g. `aria-sculpt`), which the life engine prints on a dry run:
//   AGORA_DRY_RUN=1 AGORA_ONCE=1 node workers/agora-citizens/index.js
//
// Devnet only, by construction: the RPC is pinned to a devnet endpoint and the
// script refuses to run against any other cluster. It never touches mainnet or
// $THREE. Fund the bank first at https://faucet.solana.com (or `solana airdrop`).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	Connection,
	Keypair,
	LAMPORTS_PER_SOL,
	SystemProgram,
	Transaction,
	sendAndConfirmTransaction,
} from '@solana/web3.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'workers', 'agora-citizens', '.cache');

const DEVNET_RPC =
	process.env.AGENC_DEVNET_RPC_URL || process.env.SOLANA_RPC_URL_DEVNET || 'https://api.devnet.solana.com';

if (!/devnet/i.test(DEVNET_RPC)) {
	console.error(`[agora-fund] refusing to run: RPC "${DEVNET_RPC}" is not a devnet endpoint. This script is devnet-only.`);
	process.exit(2);
}

function parseArgs(argv) {
	const out = { bank: 'agora-dispatcher', sol: 0.09, list: false, targets: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--list') out.list = true;
		else if (a === '--bank') out.bank = argv[++i];
		else if (a === '--sol') out.sol = Number(argv[++i]);
		else out.targets.push(a);
	}
	if (!Number.isFinite(out.sol) || out.sol <= 0) {
		throw new Error('--sol must be a positive number of SOL');
	}
	return out;
}

function cacheKeys() {
	if (!fs.existsSync(CACHE_DIR)) return [];
	return fs
		.readdirSync(CACHE_DIR)
		.filter((f) => f.endsWith('.json'))
		.map((f) => f.replace(/\.json$/, ''));
}

function loadKeypair(name) {
	const file = path.join(CACHE_DIR, `${name}.json`);
	if (!fs.existsSync(file)) {
		throw new Error(
			`no cached keypair "${name}". Run the engine once (AGORA_DRY_RUN=1 AGORA_ONCE=1 node workers/agora-citizens/index.js) to mint the fleet's signers, then re-run. Known: ${cacheKeys().join(', ') || '(none)'}`,
		);
	}
	return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));
}

const args = parseArgs(process.argv.slice(2));
const conn = new Connection(DEVNET_RPC, 'confirmed');

// The public devnet RPC drops requests and slows to double-digit seconds once an
// IP has been hammered, and a single transient `fetch failed` should never abort
// a listing or strand a half-funded fleet.
async function balanceOf(pubkey, attempts = 6) {
	let lastErr;
	for (let i = 0; i < attempts; i++) {
		try {
			return await conn.getBalance(pubkey);
		} catch (err) {
			lastErr = err;
			await new Promise((r) => setTimeout(r, 1_000 * (i + 1)));
		}
	}
	throw new Error(`balance read failed for ${pubkey.toBase58()} after ${attempts} tries: ${lastErr?.message || lastErr}`);
}

if (args.list || args.targets.length === 0) {
	const keys = cacheKeys();
	if (!keys.length) {
		console.log('[agora-fund] no cached signers yet: run the engine once to mint them.');
		process.exit(0);
	}
	console.log(`[agora-fund] cached devnet signers (${DEVNET_RPC}):`);
	for (const k of keys) {
		const kp = loadKeypair(k);
		const bal = await balanceOf(kp.publicKey);
		console.log(`  ${k.padEnd(28)} ${kp.publicKey.toBase58()}  ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
	}
	if (!args.list) console.log('\nPass one or more signer names to fund them from the bank wallet.');
	process.exit(0);
}

const bank = loadKeypair(args.bank);
const perTarget = Math.floor(args.sol * LAMPORTS_PER_SOL);
// Leave the bank enough to pay its own transfer fees and stay a working signer.
const BANK_RESERVE_LAMPORTS = 10_000_000; // 0.01 SOL

const bankStart = await balanceOf(bank.publicKey);
console.log(`[agora-fund] bank ${args.bank} ${bank.publicKey.toBase58()}: ${(bankStart / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

let spent = 0;
let funded = 0;
for (const name of args.targets) {
	if (name === args.bank) {
		console.log(`  skip ${name} (is the bank)`);
		continue;
	}
	const kp = loadKeypair(name);
	const have = await balanceOf(kp.publicKey);
	if (have >= perTarget) {
		console.log(`  skip ${name}: already holds ${(have / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
		continue;
	}
	const need = perTarget - have;
	if (bankStart - spent - need < BANK_RESERVE_LAMPORTS) {
		console.error(
			`  STOP ${name}: bank would drop below its ${(BANK_RESERVE_LAMPORTS / LAMPORTS_PER_SOL).toFixed(3)} SOL reserve. Top the bank up at https://faucet.solana.com`,
		);
		break;
	}
	const tx = new Transaction().add(
		SystemProgram.transfer({ fromPubkey: bank.publicKey, toPubkey: kp.publicKey, lamports: need }),
	);
	const sig = await sendAndConfirmTransaction(conn, tx, [bank], { commitment: 'confirmed' });
	spent += need;
	funded++;
	console.log(`  funded ${name.padEnd(24)} ${kp.publicKey.toBase58()}  +${(need / LAMPORTS_PER_SOL).toFixed(4)} SOL  ${sig}`);
}

const bankEnd = await balanceOf(bank.publicKey);
console.log(`[agora-fund] funded ${funded}/${args.targets.length}; bank now ${(bankEnd / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
