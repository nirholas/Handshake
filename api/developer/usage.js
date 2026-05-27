// GET /api/developer/usage — API usage metrics for the developer dashboard.
//
// Returns request counts, error rates, top endpoints, and usage over time
// aggregated from audit_log + webhook_deliveries + x402 transactions.
//
// Query parameters:
//   days  — lookback window: 7 | 30 | 90 (default: 30)

import { cors, error, json, method, wrap } from '../_lib/http.js';
import { getSessionUser } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';

const ALLOWED_DAYS = [7, 30, 90];

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'Sign in required');

	const url = new URL(req.url, 'http://x');
	const days = ALLOWED_DAYS.includes(Number(url.searchParams.get('days')))
		? Number(url.searchParams.get('days'))
		: 30;

	const since = new Date(Date.now() - days * 86400_000).toISOString();

	const [apiKeyStats, auditStats, auditTimeseries, topActions, webhookStats, x402Stats] =
		await Promise.all([
			sql`
			select count(*)::int as total_keys,
			       count(*) filter (where revoked_at is null)::int as active_keys
			from api_keys
			where user_id = ${user.id}
		`.catch(() => [{ total_keys: 0, active_keys: 0 }]),

			sql`
			select count(*)::int as total_requests,
			       count(distinct action)::int as unique_actions,
			       count(*) filter (where action like '%.error%' or action like '%fail%')::int as error_count,
			       min(created_at) as first_request_at,
			       max(created_at) as last_request_at
			from audit_log
			where user_id = ${user.id} and created_at >= ${since}::timestamptz
		`.catch(() => [{ total_requests: 0, unique_actions: 0, error_count: 0, first_request_at: null, last_request_at: null }]),

			sql`
			select date_trunc('day', created_at)::date as day,
			       count(*)::int as requests
			from audit_log
			where user_id = ${user.id} and created_at >= ${since}::timestamptz
			group by 1
			order by 1
		`.catch(() => []),

			sql`
			select action, count(*)::int as count
			from audit_log
			where user_id = ${user.id} and created_at >= ${since}::timestamptz
			group by action
			order by count desc
			limit 10
		`.catch(() => []),

			sql`
			select count(*)::int as total_deliveries,
			       count(*) filter (where status_code between 200 and 299)::int as succeeded,
			       count(*) filter (where status_code is null or status_code >= 400)::int as failed
			from webhook_deliveries wd
			join developer_webhooks dw on dw.id = wd.webhook_id
			where dw.user_id = ${user.id} and wd.created_at >= ${since}::timestamptz
		`.catch(() => [{ total_deliveries: 0, succeeded: 0, failed: 0 }]),

			sql`
			select count(*)::int as total_payments,
			       coalesce(sum(amount_usdc), 0)::bigint as total_usdc
			from x402_receipts
			where payee_user_id = ${user.id} and created_at >= ${since}::timestamptz
		`.catch(() => [{ total_payments: 0, total_usdc: 0 }]),
		]);

	const audit = auditStats[0] || { total_requests: 0, unique_actions: 0, error_count: 0 };
	const keys = apiKeyStats[0] || { total_keys: 0, active_keys: 0 };
	const wh = webhookStats[0] || { total_deliveries: 0, succeeded: 0, failed: 0 };
	const x402 = x402Stats[0] || { total_payments: 0, total_usdc: 0 };
	const errorRate = audit.total_requests > 0
		? Number(((audit.error_count / audit.total_requests) * 100).toFixed(2))
		: 0;

	return json(res, 200, {
		period: { days, since },
		api_keys: keys,
		requests: {
			total: audit.total_requests,
			unique_actions: audit.unique_actions,
			errors: audit.error_count,
			error_rate: errorRate,
			first_at: audit.first_request_at,
			last_at: audit.last_request_at,
		},
		timeseries: auditTimeseries,
		top_actions: topActions,
		webhooks: wh,
		x402: {
			payments: x402.total_payments,
			volume_usdc: Number(x402.total_usdc),
		},
	});
});
