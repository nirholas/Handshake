// Dynamic sitemap index. Returns the top-level sitemap.xml that Google /
// Bing crawl first; each entry points at a chunked sub-sitemap (core
// landing pages, agents, avatars, widgets, public profiles).
//
// Why an index instead of one giant file:
//   - 50k URL / 50MB per-file cap from sitemaps.org spec
//   - lets each entity type set its own lastmod / changefreq
//   - per-file caches in Vercel's CDN — re-render only the type that changed
//
// Wired via vercel.json rewrite: /sitemap.xml → /api/sitemap

import { sql } from './_lib/db.js';
import { env } from './_lib/env.js';

const ORIGIN = env.APP_ORIGIN;

function xml(res, body) {
	res.setHeader('content-type', 'application/xml; charset=utf-8');
	res.setHeader('cache-control', 'public, s-maxage=600, stale-while-revalidate=86400');
	res.statusCode = 200;
	res.end(body);
}

function fmtDate(d) {
	const t = d instanceof Date ? d : new Date(d);
	if (Number.isNaN(t.getTime())) return new Date().toISOString().slice(0, 10);
	return t.toISOString().slice(0, 10);
}

// Coalesce on created_at because most rows in this DB never get an explicit
// updated_at write — many writes happen via INSERT rather than UPDATE, so
// `max(updated_at)` returns NULL even when there's plenty of content.
async function newestTimestamp(table, where = '') {
	try {
		const rows = await sql.unsafe(
			`select max(coalesce(updated_at, created_at)) as ts from ${table} ${where ? 'where ' + where : ''}`,
		);
		return rows?.[0]?.ts || null;
	} catch {
		return null;
	}
}

// agent_identities has no updated_at on every row — use created_at directly.
async function newestCreated(table, where = '') {
	try {
		const rows = await sql.unsafe(
			`select max(created_at) as ts from ${table} ${where ? 'where ' + where : ''}`,
		);
		return rows?.[0]?.ts || null;
	} catch {
		return null;
	}
}

export default async function handler(req, res) {
	const [agentsTs, avatarsTs, widgetsTs, usersTs, subdomainsTs] = await Promise.all([
		newestCreated('agent_identities', 'deleted_at is null and is_public = true'),
		newestTimestamp('avatars', "visibility = 'public' and deleted_at is null"),
		newestTimestamp('widgets', 'is_public = true and deleted_at is null'),
		newestTimestamp('users', 'deleted_at is null and username is not null'),
		newestCreated('user_subdomains'),
	]);

	// Always emit every sub-sitemap entry — the sub-sitemap itself decides if
	// it has zero rows. An empty <urlset> is valid and lets Google retry later
	// without us having to remember to "turn it on" once content appears.
	const today = fmtDate(new Date());
	const entries = [
		{ loc: `${ORIGIN}/sitemap/core.xml`, lastmod: today },
		{ loc: `${ORIGIN}/sitemap/agents.xml`, lastmod: fmtDate(agentsTs || today) },
		{ loc: `${ORIGIN}/sitemap/avatars.xml`, lastmod: fmtDate(avatarsTs || today) },
		{ loc: `${ORIGIN}/sitemap/widgets.xml`, lastmod: fmtDate(widgetsTs || today) },
		{ loc: `${ORIGIN}/sitemap/profiles.xml`, lastmod: fmtDate(usersTs || subdomainsTs || today) },
	];

	const body =
		`<?xml version="1.0" encoding="UTF-8"?>\n` +
		`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
		entries
			.map(
				(e) => `\t<sitemap>\n\t\t<loc>${e.loc}</loc>\n\t\t<lastmod>${e.lastmod}</lastmod>\n\t</sitemap>`,
			)
			.join('\n') +
		`\n</sitemapindex>\n`;

	return xml(res, body);
}
