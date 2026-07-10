#!/usr/bin/env node
// Validate every feed in api/_lib/news-sources.js and report which are still
// alive. The news registry is a list of other people's servers: outlets fold,
// feeds move, and hosts put themselves behind bot challenges. A registry that
// is never re-checked silently rots into a list of 404s.
//
//   node scripts/news-sources-probe.mjs              # probe every source
//   node scripts/news-sources-probe.mjs --category=defi
//   node scripts/news-sources-probe.mjs --json       # machine-readable report
//   node scripts/news-sources-probe.mjs --discover   # also chase moved feeds
//
// Exit code is 0 when every probed source is live, 1 otherwise, so this can
// gate a release or run on a schedule.
//
// Methodology (each rule earned by a failed run):
//   * Use a polite, identifying bot UA. A spoofed Chrome UA without the
//     matching TLS/header fingerprint reads as a scraper and earns MORE 403s.
//   * Serialize per domain. Feeds cluster on shared hosts (medium.com carries
//     dozens); probing them in parallel self-inflicts 429s that look like death.
//   * A body that does not begin with <rss/<feed/<rdf:RDF is not a feed, no
//     matter how many kilobytes of HTML it is.
//   * --discover: on a 404/410/HTML, try RSS autodiscovery against the site
//     origin, then conventional feed paths, and report the new location.

import { XMLParser } from 'fast-xml-parser';
import { NEWS_SOURCES } from '../api/_lib/news-sources.js';

const args = process.argv.slice(2);
const flag = (name) => args.some((a) => a === `--${name}`);
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const AS_JSON = flag('json');
const DISCOVER = flag('discover');
const CATEGORY = opt('category');

const UA = 'Mozilla/5.0 (compatible; three.ws-news/1.0; +https://three.ws)';
const ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8';
const TIMEOUT_MS = 15_000;
const DOMAIN_WORKERS = 12;

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return null; } };
const norm = (u) => String(u).trim().replace(/\/+$/, '').toLowerCase();

// Shared hosts need breathing room between requests or they 429 us.
const spacingFor = (host) =>
	/(^|\.)medium\.com$/.test(host) ? 4000 : /mirror\.xyz$/.test(host) ? 2500 : /substack\.com$/.test(host) ? 2000 : 300;

function feedItemCount(body) {
	if (!/<rss[\s>]|<feed[\s>]|<rdf:RDF[\s>]/i.test(body.slice(0, 4000))) return null;
	try {
		const doc = parser.parse(body);
		const items = doc?.rss?.channel?.item || doc?.feed?.entry || doc?.['rdf:RDF']?.item || [];
		return Array.isArray(items) ? items.length : items ? 1 : 0;
	} catch {
		return null;
	}
}

async function tryFeed(url) {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const resp = await fetch(url, {
				headers: { accept: ACCEPT, 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' },
				signal: AbortSignal.timeout(TIMEOUT_MS),
				redirect: 'follow',
			});
			if (resp.status === 429) {
				await sleep(12_000 * (attempt + 1));
				continue;
			}
			if (!resp.ok) return { ok: false, reason: `http_${resp.status}` };
			const count = feedItemCount(await resp.text());
			if (count === null) return { ok: false, reason: 'not_feed' };
			if (count === 0) return { ok: false, reason: 'empty_feed' };
			return { ok: true, items: count, final_url: resp.url };
		} catch (err) {
			if (attempt === 2) return { ok: false, reason: err.name === 'TimeoutError' ? 'timeout' : 'fetch_failed' };
			await sleep(2500);
		}
	}
	return { ok: false, reason: 'http_429' };
}

