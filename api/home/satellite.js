// Voice satellites: /api/home/satellite
//
//   GET                      the caller's satellites and their unredeemed codes
//   POST { action: 'pair' }   mint a pairing code for one agent
//   POST { action: 'claim' }  a satellite service redeems that code, once
//   POST { action: 'session'} a paired service refreshes its hub token
//   POST { action: 'attach' } a browser asks for a token to watch a satellite
//   POST { action: 'revoke' } withdraw a code, or retire a satellite
//
// Two of these are called by a program, not a person, and that shapes the file.
// `claim` and `session` carry no cookie: the service that calls them has a
// pairing code or a satellite secret and nothing else, so they are exempt from
// the session and CSRF checks that guard everything else here and are rate
// limited by IP instead. Every other action requires a signed-in owner.
//
// What a token here buys is worth stating plainly, because it is not "some
// JSON". A viewer token joins a live audio session with a microphone in
// somebody's house on the other end. It is therefore minted for one satellite,
// expires in minutes, and is signed rather than looked up, so the hub can
// enforce it without a database and without ever holding a credential.

import { getSessionUser } from '../_lib/auth.js';
import { requireCsrf } from '../_lib/csrf.js';
import { sql } from '../_lib/db.js';
import { getAvatar } from '../_lib/avatars.js';
import {
	CODE_TTL_MINUTES,
	authenticateSatellite,
	claimPairingCode,
	createPairingCode,
	getSatelliteForOwner,
	listPendingCodes,
	listSatellites,
	revokePairingCode,
	revokeSatellite,
	touchSatellite,
} from '../_lib/home/satellites.js';
import { cors, error, json, method, rateLimited, readJson, wrap } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { isUuid } from '../_lib/validate.js';
import { ROLE, signToken } from '../../services/home-satellite/src/token.js';

/** How long a satellite's own hub token lasts before it has to ask again. */
const HUB_TOKEN_TTL_SECONDS = 24 * 60 * 60;

/** How long a browser's viewer token lasts. Short: it is handed to a web page. */
const VIEWER_TOKEN_TTL_SECONDS = 15 * 60;

const hubSecret = () => process.env.HOME_SATELLITE_HUB_SECRET || '';
const hubUrl = () => process.env.HOME_SATELLITE_HUB_URL || '';

/** Resolve an agent the caller owns, with the model its face is rendered from. */
async function ownedAgent(agentId, userId) {
	const [agent] = await sql`
		select id, name, avatar_id from agent_identities
		where id = ${agentId} and user_id = ${userId} and deleted_at is null
		limit 1
	`;
	return agent || null;
}

