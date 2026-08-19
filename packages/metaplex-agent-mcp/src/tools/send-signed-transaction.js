// `send_signed_transaction`: broadcast a fully signed transaction (usually
// the output of prepare_agent_mint after the owner's wallet signed it) and
// wait for confirmation.

import { z } from 'zod';

import { NETWORK } from '../config.js';
import { buildUmi, toBase58Signature, txLink } from '../lib/solana.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const def = {
	name: 'send_signed_transaction',
	title: 'Broadcast a signed Solana transaction and confirm it',
	annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
	description:
		'Broadcast a fully signed Solana transaction (base64) and poll until it confirms. Use it to complete the ' +
		'prepare_agent_mint flow when the signing wallet does not broadcast on its own. Whatever the transaction ' +
		'does on-chain happens for real, so only send bytes you built and inspected.',
	inputSchema: {
		tx_base64: z.string().min(64).describe('The fully signed transaction, base64 encoded.'),
		network: z.enum(['mainnet', 'devnet']).optional().describe('Cluster to broadcast on. Defaults to the configured network.'),
	},
	async handler(args) {
		const network = args.network || NETWORK;
		const umi = buildUmi({ network });

		let tx;
		try {
			tx = umi.transactions.deserialize(new Uint8Array(Buffer.from(args.tx_base64, 'base64')));
		} catch {
			throw Object.assign(new Error('tx_base64 does not deserialize as a Solana transaction'), {
				code: 'bad_transaction',
			});
		}

		const rawSignature = await umi.rpc.sendTransaction(tx, { commitment: 'confirmed' });
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

		return {
			ok: true,
			network,
			signature,
			confirmed: status !== null,
			commitment: status,
			tx: txLink(signature, network),
			...(status === null
				? { note: 'Broadcast succeeded but confirmation was not observed within 60s. Check the tx link before retrying; re-sending a landed transaction is harmless (same signature).' }
				: {}),
		};
	},
};
