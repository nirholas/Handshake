// POST /api/herald/announce: make your own avatar say something, from anywhere.
//
// This is the rail behind @three-ws/herald (herald-sdk/). Anything that can
// make an HTTPS request (a deploy script, a CI job, a cron, an AI agent holding
// an API key) posts a line here, and the browser tab the human is actually
// looking at hears it: the corner companion walks on, gestures, and says it.
//
//   curl -X POST https://three.ws/api/herald/announce \
//     -H "Authorization: Bearer sk_live_..." \
//     -H 'content-type: application/json' \
//     -d '{"text":"Deploy is green","importance":80,"url":"/dashboard"}'
//
// Addressing is the security model: a message is always delivered to the
// *authenticated caller's own* sessions. There is no `to` field, so no key can
// ever be used to interrupt somebody else, and a leaked key can annoy exactly
// one person: the person who leaked it. Revoke it at /dashboard/developers.
//
// Storage is a short-lived Redis list per user (no table, no migration, no
// retention question). GET /api/herald/stream drains it. A message nobody was
// online to hear expires on its own: this is a live channel, and the durable
// record of what happened to an account is the notification bell, not this.

import { z } from 'zod';
import { cors, error, json, method, rateLimited, readJson, wrap } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { limits } from '../_lib/rate-limit.js';
import { getRedis } from '../_lib/redis.js';
import { parse } from '../_lib/validate.js';
import { queueKey, QUEUE_TTL_SECONDS, QUEUE_CAP, normalizeAnnouncement } from '../_lib/herald.js';

const body = z.object({
	// `text` is the line. `message` is accepted as an alias because every
	// integrator's first guess is one or the other, and a 400 on a synonym is a
	// bad first minute with an API.
	text: z.string().trim().min(1).max(280).optional(),
	message: z.string().trim().min(1).max(280).optional(),
	from: z.string().trim().max(60).optional(),
	importance: z.coerce.number().int().min(0).max(100).optional(),
	url: z.string().trim().max(2048).optional(),
	tone: z.enum(['neutral', 'alert', 'celebrate', 'error']).optional(),
	emote: z.string().trim().max(40).optional(),
	key: z.string().trim().max(120).optional(),
	meta: z.record(z.unknown()).optional(),
});

async function resolveCaller(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, via: 'session' };
	const bearer = await authenticateBearer(extractBearer(req));
	// An API key needs the scope explicitly: a key minted for avatar reads must
	// not gain the ability to interrupt its owner because this route shipped.
	if (bearer && hasScope(bearer.scope, 'herald:announce')) {
		return { userId: bearer.userId, via: 'apikey' };
	}
	if (bearer) return { userId: null, via: 'insufficient_scope' };
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const caller = await resolveCaller(req);
	if (!caller) {
		return error(res, 401, 'unauthorized', 'sign in or send a key with the herald:announce scope');
	}
	if (!caller.userId) {
		return error(res, 403, 'insufficient_scope', 'this key is missing the herald:announce scope');
	}

	const rl = await limits.heraldAnnounce(caller.userId);
	if (!rl.success) return rateLimited(res, rl);

	const input = parse(body, await readJson(req));
	const text = input.text || input.message;
	if (!text) return error(res, 400, 'validation_error', 'text is required');

	const announcement = normalizeAnnouncement({ ...input, text });

	const redis = getRedis();
	if (!redis) {
		// No Redis configured is a deployment problem, not a caller problem, and
		// it must not read as "delivered".
		return error(res, 503, 'service_unavailable', 'the delivery rail is not available right now');
	}

	const key = queueKey(caller.userId);
	try {
		await redis.rpush(key, JSON.stringify(announcement));
		await redis.ltrim(key, -QUEUE_CAP, -1);
		await redis.expire(key, QUEUE_TTL_SECONDS);
	} catch (err) {
		console.error('[herald] queue write failed:', err.message);
		return error(res, 503, 'service_unavailable', 'could not queue the announcement');
	}

	// `queued` is honest: it says the line is waiting for a live surface, not
	// that a human heard it. Nothing here can promise the second thing.
	return json(res, 202, {
		queued: true,
		id: announcement.id,
		expires_in: QUEUE_TTL_SECONDS,
		announcement,
	});
});
