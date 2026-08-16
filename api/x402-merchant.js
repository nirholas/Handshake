// x402 Merchant Console — account settings for the "Stripe of x402".
//
// One settings row per merchant (user). Holds payout/agent wallets, default
// settlement network, branding, CORS allow-list, security limits, a hashed API
// key for the key-bypass lane, a settlement webhook, and a drag-and-drop
// storefront layout published at /store/<handle>.
//
//   GET    /api/x402-merchant                 → my settings (auth; lazily created)
//   PUT    /api/x402-merchant                 → upsert my settings (auth)
//   POST   /api/x402-merchant?action=rotate-key → mint a fresh API key (auth; shown once)
//   GET    /api/x402-merchant?store=<handle>  → public storefront + products (no auth)

import { z } from 'zod';
import { sql } from './_lib/db.js';
import { getSessionUser } from './_lib/auth.js';
import { cors, json, readJson, wrap, error, rateLimited } from './_lib/http.js';
import { parse } from './_lib/validate.js';
import { randomToken, sha256 } from './_lib/crypto.js';
import { clientIp, limits } from './_lib/rate-limit.js';

const evmAddress = z.string().trim().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x EVM address');
const solAddress = z
	.string()
	.trim()
	.regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'must be a base58 Solana address');
const httpsOrigin = z
	.string()
	.trim()
	.regex(/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i, 'must be an origin like https://example.com');
const httpsUrl = z
	.string()
	.trim()
	.url()
	.refine((v) => v.startsWith('https://') || v.startsWith('http://localhost'), 'must be https');
const atomics = z.string().trim().regex(/^\d{1,20}$/, 'must be a whole token amount');
const storeHandle = z
	.string()
	.trim()
	.toLowerCase()
	.regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'handle: lowercase, hyphenated, 3-40 chars');

// Agent wallets — the named on-chain identities a merchant authorizes to
// auto-pay (payer) or receive (payout) on its behalf, each capped independently.
// A misconfigured agent wallet moves real USDC, so the address is validated
// against its declared chain and the caps are whole-token atomics strings.
const agentWalletSchema = z
	.object({
		id: z.string().trim().min(1).max(40),
		label: z.string().trim().min(1).max(60),
		chain: z.enum(['base', 'solana']),
		role: z.enum(['payer', 'payout']),
		address: z.string().trim().min(1).max(64),
		enabled: z.boolean().default(true),
		per_call_cap_atomics: z
			.string()
			.regex(/^\d{1,20}$/)
			.nullish(),
		daily_cap_atomics: z
			.string()
			.regex(/^\d{1,20}$/)
			.nullish(),
	})
	.superRefine((w, ctx) => {
		const ok =
			w.chain === 'base'
				? /^0x[0-9a-fA-F]{40}$/.test(w.address)
				: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w.address);
		if (!ok) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['address'], message: `invalid ${w.chain} address` });
	});

// Storefront blocks. The builder serialises an ordered array of these; the
// hosted renderer walks it. Keep the schema permissive on copy fields but tight
// on type + referenced ids so a published store can't carry junk.
const blockSchema = z.object({
	id: z.string().min(1).max(40),
	type: z.enum(['hero', 'products', 'product', 'text', 'image', 'button', 'divider', 'footer']),
	heading: z.string().max(160).optional(),
	subheading: z.string().max(400).optional(),
	body: z.string().max(4000).optional(),
	image_url: httpsUrl.optional(),
	href: httpsUrl.optional(),
	label: z.string().max(80).optional(),
	sku_id: z.string().uuid().optional(),
	sku_ids: z.array(z.string().uuid()).max(48).optional(),
	align: z.enum(['left', 'center']).optional(),
});

