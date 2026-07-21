// GET/POST /api/cron/oracle-calibrate (Bridge 3): does the Oracle's conviction
// actually predict realized wins?
//
// For every mint the fleet really traded, this joins the coin's Oracle conviction
// to the fleet's realized outcome, buckets by conviction band, and computes the
// REALIZED win rate per band. A well-calibrated Oracle has an 80-conviction band
// winning ~80% of the time; drift means the score is over- or under-confident.
//
// It writes oracle_calibration (per band: samples, observed win rate, mean
// conviction, mean realized PnL%, and a BOUNDED correction_factor). The factor is
// observed_rate / predicted_rate, clamped to [0.7, 1.3], and only leaves 1.0
// (no-op) once a band has enough real trades.
//
// The correction is deliberately NOT written back onto the canonical
// oracle_conviction score: the calibration is measured against that score, so
// mutating it would feed back into its own measurement and oscillate. Instead the
// factor is EXPOSED (GET /api/oracle/calibration) and the practical correction is
// applied where it belongs, in the sniper optimizer's Rule O, which tunes each
// arm's entry threshold toward the conviction band that realized wins. Additive
// and idempotent.

import { error, json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { sql } from '../_lib/db.js';

const BANDS = [
	{ lo: 0, hi: 30 }, { lo: 30, hi: 50 }, { lo: 50, hi: 70 }, { lo: 70, hi: 85 }, { lo: 85, hi: 101 },
];
const MIN_BAND_SAMPLE = 5;
const FACTOR_MIN = 0.7;
const FACTOR_MAX = 1.3;

function requireCron(req, res) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) { error(res, 503, 'not_configured', 'CRON_SECRET unset'); return false; }
	const auth = req.headers['authorization'] || '';
	const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!constantTimeEquals(presented, secret)) { error(res, 401, 'unauthorized', 'invalid cron secret'); return false; }
	return true;
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;
	const network = 'mainnet';

	// Per traded mint: its conviction score and the fleet's net realized outcome.
	const rows = await sql`
		select oc.score,
			case when sum(p.realized_pnl_lamports) > 0 then 1 else 0 end as win,
			avg(p.realized_pnl_pct) as pnl_pct
		from agent_sniper_positions p
		join oracle_conviction oc on oc.mint = p.mint and oc.network = p.network
		where p.network = ${network} and p.status = 'closed'
		  and p.buy_sig <> 'SIMULATED' and p.realized_pnl_lamports is not null
		group by oc.mint, oc.score
	`;

	const out = [];
	for (const band of BANDS) {
		const inBand = rows.filter((r) => Number(r.score) >= band.lo && Number(r.score) < band.hi);
		const samples = inBand.length;
		const wins = inBand.reduce((s, r) => s + Number(r.win), 0);
		const observed = samples ? wins / samples : null;
		const avgConv = samples ? inBand.reduce((s, r) => s + Number(r.score), 0) / samples : null;
		const avgPct = samples ? inBand.reduce((s, r) => s + (Number(r.pnl_pct) || 0), 0) / samples : null;
		const predicted = avgConv != null ? avgConv / 100 : null;
		let factor = 1;
		if (samples >= MIN_BAND_SAMPLE && predicted && predicted > 0.01 && observed != null) {
			factor = clamp(observed / predicted, FACTOR_MIN, FACTOR_MAX);
		}
		await sql`
			insert into oracle_calibration (network, bucket_lo, bucket_hi, samples, wins, observed_rate, avg_conviction, avg_realized_pct, correction_factor, updated_at)
			values (${network}, ${band.lo}, ${band.hi}, ${samples}, ${wins},
			        ${observed}, ${avgConv}, ${avgPct != null ? Number(avgPct.toFixed(4)) : null}, ${Number(factor.toFixed(4))}, now())
			on conflict (network, bucket_lo) do update set
				bucket_hi = excluded.bucket_hi, samples = excluded.samples, wins = excluded.wins,
				observed_rate = excluded.observed_rate, avg_conviction = excluded.avg_conviction,
				avg_realized_pct = excluded.avg_realized_pct, correction_factor = excluded.correction_factor,
				updated_at = now()
		`;
		out.push({ band: `${band.lo}-${band.hi === 101 ? '100' : band.hi}`, samples, observed_rate: observed, correction_factor: Number(factor.toFixed(3)) });
	}

	return json(res, 200, { ok: true, traded_scored_mints: rows.length, bands: out });
});
