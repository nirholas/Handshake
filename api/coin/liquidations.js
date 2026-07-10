// GET /api/coin/liquidations
// ---------------------------------------------------------------------------
// Proxies the real-time liquidations snapshot from the standalone
// `services/liquidation-collector` service (see its README for why this can't
// be a Vercel function — it holds long-lived exchange WebSocket connections).
// Powers the "liquidations pulse" strip on /coins.
//
// No fabricated fallback data, ever: if `LIQUIDATION_COLLECTOR_URL` is unset
// or the upstream is unreachable/slow, this responds 503 { error:
// 'collector_offline' } and the UI renders its designed offline state — never
// synthetic numbers.

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const TIMEOUT_MS = 5000;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const collectorUrl = process.env.LIQUIDATION_COLLECTOR_URL;
	if (!collectorUrl) {
		return json(
			res,
			503,
			{ error: 'collector_offline', error_description: 'liquidation collector is not configured on this deployment' },
			{ 'cache-control': 'no-store' },
		);
	}

	try {
		const upstream = new URL('/liquidations', collectorUrl).toString();
		const resp = await fetch(upstream, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!resp.ok) {
			return json(
				res,
				503,
				{ error: 'collector_offline', error_description: `collector responded ${resp.status}` },
				{ 'cache-control': 'no-store' },
			);
		}
		const payload = await resp.json();
		return json(res, 200, payload, {
			'cache-control': 'public, s-maxage=15, stale-while-revalidate=60',
		});
	} catch {
		return json(
			res,
			503,
			{ error: 'collector_offline', error_description: 'liquidation collector is unreachable right now' },
			{ 'cache-control': 'no-store' },
		);
	}
});
