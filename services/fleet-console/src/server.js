#!/usr/bin/env node
/**
 * Fleet Console HTTP server.
 *
 * Routes:
 *   GET  /                    the dashboard, or the scanning state before the first snapshot
 *   GET  /r/:repo             one repository with every measurement behind its score
 *   GET  /docs                how the score is computed and how to embed a badge
 *   GET  /api/fleet           the whole snapshot
 *   GET  /api/repo/:repo      one repository
 *   GET  /api/status          scan progress, safe to poll
 *   GET  /api/attention       only what is broken, ranked, for automation
 *   POST /api/scan            trigger a scan (requires FLEET_SCAN_TOKEN)
 *   GET  /badge/fleet.svg     fleet median badge
 *   GET  /badge/:repo.svg     per-repository health badge
 *   GET  /badge/:repo/deployment.svg
 *   GET  /healthz             liveness
 */

import { createServer } from 'node:http';
import { config } from './config.js';
import { runScan, progress } from './scan.js';
import * as store from './store.js';
import { dashboardPage, scanningPage } from './views/dashboard.js';
import { repoPage, notFoundPage } from './views/repo.js';
import { docsPage } from './views/docs.js';
import { repoBadge, deploymentBadge, fleetBadge } from './badge.js';

const send = (res, status, body, headers = {}) => {
	res.writeHead(status, {
		'content-length': Buffer.byteLength(body),
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'no-referrer',
		...headers
	});
	res.end(body);
};

