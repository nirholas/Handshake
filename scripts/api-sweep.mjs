#!/usr/bin/env node
/**
 * api-sweep.mjs - live liveness sweep of the entire API surface.
 *
 * The browser page audit only exercises the API endpoints that pages happen to
 * call on load. This script closes the rest of the gap: it enumerates every
 * handler file under api/ (the deployed route surface), issues a single
 * read-only GET against the live target, and classifies the result:
 *
 *   error  - HTTP 5xx, or unreachable after a retry (the endpoint is broken)
 *   warn   - HTTP 404 for a handler that exists on disk (route-table drift:
 *            the code shipped but no route serves it)
 *   ok     - anything else. 401/403 (auth required), 402 (x402 payment
 *            required), 405 (POST-only), 400 (missing params) all prove the
 *            handler is alive and answering.
 *
 * Safety: strictly GET, and side-effectful-on-GET surfaces are excluded
 * (cron endpoints run real jobs when hit; webhooks/oauth callbacks are not
 * ours to poke). Dynamic [param] handlers are skipped and counted, never
 * guessed. Every exclusion is listed in the report - no silent gaps.
 *
 * Usage:
 *   node scripts/api-sweep.mjs                        # against https://three.ws
 *   BASE_URL=http://localhost:3000 node scripts/api-sweep.mjs
 *   node scripts/api-sweep.mjs --concurrency 24
 *   node scripts/api-sweep.mjs --strict               # exit 1 on any error
 */
import { readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL = (process.env.BASE_URL || 'https://three.ws').replace(/\/$/, '');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, fb) => {
	const i = argv.indexOf(`--${n}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : fb;
};
const STRICT = flag('strict');
const CONCURRENCY = Math.max(1, Number(opt('concurrency', 16)) || 16);
const TIMEOUT_MS = 20000;

// GET on these does real work or belongs to a third party. Never probed.
const SIDE_EFFECT = [
	/^\/api\/cron\//,
	/webhook/i,
	/callback/i,
	/oauth/i,
	/logout/i,
	/unsubscribe/i,
	/\/telegram\//i,
];

function enumerateRoutes() {
	const routes = [];
	const dynamic = [];
	const walk = (dir) => {
		for (const e of readdirSync(dir)) {
			const full = resolve(dir, e);
			const st = statSync(full);
			if (st.isDirectory()) {
				// _lib / _providers / _mcp helpers are imports, not routes.
				if (e.startsWith('_') || e === 'node_modules') continue;
				walk(full);
				continue;
			}
			if (!/\.(js|mjs)$/.test(e)) continue;
			// Underscore-prefixed files are shared helpers, not routes.
			if (e.startsWith('_')) continue;
			const rel = '/' + relative(ROOT, full).replace(/\.(js|mjs)$/, '');
			const route = rel.replace(/\/index$/, '') || '/api';
			if (/\[.+\]/.test(route)) {
				dynamic.push(route);
				continue;
			}
			routes.push(route);
		}
	};
	walk(resolve(ROOT, 'api'));
	const excluded = routes.filter((r) => SIDE_EFFECT.some((re) => re.test(r)));
	const probed = routes.filter((r) => !SIDE_EFFECT.some((re) => re.test(r)));
	return { probed: [...new Set(probed)].sort(), excluded, dynamic };
}

async function probe(route, attempt = 1) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(`${BASE_URL}${route}`, {
			method: 'GET',
			redirect: 'manual',
			signal: ctrl.signal,
			headers: { 'user-agent': 'three.ws-api-sweep/1.0 (internal audit)' },
		});
		clearTimeout(timer);
		const status = res.status;
		const body = await res.text().catch(() => '');
		if (status >= 500) {
			return { route, status, verdict: 'error', note: `HTTP ${status} ${body.slice(0, 160)}` };
		}
		if (status === 404) {
			// Only two 404 shapes mean the handler is unreachable: the server's
			// route fall-through, and a dispatcher missing the action entry. A
			// handler answering 404 for a missing param/resource is alive.
			if (/No API route matches|unknown action/i.test(body)) {
				return { route, status, verdict: 'warn', note: `unreachable handler: ${body.slice(0, 120)}` };
			}
		}
		return { route, status, verdict: 'ok' };
	} catch (e) {
		clearTimeout(timer);
		if (attempt < 2) return probe(route, attempt + 1);
		return { route, status: null, verdict: 'error', note: `unreachable: ${e.name || e.message}` };
	}
}

async function main() {
	const { probed, excluded, dynamic } = enumerateRoutes();
	console.log(`API sweep -> ${BASE_URL}`);
	console.log(`  probing ${probed.length} GET route(s) · concurrency ${CONCURRENCY}`);
	console.log(`  excluded ${excluded.length} side-effect route(s), skipped ${dynamic.length} dynamic [param] route(s)\n`);

	const queue = [...probed];
	const results = [];
	let done = 0;
	const worker = async () => {
		while (queue.length) {
			const r = await probe(queue.shift());
			results.push(r);
			done++;
			if (r.verdict !== 'ok') {
				console.log(`  ${r.verdict === 'error' ? '🔴' : '🟡'} ${r.route} ${r.note || ''}`);
			} else if (done % 200 === 0) {
				console.log(`  ... ${done}/${probed.length}`);
			}
		}
	};
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));

	const errors = results.filter((r) => r.verdict === 'error').sort((a, b) => a.route.localeCompare(b.route));
	const warns = results.filter((r) => r.verdict === 'warn').sort((a, b) => a.route.localeCompare(b.route));
	const statusCounts = {};
	for (const r of results) statusCounts[r.status ?? 'net-fail'] = (statusCounts[r.status ?? 'net-fail'] || 0) + 1;

	mkdirSync(resolve(ROOT, 'reports'), { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const jsonPath = resolve(ROOT, `reports/api-sweep-${stamp}.json`);
	const mdPath = resolve(ROOT, `reports/api-sweep-${stamp}.md`);
	writeFileSync(
		jsonPath,
		JSON.stringify({ baseUrl: BASE_URL, generatedAt: stamp, statusCounts, errors, warns, excluded, dynamic, total: results.length }, null, 2),
	);
	const lines = [
		`# API sweep - ${BASE_URL}`,
		'',
		`- Probed: ${results.length} routes · Errors: ${errors.length} · Route-drift 404s: ${warns.length}`,
		`- Status distribution: ${Object.entries(statusCounts).sort().map(([s, n]) => `${s}: ${n}`).join(' · ')}`,
		`- Excluded (side-effect on GET): ${excluded.length} · Skipped dynamic [param]: ${dynamic.length}`,
		'',
	];
	if (errors.length) {
		lines.push('## Broken (5xx / unreachable)', '');
		for (const r of errors) lines.push(`- 🔴 \`${r.route}\` ${r.note}`);
		lines.push('');
	}
	if (warns.length) {
		lines.push('## Handler exists on disk but the route 404s (route-table drift)', '');
		for (const r of warns) lines.push(`- 🟡 \`${r.route}\``);
		lines.push('');
	}
	if (excluded.length) {
		lines.push('## Excluded from probing (GET has side effects)', '');
		for (const r of excluded) lines.push(`- \`${r}\``);
		lines.push('');
	}
	writeFileSync(mdPath, lines.join('\n'));

	console.log(`\n  ${errors.length} error · ${warns.length} route-drift 404 · ${results.length - errors.length - warns.length} ok`);
	console.log(`  Report: ${mdPath.replace(ROOT + '/', '')}`);
	if (STRICT && errors.length) process.exit(1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
