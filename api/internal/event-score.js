// POST /api/internal/event-score, the multiplayer server → API bridge for the live
// event leaderboard.
//
// When a player finishes one of the event quest line's jobs (multiplayer/src/
// quests.js, `event: true`), the authoritative Colyseus room reports it here. Only
// completions that the room's own quest engine granted ever reach this endpoint, and
// only inside the event window that the room re-derives server-side, a client can
// neither claim a run nor forge one for another player.
//
// Trust model mirrors api/internal/quest-notify.js: a valid world-service token
// (signed by multiplayer/src/persistence.js, svc:'world') is required, so a browser
// cannot POST a score. The endpoint additionally refuses any event id that is not
// the currently configured event, and any run reported outside that event's window,
// so even a leaked token cannot stuff a board for an event that is not running.
//
// The response echoes the player's updated row: the room forwards it to the client
// so a completion toast can say "that's your 4th run" without a second read.

import { json, method, wrap, error, readJson, cors } from '../_lib/http.js';
import { extractBearer } from '../_lib/auth.js';
import { verifyWorldServiceToken } from '../_lib/world-service-auth.js';
import { eventConfig } from '../_lib/event-config.js';
import { recordEventRun, isValidAccount } from '../_lib/event-leaderboard-store.js';
import { isEventLive } from '../../multiplayer/src/event-window.js';
import { isEventMission } from '../../multiplayer/src/quests.js';

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

	const now = Date.now();
	const event = eventConfig(now);
	if (!event) return error(res, 409, 'no_event', 'no event is configured');

	const eventId = typeof body?.eventId === 'string' ? body.eventId.trim() : '';
	if (eventId && eventId !== event.id) {
		return error(res, 409, 'event_mismatch', 'reported event is not the configured event');
	}
	if (!isEventLive(event, now)) {
		return error(res, 409, 'event_closed', 'the event window is not open');
	}

	const account = typeof body?.account === 'string' ? body.account.trim() : '';
	if (!isValidAccount(account)) return error(res, 400, 'validation_error', 'account required');

	const missionId = typeof body?.missionId === 'string' ? body.missionId.slice(0, 64) : '';
	if (!isEventMission(missionId)) {
		return error(res, 400, 'validation_error', 'missionId must be an event mission');
	}

	const name = typeof body?.name === 'string' ? body.name.slice(0, 24) : '';
	const gold = Number.isFinite(body?.gold) ? Math.max(0, Math.round(body.gold)) : 0;

	const { record, durable } = await recordEventRun({
		eventId: event.id,
		account,
		name,
		missionId,
		gold,
		at: now,
	});

	return json(res, 200, {
		ok: true,
		durable,
		eventId: event.id,
		runs: record.runs,
		cash: record.cash,
	});
});
