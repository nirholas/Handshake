// /api/home/pair, the door a house that only exists on a LAN comes in through.
//
//   POST  { label }                    mint a pairing code for a new relayed home
//   POST  { homeId, action: 'refresh' } mint a fresh code for one already pending
//   GET   ?homeId=                     the live code's countdown and this home's link state
//
// The redemption half lives at /api/home/pair/redeem and is deliberately a
// separate file, because it is the one endpoint in this whole surface with no
// three.ws session behind it: the caller is a Home Assistant install, which has
// no account, no cookie and no bearer token, and only ever will have the short
// code its owner typed in.
//
// Why this exists at all: three.ws is served over https from Cloud Run and
// cannot route to RFC1918 space, so for most Home Assistant installs there is
// no URL we could ever dial. Those houses dial us. See
// docs/home-relay-threat-model.md for what that connection can and cannot do.

import { publicHome, resolveCaller } from '../_lib/home/access.js';
import { can } from '../_lib/home/members.js';
import { homeError, homeFailure, HOME_ERR } from '../_lib/home/errors.js';
import {
	isRelayConfigured,
	PairingError,
	pendingPairing,
	refreshPairing,
	relayStatus,
	startPairing,
} from '../_lib/home/relay.js';
import { getConnection } from '../_lib/home/store.js';
import { requireCsrf } from '../_lib/csrf.js';
import { cors, error, json, method, rateLimited, readJson, wrap } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { logAudit } from '../_lib/audit.js';

const LABEL_MAX = 120;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const caller = await resolveCaller(req, res);
	if (!caller) return error(res, 401, 'unauthorized', 'Sign in to connect a home.');

	if (!isRelayConfigured()) {
		return homeError(
			res,
			homeFailure(
				HOME_ERR.NOT_CONNECTED,
				'This three.ws deployment has no home relay configured yet, so a home that is only on your network cannot be connected here. A home with a remote https address still connects normally.',
			),
		);
	}

	if (req.method === 'GET') return handleStatus(req, res, caller);
	return handleMint(req, res, caller);
});

/**
 * The connect UI polls this while the code is on screen: it renders the
 * countdown from `expiresAt` and flips to the connected state the moment the
 * house dials in, with no page reload and no user action.
 */
async function handleStatus(req, res, caller) {
	const rl = await limits.homeRead(caller.userId);
	if (!rl.success) return rateLimited(res, rl, 'too many home reads, slow down');

	const homeId = new URL(req.url, 'http://local').searchParams.get('homeId');
	if (!homeId) return homeError(res, homeFailure(HOME_ERR.VALIDATION, 'homeId is required.'));

	const home = await getConnection(homeId, caller.userId);
	if (!home) return homeError(res, homeFailure(HOME_ERR.NOT_FOUND, 'No such home.'));
	// Re-pairing a relay changes how the house connects, which is connection
	// administration rather than living in the house. A member can turn the
	// lights on and cannot re-point the tunnel their household runs on.
	if (!can(home.role, 'manage')) {
		return homeError(res, homeFailure(HOME_ERR.FORBIDDEN, `A ${home.role} cannot manage this home's connection.`));
	}
	if (home.transport !== 'relay') {
		return homeError(res, homeFailure(HOME_ERR.VALIDATION, 'That home connects to its own address, not through the three.ws integration.'));
	}

	const [pairing, live] = await Promise.all([
		pendingPairing(homeId, caller.userId),
		relayStatus(home.relay_id),
	]);

	return json(res, 200, {
		home: publicHome(home),
		pairing,
		// `online` is the honest answer to "is the integration in my house
		// running right now", read from the relay rather than inferred from the
		// last successful session. It is what tells state 3 from state 4.
		relay: { online: Boolean(live.online), agent: live.agent || null, sessions: live.sessions ?? 0 },
	});
}

async function handleMint(req, res, caller) {
	if (!(await requireCsrf(req, res, caller.userId))) return;

	const rl = await limits.homeConnect(caller.userId);
	if (!rl.success) return rateLimited(res, rl, 'too many connection attempts, wait a moment');

	const body = (await readJson(req, 4_000).catch(() => null)) || {};
	const homeId = typeof body.homeId === 'string' ? body.homeId : '';

	try {
		if (homeId) {
			const refreshed = await refreshPairing({ homeId, userId: caller.userId });
			logAudit({ action: 'home.pair.refresh', userId: caller.userId, targetId: homeId });
			return json(res, 200, { homeId, ...refreshed });
		}

		const label = typeof body.label === 'string' ? body.label.trim().slice(0, LABEL_MAX) : '';
		const started = await startPairing({ userId: caller.userId, label });
		logAudit({ action: 'home.pair.start', userId: caller.userId, targetId: started.home.id });
		return json(res, 201, {
			home: publicHome(started.home),
			code: started.code,
			expiresAt: started.expiresAt,
			relayUrl: started.relayUrl,
			// Everything the user has to do next, in the order they do it, so the
			// UI renders instructions rather than inventing them.
			instructions: {
				hacs: 'https://github.com/nirholas/three-ws-home-assistant',
				integration: 'three.ws',
				where: 'Settings, Devices and services, Add integration, three.ws',
			},
		});
	} catch (err) {
		if (err instanceof PairingError) return error(res, err.status || 400, err.code, err.message);
		throw err;
	}
}
