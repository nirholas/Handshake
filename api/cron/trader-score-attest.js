// GET /api/cron/trader-score-attest — daily on-chain TraderScore attestations.
//
// Walks the top of the all-time sniper leaderboard and commits each trader's
// rolled-up score to the chain via a signed SPL-Memo attestation (see
// trader-score-attest.js), making the leaderboard's headline numbers tamper-
// evident on top of the per-trade Solscan proof the profile already exposes.
//
// Best-effort, like the other on-chain payout lanes: with no funded attester key
// (ATTEST_AGENT_SECRET_KEY) the cron is authoritative as a DRY RUN — it reports
// exactly which wallets WOULD be attested and why it skipped — rather than 500ing.

import { error, json, method, wrapCron } from '../_lib/http.js';
import { getLeaderboard, getTraderStats } from '../_lib/trader-stats.js';
import { attestTraderScore } from '../_lib/trader-score-attest.js';
import { requireCron } from '../_lib/cron-auth.js';

const TOP_N = 25;
const NETWORKS = ['mainnet', 'devnet'];

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const results = [];
	for (const network of NETWORKS) {
		let board;
		try {
			board = await getLeaderboard({ network, window: 'all', sort: 'score', limit: TOP_N });
		} catch (err) {
			results.push({ network, error: 'leaderboard_failed', detail: err.message });
			continue;
		}

		for (const row of board.leaderboard) {
			if (!row.wallet || !row.closed) continue; // nothing to attest for an empty book
			try {
				// Re-derive the canonical metrics for the subject so the on-chain payload
				// matches what the profile serves byte-for-byte.
				const stats = await getTraderStats({ agentId: row.agent_id, network, window: 'all' });
				if (!stats) continue;
				const out = await attestTraderScore({
					network, wallet: stats.agent.wallet, agentId: row.agent_id,
					metrics: stats.metrics, window: 'all',
				});
				results.push({ network, agent_id: row.agent_id, ...out });
			} catch (err) {
				results.push({
					network, agent_id: row.agent_id,
					status: 'skipped', code: err.code || 'error', detail: err.message,
				});
				// A missing attester key fails identically for every row — stop hammering.
				if (err.code === 'attester_key_not_configured') break;
			}
		}
	}

	const minted = results.filter((r) => r.status === 'minted').length;
	const deduped = results.filter((r) => r.status === 'deduped').length;
	const skipped = results.filter((r) => r.status === 'skipped').length;
	return json(res, 200, { ok: true, minted, deduped, skipped, results });
});
