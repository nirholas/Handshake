// GET/POST /api/cron/kol-tracker-refresh — prewarm the KOL Tracker's caches.
//
// The tracker (src/kol/tracker.js) computes P&L live per request but caches the
// X follower/avatar lookup for 15 minutes (src/kol/x-profile.js) — the free X API
// tier's rate limit (75 user lookups/15min) can't absorb every page load hitting
// it cold. Running this every 10 minutes keeps that cache warm so a visitor's
// request never blocks on (or exhausts) the X API budget.
//
// Idempotent and cheap: getKolTracker's own cache checks make a warm run mostly
// no-ops.

import { json, wrapCron } from '../_lib/http.js';
import { requireCron } from '../_lib/cron-auth.js';

const WINDOWS = ['24h', '7d', '30d'];

export default wrapCron(async (req, res) => {
	if (!requireCron(req, res)) return;
	const started = Date.now();

	const { getKolTracker } = await import('../../src/kol/tracker.js');
	const results = await Promise.allSettled(
		WINDOWS.map((window) => getKolTracker({ window, limit: 100 })),
	);

	const byWindow = {};
	results.forEach((r, i) => {
		byWindow[WINDOWS[i]] = r.status === 'fulfilled' ? r.value.length : null;
	});

	return json(res, 200, { ok: true, rows: byWindow, ms: Date.now() - started });
});
