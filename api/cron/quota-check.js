// @ts-check
// GET /api/cron/quota-check — infrastructure quota watchdog.
//
// Runs hourly. Checks two things:
//
//   1. Upstash Redis daily request quota — alerts at 70% so there's hours of
//      runway to react before the quota blows and rate-limiting fails open/closed
//      (the June 2026 incident: 500k/day exhausted, forge lanes went dark).
//      Requires three optional env vars (no-op if absent):
//        UPSTASH_MANAGEMENT_API_KEY   — Upstash org API key
//        UPSTASH_MANAGEMENT_API_EMAIL — Upstash account email
//        UPSTASH_REDIS_DB_ID          — database ID from Upstash console
//
//   2. QStash dead-letter queue (DLQ) — alerts on any failed jobs so background
//      work (usage flush, knowledge embed, etc.) isn't silently abandoned.
//      Requires QSTASH_TOKEN (already in use by publishJob).
//
// Kept as a concrete file to keep the import graph tiny — this cron must not
// share a cold start with the heavy SDK bundles.

import { error, json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { getRedis } from '../_lib/redis.js';
import { requireCron } from '../_lib/cron-auth.js';

const QUOTA_WARN_PCT = 70;
const QUOTA_CRITICAL_PCT = 90;

async function checkUpstashQuota() {
	const apiKey = process.env.UPSTASH_MANAGEMENT_API_KEY;
	const email = process.env.UPSTASH_MANAGEMENT_API_EMAIL;
	const dbId = process.env.UPSTASH_REDIS_DB_ID;

	if (!apiKey || !email || !dbId) {
		return { skipped: true, reason: 'management_api_not_configured' };
	}

	const credentials = Buffer.from(`${email}:${apiKey}`).toString('base64');
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 8_000);

	try {
		const res = await fetch(`https://api.upstash.com/v2/redis/${dbId}`, {
			headers: {
				authorization: `Basic ${credentials}`,
				accept: 'application/json',
			},
			signal: controller.signal,
		});

		if (!res.ok) {
			return { error: `upstash_api_${res.status}`, body: await res.text().catch(() => '') };
		}

		const data = await res.json();
		const used = data.daily_request_count ?? data.daily_requests ?? null;
		const limit = data.daily_request_limit ?? data.max_daily_requests ?? null;

		if (used === null || limit === null) {
			return { skipped: true, reason: 'quota_fields_absent', keys: Object.keys(data) };
		}

		const pct = Math.round((used / limit) * 100);
		const result = { used, limit, pct };

		if (pct >= QUOTA_CRITICAL_PCT) {
			sendOpsAlert(
				`CRITICAL: Redis quota ${pct}% used`,
				`${used.toLocaleString()} / ${limit.toLocaleString()} daily requests. Rate-limiting may fail.`,
				{ signature: `redis-quota-critical-${pct}` },
			);
		} else if (pct >= QUOTA_WARN_PCT) {
			sendOpsAlert(
				`Redis quota ${pct}% used`,
				`${used.toLocaleString()} / ${limit.toLocaleString()} daily requests. Upgrade Upstash plan before hitting ceiling.`,
				{ signature: `redis-quota-warn-${pct}` },
			);
		}

		// Also store the latest reading in Redis for the /api/status page.
		const r = getRedis();
		if (r) {
			await r.set('quota:redis', JSON.stringify({ ...result, ts: Date.now() }), { ex: 90_000 }).catch(() => {});
		}

		return result;
	} catch (err) {
		return { error: err?.name === 'AbortError' ? 'timeout' : err?.message };
	} finally {
		clearTimeout(timer);
	}
}

async function checkQstashDlq() {
	const token = process.env.QSTASH_TOKEN;
	if (!token) return { skipped: true, reason: 'qstash_not_configured' };

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 8_000);

	try {
		const res = await fetch('https://qstash.upstash.io/v2/dlq', {
			headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
			signal: controller.signal,
		});

		if (!res.ok) {
			return { error: `qstash_dlq_${res.status}`, body: await res.text().catch(() => '') };
		}

		const data = await res.json();
		const messages = data.messages ?? [];
		const count = messages.length;

		if (count > 0) {
			// Summarize which endpoints are failing.
			const endpoints = [...new Set(messages.slice(0, 10).map((m) => {
				try { return new URL(m.url).pathname; } catch { return m.url; }
			}))].join(', ');

			sendOpsAlert(
				`QStash DLQ: ${count} failed job${count === 1 ? '' : 's'}`,
				`Endpoints: ${endpoints}\nOldest: ${messages[0]?.created_at ?? 'unknown'}\nReview at https://console.upstash.com/qstash`,
				{ signature: 'qstash-dlq-nonempty' },
			);
		}

		return { count, sample: messages.slice(0, 3).map((m) => ({ url: m.url, responseStatus: m.response_status })) };
	} catch (err) {
		return { error: err?.name === 'AbortError' ? 'timeout' : err?.message };
	} finally {
		clearTimeout(timer);
	}
}

async function checkUsageBufferBacklog() {
	const r = getRedis();
	if (!r) return { skipped: true };
	try {
		const len = await r.llen('usage:buffer');
		if (len > 2_000) {
			sendOpsAlert(
				`Usage buffer backlog: ${len} events`,
				'The flush cron or QStash job may not be running. Check api/cron/flush-usage-events.',
				{ signature: 'usage-buffer-critical-backlog' },
			);
		}
		return { usageBufferLen: len };
	} catch {
		return { skipped: true };
	}
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	const [quota, dlq, buffer] = await Promise.all([
		checkUpstashQuota(),
		checkQstashDlq(),
		checkUsageBufferBacklog(),
	]);

	return json(res, 200, { quota, dlq, buffer, ts: Date.now() });
});
