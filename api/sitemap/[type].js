// Sub-sitemap by entity type — agents, avatars, widgets, profiles, core.
//
// Each request streams up to 45k URLs (capped under the sitemaps.org 50k
// ceiling). Beyond that we'd shard into agents-1.xml, agents-2.xml, etc.,
// but the catalog is nowhere near that size yet.
//
// Cached at the edge for 10 min — long enough to absorb crawl bursts,
// short enough that newly minted agents are discoverable within minutes
// (and IndexNow gives them an instant push too).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from '../_lib/db.js';
import { env } from '../_lib/env.js';

const ORIGIN = env.APP_ORIGIN;
const MAX_URLS = 45_000;

function fmtDate(d) {
	const t = d instanceof Date ? d : new Date(d || Date.now());
	if (Number.isNaN(t.getTime())) return new Date().toISOString().slice(0, 10);
	return t.toISOString().slice(0, 10);
}

function xmlEscape(s) {
	return String(s || '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function urlsetXml(entries) {
	return (
		`<?xml version="1.0" encoding="UTF-8"?>\n` +
		`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
		entries
			.map((e) => {
				const parts = [`\t\t<loc>${xmlEscape(e.loc)}</loc>`];
				if (e.lastmod) parts.push(`\t\t<lastmod>${e.lastmod}</lastmod>`);
				if (e.changefreq) parts.push(`\t\t<changefreq>${e.changefreq}</changefreq>`);
				if (e.priority) parts.push(`\t\t<priority>${e.priority}</priority>`);
				return `\t<url>\n${parts.join('\n')}\n\t</url>`;
			})
			.join('\n') +
		`\n</urlset>\n`
	);
}

function send(res, body) {
	res.setHeader('content-type', 'application/xml; charset=utf-8');
	res.setHeader('cache-control', 'public, s-maxage=600, stale-while-revalidate=86400');
	res.statusCode = 200;
	res.end(body);
}

// Core (static) routes are read from data/pages.json — the same source of
// truth that build-page-index.mjs uses for llms.txt / sitemap.html / the
// features manifest. One file to edit; this route + the human sitemap + the
// AI indexes all stay in lockstep.
async function loadPagesManifest() {
	// In the Vercel bundle data/ ships alongside the function via includeFiles;
	// in dev it's at repo root. Try both.
	const candidates = [
		path.join(process.cwd(), 'data', 'pages.json'),
		path.join(process.cwd(), 'public', 'features.json'),
	];
	for (const file of candidates) {
		try {
			const raw = await readFile(file, 'utf8');
			return JSON.parse(raw);
		} catch {
			// try next
		}
	}
	return null;
}

async function coreSitemap() {
	const today = fmtDate(new Date());
	const manifest = await loadPagesManifest();
	if (!manifest?.sections) {
		// Fallback to the home page only — never 500 the crawler.
		return [{ loc: `${ORIGIN}/`, lastmod: today, changefreq: 'daily', priority: '1.0' }];
	}
	const out = [];
	for (const section of manifest.sections) {
		// Skip news (it has its own long-tail) and any non-indexable section.
		if (section.id === 'news') continue;
		for (const p of section.pages || []) {
			if (p.indexable === false) continue;
			if (p.auth === 'required') continue;
			if (!p.path || p.path.startsWith('http')) continue;
			out.push({
				loc: `${ORIGIN}${p.path === '/' ? '/' : p.path}`,
				lastmod: p.lastmod || today,
				changefreq: p.changefreq || 'weekly',
				priority: typeof p.priority === 'number' ? p.priority.toFixed(1) : '0.6',
			});
		}
	}
	return out.length ? out : [{ loc: `${ORIGIN}/`, lastmod: today, changefreq: 'daily', priority: '1.0' }];
}

async function agentsSitemap() {
	const rows = await sql`
		select id, updated_at, created_at
		from agent_identities
		where deleted_at is null and is_public = true
		order by coalesce(updated_at, created_at) desc
		limit ${MAX_URLS}
	`;
	return rows.map((r) => ({
		loc: `${ORIGIN}/agent/${r.id}`,
		lastmod: fmtDate(r.updated_at || r.created_at),
		changefreq: 'weekly',
		priority: '0.7',
	}));
}

async function avatarsSitemap() {
	const rows = await sql`
		select id, updated_at, created_at
		from avatars
		where deleted_at is null and visibility = 'public'
		order by coalesce(updated_at, created_at) desc
		limit ${MAX_URLS}
	`;
	return rows.map((r) => ({
		loc: `${ORIGIN}/avatars/${r.id}`,
		lastmod: fmtDate(r.updated_at || r.created_at),
		changefreq: 'weekly',
		priority: '0.6',
	}));
}

async function widgetsSitemap() {
	// Only widgets surfaced on a public profile/showcase are worth indexing — the
	// raw embed endpoint isn't human content. Filtering on is_public matches the
	// front-end's listing behavior.
	const rows = await sql`
		select id, updated_at, created_at
		from widgets
		where deleted_at is null and is_public = true
		order by coalesce(updated_at, created_at) desc
		limit ${MAX_URLS}
	`;
	return rows.map((r) => ({
		loc: `${ORIGIN}/w/${r.id}`,
		lastmod: fmtDate(r.updated_at || r.created_at),
		changefreq: 'monthly',
		priority: '0.5',
	}));
}

async function profilesSitemap() {
	// Public user profiles + the subdomain showcase pages they map to. We index
	// /u/<username> — the canonical profile URL — and skip raw user IDs.
	const rows = await sql`
		select u.username, u.updated_at, u.created_at
		from users u
		where u.deleted_at is null and u.username is not null
		order by coalesce(u.updated_at, u.created_at) desc
		limit ${MAX_URLS}
	`;
	return rows.map((r) => ({
		loc: `${ORIGIN}/u/${r.username}`,
		lastmod: fmtDate(r.updated_at || r.created_at),
		changefreq: 'weekly',
		priority: '0.6',
	}));
}

const BUILDERS = {
	core: coreSitemap,
	agents: agentsSitemap,
	avatars: avatarsSitemap,
	widgets: widgetsSitemap,
	profiles: profilesSitemap,
};

export default async function handler(req, res) {
	const raw = String(req.query?.type || req.query?.id || '').replace(/\.xml$/i, '');
	const builder = BUILDERS[raw];
	if (!builder) {
		res.statusCode = 404;
		res.setHeader('content-type', 'text/plain');
		res.end('unknown sitemap');
		return;
	}
	try {
		const entries = await builder();
		return send(res, urlsetXml(entries));
	} catch (err) {
		console.error('[sitemap]', raw, err?.message);
		res.statusCode = 500;
		res.setHeader('content-type', 'text/plain');
		res.end('sitemap failed');
	}
}
