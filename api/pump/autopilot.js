/**
 * Autonomous Coin Agent — autopilot policy + activity API.
 *
 *   GET  /api/pump/autopilot           → caller's launched coins, their policy,
 *                                         recent autonomous actions, and totals.
 *   POST /api/pump/autopilot           → upsert the policy for one owned coin.
 *
 * The policy rows (pump_autopilot) gate the run-buyback and run-distribute-payments
 * crons (see api/cron/[name].js). A coin with no policy row keeps the legacy
 * always-on behaviour; writing a row here lets the owner tune or pause it.
 *
 * Auth: session cookie OR bearer token. Every read/write is scoped to coins the
 * caller owns (pump_agent_mints.user_id).
 */

import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import {
	getSessionUser,
	authenticateBearer,
	extractBearer,
	isSameSiteOrigin,
} from '../_lib/auth.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { z } from 'zod';

/**
 * Resolve the caller to { userId, viaCookie }, or null when unauthenticated.
 *
 * `viaCookie` drives the CSRF gate below. A POST here rewrites the policy that
 * gates the buyback and payout crons, so a cross-site form riding the session
 * cookie could pause an owner's buyback or flip it to full-swap without them
 * ever seeing it. Bearer callers are exempt: the token itself is the proof of
 * intent. Same rule the pump dispatcher applies to its cookie-borne writes.
 */
async function resolveCaller(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, viaCookie: true };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId, viaCookie: false };
	return null;
}

const POLICY_SCHEMA = z.object({
	mint: z.string().min(32).max(64),
	network: z.enum(['mainnet', 'devnet']).default('mainnet'),
	enabled: z.boolean().optional(),
	buyback_enabled: z.boolean().optional(),
	buyback_min_atomics: z.union([z.string(), z.number()]).optional(),
	buyback_full_swap: z.boolean().optional(),
	distribute_enabled: z.boolean().optional(),
	distribute_min_atomics: z.union([z.string(), z.number()]).optional(),
	narrate: z.boolean().optional(),
});

/** Clamp a user-supplied atomics value to a non-negative integer string. */
function atomics(v, fallback = '0') {
	if (v == null) return fallback;
	let s = String(v).trim();
	if (!/^\d+$/.test(s)) {
		// Tolerate decimals by truncating — atomics are always integers.
		const n = Number(s);
		if (!Number.isFinite(n) || n < 0) return fallback;
		s = String(Math.floor(n));
	}
	return s;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const caller = await resolveCaller(req);
	if (!caller) return error(res, 401, 'unauthorized', 'sign in to manage autopilot');
	if (req.method === 'POST' && caller.viaCookie && !isSameSiteOrigin(req)) {
		return error(res, 403, 'forbidden', 'cross-site request blocked');
	}

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	if (req.method === 'POST') return upsertPolicy(req, res, caller.userId);
	return listCoins(req, res, caller.userId);
});

// ── GET — coins + policy + activity ──────────────────────────────────────────

async function listCoins(req, res, userId) {
	const coins = await sql`
		select
			m.id, m.mint, m.network, m.name, m.symbol, m.buyback_bps,
			m.created_at, m.agent_id,
			a.name           as agent_name,
			a.avatar_url     as agent_avatar,
			a.profile_image_url as agent_image,
			s.graduated,
			s.bonding_curve,
			ap.enabled, ap.buyback_enabled, ap.buyback_min_atomics, ap.buyback_full_swap,
			ap.distribute_enabled, ap.distribute_min_atomics, ap.narrate
		from pump_agent_mints m
		join agent_identities a on a.id = m.agent_id
		left join pump_agent_stats s on s.mint_id = m.id
		left join pump_autopilot  ap on ap.mint_id = m.id
		where m.user_id = ${userId}
		order by m.created_at desc
		limit 100
	`;

	if (!coins.length) return json(res, 200, { coins: [], activity: [] });

	const ids = coins.map((c) => c.id);

	// Recent autonomous actions across all of the caller's coins, newest first.
	const [buybacks, distributes, payTotals] = await Promise.all([
		sql`
			select mint_id, status, burn_amount, currency_mint, tx_signature, error, created_at
			from pump_buyback_runs
			where mint_id = any(${ids})
			order by created_at desc
			limit 60
		`,
		sql`
			select mint_id, status, currency_mint, tx_signature, balances_before, error, created_at
			from pump_distribute_runs
			where mint_id = any(${ids})
			order by created_at desc
			limit 60
		`,
		sql`
			select mint_id,
			       count(*) filter (where status = 'confirmed')                        as paid_count,
			       coalesce(sum(amount_atomics) filter (where status = 'confirmed'), 0) as paid_atomics
			from pump_agent_payments
			where mint_id = any(${ids})
			group by mint_id
		`,
	]);

	const payByMint = new Map(payTotals.map((p) => [p.mint_id, p]));

	const activity = [];
	for (const b of buybacks) {
		activity.push({
			mint_id: b.mint_id,
			kind: 'buyback',
			status: b.status,
			amount_atomics: b.burn_amount != null ? String(b.burn_amount) : null,
			tx_signature: b.tx_signature || null,
			error: b.error || null,
			at: b.created_at,
		});
	}
	for (const d of distributes) {
		activity.push({
			mint_id: d.mint_id,
			kind: 'distribute',
			status: d.status,
			amount_atomics:
				d.balances_before?.payment != null ? String(d.balances_before.payment) : null,
			tx_signature: d.tx_signature || null,
			error: d.error || null,
			at: d.created_at,
		});
	}
	activity.sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime());

	const out = coins.map((c) => {
		const hasPolicy = c.enabled != null;
		const pay = payByMint.get(c.id);
		const burned = buybacks
			.filter((b) => b.mint_id === c.id && b.status === 'confirmed' && b.burn_amount)
			.reduce((sum, b) => sum + BigInt(b.burn_amount), 0n);
		const distributed = distributes.filter(
			(d) => d.mint_id === c.id && d.status === 'confirmed',
		).length;
		const progress = c.bonding_curve?.progress_pct ?? null;

		return {
			id: c.id,
			mint: c.mint,
			network: c.network,
			agent_id: c.agent_id,
			name: c.name || c.agent_name,
			symbol: c.symbol,
			agent_name: c.agent_name,
			image: c.agent_image || c.agent_avatar || null,
			pump_url: c.network === 'mainnet' ? `https://pump.fun/coin/${c.mint}` : null,
			policy: {
				// A missing row reports the effective legacy defaults so the UI shows
				// the true runtime state, with `configured: false` to flag opt-in.
				configured: hasPolicy,
				enabled: hasPolicy ? c.enabled : true,
				buyback_enabled: hasPolicy ? c.buyback_enabled : true,
				buyback_min_atomics: hasPolicy ? String(c.buyback_min_atomics) : '0',
				buyback_full_swap: hasPolicy ? c.buyback_full_swap : false,
				distribute_enabled: hasPolicy ? c.distribute_enabled : true,
				distribute_min_atomics: hasPolicy ? String(c.distribute_min_atomics) : '0',
				narrate: hasPolicy ? c.narrate : true,
			},
			stats: {
				graduated: !!c.graduated,
				progress_pct: progress,
			},
			totals: {
				burned_atomics: burned.toString(),
				distribute_runs: distributed,
				paid_count: pay ? Number(pay.paid_count) : 0,
				paid_atomics: pay ? String(pay.paid_atomics) : '0',
			},
		};
	});

	return json(res, 200, { coins: out, activity: activity.slice(0, 40) });
}

