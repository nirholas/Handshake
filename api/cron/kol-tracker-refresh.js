// GET/POST /api/cron/kol-tracker-refresh - prewarm the KOL Tracker's caches.
//
// The tracker (src/kol/tracker.js) computes P&L live per request but caches the
// X follower/avatar lookup for 15 minutes (src/kol/x-profile.js) - the free X API
// tier's rate limit (75 user lookups/15min) can't absorb every page load hitting
// it cold. Running this every 10 minutes keeps that cache warm so a visitor's
// request never blocks on (or exhausts) the X API budget.
//
// Idempotent and cheap: getKolTracker's own cache checks make a warm run mostly
// no-ops.

import { json, method, wrapCron } from '../_lib/http.js';
import { requireCron } from '../_lib/cron-auth.js';

const WINDOWS = ['24h', '7d', '30d'];

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;
	const started = Date.now();

	const { getKolTracker } = await import('../../src/kol/tracker.js');
	const results = await Promise.allSettled(
		WINDOWS.map((window) => getKolTracker({ window, limit: 100 })),
	);

	// A prewarm that silently returned nulls for every window still read as a
	// healthy 200, so a tracker broken for hours looked identical to a warm
	// cache. Report the failed windows and their reason instead.
	const byWindow = {};
	const failures = {};
	results.forEach((r, i) => {
		const window = WINDOWS[i];
		if (r.status === 'fulfilled') {
			byWindow[window] = r.value.length;
		} else {
			byWindow[window] = null;
			failures[window] = String(r.reason?.message || r.reason).slice(0, 160);
		}
	});
	const failed = Object.keys(failures).length;
	if (failed) console.warn('[kol-tracker-refresh] prewarm failed for', failures);

	return json(res, 200, {
		ok: failed < WINDOWS.length,
		rows: byWindow,
		failed,
		...(failed ? { failures } : {}),
		ms: Date.now() - started,
	});
});
