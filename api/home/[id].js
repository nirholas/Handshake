// /api/home/:id: one home, and the door that removes it.
//
//   GET     the connection record plus a live room graph snapshot
//   DELETE  disconnect: soft-delete the row and destroy the credential
//
// The GET deliberately answers even when the house is unreachable. A person
// opening their home page while their router is rebooting should see the home
// they connected, the reason it is not answering, and a way to retry, not a 502
// with no context. So the record always comes back at 200 and the graph is
// nullable, with `status` and `status_detail` carrying the truth. A route that
// 502s here would make the whole page an error page over a transient blip.
//
// The DELETE is idempotent by design and returns 200 both times. Disconnecting a
// home twice is not an error; it is a person clicking a button they were not
// sure had worked, and answering the second click with a 404 teaches them that
// the first one broke something.

import { requireCsrf } from '../_lib/csrf.js';
import { publicHome, resolveHomeAccess } from '../_lib/home/access.js';
import { homeError, toHomeFailure } from '../_lib/home/errors.js';
import { revokeConnection } from '../_lib/home/store.js';
import { closeHome, snapshot } from '../_lib/home/runtime.js';
import { cors, error, json, method, rateLimited, wrap } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'DELETE'])) return;

	const homeId = req.query?.id;
	const access = await resolveHomeAccess(req, res, homeId);
	if (!access.ok) return error(res, access.status, access.code, access.message);

	if (req.method === 'GET') return handleRead(req, res, access);
	return handleRevoke(req, res, access);
});

async function handleRead(req, res, { caller, home }) {
	const rl = await limits.homeRead(caller.userId);
	if (!rl.success) return rateLimited(res, rl, 'too many home reads, slow down');

	let live = null;
	let failure = null;
	try {
		live = await snapshot(home.id, caller.userId);
	} catch (err) {
		// The record is still the answer. Report why the graph is missing in the
		// same shape every other route uses, so a client has one error table.
		const shaped = toHomeFailure(err);
		if (shaped.unexpected) throw err;
		failure = { code: shaped.code, message: shaped.message, ...(shaped.detailCode ? { detail_code: shaped.detailCode } : {}) };
	}

	return json(res, 200, {
		home: publicHome(home),
		graph: live?.graph ?? null,
		connected: live?.connected ?? false,
		stale: live?.stale ?? true,
		live_status: live?.status ?? home.status,
		error: failure,
	});
}

async function handleRevoke(req, res, { caller, home }) {
	if (!(await requireCsrf(req, res, caller.userId))) return;

	const rl = await limits.homeConnect(caller.userId);
	if (!rl.success) return rateLimited(res, rl, 'too many connection changes, wait a moment');

	const result = await revokeConnection(home.id, caller.userId);
	// The row is gone and the ciphertext is scrubbed, but a socket this instance
	// opened earlier is already authenticated. Drop it so an open SSE stream stops
	// now rather than at the end of the idle window.
	closeHome(home.id);
	return json(res, 200, {
		revoked: true,
		// True on the first call, false on every one after it. The client renders
		// the same "disconnected" state either way; this is for a log.
		changed: result.revoked,
		home: publicHome(result.home ?? home),
	});
}
