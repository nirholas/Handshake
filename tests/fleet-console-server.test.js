/**
 * Core-path smoke test for the fleet console service (services/fleet-console).
 *
 * The sibling suite (tests/fleet-console.test.js) covers the pure pieces in
 * isolation. This one exercises the path a user actually takes: a snapshot on
 * disk, the store loading it, the real HTTP handler on a real socket, and every
 * route answering with the right status, content type and content. Nothing is
 * mocked. The only synthetic input is the probe results inside the snapshot,
 * because a unit suite cannot reach the live internet, and everything derived
 * from them (scores, summary, attention ranking, badges, HTML) is produced by
 * the service's own code.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

// config.js snapshots the environment at import time, so the data directory has
// to be pointed at a scratch path before anything in the service is loaded.
const dataDir = await mkdtemp(join(tmpdir(), 'fleet-console-test-'));
process.env.FLEET_DATA_DIR = dataDir;
process.env.FLEET_SCAN_ON_BOOT = 'false';
process.env.FLEET_SCAN_INTERVAL_MS = '0';
process.env.FLEET_OWNER = 'test-owner';
delete process.env.FLEET_SCAN_TOKEN;

const store = await import('../services/fleet-console/src/store.js');
const { handler } = await import('../services/fleet-console/src/server.js');
const { scoreRepo, summarise } = await import('../services/fleet-console/src/score.js');
const { partialReasons } = await import('../services/fleet-console/src/scan.js');

const probe = (url, state) => ({
	url,
	state,
	status: state === 'live' ? 200 : state === 'not_found' ? 404 : null,
	ms: 21,
	finalUrl: url,
	redirected: false,
	detail: ''
});

/** Two repositories built by the service's own scorer, one healthy and one not. */
function buildSnapshot() {
	const gathered = [
		{
			name: 'healthy-widget',
			fullName: 'test-owner/healthy-widget',
			description: 'A widget that keeps its promises',
			htmlUrl: 'https://github.com/test-owner/healthy-widget',
			stars: 42,
			language: 'JavaScript',
			topics: ['widget', 'cli', 'node'],
			license: 'MIT',
			pushedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
			readmeBytes: 5200,
			hasDocsDir: true,
			packageVersion: '1.4.0',
			deployments: [probe('https://healthy-widget.example.dev/', 'live')],
			links: [probe('https://spec.example.org/v1', 'live')],
			packages: {
				checked: [{ name: 'healthy-widget', published: true, latest: '1.4.0', deprecated: false, role: 'manifest' }],
				missing: [],
				ownPackage: { name: 'healthy-widget', published: true, latest: '1.4.0' }
			}
		},
		{
			name: 'broken-widget',
			fullName: 'test-owner/broken-widget',
			description: '',
			htmlUrl: 'https://github.com/test-owner/broken-widget',
			stars: 7,
			language: 'TypeScript',
			topics: [],
			license: '',
			pushedAt: new Date(Date.now() - 800 * 86400000).toISOString(),
			readmeBytes: 220,
			hasDocsDir: false,
			packageVersion: '0.1.0',
			deployments: [probe('https://broken-widget.example.dev/', 'not_found')],
			links: [probe('https://gone.example.dev/', 'dns_failure')],
			packages: {
				checked: [{ name: 'broken-widget', published: false, latest: '', deprecated: false, role: 'manifest' }],
				missing: ['broken-widget'],
				ownPackage: { name: 'broken-widget', published: false, latest: '' }
			}
		}
	];

	const repos = gathered.map((repo) => ({ ...repo, ...scoreRepo(repo) }));
	return {
		owner: 'test-owner',
		generatedAt: new Date().toISOString(),
		durationMs: 4200,
		partial: true,
		partialReason: 'repo_cap',
		totalOwned: 9,
		authenticated: true,
		rateLimit: { limit: 5000, remaining: 4900, resetAt: new Date(Date.now() + 600000).toISOString() },
		summary: summarise(repos),
		repos
	};
}

let base = '';
let server = null;

const get = (path, init) => fetch(`${base}${path}`, init);

