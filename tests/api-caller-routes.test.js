/**
 * Every API URL the frontend actually calls must reach the handler that shares
 * its name.
 *
 * `vercel.json`'s `routes` array is ordered and the first terminal match wins,
 * so a handler file can exist, look routed, and never run: an earlier catch-all
 * swallows the path and answers with a DIFFERENT handler's body. Nothing in a
 * diff shows it, and the failure is silent at runtime because the caller
 * usually wraps the fetch in a soft error handler.
 *
 * The live instance this guards (found 2026-08-01): the creator dashboard
 * called `/api/users/earnings`, which `/api/users/([^/]+)` rewrote to the
 * profile handler as a user literally named "earnings". Production answered
 * `{"error":"not_found","error_description":"user not found"}`, the dashboard's
 * `safe()` wrapper discarded it, and the earnings panel was permanently blank
 * with no error anywhere. The handler was fine; only `/api/users/me/earnings`
 * ever reached it.
 *
 * The rule is deliberately narrow, because the broad version is all false
 * positives (see scripts/audit-route-shadowing.mjs, whose report is dominated
 * by them). A path is only a violation when ALL of these hold:
 *   1. frontend source calls it as a literal URL,
 *   2. a handler file exists at exactly that path, and
 *   3. the route table sends it somewhere else, and
 *   4. that somewhere else does NOT visibly dispatch to the name.
 *
 * Condition 4 is what keeps the dispatcher families out. `api/pump/[action].js`
 * handles `case 'balances'` inline, and `api/agents/[id].js` delegates with
 * `import('./portfolio.js')` or `sub === 'capabilities'`; in both the request
 * genuinely arrives, just not at the sibling file. Those are by design, so a
 * dispatcher that mentions the name is treated as reaching it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const routes = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')).routes;
const fsPhase = routes.findIndex((r) => r.handle === 'filesystem');

/** First terminal pre-filesystem match, with $n backreferences substituted. */
function resolveRoute(pathname) {
	for (const route of routes.slice(0, fsPhase)) {
		if (typeof route.src !== 'string') continue;
		let m;
		try {
			m = new RegExp(`^(?:${route.src})$`).exec(pathname);
		} catch {
			continue;
		}
		if (!m || route.continue) continue;
		return String(route.dest || '').replace(/\$(\d)/g, (_, d) => m[Number(d)] ?? '');
	}
	return null;
}

/** Does the handler at `destPath` visibly dispatch to `name`? */
function dispatcherHandles(destPath, name) {
	const file = `${repoRoot}api${destPath.slice(4)}.js`;
	if (!existsSync(file)) return false;
	const src = readFileSync(file, 'utf8');
	return (
		src.includes(`case '${name}'`) ||
		src.includes(`'./${name}.js'`) ||
		src.includes(`sub === '${name}'`)
	);
}

/** Literal /api/... URLs called from browser-facing source, with their caller. */
function collectCalledUrls() {
	const out = [];
	for (const rel of globSync('src/**/*.js', { cwd: repoRoot })) {
		const src = readFileSync(`${repoRoot}${rel}`, 'utf8');
		for (const line of src.split('\n')) {
			const t = line.trimStart();
			if (t.startsWith('//') || t.startsWith('*')) continue;
			// Only a literal path ending at the quote or a query string; anything
			// carrying a ${} interpolation is a template and is skipped.
			for (const m of line.matchAll(/['"`](\/api\/[a-zA-Z0-9._/-]+)(?=[?'"`])/g)) {
				out.push({ url: m[1], caller: rel });
			}
		}
	}
	return out;
}

/** Apply the four conditions above. Exported shape keeps the assertion readable. */
function findShadowedCalls(urls) {
	const seen = new Set();
	const violations = [];
	for (const { url, caller } of urls) {
		if (!existsSync(`${repoRoot}api${url.slice(4)}.js`)) continue;
		const dest = resolveRoute(url);
		if (!dest || dest.startsWith(url)) continue;
		const destPath = dest.split('?')[0];
		const name = url.split('/').pop();
		if (dispatcherHandles(destPath, name)) continue;
		if (seen.has(url)) continue;
		seen.add(url);
		violations.push({ url, destPath, caller });
	}
	return violations;
}

describe('API URLs the frontend calls reach their own handler', () => {
	it('finds no called-but-shadowed endpoint', () => {
		const violations = findShadowedCalls(collectCalledUrls());
		const detail = violations
			.map((v) => `${v.url} → ${v.destPath} (called by ${v.caller})`)
			.join('\n  ');
		expect(violations, `called endpoints answered by a different handler:\n  ${detail}`).toEqual([]);
	});

	it('still catches the outage it was written for', () => {
		// The rule is only worth having if it fails on the real defect, so the
		// fixed URL is replayed here as a synthetic caller. If a future refactor
		// makes this pass, the test above has quietly stopped guarding anything.
		const violations = findShadowedCalls([
			{ url: '/api/users/earnings', caller: 'synthetic-regression-probe' },
		]);
		expect(violations).toHaveLength(1);
		expect(violations[0].destPath).toBe('/api/users/[username]');
	});

	it('does not flag dispatcher families that handle the name themselves', () => {
		// /api/pump/balances is rewritten to api/pump/[action].js, which serves it
		// from an inline `case 'balances'`. Reaching a dispatcher is not a defect.
		expect(findShadowedCalls([{ url: '/api/pump/balances', caller: 'probe' }])).toEqual([]);
		expect(dispatcherHandles('/api/pump/[action]', 'balances')).toBe(true);
	});
});
