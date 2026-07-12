// news-knowledge-store — the durable memory the 3D agents read crypto from.
//
// Every time the reader fully extracts and analyzes a story, the enriched
// record lands here: the full article body, the AI summary + key points,
// sentiment, detected tickers with their live market snapshot, and the named
// entities (orgs, people, projects) the story is about. This is a permanent,
// queryable knowledge base — distinct from the GCS archive (append-only feed
// metadata) and from per-agent memory (agent_memory). Agents ground their
// answers in it; the reader itself reads it as a durable cross-instance cache
// so a story is only extracted from the (rate-limited, blockable) publisher
// once.
//
// One row per content-addressed article id (sha256 of the publisher link — the
// same id the feed, archive, and story permalinks share). The heavy payload
// (paragraphs, coins, entities) rides in a jsonb `doc`; the indexed columns
// (title, source, sentiment, published_at) power listing and search without
// deserializing every body.
//
// Degrades cleanly: without DATABASE_URL every function returns null/empty, so
// the reader still extracts and renders live — only the durable memory is off.

import { sql } from './db.js';
import { databaseConfigured } from './env.js';

export function knowledgeStoreEnabled() {
	return databaseConfigured();
}

let _ensured = null;
async function ensureTable() {
	if (!knowledgeStoreEnabled()) return false;
	if (_ensured) return _ensured;
	_ensured = (async () => {
		await sql`
			create table if not exists news_knowledge (
				id            text primary key,
				url           text not null,
				title         text not null,
				source        text,
				author        text,
				image         text,
				published_at  timestamptz,
				extraction    text not null,
				sentiment     text,
				analysis      text,
				tickers       text[] not null default '{}',
				entities      text[] not null default '{}',
				summary       text,
				content_chars integer not null default 0,
				doc           jsonb not null,
				fetched_at    timestamptz not null default now(),
				updated_at    timestamptz not null default now()
			)
		`;
		await sql`create index if not exists news_knowledge_published_idx on news_knowledge (published_at desc)`;
		await sql`create index if not exists news_knowledge_tickers_idx on news_knowledge using gin (tickers)`;
		await sql`create index if not exists news_knowledge_fetched_idx on news_knowledge (fetched_at desc)`;
		return true;
	})().catch((err) => {
		console.error('[news-knowledge] ensureTable failed:', err?.message);
		_ensured = null;
		return false;
	});
	return _ensured;
}

