// Unit tests for scripts/lib/audit-routes.mjs, the single route list every
// browser sweep works from.
//
// AUTHED_ROUTES used to be a hand-kept array, and it went stale without any
// signal: by 2026-09-04 ten of its eighteen entries had become 301 stubs
// pointing at consolidated dashboard pages, so the authenticated sweep spent
// a third of its budget auditing empty redirects while twenty-one live
// dashboard pages were never audited under a session at all. It is now
// derived from the vercel.json route table, and these tests hold that
// derivation to the properties that made the drift invisible.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUTHED_ROUTES, isHtmlRoute } from '../scripts/lib/audit-routes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routeTable = JSON.parse(readFileSync(resolve(ROOT, 'vercel.json'), 'utf8')).routes;

/** Route-table entries that answer a request with a Location redirect. */
const redirectSources = new Set(
	routeTable
		.filter((r) => typeof r.src === 'string' && (r.status || r.headers?.Location))
		.map((r) => r.src.replace(/\/\?$/, '')),
);

describe('AUTHED_ROUTES', () => {
	it('is a non-empty, deduped, sorted list of absolute paths', () => {
		expect(AUTHED_ROUTES.length).toBeGreaterThan(0);
		expect(new Set(AUTHED_ROUTES).size).toBe(AUTHED_ROUTES.length);
		expect([...AUTHED_ROUTES].sort()).toEqual(AUTHED_ROUTES);
		for (const path of AUTHED_ROUTES) expect(path.startsWith('/')).toBe(true);
	});

	it('holds no redirect stub: a 301 has no DOM worth auditing', () => {
		const stubs = AUTHED_ROUTES.filter((path) => redirectSources.has(path));
		expect(stubs).toEqual([]);
	});

	it('holds no route pattern, only concrete addressable paths', () => {
		for (const path of AUTHED_ROUTES) {
			expect(path).not.toMatch(/[()[\]*+|^$\\?]/);
			expect(path).not.toMatch(/\/$/);
		}
	});

	it('holds only routes an HTML sweep can render', () => {
		for (const path of AUTHED_ROUTES) expect(isHtmlRoute(path)).toBe(true);
	});

	it('covers every concrete dashboard page the route table serves', () => {
		const served = routeTable
			.filter((r) => typeof r.src === 'string' && r.dest && !r.status && !r.headers?.Location)
			.map((r) => r.src.replace(/\/\?$/, ''))
			.filter((src) => src.startsWith('/dashboard/') && !/[()[\]*+|^$\\?]/.test(src));
		expect(served.length).toBeGreaterThan(0);
		for (const path of served) expect(AUTHED_ROUTES).toContain(path);
	});

	it('carries the account surfaces that live outside the dashboard block', () => {
		for (const path of ['/profile', '/settings', '/my-agents']) {
			expect(AUTHED_ROUTES).toContain(path);
		}
	});
});
