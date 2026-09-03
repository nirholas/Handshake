// /api/home, the caller's homes, and the door that adds one.
//
//   GET   list every home this account has connected, credential-free
//   POST  verify a Home Assistant instance for real, then store it
//
// The POST is the only place a Home Assistant long-lived access token ever
// enters the platform, which is why it does three things in a fixed order and
// refuses to reorder them:
//
//   1. Validate the URL shape BEFORE anything opens a socket, so a LAN address
//      is refused with an explanation instead of a fifteen second timeout.
//   2. Open a real connection and MEASURE the instance: version, entity count,
//      areas, floors, and whether the optional Model Context Protocol Server
//      integration answers. Nothing here is inferred from the URL or assumed
//      from a version string. A capability we did not observe is reported as
//      absent, never as present.
//   3. Only then encrypt the token and write the row. A house we could not
//      reach never becomes a stored credential, so the connection list cannot
//      fill up with rows that have never worked.
//
// A home whose `mcp_server` integration is not enabled is NOT an error at any
// point in that sequence. It is an ordinary home, it connects, it stores, and it
// comes back with `capabilities.mcp === false` plus the setting path the user
// would follow to turn it on. Treating a missing optional integration as a
// failure is how a connect screen tells a person their working house is broken.

import { isPrivateHost, normalizeBaseUrl } from '@three-ws/home-bridge';

import { logAudit } from '../_lib/audit.js';
import { requireCsrf } from '../_lib/csrf.js';
import { publicHome, resolveCaller } from '../_lib/home/access.js';
import { homeError, homeFailure, HOME_ERR } from '../_lib/home/errors.js';
import { createConnection, HOME_STATUS, listConnections } from '../_lib/home/store.js';
import { verifyConnection } from '../_lib/home/verify.js';
import { cors, error, json, method, rateLimited, readJson, wrap } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';

/** A label is a display string, not an identifier. Long enough for "Mum's house". */
const LABEL_MAX = 120;
/** Home Assistant long-lived tokens are JWTs of roughly 180 to 260 characters. */
const TOKEN_MAX = 4_000;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const caller = await resolveCaller(req, res);
	if (!caller) return error(res, 401, 'unauthorized', 'Sign in to see your homes.');

	if (req.method === 'GET') return handleList(req, res, caller);
	return handleConnect(req, res, caller);
});

async function handleList(req, res, caller) {
	const rl = await limits.homeRead(caller.userId);
	if (!rl.success) return rateLimited(res, rl, 'too many home reads, slow down');

	const homes = await listConnections(caller.userId);
	return json(res, 200, { homes: homes.map(publicHome) });
}

async function handleConnect(req, res, caller) {
	// A cookie session needs CSRF; `requireCsrf` exempts bearer callers itself, so
	// the agent lane is not asked for a token it has no way to hold.
	if (!(await requireCsrf(req, res, caller.userId))) return;

	const rl = await limits.homeConnect(caller.userId);
	if (!rl.success) return rateLimited(res, rl, 'too many connection attempts, wait a moment');

	const body = await readJson(req, 16_000).catch(() => null);
	if (!body || typeof body !== 'object') {
		return homeError(res, homeFailure(HOME_ERR.VALIDATION, 'Send a JSON body with baseUrl and token.'));
	}

	const rawUrl = typeof body.baseUrl === 'string' ? body.baseUrl : body.base_url;
	const token = typeof body.token === 'string' ? body.token.trim() : '';
	const label = typeof body.label === 'string' ? body.label.trim().slice(0, LABEL_MAX) : '';

	if (!token) {
		return homeError(res, homeFailure(HOME_ERR.AUTH, 'A Home Assistant long-lived access token is required. Create one in your Home Assistant profile, under Security.'));
	}
	if (token.length > TOKEN_MAX) {
		return homeError(res, homeFailure(HOME_ERR.AUTH, 'That does not look like a Home Assistant access token.'));
	}

	let normalized;
	try {
		// requireSecure mirrors what a browser on an https page can actually reach.
		// Failing here, before any socket, is what turns "it just spins" into a
		// sentence the user can act on.
		normalized = normalizeBaseUrl(rawUrl, { requireSecure: true });
	} catch (err) {
		return homeError(res, err);
	}

	// Our servers cannot route to RFC1918 space at all, so a private address is a
	// certain failure we can name up front rather than a fifteen second wait
	// followed by a generic timeout.
	const host = new URL(normalized.http).hostname;
	if (isPrivateHost(host) && !normalized.loopback) {
		return homeError(res, homeFailure(
			HOME_ERR.UNREACHABLE,
			`${host} is an address on your own network, and three.ws runs on the public internet, so it cannot reach it. Use the remote https URL from Home Assistant Cloud or your own reverse proxy.`,
		));
	}

	let measured;
	try {
		measured = await verifyConnection({ baseUrl: normalized.http, token });
	} catch (err) {
		// Nothing is stored on a failed verify: a house we could not reach never
		// becomes a row, and the token never becomes ciphertext at rest.
		return homeError(res, err);
	}

	const home = await createConnection({
		userId: caller.userId,
		label: label || defaultLabel(normalized.http),
		baseUrl: normalized.http,
		token,
		capabilities: measured.capabilities,
		status: HOME_STATUS.CONNECTED,
		statusDetail: null,
	});

	logAudit({
		userId: caller.userId,
		action: 'connect_home',
		resourceId: home.id,
		// The base URL is the one identifying fact worth keeping; the token is not
		// here, is not logged anywhere else, and must never be added.
		meta: { base_url: home.base_url, entity_count: measured.capabilities.entityCount, mcp: measured.capabilities.mcp },
		req,
	});

	return json(res, 201, {
		home: publicHome(home),
		capabilities: measured.capabilities,
		graph: measured.graph,
	});
}

/** "home.example.com" beats "Untitled home" when the user did not name it. */
function defaultLabel(httpUrl) {
	try {
		return new URL(httpUrl).hostname;
	} catch {
		return 'Home';
	}
}
