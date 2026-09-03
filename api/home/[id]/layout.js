// /api/home/:id/layout: the authored floorplan for one house.
//
//   GET     the current layout, its version, and what has drifted from the house
//   PUT     write a layout, refusing a stale write with 409 and the current one
//   DELETE  drop it, so the scene returns to the default arrangement
//
// Home Assistant has no geometry, so the arrangement of rooms in the 3D scene is
// either the default grid or something a person drew. This route owns the second
// one. It is never required: no row here is an ordinary state, and the scene
// renders the default grid without it.
//
// Two members can edit the same house. `version` is the whole concurrency story:
// a PUT names the version it loaded, a mismatch is refused with the current
// document attached, and the editor asks the user rather than silently
// discarding somebody's afternoon. Last-write-wins on a timestamp was rejected
// because clock skew between two browsers is real and the loser of a millisecond
// should not lose their work.

import { logAudit } from '../../_lib/audit.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { resolveHomeAccess } from '../../_lib/home/access.js';
import { deleteLayout, getLayout, LayoutInvalid, putLayout, reconcileLayout } from '../../_lib/home/layout.js';
import { snapshot } from '../../_lib/home/runtime.js';
import { cors, error, json, method, rateLimited, readJson, wrap } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,PUT,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'PUT', 'DELETE'])) return;

	// Reading the plan is a read; drawing it is the `layout` capability, which a
	// guest and a viewer do not hold. A house sitter should see where the rooms
	// are and should not be able to redraw somebody's home.
	const access = await resolveHomeAccess(req, res, req.query?.id, req.method === 'GET' ? 'read' : 'layout');
	if (!access.ok) return error(res, access.status, access.code, access.message);
	const { caller, home } = access;

	if (req.method === 'GET') {
		const rl = await limits.homeRead(caller.userId);
		if (!rl.success) return rateLimited(res, rl, 'too many home reads, slow down');
		return json(res, 200, await describe(home.id, caller.userId));
	}

	if (!requireCsrf(req, res)) return;

	if (req.method === 'DELETE') {
		const removed = await deleteLayout(home.id);
		if (removed) {
			logAudit({ userId: caller.userId, action: 'delete_home_layout', resourceId: home.id, req });
		}
		return json(res, 200, { removed, ...(await describe(home.id, caller.userId)) });
	}

	const rl = await limits.homeAct(caller.userId);
	if (!rl.success) return rateLimited(res, rl, 'too many layout writes, slow down');

	const body = await readJson(req, res);
	if (body === undefined) return;

	// A caller that omits the version is not "starting fresh", it is a caller
	// that has not read the concurrency contract. Saying so beats letting it
	// overwrite whatever is there.
	if (body?.version == null) {
		return error(res, 400, 'version_required', 'Send the version you loaded, or 0 to create the first layout.');
	}
	const expected = Number(body.version);
	if (!Number.isInteger(expected) || expected < 0) {
		return error(res, 400, 'version_required', 'version must be a whole number, 0 or greater.');
	}

	let result;
	try {
		result = await putLayout({
			homeId: home.id,
			layout: body.layout,
			updatedBy: caller.userId,
			expectedVersion: expected,
		});
	} catch (err) {
		if (err instanceof LayoutInvalid) {
			return error(res, 400, 'layout_invalid', err.message, { field: err.field });
		}
		throw err;
	}

	if (!result.ok) {
		// 409 with the current document, so the client can offer keep-mine,
		// take-theirs or a side-by-side rather than a bare failure.
		return json(res, 409, {
			error: 'Someone else changed this floorplan while you were drawing.',
			code: 'layout_conflict',
			current: result.current,
			...(await drift(home.id, caller.userId, result.current?.layout)),
		});
	}

	logAudit({ userId: caller.userId, action: 'write_home_layout', resourceId: home.id, meta: { version: result.version, rooms: Object.keys(result.layout.rooms).length }, req });
	return json(res, 200, { version: result.version, layout: result.layout, ...(await drift(home.id, caller.userId, result.layout)) });
});

/** The stored layout plus what has drifted from the live house. */
async function describe(homeId, userId) {
	const stored = await getLayout(homeId);
	return {
		version: stored?.version ?? 0,
		layout: stored?.layout ?? null,
		updatedAt: stored?.updatedAt ?? null,
		// A document this server would now refuse to store is reported rather
		// than thrown: one bad row degrades to the default arrangement instead of
		// taking the page down.
		unreadable: stored?.unreadable ?? null,
		...(await drift(homeId, userId, stored?.layout)),
	};
}

/**
 * Which placed rooms the house no longer has, and which house rooms nobody has
 * placed. Both are ordinary, and the editor shows each of them.
 *
 * The graph read is best effort: a floorplan must stay editable while the house
 * itself is unreachable, so a failure here reports no drift rather than failing
 * the request.
 */
async function drift(homeId, userId, layoutDoc) {
	if (!layoutDoc) return { orphaned: [], unplaced: [], driftKnown: false };
	try {
		const graph = await snapshot(homeId, userId);
		const { orphaned, unplaced } = reconcileLayout(layoutDoc, graph);
		return { orphaned, unplaced, driftKnown: true };
	} catch {
		return { orphaned: [], unplaced: [], driftKnown: false };
	}
}
