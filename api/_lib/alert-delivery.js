// @ts-check
// Multi-channel delivery for pump dashboard alerts (Task 04).
//
// Three independent channels — in-app notification, signed webhook, Telegram —
// each wrapped so one channel's failure never blocks the others. Every call
// returns a per-channel result the runner persists to pump_alert_deliveries so
// the dashboard can surface "webhook failed" instead of silently dropping it.
//
// Webhooks are signed with the rule's per-rule secret using the Standard
// Webhooks format (matching api/_lib/webhook-dispatch.js) and pinned to a
// validated public address (SSRF guard). Telegram uses the platform bot and
// no-ops cleanly when TELEGRAM_BOT_TOKEN is absent.

import { sql } from './db.js';
import { hmacSha256, randomToken } from './crypto.js';
import { validatePublicUrl, resolvePublicHost, pinnedAgent, SsrfError } from './ssrf.js';
import { formatAlertSummary } from './pump-alert-eval.js';

import { fetchUpstream } from './upstream-fetch.js';
const WEBHOOK_TIMEOUT_MS = 8_000;
const TELEGRAM_TIMEOUT_MS = 5_000;

/** @typedef {{ attempted: boolean, ok: boolean, detail: string|null }} ChannelResult */

const skipped = () => /** @type {ChannelResult} */ ({ attempted: false, ok: false, detail: null });

/**
 * Deliver one alert across every channel the rule has configured. Channels run
 * concurrently and are fully isolated.
 *
 * @param {import('./pump-alert-eval.js').AlertRule} rule
 * @param {Record<string, any>} payload  alert payload (also stored in-app)
 * @returns {Promise<{ in_app: ChannelResult, webhook: ChannelResult, telegram: ChannelResult }>}
 */
export async function deliverAlert(rule, payload) {
	const [inApp, webhook, telegram] = await Promise.all([
		rule.deliver_in_app ? deliverInApp(rule, payload) : skipped(),
		rule.webhook_url ? deliverWebhook(rule, payload) : skipped(),
		rule.telegram_chat ? deliverTelegram(rule, payload) : skipped(),
	]);
	return { in_app: inApp, webhook, telegram };
}

/** Insert the in-app notification row (type 'pump_alert'). */
async function deliverInApp(rule, payload) {
	try {
		await sql`
			insert into user_notifications (user_id, type, payload)
			values (${rule.user_id}, 'pump_alert', ${JSON.stringify(payload)}::jsonb)
		`;
		return { attempted: true, ok: true, detail: null };
	} catch (e) {
		return { attempted: true, ok: false, detail: errMsg(e) };
	}
}

/**
 * POST a signed event to the rule's webhook. Redirects are not followed and the
 * connection is pinned to the resolved public address so a webhook can't be
 * used as an SSRF oracle. Returns ok only on a 2xx.
 */
async function deliverWebhook(rule, payload) {
	const eventId = `evt_${randomToken(16)}`;
	const timestamp = Math.floor(Date.now() / 1000);
	const body = JSON.stringify({
		id: eventId,
		type: 'pump.alert',
		created_at: new Date(timestamp * 1000).toISOString(),
		data: payload,
	});

	let target;
	let agent;
	try {
		target = validatePublicUrl(rule.webhook_url);
		const addrs = await resolvePublicHost(target.hostname);
		agent = pinnedAgent(target.hostname, addrs);
	} catch (e) {
		const reason = e instanceof SsrfError ? `blocked_url:${e.code}` : 'invalid_url';
		return { attempted: true, ok: false, detail: reason };
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
	try {
		const headers = {
			'content-type': 'application/json',
			'webhook-id': eventId,
			'webhook-timestamp': String(timestamp),
			'user-agent': 'three.ws-pump-alerts/1.0',
		};
		if (rule.webhook_secret) {
			const sig = await hmacSha256(rule.webhook_secret, `${eventId}.${timestamp}.${body}`);
			headers['webhook-signature'] = `v1,${sig}`;
		}
		const res = await fetchUpstream(target, {
			method: 'POST',
			redirect: 'manual',
			// @ts-ignore — undici dispatcher option, pins the resolved address.
			dispatcher: agent,
			headers,
			body,
			signal: controller.signal,
		}, { timeoutMs: 10_000, attempts: 2, okWhen: () => true });
		if (res.status >= 300 && res.status < 400) {
			return { attempted: true, ok: false, detail: `redirect_not_followed:${res.status}` };
		}
		return { attempted: true, ok: res.ok, detail: res.ok ? null : `http_${res.status}` };
	} catch (e) {
		return { attempted: true, ok: false, detail: errMsg(e) };
	} finally {
		clearTimeout(timer);
		await agent.close().catch(() => {});
	}
}

/**
 * Send the alert to the user's Telegram chat via the platform bot. No-ops
 * cleanly (attempted=false) when the bot token is unset so dev/test never fail.
 */
async function deliverTelegram(rule, payload) {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	if (!token) return { attempted: false, ok: false, detail: 'no_bot_token' };

	const text = telegramText(payload);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
	try {
		const res = await fetchUpstream(`https://api.telegram.org/bot${token}/sendMessage`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				chat_id: rule.telegram_chat,
				text,
				disable_web_page_preview: true,
			}),
			signal: controller.signal,
		}, { name: 'telegram', timeoutMs: 10_000, attempts: 2, okWhen: () => true });
		const data = await res.json().catch(() => ({}));
		if (!res.ok || data?.ok === false) {
			return { attempted: true, ok: false, detail: data?.description || `http_${res.status}` };
		}
		return { attempted: true, ok: true, detail: null };
	} catch (e) {
		return { attempted: true, ok: false, detail: errMsg(e) };
	} finally {
		clearTimeout(timer);
	}
}

/** Plain-text Telegram body — no parse_mode, so user/token text can't inject markup. */
function telegramText(payload) {
	const lines = [formatAlertSummary(payload)];
	if (payload.mint) {
		lines.push(`Mint: ${payload.mint}`);
		lines.push(`https://pump.fun/coin/${payload.mint}`);
	}
	return lines.join('\n').slice(0, 4000);
}

function errMsg(e) {
	return (e && (e.message || String(e))) ? String(e.message || e).slice(0, 200) : 'error';
}
