// `prepare_agent_mint` is the wallet path. It builds the SAME atomic mint+register
// transaction for a Phantom / Solflare / any-Solana-wallet owner. No key is
// needed here: the transaction comes back base64, partially signed by the new
// asset keypair, with the owner's wallet as fee payer. The owner signs and
// broadcasts it (or hands the signed bytes to send_signed_transaction).

import { z } from 'zod';

import { NETWORK } from '../config.js';
import { buildAgentMint } from '../lib/mint.js';
import {
	buildUmi,
	assetSignerAddress,
	agentLinks,
	EST_MINT_LAMPORTS,
	EST_REGISTER_LAMPORTS,
	LAMPORTS_PER_SOL,
} from '../lib/solana.js';
import { mintShape, mintParams } from './mint-shape.js';
import { createNoopSigner, publicKey as umiPublicKey, signerIdentity } from '@metaplex-foundation/umi';

export const def = {
	name: 'prepare_agent_mint',
	title: 'Prepare an agent mint for a Phantom/Solflare wallet to sign',
	annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
	description:
		'Build the exact Genesis-style mint+register transaction (Metaplex Core asset + Agent Identity, one atomic ' +
		'tx) for an EXTERNAL Solana wallet: Phantom, Solflare, Backpack, Ledger, anything. Needs no secret key. ' +
		'Returns the unsigned transaction base64 (already co-signed by the new asset keypair) with `wallet` as the ' +
		'fee payer; the wallet signs it and broadcasts, or passes the signed bytes to send_signed_transaction. ' +
		'Broadcasts nothing itself. The blockhash expires after roughly a minute, so sign promptly and re-prepare ' +
		'if a wallet reports an expired transaction.',
	inputSchema: {
		...mintShape,
		wallet: z.string().min(32).max(44).describe('The base58 address of the wallet that will sign, pay, and own the agent.'),
	},
	async handler(args) {
		const network = args.network || NETWORK;
		const umi = buildUmi({ network });
		umi.use(signerIdentity(createNoopSigner(umiPublicKey(args.wallet))));

		const mint = buildAgentMint(umi, mintParams(args, { network, creator: args.wallet }));
		const asset = mint.assetSigner.publicKey.toString();

		const tx = await mint.builder.buildAndSign(umi);
		const txBase64 = Buffer.from(umi.transactions.serialize(tx)).toString('base64');

		return {
			ok: true,
			network,
			wallet: args.wallet,
			asset,
			agent_wallet: assetSignerAddress(umi, asset),
			tx_base64: txBase64,
			estimated_cost_sol: (EST_MINT_LAMPORTS + EST_REGISTER_LAMPORTS) / LAMPORTS_PER_SOL,
			asset_metadata: mint.assetMetadata,
			registration: mint.registration,
			links: agentLinks(asset, network),
			next: 'Have the wallet sign tx_base64 (signTransaction on a VersionedTransaction/legacy tx from these bytes) and broadcast it, or call send_signed_transaction with the signed base64.',
		};
	},
};
