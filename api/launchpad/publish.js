// POST /api/launchpad/publish
//
// Persists a Launchpad Studio configuration to launchpad_pages so it can be
// served at /p/<slug> and edited later. Anonymous publish is allowed: the
// studio is the "Wix of 3D avatars" surface and must work for drive-by
// creators with no account.
//
// Edit auth model:
//   • First publish of a slug returns `ownerSecret` (random 32-byte hex).
//     The studio stores it in localStorage keyed by slug.
//   • Subsequent publishes that change anything must include either:
//       (a) a matching `ownerSecret` in the request body, OR
//       (b) an authenticated session whose user_id matches the row.
//   • Without one of those, slug is treated as taken (409 slug_taken).
//     (Matching the row's payout wallet is deliberately NOT accepted: the
//     owner wallet is publicly readable via /api/launchpad/get, so it would
//     let anyone overwrite any page.)
//   • Both decisions are made by the write statements themselves (a claiming
//     INSERT ... ON CONFLICT DO NOTHING, then an UPDATE whose WHERE re-asserts
//     the secret/session match), never by a preceding SELECT. Two first
//     publishes of the same slug racing each other used to both read "no row",
//     both mint a secret, and both return 200: the loser overwrote the winner's
//     page and walked away with a secret that unlocks nothing.
//
// This lets anonymous CMS-style editing work end-to-end: publish from a
// browser → edit later from the same browser → secret travels with the
// localStorage draft. Lose the secret AND the session → you can't edit.
// That's the right tradeoff for a no-auth surface.

