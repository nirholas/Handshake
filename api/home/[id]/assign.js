// /api/home/:id/assign: file an entity into a room, in Home Assistant itself.
//
//   POST { entityId, areaId }   areaId null unfiles it
//
// This is the floorplan editor's payload and the reason that editor is worth
// building. Dragging a stray device into a room does not decorate our picture of
// the house; it writes the area into the user's own Home Assistant registry, so
// their dashboards, their voice assistant and their automations all gain the
// same organisation. The work leaves with them even if they never open three.ws
// again.
//
// It is not a guarded action. Nothing moves, nothing opens, and the change is
// two clicks to reverse in their own UI. It is still a write to their house, so
// it needs the `layout` capability, a CSRF token, and a row in the action log.

import { logAudit } from '../../_lib/audit.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { resolveHomeAccess } from '../../_lib/home/access.js';
import { homeError, notFound } from '../../_lib/home/errors.js';
import { entityInScope } from '../../_lib/home/members.js';
import { snapshot, withHome } from '../../_lib/home/runtime.js';
import { logHomeAction } from '../../_lib/home/store.js';
import { cors, error, json, method, rateLimited, readJson, wrap } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';

/** Home Assistant entity id: domain.object_id, both lower snake case. */
const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;
/** Area ids are slugs Home Assistant generates from the area name. */
const AREA_RE = /^[a-z0-9_]{1,128}$/;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const access = await resolveHomeAccess(req, res, req.query?.id, 'layout');
	if (!access.ok) return error(res, access.status, access.code, access.message);
	const { caller, home, scope, scoped } = access;

	if (!requireCsrf(req, res)) return;

	const rl = await limits.homeAct(caller.userId);
	if (!rl.success) return rateLimited(res, rl, 'too many home writes, slow down');

	const body = await readJson(req, res);
	if (body === undefined) return;

	const entityId = typeof body?.entityId === 'string' ? body.entityId.trim() : '';
	if (!ENTITY_RE.test(entityId)) {
		return error(res, 400, 'entity_invalid', 'entityId must look like light.kitchen_lights.');
	}

	// null and '' both mean "take it out of every room", which is a real thing a
	// user does when they mis-filed something. undefined does not: a caller that
	// forgot the field is a bug, not an unfiling.
	const raw = body?.areaId;
	if (raw === undefined) {
		return error(res, 400, 'area_invalid', 'Send an areaId, or null to take this device out of every room.');
	}
	const areaId = raw === null || raw === '' ? null : String(raw).trim();
	if (areaId !== null && !AREA_RE.test(areaId)) {
		return error(res, 400, 'area_invalid', 'areaId must be a Home Assistant area id.');
	}

	// A scoped member cannot file a device they are not allowed to see, and
	// cannot file one INTO a room they are not allowed to see. Without both
	// halves, a scoped member with the layout capability could map the whole
	// house one rejected assignment at a time, and could move a device out of
	// their own scope where they could no longer undo it.
	//
	// Scope is evaluated against the entity's CURRENT area, read from the live
	// graph, because an area-mode scope grants rooms rather than devices and
	// membership of a room is a property of the house.
	if (scoped) {
		let currentArea = null;
		let known = false;
		try {
			const graph = await snapshot(home.id, caller.userId);
			for (const room of graph.rooms || []) {
				if (room.entities?.some((e) => e.entityId === entityId)) {
					currentArea = room.id;
					known = true;
					break;
				}
			}
			if (!known) known = (graph.unassigned || []).some((e) => e.entityId === entityId);
		} catch {
			// An unreachable house cannot prove scope, and a scoped member must not
			// be granted a write on the strength of an unanswered question.
			return homeError(res, notFound('device'));
		}
		if (!known) return homeError(res, notFound('device'));
		if (!entityInScope(scope, { entityId, areaId: currentArea })) return homeError(res, notFound('device'));
		if (areaId && !entityInScope(scope, { entityId, areaId })) {
			return homeError(res, notFound('room'));
		}
	}

	try {
		const result = await withHome(home.id, caller.userId, (bridge) => bridge.assignEntityArea(entityId, areaId));
		logHomeAction({
			homeId: home.id,
			userId: caller.userId,
			actor: 'user',
			channel: 'websocket',
			action: 'entity_registry.assign_area',
			entityIds: [entityId],
			guarded: false,
			outcome: 'ok',
			detail: { areaId },
		});
		logAudit({ userId: caller.userId, action: 'assign_home_entity_area', resourceId: home.id, meta: { entityId, areaId }, req });
		return json(res, 200, { ok: true, ...result });
	} catch (err) {
		logHomeAction({
			homeId: home.id,
			userId: caller.userId,
			actor: 'user',
			channel: 'websocket',
			action: 'entity_registry.assign_area',
			entityIds: [entityId],
			guarded: false,
			outcome: 'failed',
			detail: { areaId, reason: err?.code || 'error' },
		});
		return homeError(res, err);
	}
});
