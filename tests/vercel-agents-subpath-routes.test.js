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
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

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
