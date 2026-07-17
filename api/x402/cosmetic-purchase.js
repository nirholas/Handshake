// GET /api/x402/cosmetic-purchase?id=<cosmeticId>&account=<accountId>
//
// The avatar shop's checkout (R22). Buying a premium cosmetic settles a real
// USDC payment over x402 (Base or Solana) and, on a verified payment, records
// ownership of that cosmetic to the buyer's account in the durable ownership
// ledger (api/_lib/cosmetics-ownership.js). The shop (R21) and the owned
// inventory (R23) read that ledger back.
//
// Pricing is per rarity and SERVER-OWNED — the USDC amount comes from the
// catalog (api/_lib/cosmetics.js), never from the client, so a buyer can't move
// the price. The $THREE figure the shop quotes is the item's coin-facing value;
// USDC is only the settlement asset, exactly as every other /api/x402/* endpoint.
//
// "Buy once, owned forever": each (cosmetic, wallet) pair gets a permanent SIWX
// grant baked to the item id, so a wallet that already paid re-accesses for free
// by signing — and the handler re-grants ownership idempotently each time. The
// on-chain payment itself is single-use (the facilitator won't settle the same
// signed proof twice), and the ownership SET is idempotent, so the flow is safe
// against replay and can never double-grant.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema, paymentRequirements, send402 } from '../_lib/x402-spec.js';
import { priceFor } from '../_lib/x402-prices.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { error } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { getCosmetic, priceUsdcAtomicsOf } from '../_lib/cosmetics.js';
import { grantCosmeticOwnership, normalizeAccountId } from '../_lib/cosmetics-ownership.js';
import { recordSaleAndSplit, isMint } from '../_lib/cosmetics-economy.js';
import cosmeticPurchaseListing from '../_lib/service-catalog/services/cosmetic-purchase.js';

const ROUTE = '/api/x402/cosmetic-purchase';

// Single source of truth:
// api/_lib/service-catalog/services/cosmetic-purchase.js is the storefront
// listing copy — importing it here keeps the live 402 challenge from drifting
// from what /.well-known/x402.json and the OKX projection advertise (same
// pattern as forge.js → forge-listing.js).
const DESCRIPTION = cosmeticPurchaseListing.description;

const INPUT_EXAMPLE = { id: 'skin-midnight', account: 'g_5f3c9a21b8' };

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['id', 'account'],
	properties: {
		id: {
			type: 'string',
			description: 'Premium cosmetic id from /api/cosmetics/catalog.',
			minLength: 1,
			maxLength: 64,
		},
		account: {
			type: 'string',
			description:
				'The account the cosmetic is granted to — a Solana wallet address or ' +
				'a guest id (g_…). Ownership is keyed here, not on the paying wallet.',
			minLength: 3,
			maxLength: 64,
		},
	},
};

