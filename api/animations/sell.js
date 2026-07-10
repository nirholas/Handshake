// POST /api/animations/sell — list (or update / delist) an animation clip for
// sale in the marketplace.
//
// A creator authors an animation in the Studio (/pose), saves it (POST
// /api/animations/clips), bakes a self-contained animated GLB, uploads it to R2
// via /api/animations/presign, then calls this endpoint to set a price + payout
// and flip `listed = true`. The clip then surfaces in GET /api/marketplace/
// animations and sells through the x402 paid-download endpoint
// (api/x402/animation-download.js) — buy once in USDC, re-download free forever
// by signing in with the same wallet.
//
// Body (list / update):
//   { id, price, currency?, artifact_key, artifact_bytes?, artifact_mime?,
//     payto_base?, payto_solana?, payto_bsc?, listed? }
// Body (delist):
//   { id, action: 'delist' }
//
// price is a human USDC amount (e.g. 2.5). 0 / null lists the clip as a free
// download. Payout addresses default to the seller's default payout wallets
// (agent_payout_wallets) when omitted; a paid listing needs at least one.

import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { thumbnailUrl } from '../_lib/r2.js';
import { z } from 'zod';

// USDC only for now — the x402 facilitator settles USDC on Base + Solana.
const SUPPORTED_CURRENCIES = ['USDC'];
const MAX_PRICE = 100_000; // $100k ceiling — sanity bound, not a product limit.

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const listSchema = z.object({
	id: z.string().uuid(),
	action: z.literal('list').optional(),
	price: z.number().nonnegative().max(MAX_PRICE).optional(),
	currency: z.enum(SUPPORTED_CURRENCIES).default('USDC'),
	// The sellable artifact: a baked animated GLB staged in the caller's R2
	// namespace by /api/animations/presign.
	artifact_key: z.string().trim().min(1).max(512),
	artifact_bytes: z.number().int().positive().max(200 * 1024 * 1024).optional(),
	artifact_mime: z.enum(['model/gltf-binary', 'model/gltf+json']).default('model/gltf-binary'),
	payto_base: z.string().trim().regex(EVM_ADDR).optional(),
	payto_solana: z.string().trim().regex(SOL_ADDR).optional(),
	payto_bsc: z.string().trim().regex(EVM_ADDR).optional(),
	listed: z.boolean().default(true),
});

const delistSchema = z.object({
	id: z.string().uuid(),
	action: z.literal('delist'),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req, 'avatars:write');
	if (!auth) return error(res, 401, 'unauthorized', 'sign in or provide a valid bearer token');

	const rl = await limits.avatarPatch(auth.userId);
	if (!rl.success) return rateLimited(res, rl, 'too many listing changes');

	const raw = await readJson(req);
	if (!raw || typeof raw !== 'object') return error(res, 400, 'invalid_request', 'body required');

	if (raw.action === 'delist') return handleDelist(req, res, auth, raw);
	return handleList(req, res, auth, raw);
});

