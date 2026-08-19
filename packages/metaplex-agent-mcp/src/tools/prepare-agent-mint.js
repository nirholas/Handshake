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
import { resolveDeployFee } from '../lib/three.js';
import { mintShape, mintParams } from './mint-shape.js';
import { createNoopSigner, publicKey as umiPublicKey, signerIdentity } from '@metaplex-foundation/umi';

export const def = {
	name: 'prepare_agent_mint',
	title: 'Prepare an agent mint for a Phantom/Solflare wallet to sign',
	annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
	description:
		'Build the exact Genesis-style mint+register flow (Metaplex Core asset + Agent Identity) for an EXTERNAL ' +
		'Solana wallet: Phantom, Solflare, Backpack, Ledger, anything. Needs no secret key. Returns unsigned ' +
		'transactions base64 in txs_base64 (already co-signed by the new asset keypair) with `wallet` as the fee ' +
		'payer: one atomic tx when it fits Solana\'s size limit, else create + register to sign together via ' +
		'signAllTransactions. The wallet signs and broadcasts, or hands the signed array to ' +
		'send_signed_transaction. Includes the same mainnet deploy fee as mint_onchain_agent, priced against the ' +
		"wallet's live $THREE balance and returned as deploy_fee_sol/deploy_fee_to before anything is signed. " +
		'Broadcasts nothing itself. The blockhash expires after roughly a minute, so sign ' +
		'promptly and re-prepare if a wallet reports an expired transaction.',
	inputSchema: {
		...mintShape,
		wallet: z.string().min(32).max(44).describe('The base58 address of the wallet that will sign, pay, and own the agent.'),
	},
	async handler(args) {
		const network = args.network || NETWORK;
		const umi = buildUmi({ network });
		umi.use(signerIdentity(createNoopSigner(umiPublicKey(args.wallet))));

		const fee = await resolveDeployFee(umi, { network, payer: args.wallet });
		const mint = buildAgentMint(
			umi,
			mintParams(args, { network, creator: args.wallet, feeLamports: fee.lamports, feeWallet: fee.wallet }),
		);
		const asset = mint.assetSigner.publicKey.toString();

		const txsBase64 = [];
		for (const builder of mint.builders) {
			const tx = await builder.buildAndSign(umi);
			txsBase64.push(Buffer.from(umi.transactions.serialize(tx)).toString('base64'));
		}

		return {
			ok: true,
			network,
			wallet: args.wallet,
			asset,
			agent_wallet: assetSignerAddress(umi, asset),
			atomic: mint.atomic,
			txs_base64: txsBase64,
			estimated_cost_sol: (EST_MINT_LAMPORTS + EST_REGISTER_LAMPORTS) / LAMPORTS_PER_SOL + fee.sol,
			network_cost_sol: (EST_MINT_LAMPORTS + EST_REGISTER_LAMPORTS) / LAMPORTS_PER_SOL,
			deploy_fee_sol: fee.sol,
			deploy_fee_to: fee.wallet,
			three_tier: fee.tier,
			three_balance: fee.three_tokens,
			three_note: fee.reason,
			asset_metadata: mint.assetMetadata,
			registration: mint.registration,
			links: agentLinks(asset, network),
			next:
				txsBase64.length === 1
					? 'Have the wallet sign txs_base64[0] and broadcast it, or call send_signed_transaction with the signed base64.'
					: 'The mint exceeds one transaction (large data: URIs), so it is create + register IN ORDER. Have the wallet signAllTransactions over txs_base64, then call send_signed_transaction with the signed array; it broadcasts sequentially and absorbs the propagation race.',
		};
	},
};