const settingsSchema = z.object({
	business_name: z.string().trim().max(80).nullish(),
	support_email: z.string().trim().email().max(254).nullish(),
	logo_url: httpsUrl.nullish(),
	accent_color: z
		.string()
		.regex(/^#[0-9a-fA-F]{6}$/)
		.nullish(),
	payout_evm: evmAddress.nullish(),
	payout_solana: solAddress.nullish(),
	default_network: z.enum(['base', 'solana']).optional(),
	cors_origins: z.array(httpsOrigin).max(50).optional(),
	spend_cap_per_call_atomics: atomics.nullish(),
	spend_cap_daily_atomics: atomics.nullish(),
	require_siwx: z.boolean().optional(),
	allowed_networks: z.array(z.enum(['base', 'solana'])).min(1).max(2).optional(),
	agent_wallets: z.array(agentWalletSchema).max(50).optional(),
	facilitator: httpsUrl.nullish(),
	webhook_url: httpsUrl.nullish(),
	// Giving — charity split (basis points of every settled payment) + round-up
	// (round the buyer total up to the nearest unit, donate the difference).
	charity_enabled: z.boolean().optional(),
	charity_name: z.string().trim().max(80).nullish(),
	charity_chain: z.enum(['base', 'solana']).nullish(),
	charity_address: z.string().trim().min(1).max(64).nullish(),
	charity_bps: z.number().int().min(0).max(10000).optional(),
	roundup_enabled: z.boolean().optional(),
	roundup_to_atomics: atomics.nullish(),
	store_handle: storeHandle.nullish(),
	store_published: z.boolean().optional(),
	store_layout: z.array(blockSchema).max(60).optional(),
	store_theme: z
		.object({
			mode: z.enum(['light', 'dark', 'auto']).optional(),
			bg: z
				.string()
				.regex(/^#[0-9a-fA-F]{6}$/)
				.optional(),
			accent: z
				.string()
				.regex(/^#[0-9a-fA-F]{6}$/)
				.optional(),
		})
		.partial()
		.optional(),
	})
	.superRefine((s, ctx) => {
		// A charity address must match its declared chain — a misrouted donation
		// loses real funds, so validate the same way agent wallets do.
		if (s.charity_address) {
			const chain = s.charity_chain;
			const ok =
				chain === 'base'
					? /^0x[0-9a-fA-F]{40}$/.test(s.charity_address)
					: chain === 'solana'
						? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.charity_address)
						: false;
			if (!ok)
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['charity_address'],
					message: chain ? `invalid ${chain} address` : 'set charity_chain to validate the address',
				});
		}
		// Enabling charity needs a destination + a non-zero share.
		if (s.charity_enabled === true) {
			if (!s.charity_address)
				ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['charity_address'], message: 'charity address required when charity is enabled' });
			if (s.charity_bps === 0)
				ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['charity_bps'], message: 'set a non-zero share when charity is enabled' });
		}
		// Round-up donates the difference, so it needs a cause wallet too.
		if (s.roundup_enabled === true && !s.charity_address)
			ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['charity_address'], message: 'round-up needs a charity address to receive the difference' });
	});

const DEFAULTS = {
	business_name: null,
	support_email: null,
	logo_url: null,
	accent_color: '#111111',
	payout_evm: null,
	payout_solana: null,
	default_network: 'solana',
	cors_origins: [],
	spend_cap_per_call_atomics: null,
	spend_cap_daily_atomics: null,
	require_siwx: false,
	allowed_networks: ['solana', 'base'],
	agent_wallets: [],
	facilitator: null,
	webhook_url: null,
	charity_enabled: false,
	charity_name: null,
	charity_chain: null,
	charity_address: null,
	charity_bps: 0,
	roundup_enabled: false,
	roundup_to_atomics: null,
	store_handle: null,
	store_published: false,
	store_layout: [],
	store_theme: {},
};

// Columns we return to the owner. Never expose api_key_hash.
const OWNER_COLS = sql`
	owner_user_id, business_name, support_email, logo_url, accent_color,
	payout_evm, payout_solana, default_network, cors_origins,
	spend_cap_per_call_atomics, spend_cap_daily_atomics, require_siwx, allowed_networks,
	agent_wallets, facilitator,
	charity_enabled, charity_name, charity_chain, charity_address, charity_bps,
	roundup_enabled, roundup_to_atomics,
	api_key_prefix, api_key_created_at, webhook_url,
	store_handle, store_published, store_layout, store_theme, created_at, updated_at
`;

export default wrap(async (req, res) => {
	if (cors(req, res, { origins: '*', methods: 'GET,PUT,POST,OPTIONS' })) return;

	const method = req.method;
	if (method === 'GET') return handleGet(req, res);
	if (method === 'PUT') return handleUpsert(req, res);
	if (method === 'POST') return handlePost(req, res);
	return error(res, 405, 'method_not_allowed', `unsupported: ${method}`);
});

async function handleGet(req, res) {
	const { store } = req.query || {};

	// Public storefront read — no auth. Returns the published layout + its
	// products so /store/<handle> can render without exposing owner-only fields.
	if (store) {
		// Handles are at most 40 chars (storeHandle above). Reject anything longer
		// before it reaches Postgres and before it is echoed back: a 3 KB ?store=
		// used to make one round-trip AND come straight back in the 404 body.
		const handle = String(store).toLowerCase();
		if (handle.length > 40) return error(res, 404, 'store_not_found', 'no published store with that handle');
		const [m] = await sql`
			select owner_user_id, business_name, logo_url, accent_color,
			       store_handle, store_layout, store_theme,
			       charity_enabled, charity_name, charity_chain, charity_address, charity_bps,
			       roundup_enabled, roundup_to_atomics
			from x402_merchant_settings
			where store_handle = ${handle} and store_published = true
			limit 1
		`;
		if (!m) return error(res, 404, 'store_not_found', `no published store "${handle}"`);
		const products = await sql`
			select id, slug, merchant_name, action_name, description, logo_url, image_url,
			       accent_color, price_atomics, price_network, target_method, position
			from x402_skus
			where owner_user_id = ${m.owner_user_id} and archived_at is null and active = true
			order by position asc, created_at desc
		`;
		return json(res, 200, { store: m, products }, { 'cache-control': 'public, max-age=30' });
	}

	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const settings = await getOrCreate(user.id);
	return json(res, 200, { settings });
}

