// POST /api/companion/events/:id/reply  { text }
//
// The other half of a delivery. The companion brings you a message; answering it
// should not mean going to find the app. This routes an answer back through the
// same connection the message arrived on, quoting the original so it lands as a
// reply rather than a stray line in a chat.
//
// Only lanes whose protocol can carry an answer offer this (today: Telegram,
// through the user's own bot). A calendar feed is read only, and answering mail
// would need SMTP credentials this feature deliberately never asks for, so both
// are refused with a message that says which lane could not do it.

import { z } from 'zod';
import { getRequestUser } from '../../../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../../../_lib/http.js';
import { requireCsrf } from '../../../_lib/csrf.js';
import { limits } from '../../../_lib/rate-limit.js';
import { parse } from '../../../_lib/validate.js';
import { getReplyTarget, recordReply } from '../../../_lib/companion/store.js';
import { laneFor } from '../../../_lib/companion/poll.js';

const replyBody = z.object({
	text: z.string().min(1).max(4000),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getRequestUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	if (!(await requireCsrf(req, res, user.id))) return;

	// A reply opens a connection to the user's own provider, so it shares the
	// bucket with "check now" rather than the cheap read bucket.
	const rl = await limits.companionPoll(user.id);
	if (!rl.success) return rateLimited(res, rl);

	const id = String(req.query?.id || '').trim();
	if (!/^[0-9a-f-]{36}$/i.test(id)) return error(res, 400, 'validation_error', 'invalid event id');

	const { text } = parse(replyBody, await readJson(req));

	const target = await getReplyTarget(user.id, id);
	if (!target) return error(res, 404, 'not_found', 'no such message');
	if (!target.reply_to) {
		return error(res, 400, 'not_repliable', `a ${target.source_kind} message has nothing to reply to`);
	}
	if (!target.config) {
		return error(res, 409, 'source_disconnected', 'the connection this message came from has been disconnected');
	}

	const lane = laneFor(target.source_kind_actual || target.source_kind);
	if (!lane?.reply) {
		return error(res, 400, 'not_repliable', `the ${target.source_kind} lane cannot send a reply`);
	}

	try {
		const sent = await lane.reply(target.config, target.reply_to, text);
		const row = await recordReply(user.id, id, text);
		return json(res, 200, { sent: true, to: sent.chat || target.sender || null, event: row });
	} catch (err) {
		// The provider's own words are the useful ones here ("bot was blocked by
		// the user", "chat not found"), so they are passed through rather than
		// flattened into a generic failure.
		return error(res, 502, 'reply_failed', String(err?.message || err).slice(0, 300));
	}
});
