import { mintTokenized3dAsset, readTokenized3dAsset, TOKENIZE_3D_ROYALTY_CAP_BPS } from '../../_lib/tokenize-3d.js';
import { priceFor } from '../../_lib/pump-pricing.js';

// A handled boundary error carries a status + code; surface it as a clean MCP
// tool error (isError) rather than letting an unexpected 500 bubble.
function isHandled(err) {
	return err && typeof err.code === 'string' && Number.isInteger(err.status);
}

function toolError(message) {
	return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

export const toolDefs = [
	{
		name: 'mint_3d_asset',
		title: 'Mint a 3D asset as a Solana NFT',
		// Creates an on-chain Core NFT. Not destructive (it mints, never deletes),
		// and idempotent: the claim-first guard means repeating a call with the
		// same arguments returns the same mint instead of minting twice. Open-world
		// (writes to the Solana network). destructiveHint is explicit (spec defaults
		// it to true when omitted).
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		description:
			'Mint a generated or owned GLB as a Metaplex Core NFT on Solana whose media is a ' +
			'LIVE, interactive 3D viewer (the rigged glTF model under animation_url, not a static ' +
			'image). Bakes provenance (creator, prompt, generation model, parent lineage, timestamp) ' +
			'into the metadata AND appends a signed, independently-verifiable record to the ' +
			'agent_actions provenance ledger; enforces capped creator royalties on secondary sales. ' +
			'Supply an owned avatar_id or a glb_url, and a recipient (owner_wallet, or your OAuth-linked ' +
			'Solana wallet). Devnet by default; pass network="mainnet" for a real mainnet mint. Idempotent ' +
			'(a repeat call for the same asset returns the same mint). Royalty is capped at ' +
			`${TOKENIZE_3D_ROYALTY_CAP_BPS / 100}%. Naming parent_mint (a remix/derivative on mainnet) ` +
			"routes the parent creator's royalty slice out of THIS mint's fee as a real on-chain USDC " +
			'transfer. Returns the mint address, explorer + viewer links, royalty terms, the provenance ' +
			'ledger reference, and (for a remix) the royalty settlement. Priced per call via x402 (USDC); ' +
			'an OAuth bearer token bypasses payment.',
		inputSchema: {
			type: 'object',
			properties: {
				avatar_id: {
					type: 'string',
					format: 'uuid',
					description: 'An owned avatar to tokenize (its GLB becomes the NFT media).',
				},
				glb_url: {
					type: 'string',
					format: 'uri',
					description: 'Or a GLB URL to tokenize (absolute http(s)).',
				},
				owner_wallet: {
					type: 'string',
					description:
						'Recipient Solana wallet (base58). Defaults to your OAuth-linked wallet when omitted.',
				},
				name: { type: 'string', maxLength: 200, description: 'Display name for the NFT.' },
				description: { type: 'string', maxLength: 2000 },
				network: {
					type: 'string',
					enum: ['devnet', 'mainnet'],
					default: 'devnet',
					description: 'Cluster to mint on. Devnet by default; mainnet is a real mint.',
				},
				seller_fee_basis_points: {
					type: 'integer',
					minimum: 0,
					maximum: TOKENIZE_3D_ROYALTY_CAP_BPS,
					description: `Enforced secondary-sale royalty in basis points. Clamped to the ${TOKENIZE_3D_ROYALTY_CAP_BPS / 100}% hard cap.`,
				},
				royalty_recipient: {
					type: 'string',
					description: 'Wallet the royalty routes to (base58). Defaults to the owner.',
				},
				parent_mint: {
					type: 'string',
					description: 'Lineage: the asset this was remixed from (baked into provenance).',
				},
				prompt: { type: 'string', maxLength: 1000, description: 'Generation prompt (provenance).' },
				generation_model: { type: 'string', maxLength: 96 },
				generation_provider: { type: 'string', maxLength: 64 },
				idempotency_key: {
					type: 'string',
					maxLength: 128,
					description: 'Override the derived idempotency key to force-dedupe a specific request.',
				},
			},
			additionalProperties: false,
		},
		async handler(args, auth) {
			try {
				// The remix-royalty split (task 4) must only ever split a fee that was
				// ACTUALLY collected for this exact call: a genuine per-call x402
				// settlement (auth.x402Paid), never a subscription window or an OAuth
				// bypass (both real access, but no fresh fee here to split).
				const mintFeeAtomicsCollected =
					auth?.source === 'x402' && auth?.x402Paid
						? BigInt(Math.round((priceFor('mint_3d_asset')?.amount_usdc || 0) * 1_000_000))
						: 0n;
				const result = await mintTokenized3dAsset({
					avatarId: args.avatar_id,
					glbUrl: args.glb_url,
					ownerWallet: args.owner_wallet,
					requesterId: auth?.userId ?? null,
					name: args.name,
					description: args.description,
					network: args.network || 'devnet',
					sellerFeeBasisPoints: args.seller_fee_basis_points,
					royaltyRecipient: args.royalty_recipient,
					parentMint: args.parent_mint,
					prompt: args.prompt,
					generationModel: args.generation_model,
					generationProvider: args.generation_provider,
					idempotencyKey: args.idempotency_key,
					mintFeeAtomicsCollected,
				});
				const text =
					result.status === 'minted'
						? `${result.idempotent ? 'Already minted' : 'Minted'} "${result.name}" on ${result.network}.\n` +
							`Mint: ${result.mint}\n` +
							`Explorer: ${result.explorer_asset_url}\n` +
							(result.explorer_tx_url ? `Tx: ${result.explorer_tx_url}\n` : '') +
							`Viewer: ${result.viewer_url}\n` +
							`Royalty: ${result.royalty.percent}% (cap ${result.royalty.cap_basis_points / 100}%)` +
							(result.royalty.capped ? ` (requested ${result.royalty.requested_basis_points / 100}%, clamped)` : '') +
							(result.provenance_ledger
								? `\nProvenance: ledger action #${result.provenance_ledger.action_id} (${result.provenance_ledger.signed ? 'signed' : 'unsigned'})`
								: '') +
							(result.remix_royalty
								? result.remix_royalty.paid
									? `\nRemix royalty: ${result.remix_royalty.creator_usd} USDC paid to the source creator (${result.remix_royalty.creator_tx})`
									: `\nRemix royalty: not paid (${result.remix_royalty.reason})`
								: '')
						: `Mint in progress for this asset. Read it back with get_3d_asset_onchain once it confirms.`;
				return { content: [{ type: 'text', text }], structuredContent: result };
			} catch (err) {
				if (isHandled(err)) return toolError(err.message);
				throw err;
			}
		},
	},
	{
		name: 'get_3d_asset_onchain',
		title: 'Resolve a 3D NFT to its live asset + provenance',
		// A read over live on-chain state: the holder can change between calls, so
		// not idempotent. Open-world (reads the Solana network).
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		description:
			'Resolve a Solana mint address to its live 3D asset: current holder, the interactive ' +
			'viewer link + GLB (confirmed live), baked provenance (creator, prompt, model, lineage, ' +
			'timestamp), and the enforced on-chain royalty terms. Works on any Metaplex Core mint. ' +
			'Assets minted through three.ws also return their platform launch record. Read-only, public.',
		inputSchema: {
			type: 'object',
			properties: {
				mint: { type: 'string', description: 'The Metaplex Core asset (mint) pubkey, base58.' },
				network: {
					type: 'string',
					enum: ['devnet', 'mainnet'],
					default: 'devnet',
					description: 'Cluster to read (ignored if the mint is in our launch records).',
				},
			},
			required: ['mint'],
			additionalProperties: false,
		},
		async handler(args) {
			try {
				const data = await readTokenized3dAsset({ mint: args.mint, network: args.network || 'devnet' });
				return {
					content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
					structuredContent: data,
				};
			} catch (err) {
				if (isHandled(err)) return toolError(err.message);
				throw err;
			}
		},
	},
];
