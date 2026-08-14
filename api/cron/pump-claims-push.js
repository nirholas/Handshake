// @ts-check
// GET /api/cron/pump-claims-push posts every new pump.fun FIRST creator-fee
// claim to Telegram as it lands.
//
// Runs every 5 minutes. Scans recent claims via the shared scanner in
// api/_lib/pump-claims.js, diffs them against the last-posted signatures in
// app_settings, and posts anything new, oldest-first, one message per claim.
//
// Destination: TELEGRAM_PUMP_CLAIMS_CHAT_ID. There is no fallback to the
// holder channel on purpose (see api/_lib/pump-claims-push.js).
//
// A lane whose credentials are absent reports { skipped: 'not_configured' }.
//   Telegram: TELEGRAM_BOT_TOKEN + TELEGRAM_PUMP_CLAIMS_CHAT_ID
//
// The scan itself needs a claims source. With PUMPFUN_BOT_URL configured it
// reads the indexer; without it the scanner falls back to a direct RPC scan
// that cannot cover a useful time window on a program this busy, so the lane
// reports { scanned: 0 } indefinitely. See docs/pump-claims-channel.md.
//
// A DB lock (app_settings) keeps overlapping ticks from double-posting.

import { json, method, wrapCron } from '../_lib/http.js';
import { acquireLock, releaseLock, pushTelegramLane } from '../_lib/pump-claims-push.js';
import { requireCron } from '../_lib/cron-auth.js';

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	if (!(await acquireLock())) {
		json(res, 200, { ok: true, skipped: 'locked' });
		return;
	}

	try {
		const telegram = await pushTelegramLane();
		const failed = Boolean(telegram.error);
		if (failed) console.warn('[cron] pump-claims-push lane error', { telegram });
		json(res, failed ? 502 : 200, { ok: !failed, telegram });
	} finally {
		await releaseLock().catch(() => {});
	}
});
