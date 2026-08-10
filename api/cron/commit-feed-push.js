// @ts-check
// GET /api/cron/commit-feed-push — posts every new commit on `main` to
// Telegram as it lands, independent of the curated changelog cron
// (changelog-push.js only ships holder-readable, deploy-gated entries).
//
// Runs every 5 minutes. Reads the commit list from the GitHub REST API,
// diffs it against the last-posted SHA in app_settings, and posts anything
// newer, oldest-first, one message per commit.
//
// Destination: TELEGRAM_COMMITS_CHAT_ID if set, else TELEGRAM_CHANGELOG_CHAT_ID
// (the existing @three_ws channel) so this works out of the box on the same
// bot. Point TELEGRAM_COMMITS_CHAT_ID at a separate chat to split dev/commit
// noise out of the holder-facing channel.
//
// A lane whose credentials are absent reports { skipped: 'not_configured' }.
//   Telegram: TELEGRAM_BOT_TOKEN + (TELEGRAM_COMMITS_CHAT_ID or TELEGRAM_CHANGELOG_CHAT_ID)
//
// A DB lock (app_settings) keeps overlapping ticks from double-posting.

import { json, method, wrapCron } from '../_lib/http.js';
import { acquireLock, releaseLock, pushTelegramLane } from '../_lib/commit-feed-push.js';
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
		if (failed) console.warn('[cron] commit-feed-push lane error', { telegram });
		json(res, failed ? 502 : 200, { ok: !failed, telegram });
	} finally {
		await releaseLock().catch(() => {});
	}
});
