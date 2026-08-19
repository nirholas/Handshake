// `send_signed_transaction`: the second half of the browser-wallet lane.
// prepare returns an unsigned transaction, your wallet signs it, this
// broadcasts it. No key is ever seen by this server.

import { z } from 'zod';

import { NETWORK } from '../config.js';
import { connectionFor } from '../lib/solana.js';
import { sendSignedBase64 } from '../lib/tx.js';

export const def = {
	name: 'send_signed_transaction',
	title: 'Broadcast a transaction your wallet signed',
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
	description:
		'Broadcast a base64 transaction that Phantom, Solflare, Backpack, or a Ledger already signed, and wait for ' +
		'confirmation. This is how the owner side works without any secret key on this machine: any tool that returns ' +
		'"prepared_for_wallet" hands you a transaction_base64 to sign and pass here. Blockhashes expire in about 60 ' +
		'seconds, so if this reports an expired blockhash, re-run the tool that prepared it.',
	inputSchema: {
		signed_transaction: z.string().describe('The signed transaction, base64-encoded, as your wallet returned it.'),
	},
	async handler(args) {
		const connection = connectionFor(NETWORK);
		const sent = await sendSignedBase64({ connection, signedBase64: args.signed_transaction, network: NETWORK });
		return { ok: true, network: NETWORK, ...sent };
	},
};
