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
import { filterGraphForScope, publicHome, resolveHomeAccess } from '../_lib/home/access.js';
import { homeError, toHomeFailure } from '../_lib/home/errors.js';
import { getConnection, revokeConnection } from '../_lib/home/store.js';
import { revokeAtRelay } from '../_lib/home/relay.js';
import { closeHome, snapshot } from '../_lib/home/runtime.js';
import { cors, error, json, method, rateLimited, wrap } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'DELETE'])) return;

	const homeId = req.query?.id;
	// GET is a read; DELETE takes the house off the platform, which is the one
	// thing an admin may not do.
	const access = await resolveHomeAccess(req, res, homeId, req.method === 'DELETE' ? 'disconnect' : 'read');
	if (!access.ok) {
		// Disconnecting is idempotent, and a home that is ALREADY disconnected is
		// the state the caller asked for. Reads keep answering 404 for a revoked
		// home (it is off the platform), but answering the second click of a
		// Disconnect button with a 404 teaches a person that the first one broke
		// something. Ownership is still a WHERE clause: the lookup below is the
		// same household-joined query, it simply does not filter out revoked rows.
		if (req.method === 'DELETE' && access.status === 404) {
			const alreadyGone = homeId ? await getConnection(homeId, access.caller?.userId, { includeRevoked: true }) : null;
			if (alreadyGone?.revoked_at) {
				return json(res, 200, { revoked: true, changed: false, home: publicHome(alreadyGone) });
			}
		}
		return error(res, access.status, access.code, access.message);
	}

	if (req.method === 'GET') return handleRead(req, res, access);
	return handleRevoke(req, res, access);
});

async function handleRead(req, res, { caller, home, scope }) {
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
		role: home.role,
		// Filtered before serialization, never in the client. A guest given the
		// kitchen receives a house with one room in it; the rooms they were not
		// given do not reach the wire at all, names included, because a room whose
		// name arrived in a browser has been disclosed no matter what the browser
		// then chooses to draw.
		graph: live?.graph ? filterGraphForScope(live.graph, scope) : null,
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
	// A relayed home has a second, longer-lived socket: the one the house itself
	// opened outward to the relay. Revocation has to be both-ended or "I
	// disconnected my home" would leave that tunnel standing until its next
	// heartbeat. This is push, not poll, and it is deliberately not awaited into
	// the failure path: the database row already gates every session, so a relay
	// that is briefly unreachable must not make disconnecting fail.
	const relayDrop = home.transport === 'relay' && home.relay_id ? await revokeAtRelay(home.relay_id) : null;
	if (relayDrop && !relayDrop.ok) {
		console.warn(`[home] relay revoke for ${home.relay_id} did not land: ${relayDrop.detail}`);
	}
	return json(res, 200, {
		revoked: true,
		// Whether the house's own outbound socket was dropped at the relay, so an
		// operator reading a log can tell "revoked and the tunnel is down" from
		// "revoked, and the relay did not answer when we told it".
		...(relayDrop ? { relay_dropped: Boolean(relayDrop.ok) } : {}),
		// True on the first call, false on every one after it. The client renders
		// the same "disconnected" state either way; this is for a log.
		changed: result.revoked,
		home: publicHome(result.home ?? home),
	});
}
