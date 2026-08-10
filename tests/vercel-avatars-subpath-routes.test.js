/**
 * Route-shadowing guard for `/api/avatars/*`, the sibling of
 * vercel-agents-subpath-routes.test.js.
 *
 * `routes` is ordered and the first terminal match wins, so a handler can exist,
 * be correct, and still never run: `/api/avatars/([^/]+)` → `/api/avatars/[id]`
 * sits pre-filesystem and swallows every single-segment path under
 * /api/avatars/, the filesystem phase included. A shadowed handler does not 404
 * in a way anyone notices either, because the dispatcher answers with its own
 * `{"error":"not_found","error_description":"avatar not found"}`.
 *
 * `api/avatars/popular-searches.js` was dead in production exactly this way. It
 * is the read side of the Avatar Search Index Warmup pipeline, which pays per
 * call to warm `avatar_search_warm_cache`, so the shadowing burned real money
 * producing data no request could reach.
 *
 * The handler list is derived from disk, never hand-written: a hand-list only
 * covers the outage someone already found, and the point is to catch the NEXT
 * handler that lands in this directory without a route above the catch-all.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const routes = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')).routes;
const fsPhase = routes.findIndex((r) => r.handle === 'filesystem');

/** First terminal pre-filesystem match, resolved the way the server resolves it. */
function resolve(path) {
	for (const route of routes.slice(0, fsPhase)) {
		if (typeof route.src !== 'string') continue;
		let m;
		try {
			m = new RegExp(`^(?:${route.src})$`).exec(path);
		} catch {
			continue;
		}
		if (!m || route.continue) continue;
		return String(route.dest || '').replace(/\$(\d)/g, (_, d) => m[Number(d)] ?? '');
	}
	return null;
}

// Literal-named handlers directly under api/avatars/. `_`-prefixed files are
// shared library modules (never routable) and `[`-prefixed ones are the dynamic
// dispatchers doing the shadowing.
const handlers = readdirSync(new URL('../api/avatars', import.meta.url))
	.filter((f) => f.endsWith('.js') && !f.startsWith('_') && !f.startsWith('['))
	.map((f) => f.replace(/\.js$/, ''))
	// index.js is reached through `/api/avatars/?`, not by its filename.
	.filter((f) => f !== 'index');

describe('/api/avatars/* literal handlers are reachable', () => {
	it('finds the handlers on disk', () => {
		expect(handlers.length).toBeGreaterThan(5);
		expect(handlers).toContain('popular-searches');
	});

	it.each(handlers)('GET /api/avatars/%s reaches its own handler, not the [id] dispatcher', (name) => {
		expect(resolve(`/api/avatars/${name}`)).toBe(`/api/avatars/${name}`);
	});

	it('still routes a real avatar id to the [id] dispatcher', () => {
		expect(resolve('/api/avatars/6a3f1b0c-2b6e-4f1a-9d5b-8c7e2f0a1d34')).toBe('/api/avatars/[id]');
	});

	it('routes the index listing to api/avatars/index.js', () => {
		expect(resolve('/api/avatars/')).toBe('/api/avatars/index');
	});
});
