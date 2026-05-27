#!/usr/bin/env node
// Devnet smoke for the pump-swap inner-ix + outer agent_buyback_trigger path.
//
// Bypasses the HTTP cron entrypoint and the postgres lookup — drives the same
// builder + signer path the cron uses, against whatever mint the operator
// points at. Use after applying api/_lib/migrations/2026-05-20-pump-buyback-fullswap.sql
// in prod; this script is for one-off devnet verification.
//
// Env:
//   PUMP_CRON_RELAYER_SECRET_KEY_B64   base64 of the 64-byte secret-key bytes
//   SOLANA_RPC_URL_DEVNET              optional, defaults to api.devnet.solana.com
//   MINT                               base58 devnet pump.fun mint
//   CURRENCY                           base58 quote currency mint (e.g. USDC devnet)
//   FULL_SWAP=true|false               when true, builds the buy-on-curve inner ix
//   SLIPPAGE_BPS                       default 500 (5%)
//   DRY_RUN=true                       build but do not submit
//
// Examples:
//   PUMP_CRON_RELAYER_SECRET_KEY_B64=... MINT=<mint> CURRENCY=<usdc-devnet> \
//   FULL_SWAP=true node scripts/buyback-devnet-smoke.mjs
//
//   ... FULL_SWAP=false node scripts/buyback-devnet-smoke.mjs   # burn-only

import { Keypair, Transaction } from '@solana/web3.js';

function need(name) {
	const v = process.env[name];
	if (!v) throw new Error(`missing required env: ${name}`);
	return v;
}

const network = 'devnet';
const mintStr = need('MINT');
const currencyStr = need('CURRENCY');
const fullSwap = process.env.FULL_SWAP === 'true';
const slippageBps = Number(process.env.SLIPPAGE_BPS) || 500;
const dryRun = process.env.DRY_RUN === 'true';
const relayerB64 = need('PUMP_CRON_RELAYER_SECRET_KEY_B64');

const relayer = Keypair.fromSecretKey(Buffer.from(relayerB64, 'base64'));
console.log(`relayer:     ${relayer.publicKey.toBase58()}`);
console.log(`mint:        ${mintStr}`);
console.log(`currency:    ${currencyStr}`);
console.log(`mode:        ${fullSwap ? 'full-swap' : 'burn-only'}`);
console.log(`slippageBps: ${slippageBps}`);
console.log('');

const { PUMP_PROGRAM_ID } = await import('@pump-fun/agent-payments-sdk');
const {
	getConnection,
	getPumpAgent,
	getPumpAgentOffline,
	solanaPubkey,
} = await import('../api/_lib/pump.js');
const { buildPumpSwapInnerIx } = await import('../api/_lib/pump-swap-ix.js');

const currency = solanaPubkey(currencyStr);
const connection = getConnection({ network });

const { agent } = await getPumpAgent({ network, mint: mintStr });
const balances = await agent.getBalances(currency);
const buyback = BigInt(balances.buybackVault?.balance ?? 0);
console.log(`buybackVault balance: ${buyback.toString()}`);
if (buyback === 0n) {
	console.log('nothing to buy back, exiting');
	process.exit(0);
}

const { offline } = await getPumpAgentOffline({ network, mint: mintStr });

const params = {
	globalBuybackAuthority: relayer.publicKey,
	currencyMint: currency,
	swapProgramToInvoke: PUMP_PROGRAM_ID,
	swapInstructionData: Buffer.alloc(0),
	remainingAccounts: [],
};

if (fullSwap) {
	console.log('building pump-swap inner ix...');
	const inner = await buildPumpSwapInnerIx({
		mint: mintStr,
		currency,
		amountIn: buyback,
		slippageBps,
		cluster: network,
	});
	params.swapInstructionData = inner.data;
	params.remainingAccounts = inner.accounts;
	console.log(`  inner ix: ${inner.data.length}-byte data, ${inner.accounts.length} accounts`);
	console.log(`  expectedBaseTokens: ${inner.expectedBaseTokens.toString()}`);
	console.log(`  minTokensOut:       ${inner.minTokensOut.toString()}`);
}

const ix = await offline.buybackTrigger(params);
console.log(`outer ix built: ${ix.keys.length} keys, ${ix.data.length}-byte data`);

if (dryRun) {
	console.log('DRY_RUN=true — exiting before submit');
	process.exit(0);
}

const tx = new Transaction();
tx.add(ix);
const { blockhash } = await connection.getLatestBlockhash('confirmed');
tx.recentBlockhash = blockhash;
tx.feePayer = relayer.publicKey;
tx.sign(relayer);
const sig = await connection.sendRawTransaction(tx.serialize());
console.log('');
console.log(`submitted: ${sig}`);
console.log(`https://explorer.solana.com/tx/${sig}?cluster=devnet`);

await connection.confirmTransaction(sig, 'confirmed');
console.log('confirmed');
