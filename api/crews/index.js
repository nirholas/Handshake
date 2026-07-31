// /api/crews
//   GET  — the caller's crew (with roster + live presence) and pending crew
//          invites. Empty crew/invites when they belong to none.
//   POST — crew mutations via { action, ... }:
//            create   { tag, name }   found a new crew (founder becomes owner)
//            invite   { userId }      invite an account to my crew
//            accept   { crewId }      accept an invite to a crew
//            decline  { crewId }      decline an invite
//            leave    {}              leave my crew (owner hands off / disbands)
//            kick     { userId }      owner-only: remove a member
//
// Validates the caller owns the account (session or bearer); the store layer
// guards self-invite, duplicates, one-crew-per-account, and ownership. Rate-
// limited per account. Mirrors api/friends/index.js.

import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { resolveAccount } from '../_lib/account-auth.js';
import { readPresence, notifyMultiplayer } from '../_lib/presence-store.js';
import {
	getMyCrew,
	listMembers,
	listInvites,
	createCrew,
	invite,
	acceptInvite,
	declineInvite,
	leaveCrew,
	kickMember,
	isMissingRelation,
} from '../_lib/crews-store.js';

function isUuid(v) {
	return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

const EMPTY = { crew: null, members: [], invites: [] };

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const auth = await resolveAccount(req, res);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
	const me = auth.userId;

	if (req.method === 'GET') {
		const rl = await limits.publicIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl);
		return json(res, 200, { data: await crewWithPresence(me) });
	}

	// POST — a crew mutation. 40 actions/min per account (shared chat limiter).
	const rl = await limits.chatUser(me);
	if (!rl.success) return rateLimited(res, rl, 'slow down');

	const body = await readJson(req).catch(() => ({}));
	const action = String(body.action || '');
	try {
		switch (action) {
			case 'create': {
				const crew = await createCrew(me, body.tag, body.name);
				return json(res, 200, { data: { crew } });
			}
			case 'invite': {
				if (!isUuid(body.userId)) return error(res, 400, 'bad_target', 'invalid user id');
				const { crew, invitee } = await invite(me, body.userId);
				notifyMultiplayer('crew_invite', body.userId, { crew, from: me });
				return json(res, 200, { data: { ok: true, invitee } });
			}
			case 'accept': {
				if (!isUuid(body.crewId)) return error(res, 400, 'bad_target', 'invalid crew id');
				const crew = await acceptInvite(me, body.crewId);
				return json(res, 200, { data: { crew } });
			}
			case 'decline': {
				if (!isUuid(body.crewId)) return error(res, 400, 'bad_target', 'invalid crew id');
				return json(res, 200, { data: await declineInvite(me, body.crewId) });
			}
			case 'leave':
				return json(res, 200, { data: await leaveCrew(me) });
			case 'kick': {
				if (!isUuid(body.userId)) return error(res, 400, 'bad_target', 'invalid user id');
				return json(res, 200, { data: await kickMember(me, body.userId) });
			}
			default:
				return error(res, 400, 'bad_action', 'unknown action');
		}
	} catch (e) {
		// Store layer throws typed errors ({ status, code }); surface them cleanly.
		if (e?.status && e?.code) return error(res, e.status, e.code, e.message);
		throw e;
	}
});

async function crewWithPresence(me) {
	let crew;
	let invites;
	try {
		crew = await getMyCrew(me);
		invites = await listInvites(me);
	} catch (err) {
		// Crew tables may not be migrated yet: return an empty view rather than 500.
		if (isMissingRelation(err)) return EMPTY;
		throw err;
	}
	if (!crew) return { crew: null, members: [], invites: invites || [] };

	const members = await listMembers(crew.id);
	const presence = await readPresence(members.map((m) => m.id));
	const annotated = members.map((m) => ({ ...m, ...(presence[m.id] || { online: false, realm: null, server: null }) }));
	return { crew, members: annotated, invites: invites || [] };
}
