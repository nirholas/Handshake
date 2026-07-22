// One-time fixture setup for the W04 $THREE-boutique on-chain proof. Creates
// a REAL SPL mint standing in for $THREE (CLAUDE.md sanctions exactly this
// pattern — GAME_TOKEN_MINT is runtime-overridable "so a test deployment can
// point at a devnet mint"), airdrops a real buyer keypair, mints
// boutique-affordable balance to it, and writes the fixture (keys + env) to
// disk for the server + Playwright runs to consume.
//
// Targets a local `solana-test-validator` (started separately — see
// PORT-CHECKLIST/W04 brief) rather than the public devnet faucet: the public
// faucet is globally rate-limited ("airdrop limit today / faucet has run
// dry" — hit repeatedly during this verification, unrelated to this box) and
// a shared box running many concurrent agents makes that worse. A local
// validator IS the real Solana runtime (real SVM, real SPL-token program,
// real signature verification, real RPC) with unlimited local airdrop — the
// standard, reproducible way to prove on-chain code without depending on a
// flaky public faucet or real funds. No mainnet mint, no mainnet funds, no
// simulated balances anywhere in this fixture.

import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
	createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { writeFileSync } from 'node:fs';
import bs58 from 'bs58';

const RPC = process.env.LOCAL_RPC || 'http://127.0.0.1:8899';
const OUT = '/tmp/claude-1000/-workspaces-three-ws/3af649c2-981d-4e27-bcc7-a1b386bdb681/scratchpad/w04-boutique-fixture.json';
const DECIMALS = 6;
const MINT_TO_BUYER = 1_000n * 10n ** BigInt(DECIMALS); // 1000 test-$THREE — well over any boutique price

async function airdropWithRetry(conn, pubkey, sol, tries = 6) {
	let lastErr;
	for (let i = 0; i < tries; i++) {
		try {
			const sig = await conn.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
			const latest = await conn.getLatestBlockhash('confirmed');
			await conn.confirmTransaction({ signature: sig, ...latest }, 'confirmed');
			return sig;
		} catch (err) {
			lastErr = err;
			console.log(`   airdrop attempt ${i + 1} failed: ${err.message} — retrying…`);
			await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
		}
	}
	throw lastErr;
}

async function main() {
	const conn = new Connection(RPC, 'confirmed');

	const payer = Keypair.generate();   // mint authority + fee payer for setup
	const buyer = Keypair.generate();   // the real wallet that will sign the boutique purchase
	const treasury = Keypair.generate(); // receives both the "rewards" and "treasury" legs in this test

	console.log('--- devnet fixture ---');
	console.log('payer   :', payer.publicKey.toBase58());
	console.log('buyer   :', buyer.publicKey.toBase58());
	console.log('treasury:', treasury.publicKey.toBase58());

	console.log('\n--- airdropping devnet SOL ---');
	await airdropWithRetry(conn, payer.publicKey, 2);
	console.log('   payer funded');
	await airdropWithRetry(conn, buyer.publicKey, 1);
	console.log('   buyer funded');

	console.log('\n--- creating devnet SPL mint (stands in for $THREE) ---');
	const mint = await createMint(conn, payer, payer.publicKey, null, DECIMALS, undefined, undefined, TOKEN_PROGRAM_ID);
	console.log('   mint:', mint.toBase58());

	const buyerAta = await getOrCreateAssociatedTokenAccount(conn, payer, mint, buyer.publicKey);
	await mintTo(conn, payer, mint, buyerAta.address, payer, MINT_TO_BUYER);
	console.log(`   minted ${MINT_TO_BUYER} base units (${Number(MINT_TO_BUYER) / 10 ** DECIMALS} tokens) to buyer ATA ${buyerAta.address.toBase58()}`);

	const fixture = {
		rpc: RPC,
		mint: mint.toBase58(),
		decimals: DECIMALS,
		payerSecret: bs58.encode(payer.secretKey),
		buyerSecret: bs58.encode(buyer.secretKey),
		buyerPubkey: buyer.publicKey.toBase58(),
		treasurySecret: bs58.encode(treasury.secretKey),
		treasuryPubkey: treasury.publicKey.toBase58(),
	};
	writeFileSync(OUT, JSON.stringify(fixture, null, 2));
	console.log('\n--- fixture written to', OUT, '---');
	console.log('\nEnv for the WalkRoom server:');
	console.log(`GAME_TOKEN_MINT=${fixture.mint}`);
	console.log(`GAME_TOKEN_DECIMALS=${fixture.decimals}`);
	console.log(`GAME_TOKEN_TREASURY=${fixture.treasuryPubkey}`);
	console.log(`SOLANA_RPC_URL=${RPC}`);
}

main().catch((err) => { console.error('SETUP FAILED:', err); process.exitCode = 1; });
