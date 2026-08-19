// `mint_onchain_agent` is the self-custody path. Mint + register in ONE atomic
// transaction, signed by the agent's own keypair (SOLANA_SECRET_KEY or a
// per-call `secret`). Called without confirm:true it returns a full preview
// (documents, wallet, cost) and spends nothing.

import { z } from 'zod';

import { NETWORK, REQUIRE_CONFIRM } from '../config.js';
import { buildAgentMint, sendAgentMint } from '../lib/mint.js';
import {
	buildUmi,
	solBalance,
	assetSignerAddress,
	agentLinks,
	txLink,
	toBase58Signature,
	EST_MINT_LAMPORTS,
	EST_REGISTER_LAMPORTS,
	LAMPORTS_PER_SOL,
} from '../lib/solana.js';
import { mintShape, mintParams } from './mint-shape.js';

const EST_TOTAL_SOL = (EST_MINT_LAMPORTS + EST_REGISTER_LAMPORTS) / LAMPORTS_PER_SOL;

export const def = {
	name: 'mint_onchain_agent',
	title: 'Mint an on-chain agent into the Metaplex Agent Registry',
	annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
	description:
		'Deploy an AI agent on-chain, Genesis-333 style: mints a Metaplex Core asset (data: URI metadata, verified ' +
		'creator, royalties, immutable metadata) AND registers its EIP-8004 Agent Identity, so it appears on ' +
		'metaplex.com/agents with its own built-in wallet. Runs as ONE atomic transaction when it fits Solana\'s ' +
		'1232-byte limit, otherwise as create followed by register (how the Genesis 333 landed). Signs with the configured ' +
		'SOLANA_SECRET_KEY (or a per-call secret) and spends ~0.007 SOL in rent + fees. Without confirm:true it ' +
		'returns a full preview (both JSON documents, the paying wallet, the cost) and broadcasts NOTHING. ' +
		'For Phantom/Solflare users, use prepare_agent_mint instead.',
	inputSchema: {
		...mintShape,
		secret: z.string().optional().describe('Per-call signing key (base58 secret key or JSON byte array). Overrides SOLANA_SECRET_KEY.'),
		confirm: z.boolean().optional().describe('Must be true to broadcast. Anything else returns a spend-nothing preview.'),
	},
	async handler(args) {
		const network = args.network || NETWORK;
		const umi = buildUmi({ network, secret: args.secret, requireSigner: true });
		const wallet = umi.identity.publicKey.toString();

		const mint = buildAgentMint(umi, mintParams(args, { network, creator: wallet }));
		const asset = mint.assetSigner.publicKey.toString();

		if (REQUIRE_CONFIRM && args.confirm !== true) {
			return {
				ok: true,
				confirm_required: true,
				message: `Preview only. Re-issue with confirm:true to mint on ${network} for ~${EST_TOTAL_SOL} SOL.`,
				network,
				paying_wallet: wallet,
				estimated_cost_sol: EST_TOTAL_SOL,
				asset_metadata: mint.assetMetadata,
				metadata_uri_bytes: mint.metadataUri.length,
				registration: mint.registration,
			};
		}

		const balance = await solBalance(umi, wallet);
		if (balance * LAMPORTS_PER_SOL < EST_MINT_LAMPORTS + EST_REGISTER_LAMPORTS) {
			throw Object.assign(
				new Error(
					`Wallet ${wallet} holds ${balance} SOL on ${network}; the mint needs ~${EST_TOTAL_SOL} SOL. Fund it and retry.`,
				),
				{ code: 'insufficient_sol' },
			);
		}

		const { signatures, atomic } = await sendAgentMint(umi, mint, { toBase58Signature });

		return {
			ok: true,
			network,
			asset,
			atomic,
			signatures,
			txs: signatures.map((s) => txLink(s, network)),
			owner: args.owner || wallet,
			agent_wallet: assetSignerAddress(umi, asset),
			metadata_uri: mint.metadataUri,
			registration: mint.registration,
			links: agentLinks(asset, network),
			note: 'The agent is live in the Metaplex Agent Registry. DAS indexers surface it within minutes; fund agent_wallet to let the asset act on-chain.',
		};
	},
};
