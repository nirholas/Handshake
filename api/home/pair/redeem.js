// /api/home/pair/redeem, called from inside a house.
//
// This is the only endpoint in the home surface with no three.ws session behind
// it, and that is not an oversight. The caller is a Home Assistant install: it
// has no account, no cookie, no bearer token, and the only thing it will ever
// hold is the short code its owner read off a three.ws screen and typed into a
// config flow. Authentication here IS the code.
//
// Everything that makes that safe lives in api/_lib/home/relay.js and is worth
// restating, because a weak-looking secret on an unauthenticated endpoint is
// exactly the shape of a real vulnerability:
//
//   * The code redeems into ONE home_connections row, the one it was minted
//     for. It is not a ticket to "a house"; a guess cannot be aimed.
//   * It is single use, decided by a conditional UPDATE, so two racing
//     redemptions cannot both succeed.
//   * It expires in ten minutes.
//   * Wrong guesses are counted against the pairing and kill it after five.
//   * It is stored as a digest, so reading the table yields no live pairing.
//   * It is rate limited per IP here, on top of all of that.
//
// What it hands back is an install token: an HMAC over the relay id, the owner
// and the home, which lets the relay verify a dial-in with no database. It is
// not a Home Assistant credential, because three.ws never receives one for a
// relayed home. The integration authenticates to Home Assistant locally.

import { homeError, homeFailure, HOME_ERR } from '../../_lib/home/errors.js';
import { isRelayConfigured, normalizePairingCode, PairingError, recordFailedAttempt, redeemPairing } from '../../_lib/home/relay.js';
import { clientIp, limits } from '../../_lib/rate-limit.js';
import { cors, error, json, method, rateLimited, readJson, wrap } from '../../_lib/http.js';
import { logAudit } from '../../_lib/audit.js';

export default wrap(async (req, res) => {
	// No credentials on this route: the caller is a server, not a browser, so an
	// origin-scoped cookie has no meaning here and asking for one would only make
	// the integration harder to write without making anything safer.
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['POST'])) return;

	if (!isRelayConfigured()) {
		return homeError(
			res,
			homeFailure(HOME_ERR.NOT_CONNECTED, 'This three.ws deployment has no home relay configured, so there is nothing to pair with yet.'),
		);
	}

	const ip = clientIp(req);
	const rl = await limits.homePairRedeem(ip);
	if (!rl.success) return rateLimited(res, rl, 'too many pairing attempts, wait a few minutes');

	const body = await readJson(req, 4_000).catch(() => null);
	const code = normalizePairingCode(body?.code);
	if (!code) return error(res, 400, 'validation_error', 'A pairing code is required.');

	try {
		const paired = await redeemPairing({ code, protocol: body?.protocol, agent: body?.agent });
		logAudit({ action: 'home.pair.redeem', targetId: paired.relayId, detail: { ip } });
		return json(res, 200, paired);
	} catch (err) {
		if (err instanceof PairingError) {
			// A wrong code that matches nothing has nothing to count against; a
			// wrong code aimed at a live pairing burns one of its five attempts.
			// Both answer identically, so a caller learns nothing from the shape of
			// the refusal it did not already know from having the code.
			if (err.code === 'unknown_code') await recordFailedAttempt(code).catch(() => null);
			return error(res, err.status || 400, err.code, err.message);
		}
		throw err;
	}
});
