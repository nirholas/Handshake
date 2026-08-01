// @ts-check
/**
 * Exit Lab: the replayable corpus of REAL closed sniper positions.
 *
 *   GET /api/sniper/exit-lab?network=mainnet&window=90&limit=400
 *
 * Returns every closed position whose recorded price path can honestly be
 * replayed under a different exit policy, in the compact shape
 * `api/_lib/exit-replay.js` consumes. The browser console at /exit-lab does the
 * replay itself against the same kernel, so moving a slider is instant and the
 * server is not asked to re-derive an answer it has no better claim to.
 *
 * Every row is a position the fleet actually opened with real SOL and closed
 * on-chain: `buy_sig` is present and is not the 'SIMULATED' sentinel, so a paper
 * fill can never enter the corpus. Public + IP rate-limited, exactly like the
 * leaderboard: the tx signatures are the proof, and the point is that anyone can
 * check the fleet's homework.
 *
 * Exclusions are returned, not hidden. A position whose initials were already
 * taken has had its cost basis scaled down and its high-water mark reset by the
 * partial-sell path (workers/agent-sniper/executor.js), so its recorded points
 * are bag-relative and the original path is unrecoverable. Replaying it anyway
 * would produce a confident number computed from figures that no longer mean
 * what they look like. It is dropped with a stated reason and counted, so the
 * console can tell the reader exactly how much of the fleet's history the answer
 * covers.
 */

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const WINDOWS = new Set(['7', '30', '90', 'all']);
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 400;

/** Why a closed position could not enter the replay corpus. */
const EXCLUSIONS = {
	laddered: 'Initials were already taken, so the recorded cost basis and high-water mark describe the moon bag, not the original position.',
	no_path: 'No high-water mark or final quote was recorded, so there is no price path to replay.',
	no_basis: 'No entry cost was recorded.',
};

function solscan(sig, network) {
	if (!sig || sig === 'SIMULATED') return null;
	return network === 'devnet' ? `https://solscan.io/tx/${sig}?cluster=devnet` : `https://solscan.io/tx/${sig}`;
}

function numOrNull(v) {
	if (v == null || v === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://localhost');
	const network = NETWORKS.has(url.searchParams.get('network') || '') ? url.searchParams.get('network') : 'mainnet';
	const windowRaw = url.searchParams.get('window') || '90';
	const win = WINDOWS.has(windowRaw) ? windowRaw : '90';
	const limitRaw = Number(url.searchParams.get('limit'));
	const limit = Number.isFinite(limitRaw) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limitRaw))) : DEFAULT_LIMIT;

	const start = win === 'all' ? new Date(0) : new Date(Date.now() - Number(win) * 86_400_000);

	let rows = [];
	try {
		rows = await sql`
			SELECT p.mint, p.symbol, p.exit_reason, p.agent_id,
			       p.entry_quote_lamports, p.peak_value_lamports, p.last_value_lamports,
			       p.exit_quote_lamports, p.realized_pnl_lamports, p.initials_recovered,
			       p.opened_at, p.closed_at, p.buy_sig, p.sell_sig,
			       a.name AS agent_name
			FROM agent_sniper_positions p
			LEFT JOIN agent_identities a ON a.id = p.agent_id AND a.is_public IS NOT FALSE
			WHERE p.network = ${network}
			  AND p.status = 'closed'
			  AND p.buy_sig IS NOT NULL
			  AND p.buy_sig <> 'SIMULATED'
			  AND p.closed_at IS NOT NULL
			  AND p.closed_at >= ${start.toISOString()}
			ORDER BY p.closed_at DESC
			LIMIT ${limit}
		`;
	} catch (err) {
		// A read failure is reported as an empty corpus with the reason attached,
		// so the console renders its honest error state instead of a blank page
		// that looks like "the fleet has never traded".
		return json(
			res,
			{ ok: false, error: 'corpus_unavailable', detail: err?.message || 'database read failed', network, window: win, trades: [], excluded: [] },
			{ 'cache-control': 'no-store' },
		);
	}

	const trades = [];
	const excludedCounts = { laddered: 0, no_path: 0, no_basis: 0 };

	for (const r of rows) {
		const entry = numOrNull(r.entry_quote_lamports);
		if (!(entry > 0)) {
			excludedCounts.no_basis += 1;
			continue;
		}
		if (r.initials_recovered === true) {
			excludedCounts.laddered += 1;
			continue;
		}
		const peak = numOrNull(r.peak_value_lamports);
		// The last live quote is the terminal price. When the sweep never wrote one
		// (an exit that fired on its very first tick), the realized proceeds are the
		// same observation from the other side, so the path is still recoverable.
		const terminal = numOrNull(r.last_value_lamports) ?? numOrNull(r.exit_quote_lamports);
		if (peak == null || terminal == null) {
			excludedCounts.no_path += 1;
			continue;
		}
		const opened = r.opened_at ? new Date(r.opened_at).getTime() : null;
		const closed = r.closed_at ? new Date(r.closed_at).getTime() : null;
		trades.push({
			mint: r.mint,
			symbol: r.symbol || null,
			agentId: r.agent_id,
			agentName: r.agent_name || null,
			entryLamports: entry,
			peakLamports: peak,
			terminalLamports: terminal,
			holdSeconds: opened != null && closed != null ? Math.max(0, Math.round((closed - opened) / 1000)) : null,
			actualPnlLamports: numOrNull(r.realized_pnl_lamports),
			actualReason: r.exit_reason || null,
			closedAt: r.closed_at ?? null,
			buyUrl: solscan(r.buy_sig, network),
			sellUrl: solscan(r.sell_sig, network),
		});
	}

	const excluded = Object.entries(excludedCounts)
		.filter(([, n]) => n > 0)
		.map(([key, n]) => ({ key, count: n, reason: EXCLUSIONS[key] }));

	return json(
		res,
		{
			ok: true,
			network,
			window: win,
			trades,
			// The reader deserves the denominator: how many closed positions the
			// window held, and how many the replay can actually speak to.
			scanned: rows.length,
			replayable: trades.length,
			excluded,
			generatedAt: new Date().toISOString(),
		},
		// The corpus only grows when a position closes; a minute of shared cache
		// absorbs a page reload without ever staling a trade out of view.
		{ 'cache-control': 'public, max-age=60' },
	);
});
