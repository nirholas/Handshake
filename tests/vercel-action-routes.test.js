import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';

// Guards against a real production outage class: a nested dynamic API function
// `api/<dir>/[action].js` ships to Vercel but has NO route in vercel.json's
// legacy `routes` array, so the path falls through to `handle: filesystem`,
// matches nothing, and Vercel serves the styled HTML 404 page — the function is
// deployed but unreachable. This silently broke EVM/Solana wallet sign-in
// (/api/auth/siwe, /api/auth/siws), session management (/api/auth/session),
// token launch (/api/agents/tokens), agent payments, on-chain tx prep/confirm,
// checkout, and live-walk control — every one returned the 404 page in prod.
//
// Unlike single-segment functions (api/<dir>/[action].js, caught by a top-level
// `/api/<dir>/([^/]+)` rewrite), NESTED functions (api/<a>/<b>/[action].js) each
// need their own explicit route mapping. Two valid styles exist and both count
// as covered here:
//   · generic capture  — src "/api/a/b/([^/]+)"  dest "/api/a/b/[action]?action=$1"
//   · per-action lines — src "/api/a/b/([...])/x" dest "/api/a/b/[action]?...=x"
// Either way the dest path lands inside the function's own directory, so a
// function is "routed" iff some route's dest (sans query) begins with its dir.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

// Path part of every route dest, e.g. "/api/auth/siwe/[action]?action=$1" → "/api/auth/siwe/[action]".
const destPaths = (vercel.routes || [])
	.map((r) => (typeof r.dest === 'string' ? r.dest.split('?')[0] : null))
	.filter(Boolean);

// Every nested dynamic function: api/<seg>/<seg...>/[action].js (≥2 dir segments).
const nestedActionFns = globSync('api/**/[[]action].js', { cwd: repoRoot })
	.map((file) => {
		const dir = file.slice('api/'.length).replace(/\/\[action\]\.js$/, ''); // e.g. "auth/siwe"
		return { file, dir, segments: dir.split('/').length };
	})
	.filter((fn) => fn.segments >= 2);

function isRouted(dir) {
	const prefix = `/api/${dir}/`;
	return destPaths.some((d) => d.startsWith(prefix));
}

describe('vercel.json routes cover every nested [action] function', () => {
	it('discovers the nested dynamic API functions', () => {
		// Sanity: the glob must actually find functions, or the guard is vacuous.
		expect(nestedActionFns.length).toBeGreaterThan(5);
	});

	it.each(nestedActionFns)('$dir/[action].js is reachable via a vercel.json route', ({ dir }) => {
		expect(
			isRouted(dir),
			`api/${dir}/[action].js has no route in vercel.json — it will 404 in production. ` +
				`Add { "src": "/api/${dir}/([^/]+)", "dest": "/api/${dir}/[action]?action=$1" }.`,
		).toBe(true);
	});

	it('the specific endpoints from the routing outage are all covered', () => {
		const mustRoute = [
			'auth/siwe',
			'auth/siws',
			'auth/session',
			'agents/onchain',
			'agents/payments',
			'agents/tokens',
			'payments/solana',
			'payments/evm',
			'tx/solana',
			'walk/control',
		];
		const missing = mustRoute.filter((d) => !isRouted(d));
		expect(missing, `unreachable in production: ${missing.join(', ')}`).toEqual([]);
	});
});