import { createHash, randomBytes } from 'node:crypto';
import { sql } from '../_lib/db.js';
import { authenticateBearer, extractBearer, getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';
import { z } from 'zod';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
const TEMPLATES = ['token-launchpad', 'paid-concierge', 'gated-showroom'];

const skillSchema = z.object({
	name: z.string().trim().min(1).max(80),
	price: z.number().nonnegative(),
	currency: z.string().trim().min(1).max(10),
	chain: z.string().trim().min(1).max(20),
	description: z.string().max(280).optional().default(''),
});

const bodySchema = z.object({
	slug: z.string().regex(SLUG_RE, 'slug must be 1-40 chars, lowercase alphanumeric or hyphens'),
	template: z.enum(TEMPLATES),
	ownerSecret: z.string().min(32).max(128).optional(),
	identity: z.object({
		slug: z.string().optional(),
		brand: z.string().max(20),
		wallet: z.string().min(20).max(64),
		website: z.string().max(300).optional().default(''),
		theme: z.enum(['light', 'dark']).default('light'),
		socials: z
			.object({
				twitter: z.string().max(200).optional().default(''),
				telegram: z.string().max(200).optional().default(''),
				discord: z.string().max(200).optional().default(''),
			})
			.optional(),
	}),
	avatar: z.object({
		src: z.string().min(1).max(500),
		name: z.string().max(80),
	}),
	copy: z.object({
		headline: z.string().max(120),
		tagline: z.string().max(280),
		cta: z.string().max(40),
	}),
	token: z
		.object({
			name: z.string().max(80).optional().default(''),
			ticker: z.string().max(10).optional().default(''),
			supply: z.number().int().nonnegative().optional().default(0),
			description: z.string().max(500).optional().default(''),
			imageUrl: z.string().max(500).optional().default(''),
			mint: z.string().max(64).optional().default(''),
		})
		.optional(),
	agentSkills: z.array(skillSchema).max(20).optional().default([]),
	scene: z.object({ src: z.string().max(500).optional().default('') }).optional(),
	monetize: z.object({
		kind: z.string().max(40),
		price: z.number().nonnegative(),
		currency: z.string().max(10),
		chain: z.string().max(20),
	}),
});

function validateWalletForChain(wallet, chain) {
	if (chain === 'solana') return SOL_RE.test(wallet);
	if (chain === 'base' || chain === 'polygon' || chain === 'ethereum') return EVM_RE.test(wallet);
	return SOL_RE.test(wallet) || EVM_RE.test(wallet);
}

function hashSecret(secret) {
	return createHash('sha256').update(secret).digest('hex');
}

async function resolveAuth(req) {
	try {
		const session = await getSessionUser(req);
		if (session) return { userId: session.id };
	} catch {}
	try {
		const bearer = await authenticateBearer(extractBearer(req));
		if (bearer) return { userId: bearer.userId };
	} catch {}
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many publish attempts, try again soon');

	const body = await readJson(req).catch(() => null);
	if (!body) return error(res, 400, 'validation_error', 'request body required');

	const parsed = bodySchema.safeParse(body);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		return error(res, 400, 'validation_error', issue?.message || 'invalid input', {
			path: issue?.path,
		});
	}
	const data = parsed.data;

	if (!validateWalletForChain(data.identity.wallet, data.monetize.chain)) {
		return error(
			res,
			400,
			'validation_error',
			`payout wallet does not look like a ${data.monetize.chain} address`,
		);
	}

	const auth = await resolveAuth(req);
	const authUserId = auth?.userId || null;
	const providedHash = data.ownerSecret ? hashSecret(data.ownerSecret) : null;

	// Minted up front so the claiming INSERT can carry it, but only ever handed
	// back when the database confirms this request is the one that stored it.
	const freshSecret = randomBytes(32).toString('hex');
	const freshHash = hashSecret(freshSecret);

	const config = {
		identity: data.identity,
		avatar: data.avatar,
		copy: data.copy,
		token: data.token || {},
		agentSkills: data.agentSkills || [],
		scene: data.scene || {},
		monetize: data.monetize,
	};

	const tokenMint = data.token?.mint?.trim() || null;

	const out = {
		slug: data.slug,
		url: `${env.APP_ORIGIN}/p/${data.slug}`,
		publishedAt: new Date().toISOString(),
	};

	// Claim the slug. DO NOTHING means the row already existed (or a concurrent
	// publisher won the race), and this request is an edit that has to prove it.
	const claimed = await sql`
		INSERT INTO launchpad_pages
			(slug, template, owner_wallet, owner_secret_hash, user_id, config, token_mint, updated_at)
		VALUES
			(${data.slug}, ${data.template}, ${data.identity.wallet}, ${freshHash},
			 ${authUserId}, ${JSON.stringify(config)}::jsonb, ${tokenMint}, now())
		ON CONFLICT (slug) DO NOTHING
		RETURNING slug
	`;
	if (claimed.length) {
		out.ownerSecret = freshSecret;
		return json(res, 200, out);
	}

	// Edit auth, re-asserted inside the statement so it cannot go stale between a
	// read and the write: (a) matching secret, or (b) same session user. The row's
	// payout wallet is public (returned by /api/launchpad/get), so knowing it
	// proves nothing and must never grant edit rights. A row created before
	// secrets existed gets one minted here, on the update that proves ownership.
	const [updated] = await sql`
		UPDATE launchpad_pages SET
			template          = ${data.template},
			owner_wallet      = ${data.identity.wallet},
			owner_secret_hash = COALESCE(owner_secret_hash, ${freshHash}),
			user_id           = COALESCE(${authUserId}, user_id),
			config            = ${JSON.stringify(config)}::jsonb,
			-- A launched mint is a permanent on-chain fact. Re-publishing from a
			-- studio draft that predates the launch must not erase it (which would
			-- also drop the page out of list.js's "already minted" sort).
			token_mint        = COALESCE(${tokenMint}, token_mint),
			updated_at        = now()
		WHERE slug = ${data.slug}
			AND (
				(${providedHash}::text IS NOT NULL AND owner_secret_hash = ${providedHash})
				OR (${authUserId}::uuid IS NOT NULL AND user_id = ${authUserId})
			)
		RETURNING owner_secret_hash
	`;
	if (!updated) {
		return error(res, 409, 'slug_taken', 'that slug is already published, pick a different one');
	}

	// Only hand back a secret when this request is the one that stored it: the
	// first publish above, or the legacy row that had none until this update.
	if (updated.owner_secret_hash === freshHash) out.ownerSecret = freshSecret;
	return json(res, 200, out);
});