async function handleList(req, res, auth, raw) {
	const parsed = listSchema.safeParse(raw);
	if (!parsed.success) {
		return error(res, 400, 'validation_error', parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
	}
	const input = parsed.data;

	// The artifact must live in the caller's own R2 namespace — never let a
	// seller point a listing at another user's (or a system) object.
	const ns = `u/${auth.userId}/`;
	if (!input.artifact_key.startsWith(ns)) {
		return error(res, 403, 'forbidden', 'artifact_key must be in your own upload namespace');
	}

	const [clip] = await sql`
		select id, owner_id, name, slug, deleted_at
		from animation_clips
		where id = ${input.id} and deleted_at is null
		limit 1
	`;
	if (!clip || clip.owner_id !== auth.userId) {
		return error(res, 404, 'not_found', 'animation not found or not yours');
	}

	const priced = input.price && input.price > 0;

	// Resolve payout addresses: explicit overrides win, else fall back to the
	// seller's default payout wallets. A paid listing needs somewhere to settle.
	const payto = await resolvePayto(auth.userId, input);
	if (priced && !payto.base && !payto.solana) {
		return error(
			res,
			422,
			'payout_required',
			'Add a Base or Solana payout wallet (or pass payto_base / payto_solana) before pricing this animation.',
		);
	}

	const priceAmount = priced ? input.price : null;
	const priceCurrency = priced ? input.currency : null;

	// Visibility is left untouched here: the marketplace feed keys on `listed`,
	// so a listed clip surfaces with public metadata + poster while its baked
	// motion data stays gated behind the x402 paywall (a private clip's
	// GET /api/animations/clips/:id still 404s for non-owners). Listing for sale
	// is intentionally not the same as publishing the clip free to the gallery.
	let row;
	try {
		[row] = await sql`
			update animation_clips set
				listed = ${input.listed},
				price_amount = ${priceAmount},
				price_currency = ${priceCurrency},
				artifact_key = ${input.artifact_key},
				artifact_bytes = ${input.artifact_bytes ?? null},
				artifact_mime = ${input.artifact_mime},
				creator_payto_base = ${payto.base},
				creator_payto_solana = ${payto.solana},
				creator_payto_bsc = ${payto.bsc}
			where id = ${input.id} and owner_id = ${auth.userId} and deleted_at is null
			returning id, slug, name, visibility, listed, price_amount, price_currency,
			          artifact_bytes, artifact_mime, thumbnail_key, purchase_count
		`;
	} catch (err) {
		console.error('[animations/sell]', err?.message || err);
		return error(res, 500, 'db_error', 'Failed to update listing');
	}
	if (!row) return error(res, 404, 'not_found', 'animation not found or not yours');

	return json(res, 200, { listing: shape(row, payto) });
}

async function handleDelist(req, res, auth, raw) {
	const parsed = delistSchema.safeParse(raw);
	if (!parsed.success) return error(res, 400, 'validation_error', 'id required');

	const [row] = await sql`
		update animation_clips set listed = false
		where id = ${parsed.data.id} and owner_id = ${auth.userId} and deleted_at is null
		returning id, slug, name, visibility, listed, price_amount, price_currency,
		          artifact_bytes, artifact_mime, thumbnail_key, purchase_count,
		          creator_payto_base, creator_payto_solana, creator_payto_bsc
	`;
	if (!row) return error(res, 404, 'not_found', 'animation not found or not yours');
	return json(res, 200, {
		listing: shape(row, {
			base: row.creator_payto_base,
			solana: row.creator_payto_solana,
			bsc: row.creator_payto_bsc,
		}),
	});
}

// Explicit payout overrides win; otherwise pull the seller's default wallets.
async function resolvePayto(userId, input) {
	const out = {
		base: input.payto_base || null,
		solana: input.payto_solana || null,
		bsc: input.payto_bsc || null,
	};
	const missing = ['base', 'solana', 'bsc'].filter((c) => !out[c]);
	if (missing.length) {
		const rows = await sql`
			select chain, address from agent_payout_wallets
			where user_id = ${userId} and chain = any(${missing})
			order by is_default desc, created_at desc
		`;
		for (const c of missing) {
			const hit = rows.find((r) => r.chain === c);
			if (hit) out[c] = hit.address;
		}
	}
	return out;
}

function shape(row, payto) {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		visibility: row.visibility,
		listed: !!row.listed,
		price: row.price_amount ? { amount: String(row.price_amount), currency: row.price_currency } : null,
		artifact_bytes: row.artifact_bytes != null ? Number(row.artifact_bytes) : null,
		artifact_mime: row.artifact_mime || null,
		thumbnail_url: thumbnailUrl(row.thumbnail_key),
		purchase_count: Number(row.purchase_count || 0),
		payout: { base: payto.base || null, solana: payto.solana || null, bsc: payto.bsc || null },
	};
}

async function resolveAuth(req, requiredScope) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, source: 'session' };
	const bearer = await authenticateBearer(extractBearer(req));
	if (!bearer) return null;
	if (!hasScope(bearer.scope, requiredScope)) return null;
	return bearer;
}

export const __test__ = { listSchema, delistSchema, shape, resolvePayto };