async function getOrCreate(userId) {
	const [existing] = await sql`select ${OWNER_COLS} from x402_merchant_settings where owner_user_id = ${userId} limit 1`;
	if (existing) return existing;
	const [created] = await sql`
		insert into x402_merchant_settings (owner_user_id)
		values (${userId})
		on conflict (owner_user_id) do update set updated_at = now()
		returning ${OWNER_COLS}
	`;
	return created;
}

async function handleUpsert(req, res) {
	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const patch = parse(settingsSchema, await readJson(req));

	// Publishing requires a handle.
	if (patch.store_published === true) {
		const [cur] = await sql`select store_handle from x402_merchant_settings where owner_user_id = ${user.id} limit 1`;
		const handle = patch.store_handle ?? cur?.store_handle;
		if (!handle) return error(res, 400, 'handle_required', 'set a store handle before publishing');
	}

	// Storefront handle is globally unique — surface a clean 409 instead of a raw
	// constraint error.
	if (patch.store_handle) {
		const [taken] = await sql`
			select owner_user_id from x402_merchant_settings
			where store_handle = ${patch.store_handle} and owner_user_id <> ${user.id} limit 1
		`;
		if (taken) return error(res, 409, 'handle_taken', `store handle "${patch.store_handle}" is taken`);
	}

	await getOrCreate(user.id);

	// Build the row with current values as the base, overlaying provided keys.
	const [cur] = await sql`select ${OWNER_COLS} from x402_merchant_settings where owner_user_id = ${user.id} limit 1`;
	const next = { ...DEFAULTS, ...cur };
	for (const [k, v] of Object.entries(patch)) next[k] = v;

	const [updated] = await sql`
		update x402_merchant_settings set
			business_name = ${next.business_name},
			support_email = ${next.support_email},
			logo_url = ${next.logo_url},
			accent_color = ${next.accent_color ?? '#111111'},
			payout_evm = ${next.payout_evm},
			payout_solana = ${next.payout_solana},
			default_network = ${next.default_network ?? 'solana'},
			cors_origins = ${JSON.stringify(next.cors_origins ?? [])}::jsonb,
			spend_cap_per_call_atomics = ${next.spend_cap_per_call_atomics},
			spend_cap_daily_atomics = ${next.spend_cap_daily_atomics},
			require_siwx = ${next.require_siwx ?? false},
			allowed_networks = ${JSON.stringify(next.allowed_networks ?? ['solana', 'base'])}::jsonb,
			agent_wallets = ${JSON.stringify(next.agent_wallets ?? [])}::jsonb,
			facilitator = ${next.facilitator},
			webhook_url = ${next.webhook_url},
			charity_enabled = ${next.charity_enabled ?? false},
			charity_name = ${next.charity_name},
			charity_chain = ${next.charity_chain},
			charity_address = ${next.charity_address},
			charity_bps = ${next.charity_bps ?? 0},
			roundup_enabled = ${next.roundup_enabled ?? false},
			roundup_to_atomics = ${next.roundup_to_atomics},
			store_handle = ${next.store_handle},
			store_published = ${next.store_published ?? false},
			store_layout = ${JSON.stringify(next.store_layout ?? [])}::jsonb,
			store_theme = ${JSON.stringify(next.store_theme ?? {})}::jsonb,
			updated_at = now()
		where owner_user_id = ${user.id}
		returning ${OWNER_COLS}
	`;
	return json(res, 200, { settings: updated });
}

async function handlePost(req, res) {
	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const action = req.query?.action;
	if (action !== 'rotate-key') return error(res, 404, 'not_found', `unknown action: ${action ?? '(none)'}`);

	await getOrCreate(user.id);

	// Mint a fresh key, store only its hash + a display prefix. Returned once.
	const secret = `x402_live_${randomToken(24)}`;
	const hash = await sha256(secret);
	const prefix = secret.slice(0, 18);
	await sql`
		update x402_merchant_settings
		set api_key_hash = ${hash}, api_key_prefix = ${prefix}, api_key_created_at = now(), updated_at = now()
		where owner_user_id = ${user.id}
	`;
	return json(res, 200, { api_key: secret, api_key_prefix: prefix });
}
