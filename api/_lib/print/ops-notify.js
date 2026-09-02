// @ts-check
// The operator channel for Materialize fulfillment.
//
// The manual lane is a real print operation: a human takes a job off a queue,
// runs it through a bureau, and reports back. That only works if the human
// learns a job exists within minutes of it being paid for, so this module is
// part of the fulfillment path, not decoration around it.
//
// Three sinks, deliberately layered so no single missing credential silences
// the queue:
//
//   1. Telegram, to a PRIVATE ops chat (TELEGRAM_PRINT_OPS_CHAT_ID, falling
//      back to the existing TELEGRAM_ALERTS_CHAT_ID). Same bot token and the
//      same retrying sender the ops alerts already use. Never the public
//      changelog channel: these messages carry order ids.
//   2. The in-app bell, for every platform admin. This is what makes the
//      channel work on a deployment that has no dedicated ops chat id yet.
//   3. ops_alerts, via sendOpsAlert, but only for the things an operator must
//      act on (a stall). That table is the durable record when both of the
//      above are unconfigured.
//
// PII discipline: an ops message carries the order id, the material, and the
// destination COUNTRY. Never the recipient's name, street address, or phone.
// Those exist only inside the console, behind the operator gate.

import { sql } from './../db.js';
import { fetchUpstream } from './../upstream-fetch.js';
import { publishUserEvent } from './../feed.js';
import { sendOpsAlert } from './../alerts.js';
import { databaseConfigured } from './../env.js';

const CONSOLE_PATH = '/materialize/ops';

/** The private ops chat, or null when this deployment has none wired. */
function telegramConfig() {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	const chatId = process.env.TELEGRAM_PRINT_OPS_CHAT_ID || process.env.TELEGRAM_ALERTS_CHAT_ID;
	if (!token || !chatId) return null;
	return { token, chatId };
}

/** True when an operator would actually see a Telegram message right now. */
export function operatorChannelConfigured() {
	return telegramConfig() !== null;
}

/**
 * @param {{ token: string, chatId: string }} cfg
 * @param {string} text
 */
function post(cfg, text) {
	return fetchUpstream(
		`https://api.telegram.org/bot${cfg.token}/sendMessage`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				chat_id: cfg.chatId,
				text: text.slice(0, 4000),
				disable_web_page_preview: true,
			}),
			keepalive: true,
		},
		{ name: 'telegram:print-ops', timeoutMs: 5_000, attempts: 2 },
	).catch((err) => {
		console.warn(`[print-ops] telegram delivery failed after retries: ${err?.message || err}`);
	});
}

/** Every platform admin, for the in-app bell fan-out. */
async function adminUserIds() {
	if (!databaseConfigured()) return [];
	try {
		const rows = await sql`select id from users where is_admin = true limit 50`;
		return rows.map((r) => r.id);
	} catch (err) {
		console.warn(`[print-ops] admin lookup failed: ${err?.message || err}`);
		return [];
	}
}

/**
 * Notify the operators. Fire-and-forget by contract: a fulfillment transition
 * must never fail because a chat was unreachable.
 *
 * @param {object} input
 * @param {string} input.title    one line, e.g. "New print job ready to submit"
 * @param {string[]} [input.lines] body lines, already PII-scrubbed by the caller
 * @param {string} [input.orderId]
 * @param {boolean} [input.alert] also record to ops_alerts (use for stalls)
 */
export async function notifyOperators({ title, lines = [], orderId = '', alert = false }) {
	const link = orderId ? `https://three.ws${CONSOLE_PATH}?order=${orderId}` : `https://three.ws${CONSOLE_PATH}`;
	const body = [...lines, link].filter(Boolean).join('\n');

	const cfg = telegramConfig();
	if (cfg) post(cfg, `🖨 ${title}\n${body}`);

	for (const userId of await adminUserIds()) {
		publishUserEvent(userId, {
			type: 'print',
			status: 'operator',
			order_id: orderId || null,
			message: title,
			link: orderId ? `${CONSOLE_PATH}?order=${orderId}` : CONSOLE_PATH,
		});
	}

	if (alert) {
		// A per-order signature: the alert dedup exists to coalesce a storm of the
		// same fault, and two different stalled orders are not the same fault.
		await sendOpsAlert(title, body, { signature: `print-ops:${orderId || title}`, severity: 'warn' }).catch(() => {});
	}
}

/**
 * The message a newly submitted manual job produces. Kept here rather than in
 * the adapter so every ops line has one shape and one PII review surface.
 * @param {object} order
 */
export function jobSummaryLines(order) {
	const qty = Number(order?.quantity) || 1;
	const country = order?.shipping?.country || 'unknown';
	const height = order?.target_height_mm ? `${order.target_height_mm} mm tall` : 'height per quote';
	return [
		`Order ${String(order?.id || '').slice(0, 8)} · ${order?.material_id || 'material tbd'} · ${qty}x · ${height}`,
		`Ship to ${country} · ${Number(order?.price_usdc || 0).toFixed(2)} USDC`,
	];
}