const html = (res, status, body) => send(res, status, body, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' });

const json = (res, status, value, { maxAge = 60 } = {}) =>
	send(res, status, JSON.stringify(value, null, 2), {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': `public, max-age=${maxAge}`,
		'access-control-allow-origin': '*'
	});

const svg = (res, body) =>
	send(res, 200, body, {
		'content-type': 'image/svg+xml; charset=utf-8',
		// Badges are embedded in READMEs that GitHub proxies; a short TTL keeps them fresh without hammering.
		'cache-control': 'public, max-age=900, s-maxage=900',
		'access-control-allow-origin': '*'
	});

/** Only what is broken, ranked worst first. Built for automation, not for reading. */
function attention(snapshot) {
	const items = [];
	for (const repo of snapshot.repos) {
		for (const deployment of repo.deployments || []) {
			if (deployment.state === 'live' || deployment.state === 'redirected') continue;
			items.push({ repo: repo.name, severity: 'high', kind: 'deployment_down', target: deployment.url, state: deployment.state, detail: deployment.detail || deployment.why });
		}
		for (const name of repo.packages?.missing || []) {
			items.push({ repo: repo.name, severity: 'high', kind: 'package_unpublished', target: name, state: 'not_found', detail: 'advertised for install but absent from the npm registry' });
		}
		for (const link of repo.links || []) {
			if (link.state === 'live' || link.state === 'redirected' || link.state === 'auth_required' || link.state === 'rate_limited') continue;
			items.push({ repo: repo.name, severity: 'low', kind: 'dead_link', target: link.url, state: link.state, detail: link.detail || '' });
		}
		for (const check of repo.checks || []) {
			if (check.status !== 'fail' || check.id === 'deployment' || check.id === 'packages' || check.id === 'links') continue;
			items.push({ repo: repo.name, severity: 'medium', kind: `check_failed:${check.id}`, target: repo.name, state: 'fail', detail: check.fix || check.evidence });
		}
	}
	const rank = { high: 0, medium: 1, low: 2 };
	items.sort((a, b) => rank[a.severity] - rank[b.severity] || a.repo.localeCompare(b.repo));
	return { generatedAt: snapshot.generatedAt, owner: snapshot.owner, count: items.length, items };
}

/** A repository without the noisy full probe payload, for list endpoints. */
const slim = (repo) => ({
	name: repo.name,
	description: repo.description,
	stars: repo.stars,
	language: repo.language,
	score: repo.score,
	grade: repo.grade?.grade || null,
	url: repo.htmlUrl,
	live: (repo.deployments || []).filter((entry) => entry.state === 'live' || entry.state === 'redirected').map((entry) => entry.url),
	broken: (repo.deployments || []).filter((entry) => entry.state !== 'live' && entry.state !== 'redirected').map((entry) => ({ url: entry.url, state: entry.state })),
	unpublishedPackages: repo.packages?.missing || []
});

async function triggerScan(reason) {
	if (progress.running) return;
	try {
		const snapshot = await runScan();
		await store.save(snapshot);
		console.log(`[scan] ${reason}: ${snapshot.repos.length} repos in ${(snapshot.durationMs / 1000).toFixed(1)}s, median ${snapshot.summary.medianScore}`);
	} catch (error) {
		console.error(`[scan] ${reason} failed:`, error?.message || error);
	}
}

const handler = async (req, res) => {
	const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
	const path = url.pathname.replace(/\/+$/, '') || '/';
	const snapshot = store.getSnapshot();

	if (path === '/healthz') {
		return json(res, 200, { ok: true, hasSnapshot: Boolean(snapshot), scanning: progress.running, owner: config.owner }, { maxAge: 0 });
	}

	if (path === '/api/status') {
		return json(res, 200, { hasSnapshot: Boolean(snapshot), generatedAt: snapshot?.generatedAt || null, progress, owner: config.owner, authenticated: Boolean(config.githubToken) }, { maxAge: 0 });
	}

	if (path === '/api/scan') {
		if (req.method !== 'POST') return json(res, 405, { error: 'use POST' }, { maxAge: 0 });
		if (!config.scanToken) return json(res, 403, { error: 'FLEET_SCAN_TOKEN is not configured, so on-demand scans are disabled' }, { maxAge: 0 });
		const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
		if (supplied !== config.scanToken) return json(res, 401, { error: 'bad token' }, { maxAge: 0 });
		if (progress.running) return json(res, 409, { error: 'a scan is already running', progress }, { maxAge: 0 });
		triggerScan('on demand');
		return json(res, 202, { started: true, progress }, { maxAge: 0 });
	}

	if (path === '/badge/fleet.svg') return svg(res, fleetBadge(snapshot));

	const deploymentBadgeMatch = path.match(/^\/badge\/([^/]+)\/deployment\.svg$/);
	if (deploymentBadgeMatch) return svg(res, deploymentBadge(store.findRepo(decodeURIComponent(deploymentBadgeMatch[1]))));

	const badgeMatch = path.match(/^\/badge\/(.+)\.svg$/);
	if (badgeMatch) return svg(res, repoBadge(store.findRepo(decodeURIComponent(badgeMatch[1]))));

	if (path === '/api/fleet') {
		if (!snapshot) return json(res, 503, { error: 'no snapshot yet', progress }, { maxAge: 0 });
		const full = url.searchParams.get('full') === '1';
		return json(res, 200, full ? snapshot : { ...snapshot, repos: snapshot.repos.map(slim) });
	}

	if (path === '/api/attention') {
		if (!snapshot) return json(res, 503, { error: 'no snapshot yet', progress }, { maxAge: 0 });
		return json(res, 200, attention(snapshot));
	}

	const apiRepo = path.match(/^\/api\/repo\/(.+)$/);
	if (apiRepo) {
		const repo = store.findRepo(decodeURIComponent(apiRepo[1]));
		if (!repo) return json(res, 404, { error: 'no such repository in the current snapshot' }, { maxAge: 0 });
		return json(res, 200, { ...repo, history: store.historyFor(repo.name) });
	}

	if (path === '/docs') return html(res, 200, docsPage({ owner: config.owner, snapshot }));

	const repoPath = path.match(/^\/r\/(.+)$/);
	if (repoPath) {
		const name = decodeURIComponent(repoPath[1]);
		const repo = store.findRepo(name);
		if (!repo) return html(res, 404, notFoundPage({ owner: config.owner, name }));
		return html(res, 200, repoPage({ repo, owner: config.owner, history: store.historyFor(repo.name) }));
	}

	if (path === '/') {
		if (!snapshot) return html(res, 200, scanningPage({ owner: config.owner, progress, authenticated: Boolean(config.githubToken) }));
		return html(res, 200, dashboardPage({ snapshot, history: store.getHistory() }));
	}

	return html(res, 404, notFoundPage({ owner: config.owner, name: path.slice(1) }));
};

async function main() {
	await store.load();

	const server = createServer((req, res) => {
		handler(req, res).catch((error) => {
			console.error('[request]', req.method, req.url, error?.message || error);
			if (!res.headersSent) json(res, 500, { error: 'internal error' }, { maxAge: 0 });
			else res.end();
		});
	});

	server.listen(config.port, () => {
		console.log(`[fleet-console] listening on :${config.port} for owner ${config.owner}${config.githubToken ? '' : ' (unauthenticated GitHub access)'}`);
	});

	if (config.scanOnBoot && !store.getSnapshot()) triggerScan('boot');
	if (config.scanIntervalMs > 0) {
		setInterval(() => triggerScan('scheduled'), config.scanIntervalMs).unref?.();
	}

	for (const signal of ['SIGTERM', 'SIGINT']) {
		process.on(signal, () => {
			console.log(`[fleet-console] ${signal}, closing`);
			server.close(() => process.exit(0));
			setTimeout(() => process.exit(0), 8000).unref();
		});
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error('[fleet-console] failed to start:', error);
		process.exit(1);
	});
}

export { handler, attention, slim };
