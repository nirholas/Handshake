/**
 * Guards a shadowing outage class distinct from vercel-action-routes.test.js.
 *
 * That test asks "does a nested [action].js have SOME route?". This one asks the
 * harder question: "does the request actually REACH it?". `routes` is ordered and
 * the first terminal match wins, so a handler can be perfectly routed and still
 * never run if a broader route sits above it.
 *
 * `/api/agents/([^/]+)(?:/.*)?` → `/api/agents/[id]` is exactly that broader
 * route: it swallows every path under /api/agents/, including nested handlers
 * with literal names. Because it is pre-filesystem, the filesystem phase never
 * gets a chance either. Three documented endpoints were dead in production this
 * way, each answering the dispatcher's `{"error":"not_found","error_description":
 * "agent not found"}` instead of running:
 *   · GET /api/agents/ens/:name      (ENS → agent identity lookup, docs/erc8004)
 *   · GET /api/agents/8004/agent     (ERC-8004 agent by token id, /demos/erc8004)
 *   · GET /api/agents/8004/search    (ERC-8004 registry search, /demos/erc8004)
 * `api/agents/ens/[name].js` had never served a single request.
 *
 * Sub-paths that legitimately resolve to the dispatcher (it switches on the URL
 * internally) and the hyphen-aliased `<dir>-<action>` routes are unaffected and
 * asserted here too, so a fix for one cannot silently break the other.
 *
 * The `api/agents/[id]/` sweep below is derived from disk rather than hand-listed,
 * because a hand-list only ever covers the outage someone already found. This test
 * previously named those same three paths and nothing else, so
 * `api/agents/[id]/bundles.js` sat unrouted and unnoticed: every
 * `GET /api/agents/:id/bundles` was answered by the dispatcher with the AGENT
 * object, a 200 carrying the wrong body, which no error monitor can see. The whole
 * skill-bundle feature (create, list, price, buy) was unreachable in production as
 * a result. Deriving the list means the next handler added to that directory is
 * covered the moment it lands.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const routes = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')).routes;
const fsPhase = routes.findIndex((r) => r.handle === 'filesystem');

/**
 * First terminal pre-filesystem match, the way the server resolves a request:
 * `continue: true` routes (header decorators) fall through, everything else wins.
 * Returns the dest with $n backreferences substituted, or null if nothing matched.
 */
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

const DISPATCHER = '/api/agents/[id]';

