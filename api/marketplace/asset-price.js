/**
 * /api/marketplace/asset-price
 *
 * Owner-driven price configuration for whole assets in the marketplace
 * (avatars, agents, plugins). Skills have their own table — this one is for
 * "buy the avatar / agent / plugin itself" listings.
 *
 *   GET  ?item_type=avatar&item_id=<uuid>          → public read, returns active price or null
 *   POST { item_type, item_id, amount, currency_mint?, chain? }
 *        amount=0 deactivates the listing (back to free). Only the owner of the
 *        underlying entity may write.
 *
 * Currency defaults: USDC on Solana mainnet, 6 decimals.
 */

import { sql } from '../_lib/db.js';
import { authenticateBearer, extractBearer, getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { z } from 'zod';

const DEFAULT_USDC_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const ITEM_TYPES = ['avatar', 'agent', 'plugin'];

const postBody = z.object({
	item_type:     z.enum(ITEM_TYPES),
	item_id:       z.string().uuid(),
	amount:        z.number().int().min(0).max(2_000_000_000_000), // 2M USDC ceiling, sanity bound
	currency_mint: z.string().trim().min(1).max(100).default(DEFAULT_USDC_MAINNET),
	chain:         z.enum(['solana']).default('solana'), // start Solana-only; matches skill flow
	mint_decimals: z.number().int().min(0).max(18).default(6),
});

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

// Confirms the caller owns the asset they're trying to price.
async function getOwnerUserId(itemType, itemId) {
	if (itemType === 'avatar') {
		const [row] = await sql`SELECT owner_id AS user_id FROM avatars WHERE id = ${itemId} AND deleted_at IS NULL`;
		return row?.user_id ?? null;
	}
	if (itemType === 'agent') {
		const [row] = await sql`SELECT user_id FROM agent_identities WHERE id = ${itemId} AND deleted_at IS NULL`;
		return row?.user_id ?? null;
	}
	if (itemType === 'plugin') {
		const [row] = await sql`SELECT author_id AS user_id FROM plugins WHERE id = ${itemId} AND deleted_at IS NULL`;
		return row?.user_id ?? null;
	}
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;
	if (req.method === 'GET') return handleGet(req, res);
	return handleSet(req, res);
});

async function handleGet(req, res) {
	const url = new URL(req.url, 'http://x');
	const itemType = url.searchParams.get('item_type');
	const itemId = url.searchParams.get('item_id');
	if (!ITEM_TYPES.includes(itemType) || !itemId) {
		return error(res, 400, 'validation_error', 'item_type and item_id required');
	}

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const [row] = await sql`
		SELECT ap.amount, ap.currency_mint, ap.chain, ap.mint_decimals, ap.owner_user_id, ap.updated_at,
		       pw.address AS payout_address
		FROM asset_prices ap
		LEFT JOIN agent_payout_wallets pw
		  ON pw.user_id = ap.owner_user_id
		 AND pw.chain = ap.chain
		 AND pw.is_default = true
		WHERE ap.item_type = ${itemType} AND ap.item_id = ${itemId} AND ap.is_active = true
		ORDER BY pw.created_at ASC
		LIMIT 1
	`;
	if (!row) return json(res, 200, { data: { price: null, sellable: false } });
	return json(res, 200, {
		data: {
			price: {
				amount: String(row.amount),
				currency_mint: row.currency_mint,
				chain: row.chain,
				mint_decimals: row.mint_decimals,
				updated_at: row.updated_at,
			},
			sellable: !!row.payout_address,
		},
	});
}

async function handleSet(req, res) {
	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = await readJson(req).catch(() => null);
	if (!body) return error(res, 400, 'validation_error', 'request body required');
	const parsed = postBody.safeParse(body);
	if (!parsed.success) {
		return error(res, 400, 'validation_error', parsed.error.issues[0]?.message || 'validation error');
	}
	const { item_type, item_id, amount, currency_mint, chain, mint_decimals } = parsed.data;

	const ownerId = await getOwnerUserId(item_type, item_id);
	if (!ownerId) return error(res, 404, 'not_found', 'asset not found');
	if (ownerId !== auth.userId) return error(res, 403, 'forbidden', 'not your asset');

	if (amount === 0) {
		await sql`
			UPDATE asset_prices
			SET is_active = false, updated_at = now()
			WHERE item_type = ${item_type} AND item_id = ${item_id} AND is_active = true
		`;
		return json(res, 200, { data: { ok: true, price: null } });
	}

	await sql`
		INSERT INTO asset_prices (item_type, item_id, owner_user_id, amount, currency_mint, chain, mint_decimals, is_active)
		VALUES (${item_type}, ${item_id}, ${auth.userId}, ${amount}, ${currency_mint}, ${chain}, ${mint_decimals}, true)
		ON CONFLICT (item_type, item_id)
		DO UPDATE SET
			amount        = EXCLUDED.amount,
			currency_mint = EXCLUDED.currency_mint,
			chain         = EXCLUDED.chain,
			mint_decimals = EXCLUDED.mint_decimals,
			owner_user_id = EXCLUDED.owner_user_id,
			is_active     = true,
			updated_at    = now()
	`;

	return json(res, 200, {
		data: {
			ok: true,
			price: { amount: String(amount), currency_mint, chain, mint_decimals },
		},
	});
}
