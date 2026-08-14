/**
 * Oracle: agent follower subscriptions (the Watch tier of social copy-trading).
 *
 *   GET    /api/oracle/follow?agent_id=<uuid>&chat_id=<telegram>&network=mainnet
 *          → { following: bool, min_score: int|null }
 *
 *   POST   /api/oracle/follow  { agent_id, chat_id, min_score? }
 *          → { ok: true, action: 'subscribed'|'updated' }
 *          Idempotent: posting again updates min_score on an existing row.
 *
 *   DELETE /api/oracle/follow  { agent_id, chat_id }
 *          → { ok: true }
 *
 * No auth required: the Telegram chat_id is the caller-supplied identity.
 * Rate-limited per IP and per (agent_id, chat_id) pair to prevent spam.
 *
 * How the signals are delivered: when an armed Oracle agent makes a conviction
 * buy (in `workers/oracle/agent-loop.js`), the agent-loop calls
 * `alertFollowers()` (api/_lib/oracle/alerts.js) which fans out a Telegram
 * message to every follower subscribed to that agent above their min_score.
 */

import { cors, json, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql, isDbUnavailableError } from '../_lib/db.js';
import { isUuid } from '../_lib/validate.js';

const NETWORKS = new Set(['mainnet', 'devnet']);

// Every read here is a subscription FACT the caller acts on: "am I following?",
// "does this agent exist?", "did my unsubscribe land?". A blanket `.catch()`
// turned a database outage into a confident wrong answer for all three: the GET
// reported `following: false` to a subscriber who was in fact subscribed, the
// POST reported `agent not found` for an agent that plainly exists, and the
// DELETE reported `{ ok: true }` while the row survived, so the caller believed
// they had unsubscribed and kept receiving Telegram alerts with no way to stop
// them. Rethrowing a connectivity failure hands it to wrap(), which answers the
// shared 503 + Retry-After that tells the caller to try again. A genuine
// statement-level fault still degrades to the empty result the callers expect.
function orRethrowIfDbDown(fallback) {
	return (err) => {
		if (isDbUnavailableError(err)) throw err;
		return fallback;
	};
}
const CHAT_ID_RE = /^-?\d{1,20}$|^@[a-zA-Z0-9_]{5,32}$/;
function validateChatId(v) {
	return typeof v === 'string' && CHAT_ID_RE.test(v.trim());
}

// JSON bodies are caller-controlled, so a field can arrive as any type. `(v ||
// '').trim()` blows up on a number or a boolean (`(123).trim is not a function`),
// which wrap() turns into a 500 for what is plainly a 400: posting
// {"agent_id": 12345} answered internal_error. Reduce every field to a string
// here and let the validators below reject it with the right status.
function asTrimmedString(v) {
	return typeof v === 'string' ? v.trim() : '';
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,DELETE,OPTIONS', origins: '*' })) return;
	const ip = clientIp(req);

	// ── GET: check follow status ────────────────────────────────────────────
	// Branch on req.method directly: the shared method() helper writes a 405 and
	// ends the response on the first mismatch, so calling it per-branch (GET first)
	// would 405 every POST/DELETE before its branch was reached. A single trailing
	// 405 below covers unsupported verbs.
	if (req.method === 'GET' || req.method === 'HEAD') {
		const rl = await limits.publicIp(ip);
		if (!rl.success) return rateLimited(res, rl);

		const params  = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
		const agentId = params.get('agent_id') || '';
		const chatId  = (params.get('chat_id') || '').trim();
		const network = NETWORKS.has(params.get('network')) ? params.get('network') : 'mainnet';

		if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'agent_id must be a UUID');
		if (!validateChatId(chatId)) return error(res, 400, 'validation_error', 'chat_id must be a numeric ID or @handle');

		const rows = await sql`
			select min_score from oracle_followers
			where agent_id = ${agentId} and chat_id = ${chatId} and network = ${network}
			limit 1
		`.catch(orRethrowIfDbDown([]));

		return json(res, 200, {
			following:  rows.length > 0,
			min_score:  rows.length > 0 ? Number(rows[0].min_score) : null,
		});
	}

	// ── POST: subscribe or update ───────────────────────────────────────────
	if (req.method === 'POST') {
		const rl = await limits.oracleFollowIp(ip);
		if (!rl.success) return rateLimited(res, rl);

		const body = await readJson(req).catch(() => null);
		if (!body) return error(res, 400, 'invalid_json', 'request body must be valid JSON');

		const agentId  = asTrimmedString(body.agent_id);
		const chatId   = asTrimmedString(body.chat_id);
		const network  = NETWORKS.has(body.network) ? body.network : 'mainnet';
		const minScore = Math.min(100, Math.max(0, Number(body.min_score ?? 54) || 54));

		if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'agent_id must be a UUID');
		if (!validateChatId(chatId)) return error(res, 400, 'validation_error', 'chat_id must be a numeric Telegram ID or @handle');

		// Ensure the agent exists (guard against phantom subscriptions)
		const agentRows = await sql`
			select id from agent_identities where id = ${agentId} and deleted_at is null limit 1
		`.catch(orRethrowIfDbDown([]));
		if (!agentRows.length) return error(res, 404, 'not_found', 'agent not found');

		const existing = await sql`
			select id from oracle_followers
			where agent_id = ${agentId} and chat_id = ${chatId} and network = ${network}
			limit 1
		`.catch(orRethrowIfDbDown([]));

		if (existing.length) {
			await sql`
				update oracle_followers
				set min_score = ${minScore}
				where agent_id = ${agentId} and chat_id = ${chatId} and network = ${network}
			`;
			return json(res, 200, { ok: true, action: 'updated', min_score: minScore });
		}

		await sql`
			insert into oracle_followers (agent_id, chat_id, network, min_score)
			values (${agentId}, ${chatId}, ${network}, ${minScore})
			on conflict (agent_id, chat_id, network) do update set min_score = excluded.min_score
		`;
		return json(res, 201, { ok: true, action: 'subscribed', min_score: minScore });
	}

	// ── DELETE: unsubscribe ─────────────────────────────────────────────────
	if (req.method === 'DELETE') {
		const rl = await limits.publicIp(ip);
		if (!rl.success) return rateLimited(res, rl);

		const body = await readJson(req).catch(() => null);
		if (!body) return error(res, 400, 'invalid_json', 'request body must be valid JSON');

		const agentId = asTrimmedString(body.agent_id);
		const chatId  = asTrimmedString(body.chat_id);
		const network = NETWORKS.has(body.network) ? body.network : 'mainnet';

		if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'agent_id must be a UUID');
		if (!validateChatId(chatId)) return error(res, 400, 'validation_error', 'chat_id must be a numeric Telegram ID or @handle');

		// No `.catch()` swallow: this statement IS the response. Reporting
		// `{ ok: true }` on a delete that never ran leaves the follower subscribed
		// and still receiving alerts while believing they opted out. Let wrap()
		// answer 503 (outage) or 500 (real fault) so the caller can retry.
		await sql`
			delete from oracle_followers
			where agent_id = ${agentId} and chat_id = ${chatId} and network = ${network}
		`;

		return json(res, 200, { ok: true });
	}

	error(res, 405, 'method_not_allowed', 'GET, POST or DELETE required');
});
