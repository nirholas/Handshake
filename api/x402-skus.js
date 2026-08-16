// x402 Checkout SKUs — REST endpoint.
//
// A SKU is a hosted checkout link: merchant creates one in their dashboard,
// gets a URL like /pay/c/<slug>, and shares it. The buyer-facing page opens
// the drop-in payment modal pre-wired to the SKU's target endpoint.
//
//   GET  /api/x402-skus                 → list my SKUs (auth)
//   POST /api/x402-skus                 → create SKU (auth)
//   PATCH /api/x402-skus?id=…           → update SKU (auth, owner only)
//   DELETE /api/x402-skus?id=…          → archive SKU (auth, owner only)
//   GET  /api/x402-skus?slug=…          → public read (no auth) — what /pay/c/<slug> uses
//   GET  /api/x402-skus?id=…&stats=1    → revenue/call stats (auth, owner only)

import { z } from 'zod';
import { sql } from './_lib/db.js';
import { getSessionUser } from './_lib/auth.js';
import { cors, json, readJson, wrap, error, rateLimited } from './_lib/http.js';
import { parse } from './_lib/validate.js';
import { clientIp, limits } from './_lib/rate-limit.js';

const slugSchema = z
	.string()
	.trim()
	.min(3)
	.max(64)
	.regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/, 'slug must be lowercase, hyphenated, 3-64 chars');

const httpsUrl = z
	.string()
	.url()
	.refine((v) => v.startsWith('https://') || v.startsWith('http://localhost'), 'must be https');

