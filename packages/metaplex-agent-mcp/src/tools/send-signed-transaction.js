// `send_signed_transaction`: broadcast one or more fully signed transactions
// (usually the output of prepare_agent_mint after the owner's wallet signed)
// IN ORDER, waiting for confirmation between them. The order matters for the
// split mint: register only succeeds once create has landed, and the bounded
// retry below absorbs the RPC propagation race in between.

import { z } from 'zod';

import { NETWORK } from '../config.js';
import { isAssetPropagationError } from '../lib/mint.js';
import { buildUmi, toBase58Signature, txLink } from '../lib/solana.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function broadcastOne(umi, txBase64, network) {
	let tx;
	try {
		tx = umi.transactions.deserialize(new Uint8Array(Buffer.from(txBase64, 'base64')));
	} catch {
		throw Object.assign(new Error('a transaction does not deserialize from base64'), { code: 'bad_transaction' });
	}

	let rawSignature;
	for (let attempt = 0; ; attempt++) {
		try {
			rawSignature = await umi.rpc.sendTransaction(tx, { commitment: 'confirmed' });
			break;
		} catch (err) {
			if (!isAssetPropagationError(err) || attempt >= 4) throw err;
			await sleep(2000);
		}
	}
	const signature = toBase58Signature(rawSignature);

	// Bounded confirmation poll: ~60s at 2s intervals.
	let status = null;
	for (let i = 0; i < 30; i++) {
		const [s] = await umi.rpc.getSignatureStatuses([rawSignature]);
		if (s?.error) {
			throw Object.assign(new Error(`transaction ${signature} failed on-chain: ${JSON.stringify(s.error)}`), {
				code: 'tx_failed',
			});
		}
		if (s && (s.commitment === 'confirmed' || s.commitment === 'finalized')) {
			status = s.commitment;
			break;
		}
		await sleep(2000);
	}
	return { signature, commitment: status, tx: txLink(signature, network) };
}

export const def = {
	name: 'send_signed_transaction',
	title: 'Broadcast signed Solana transactions in order and confirm them',
	annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
	description:
		'Broadcast one or more fully signed Solana transactions (base64) IN ORDER, polling each to confirmation ' +
		'before the next. Use it to complete the prepare_agent_mint flow: pass the wallet-signed txs_base64 array ' +
		'and the create/register sequencing (including the propagation race) is handled. Whatever the transactions ' +
		'do on-chain happens for real, so only send bytes you built and inspected.',
	inputSchema: {
		tx_base64: z.string().min(64).optional().describe('A single fully signed transaction, base64 encoded.'),
		txs_base64: z.array(z.string().min(64)).min(1).max(4).optional().describe('Fully signed transactions to broadcast in order (e.g. create then register).'),
		network: z.enum(['mainnet', 'devnet']).optional().describe('Cluster to broadcast on. Defaults to the configured network.'),
	},
	async handler(args) {
		const network = args.network || NETWORK;
		const txs = args.txs_base64?.length ? args.txs_base64 : args.tx_base64 ? [args.tx_base64] : null;
		if (!txs) {
			throw Object.assign(new Error('pass tx_base64 or txs_base64'), { code: 'validation_error' });
		}
		const umi = buildUmi({ network });

		const results = [];
		for (const txBase64 of txs) {
			results.push(await broadcastOne(umi, txBase64, network));
		}

		const unconfirmed = results.filter((r) => r.commitment === null);
		return {
			ok: true,
			network,
			confirmed: unconfirmed.length === 0,
			transactions: results,
			...(unconfirmed.length
				? { note: 'Broadcast succeeded but at least one confirmation was not observed within 60s. Check the tx links before retrying; re-sending a landed transaction is harmless (same signature).' }
				: {}),
		};
	},
};
