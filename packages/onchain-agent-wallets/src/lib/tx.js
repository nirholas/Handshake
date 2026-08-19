// Transaction assembly, the self-custody signing lane, and the browser-wallet
// lane. Every value-moving tool goes through exactly one of these two paths:
//
//   sendWithSigners  : this process holds a key (the agent's, or an owner key
//                      the operator deliberately configured) and signs locally.
//   prepareForWallet : nothing is signed here. The unsigned transaction is
//                      handed back base64-encoded for Phantom, Solflare,
//                      Backpack, or a Ledger to sign, then broadcast through
//                      send_signed_transaction. No key ever reaches this
//                      machine.

import { VersionedTransaction, TransactionMessage, ComputeBudgetProgram } from '@solana/web3.js';

import { toPublicKey, txLink } from './solana.js';

// A small priority fee keeps spends landing when the network is busy. Payments
// that silently fail to confirm are worse than payments that cost a fraction
// of a cent more.
const PRIORITY_MICRO_LAMPORTS = 20_000;
const COMPUTE_UNIT_LIMIT = 200_000;

function withComputeBudget(instructions) {
	return [
		ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
		ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICRO_LAMPORTS }),
		...instructions,
	];
}

/** Compile instructions into an unsigned v0 transaction against a fresh blockhash. */
export async function buildTransaction({ connection, payer, instructions }) {
	const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
	const message = new TransactionMessage({
		payerKey: toPublicKey(payer, 'fee payer'),
		recentBlockhash: blockhash,
		instructions: withComputeBudget(instructions),
	}).compileToV0Message();
	return { transaction: new VersionedTransaction(message), blockhash, lastValidBlockHeight };
}

/** Sign locally and broadcast, waiting for confirmation before returning. */
export async function sendWithSigners({ connection, payer, instructions, signers, network }) {
	const { transaction, blockhash, lastValidBlockHeight } = await buildTransaction({ connection, payer, instructions });
	transaction.sign(signers);
	const signature = await connection.sendTransaction(transaction, { maxRetries: 5 });
	const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
	if (result.value?.err) {
		throw Object.assign(new Error(`transaction ${signature} failed on-chain: ${JSON.stringify(result.value.err)}`), {
			code: 'tx_failed',
			signature,
			link: txLink(signature, network),
		});
	}
	return { signature, link: txLink(signature, network) };
}

/** Build the same transaction unsigned, for a browser wallet or a Ledger to sign. */
export async function prepareForWallet({ connection, payer, instructions, network, note }) {
	const { transaction, blockhash, lastValidBlockHeight } = await buildTransaction({ connection, payer, instructions });
	return {
		transaction_base64: Buffer.from(transaction.serialize()).toString('base64'),
		fee_payer: String(payer),
		blockhash,
		last_valid_block_height: lastValidBlockHeight,
		network,
		note,
		next_step:
			'Sign this with your wallet (Phantom, Solflare, Backpack, Ledger), then call send_signed_transaction with the signed base64. Blockhashes expire in about 60 seconds, so sign promptly or re-run this tool.',
	};
}

/** Broadcast a transaction a wallet already signed. */
export async function sendSignedBase64({ connection, signedBase64, network }) {
	let transaction;
	try {
		transaction = VersionedTransaction.deserialize(Buffer.from(String(signedBase64).trim(), 'base64'));
	} catch (err) {
		throw Object.assign(new Error(`could not decode the signed transaction: ${err.message}`), { code: 'bad_tx' });
	}
	if (!transaction.signatures?.some((sig) => sig.some((byte) => byte !== 0))) {
		throw Object.assign(new Error('that transaction carries no signature. Sign it in your wallet first.'), {
			code: 'unsigned_tx',
		});
	}
	const signature = await connection.sendTransaction(transaction, { maxRetries: 5 });
	const latest = await connection.getLatestBlockhash('confirmed');
	const result = await connection.confirmTransaction(
		{ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
		'confirmed',
	);
	if (result.value?.err) {
		throw Object.assign(new Error(`transaction ${signature} failed on-chain: ${JSON.stringify(result.value.err)}`), {
			code: 'tx_failed',
			signature,
			link: txLink(signature, network),
		});
	}
	return { signature, link: txLink(signature, network) };
}
