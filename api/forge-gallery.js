/**
 * Forge gallery — durable text→3D creations.
 *
 *   GET /api/forge-gallery                    → { creations: [...], enabled }
 *   GET /api/forge-gallery?scope=community    → { creations: [...], enabled }
 *
 * Default scope reads the persisted models for the browser identified by the
 * x-forge-client header, newest first — the "Your creations" strip on /forge,
 * so generated meshes are reusable instead of lost the moment the tab closes.
 *
 * scope=community reads the newest finished models across all clients (no
 * client header required, nothing identifying returned) — the public "Fresh
 * from the Forge" showcase. Community responses are CDN-cached briefly: the
 * feed only changes when someone finishes a generation.
 *
 * When persistence isn't configured on the deployment both scopes return
 * { enabled: false, creations: [] } so the page can hide the strips cleanly
 * rather than show a broken state.
 */

import { cors, json, method, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { hashClient, listCreations, listShowcase, forgeStoreEnabled } from './_lib/forge-store.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) {
		return rateLimited(res, rl);
	}

	if (!forgeStoreEnabled()) {
		return json(res, 200, { enabled: false, creations: [] });
	}

	const url = new URL(req.url, 'http://localhost');
	const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 24, 1), 50);

	if ((url.searchParams.get('scope') || '').trim() === 'community') {
		// Fresh (newest, visual-first) vs Top (Forge-Off board, most-voted). The
		// `window=week` narrows Top to the current Forge-Off week.
		const sort = (url.searchParams.get('sort') || '').trim() === 'top' ? 'top' : 'fresh';
		const window = (url.searchParams.get('window') || '').trim() === 'week' ? 'week' : 'all';
		// Resolve the caller's own voted-state per card when they send their
		// forge id — the community feed carries no other identifying data, and a
		// missing header just yields voted=false everywhere (anonymous read).
		const rawClient = req.headers['x-forge-client'];
		const hasClient = Array.isArray(rawClient) ? rawClient[0] : rawClient;
		const voterKey = hasClient ? hashClient(hasClient) : null;
		const creations = await listShowcase({ limit, sort, window, voterKey });
		// Per-voter reads can't be shared across browsers, so only the anonymous
		// (no client id) read is CDN-cacheable. A voted-state read is private.
		const headers = voterKey
			? { 'cache-control': 'private, no-store' }
			: { 'cache-control': 'public, s-maxage=60, stale-while-revalidate=300' };
		return json(res, 200, { enabled: true, creations, sort, window }, headers);
	}

	const rawClient = req.headers['x-forge-client'];
	const clientKey = hashClient(Array.isArray(rawClient) ? rawClient[0] : rawClient);
	const creations = await listCreations({ clientKey, limit });
	return json(res, 200, { enabled: true, creations });
});
