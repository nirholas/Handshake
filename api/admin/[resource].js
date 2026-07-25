import { sql } from '../_lib/db.js';
import { cors, json, method, wrap, error } from '../_lib/http.js';
import { requireAdmin } from '../_lib/admin.js';
import { computeKFactor, conversionRate } from '../_lib/referral-rewards.js';

export default wrap(async (req, res) => {
	const resource = req.query?.resource;

	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;
	if (!(await requireAdmin(req, res))) return;

	if (resource === 'stats') {
		const [counts] = await sql`
			select
				(select count(*) from users where deleted_at is null and not service_account)::int  as total_users,
				(select count(*) from users where deleted_at is null and not service_account and created_at > now() - interval '7 days')::int as new_users_7d,
				(select count(*) from users where deleted_at is null and not service_account and created_at > now() - interval '30 days')::int as new_users_30d,
				(select count(*) from users where deleted_at is null and service_account)::int       as service_accounts,
				(select count(*) from avatars where deleted_at is null)::int                        as total_avatars,
				(select coalesce(sum(size_bytes),0) from avatars where deleted_at is null)::bigint  as total_bytes,
				(select count(*) from agent_identities where deleted_at is null)::int               as total_agents,
				(select count(*) from sessions where revoked_at is null and expires_at > now())::int as active_sessions,
				(select count(*) from users where plan='pro' and deleted_at is null)::int           as pro_users,
				(select count(*) from users where plan='team' and deleted_at is null)::int          as team_users,
				(select count(*) from users where plan='enterprise' and deleted_at is null)::int    as enterprise_users,
				(select count(*) from subscriptions where status='active')::int                     as active_subscriptions
		`;

		const recentSignups = await sql`
			select date_trunc('day', created_at)::date as day, count(*)::int as users
			from users
			where deleted_at is null and not service_account and created_at > now() - interval '30 days'
			group by 1 order by 1
		`;

		const planBreakdown = await sql`
			select plan, count(*)::int as users
			from users where deleted_at is null and not service_account
			group by plan order by users desc
		`;

		const chainBreakdown = await sql`
			select chain_type, count(*)::int as wallets
			from user_wallets
			group by chain_type order by wallets desc
		`;

		return json(res, 200, { counts, recentSignups, planBreakdown, chainBreakdown });
	}

	if (resource === 'users') {
		const params = new URL(req.url, 'http://x').searchParams;
		const q = (params.get('q') || '').trim().slice(0, 200);
		const plan = params.get('plan') || null;
		const page = Math.max(1, parseInt(params.get('page') || '1', 10));
		const limit = Math.min(100, Math.max(1, parseInt(params.get('limit') || '50', 10)));
		const offset = (page - 1) * limit;

		const users = await sql`
			select
				u.id, u.email, u.display_name, u.plan, u.is_admin,
				u.wallet_address, u.created_at, u.deleted_at,
				(
					select json_agg(json_build_object('address', w.address, 'chain_type', w.chain_type, 'is_primary', w.is_primary))
					from user_wallets w where w.user_id = u.id
				) as wallets,
				(select count(*)::int from avatars a where a.owner_id = u.id and a.deleted_at is null) as avatar_count
			from users u
			where
				u.deleted_at is null
				and (${q} = '' or u.email ilike ${'%' + q + '%'} or u.display_name ilike ${'%' + q + '%'} or u.wallet_address ilike ${'%' + q + '%'})
				and (${plan} is null or u.plan = ${plan})
			order by u.created_at desc
			limit ${limit} offset ${offset}
		`;

		const [{ total }] = await sql`
			select count(*)::int as total from users u
			where
				u.deleted_at is null
				and (${q} = '' or u.email ilike ${'%' + q + '%'} or u.display_name ilike ${'%' + q + '%'} or u.wallet_address ilike ${'%' + q + '%'})
				and (${plan} is null or u.plan = ${plan})
		`;

		return json(res, 200, { users, total, page, limit });
	}

	// LLM spend ledger — what the platform's inference (incl. Anthropic credits)
	// is costing, and where it's going. Cost is micro-USD ($0.000001); the UI
	// divides by 1e6. Free providers (groq/openrouter) price to 0 by design, so
	// `paid_calls` vs `total_calls` shows the paid-vs-free split.
	if (resource === 'llm-spend') {
		const [totals] = await sql`
			select
				count(*)::int                                                                          as total_calls,
				count(*) filter (where created_at > now() - interval '24 hours')::int                 as calls_24h,
				count(*) filter (where created_at > now() - interval '7 days')::int                   as calls_7d,
				coalesce(sum(cost_micro_usd),0)::bigint                                                as cost_micro_usd_30d,
				coalesce(sum(cost_micro_usd) filter (where created_at > now() - interval '24 hours'),0)::bigint as cost_micro_usd_24h,
				coalesce(sum(cost_micro_usd) filter (where created_at > now() - interval '7 days'),0)::bigint   as cost_micro_usd_7d,
				count(*) filter (where coalesce(cost_micro_usd,0) > 0)::int                            as paid_calls,
				coalesce(sum(input_tokens),0)::bigint                                                  as input_tokens,
				coalesce(sum(output_tokens),0)::bigint                                                 as output_tokens
			from usage_events
			where kind = 'llm' and created_at > now() - interval '30 days'
		`;

		const byProvider = await sql`
			select coalesce(provider,'unknown') as provider,
				count(*)::int as calls,
				coalesce(sum(cost_micro_usd),0)::bigint as cost_micro_usd,
				coalesce(sum(input_tokens),0)::bigint as input_tokens,
				coalesce(sum(output_tokens),0)::bigint as output_tokens
			from usage_events
			where kind = 'llm' and created_at > now() - interval '30 days'
			group by provider order by cost_micro_usd desc, calls desc
		`;

		const byModel = await sql`
			select coalesce(model,'unknown') as model,
				count(*)::int as calls,
				coalesce(sum(cost_micro_usd),0)::bigint as cost_micro_usd
			from usage_events
			where kind = 'llm' and created_at > now() - interval '30 days'
			group by model order by cost_micro_usd desc, calls desc limit 20
		`;

		const byDay = await sql`
			select date_trunc('day', created_at)::date as day,
				count(*)::int as calls,
				coalesce(sum(cost_micro_usd),0)::bigint as cost_micro_usd
			from usage_events
			where kind = 'llm' and created_at > now() - interval '30 days'
			group by 1 order by 1
		`;

		return json(res, 200, { totals, byProvider, byModel, byDay });
	}

	// Feature adoption — which capabilities users actually exercise, by event
	// kind and tool, plus a daily activity trend across all event kinds.
	if (resource === 'features') {
		const byKind = await sql`
			select kind, count(*)::int as events,
				count(distinct user_id)::int as users,
				count(distinct agent_id)::int as agents
			from usage_events
			where created_at > now() - interval '30 days'
			group by kind order by events desc
		`;

		const byTool = await sql`
			select coalesce(tool,'(none)') as tool, kind, count(*)::int as events
			from usage_events
			where created_at > now() - interval '30 days' and tool is not null
			group by tool, kind order by events desc limit 25
		`;

		const byDay = await sql`
			select date_trunc('day', created_at)::date as day, kind, count(*)::int as events
			from usage_events
			where created_at > now() - interval '30 days'
			group by 1, 2 order by 1
		`;

		return json(res, 200, { byKind, byTool, byDay });
	}

	// x402 payment activity — the revenue side. amount_atomics is raw token
	// units (text); we sum as numeric. The UI converts to USDC (6 decimals).
	if (resource === 'x402') {
		const [totals] = await sql`
			select
				count(*) filter (where event_type = 'payment_settled')::int                 as settled,
				count(*) filter (where event_type = 'payment_failed')::int                  as failed,
				count(distinct payer) filter (where event_type = 'payment_settled')::int    as unique_payers,
				coalesce(sum((amount_atomics)::numeric) filter (where event_type = 'payment_settled'),0)::text as volume_atomics
			from x402_audit_log
			where created_at > now() - interval '30 days'
		`;

		const byRoute = await sql`
			select coalesce(route,'(unknown)') as route,
				count(*)::int as payments,
				coalesce(sum((amount_atomics)::numeric),0)::text as volume_atomics
			from x402_audit_log
			where event_type = 'payment_settled' and created_at > now() - interval '30 days'
			group by route order by payments desc limit 20
		`;

		const byDay = await sql`
			select date_trunc('day', created_at)::date as day,
				count(*)::int as payments,
				coalesce(sum((amount_atomics)::numeric),0)::text as volume_atomics
			from x402_audit_log
			where event_type = 'payment_settled' and created_at > now() - interval '30 days'
			group by 1 order by 1
		`;

		return json(res, 200, { totals, byRoute, byDay });
	}

	if (resource === 'referrals') {
		// Viral loop health. Window is configurable (?days=, 1–365, default 30) so
		// the loop's k-factor and funnel can be tracked over the period that matters.
		const params = new URL(req.url, 'http://x').searchParams;
		const days = Math.min(365, Math.max(1, parseInt(params.get('days') || '30', 10)));
		const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

		// Funnel counts over the window:
		//   visits   — deduped referral-link visits (referral_visits)
		//   sharers  — distinct attributed referrers who drove ≥1 visit
		//   signups  — accounts that signed up referred (users.referred_by_id set)
		//   activations — referred accounts that reached their first win
		const [funnel] = await sql`
			select
				(select count(*)::int from referral_visits
					where created_at > ${cutoff}::timestamptz)                                   as visits,
				(select count(distinct referrer_user_id)::int from referral_visits
					where created_at > ${cutoff}::timestamptz and referrer_user_id is not null) as sharers,
				(select count(*)::int from users
					where referred_by_id is not null and deleted_at is null
					  and created_at > ${cutoff}::timestamptz)                                  as signups,
				(select count(*)::int from users
					where referred_by_id is not null and deleted_at is null
					  and activated_at is not null and activated_at > ${cutoff}::timestamptz)   as activations
		`;

		// All-time totals for context (referred members, activated members, rewards paid).
		const [totals] = await sql`
			select
				(select count(*)::int from users
					where referred_by_id is not null and deleted_at is null)            as referred_members,
				(select count(*)::int from users
					where referred_by_id is not null and deleted_at is null
					  and activated_at is not null)                                     as activated_referred_members,
				(select coalesce(sum(amount_usd),0)::float from credit_ledger
					where ref_type = 'referral_activation' and kind = 'grant')          as rewards_paid_usd,
				(select count(*)::int from credit_ledger
					where ref_type = 'referral_activation' and kind = 'grant')          as rewards_paid_count
		`;

		// Top referrers by activated referrals (the conversions that actually matter).
		const topReferrers = await sql`
			select
				u.id, u.username, u.display_name,
				count(ru.id)::int                                                  as referred_total,
				count(ru.id) filter (where ru.activated_at is not null)::int       as activated_total,
				coalesce(u.referral_earnings_total, 0)::bigint                     as commission_atomics
			from users u
			join users ru on ru.referred_by_id = u.id and ru.deleted_at is null
			where u.deleted_at is null
			group by u.id, u.username, u.display_name, u.referral_earnings_total
			order by activated_total desc, referred_total desc
			limit 20
		`;

		// Daily referred signups vs activations — the trend line for the loop.
		const byDay = await sql`
			select day, sum(signups)::int as signups, sum(activations)::int as activations from (
				select date_trunc('day', created_at)::date as day, count(*) as signups, 0 as activations
					from users
					where referred_by_id is not null and deleted_at is null and created_at > ${cutoff}::timestamptz
					group by 1
				union all
				select date_trunc('day', activated_at)::date as day, 0 as signups, count(*) as activations
					from users
					where referred_by_id is not null and deleted_at is null
					  and activated_at is not null and activated_at > ${cutoff}::timestamptz
					group by 1
			) t
			group by day order by day
		`;

		const visits = Number(funnel.visits || 0);
		const signups = Number(funnel.signups || 0);
		const activations = Number(funnel.activations || 0);
		const sharers = Number(funnel.sharers || 0);

		return json(res, 200, {
			window_days: days,
			funnel: { visits, sharers, signups, activations },
			// k-factor: new referred signups per sharing user this window. >1 = viral.
			k_factor: computeKFactor({ signups, sharers }),
			conversion: {
				visit_to_signup: conversionRate(signups, visits),
				signup_to_activation: conversionRate(activations, signups),
			},
			totals: {
				referred_members: Number(totals.referred_members || 0),
				activated_referred_members: Number(totals.activated_referred_members || 0),
				rewards_paid_usd: Number(totals.rewards_paid_usd || 0),
				rewards_paid_count: Number(totals.rewards_paid_count || 0),
			},
			top_referrers: topReferrers.map((r) => ({
				user_id: r.id,
				username: r.username || null,
				display_name: r.display_name || r.username || null,
				referred_total: Number(r.referred_total || 0),
				activated_total: Number(r.activated_total || 0),
				commission_earned_usd: Number(r.commission_atomics || 0) / 1_000_000,
			})),
		});
	}

	return error(res, 404, 'not_found', 'unknown admin resource');
});
