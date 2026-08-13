// Persona identity resolve: the live chain-state feed behind the embodiment
// embed's visual binding (prompt 17: "the avatar IS the wallet").
//
//   GET /api/mcp3d/persona-identity?id=persona_xxx[&network=mainnet|devnet]
//     → { persona, address, network, balances, reputation, holdings, nameplate,
//         visual, caps, fetched_at }
//
// `persona` is the same public projection GET /api/mcp3d/persona returns; every
// other field sits at the top level because that is exactly the object
// EmbodimentStage.setChainState() reads.
//
// pages/embodiment/embed.html polls this (only when opened with ?wallet=1) so
// the body's aura/cosmetic/muted-state/nameplate track LIVE chain state, not a
// snapshot frozen at the MCP tool call that minted the embed URL. Same core
// read the `persona_identity` MCP tool uses (api/_lib/persona-wallet.js): one
// source of truth, two front doors. Read-only, no private key ever touches
// this path: getPersonaIdentity only ever derives the PUBLIC key.
//
// CORS open + short CDN cache: the embed is framed cross-origin, and a fresh
// read every ~20s (the embed's poll interval) is honest without hammering the
// RPC/attestation/Bonfida upstreams on every viewer.

import { cors, json, wrap } from '../_lib/http.js';
import { isPersonaId, getPersona, personaPublicView } from '../_lib/persona-store.js';
import { getPersonaIdentity } from '../_lib/persona-wallet.js';

// Short CDN window: the embed polls roughly every 20s, so a 15s shared cache
// keeps a crowded room off the RPC/attestation/Bonfida upstreams without ever
// showing a viewer state older than one poll.
const CACHE_CONTROL = 'public, s-maxage=15, stale-while-revalidate=60';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,HEAD,OPTIONS', origins: '*' })) return;

	if (req.method !== 'GET' && req.method !== 'HEAD') {
		json(res, 405, { error: 'method_not_allowed', message: 'GET this endpoint with ?id=persona_…' }, { allow: 'GET, HEAD, OPTIONS' });
		return;
	}

	const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
	const id = url.searchParams.get('id') || '';
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';

	if (!isPersonaId(id)) {
		json(res, 400, { error: 'invalid_id', message: 'Provide a valid persona id (?id=persona_…).' });
		return;
	}

	let record;
	try {
		record = await getPersona(id);
	} catch (err) {
		console.warn('[mcp3d/persona-identity] persona load failed:', err?.message || err);
		json(res, 503, { error: 'unavailable', message: 'Could not load that persona right now. Please try again.' });
		return;
	}
	if (!record) {
		json(res, 404, { error: 'not_found', message: 'No persona found for that id.' });
		return;
	}

	let identity;
	try {
		identity = await getPersonaIdentity(id, { network });
	} catch (err) {
		// Every sub-read inside getPersonaIdentity already degrades independently,
		// so reaching here means the derivation itself failed (e.g. no
		// PERSONA_WALLET_SECRET configured). Report that honestly, not a 500, and
		// log the cause: this branch is a config fault, and an unlogged one costs
		// an ops session to rediscover.
		console.warn('[mcp3d/persona-identity] identity derivation failed:', err?.code || err?.message || err);
		json(res, 503, { error: 'wallet_unavailable', message: 'This persona wallet is not available right now.' });
		return;
	}

	res.setHeader('cache-control', CACHE_CONTROL);
	res.setHeader('cross-origin-resource-policy', 'cross-origin');
	json(res, 200, { persona: personaPublicView(record), ...identity });
});
