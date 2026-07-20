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

import { error, json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { acquireLock, releaseLock, pushTelegramLane } from '../_lib/commit-feed-push.js';

function requireCron(req, res) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) {
		error(res, 503, 'not_configured', 'CRON_SECRET unset');
		return false;
	}
	const auth = req.headers['authorization'] || '';
	const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!constantTimeEquals(presented, secret)) {
		error(res, 401, 'unauthorized', 'invalid cron secret');
		return false;
	}
	return true;
}

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
