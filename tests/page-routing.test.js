/**
 * Page reachability guard — unit tests.
 *
 * scripts/check-pages.mjs gates `build:gcp` on "every path in data/pages.json
 * can actually be served". These tests cover the resolver behind it against a
 * synthetic dist/ built in a temp dir, so they assert the exact regression that
 * shipped twice in production:
 *
 *   /timeline  fixed by 5688277bd ("page shipped without a route entry")
 *   /tracker   advertised in data/pages.json 2026-07-23, 404 for two days
 *
 * Both had a built dist/<slug>.html and no vercel.json rewrite. server's
 * resolveStatic() has no `.html` extension fallback, so the clean URL 404s.
 * The `notfound` assertions below are the ones that matter — if someone adds an
 * extension fallback to the resolver, these fail loudly rather than silently
 * making the guard useless.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
	loadRouteTable,
	resolveRequest,
	resolveStatic,
	collectDeclaredPaths,
} from '../scripts/lib/page-routing.mjs';

let root;
let distRoot;
let table;

const writeVercel = (routes) =>
	writeFileSync(path.join(root, 'vercel.json'), JSON.stringify({ routes }));

beforeAll(() => {
	root = mkdtempSync(path.join(tmpdir(), 'page-routing-'));
	distRoot = path.join(root, 'dist');
	mkdirSync(distRoot, { recursive: true });

	// A built page (no rewrite yet) — the /tracker and /timeline shape.
	writeFileSync(path.join(distRoot, 'tracker.html'), '<html>tracker</html>');
	// A page reachable as a directory index.
	mkdirSync(path.join(distRoot, 'changelog'), { recursive: true });
	writeFileSync(path.join(distRoot, 'changelog', 'index.html'), '<html>changelog</html>');
	writeFileSync(path.join(distRoot, 'home.html'), '<html>home</html>');
	writeFileSync(path.join(distRoot, '404.html'), '<html>404</html>');

	mkdirSync(path.join(root, 'data'), { recursive: true });
	writeFileSync(
		path.join(root, 'data', 'pages.json'),
		JSON.stringify({
			groups: [
				{ pages: [{ path: '/tracker' }, { path: '/changelog' }] },
				{ nested: { deeper: [{ path: '/tracker' }, { path: '/api/thing' }] } },
			],
		}),
	);

	writeVercel([
		{ src: '/', dest: '/home.html' },
		{ src: '/changelog', dest: '/changelog/index.html' },
		{ src: '/chat', status: 301 },
		{ src: '/api/(.*)', dest: '/api/$1' },
		{ src: '/ingest/(.*)', dest: 'https://example.com/$1' },
		{ src: '/og/(.*)', dest: '/og.html', has: [{ type: 'header', key: 'user-agent', value: 'bot' }] },
		{ handle: 'filesystem' },
		{ src: '/(?!_vercel/).*', status: 404, dest: '/404.html' },
	]);
	table = loadRouteTable(root);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('loadRouteTable', () => {
	it('splits the table at the filesystem marker', () => {
		expect(table.phase1).toHaveLength(6);
		expect(table.postFs).toHaveLength(1);
	});
});

describe('resolveStatic', () => {
	it('serves an exact file', () => {
		expect(resolveStatic(distRoot, '/tracker.html')).toContain('tracker.html');
	});

	it('falls back to index.html for a directory', () => {
		expect(resolveStatic(distRoot, '/changelog')).toContain(path.join('changelog', 'index.html'));
	});

	it('does NOT append .html to a bare path (the bug that shipped twice)', () => {
		expect(resolveStatic(distRoot, '/tracker')).toBeNull();
	});

	it('refuses traversal outside dist', () => {
		expect(resolveStatic(distRoot, '/../vercel.json')).toBeNull();
	});
});

describe('resolveRequest', () => {
	it('flags a built page with no rewrite as unreachable', () => {
		// Exactly the /timeline and /tracker production regression.
		expect(resolveRequest('/tracker', table, distRoot).outcome).toBe('notfound');
	});

	it('resolves the page once a rewrite is added', () => {
		writeVercel([
			{ src: '/tracker/?', dest: '/tracker.html' },
			{ handle: 'filesystem' },
			{ src: '/(?!_vercel/).*', status: 404, dest: '/404.html' },
		]);
		const fixed = loadRouteTable(root);
		const r = resolveRequest('/tracker', fixed, distRoot);
		expect(r.outcome).toBe('static');
		expect(r.target).toContain('tracker.html');
		writeVercel([
			{ src: '/', dest: '/home.html' },
			{ src: '/changelog', dest: '/changelog/index.html' },
			{ src: '/chat', status: 301 },
			{ src: '/api/(.*)', dest: '/api/$1' },
			{ src: '/ingest/(.*)', dest: 'https://example.com/$1' },
			{ src: '/og/(.*)', dest: '/og.html', has: [{ type: 'header', key: 'user-agent', value: 'bot' }] },
			{ handle: 'filesystem' },
			{ src: '/(?!_vercel/).*', status: 404, dest: '/404.html' },
		]);
	});

	it('classifies a rewrite to /api/ as server-rendered, not a 404', () => {
		expect(resolveRequest('/api/thing', table, distRoot).outcome).toBe('api');
	});

	it('classifies a status-only rule as a redirect', () => {
		expect(resolveRequest('/chat', table, distRoot)).toMatchObject({
			outcome: 'redirect',
			status: 301,
		});
	});

	it('classifies an external dest as a proxy, not a 404', () => {
		expect(resolveRequest('/ingest/e', table, distRoot).outcome).toBe('external');
	});

	it('resolves a directory index through a rewrite', () => {
		expect(resolveRequest('/changelog', table, distRoot).outcome).toBe('static');
	});

	it('serves / from the home.html rewrite', () => {
		expect(resolveRequest('/', table, distRoot).outcome).toBe('static');
	});

	it('ignores has[]-gated rules, which do not fire for an anonymous visitor', () => {
		// The OG rewrite only fires for social bots; a real visitor still 404s,
		// so the guard must not count it as reachable.
		expect(resolveRequest('/og/x', table, distRoot).outcome).toBe('notfound');
	});
});

describe('collectDeclaredPaths', () => {
	it('walks nested structures and dedupes', () => {
		const paths = collectDeclaredPaths(root);
		expect(paths).toEqual(['/tracker', '/changelog', '/api/thing']);
	});
});
