// POST /api/x402/pump-launch
//
// Paid endpoint cataloged by the CDP x402 Bazaar. For a flat USDC fee the
// server deploys a brand-new pump.fun token (bonding-curve create — no dev buy)
// on behalf of an anonymous buyer. The buyer pays in USDC on Base or Solana via
// the 402 challenge; a funded server keypair fronts the ~0.022 SOL deploy cost
// and signs the create-coin transaction, so the buyer needs neither SOL nor a
// three.ws account.
//
// The buyer supplies metadata one of two ways:
//   1. `metadataUri` — already pinned (use scripts/pump-upload-metadata or any
//      pump.fun-compatible IPFS descriptor); we point the create tx straight at it.
//   2. `imageUrl` (+ name/symbol/description/socials) — we fetch the image, pin
//      it and a descriptor to pump.fun's IPFS, and use the resulting metadataUri.
//
// pump.fun creator rewards accrue to `creator` (any Solana pubkey the buyer
// nominates); default is the launcher. An optional `vanityPrefix`/`vanitySuffix`
// grinds a custom mint address before deploy.
//
// The launch runs AFTER payment verification but BEFORE settlement: a bad image
// URL, IPFS failure, or RPC error throws here and settlement never runs, so a
// failed deploy costs the buyer nothing. Payment-identifier idempotency makes a
// retried payment return the SAME mint + signature instead of double-launching.
//
// Networks: Base mainnet + Solana mainnet (USDC). pump.fun itself is mainnet.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import { readJson } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { loadLauncherKeypair, uploadPumpMetadata, launchPumpToken } from '../_lib/pump-launch.js';
import { z } from 'zod';

const ROUTE = '/api/x402/pump-launch';
const REQUIRED_SCOPE = 'x402:bypass';

// Flat fee in USDC atomics (6 decimals). Default $5.00 comfortably covers the
// ~0.022 SOL deploy cost the launcher fronts plus margin. Tune per unit
// economics with X402_PRICE_PUMP_LAUNCH=<atomics>.
const PRICE_ATOMICS = priceFor('pump-launch', '5000000');

const DESCRIPTION =
	'three.ws Pump Launcher — deploy a brand-new pump.fun token in one paid call. ' +
	'Supply a name, symbol, and either a pre-pinned metadataUri or an imageUrl ' +
	'(we pin the image + descriptor to pump.fun IPFS for you). The server fronts ' +
	'the SOL deploy cost and signs the create-coin tx, so you need no SOL and no ' +
	'account — just USDC. Creator rewards accrue to any Solana wallet you nominate. ' +
	'Optional vanity prefix/suffix grinds a custom mint address. Returns the mint, ' +
	'tx signature, and pump.fun URL. Pay-per-call in USDC on Base or Solana mainnet.';

const INPUT_EXAMPLE = {
	name: 'Helios',
	symbol: 'HELIO',
	imageUrl: 'https://example.com/helios.png',
	description: 'A sun-themed community coin.',
	creator: 'wwwPqsM4N7T9J69tB82nLyzxqsH159j4orftLTQfUGV',
	twitter: 'https://x.com/heliocoin',
};

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['name', 'symbol'],
	properties: {
		name: { type: 'string', maxLength: 32, description: 'Token name.' },
		symbol: { type: 'string', maxLength: 10, description: 'Token ticker.' },
		metadataUri: {
			type: 'string',
			format: 'uri',
			description: 'Pre-pinned pump.fun metadata descriptor. Provide this OR imageUrl.',
		},
		imageUrl: {
			type: 'string',
			format: 'uri',
			description:
				'https URL of the token image. When metadataUri is omitted, the image + a ' +
				'descriptor are pinned to pump.fun IPFS (png, jpeg, gif, webp; max 5 MB).',
		},
		description: { type: 'string', maxLength: 2000 },
		twitter: { type: 'string', maxLength: 2048 },
		telegram: { type: 'string', maxLength: 2048 },
		website: { type: 'string', maxLength: 2048 },
		creator: {
			type: 'string',
			description: 'Solana pubkey to receive pump.fun creator rewards. Defaults to the launcher.',
		},
		vanityPrefix: { type: 'string', maxLength: 5, description: 'Base58 prefix for the mint address.' },
		vanitySuffix: { type: 'string', maxLength: 5, description: 'Base58 suffix for the mint address.' },
		vanityIgnoreCase: { type: 'boolean' },
	},
};

