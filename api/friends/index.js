// /api/friends
//   GET  — the caller's whole social graph: accepted friends (with live presence
//          + unread DM counts), incoming requests, outgoing requests.
//   POST — graph mutations via { action, ... }:
//            request  { to }            send a friend request (auto-accepts a reciprocal one)
//            accept   { userId }        accept an incoming request
//            decline  { userId }        decline an incoming request
//            remove   { userId }        remove a friend / cancel an outgoing request
//            mute     { userId }        mute an account (suppress their DMs)
//            unmute   { userId }        unmute an account
//
// Validates the caller owns the account (session or bearer). Guards self-add,
// duplicates, and unknown targets in the store layer; rate-limited per account.

import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { resolveAccount } from '../_lib/account-auth.js';
import { readPresence, notifyMultiplayer } from '../_lib/presence-store.js';
import {
	listGraph,
	sendRequest,
	acceptRequest,
	declineRequest,
	removeFriend,
	muteUser,
	unmuteUser,
} from '../_lib/friends-store.js';

function isUuid(v) {
	return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
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
		return json(res, 200, { data: await graphWithPresence(me) });
	}

	// POST — a graph mutation. Tighter limit: 60 actions/min per account.
	const rl = await limits.chatUser(me);
	if (!rl.success) return error(res, 429, 'rate_limited', 'slow down');

	const body = await readJson(req).catch(() => ({}));
	const action = String(body.action || '');
	const target = body.to ?? body.userId;
	if (action !== 'request' && action !== 'accept' && action !== 'decline' &&
		action !== 'remove' && action !== 'mute' && action !== 'unmute') {
		return error(res, 400, 'bad_action', 'unknown action');
	}
	if (!isUuid(target)) return error(res, 400, 'bad_target', 'invalid user id');

	switch (action) {
		case 'request': {
			const result = await sendRequest(me, target);
			// Notify the other account: a fresh invite, or that we accepted theirs.
			if (result.status === 'requested') notifyMultiplayer('friend_request', target, { from: me });
			else if (result.status === 'accepted') notifyMultiplayer('friend_accept', target, { from: me });
			return json(res, 200, { data: result });
		}
		case 'accept': {
			const result = await acceptRequest(me, target);
			notifyMultiplayer('friend_accept', target, { from: me });
			return json(res, 200, { data: result });
		}
		case 'decline':
			return json(res, 200, { data: await declineRequest(me, target) });
		case 'remove':
			return json(res, 200, { data: await removeFriend(me, target) });
		case 'mute':
			return json(res, 200, { data: await muteUser(me, target) });
		case 'unmute':
			return json(res, 200, { data: await unmuteUser(me, target) });
	}
});

async function graphWithPresence(me) {
	const graph = await listGraph(me);
	const ids = [
		...graph.friends.map((f) => f.id),
		...graph.incoming.map((f) => f.id),
		...graph.outgoing.map((f) => f.id),
	];
	const presence = await readPresence(ids);
	const annotate = (u) => ({ ...u, ...(presence[u.id] || { online: false, realm: null, server: null }) });
	return {
		friends: graph.friends.map(annotate),
		incoming: graph.incoming.map(annotate),
		outgoing: graph.outgoing.map(annotate),
	};
}
