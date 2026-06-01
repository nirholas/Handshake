// /api/friends/messages
//   GET  ?with=<userId>&before=<msgId> — fetch a DM thread (oldest→newest) and
//        mark the other side's messages read. `before` paginates older history.
//   POST { to, body }                  — send a DM to a friend.
//
// DMs require an accepted friendship. They deliver live over the socket when the
// recipient is online and are always persisted so an offline recipient reads
// them on next login. If the recipient has muted the sender the message is
// silently dropped (Task 14). Rate-limited and length-capped like world chat.

import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { resolveAccount } from '../_lib/account-auth.js';
import { notifyMultiplayer } from '../_lib/presence-store.js';
import { areFriends, getThread, markThreadRead, sendDM } from '../_lib/friends-store.js';

const MAX_BODY_LEN = 2000;

function isUuid(v) {
	return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

// Strip control chars + collapse whitespace, matching the world-chat cleaner.
function clean(str, maxLen) {
	if (typeof str !== 'string') return '';
	return str.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, maxLen);
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const auth = await resolveAccount(req, res);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
	const me = auth.userId;

	if (req.method === 'GET') {
		const rl = await limits.publicIp(clientIp(req));
		if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

		const url = new URL(req.url, 'http://x');
		const other = url.searchParams.get('with');
		const beforeId = url.searchParams.get('before');
		if (!isUuid(other)) return error(res, 400, 'bad_target', 'invalid user id');
		if (beforeId && !isUuid(beforeId)) return error(res, 400, 'bad_cursor', 'invalid cursor');
		if (!(await areFriends(me, other))) {
			return error(res, 403, 'not_friends', 'you can only message friends');
		}

		const messages = await getThread(me, other, { beforeId });
		// Opening the thread reads it — clear unread on the first (non-paginated) load.
		if (!beforeId) await markThreadRead(me, other);
		return json(res, 200, { data: { messages } });
	}

	// POST — send a DM.
	const rl = await limits.dmSend(me);
	if (!rl.success) return error(res, 429, 'rate_limited', 'you are sending messages too fast');

	const payload = await readJson(req).catch(() => ({}));
	const to = payload.to;
	const body = clean(payload.body, MAX_BODY_LEN);
	if (!isUuid(to)) return error(res, 400, 'bad_target', 'invalid user id');
	if (!body) return error(res, 400, 'empty', 'message is empty');
	if (typeof payload.body === 'string' && payload.body.length > MAX_BODY_LEN) {
		return error(res, 400, 'too_long', `keep it under ${MAX_BODY_LEN} characters`);
	}
	if (!(await areFriends(me, to))) {
		return error(res, 403, 'not_friends', 'you can only message friends');
	}

	const message = await sendDM(me, to, body);
	if (!message) {
		// Recipient muted the sender — the message was suppressed. Report success
		// so the sender can't probe who has muted them, but don't deliver.
		return json(res, 200, { data: { message: null, suppressed: true } });
	}

	notifyMultiplayer('dm', to, { message });
	return json(res, 200, { data: { message } });
});
