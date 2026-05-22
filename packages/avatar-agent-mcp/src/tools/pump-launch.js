// `pump_launch` — atomic pump.fun token launch via a Jito bundle.
//
// Wraps the atomic-launch port (originally from nirholas/atomic). Two-tx
// bundle: funder pays its own fee + the Jito tip and rent-funds the
// creator; creator signs createV2 in tx2. Either both land or neither
// does, so the on-chain `creator` is the creator wallet (not the funder)
// without forcing the creator to hold SOL up front.
//
// If `uri` is omitted, we upload metadata to pump.fun's IPFS endpoint
// first using the supplied name/symbol/description/socials/imageUrl. This
// makes the tool a one-shot "launch from scratch".
//
// EXECUTION ACTION — creates a real mint on Solana mainnet and pays
// Jito tips + rent.

import { z } from 'zod';

import { atomicLaunch, uploadPumpMetadata } from '../lib/atomic-launch.js';

export const def = {
	name: 'pump_launch',
	title: 'Atomic pump.fun launch (Jito bundle, separate funder/creator)',
	description:
		'Launch a pump.fun token atomically via a Jito bundle. Funder pays its own fee + tip and rent-funds the creator; creator signs createV2 in tx2 — both txs land in the same block or neither does. If uri is omitted, metadata is uploaded to pump.fun IPFS first from name/symbol/description/socials/imageUrl. Returns the mint address, bundle id, both tx signatures, and the pump.fun URL. EXECUTION ACTION — creates a real mint on mainnet.',
	inputSchema: {
		name: z.string().min(1).max(32).describe('Token name.'),
		symbol: z.string().min(1).max(10).describe('Token symbol (ticker).'),
		funderSecret: z.string().describe('Base58 secret of the funder wallet (pays Tx1 fee + tip + rent transfer).'),
		creatorSecret: z.string().describe('Base58 secret of the creator wallet (signs createV2 — becomes on-chain creator).'),
		uri: z.string().url().optional().describe('Existing metadata URI. If omitted, metadata is uploaded first.'),
		description: z.string().max(500).optional(),
		twitter: z.string().optional(),
		telegram: z.string().optional(),
		website: z.string().optional(),
		imageUrl: z.string().url().optional().describe('Image to upload as the token icon (re-fetched at upload time).'),
		mintSecret: z.string().optional().describe('Base58 secret to use as the mint keypair (default: random).'),
		rentSol: z.number().min(0).optional().describe('SOL the funder transfers to the creator for tx2 rent + fees (default 0.035).'),
		jitoTipSol: z.number().min(0).optional().describe('Jito tip in SOL (default 0.005).'),
		priorityMicroLamports: z.number().int().min(0).max(20_000_000).optional()
			.describe('Compute-unit priority price (default 2_000_000).'),
	},
	async handler(args) {
		try {
			let uri = args.uri;
			let uploadedMeta = null;
			if (!uri) {
				uploadedMeta = await uploadPumpMetadata({
					name: args.name,
					symbol: args.symbol,
					description: args.description || '',
					twitter: args.twitter || '',
					telegram: args.telegram || '',
					website: args.website || '',
					imageUrl: args.imageUrl,
				});
				uri = uploadedMeta.uri;
				if (!uri) {
					return { ok: false, error: 'metadata_upload_failed', detail: uploadedMeta.raw };
				}
			}
			const out = await atomicLaunch({
				name: args.name,
				symbol: args.symbol,
				uri,
				funderSecret: args.funderSecret,
				creatorSecret: args.creatorSecret,
				mintSecret: args.mintSecret,
				rentSol: args.rentSol,
				jitoTipSol: args.jitoTipSol,
				priorityMicroLamports: args.priorityMicroLamports,
			});
			return { ...out, metadataUri: uri, metadataUploadedNow: !!uploadedMeta };
		} catch (err) {
			return { ok: false, error: err.code || 'launch_failed', message: err.message };
		}
	},
};
