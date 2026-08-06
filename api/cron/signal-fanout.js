// GET /api/cron/signal-fanout — drive the reputation-gated signal marketplace.
//
// Two passes per network:
//   1. EMIT — for every active feed whose publisher has new position activity
//      (an open or a close) since the feed's cursor, generate the corresponding
//      entry/exit emissions from the REAL agent_sniper_positions and backfill the
//      realized outcome onto closed entries (api/_lib/signal-engine.js
//      syncFeedEmissions). Sellers never hand-author signals — every emission
//      binds to an on-chain fill.
//   2. DELIVER — for every active, non-killed subscription with undelivered
//      emissions, settle the x402 USDC payment and auto-mirror the trade through
//      the SAME firewall + MEV + spend-guard pipeline every other path uses
//      (deliverSubscription → runFollowerTrade). Idempotent end to end: the
//      signal_deliveries unique key and the custody idempotency key both prevent
//      double-paying / double-trading, so re-running (or overlapping with an owner
//      "Sync now") is safe.
//
// Bounded so a 2-minute cron can never run away: only feeds with recent publisher
// activity emit, and each subscription delivers at most N emissions per run.

import { error, json, method, wrapCron } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { syncFeedEmissions, deliverSubscription } from '../_lib/signal-engine.js';
import { requireCron } from '../_lib/cron-auth.js';

const NETWORKS = ['mainnet', 'devnet'];
const MAX_FEEDS_PER_RUN = 120;
const MAX_SUBS_PER_RUN = 200;
const MAX_EVENTS_PER_SUB = 12;

// PASS 1 — generate emissions from publishers' real positions.
async function emitPass(network, stats) {
	// Only feeds whose publisher has a position opened/closed past the relevant
	// cursor recently — keeps the scan bounded to feeds with fresh activity.
	const feeds = await sql`
		SELECT f.*
		FROM signal_feeds f
		JOIN agent_identities a ON a.id = f.publisher_agent_id AND a.deleted_at IS NULL
		WHERE f.status = 'active' AND f.network = ${network}
		  AND EXISTS (
		    SELECT 1 FROM agent_sniper_positions p
		    WHERE p.agent_id = f.publisher_agent_id AND p.network = ${network}
		      AND (
		        (p.opened_at > f.entry_cursor AND p.opened_at > now() - interval '30 minutes')
		        OR (p.status = 'closed' AND p.closed_at > f.exit_cursor AND p.closed_at > now() - interval '30 minutes')
		      )
		  )
		ORDER BY f.updated_at ASC
		LIMIT ${MAX_FEEDS_PER_RUN}
	`;
	if (!feeds.length) return;
	stats.feeds = (stats.feeds || 0) + feeds.length;
	for (const f of feeds) {
		try {
			const r = await syncFeedEmissions(f);
			stats.emitted_entries = (stats.emitted_entries || 0) + r.entries;
			stats.emitted_exits = (stats.emitted_exits || 0) + r.exits;
			stats.closed_signals = (stats.closed_signals || 0) + r.closed;
		} catch (err) {
			stats.emit_error = (stats.emit_error || 0) + 1;
			stats.last_emit_error = (err?.message || 'error').slice(0, 160);
		}
	}
}

// PASS 2 — deliver undelivered emissions to active subscriptions.
async function deliverPass(network, stats) {
	const subs = await sql`
		SELECT s.*
		FROM signal_subscriptions s
		JOIN signal_feeds f ON f.id = s.feed_id AND f.status = 'active'
		JOIN agent_identities sa ON sa.id = s.subscriber_agent_id AND sa.deleted_at IS NULL
		WHERE s.status = 'active' AND s.killed = false AND s.network = ${network}
		  AND EXISTS (
		    SELECT 1 FROM signal_emissions e
		    WHERE e.feed_id = s.feed_id AND e.id > s.last_emission_id
		  )
		ORDER BY s.updated_at ASC
		LIMIT ${MAX_SUBS_PER_RUN}
	`;
	if (!subs.length) return;
	stats.subscriptions = (stats.subscriptions || 0) + subs.length;
	for (const s of subs) {
		try {
			const r = await deliverSubscription(s, { maxEvents: MAX_EVENTS_PER_SUB });
			for (const d of r.results) {
				const key = d.mirror_status || d.status || 'unknown';
				stats[`mirror_${key}`] = (stats[`mirror_${key}`] || 0) + 1;
			}
		} catch (err) {
			stats.deliver_error = (stats.deliver_error || 0) + 1;
			stats.last_deliver_error = (err?.message || 'error').slice(0, 160);
		}
	}
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const stats = {};
	for (const network of NETWORKS) {
		try {
			await emitPass(network, stats);
			await deliverPass(network, stats);
		} catch (err) {
			stats[`error_${network}`] = (err?.message || 'error').slice(0, 160);
		}
	}
	return json(res, 200, { ok: true, ...stats });
});
