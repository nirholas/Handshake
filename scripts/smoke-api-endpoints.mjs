#!/usr/bin/env node
// Smoke-test every API endpoint against a deployed target.
//
// Walks api/, derives Vercel routes from the file tree, then GETs each one and
// classifies the response. A GET is a liveness probe: a deployed function that
// requires POST/auth/params answers 405/401/403/400 — all of which prove the
// function is routed and running. Only 5xx (or network failure) means broken.
//
// Usage: node scripts/smoke-api-endpoints.mjs [baseUrl] [--concurrency=12]
//   baseUrl defaults to https://three.ws

import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const BASE = (process.argv.find((a) => /^https?:\/\//.test(a)) || 'https://three.ws').replace(/\/$/, '');
const CONCURRENCY = Number((process.argv.find((a) => a.startsWith('--concurrency=')) || '').split('=')[1]) || 12;
const TIMEOUT_MS = 20000;
const API_DIR = new URL('../api/', import.meta.url).pathname;

// Placeholder values for dynamic segments so the route actually matches.
const DYN = { id: 'test', action: 'status', name: 'health', type: 'index', path: 'test' };

async function walk(dir) {
	const out = [];
	for (const ent of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, ent.name);
		// Skip helper dirs/files (underscore-prefixed) and non-endpoint files.
		if (ent.name.startsWith('_')) continue;
		if (ent.isDirectory()) {
			out.push(...(await walk(full)));
		} else if (ent.name.endsWith('.js') || ent.name.endsWith('.ts')) {
			out.push(full);
		}
	}
	return out;
}

function fileToRoute(file) {
	let rel = relative(API_DIR, file).replace(/\.(js|ts)$/, '');
	const segments = rel.split('/');
	// index files map to their dir root
	const mapped = segments
		.filter((s, i) => !(s === 'index' && i === segments.length - 1))
		.map((s) => {
			const m = s.match(/^\[\.\.\.(.+)\]$/) || s.match(/^\[(.+)\]$/);
			if (!m) return s;
			const key = m[1];
			return DYN[key] ?? 'test';
		});
	return '/api/' + mapped.join('/');
}

function classify(status) {
	if (status >= 500) return 'BROKEN';
	if (status === 404) return 'NOT_FOUND';
	if (status === 405) return 'alive(405)';
	if (status === 401 || status === 403) return 'alive(auth)';
	if (status === 400 || status === 422) return 'alive(400)';
	if (status >= 200 && status < 300) return 'OK';
	if (status >= 300 && status < 400) return 'OK(redirect)';
	if (status === 402) return 'alive(402)';
	if (status === 429) return 'alive(429)';
	return `other(${status})`;
}

async function probe(route) {
	const url = BASE + route;
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	const started = Date.now();
	try {
		const r = await fetch(url, {
			method: 'GET',
			headers: { accept: 'application/json', 'user-agent': 'three-ws-smoke/1.0' },
			redirect: 'manual',
			signal: ctrl.signal,
		});
		return { route, status: r.status, ms: Date.now() - started, cls: classify(r.status) };
	} catch (e) {
		return { route, status: 0, ms: Date.now() - started, cls: 'NETERR', err: e.name === 'AbortError' ? 'timeout' : e.message };
	} finally {
		clearTimeout(t);
	}
}

async function pool(items, n, fn) {
	const results = [];
	let i = 0;
	const workers = Array.from({ length: n }, async () => {
		while (i < items.length) {
			const idx = i++;
			results[idx] = await fn(items[idx]);
		}
	});
	await Promise.all(workers);
	return results;
}

const files = await walk(API_DIR);
// Dedupe routes (e.g. index collisions) keeping the first file.
const routeMap = new Map();
for (const f of files) {
	const r = fileToRoute(f);
	if (!routeMap.has(r)) routeMap.set(r, f);
}
const routes = [...routeMap.keys()].sort();

console.log(`Probing ${routes.length} routes against ${BASE} (GET, concurrency=${CONCURRENCY})\n`);
const results = await pool(routes, CONCURRENCY, probe);

const groups = {};
for (const r of results) (groups[r.cls] ??= []).push(r);

// Print the problem groups in full, summarize the healthy ones.
const order = ['BROKEN', 'NETERR', 'NOT_FOUND', 'OK', 'OK(redirect)', 'alive(auth)', 'alive(405)', 'alive(400)', 'alive(402)', 'alive(429)'];
const seen = new Set();
function dump(label, list, full) {
	if (!list?.length) return;
	console.log(`\n=== ${label} — ${list.length} ===`);
	const show = full ? list : list.slice(0, 0);
	for (const r of show.sort((a, b) => a.route.localeCompare(b.route))) {
		console.log(`  ${String(r.status).padStart(3)} ${r.route}${r.err ? '  (' + r.err + ')' : ''}`);
	}
}

// Always show broken + network errors in full — these are the real findings.
dump('BROKEN (5xx)', groups.BROKEN, true);
dump('NETWORK ERROR / TIMEOUT', groups.NETERR, true);
dump('NOT_FOUND (404 — unrouted or needs real param)', groups.NOT_FOUND, true);

console.log('\n=== SUMMARY ===');
for (const k of [...order, ...Object.keys(groups)]) {
	if (seen.has(k) || !groups[k]) continue;
	seen.add(k);
	console.log(`  ${k.padEnd(16)} ${groups[k].length}`);
}
const healthy = results.filter((r) => r.cls !== 'BROKEN' && r.cls !== 'NETERR').length;
console.log(`\n  ${healthy}/${results.length} routes responded without server error.`);

const broken = (groups.BROKEN?.length || 0) + (groups.NETERR?.length || 0);
process.exit(broken > 0 ? 1 : 0);
