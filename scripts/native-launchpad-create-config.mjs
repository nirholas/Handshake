#!/usr/bin/env node
// Create the three.ws partner config for the native launchpad (Meteora DBC).
//
// One-shot per network. The config account is a fresh keypair that signs its
// own creation; after it lands, pin the printed pubkey in the environment:
//   devnet  -> NATIVE_LAUNCH_CONFIG_KEY_DEVNET
//   mainnet -> NATIVE_LAUNCH_CONFIG_KEY
//
// Usage:
//   node scripts/native-launchpad-create-config.mjs --network devnet
//   node scripts/native-launchpad-create-config.mjs --network devnet --airdrop
//   node scripts/native-launchpad-create-config.mjs --network mainnet
//
// The payer/partner keypair comes from NATIVE_LAUNCH_PARTNER_SECRET_BASE58,
// falling back to X402_TREASURY_SECRET_BASE58 (the platform treasury). The
// same wallet becomes feeClaimer + leftoverReceiver unless
// NATIVE_LAUNCH_FEE_WALLET overrides the claimer.

import 'dotenv/config';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { DynamicBondingCurveClient, buildCurveWithMarketCap } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { curveBuildParams } from '../api/_lib/native-launch/config.js';

const args = process.argv.slice(2);
const network = args.includes('--network') ? args[args.indexOf('--network') + 1] : 'devnet';
const doAirdrop = args.includes('--airdrop');
if (!['mainnet', 'devnet'].includes(network)) {
	console.error('--network must be mainnet or devnet');
	process.exit(1);
}

const RPC =
	network === 'devnet'
		? process.env.SOLANA_RPC_URL_DEVNET || 'https://api.devnet.solana.com'
		: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

const secret =
	process.env.NATIVE_LAUNCH_PARTNER_SECRET_BASE58 || process.env.X402_TREASURY_SECRET_BASE58;
if (!secret) {
	console.error('set NATIVE_LAUNCH_PARTNER_SECRET_BASE58 (or X402_TREASURY_SECRET_BASE58)');
	process.exit(1);
}
const partner = Keypair.fromSecretKey(bs58.decode(secret));
const feeClaimer = process.env.NATIVE_LAUNCH_FEE_WALLET
	? new PublicKey(process.env.NATIVE_LAUNCH_FEE_WALLET)
	: partner.publicKey;

const connection = new Connection(RPC, 'confirmed');

if (doAirdrop && network === 'devnet') {
	console.log(`airdropping 2 SOL to ${partner.publicKey.toBase58()} …`);
	try {
		const sig = await connection.requestAirdrop(partner.publicKey, 2e9);
		await connection.confirmTransaction(sig, 'confirmed');
	} catch (e) {
		console.warn(`airdrop failed (${e.message}) — continuing with existing balance`);
	}
}

const balance = await connection.getBalance(partner.publicKey);
console.log(`network:  ${network}`);
console.log(`partner:  ${partner.publicKey.toBase58()} (${(balance / 1e9).toFixed(4)} SOL)`);
console.log(`claimer:  ${feeClaimer.toBase58()}`);
if (balance < 0.05e9) {
	console.error('partner wallet needs at least 0.05 SOL for rent + fees');
	process.exit(1);
}

const curveConfig = buildCurveWithMarketCap(curveBuildParams());
console.log(
	`curve:    graduation at ${(Number(curveConfig.migrationQuoteThreshold.toString()) / 1e9).toFixed(2)} SOL raised`,
);

const client = new DynamicBondingCurveClient(connection, 'confirmed');
const configKeypair = Keypair.generate();

const tx = await client.partner.createConfig({
	...curveConfig,
	config: configKeypair.publicKey,
	feeClaimer,
	leftoverReceiver: feeClaimer,
	quoteMint: NATIVE_MINT,
	payer: partner.publicKey,
});

const sig = await sendAndConfirmTransaction(connection, tx, [partner, configKeypair], {
	commitment: 'confirmed',
});

console.log('');
console.log(`config created: ${configKeypair.publicKey.toBase58()}`);
console.log(`tx:             https://solscan.io/tx/${sig}${network === 'devnet' ? '?cluster=devnet' : ''}`);
console.log('');
console.log(
	`pin it: ${network === 'devnet' ? 'NATIVE_LAUNCH_CONFIG_KEY_DEVNET' : 'NATIVE_LAUNCH_CONFIG_KEY'}=${configKeypair.publicKey.toBase58()}`,
);