/** The public shape of an agent, as both the service and the browser see it. */
async function agentView(agent, requesterId) {
	if (!agent) return null;
	let avatarUrl = null;
	if (agent.avatar_id) {
		const avatar = await getAvatar({ id: agent.avatar_id, requesterId }).catch(() => null);
		avatarUrl = avatar?.model_url || null;
	}
	return { id: agent.id, name: agent.name, avatarUrl };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	if (req.method === 'GET') {
		const user = await getSessionUser(req, res).catch(() => null);
		if (!user) return error(res, 401, 'unauthorized', 'sign in to manage your satellites');
		const [satellites, codes] = await Promise.all([listSatellites(user.id), listPendingCodes(user.id)]);
		return json(res, 200, {
			satellites: satellites.map((s) => ({
				id: s.id,
				name: s.name,
				area: s.area,
				agent: { id: s.agent_id, name: s.agent_name },
				version: s.version,
				wyoming_version: s.wyoming_version,
				created_at: s.created_at,
				last_seen_at: s.last_seen_at,
			})),
			pending_codes: codes.map((c) => ({
				id: c.id,
				agent: { id: c.agent_id, name: c.agent_name },
				name: c.name,
				created_at: c.created_at,
				expires_at: c.expires_at,
			})),
			hub_configured: !!(hubSecret() && hubUrl()),
		});
	}

	const body = await readJson(req).catch(() => null);
	if (!body || typeof body !== 'object') return error(res, 400, 'bad_request', 'a JSON body is required');
	const action = String(body.action || '');

	/* ---------------------------------------------------------------- claim */
	// Called by the service itself, holding only a pairing code.
	if (action === 'claim') {
		const rl = await limits.homeSatelliteClaimIp(clientIp(req)).catch(() => ({ success: true }));
		if (rl && rl.success === false) return rateLimited(res, rl, 'too many pairing attempts, try again shortly');

		const result = await claimPairingCode({
			code: body.code,
			name: typeof body.name === 'string' ? body.name : null,
			area: typeof body.area === 'string' ? body.area : null,
			version: typeof body.version === 'string' ? body.version : null,
			wyomingVersion: typeof body.wyoming_version === 'string' ? body.wyoming_version : null,
		});
		if (!result.ok) {
			// One answer for malformed, expired, already-claimed and never-existed.
			// Distinguishing them would turn this endpoint into an oracle for
			// guessing codes, and none of the four is actionable differently: the
			// fix is always "get a fresh code".
			return error(res, 400, 'invalid_code', 'that pairing code is not valid. Codes are single use and expire after 15 minutes; generate a new one at /smart-home/satellite.');
		}

		const [agentRow] = await sql`select id, name, avatar_id from agent_identities where id = ${result.satellite.agent_id} limit 1`;
		const agent = await agentView(agentRow, result.satellite.user_id);
		const secret = hubSecret();
		return json(res, 201, {
			satellite_id: result.satellite.id,
			secret: result.secret,
			name: result.satellite.name,
			agent,
			hub_url: secret && hubUrl() ? `${hubUrl().replace(/\/+$/, '')}/room` : null,
			hub_token: secret ? signToken({ sid: result.satellite.id, role: ROLE.SATELLITE }, secret, HUB_TOKEN_TTL_SECONDS) : null,
			hub_token_exp: secret ? Math.floor(Date.now() / 1000) + HUB_TOKEN_TTL_SECONDS : 0,
		});
	}

	/* -------------------------------------------------------------- session */
	// Called by a paired service to refresh the token that gets it into its room.
	if (action === 'session') {
		const rl = await limits.homeSatelliteClaimIp(clientIp(req)).catch(() => ({ success: true }));
		if (rl && rl.success === false) return rateLimited(res, rl, 'too many session requests, try again shortly');

		if (!isUuid(body.satellite_id)) return error(res, 400, 'bad_request', 'satellite_id required');
		const auth = await authenticateSatellite(body.satellite_id, body.secret);
		if (!auth) return error(res, 401, 'unauthorized', 'this satellite is not paired, or its secret has been revoked');

		await touchSatellite(auth.satellite.id, {
			version: typeof body.version === 'string' ? body.version : null,
			wyomingVersion: typeof body.wyoming_version === 'string' ? body.wyoming_version : null,
		});

		const [agentRow] = await sql`select id, name, avatar_id from agent_identities where id = ${auth.satellite.agent_id} limit 1`;
		const agent = await agentView(agentRow, auth.satellite.user_id);
		const secret = hubSecret();
		return json(res, 200, {
			agent,
			hub_url: secret && hubUrl() ? `${hubUrl().replace(/\/+$/, '')}/room` : null,
			hub_token: secret ? signToken({ sid: auth.satellite.id, role: ROLE.SATELLITE }, secret, HUB_TOKEN_TTL_SECONDS) : null,
			hub_token_exp: secret ? Math.floor(Date.now() / 1000) + HUB_TOKEN_TTL_SECONDS : 0,
		});
	}

	/* ------------------------------------------------- everything else: user */
	const user = await getSessionUser(req, res).catch(() => null);
	if (!user) return error(res, 401, 'unauthorized', 'sign in to manage your satellites');
	if (!(await requireCsrf(req, res, user.id))) return;

	if (action === 'pair') {
		const rl = await limits.homeSatellitePair(user.id).catch(() => ({ success: true }));
		if (rl && rl.success === false) return rateLimited(res, rl, 'too many pairing codes, try again shortly');

		if (!isUuid(body.agent_id)) return error(res, 400, 'bad_request', 'agent_id required');
		const agent = await ownedAgent(body.agent_id, user.id);
		if (!agent) return error(res, 404, 'not_found', 'no agent of yours has that id');

		const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : null;
		const created = await createPairingCode({ userId: user.id, agentId: agent.id, name });
		return json(res, 201, {
			code: created.code,
			expires_at: created.expires_at,
			ttl_minutes: CODE_TTL_MINUTES,
			agent: { id: agent.id, name: agent.name },
			// The exact command, with the code already in it. A pairing flow that
			// makes somebody assemble a docker run line from prose is a pairing
			// flow half of them abandon.
			command: `docker run -d --name three-ws-satellite --network host -v three-ws-satellite:/data -e THREE_WS_PAIRING_CODE=${created.code} ghcr.io/nirholas/three-ws-home-satellite:latest`,
		});
	}

	if (action === 'attach') {
		if (!isUuid(body.satellite_id)) return error(res, 400, 'bad_request', 'satellite_id required');
		const owned = await getSatelliteForOwner(body.satellite_id, user.id);
		if (!owned) return error(res, 404, 'not_found', 'no satellite of yours has that id');

		const [agentRow] = await sql`select id, name, avatar_id from agent_identities where id = ${owned.satellite.agent_id} limit 1`;
		const agent = await agentView(agentRow, user.id);
		const secret = hubSecret();
		return json(res, 200, {
			satellite: {
				id: owned.satellite.id,
				name: owned.satellite.name,
				area: owned.satellite.area,
				version: owned.satellite.version,
				wyoming_version: owned.satellite.wyoming_version,
				last_seen_at: owned.satellite.last_seen_at,
			},
			agent,
			// The hosted path: works from https://three.ws, needs the hub.
			hub_url: secret && hubUrl() ? `${hubUrl().replace(/\/+$/, '')}/room` : null,
			hub_token: secret ? signToken({ sid: owned.satellite.id, role: ROLE.VIEWER }, secret, VIEWER_TOKEN_TTL_SECONDS) : null,
			// The local path: works from a browser on the same network as the
			// house, with three.ws entirely out of the loop after this response.
			lan_token: owned.secret ? signToken({ sid: owned.satellite.id, role: ROLE.VIEWER }, owned.secret, VIEWER_TOKEN_TTL_SECONDS) : null,
			expires_in: VIEWER_TOKEN_TTL_SECONDS,
		});
	}

	if (action === 'revoke') {
		if (isUuid(body.satellite_id)) {
			const done = await revokeSatellite(body.satellite_id, user.id);
			if (!done) return error(res, 404, 'not_found', 'no satellite of yours has that id');
			return json(res, 200, { revoked: 'satellite', id: body.satellite_id });
		}
		if (isUuid(body.code_id)) {
			const done = await revokePairingCode(body.code_id, user.id);
			if (!done) return error(res, 404, 'not_found', 'no unclaimed code of yours has that id');
			return json(res, 200, { revoked: 'code', id: body.code_id });
		}
		return error(res, 400, 'bad_request', 'satellite_id or code_id required');
	}

	return error(res, 400, 'bad_request', 'action must be pair, claim, session, attach or revoke');
});