async function autodiscover(origin) {
	try {
		const resp = await fetch(origin, {
			headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
			signal: AbortSignal.timeout(TIMEOUT_MS),
			redirect: 'follow',
		});
		if (!resp.ok) return [];
		const html = await resp.text();
		const found = [];
		for (const match of html.matchAll(/<link[^>]+>/gi)) {
			const tag = match[0];
			if (!/rel=["']?alternate/i.test(tag)) continue;
			if (!/type=["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
			const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
			if (href) {
				try { found.push(new URL(href, resp.url).href); } catch { /* malformed href */ }
			}
		}
		return [...new Set(found)];
	} catch {
		return [];
	}
}

const COMMON_PATHS = ['/feed/', '/feed', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml'];

async function relocate(url) {
	let origin;
	try { origin = new URL(url).origin; } catch { return null; }
	for (const candidate of (await autodiscover(origin)).slice(0, 3)) {
		const result = await tryFeed(candidate);
		if (result.ok) return { ...result, via: 'autodiscovery' };
		await sleep(200);
	}
	for (const path of COMMON_PATHS) {
		const candidate = origin + path;
		if (norm(candidate) === norm(url)) continue;
		const result = await tryFeed(candidate);
		if (result.ok) return { ...result, via: 'common_path' };
		await sleep(150);
	}
	return null;
}

async function probe(key, src) {
	// JSON sources are shaped by an adapter, not parsed as a feed — a 200 with a
	// non-empty body is all this script can meaningfully assert about them.
	if (src.kind === 'json') {
		try {
			const resp = await fetch(src.url, {
				headers: { accept: 'application/json', 'user-agent': UA },
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			if (!resp.ok) return { key, ...src, ok: false, reason: `http_${resp.status}` };
			const body = await resp.json();
			return { key, ...src, ok: !!body, items: null };
		} catch {
			return { key, ...src, ok: false, reason: 'fetch_failed' };
		}
	}

	const direct = await tryFeed(src.url);
	if (direct.ok) return { key, ...src, ...direct };
	if (!DISCOVER || !/^http_(404|410)$|^not_feed$/.test(direct.reason)) return { key, ...src, ...direct };

	const moved = await relocate(src.url);
	if (moved) return { key, ...src, ...moved, moved_from: src.url };
	return { key, ...src, ...direct };
}

// ── run: serialize within a domain, parallelize across domains ───────────────
const selected = Object.entries(NEWS_SOURCES).filter(([, s]) => !CATEGORY || s.category === CATEGORY);
if (!selected.length) {
	console.error(CATEGORY ? `no sources in category "${CATEGORY}"` : 'registry is empty');
	process.exit(1);
}

const byDomain = new Map();
for (const [key, src] of selected) {
	const host = hostOf(src.url) || 'invalid';
	if (!byDomain.has(host)) byDomain.set(host, []);
	byDomain.get(host).push([key, src]);
}

const domains = [...byDomain.entries()];
const results = [];
let cursor = 0;
let finished = 0;

async function worker() {
	while (cursor < domains.length) {
		const [host, list] = domains[cursor++];
		const gap = spacingFor(host);
		for (const [key, src] of list) {
			const result = await probe(key, src);
			results.push(result);
			finished++;
			if (!AS_JSON) {
				const label = result.ok ? '\x1b[32m ok \x1b[0m' : '\x1b[31mdead\x1b[0m';
				const detail = result.ok
					? `${result.items ?? '—'} items${result.moved_from ? `  → moved: ${result.final_url}` : ''}`
					: result.reason;
				process.stderr.write(`[${String(finished).padStart(3)}/${selected.length}] ${label} ${key.padEnd(24)} ${detail}\n`);
			}
			if (list.length > 1) await sleep(gap);
		}
	}
}

await Promise.all(Array.from({ length: Math.min(DOMAIN_WORKERS, domains.length) }, worker));

const live = results.filter((r) => r.ok);
const dead = results.filter((r) => !r.ok);
const moved = live.filter((r) => r.moved_from);

if (AS_JSON) {
	console.log(JSON.stringify({ probed: results.length, live: live.length, dead: dead.length, results }, null, 2));
} else {
	const reasons = {};
	for (const d of dead) reasons[d.reason] = (reasons[d.reason] || 0) + 1;
	console.log(`\nprobed ${results.length}  live ${live.length}  dead ${dead.length}`);
	if (moved.length) {
		console.log(`\nmoved feeds (update the registry url):`);
		for (const m of moved) console.log(`  ${m.key.padEnd(24)} ${m.url}\n  ${' '.repeat(24)} → ${m.final_url}`);
	}
	if (dead.length) {
		console.log(`\ndead by reason: ${Object.entries(reasons).map(([r, n]) => `${r}:${n}`).join('  ')}`);
		for (const d of dead) console.log(`  ${d.key.padEnd(24)} ${d.reason.padEnd(14)} ${d.url}`);
	}
}

process.exit(dead.length ? 1 : 0);
