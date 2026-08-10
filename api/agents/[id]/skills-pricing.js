import { getSessionUser, authenticateBearer, extractBearer } from '../../_lib/auth.js';
import { cors, json, method, readJson, wrap, error, respondError } from '../../_lib/http.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { MonetizationService } from '../../_lib/services/MonetizationService.js';
import { isUuid } from '../../_lib/validate.js';
import { z } from 'zod';

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const priceSchema = z
	.object({
		skill: z.string().trim().min(1).max(100),
		// Amount is required for a price gate, ignored (and stored as 0) for an NFT
		// gate, so it is optional here and refined below per gate_type.
		amount: z.number().int().min(1).optional(),
		currency_mint: z.string().trim().min(1).max(100),
		chain: z.string().trim().min(1).max(20),
		trial_uses: z.number().int().min(0).max(10).default(0),
		time_pass_hours: z.number().int().min(1).max(720).nullable().optional(),
		time_pass_amount: z.number().int().min(1).nullable().optional(),
		// Pay-what-you-want: 'fixed' (default) bills `amount`; 'pwyw' lets the buyer
		// name an amount at or above `minimum_amount` (atomic units, 0 = no floor).
		pricing_type: z.enum(['fixed', 'pwyw']).default('fixed'),
		minimum_amount: z.number().int().min(0).nullable().optional(),
		// Access gate: 'price' (default) sells the skill; 'nft' restricts it to
		// holders of `nft_collection_mint`.
		gate_type: z.enum(['price', 'nft']).default('price'),
		nft_collection_mint: z.string().trim().regex(SOLANA_ADDRESS_RE).nullable().optional(),
	})
	.refine((p) => p.gate_type === 'nft' || (p.amount ?? 0) >= 1, {
		message: 'amount is required for a priced skill',
		path: ['amount'],
	})
	.refine((p) => p.gate_type !== 'nft' || !!p.nft_collection_mint, {
		message: 'nft_collection_mint is required for an NFT gate',
		path: ['nft_collection_mint'],
	})
	.refine(
		(p) => p.gate_type === 'nft' || p.pricing_type !== 'pwyw' || (p.minimum_amount ?? 0) <= (p.amount ?? 0),
		{ message: 'minimum cannot exceed the suggested amount', path: ['minimum_amount'] },
	);

const pricingUpdateSchema = z.object({
	prices: z.array(priceSchema),
});

export default wrap(async (req, res) => {
	const url = new URL(req.url, 'http://x');
	const parts = url.pathname.split('/').filter(Boolean);
	const id = url.searchParams.get('id') || parts[2];

	if (cors(req, res, { methods: 'GET,PUT,OPTIONS', credentials: true })) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	// This handler has its own vercel.json rewrite, so the uuid gate in
	// api/agents/[id].js never runs for it. A malformed id would reach a uuid
	// column and surface Postgres 22P02 to the caller as a 500 whose `error` field
	// was the raw SQLSTATE.
	if (!isUuid(id)) return error(res, 404, 'not_found', 'agent not found');

	// CSRF on state-changing session-cookie requests; bearer tokens are exempt.
	if (req.method === 'PUT' && !(await requireCsrf(req, res, auth.userId))) return;

	const service = new MonetizationService(auth);

	// Ownership gates both reads and writes on this owner-only surface.
	try {
		await service.assertOwnership(id);
	} catch (e) {
		// A 404/403 here is the gate doing its job, not an incident: log only when
		// something genuinely broke, and never echo a driver error code back to the
		// caller as if it were this API's error contract.
		if (!e?.status || e.status >= 500) {
			console.error('[agents/skills-pricing] ownership check failed', e?.message);
			return respondError(res, 500, 'error', e);
		}
		return respondError(res, e.status, e.code || 'error', e);
	}

	if (req.method === 'GET') return handleGet(req, res, service, id);
	if (req.method === 'PUT') return handlePut(req, res, service, id);

	return method(req, res, ['GET', 'PUT']);
});

async function handleGet(req, res, service, agentId) {
	const prices = await service.getSkillPricesForAgent(agentId);
	return json(res, 200, { prices });
}

async function handlePut(req, res, service, agentId) {
	const body = await readJson(req);
	const parsed = pricingUpdateSchema.safeParse(body);
	if (!parsed.success) {
		const msg = parsed.error.issues[0]?.message || 'validation error';
		return error(res, 400, 'validation_error', msg);
	}

	// Ownership already asserted above — the service performs the atomic
	// deactivate-then-upsert and invalidates the price cache.
	await service.setSkillPrices(agentId, parsed.data.prices, { skipOwnershipCheck: true });

	return json(res, 200, { ok: true });
}

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}