const iso = (v) => {
	const t = Date.parse(v || '');
	return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/**
 * Upsert one fully-extracted, analyzed story. Idempotent on `id`: a later,
 * richer extraction of the same story (e.g. reader body replacing a feed
 * teaser) overwrites the earlier one. Fire-and-forget from the reader — never
 * let a persistence hiccup fail the request.
 *
 * @returns {Promise<boolean>} true when a row was written.
 */
export async function recordExtraction(record) {
	if (!record?.id || !record?.url || !record?.title) return false;
	if (!(await ensureTable())) return false;
	const tickers = Array.isArray(record.tickers) ? record.tickers.slice(0, 12) : [];
	const entities = Array.isArray(record.entities) ? record.entities.slice(0, 24) : [];
	const doc = {
		paragraphs: Array.isArray(record.paragraphs) ? record.paragraphs.slice(0, 60) : [],
		key_points: Array.isArray(record.key_points) ? record.key_points.slice(0, 6) : [],
		coins: Array.isArray(record.coins) ? record.coins : [],
		entities,
		topics: Array.isArray(record.topics) ? record.topics.slice(0, 12) : [],
		market_context: record.market_context || null,
		blocked_reason: record.blocked_reason || null,
	};
	try {
		await sql`
			insert into news_knowledge
				(id, url, title, source, author, image, published_at, extraction,
				 sentiment, analysis, tickers, entities, summary, content_chars, doc, updated_at)
			values
				(${record.id}, ${record.url}, ${record.title.slice(0, 500)}, ${record.source || null},
				 ${record.author || null}, ${record.image || null}, ${iso(record.published_at)},
				 ${record.extraction || 'preview'}, ${record.sentiment || null},
				 ${record.analysis_provider || null}, ${tickers}::text[], ${entities}::text[],
				 ${(record.summary || '').slice(0, 2000) || null}, ${record.content_chars || 0},
				 ${JSON.stringify(doc)}::jsonb, now())
			on conflict (id) do update set
				url = excluded.url,
				title = excluded.title,
				source = coalesce(excluded.source, news_knowledge.source),
				author = coalesce(excluded.author, news_knowledge.author),
				image = coalesce(excluded.image, news_knowledge.image),
				published_at = coalesce(excluded.published_at, news_knowledge.published_at),
				extraction = excluded.extraction,
				sentiment = excluded.sentiment,
				analysis = excluded.analysis,
				tickers = excluded.tickers,
				entities = excluded.entities,
				summary = excluded.summary,
				content_chars = greatest(excluded.content_chars, news_knowledge.content_chars),
				doc = excluded.doc,
				updated_at = now()
		`;
		return true;
	} catch (err) {
		console.error('[news-knowledge] recordExtraction failed:', err?.message);
		return false;
	}
}

/** Full stored knowledge for one article id, or null. Used by the reader as a
 * durable cross-instance cache and by the agent knowledge endpoint. */
export async function getExtraction(id) {
	if (!id || !(await ensureTable())) return null;
	try {
		const rows = await sql`
			select id, url, title, source, author, image, published_at, extraction,
			       sentiment, analysis, tickers, entities, summary, content_chars, doc, fetched_at
			from news_knowledge where id = ${id} limit 1
		`;
		if (!rows.length) return null;
		const r = rows[0];
		return {
			id: r.id,
			url: r.url,
			title: r.title,
			source: r.source,
			author: r.author,
			image: r.image,
			published_at: r.published_at,
			extraction: r.extraction,
			sentiment: r.sentiment,
			analysis_provider: r.analysis,
			tickers: r.tickers || [],
			entities: r.entities || [],
			summary: r.summary,
			content_chars: r.content_chars,
			...r.doc,
			fetched_at: r.fetched_at,
		};
	} catch (err) {
		console.error('[news-knowledge] getExtraction failed:', err?.message);
		return null;
	}
}

/**
 * Query the knowledge base — the grounding surface agents read. Filter by
 * ticker and/or free-text; newest first. Returns lightweight rows (no full
 * body) unless `full` is set.
 */
export async function queryKnowledge({ ticker = null, q = null, limit = 20, full = false } = {}) {
	if (!(await ensureTable())) return [];
	const lim = Math.min(Math.max(1, limit | 0), 100);
	const sym = ticker ? String(ticker).toUpperCase().slice(0, 12) : null;
	const text = q ? `%${String(q).slice(0, 120)}%` : null;
	try {
		// `doc` (the heavy jsonb body) is always selected and dropped below when
		// !full — avoids fragile nested sql fragments for one small column.
		let rows;
		if (sym && text) {
			rows = await sql`select id,url,title,source,image,published_at,extraction,sentiment,analysis,tickers,entities,summary,content_chars,doc from news_knowledge where ${sym} = any(tickers) and (title ilike ${text} or summary ilike ${text}) order by published_at desc nulls last limit ${lim}`;
		} else if (sym) {
			rows = await sql`select id,url,title,source,image,published_at,extraction,sentiment,analysis,tickers,entities,summary,content_chars,doc from news_knowledge where ${sym} = any(tickers) order by published_at desc nulls last limit ${lim}`;
		} else if (text) {
			rows = await sql`select id,url,title,source,image,published_at,extraction,sentiment,analysis,tickers,entities,summary,content_chars,doc from news_knowledge where title ilike ${text} or summary ilike ${text} order by published_at desc nulls last limit ${lim}`;
		} else {
			rows = await sql`select id,url,title,source,image,published_at,extraction,sentiment,analysis,tickers,entities,summary,content_chars,doc from news_knowledge order by published_at desc nulls last limit ${lim}`;
		}
		return rows.map((r) => ({
			id: r.id,
			url: r.url,
			title: r.title,
			source: r.source,
			image: r.image,
			published_at: r.published_at,
			extraction: r.extraction,
			sentiment: r.sentiment,
			analysis_provider: r.analysis,
			tickers: r.tickers || [],
			entities: r.entities || [],
			summary: r.summary,
			content_chars: r.content_chars,
			...(full && r.doc ? r.doc : {}),
		}));
	} catch (err) {
		console.error('[news-knowledge] queryKnowledge failed:', err?.message);
		return [];
	}
}

/** Corpus counters for the knowledge endpoint's meta + ops visibility. */
export async function knowledgeStats() {
	if (!(await ensureTable())) return { total: 0, enabled: false };
	try {
		const rows = await sql`
			select count(*)::int as total,
			       count(*) filter (where extraction in ('page','reader'))::int as full_text,
			       max(fetched_at) as latest
			from news_knowledge
		`;
		return { total: rows[0]?.total || 0, full_text: rows[0]?.full_text || 0, latest: rows[0]?.latest || null, enabled: true };
	} catch {
		return { total: 0, enabled: true };
	}
}