const OUTPUT_EXAMPLE = {
	ok: true,
	id: 'skin-midnight',
	name: 'Midnight',
	slot: 'skin',
	rarity: 'legendary',
	account: 'g_5f3c9a21b8',
	owned: true,
	newlyOwned: true,
	payer: 'wwwPqsM4N7T9J69tB82nLyzxqsH159j4orftLTQfUGV',
	network: 'solana',
	amountAtomics: '3000000',
	asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['ok', 'id', 'name', 'slot', 'rarity', 'account', 'owned'],
	properties: {
		ok: { type: 'boolean', const: true },
		id: { type: 'string' },
		name: { type: 'string' },
		slot: { type: 'string' },
		rarity: { type: 'string' },
		account: { type: 'string' },
		owned: { type: 'boolean', const: true },
		newlyOwned: { type: 'boolean' },
		payer: { type: ['string', 'null'] },
		network: { type: ['string', 'null'] },
		amountAtomics: { type: ['string', 'null'] },
		asset: { type: ['string', 'null'] },
		// Coin the sale was tied to (R25), and the creator split that paid out.
		coin: { type: ['string', 'null'] },
		split: {
			type: ['object', 'null'],
			properties: {
				creatorWallet: { type: ['string', 'null'] },
				creatorBps: { type: 'number' },
				creatorCutAtomics: { type: 'string' },
				payoutStatus: { type: 'string' },
				payoutTx: { type: ['string', 'null'] },
			},
		},
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'GET', queryParams: INPUT_EXAMPLE },
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'GET',
		queryParamsSchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

// Discovery probes (x402scan registration, Bazaar validators) hit the bare
// route with placeholder or missing query params and expect a valid 402
// challenge, not a 400/404 — the x402 discovery spec treats runtime 402 behavior
// as the source of truth, so request validation must not reject the probe before
// the payment middleware runs. This advertises the endpoint at a representative
// default price (env-overridable via X402_PRICE_COSMETIC_PURCHASE) with the full
// bazaar schema. No money can settle against it: a paid retry still needs a real
// ?id= + ?account= (the paymentPresent branches below keep their 400/404), and
// an X-PAYMENT envelope is only an authorization — USDC moves at settle, which
// this path never reaches. Mirrors asset-download.js sendDiscoveryChallenge.
function sendDiscoveryChallenge(res, errText) {
	const resourceUrl = `${env.APP_ORIGIN}${ROUTE}`;
	return send402(res, {
		resourceUrl,
		accepts: paymentRequirements(resourceUrl, {
			amount: priceFor('cosmetic-purchase', '500000'),
		}),
		description: DESCRIPTION,
		bazaar: BAZAAR,
		error: errText,
		serviceName: 'three.ws Avatar Shop',
		tags: ['3d', 'avatar', 'cosmetic', 'shop', 'wearable'],
	});
}

// Per-item paidEndpoint built on the fly: the id picks the catalog row, which
// dictates the USDC price; everything else is shared. Mirrors asset-download.js,
// where the slug drives a per-row price + SIWX grant.
export default async function handler(req, res) {
	const paymentPresent = Boolean(req.headers['x-payment'] || req.headers['payment-signature']);

	const id = req.query?.id ? String(req.query.id).trim() : '';
	if (!id) {
		if (paymentPresent) {
			return error(res, 400, 'id_required', 'query parameter "id" is required');
		}
		return sendDiscoveryChallenge(
			res,
			'query parameter "id" is required — retry with ?id=<cosmeticId>&account=<accountId> from /api/cosmetics/catalog for that item’s exact price',
		);
	}

	const account = normalizeAccountId(req.query?.account);
	if (!account) {
		if (paymentPresent) {
			return error(res, 400, 'account_required',
				'query parameter "account" is required (a Solana wallet or guest id)');
		}
		return sendDiscoveryChallenge(
			res,
			'query parameter "account" is required (a Solana wallet or guest id) — retry with ?id=<cosmeticId>&account=<accountId>',
		);
	}

	// Coin-tied sale (R25): when bought inside a coin's /play world, the optional
	// `coin` mint ties the sale to that coin so a configurable share of the settled
	// USDC pays out to the coin's creator. Untied (no/invalid coin) → full platform
	// revenue, exactly as before.
	const coin = isMint(String(req.query?.coin || '').trim()) ? String(req.query.coin).trim() : null;

	const item = getCosmetic(id);
	if (!item) {
		if (paymentPresent) {
			return error(res, 404, 'cosmetic_not_found', `no cosmetic with id "${id}"`);
		}
		return sendDiscoveryChallenge(
			res,
			`no cosmetic with id "${id}" — browse /api/cosmetics/catalog for available premium ids`,
		);
	}
	if (!item.premium) {
		// Base-pack items ship owned with every avatar — there's nothing to sell.
		if (paymentPresent) {
			return error(res, 400, 'not_purchasable',
				`cosmetic "${id}" is part of the free base pack and is already owned`);
		}
		return sendDiscoveryChallenge(
			res,
			`cosmetic "${id}" is part of the free base pack and is already owned — pick a premium id from /api/cosmetics/catalog`,
		);
	}

	const priceAtomics = priceUsdcAtomicsOf(item);

	const inner = paidEndpoint({
		route: ROUTE,
		method: 'GET',
		priceAtomics,
		networks: ['base', 'solana'],
		description: `${DESCRIPTION} — currently unlocking: ${item.name} (${item.rarity}).`,
		bazaar: BAZAAR,
		service: withService({
			serviceName: 'three.ws Avatar Shop',
			tags: ['3d', 'avatar', 'cosmetic', 'shop', 'wearable'],
		}),
		// Bake the item id into the resource URL so the SIWX grant is per-cosmetic:
		// without this, paying for one cosmetic would unlock every cosmetic via a
		// single signature (the SIWX row is keyed on (resource, wallet) only). The
		// 402 challenge advertises the same URL the client signs against.
		resourceUrlBuilder: () =>
			`${env.APP_ORIGIN}${ROUTE}?id=${encodeURIComponent(item.id)}`,
		siwx: {
			statement: `Sign in to confirm you own "${item.name}" without re-paying.`,
			// Permanent per (cosmetic, wallet) — once paid, re-confirm forever by signing.
			ttlSeconds: null,
			expirationSeconds: 300,
		},
		async handler({ requirement, payer }) {
			// Record ownership BEFORE settlement returns to the buyer. grant throws
			// (503) if the durable store is missing — fail closed, so we never settle
			// a charge we can't record. Idempotent: a re-paid/replayed call just
			// re-confirms the existing unlock.
			const newlyOwned = await grantCosmeticOwnership(account, item.id);

			// Coin-tied creator split (R25). Only on a fresh, genuinely-settled
			// purchase: `requirement` is null on the SIWX free-re-access path, and
			// newlyOwned is false on a re-grant — either way we never re-record or
			// re-pay. The split records the sale and pays the creator's USDC cut
			// on-chain; it's best-effort and never throws, so a recording/payout
			// hiccup can't undo the unlock the buyer already paid for.
			let split = null;
			if (requirement && newlyOwned) {
				const result = await recordSaleAndSplit({
					account,
					cosmeticId: item.id,
					item,
					payerWallet: payer ?? null,
					payerNetwork: requirement?.network ?? null,
					asset: requirement?.asset ?? null,
					priceAtomics: requirement?.amount ?? priceAtomics,
					mint: coin,
				});
				if (result?.creatorWallet) {
					split = {
						creatorWallet: result.creatorWallet,
						creatorBps: result.creatorBps,
						creatorCutAtomics: result.creatorCutAtomics,
						payoutStatus: result.payoutStatus,
						payoutTx: result.payoutTx ?? null,
					};
				}
			}

			return {
				ok: true,
				id: item.id,
				name: item.name,
				slot: item.slot,
				rarity: item.rarity,
				account,
				owned: true,
				newlyOwned,
				payer: payer ?? null,
				network: requirement?.network ?? null,
				amountAtomics: requirement?.amount ?? null,
				asset: requirement?.asset ?? null,
				coin: coin ?? null,
				split,
			};
		},
	});

	return inner(req, res);
}

export const BAZAAR_SCHEMA = BAZAAR;