describe('nested /api/agents handlers are reachable, not shadowed by the [id] catch-all', () => {
	it.each([
		['/api/agents/ens/vitalik.eth', '/api/agents/ens/[name]', 'name=vitalik.eth'],
		['/api/agents/8004/agent', '/api/agents/8004/agent', null],
		['/api/agents/8004/search', '/api/agents/8004/search', null],
	])('%s reaches its own handler', (path, handler, query) => {
		const dest = resolve(path);
		expect(dest).not.toBeNull();
		expect(dest.split('?')[0]).toBe(handler);
		// The regression signature: swallowed into the agent-by-id dispatcher.
		expect(dest.split('?')[0]).not.toBe(DISPATCHER);
		if (query) expect(dest).toContain(query);
	});

	it('still sends a plain agent id to the dispatcher', () => {
		// The catch-all must keep working; the fix is ordering, not removal.
		expect(resolve('/api/agents/agt_abc123')).toBe(DISPATCHER);
		expect(resolve('/api/agents/agt_abc123/animations')).toBe(DISPATCHER);
	});

	it('leaves the per-id sub-routes and hyphen aliases intact', () => {
		expect(resolve('/api/agents/agt_abc123/economy')).toBe('/api/agents/[id]/economy?id=agt_abc123');
		expect(resolve('/api/agents/solana-metadata')).toBe('/api/agents/solana/[action]?action=metadata');
	});

	// Every handler in api/agents/[id]/ needs at least one route that both names it
	// as a dest AND actually wins resolution for the path that route describes.
	//
	// Asked as "does /api/agents/:id/<filename> resolve to <filename>?" this sweep
	// reports a false failure for memory-seed-x, which is routed and reachable at
	// /api/agents/:id/memory/seed/x. The URL is not required to echo the filename;
	// what matters is that some URL gets there. So the invariant is written over
	// the route table's own srcs instead of over a guessed URL.
	const perIdHandlers = readdirSync(new URL('../api/agents/[id]/', import.meta.url))
		.filter((f) => f.endsWith('.js'))
		.map((f) => f.replace(/\.js$/, ''));

	/**
	 * A concrete path that a route's `src` pattern matches, so the resolver can be
	 * asked whether that route is the one that wins. Covers the shapes actually used
	 * in this table: capture groups, alternations, and the optional-tail suffix.
	 */
	function samplePath(src) {
		return src
			.replace(/\(\?:\/\.\*\)\?/g, '')
			.replace(/\(\?:([^)|]+)(\|[^)]*)?\)/g, '$1')
			.replace(/\(([^)|]+)(\|[^)]*)?\)/g, (_, first) => (/^\[\^\/\]\+$/.test(first) ? 'sample' : first))
			.replace(/\\\./g, '.')
			.replace(/\?$/, '');
	}

	it('covers every handler in api/agents/[id]/', () => {
		// A directory that reads as empty would make the sweep below vacuously pass.
		expect(perIdHandlers.length).toBeGreaterThan(0);
	});

	it.each(perIdHandlers)('api/agents/[id]/%s.js is reachable', (name) => {
		const dest = `${DISPATCHER}/${name}`;
		const candidates = routes
			.slice(0, fsPhase)
			.filter((r) => typeof r.src === 'string' && String(r.dest || '').split('?')[0] === dest);

		expect(
			candidates.length,
			`no route in vercel.json has dest ${dest}, so api/agents/[id]/${name}.js can never run`,
		).toBeGreaterThan(0);

		// Having a route is not enough: an earlier broader route can still win.
		const reachable = candidates.filter((r) => resolve(samplePath(r.src))?.split('?')[0] === dest);
		expect(
			reachable.length,
			`every route for ${dest} is shadowed by a broader route above it (likely ${DISPATCHER}); move it up`,
		).toBeGreaterThan(0);
	});

	it('routes a bundle sub-resource so update and delete can address one bundle', () => {
		// PATCH/DELETE address /api/agents/:id/bundles/:bundleId. Without its own
		// route that path falls to the plain /bundles route, which carries no
		// bundle_id, and the handler answers 405 instead of editing the bundle.
		expect(resolve('/api/agents/agt_abc/bundles/bdl_123')).toBe(
			'/api/agents/[id]/bundles?id=agt_abc&bundle_id=bdl_123',
		);
	});

	it('routes the bundle purchase confirm sub-path', () => {
		// The create call returns Solana Pay params; the client then POSTs the
		// confirm sub-path. Unrouted, it fell through to the generic /api/(.*)
		// rewrite and resolved to a file that does not exist, so a buyer who had
		// already paid on-chain could never claim the skills.
		expect(resolve('/api/marketplace/purchase-bundle/pur_123/confirm')).toBe(
			'/api/marketplace/purchase-bundle?purchase_id=pur_123&op=confirm',
		);
	});

	it('keeps the ens route above the catch-all', () => {
		const ens = routes.findIndex((r) => r.src === '/api/agents/ens/([^/]+)');
		const catchAll = routes.findIndex((r) => r.src === '/api/agents/([^/]+)(?:/.*)?');
		expect(ens).toBeGreaterThan(-1);
		expect(catchAll).toBeGreaterThan(-1);
		expect(ens).toBeLessThan(catchAll);
		// Both must be pre-filesystem, or ordering between them would not matter.
		expect(catchAll).toBeLessThan(fsPhase);
	});
});
