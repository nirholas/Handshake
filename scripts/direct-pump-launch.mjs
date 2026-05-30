#!/usr/bin/env node
// Direct pump.fun launcher — bypasses 3D-Agent's server entirely.
// Talks straight to @pump-fun/pump-sdk + Solana RPC so we can isolate
// whether the SDK / RPC / keypair path itself works.
//
// Usage:
//   node scripts/direct-pump-launch.mjs gen          # generate a fresh wallet
//   node scripts/direct-pump-launch.mjs balance      # show wallet + SOL balance
//   node scripts/direct-pump-launch.mjs launch <name> <symbol> <metadataUrl> [--buy <sol>]
//                                                    # launch a coin
//
// Keypair lives at .fresh-pump-wallet.json (gitignored).

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
	Connection,
	Keypair,
	PublicKey,
	TransactionMessage,
	VersionedTransaction,
	LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { PumpSdk, OnlinePumpSdk, getBuyTokenAmountFromSolAmount } from '@pump-fun/pump-sdk';
import BN from 'bn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WALLET_PATH = path.join(REPO_ROOT, '.fresh-pump-wallet.json');

// Load .env.local so HELIUS_API_KEY is available.
function loadDotenv() {
	const p = path.join(REPO_ROOT, '.env.local');
	if (!fs.existsSync(p)) return;
	for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
		const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
		if (!m) continue;
		if (process.env[m[1]] === undefined) {
			process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
		}
	}
}
loadDotenv();

const RPC_URL = process.env.SOLANA_RPC_URL
	|| (process.env.HELIUS_API_KEY
		? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
		: 'https://api.mainnet-beta.solana.com');

