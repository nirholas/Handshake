/**
 * Oracle — send a Telegram test alert to a personal chat.
 *
 *   POST /api/oracle/test-alert
 *   Body: { agent_id: uuid, chat_id: string }
 *
 * Verifies the caller owns the agent, then sends a test message to the
 * supplied Telegram chat ID so the user can confirm their setup is working
 * before they arm their agent and wait for a real signal.
 *
 * Auth: session cookie or bearer token. Rate-limited per IP by
 * limits.oracleTelegramTestIp (see api/_lib/rate-limit.js for the ceiling).
 */

import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { isUuid } from '../_lib/validate.js';

const CHAT_ID_RE = /^-?\d{1,20}$|^@[A-Za-z0-9_]{3,32}$/;

async function resolveUserId(req) {
	const session = await getSessionUser(req);
	if (session) return session.id;
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return bearer.userId;
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.oracleTelegramTestIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const userId = await resolveUserId(req);
	if (!userId) return error(res, 401, 'unauthorized', 'sign in to send a test alert');

	const body = await readJson(req).catch(() => null);
	const agentId = (body?.agent_id || '').trim();
	const chatId  = (body?.chat_id  || '').trim();

	if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'invalid agent_id');
	if (!CHAT_ID_RE.test(chatId)) return error(res, 400, 'validation_error', 'chat_id must be a numeric ID or @handle');

	// Verify ownership.
	const [agent] = await sql`
		select name from agent_identities
		where id = ${agentId} and user_id = ${userId} and deleted_at is null
		limit 1
	`.catch(() => []);
	if (!agent) return error(res, 403, 'forbidden', 'you do not own this agent');

	const token = process.env.TELEGRAM_BOT_TOKEN;
	if (!token) return error(res, 503, 'not_configured', 'Telegram bot is not configured on this deployment');

	const agentName = agent.name || 'Your agent';
	const text = [
		`🔮 <b>Oracle alerts are working</b>`,
		``,
		`<b>${agentName}</b> will send signals here when a coin crosses your conviction threshold.`,
		``,
		`<i>This is a test message from <a href="https://three.ws/oracle">three.ws Oracle</a>.</i>`,
	].join('\n');

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 5000);
	let tgOk = false;
	let tgErr = null;
	try {
		const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				chat_id: chatId,
				text,
				parse_mode: 'HTML',
				disable_web_page_preview: true,
			}),
			signal: ctrl.signal,
		});
		const result = await r.json().catch(() => null);
		tgOk = result?.ok === true;
		if (!tgOk) tgErr = result?.description || 'Telegram rejected the message';
	} catch (e) {
		tgErr = e?.name === 'AbortError' ? 'Telegram timed out' : (e?.message || 'network error');
	} finally {
		clearTimeout(timer);
	}

	if (!tgOk) {
		return json(res, 200, {
			ok: false,
			error: tgErr || 'could not deliver test message',
			hint: 'Make sure you started a chat with @three_ws_bot and sent /start first.',
		});
	}

	return json(res, 200, { ok: true, chat_id: chatId });
});
