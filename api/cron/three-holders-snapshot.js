// @ts-check
// GET /api/cron/three-holders-snapshot — refresh the cached $THREE holder set.
//
// The public holder leaderboard (api/leaderboard.js), its OG share card
// (api/og-leaderboard.js), and the token stats panel (api/three-token/[action].js)
// all need the full $THREE holder set to rank wallets and compute % of supply.
// Reading that live meant a full Helius DAS `getTokenAccounts` walk on every
// edge-cache miss — so DAS credit burn scaled with page/bot traffic, not with how
// often the data actually changes.
//
// This cron runs ONE scan every 5 minutes and writes the result to
// three_holder_snapshot; the public surfaces serve from that snapshot. Net effect:
// $THREE holder DAS calls drop from traffic-driven to a fixed ~12/hour, and the
// OG-card crawler-amplification vector is gone.
//
// Standalone (not [name].js) so the import graph stays minimal — just the snapshot
// module and its Helius/DB dependencies.

import { error, json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { refreshThreeHolderSnapshot } from '../_lib/coin/three-holders.js';
import { isRpcRateLimited } from '../_lib/coin/holders.js';
import { isDbUnavailableError } from '../_lib/db.js';
import { cacheGet, cacheSet } from '../_lib/cache.js';
import { requireCron } from '../_lib/cron-auth.js';

// After a rate-limited scan, hold off further refresh attempts for this long.
// The per-page retries inside fetchHolderBalances already burn ~90s against a
// throttled Helius before giving up; retrying again on the very next tick just
// extends the throttle window. The snapshot serves stale-but-good data in the
// meantime, so a pause costs nothing but ends the 429 storm.
const RATE_LIMIT_COOLDOWN_KEY = 'three-holders:rate-limit-cooldown';
const RATE_LIMIT_COOLDOWN_S = 600;

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	if (!process.env.HELIUS_API_KEY) {
		// No key → the snapshot can't refresh; the public reads keep serving the
		// last good snapshot (or live-fall-back) and degrade gracefully.
		return json(res, 200, { ok: false, reason: 'HELIUS_API_KEY unset', refreshed: false });
	}

	const cooling = await cacheGet(RATE_LIMIT_COOLDOWN_KEY);
	if (cooling) {
		return json(res, 200, { ok: true, refreshed: false, skipped: 'rate_limit_cooldown' });
	}

	const started = Date.now();
	try {
		const result = await refreshThreeHolderSnapshot();
		console.log(
			`[three-holders-snapshot] refreshed ${result.holders} holders in ${Date.now() - started}ms`,
		);
		return json(res, 200, { ok: true, refreshed: true, ...result, elapsed_ms: Date.now() - started });
	} catch (err) {
		// Never throw: a failed scan leaves the prior snapshot intact (the refresh
		// only deletes inside a successful scan), so public reads are unaffected.
		// A transient upstream blip — a `terminated` fetch, a Helius 429 cooldown,
		// a network reset, a DB auth failure — is expected operationally and
		// self-heals on the next 5-minute tick, so warn rather than error to keep
		// it out of alerting; reserve error for unexpected faults (a bug, a bad
		// schema migration).
		const msg = err?.message || String(err);
		// A DB outage (missing/rotated DATABASE_URL, suspended Neon compute) is
		// operationally expected and self-heals on the next tick — classify it with
		// the same isDbUnavailableError gate the rest of the platform uses so it
		// warns rather than firing a per-tick error into alerting.
		// A Helius 429 surfaces as a SolanaError whose human-readable message is
		// stripped in prod ("Solana error #8100002; Decode this …") — it carries
		// neither "429" nor "rate limit" as text, so the string regex alone missed
		// it and fired a per-tick ERROR into alerting. isRpcRateLimited inspects the
		// structured statusCode, classifying the throttle correctly as transient.
		const transient = isDbUnavailableError(err)
			|| isRpcRateLimited(err)
			|| /terminated|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|429|rate.?limit|too many requests|network|password authentication failed|table unavailable/i.test(msg);
		if (transient) console.warn('[three-holders-snapshot] refresh deferred (transient upstream):', msg);
		else console.error('[three-holders-snapshot] refresh failed:', msg);
		// A throttle means Helius needs breathing room, not an immediate retry —
		// park the refresh for the cooldown window so successive ticks skip cheaply.
		if (isRpcRateLimited(err) || /429|rate.?limit|too many requests/i.test(msg)) {
			await cacheSet(RATE_LIMIT_COOLDOWN_KEY, { at: Date.now() }, RATE_LIMIT_COOLDOWN_S);
		}
		return json(res, 200, { ok: false, refreshed: false, error: msg });
	}
});