function loadKeypair() {
	if (!fs.existsSync(WALLET_PATH)) {
		throw new Error(`No wallet at ${WALLET_PATH}. Run: node scripts/direct-pump-launch.mjs gen`);
	}
	const secret = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
	return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function cmdGen() {
	if (fs.existsSync(WALLET_PATH)) {
		const kp = loadKeypair();
		console.log('Wallet already exists.');
		console.log('Address:', kp.publicKey.toBase58());
		console.log('File:   ', WALLET_PATH);
		return;
	}
	const kp = Keypair.generate();
	fs.writeFileSync(WALLET_PATH, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
	console.log('Fresh wallet generated.');
	console.log('Address:', kp.publicKey.toBase58());
	console.log('File:   ', WALLET_PATH, '(gitignored, 0600)');
	console.log('');
	console.log('Fund this address with SOL on mainnet, then run:');
	console.log('  node scripts/direct-pump-launch.mjs balance');
}

async function cmdBalance() {
	const kp = loadKeypair();
	const conn = new Connection(RPC_URL, 'confirmed');
	const lamports = await conn.getBalance(kp.publicKey);
	console.log('Address:', kp.publicKey.toBase58());
	console.log('RPC:    ', RPC_URL.replace(/api-key=[^&]+/, 'api-key=***'));
	console.log('Balance:', (lamports / LAMPORTS_PER_SOL).toFixed(6), 'SOL');
}

async function cmdLaunch(name, symbol, uri, opts) {
	// name/symbol may be intentionally empty (a "no name / no ticker" coin), so we
	// only require the metadata URI here.
	if (name === undefined || symbol === undefined || !uri) {
		throw new Error('Usage: launch <name> <symbol> <metadataUrl> [--buy <sol>]');
	}
	const buySol = opts.buy ? parseFloat(opts.buy) : 0;
	if (Number.isNaN(buySol) || buySol < 0) throw new Error('Invalid --buy value');

	// Tokenized-agent launch with creator-fee buyback. --buyback-bps 10000 = 100%.
	const buyBackBps = opts['buyback-bps'] !== undefined ? parseInt(opts['buyback-bps'], 10) : 0;
	if (Number.isNaN(buyBackBps) || buyBackBps < 0 || buyBackBps > 10000) {
		throw new Error('Invalid --buyback-bps (0..10000)');
	}
	const isTokenizedAgent = buyBackBps > 0;
	if (isTokenizedAgent && buySol <= 0) {
		throw new Error('A tokenized-agent launch (--buyback-bps) requires a dev buy: pass --buy <sol>');
	}

	const kp = loadKeypair();
	const conn = new Connection(RPC_URL, 'confirmed');

	console.log('Creator:  ', kp.publicKey.toBase58());
	console.log('RPC:      ', RPC_URL.replace(/api-key=[^&]+/, 'api-key=***'));

	const lamports = await conn.getBalance(kp.publicKey);
	console.log('Balance:  ', (lamports / LAMPORTS_PER_SOL).toFixed(6), 'SOL');
	const minNeeded = 0.022 + buySol; // pump.fun base cost + buy
	if (lamports / LAMPORTS_PER_SOL < minNeeded) {
		throw new Error(`Need at least ~${minNeeded.toFixed(3)} SOL; have ${(lamports / LAMPORTS_PER_SOL).toFixed(4)}`);
	}

	const mintKp = Keypair.generate();
	console.log('Mint:     ', mintKp.publicKey.toBase58());
	console.log('Name:     ', name);
	console.log('Symbol:   ', symbol);
	console.log('Metadata: ', uri);
	console.log('Buy-in:   ', buySol, 'SOL');
	console.log('Agent:    ', isTokenizedAgent ? `tokenized, buyback ${buyBackBps} bps (${buyBackBps / 100}%)` : 'no');
	console.log('');

	// Offline SDK builds instructions; online SDK reads on-chain global state.
	const offline = new PumpSdk();
	const online = new OnlinePumpSdk(conn);

	const instructions = [];
	if (buySol > 0) {
		console.log('→ fetchGlobal...');
		const global = await online.fetchGlobal();
		const solAmount = new BN(Math.floor(buySol * LAMPORTS_PER_SOL));
		const tokenAmount = getBuyTokenAmountFromSolAmount({
			global,
			feeConfig: null,
			mintSupply: null,
			bondingCurve: null,
			amount: solAmount,
		});
		console.log('→ createAndBuyInstructions...');
		const ixs = await offline.createAndBuyInstructions({
			global,
			mint: mintKp.publicKey,
			name, symbol, uri,
			creator: kp.publicKey,
			user: kp.publicKey,
			solAmount,
			amount: tokenAmount,
			isTokenizedAgent,
			buyBackBps,
		});
		instructions.push(...(Array.isArray(ixs) ? ixs : [ixs]));
	} else {
		console.log('→ createInstruction...');
		const ix = await offline.createInstruction({
			mint: mintKp.publicKey,
			name, symbol, uri,
			creator: kp.publicKey,
			user: kp.publicKey,
		});
		instructions.push(...(Array.isArray(ix) ? ix : [ix]));
	}
	console.log('Instructions built:', instructions.length);

	// Send one v0 transaction, simulate-then-send-then-confirm. Returns the sig.
	async function sendTx(ixs, signers, { simulate = true } = {}) {
		const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
		const msg = new TransactionMessage({
			payerKey: kp.publicKey,
			recentBlockhash: blockhash,
			instructions: ixs,
		}).compileToV0Message();
		const tx = new VersionedTransaction(msg);
		tx.sign(signers);
		if (simulate) {
			const sim = await conn.simulateTransaction(tx, { sigVerify: false });
			if (sim.value.err) {
				console.error('Simulation failed:', JSON.stringify(sim.value.err));
				for (const l of sim.value.logs || []) console.error('  ', l);
				throw new Error('aborting before send (simulation failed)');
			}
			console.log('  sim OK, CU:', sim.value.unitsConsumed);
		}
		const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
		console.log('  sig:', sig);
		const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
		if (conf.value.err) throw new Error('Confirmation error: ' + JSON.stringify(conf.value.err));
		return sig;
	}

	// A tokenized-agent launch is 4 instructions — too big for one tx. Split:
	// tx1 creates the mint + dev buy, tx2 initializes the agent (after the mint
	// exists on-chain). The agent-init is the last instruction in the array.
	if (isTokenizedAgent && instructions.length > 3) {
		const agentIx = instructions.pop();
		console.log('→ tx1: create + buy...');
		const sig1 = await sendTx(instructions, [kp, mintKp]);
		console.log('  Solscan:', 'https://solscan.io/tx/' + sig1);
		console.log('→ tx2: initialize tokenized agent (buyback ' + buyBackBps / 100 + '%)...');
		const sig2 = await sendTx([agentIx], [kp], { simulate: false });
		console.log('  Solscan:', 'https://solscan.io/tx/' + sig2);
	} else {
		console.log('→ submit...');
		const sig = await sendTx(instructions, [kp, mintKp]);
		console.log('  Solscan:', 'https://solscan.io/tx/' + sig);
	}

	console.log('');
	console.log('LAUNCHED.');
	console.log('Mint:     ', mintKp.publicKey.toBase58());
	console.log('pump.fun: https://pump.fun/coin/' + mintKp.publicKey.toBase58());
}

function parseArgs(argv) {
	const cmd = argv[2];
	const rest = argv.slice(3);
	const positional = [];
	const opts = {};
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a.startsWith('--')) {
			opts[a.slice(2)] = rest[++i];
		} else {
			positional.push(a);
		}
	}
	return { cmd, positional, opts };
}

const { cmd, positional, opts } = parseArgs(process.argv);

try {
	if (cmd === 'gen') await cmdGen();
	else if (cmd === 'balance') await cmdBalance();
	else if (cmd === 'launch') await cmdLaunch(positional[0], positional[1], positional[2], opts);
	else {
		console.error('Usage:');
		console.error('  node scripts/direct-pump-launch.mjs gen');
		console.error('  node scripts/direct-pump-launch.mjs balance');
		console.error('  node scripts/direct-pump-launch.mjs launch <name> <symbol> <metadataUrl> [--buy <sol>]');
		process.exit(1);
	}
} catch (e) {
	console.error('ERROR:', e.message);
	if (e.logs) for (const l of e.logs) console.error('  ', l);
	process.exit(1);
}
