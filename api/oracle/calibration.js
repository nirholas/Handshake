/**
 * Oracle conviction calibration (realized).
 *
 *   GET /api/oracle/calibration?network=mainnet
 *
 * The honest answer to "when the Oracle says 80, do those coins actually win 80%
 * of the time with real money?" Per conviction band it returns the fleet's
 * REALIZED win rate (from agent_sniper_positions, real fills only), the mean
 * conviction, the mean realized PnL%, and the bounded correction_factor the
 * scorer applies to nudge future scores toward what actually pays.
 *
 * Written by api/cron/oracle-calibrate. Public + IP rate-limited: the win rates
 * trace to on-chain trades anyone can verify.
 */

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';

const NETWORKS = new Set(['mainnet', 'devnet']);

export default wrap(async (req, res) => {
	// `origins: '*'` like every other public oracle read: these win rates trace to
	// on-chain trades anyone can verify, so there is nothing here the default
	// allowlist is protecting.
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const network = NETWORKS.has(params.get('network')) ? params.get('network') : 'mainnet';

	const rows = await sql`
		select bucket_lo, bucket_hi, samples, wins, observed_rate, avg_conviction, avg_realized_pct, correction_factor, updated_at
		from oracle_calibration
		where network = ${network}
		order by bucket_lo asc
	`;

	const bands = rows.map((r) => ({
		band: `${r.bucket_lo}-${Number(r.bucket_hi) === 101 ? '100' : r.bucket_hi}`,
		samples: Number(r.samples) || 0,
		wins: Number(r.wins) || 0,
		observed_win_rate: r.observed_rate != null ? Number(Number(r.observed_rate).toFixed(3)) : null,
		predicted_win_rate: r.avg_conviction != null ? Number((Number(r.avg_conviction) / 100).toFixed(3)) : null,
		avg_conviction: r.avg_conviction != null ? Number(Number(r.avg_conviction).toFixed(1)) : null,
		avg_realized_pct: r.avg_realized_pct != null ? Number(Number(r.avg_realized_pct).toFixed(2)) : null,
		correction_factor: Number(Number(r.correction_factor).toFixed(3)),
	}));

	const totalSamples = bands.reduce((s, b) => s + b.samples, 0);
	return json(res, 200, { network, total_samples: totalSamples, bands, note: totalSamples < 20 ? 'Calibration is early: bands with few samples keep a neutral correction_factor of 1.0.' : undefined });
});
