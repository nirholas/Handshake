#!/usr/bin/env node
// Assert every page declared in data/pages.json is actually reachable.
//
// data/pages.json is the source of the sitemap, llms.txt and features.json, so
// anything listed there is advertised to crawlers and to users the moment it
// lands. Nothing checked that the page could actually be served, and two have
// shipped as hard 404s in three days: /timeline (fixed by 5688277bd) and
// /tracker (advertised 2026-07-23, 404 until a route landed two days later).
// Both had a built dist/<slug>.html and no vercel.json rewrite, and
// server/index.mjs deliberately has no `.html` extension fallback.
//
// Two modes:
//   node scripts/check-pages.mjs                 resolve against the local dist/
//   node scripts/check-pages.mjs --base <url>    sweep a live deployment
//
// The local mode runs in `build:gcp` (before the image is built) and turns an
// unreachable page into a red build. The --base mode runs after a deploy, where
// it also catches CDN and revision problems the build cannot see.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectDeclaredPaths, loadRouteTable, resolveRequest } from './lib/page-routing.mjs';
import { canonicalOf, canonicalUrlFor, hasSeoRoute } from '../server/seo-head.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const readFlag = (name) => {
	const i = argv.indexOf(name);
	return i === -1 ? null : argv[i + 1];
};
const base = readFlag('--base');
const concurrency = Number(readFlag('--concurrency') || 12);
const timeoutMs = Number(readFlag('--timeout') || 20000);

const paths = collectDeclaredPaths(root);
if (paths.length === 0) {
	console.error('[check-pages] no paths found in data/pages.json');
	process.exit(1);
}

const failures = [];
// A 200 that served somebody else's page. Tracked apart from `failures`
// because the fix is different: the route resolves, the content behind it does
// not exist. See the shared-shell note in the worker below.
const wrongPage = [];

// How far the running deployment trails the checkout, when both are knowable.
// Returns a one-line human summary, or null when it cannot be established (no
// /api/version, no git, an unrelated checkout): a diagnostic must never turn a
// real failure report into an error of its own.
async function deployLagReport(target) {
	let liveCommit = null;
	try {
		const res = await fetch(`${target}/api/version`, {
			signal: AbortSignal.timeout(timeoutMs),
			headers: { 'user-agent': 'three.ws-check-pages' },
		});
		if (!res.ok) return null;
		liveCommit = (await res.json())?.commit || null;
	} catch {
		return null;
	}
	if (!liveCommit) return null;

	const { execFileSync } = await import('node:child_process');
	const git = (args) =>
		execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	try {
		git(['cat-file', '-e', `${liveCommit}^{commit}`]);
		const behind = Number(git(['rev-list', '--count', `${liveCommit}..HEAD`]));
		if (!Number.isFinite(behind) || behind <= 0) {
			return `The running revision (${liveCommit.slice(0, 9)}) is up to date with this checkout, so the failures above are real routing bugs, not deploy lag.`;
		}
		return (
			`The running revision (${liveCommit.slice(0, 9)}) is ${behind} commit(s) behind this checkout. ` +
			`A page whose route landed in one of those commits is deploy lag, not a routing bug: deploy, then re-run. ` +
			`Check one with: git merge-base --is-ancestor <route-commit> ${liveCommit.slice(0, 9)}`
		);
	} catch {
		return null;
	}
}