const createSchema = z.object({
	slug: slugSchema,
	target_endpoint: httpsUrl,
	target_method: z.enum(['GET', 'POST']).default('GET'),
	target_body: z.record(z.any()).optional(),
	merchant_name: z.string().trim().min(1).max(80),
	action_name: z.string().trim().min(1).max(80),
	description: z.string().trim().max(2000).optional(),
	logo_url: httpsUrl.optional(),
	image_url: httpsUrl.optional(),
	accent_color: z
		.string()
		.regex(/^#[0-9a-fA-F]{6}$/)
		.default('#111111'),
	success_url: httpsUrl.optional(),
	// Storefront display fields — optional, never block a paid call.
	price_atomics: z
		.string()
		.regex(/^\d{1,20}$/)
		.optional(),
	price_network: z.enum(['base', 'solana']).optional(),
	position: z.number().int().min(0).max(9999).optional(),
	active: z.boolean().optional(),
});

const updateSchema = createSchema.partial();

// `x402_skus.id` is a uuid column. Binding a non-uuid straight into the query
// makes Postgres throw 22P02, which surfaced as a 500 (with a support ref) on an
// obvious caller mistake; check the shape first and answer 400.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolve the required `?id=` for the owner-only routes. Sends the 4xx and
// returns null when the param is missing or malformed.
function requireSkuId(req, res) {
	const raw = req.query?.id;
	if (!raw) {
		error(res, 400, 'missing_id', 'query param `id` required');
		return null;
	}
	const id = String(raw);
	if (!UUID_RE.test(id)) {
		error(res, 400, 'invalid_id', 'query param `id` must be a SKU uuid');
		return null;
	}
	return id;
}

// Shape the merchant's giving config into the minimal public payload the checkout
// modal needs — or null when nothing is active. Round-up routes to the same cause
// wallet, so both primitives require a charity address to mean anything.
function publicGiving(row) {
	const hasAddress = !!row.charity_address;
	const charityActive = !!row.charity_enabled && hasAddress && Number(row.charity_bps) > 0;
	const roundupActive = !!row.roundup_enabled && hasAddress && !!row.roundup_to_atomics;
	if (!charityActive && !roundupActive) return null;
	return {
		charity_enabled: charityActive,
		charity_name: row.charity_name || null,
		charity_chain: row.charity_chain || null,
		charity_address: row.charity_address || null,
		charity_bps: charityActive ? Number(row.charity_bps) : 0,
		roundup_enabled: roundupActive,
		roundup_to_atomics: roundupActive ? String(row.roundup_to_atomics) : null,
	};
}

export default wrap(async (req, res) => {
	// Public reads (`?slug=` and stats for non-owner) need permissive CORS so the
	// hosted checkout page running on a tenant subdomain can still call us.
	if (cors(req, res, { origins: '*', methods: 'GET,POST,PATCH,DELETE,OPTIONS' })) return;

	const method = req.method;
	if (method === 'GET') return handleGet(req, res);
	if (method === 'POST') return handleCreate(req, res);
	if (method === 'PATCH') return handleUpdate(req, res);
	if (method === 'DELETE') return handleArchive(req, res);
	return error(res, 405, 'method_not_allowed', `unsupported: ${method}`);
});

async function handleGet(req, res) {
	const { slug, id, stats } = req.query || {};
	if (slug) {
		// Public read for hosted checkout page. Join the merchant's giving config
		// so the checkout modal can offer the buyer a charity split / round-up that
		// settles in the same signed transaction.
		const [row] = await sql`
			select s.id, s.slug, s.target_endpoint, s.target_method, s.target_body,
			       s.merchant_name, s.action_name, s.description, s.logo_url, s.image_url, s.accent_color,
			       s.success_url, s.price_atomics, s.price_network,
			       m.charity_enabled, m.charity_name, m.charity_chain, m.charity_address, m.charity_bps,
			       m.roundup_enabled, m.roundup_to_atomics
			from x402_skus s
			left join x402_merchant_settings m on m.owner_user_id = s.owner_user_id
			where s.slug = ${String(slug)} and s.archived_at is null
			limit 1
		`;
		if (!row) return error(res, 404, 'sku_not_found', `no active SKU with slug "${slug}"`);
		const giving = publicGiving(row);
		const sku = {
			id: row.id,
			slug: row.slug,
			target_endpoint: row.target_endpoint,
			target_method: row.target_method,
			target_body: row.target_body,
			merchant_name: row.merchant_name,
			action_name: row.action_name,
			description: row.description,
			logo_url: row.logo_url,
			image_url: row.image_url,
			accent_color: row.accent_color,
			success_url: row.success_url,
			price_atomics: row.price_atomics,
			price_network: row.price_network,
		};
		return json(res, 200, { sku, giving });
	}

	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	if (id) {
		const skuId = String(id);
		if (!UUID_RE.test(skuId)) {
			return error(res, 400, 'invalid_id', 'query param `id` must be a SKU uuid');
		}
		const [row] = await sql`
			select id, slug, owner_user_id, target_endpoint, target_method, target_body,
			       merchant_name, action_name, description, logo_url, image_url, accent_color,
			       success_url, price_atomics, price_network, position, active,
			       created_at, updated_at, archived_at
			from x402_skus
			where id = ${skuId} limit 1
		`;
		if (!row) return error(res, 404, 'sku_not_found', 'no such SKU');
		if (row.owner_user_id !== user.id) return error(res, 403, 'forbidden', 'not owner');
		if (stats === '1') {
			const calls = await sql`
				select
				  count(*)::int as total_calls,
				  count(*) filter (where response_status < 400)::int as paid_calls,
				  coalesce(sum(case when response_status < 400 then amount_atomics::numeric else 0 end), 0)::text as gross_atomics,
				  count(distinct payer_address) filter (where payer_address is not null)::int as unique_payers,
				  max(paid_at) as last_paid_at
				from x402_checkout_calls where sku_id = ${row.id}
			`;
			const recent = await sql`
				select paid_at, network, tx_signature, payer_address, amount_atomics, asset, response_status
				from x402_checkout_calls where sku_id = ${row.id}
				order by paid_at desc limit 25
			`;
			return json(res, 200, { sku: row, stats: calls[0], recent });
		}
		return json(res, 200, { sku: row });
	}

	const rows = await sql`
		select s.id, s.slug, s.target_endpoint, s.target_method,
		       s.merchant_name, s.action_name, s.accent_color, s.image_url,
		       s.price_atomics, s.price_network, s.position, s.active,
		       s.created_at, s.updated_at,
		       (select count(*)::int from x402_checkout_calls c where c.sku_id = s.id and c.response_status < 400) as paid_calls,
		       (select coalesce(sum(amount_atomics::numeric), 0)::text from x402_checkout_calls c where c.sku_id = s.id and c.response_status < 400) as gross_atomics
		from x402_skus s
		where s.owner_user_id = ${user.id} and s.archived_at is null
		order by s.position asc, s.created_at desc
	`;
	return json(res, 200, { skus: rows });
}

async function handleCreate(req, res) {
	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(createSchema, await readJson(req));

	// Verify the slug isn't taken (UNIQUE constraint will also catch this).
	const [existing] = await sql`select id from x402_skus where slug = ${body.slug} limit 1`;
	if (existing) return error(res, 409, 'slug_taken', `slug "${body.slug}" is already in use`);

	const [created] = await sql`
		insert into x402_skus (
			owner_user_id, slug, target_endpoint, target_method, target_body,
			merchant_name, action_name, description, logo_url, image_url, accent_color, success_url,
			price_atomics, price_network, position, active
		) values (
			${user.id}, ${body.slug}, ${body.target_endpoint}, ${body.target_method},
			${body.target_body ? JSON.stringify(body.target_body) : null}::jsonb,
			${body.merchant_name}, ${body.action_name},
			${body.description ?? null}, ${body.logo_url ?? null}, ${body.image_url ?? null},
			${body.accent_color}, ${body.success_url ?? null},
			${body.price_atomics ?? null}, ${body.price_network ?? null},
			${body.position ?? 0}, ${body.active ?? true}
		)
		returning id, slug, merchant_name, action_name, created_at
	`;
	return json(res, 201, { sku: created, url: `/pay/c/${created.slug}` });
}

async function handleUpdate(req, res) {
	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const id = requireSkuId(req, res);
	if (!id) return;

	const [row] = await sql`select owner_user_id from x402_skus where id = ${id} limit 1`;
	if (!row) return error(res, 404, 'sku_not_found', 'no such SKU');
	if (row.owner_user_id !== user.id) return error(res, 403, 'forbidden', 'not owner');

	const patch = parse(updateSchema, await readJson(req));

	const [updated] = await sql`
		update x402_skus set
		  slug = coalesce(${patch.slug ?? null}, slug),
		  target_endpoint = coalesce(${patch.target_endpoint ?? null}, target_endpoint),
		  target_method = coalesce(${patch.target_method ?? null}, target_method),
		  target_body = coalesce(${patch.target_body ? JSON.stringify(patch.target_body) : null}::jsonb, target_body),
		  merchant_name = coalesce(${patch.merchant_name ?? null}, merchant_name),
		  action_name = coalesce(${patch.action_name ?? null}, action_name),
		  description = coalesce(${patch.description ?? null}, description),
		  logo_url = coalesce(${patch.logo_url ?? null}, logo_url),
		  image_url = coalesce(${patch.image_url ?? null}, image_url),
		  accent_color = coalesce(${patch.accent_color ?? null}, accent_color),
		  success_url = coalesce(${patch.success_url ?? null}, success_url),
		  price_atomics = coalesce(${patch.price_atomics ?? null}, price_atomics),
		  price_network = coalesce(${patch.price_network ?? null}, price_network),
		  position = coalesce(${patch.position ?? null}, position),
		  active = coalesce(${patch.active ?? null}, active),
		  updated_at = now()
		where id = ${id}
		returning id, slug, merchant_name, action_name, updated_at
	`;
	return json(res, 200, { sku: updated });
}

async function handleArchive(req, res) {
	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const id = requireSkuId(req, res);
	if (!id) return;

	const [row] = await sql`select owner_user_id from x402_skus where id = ${id} limit 1`;
	if (!row) return error(res, 404, 'sku_not_found', 'no such SKU');
	if (row.owner_user_id !== user.id) return error(res, 403, 'forbidden', 'not owner');

	await sql`update x402_skus set archived_at = now() where id = ${id}`;
	return json(res, 200, { ok: true });
}