const OUTPUT_EXAMPLE = {
	mint: 'HEL1oXyzABCDEFGHJKLMNopqrstuvwxyZ12345abcdef',
	signature: '5xY...sig',
	creator: 'wwwPqsM4N7T9J69tB82nLyzxqsH159j4orftLTQfUGV',
	name: 'Helios',
	symbol: 'HELIO',
	metadataUri: 'https://ipfs.io/ipfs/Qm...',
	network: 'mainnet',
	explorer: 'https://solscan.io/tx/5xY...sig',
	pumpfun_url: 'https://pump.fun/coin/HEL1oXyzABCDEFGHJKLMNopqrstuvwxyZ12345abcdef',
	vanity_prefix: 'HEL',
	vanity_suffix: null,
	vanity_iterations: 4821,
	vanity_duration_ms: 190,
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['mint', 'signature', 'metadataUri', 'pumpfun_url'],
	properties: {
		mint: { type: 'string' },
		signature: { type: 'string' },
		creator: { type: 'string' },
		name: { type: 'string' },
		symbol: { type: 'string' },
		metadataUri: { type: 'string', format: 'uri' },
		network: { type: 'string' },
		explorer: { type: 'string', format: 'uri' },
		pumpfun_url: { type: 'string', format: 'uri' },
		vanity_prefix: { type: ['string', 'null'] },
		vanity_suffix: { type: ['string', 'null'] },
		vanity_iterations: { type: 'integer' },
		vanity_duration_ms: { type: 'number' },
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'POST', body: INPUT_EXAMPLE },
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodyType: 'json',
		bodySchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

// Base58 (no 0/O/I/l) — used to bound vanity patterns before grinding.
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

const bodySchema = z
	.object({
		name: z.string().trim().min(1).max(32),
		symbol: z.string().trim().min(1).max(10),
		metadataUri: z.string().url().max(2048).optional(),
		imageUrl: z.string().url().max(2048).optional(),
		description: z.string().max(2000).optional(),
		twitter: z.string().max(2048).optional(),
		telegram: z.string().max(2048).optional(),
		website: z.string().max(2048).optional(),
		creator: z.string().min(32).max(44).optional(),
		vanityPrefix: z.string().min(1).max(5).regex(BASE58_RE, 'vanityPrefix must be base58').optional(),
		vanitySuffix: z.string().min(1).max(5).regex(BASE58_RE, 'vanitySuffix must be base58').optional(),
		vanityIgnoreCase: z.boolean().optional(),
	})
	.refine((b) => b.metadataUri || b.imageUrl, {
		message: 'provide either metadataUri or imageUrl',
	});

function badRequest(code, message) {
	return Object.assign(new Error(message), { status: 400, code });
}

// Map a CAIP-2 requirement network to the short label stored on the launch row.
function paymentNetworkLabel(caip2) {
	if (!caip2) return null;
	if (caip2.startsWith('solana')) return 'solana';
	if (caip2 === 'eip155:56') return 'bsc';
	if (caip2.startsWith('eip155')) return 'base';
	return caip2;
}

export default paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: PRICE_ATOMICS,
	networks: ['base', 'solana'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Pump Launcher',
		tags: ['pump.fun', 'launch', 'deploy', 'token', 'solana', 'mint'],
	}),
	requiredScope: REQUIRED_SCOPE,
	accessControl: installAccessControl({ requiredScope: REQUIRED_SCOPE }),
	// A duplicate launch is materially expensive (real SOL + a real on-chain
	// mint). When a client sends a payment identifier, a same-proof retry
	// replays the cached mint instead of launching again. Kept optional (not
	// required) so generic Bazaar buyers without the extension still work — the
	// facilitator's single-use payment nonce already blocks double-settlement.
	paymentIdentifier: {},
	async handler({ req, requirement, payer }) {
		// Parse + validate the body. Thrown 4xx here happens BEFORE settle, so a
		// malformed request never charges the buyer.
		let raw;
		try {
			raw = await readJson(req);
		} catch (err) {
			throw badRequest('invalid_body', err.message || 'invalid JSON body');
		}
		let body;
		try {
			body = bodySchema.parse(raw);
		} catch (e) {
			throw badRequest('validation_error', e.errors?.[0]?.message || 'invalid body');
		}

		// Launcher must be configured + funded before we do any work.
		const launcher = loadLauncherKeypair();

		// Resolve the metadata descriptor: pinned URI wins; otherwise pin the image.
		let metadataUri = body.metadataUri;
		if (!metadataUri) {
			const pinned = await uploadPumpMetadata({
				imageUrl: body.imageUrl,
				name: body.name,
				symbol: body.symbol,
				description: body.description || '',
				twitter: body.twitter || '',
				telegram: body.telegram || '',
				website: body.website || '',
				showName: true,
			});
			metadataUri = pinned.metadataUri;
		}

		const launched = await launchPumpToken({
			launcher,
			name: body.name,
			symbol: body.symbol,
			uri: metadataUri,
			creator: body.creator,
			vanityPrefix: body.vanityPrefix,
			vanitySuffix: body.vanitySuffix,
			vanityIgnoreCase: body.vanityIgnoreCase,
			network: 'mainnet',
		});

		const network = 'mainnet';
		const result = {
			mint: launched.mint,
			signature: launched.signature,
			creator: launched.creator,
			name: body.name,
			symbol: body.symbol,
			metadataUri,
			network,
			explorer: `https://solscan.io/tx/${launched.signature}`,
			pumpfun_url: `https://pump.fun/coin/${launched.mint}`,
			vanity_prefix: body.vanityPrefix || null,
			vanity_suffix: body.vanitySuffix || null,
			vanity_iterations: launched.vanityIterations,
			vanity_duration_ms: launched.vanityDurationMs,
		};

		// Index the launch for the catalog / analytics. Best-effort: the token is
		// already live on-chain, so a Neon hiccup must not fail the response.
		await sql`
			INSERT INTO x402_pump_launches
				(network, mint, name, symbol, metadata_uri, creator, launcher,
				 tx_signature, payer, payment_network, price_atomics,
				 vanity_prefix, vanity_suffix)
			VALUES
				(${network}, ${launched.mint}, ${body.name}, ${body.symbol}, ${metadataUri},
				 ${launched.creator}, ${launcher.publicKey.toBase58()},
				 ${launched.signature}, ${payer || null},
				 ${paymentNetworkLabel(requirement?.network)}, ${PRICE_ATOMICS},
				 ${body.vanityPrefix || null}, ${body.vanitySuffix || null})
			ON CONFLICT (mint, network) DO NOTHING
		`.catch((e) => console.error('[x402/pump-launch] index failed', e));

		return result;
	},
});