beforeAll(async () => {
	await store.load();
	server = createServer((req, res) => {
		handler(req, res).catch(() => {
			if (!res.headersSent) res.writeHead(500);
			res.end();
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
	if (server) await new Promise((resolve) => server.close(resolve));
	await rm(dataDir, { recursive: true, force: true });
});

describe('before the first scan', () => {
	it('is alive and says so, without claiming to have data', async () => {
		const res = await get('/healthz');
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, hasSnapshot: false, owner: 'test-owner' });
	});

	it('serves the scanning state rather than an empty dashboard', async () => {
		const res = await get('/');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/html');
		const body = await res.text();
		expect(body).toContain('<!doctype html>');
		expect(body.toLowerCase()).toContain('scan');
	});

	it('tells an API client there is nothing to read yet instead of returning an empty fleet', async () => {
		for (const path of ['/api/fleet', '/api/attention']) {
			const res = await get(path);
			expect(res.status, path).toBe(503);
			expect((await res.json()).error).toBeTruthy();
		}
	});

	it('renders a badge that admits it has no measurement', async () => {
		const res = await get('/badge/fleet.svg');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('image/svg+xml');
		expect(await res.text()).toContain('not scanned');
	});
});

describe('a stored snapshot, served', () => {
	beforeAll(async () => {
		await store.save(buildSnapshot());
	});

	it('persists the snapshot to disk and reloads it, so a restart is not an outage', async () => {
		const reloaded = await store.load();
		expect(reloaded.owner).toBe('test-owner');
		expect(reloaded.repos).toHaveLength(2);
		expect(store.findRepo('HEALTHY-WIDGET').name).toBe('healthy-widget');
	});

	it('reports the whole fleet in slim form, and the full measurements on request', async () => {
		const slimRes = await get('/api/fleet');
		expect(slimRes.status).toBe(200);
		const slimBody = await slimRes.json();
		expect(slimBody.summary.repos).toBe(2);
		expect(slimBody.repos.map((repo) => repo.name).sort()).toEqual(['broken-widget', 'healthy-widget']);
		expect(slimBody.repos[0].checks).toBeUndefined();

		const fullBody = await (await get('/api/fleet?full=1')).json();
		expect(fullBody.repos.every((repo) => Array.isArray(repo.checks) && repo.checks.length > 0)).toBe(true);
	});

	it('ranks what is broken worst first, with a fix on every item', async () => {
		const res = await get('/api/attention');
		expect(res.status).toBe(200);
		const report = await res.json();
		expect(report.count).toBeGreaterThan(0);
		expect(report.items[0].severity).toBe('high');
		expect(report.items.map((item) => item.kind)).toContain('deployment_down');
		expect(report.items.map((item) => item.kind)).toContain('package_unpublished');
		expect(report.items.every((item) => item.repo && item.target)).toBe(true);
	});

	it('serves one repository with its history, and 404s a name it never scanned', async () => {
		const res = await get('/api/repo/broken-widget');
		expect(res.status).toBe(200);
		const repo = await res.json();
		expect(repo.score).toBeLessThan(60);
		expect(repo.checks.find((check) => check.id === 'packages').status).toBe('fail');
		expect(repo.history.at(-1)).toMatchObject({ score: repo.score });

		expect((await get('/api/repo/never-existed')).status).toBe(404);
	});

	it('renders the dashboard with every repository on it', async () => {
		const res = await get('/');
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain('healthy-widget');
		expect(body).toContain('broken-widget');
		expect(body).toContain('test-owner');
	});

	it('names the real reason a scan was partial instead of blaming the rate limit', async () => {
		const body = await (await get('/')).text();
		expect(body).toContain('Partial scan.');
		expect(body).toContain('FLEET_MAX_REPOS');
		expect(body).not.toContain('rate-limit budget');
	});

	it('renders a repository page, and a 404 page for one that was never scanned', async () => {
		const res = await get('/r/healthy-widget');
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain('healthy-widget.example.dev');
		expect(res.headers.get('content-type')).toContain('text/html');

		const missing = await get('/r/never-existed');
		expect(missing.status).toBe(404);
		expect(await missing.text()).toContain('never-existed');
	});

	it('explains the scoring model on its own docs page', async () => {
		const res = await get('/docs');
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('<!doctype html>');
	});

	it('serves fleet, repository and deployment badges as cacheable SVG', async () => {
		for (const path of ['/badge/fleet.svg', '/badge/healthy-widget.svg', '/badge/broken-widget/deployment.svg']) {
			const res = await get(path);
			expect(res.status, path).toBe(200);
			expect(res.headers.get('content-type'), path).toContain('image/svg+xml');
			expect(res.headers.get('cache-control'), path).toContain('max-age');
			const body = await res.text();
			expect(body.startsWith('<svg'), path).toBe(true);
			expect(body.trim().endsWith('</svg>'), path).toBe(true);
		}
		expect(await (await get('/badge/broken-widget/deployment.svg')).text()).toContain('0/1 live');
	});

	it('reports scan progress on a pollable endpoint that is never cached', async () => {
		const res = await get('/api/status');
		expect(res.headers.get('cache-control')).toContain('max-age=0');
		const body = await res.json();
		expect(body).toMatchObject({ hasSnapshot: true, owner: 'test-owner' });
		expect(body.progress.running).toBe(false);
	});

	it('refuses on-demand scans while no scan token is configured, and rejects the wrong method', async () => {
		expect((await get('/api/scan', { method: 'POST' })).status).toBe(403);
		expect((await get('/api/scan')).status).toBe(405);
	});

	it('answers an unknown path with a 404 page rather than a stack trace', async () => {
		const res = await get('/not/a/route');
		expect(res.status).toBe(404);
		expect(await res.text()).toContain('<!doctype html>');
	});

	it('allows a browser on another origin to read the JSON surfaces', async () => {
		expect((await get('/api/fleet')).headers.get('access-control-allow-origin')).toBe('*');
	});
});

describe('why a scan covered less than the fleet', () => {
	const snapshot = (overrides) => ({
		partial: true,
		authenticated: true,
		summary: { repos: 6 },
		totalOwned: 189,
		rateLimit: { resetAt: '2026-08-11T06:00:00.000Z' },
		...overrides
	});

	it('says nothing at all about a complete scan', () => {
		expect(partialReasons({ partial: false, summary: { repos: 9 }, totalOwned: 9 })).toEqual([]);
		expect(partialReasons(null)).toEqual([]);
	});

	it('blames the repository cap, not GitHub, when the cap is what stopped the scan', () => {
		const [reason, ...rest] = partialReasons(snapshot({ partialReason: 'repo_cap' }));
		expect(rest).toEqual([]);
		expect(reason).toContain('FLEET_MAX_REPOS');
		expect(reason).toContain('6 most-starred of 189');
		expect(reason).not.toMatch(/rate|budget/i);
	});

	it('blames the request budget when that is what ran out', () => {
		const reasons = partialReasons(snapshot({ partialReason: 'rate_limit', totalOwned: 6 }));
		expect(reasons).toHaveLength(1);
		expect(reasons[0]).toContain('request budget ran out');
		expect(reasons[0]).toContain('2026-08-11T06:00:00.000Z');
	});

	it('points an unauthenticated operator at the token that would fix it', () => {
		const [reason] = partialReasons(snapshot({ partialReason: 'rate_limit', authenticated: false, totalOwned: 6 }));
		expect(reason).toContain('GITHUB_TOKEN');
	});

	it('still says something honest about a snapshot written before the reason was recorded', () => {
		const reasons = partialReasons(snapshot({ totalOwned: 6 }));
		expect(reasons).toEqual(['6 of 6 repositories were scanned.']);
	});

	it('reports both causes when both applied, so half a fix is not mistaken for a whole one', () => {
		const reasons = partialReasons(snapshot({ partialReason: 'rate_limit' }));
		expect(reasons).toHaveLength(2);
		expect(reasons[0]).toContain('request budget');
		expect(reasons[1]).toContain('FLEET_MAX_REPOS');
	});
});
