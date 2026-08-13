// POST /api/internal/quest-notify, the multiplayer server to API bridge for
// quest/mission notifications. WalkRoom already publishes a public
// 'mission-complete' ticker event (api/_lib/feed.js) when a player finishes a
// /play job or co-op heist, but that ticker is anonymous-by-design (world-
// readable) and carries no per-user id. This endpoint is the missing link: the
// authoritative Colyseus process (which verified the player's presence ticket
// on join) reports the SAME completion here, scoped to the player's real
// account id, so it lands in their bell inbox.
//
// Trust model mirrors api/world/[action].js save: only a request bearing a
// valid world-service token (signed by multiplayer/src/persistence.js's
// signServiceToken, svc:'world') is accepted, a browser can't forge a quest
// completion for another account.
//
// The insert is awaited, not fired and forgotten: writing the bell row IS this
// endpoint's whole job, so answering 200 before the write resolves would let the
// game server log a delivery that never happened. The response carries the row id
// (null when the player has muted this category, or when the insert failed and
// notify.js swallowed it), so the caller can tell the two outcomes apart.

import { json, method, wrap, error, readJson, cors } from '../_lib/http.js';
import { extractBearer } from '../_lib/auth.js';
import { verifyWorldServiceToken } from '../_lib/world-service-auth.js';
import { insertNotification } from '../_lib/notify.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default wrap(async (req, res) => {
	// Server-to-server only, no browser origin ever calls this directly.
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['POST'])) return;

	const service = await verifyWorldServiceToken(extractBearer(req));
	if (!service) return error(res, 401, 'unauthorized', 'valid world service token required');

	let body;
	try {
		body = await readJson(req, 4096);
	} catch (err) {
		return error(res, err.status || 400, 'validation_error', err.message || 'invalid body');
	}

	const accountUid = typeof body?.accountUid === 'string' ? body.accountUid.trim() : '';
	if (!UUID_RE.test(accountUid)) return error(res, 400, 'validation_error', 'accountUid must be a user id');

	const mission = typeof body?.mission === 'string' ? body.mission.slice(0, 120) : null;
	const gold = Number.isFinite(body?.gold) ? Math.max(0, Math.round(body.gold)) : null;
	const coop = !!body?.coop;
	const coin = typeof body?.coin === 'string' ? body.coin.slice(0, 32) : null;

	const delivery = await insertNotification(accountUid, 'quest_complete', {
		mission,
		gold,
		coop,
		coin,
		link: '/play',
	});

	return json(res, 200, { ok: true, id: delivery.id ?? null });
});