// ── POST — upsert policy ─────────────────────────────────────────────────────

async function upsertPolicy(req, res, userId) {
	const body = await readJson(req);
	const parsed = POLICY_SCHEMA.safeParse(body);
	if (!parsed.success) {
		return error(res, 400, 'bad_request', parsed.error.issues[0]?.message || 'invalid policy');
	}
	const p = parsed.data;

	const [coin] = await sql`
		select id from pump_agent_mints
		where mint = ${p.mint} and network = ${p.network} and user_id = ${userId}
		limit 1
	`;
	if (!coin) return error(res, 404, 'not_found', 'coin not found or not owned by you');

	// Merge over any existing row so partial updates only touch provided fields.
	const [existing] = await sql`select * from pump_autopilot where mint_id = ${coin.id} limit 1`;
	const cur = existing || {
		enabled: true,
		buyback_enabled: true,
		buyback_min_atomics: '0',
		buyback_full_swap: false,
		distribute_enabled: true,
		distribute_min_atomics: '0',
		narrate: true,
	};

	const next = {
		enabled: p.enabled ?? cur.enabled,
		buyback_enabled: p.buyback_enabled ?? cur.buyback_enabled,
		buyback_min_atomics:
			p.buyback_min_atomics != null
				? atomics(p.buyback_min_atomics)
				: String(cur.buyback_min_atomics),
		buyback_full_swap: p.buyback_full_swap ?? cur.buyback_full_swap,
		distribute_enabled: p.distribute_enabled ?? cur.distribute_enabled,
		distribute_min_atomics:
			p.distribute_min_atomics != null
				? atomics(p.distribute_min_atomics)
				: String(cur.distribute_min_atomics),
		narrate: p.narrate ?? cur.narrate,
	};

	const [row] = await sql`
		insert into pump_autopilot
			(mint_id, enabled, buyback_enabled, buyback_min_atomics, buyback_full_swap,
			 distribute_enabled, distribute_min_atomics, narrate, updated_at)
		values
			(${coin.id}, ${next.enabled}, ${next.buyback_enabled}, ${next.buyback_min_atomics},
			 ${next.buyback_full_swap}, ${next.distribute_enabled}, ${next.distribute_min_atomics},
			 ${next.narrate}, now())
		on conflict (mint_id) do update set
			enabled                = excluded.enabled,
			buyback_enabled        = excluded.buyback_enabled,
			buyback_min_atomics    = excluded.buyback_min_atomics,
			buyback_full_swap      = excluded.buyback_full_swap,
			distribute_enabled     = excluded.distribute_enabled,
			distribute_min_atomics = excluded.distribute_min_atomics,
			narrate                = excluded.narrate,
			updated_at             = now()
		returning *
	`;

	return json(res, 200, {
		ok: true,
		policy: {
			configured: true,
			enabled: row.enabled,
			buyback_enabled: row.buyback_enabled,
			buyback_min_atomics: String(row.buyback_min_atomics),
			buyback_full_swap: row.buyback_full_swap,
			distribute_enabled: row.distribute_enabled,
			distribute_min_atomics: String(row.distribute_min_atomics),
			narrate: row.narrate,
		},
	});
}
