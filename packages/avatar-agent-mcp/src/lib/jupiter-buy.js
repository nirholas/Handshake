// Jupiter swap for any Solana SPL or pump.fun token.
//
// Two modes:
//   - jupiterBuyDirect: the buyer wallet has SOL — single tx, no Jito.
//   - jupiterBuyBundled: ported from nirholas/atomic's buy-jito.js. The
//     funder transfers SOL to the buyer + Jito tip in Tx1, the buyer signs
//     the Jupiter swap in Tx2, both submitted as a bundle. Use this when
//     the buyer key is shared/leaked and you must beat sweeper bots.

import {
	PublicKey,
	SystemProgram,
	TransactionMessage,
	VersionedTransaction,
	ComputeBudgetProgram,
	LAMPORTS_PER_SOL,
} from '@solana/web3.js';

import { bs58encode, getConnection, keypairFromSecret } from './solana.js';
import { randomTipAccount, submitBundle, waitForSignatures } from './jito.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

async function fetchJupiterQuote({ inputMint = SOL_MINT, outputMint, amount, slippageBps = 500 }) {
	const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
	const r = await fetch(url);
	if (!r.ok) {
		const txt = await r.text().catch(() => '');
		throw new Error(`Jupiter quote failed (${r.status}): ${txt.slice(0, 300)}`);
	}
	return r.json();
}

async function fetchJupiterSwapTx({ quoteResponse, userPublicKey, priorityMicroLamports = 2_000_000 }) {
	const r = await fetch('https://lite-api.jup.ag/swap/v1/swap', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			quoteResponse,
			userPublicKey,
			wrapAndUnwrapSol: true,
			computeUnitPriceMicroLamports: priorityMicroLamports,
		}),
	});
	if (!r.ok) {
		const txt = await r.text().catch(() => '');
		throw new Error(`Jupiter swap build failed (${r.status}): ${txt.slice(0, 300)}`);
	}
	return r.json();
}

export async function jupiterBuyDirect({ buyerSecret, targetMint, buySol = 0.01, slippageBps = 500, priorityMicroLamports = 2_000_000 }) {
	const buyer = keypairFromSecret(buyerSecret);
	const conn = getConnection();

	const buyLamports = Math.floor(buySol * LAMPORTS_PER_SOL);
	const quote = await fetchJupiterQuote({ outputMint: targetMint, amount: buyLamports, slippageBps });
	const { swapTransaction } = await fetchJupiterSwapTx({
		quoteResponse: quote,
		userPublicKey: buyer.publicKey.toBase58(),
		priorityMicroLamports,
	});
	const swapTx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
	swapTx.sign([buyer]);

	const sig = await conn.sendTransaction(swapTx, { maxRetries: 5 });
	const wait = await waitForSignatures(conn, [sig], { timeoutMs: 60_000, intervalMs: 2_000 });

	return {
		ok: wait.ok,
		signature: sig,
		buyer: buyer.publicKey.toBase58(),
		target: targetMint,
		soldSol: buySol,
		expectedOutAmount: quote.outAmount,
		priceImpactPct: quote.priceImpactPct,
		route: Array.isArray(quote.routePlan) ? quote.routePlan.map((r) => r.swapInfo?.label).filter(Boolean) : [],
		statuses: wait.statuses,
		err: wait.err,
		explorer: `https://solscan.io/tx/${sig}`,
	};
}

export async function jupiterBuyBundled({
	funderSecret,
	buyerSecret,
	targetMint,
	buySol = 0.01,
	slippageBps = 500,
	jitoTipSol = 0.005,
	priorityMicroLamports = 2_000_000,
}) {
	const funder = keypairFromSecret(funderSecret);
	const buyer = keypairFromSecret(buyerSecret);
	const conn = getConnection();

	const funderBal = await conn.getBalance(funder.publicKey, 'confirmed');
	const needed = (buySol + 0.005 + jitoTipSol + 0.002) * LAMPORTS_PER_SOL;
	if (funderBal < needed) {
		const err = new Error(
			`Funder needs >= ${(needed / LAMPORTS_PER_SOL).toFixed(4)} SOL; has ${(funderBal / LAMPORTS_PER_SOL).toFixed(4)} SOL.`,
		);
		err.code = 'insufficient_funds';
		throw err;
	}

	const buyLamports = Math.floor(buySol * LAMPORTS_PER_SOL);
	const quote = await fetchJupiterQuote({ outputMint: targetMint, amount: buyLamports, slippageBps });
	const { swapTransaction } = await fetchJupiterSwapTx({
		quoteResponse: quote,
		userPublicKey: buyer.publicKey.toBase58(),
		priorityMicroLamports,
	});
	const swapTx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
	swapTx.sign([buyer]);

	const transferToBuyer = Math.floor((buySol + 0.005) * LAMPORTS_PER_SOL);
	const tipAccount = randomTipAccount();
	const blockhash = swapTx.message.recentBlockhash;

	const fundMsg = new TransactionMessage({
		payerKey: funder.publicKey,
		recentBlockhash: blockhash,
		instructions: [
			ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }),
			ComputeBudgetProgram.setComputeUnitLimit({ units: 1000 }),
			SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: buyer.publicKey, lamports: transferToBuyer }),
			SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: tipAccount, lamports: Math.floor(jitoTipSol * LAMPORTS_PER_SOL) }),
		],
	}).compileToV0Message();
	const fundTx = new VersionedTransaction(fundMsg);
	fundTx.sign([funder]);

	const bundle = [bs58encode(fundTx.serialize()), bs58encode(swapTx.serialize())];
	const { bundleId, explorer } = await submitBundle(bundle);
	const sig1 = bs58encode(fundTx.signatures[0]);
	const sig2 = bs58encode(swapTx.signatures[0]);
	const wait = await waitForSignatures(conn, [sig1, sig2], { timeoutMs: 60_000, intervalMs: 2_000 });

	return {
		ok: wait.ok,
		bundleId,
		bundleExplorer: explorer,
		fundTxSignature: sig1,
		swapTxSignature: sig2,
		funder: funder.publicKey.toBase58(),
		buyer: buyer.publicKey.toBase58(),
		target: targetMint,
		soldSol: buySol,
		expectedOutAmount: quote.outAmount,
		priceImpactPct: quote.priceImpactPct,
		route: Array.isArray(quote.routePlan) ? quote.routePlan.map((r) => r.swapInfo?.label).filter(Boolean) : [],
		statuses: wait.statuses,
		err: wait.err,
		fundTxExplorer: `https://solscan.io/tx/${sig1}`,
		swapTxExplorer: `https://solscan.io/tx/${sig2}`,
	};
}
