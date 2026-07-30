// POST /api/webhooks/gcp-budget-alert
//
// Receives Cloud Billing budget notifications (Pub/Sub push) and turns each
// threshold crossing into a Telegram ops ping via sendOpsAlert — the same path
// the changelog bot uses, but the PRIVATE ops chat (TELEGRAM_ALERTS_CHAT_ID),
// never the holders' channel. This is how the $100k credit program (see
// prompts/gcp-credits/ and docs/ops/gcp-credits.md) surfaces a runaway lane BEFORE
// it drains the grant: scripts/gcp/create-budgets.mjs registers budgets at
// 25/50/75/90/100% pointing at a Pub/Sub topic; that topic pushes here.
//
// Pub/Sub push envelope (JSON body):
//   { message: { data: <base64>, attributes, messageId, publishTime }, subscription }
// The base64 `data` decodes to the budget notification JSON:
//   { budgetDisplayName, alertThresholdExceeded, costAmount, budgetAmount,
//     currencyCode, costIntervalStart }
//
// Auth: Pub/Sub push can't carry a session, so the subscription is created with
// a shared secret in the endpoint query string (?token=…). We constant-time
// compare it against GCP_BUDGET_WEBHOOK_SECRET. Without the secret set, the
// endpoint refuses (503) rather than accepting unauthenticated pings.
//
// Always ACK (200) once authenticated — even on a malformed message — so Pub/Sub
// doesn't redeliver in a retry storm. Parse/alert failures are logged, not 5xx'd.

import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { sendOpsAlert } from '../_lib/alerts.js';

function presentedToken(req) {
	// Accept the secret from the query string (how GCP push subscriptions attach
	// it) or an x-webhook-token header (for manual/curl testing).
	try {
		const url = new URL(req.url, 'http://localhost');
		const q = url.searchParams.get('token');
		if (q) return q;
	} catch { /* fall through */ }
	const h = req.headers['x-webhook-token'];
	return Array.isArray(h) ? h[0] : h || '';
}

function decodeNotification(body) {
	const data = body?.message?.data;
	if (!data || typeof data !== 'string') return null;
	try {
		return JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
	} catch {
		return null;
	}
}

function fmtUsd(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return '—';
	return `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const secret = process.env.GCP_BUDGET_WEBHOOK_SECRET;
	if (!secret) return error(res, 503, 'not_configured', 'GCP_BUDGET_WEBHOOK_SECRET unset');
	if (!constantTimeEquals(presentedToken(req), secret)) {
		return error(res, 401, 'unauthorized', 'invalid webhook token');
	}

	let body;
	try {
		body = await readJson(req);
	} catch {
		// Malformed JSON — ack so Pub/Sub stops retrying, but say we couldn't parse.
		return json(res, 200, { ok: true, parsed: false });
	}

	const note = decodeNotification(body);
	if (!note) {
		// A subscription-verification ping or an attributes-only message: ack.
		return json(res, 200, { ok: true, parsed: false });
	}

	const cost = Number(note.costAmount);
	const budget = Number(note.budgetAmount);
	const pct = budget > 0 ? cost / budget : null;
	const threshold = Number(note.alertThresholdExceeded); // e.g. 0.9 — absent on info pings

	// Only ping on an actual threshold crossing. Budget notifications also fire
	// as periodic info messages with no alertThresholdExceeded — those would be
	// noise in the ops channel.
	if (!Number.isFinite(threshold)) {
		return json(res, 200, { ok: true, alerted: false, reason: 'no_threshold' });
	}

	const name = note.budgetDisplayName || 'GCP budget';
	const pctStr = pct != null ? `${Math.round(pct * 100)}%` : '—';
	const emoji = threshold >= 0.9 ? '🔴' : threshold >= 0.75 ? '🟠' : '🟡';

	await sendOpsAlert(
		`${emoji} GCP budget ${Math.round(threshold * 100)}% — ${name}`,
		[
			`Spend ${fmtUsd(cost)} of ${fmtUsd(budget)} (${pctStr}) ${note.currencyCode || 'USD'}`,
			threshold >= 0.9 ? 'Runaway risk — check `node scripts/gcp/burn-report.mjs`, consider scripts/gcp/emergency-stop.sh.' : 'Burn-down tracking on schedule; review the spend dashboard (/dashboard/spend).',
		].join('\n'),
		// Dedup per budget + threshold so each crossing pings once/hour, not each
		// time the budget re-evaluates within the window.
		{ signature: `gcp-budget:${name}:${threshold}` },
	);

	return json(res, 200, { ok: true, alerted: true, threshold, pct });
});
