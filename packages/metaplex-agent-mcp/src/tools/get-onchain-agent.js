// `get_onchain_agent` reads everything about a registered agent from chain:
// the Core asset, its plugins, the decoded metadata and EIP-8004 registration
// documents, the identity PDA, and the asset's built-in wallet with balance.
// Works on ANY Metaplex Agent Registry asset, not just three.ws mints.

import { z } from 'zod';

import { NETWORK, HTTP_TIMEOUT_MS } from '../config.js';
import { fetchAsset } from '@metaplex-foundation/mpl-core';
import { publicKey as umiPublicKey } from '@metaplex-foundation/umi';
import { findAgentIdentityV1Pda } from '@metaplex-foundation/mpl-agent-registry';

import { decodeJsonUri } from '../lib/registration.js';
import { buildUmi, solBalance, assetSignerAddress, agentLinks } from '../lib/solana.js';

export const def = {
	name: 'get_onchain_agent',
	title: 'Read an on-chain agent (asset, registration, wallet)',
	annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
	description:
		"Fetch a Metaplex Agent Registry agent by its Core asset address: name, owner, update authority, plugins " +
		'(royalties, verified creators, immutable metadata, attributes), the decoded asset metadata and EIP-8004 ' +
		'registration documents, whether the identity PDA exists, and the built-in agent wallet (Asset Signer PDA) ' +
		'with its live SOL balance. Read-only. Works on any registered agent, e.g. the three.ws Genesis mints.',
	inputSchema: {
		asset: z.string().min(32).max(44).describe('The Core asset address (base58).'),
		network: z.enum(['mainnet', 'devnet']).optional().describe('Cluster. Defaults to the configured network.'),
	},
	async handler(args) {
		const network = args.network || NETWORK;
		const umi = buildUmi({ network });
		const assetPk = umiPublicKey(args.asset);

		const asset = await fetchAsset(umi, assetPk);

		const [identityPda] = findAgentIdentityV1Pda(umi, { asset: assetPk });
		const identityAccount = await umi.rpc.getAccount(identityPda).catch(() => null);
		const registered = Boolean(identityAccount?.exists && identityAccount.data?.length);

		const registrationUri = asset.agentIdentities?.[0]?.uri || null;
		const [metadata, registration] = await Promise.all([
			decodeJsonUri(asset.uri, { timeoutMs: HTTP_TIMEOUT_MS }),
			registrationUri ? decodeJsonUri(registrationUri, { timeoutMs: HTTP_TIMEOUT_MS }) : null,
		]);

		const agentWallet = assetSignerAddress(umi, args.asset);
		const agentWalletSol = await solBalance(umi, agentWallet).catch(() => null);

		return {
			ok: true,
			network,
			asset: args.asset,
			name: asset.name,
			owner: asset.owner.toString(),
			update_authority: { type: asset.updateAuthority.type, address: asset.updateAuthority.address?.toString() ?? null },
			registered,
			identity_pda: identityPda.toString(),
			metadata_uri: asset.uri,
			metadata,
			registration_uri: registrationUri,
			registration,
			agent_wallet: agentWallet,
			agent_wallet_sol: agentWalletSol,
			plugins: {
				royalties: asset.royalties
					? {
							basis_points: asset.royalties.basisPoints,
							creators: asset.royalties.creators.map((c) => ({ address: c.address.toString(), percentage: c.percentage })),
						}
					: null,
				verified_creators: asset.verifiedCreators
					? asset.verifiedCreators.signatures.map((s) => ({ address: s.address.toString(), verified: s.verified }))
					: null,
				immutable_metadata: Boolean(asset.immutableMetadata),
				attributes: asset.attributes ? asset.attributes.attributeList.map((a) => ({ key: a.key, value: a.value })) : null,
			},
			links: agentLinks(args.asset, network),
		};
	},
};
