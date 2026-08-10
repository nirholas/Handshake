// GET /api/agent-economy/volume
//
// The platform-wide agent-to-agent economy roll-up: the single read behind the
// public A2A volume dashboard (/agent-economy-volume). Every number is a live
// aggregate over the real `agent_hires` ledger: one row per settled hire where
// one agent paid another for a paid skill over the x402 rails. "Completed" hires
// are the authoritative volume: real USDC moved on-chain, recorded with the
// settlement signature.
//
// Public + read-only. No auth, no PII: only aggregate counts, USD totals, and
// on-chain identifiers (agent ids + payment signatures) that are already public.
//
// Query params:
//   window  = trailing window in days for the daily series + leaderboards
//             (1 to 365, default 30).
//   top     = ranked agents per leaderboard (1 to 50, default 10).
//   recent  = settled hires in the live feed (1 to 50, default 12).
//
// No mock path: when the ledger table is unmigrated/empty the endpoint returns a
// real zero shape so the dashboard renders its empty state, never a fabricated
// value.

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { platformEconomyStats } from '../_lib/agent-economy.js';
import { explorerTxUrl } from '../_lib/avatar-wallet.js';

function intParam(value, fallback) {
	const n = Number.parseInt(Array.isArray(value) ? value[0] : value, 10);
	return Number.isFinite(n) ? n : fallback;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://localhost');
	const windowDays = intParam(url.searchParams.get('window'), 30);
	const topLimit = intParam(url.searchParams.get('top'), 10);
	const recentLimit = intParam(url.searchParams.get('recent'), 12);

	const stats = await platformEconomyStats({ windowDays, topLimit, recentLimit });

	// Attach explorer links to the settled-hire feed so the UI can deep-link each
	// payment to its on-chain proof without re-deriving the cluster client-side.
	const recent = stats.recent.map((h) => ({
		...h,
		explorer_url: h.payment_signature ? explorerTxUrl(h.payment_signature, h.network) : null,
	}));

	// Short cache: the dashboard polls and these are heavy aggregate scans. 30s of
	// staleness is invisible to a human and spares the DB under traffic spikes.
	res.setHeader('Cache-Control', 'public, max-age=15, s-maxage=30, stale-while-revalidate=60');

	return json(res, 200, {
		ok: true,
		generated_at: new Date().toISOString(),
		window_days: stats.window_days,
		totals: stats.totals,
		daily: stats.daily,
		top_providers: stats.top_providers,
		top_hirers: stats.top_hirers,
		recent,
	});
});