if (base) {
	const target = base.replace(/\/$/, '');
	let done = 0;
	let verified = 0;
	const queue = [...paths];

	const worker = async () => {
		for (;;) {
			const p = queue.shift();
			if (p === undefined) return;
			const url = `${target}${p}`;
			let status = 0;
			let note = '';
			try {
				const res = await fetch(url, {
					redirect: 'manual',
					signal: AbortSignal.timeout(timeoutMs),
					headers: { 'user-agent': 'three.ws-check-pages' },
				});
				status = res.status;
				if (status >= 300 && status < 400) note = `→ ${res.headers.get('location') || '(no location)'}`;
				// A 200 is not proof the requested page was served. /docs/* and
				// /tutorials/* (about 300 declared routes) all rewrite to one
				// shared shell, so a slug with no content behind it answers 200
				// with the shell's own head rather than a 404, and a status-only
				// sweep reads that as reachable. The server's contract for a
				// catalogued page is that the head names that page
				// (server/seo-head.mjs rewrites it when the shell does not), so
				// assert exactly that, reusing the server's own predicate and
				// canonical builder so this check cannot drift from the rule.
				// Caught /docs/tokens-xyz serving the generic docs shell while
				// /docs/tokens-xyz.md was still a hard 404 in production.
				if (status >= 200 && status < 300 && hasSeoRoute(p)) {
					const type = res.headers.get('content-type') || '';
					if (type.includes('text/html')) {
						const served = canonicalOf(await res.text());
						const want = canonicalUrlFor(p);
						if (served === want) verified += 1;
						else wrongPage.push({ path: p, served, want });
					}
				}
				// A paid endpoint answering 402 IS reachable: the payment
				// challenge is its correct response to an unpaid request, and
				// /api/mcp has flagged on every production sweep because of it.
				// Verified by SHAPE rather than by an allowlist of paid paths,
				// so a route that starts charging needs no edit here, while a
				// bare 402 with no challenge in it still fails.
				if (status === 402) {
					const challenge = await res.json().catch(() => null);
					if (challenge && (challenge.x402Version || challenge.accepts)) {
						status = 200;
						note = 'x402 payment challenge';
					} else {
						note = '402 without a readable x402 challenge';
					}
				}
			} catch (err) {
				note = err.name === 'TimeoutError' ? 'timeout' : err.message;
			}
			// 2xx and 3xx are both reachable. A redirect that resolves is how
			// /blog (301 → /changelog) is meant to behave.
			if (!(status >= 200 && status < 400)) failures.push({ path: p, status, note });
			done += 1;
			if (done % 50 === 0) console.log(`[check-pages] ${done}/${paths.length}…`);
		}
	};

	console.log(`[check-pages] sweeping ${paths.length} declared pages against ${target}`);
	await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));

	if (failures.length || wrongPage.length) {
		if (failures.length) {
			console.error(`\n[check-pages] ${failures.length} unreachable page(s) on ${target}:`);
			for (const f of failures.sort((a, b) => a.path.localeCompare(b.path))) {
				console.error(`[check-pages]   ${String(f.status || 'ERR').padEnd(4)} ${f.path} ${f.note}`);
			}
		}
		if (wrongPage.length) {
			console.error(
				`\n[check-pages] ${wrongPage.length} page(s) answered 200 with another page's content on ${target}:`,
			);
			console.error('[check-pages] Each is advertised in the sitemap and llms.txt but is not actually served.');
			for (const f of wrongPage.sort((a, b) => a.path.localeCompare(b.path))) {
				console.error(`[check-pages]   ${f.path}`);
				console.error(`[check-pages]     served canonical: ${f.served ?? '(none)'}`);
				console.error(`[check-pages]     expected:         ${f.want}`);
			}
		}
		// Separate "the code is broken" from "the deployment is behind the code".
		// A page whose route landed in a commit the running image predates is a
		// deploy lag, not a routing bug, and reads identically as a bare 404 in
		// the sweep above. Saying which one it is here saves the next reader the
		// same investigation (this misfired on /wardrobe, whose route was 48
		// commits ahead of the running revision).
		const lag = await deployLagReport(target);
		if (lag) console.error(`\n[check-pages] ${lag}`);
		process.exit(1);
	}
	console.log(
		`[check-pages] OK - all ${paths.length} declared pages reachable on ${target} ` +
			`(${verified} also verified to serve their own page, not a shared shell)`,
	);
} else {
	const distRoot = path.join(root, 'dist');
	if (!existsSync(distRoot)) {
		console.error('[check-pages] dist/ not found — run `npm run build` first');
		process.exit(1);
	}
	const table = loadRouteTable(root);
	const counts = { static: 0, api: 0, redirect: 0, external: 0, notfound: 0 };

	for (const p of paths) {
		const r = resolveRequest(p, table, distRoot);
		counts[r.outcome] += 1;
		if (r.outcome === 'notfound') failures.push({ path: p, target: r.target });
	}

	if (failures.length) {
		console.error(
			`\n[check-pages] ${failures.length} declared page(s) resolve to a 404 in this build.`,
		);
		console.error('[check-pages] Each is advertised in the sitemap and llms.txt but cannot be served.');
		console.error(
			'[check-pages] Fix: add a vercel.json rewrite (e.g. {"src":"/slug/?","dest":"/slug.html"})',
		);
		console.error('[check-pages] and make sure the page is a vite input entry so dist/slug.html is built.\n');
		for (const f of failures.sort((a, b) => a.path.localeCompare(b.path))) {
			const built = existsSync(path.join(distRoot, `${f.path.replace(/^\//, '')}.html`));
			const why = built
				? 'dist/*.html exists but no rewrite maps the clean URL to it'
				: 'not built into dist/ (missing vite input entry?)';
			console.error(`[check-pages]   ${f.path}  —  ${why}`);
		}
		process.exit(1);
	}

	console.log(
		`[check-pages] OK — all ${paths.length} declared pages resolve ` +
			`(${counts.static} static, ${counts.api} api, ${counts.redirect} redirect, ${counts.external} external)`,
	);
}
