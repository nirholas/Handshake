// Persona resolve: the durable-reload endpoint behind the embodiment embed.
//
//   GET /api/mcp3d/persona?id=persona_xxx  → { persona_id, name, glb_url, … }
//
// The embodiment embed (pages/embodiment/embed.html) calls this when it is
// opened with only a persona id (no inline glb param) so a fresh session (a new
// ChatGPT/Claude turn, a reopened panel, a shared link) reloads the exact same
// body by id. The persona id is an unguessable capability, so no auth is
// required to read; the response is the safe public projection only
// (personaPublicView strips storage keys + owner ids). No token, wallet, or
// payment surface: a persona is a name and a body.
//
// CORS is open and the response is CDN-cacheable for a short window because the
// embed is framed cross-origin by arbitrary hosts and a persona's body rarely
// changes within a session.

import { cors, json, wrap } from '../_lib/http.js';
import { getPersona, isPersonaId, personaPublicView } from '../_lib/persona-store.js';

const CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,HEAD,OPTIONS', origins: '*' })) return;

	if (req.method !== 'GET' && req.method !== 'HEAD') {
		json(res, 405, { error: 'method_not_allowed', message: 'GET this endpoint with ?id=persona_…' }, { allow: 'GET, HEAD, OPTIONS' });
		return;
	}

	// Parse the id from the query string without depending on a framework-specific
	// req.query (this handler runs under the plain Node wrap()).
	const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
	const id = url.searchParams.get('id') || '';

	if (!isPersonaId(id)) {
		json(res, 400, { error: 'invalid_id', message: 'Provide a valid persona id (?id=persona_…).' });
		return;
	}

	let record;
	try {
		record = await getPersona(id);
	} catch (err) {
		// A storage hiccup must not leak internals to the caller, but it must not
		// vanish either: a silently swallowed cause is an undiagnosable 503 in
		// production. Log the reason, return the clean unavailable.
		console.warn('[mcp3d/persona] persona load failed:', err?.message || err);
		json(res, 503, { error: 'unavailable', message: 'Could not load that persona right now. Please try again.' });
		return;
	}

	if (!record) {
		json(res, 404, { error: 'not_found', message: 'No persona found for that id.' });
		return;
	}

	// Public projection only, never the storage key or owner id. Short CDN cache:
	// the body is durable, and the embed re-fetches on each cold load anyway.
	res.setHeader('cache-control', CACHE_CONTROL);
	res.setHeader('cross-origin-resource-policy', 'cross-origin');
	json(res, 200, personaPublicView(record));
});
