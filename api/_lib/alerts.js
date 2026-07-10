// @ts-check
// Real-time ops alerts → Telegram. Errors should find the operator, not wait
// to be hunted: serverError()/wrap() report 5xx server faults here and
// api/client-errors.js reports browser errors, so production failures surface
// in an ops channel seconds after they happen.
//
// Env (both required, else every call is a silent no-op — dev and tests need
// no config):
//   TELEGRAM_BOT_TOKEN      — same bot the changelog pusher uses
//   TELEGRAM_ALERTS_CHAT_ID — PRIVATE ops chat/channel id. Never the public
//                             holders' channel: alerts carry stack traces,
//                             URLs, and IPs.
//
// Noise control, because an alert channel that floods gets muted and then it
// protects nothing:
//   - per-signature dedup: one alert per unique error signature per hour
//   - global ceiling: max 20 alerts per hour, then one "throttled" notice
// Both windows live in the shared cache (Upstash Redis when configured, so
// dedup holds across serverless instances; in-memory otherwise).
//
// Fire-and-forget like sentry.js: a hard 2.5s abort, every failure swallowed.
// An alerting pipeline must never delay or break the request it's reporting on.

import { createHash } from 'node:crypto';
import { cacheGet, cacheSet } from './cache.js';

const DEDUP_TTL_S = 60 * 60;
const GLOBAL_LIMIT_PER_HOUR = 20;

function config() {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	const chatId = process.env.TELEGRAM_ALERTS_CHAT_ID;
	return token && chatId ? { token, chatId } : null;
}

/**
 * Whether a real alert channel is wired. When false, every sendOpsAlert() is a
 * silent no-op — intended for dev/tests, but dangerous to leave unnoticed in
 * production, so /api/healthz reports this instead of letting the silence pass
 * for health.
 * @returns {boolean}
 */
export function alertsConfigured() {
	return config() !== null;
}

function signatureOf(text) {
	return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function post(cfg, text) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 2500);
	fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			chat_id: cfg.chatId,
			text: text.slice(0, 4000), // Telegram message hard limit is 4096
			disable_web_page_preview: true,
		}),
		signal: controller.signal,
		keepalive: true,
	})
		.catch(() => {})
		.finally(() => clearTimeout(timer));
}

/**
 * Send an ops alert. Deduped and throttled; safe to call on every error path.
 * @param {string} title    one-line summary, e.g. "5xx in /api/chat"
 * @param {string} [detail] body lines (message, ref, page, stack head)
 * @param {{ signature?: string }} [opts] override the dedup signature when
 *        the title/detail contain per-event noise (ids, refs) that would
 *        defeat dedup.
 */
export async function sendOpsAlert(title, detail = '', opts = {}) {
	const cfg = config();
	if (!cfg) return;
	try {
		const sig = signatureOf(opts.signature || `${title}\n${detail}`);
		if (await cacheGet(`alert:dedup:${sig}`)) return;
		await cacheSet(`alert:dedup:${sig}`, 1, DEDUP_TTL_S);

		const hourBucket = `alert:global:${Math.floor(Date.now() / 3_600_000)}`;
		const sent = Number((await cacheGet(hourBucket)) || 0);
		if (sent >= GLOBAL_LIMIT_PER_HOUR) {
			if (sent === GLOBAL_LIMIT_PER_HOUR) {
				await cacheSet(hourBucket, sent + 1, DEDUP_TTL_S);
				post(cfg, `⚠️ three.ws alerts throttled — over ${GLOBAL_LIMIT_PER_HOUR}/h. Check the logs directly.`);
			}
			return;
		}
		await cacheSet(hourBucket, sent + 1, DEDUP_TTL_S);

		const env = process.env.VERCEL_ENV || 'development';
		post(cfg, `🔴 three.ws [${env}] ${title}${detail ? `\n${detail}` : ''}`);
	} catch {
		/* alerting is best-effort, never throws into the caller */
	}
}
