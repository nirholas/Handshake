// POST/GET /api/pump/intel-enrich
// -------------------------------
// Lights up the bubble-map. The intel engine records every wallet that traded a
// new coin but never resolves WHO FUNDED those wallets, so pump_coin_wallets.funder
// is null and the funder-cluster / bundle / bubblemap_connectivity signals the
// /coin-intel API and radar render stay empty. This endpoint resolves funders
// from chain history (api/_lib/pump-intel/enrich.js) and persists them, turning a
// designed-but-dark signal into a real one — the "is this coordinated or organic?"
// answer the whole engine was built to give.
//
//   ?mint=<mint>&network=mainnet        enrich ONE coin's top buyers (the "deep scan")
//   ?recent=<n>&network=mainnet         backfill the n freshest not-yet-enriched coins (cap 8)
//
// Writes only pump_coin_wallets.funder (a column nothing else writes) and the
// funder-derived signal fields on pump_coin_intel — no clobber of the watcher's
// writes. Makes bounded chain calls, so it's rate-limited harder than the reads.
// Idempotent: re-running skips wallets whose funder is already known.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { enrichCoin } from '../_lib/pump-intel/enrich.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_BACKFILL = 8;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	// Bounded chain work per call → the meta limiter (60 / 10 min / IP) fits.
	const rl = await limits.pumpMetaIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const p = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const network = NETWORKS.has(p.get('network')) ? p.get('network') : 'mainnet';
	const mint = (p.get('mint') || '').trim();
	const recent = p.get('recent');

	// ── single-coin deep scan ────────────────────────────────────────────────
	if (mint) {
		if (!ADDR_RE.test(mint)) {
			return error(res, 400, 'invalid_mint', 'mint must be a base58 pump.fun address');
		}
		const result = await enrichCoin({ mint, network });
		if (!result.ok && result.reason === 'no_wallets') {
			return error(res, 404, 'not_found', 'No observed wallets for this coin yet — it may be outside the radar window.');
		}
		return json(res, 200, result, { 'cache-control': 'no-store' });
	}

	// ── bounded backfill of the freshest un-enriched coins ───────────────────
	if (recent != null) {
		const n = Math.max(1, Math.min(MAX_BACKFILL, parseInt(recent, 10) || 3));
		let mints = [];
		try {
			// Coins observed recently whose wallet ledger has NO funder resolved yet.
			const rows = await sql`
				select i.mint
				from pump_coin_intel i
				where i.network = ${network}
				  and i.first_seen_at >= now() - interval '6 hours'
				  and not exists (
				      select 1 from pump_coin_wallets w
				      where w.mint = i.mint and w.funder is not null
				  )
				  and exists (
				      select 1 from pump_coin_wallets w where w.mint = i.mint
				  )
				order by i.first_seen_at desc
				limit ${n}
			`;
			mints = rows.map((r) => r.mint);
		} catch (err) {
			// The caller still gets a clean 503, but swallowing the cause left no way
			// to tell "the intel store is down" from "nothing to enrich" in the logs.
			console.error('[pump/intel-enrich] backfill query failed:', err?.message || err);
			return error(res, 503, 'intel_unavailable', 'intel store is temporarily unavailable');
		}
		if (!mints.length) {
			return json(res, 200, { network, backfilled: 0, results: [], note: 'nothing to enrich' },
				{ 'cache-control': 'no-store' });
		}
		// Sequential — bounds total chain pressure across coins per invocation.
		const results = [];
		for (const m of mints) results.push(await enrichCoin({ mint: m, network }));
		return json(res, 200, {
			network,
			backfilled: results.filter((r) => r.ok).length,
			results,
		}, { 'cache-control': 'no-store' });
	}

	return error(res, 400, 'bad_request', 'pass ?mint=<mint> for a deep scan, or ?recent=<n> to backfill.');
});
