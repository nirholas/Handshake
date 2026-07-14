// @ts-check
// Narrative intelligence for the autonomous coin launcher — the "what is the
// world talking about RIGHT NOW" engine that decides which wave a launch rides.
//
// The launcher's edge is timing the zeitgeist: a coin minted into a live, rising
// narrative catches volume (and creator fees); a coin minted into nothing dies.
// This module fuses several real signals into one ranked list of cultural
// currents, each scored by momentum and cross-source confirmation, so the LLM
// coiner (launcher-sources.js) names an ORIGINAL token riding the strongest wave.
//
// Providers — every one optional, time-bounded, and degrades to silence (never
// throws, never blocks a tick):
//
//   INTERNAL (primary — these measure on-chain demand on the exact venue we ship
//   to, so they out-predict any generic news feed):
//     coin_intel — categories / tags / narratives of high-quality coins observed
//                  breaking out on pump.fun in the last day (pump_coin_intel).
//     trending   — conviction-scored hot sectors from the oracle (oracle_conviction).
//     x          — hashtags / terms from recent X chatter (x_posts).
//
//   EXTERNAL (culture + events — broaden beyond crypto into the memes and news
//   the next narrative is minted from; key-less public APIs, cached hard):
//     hackernews — tech / internet zeitgeist (HN Algolia front page).
//     reddit     — meme + culture + crypto-community pulse (subreddit hot).
//     wikipedia  — what the world is actually looking up (top pageviews).
//
// THE ONE COIN RULE ($THREE): we mine THEMES (culture, narratives, events), never
// specific tickers. Provider text is reduced to generic theme words, an explicit
// denylist strips coin/ticker-shaped tokens, and the downstream LLM is instructed
// to invent — never copy — an identity. No external coin name is ever surfaced.

import { sql } from './db.js';
import { cacheGet, cacheSet } from './cache.js';

// ── tunables ──────────────────────────────────────────────────────────────────
const AGG_CACHE_TTL_S = 180;      // ranked-narrative aggregate cache
const PROVIDER_CACHE_TTL_S = 300; // per external-provider cache
const EXTERNAL_TIMEOUT_MS = 6_000;
const MAX_TERMS = 32;

// Source weights — internal venue signals dominate; culture sources broaden.
// knowyourmeme is the single best PURE-meme external feed (entries are literally
// catalogued memes), so it outranks the general culture/news sources.
const SOURCE_WEIGHT = {
	coin_intel: 3.0,
	trending: 2.6,
	knowyourmeme: 2.0,
	x: 1.4,
	googletrends: 1.3,
	hackernews: 1.2,
	reddit: 1.2,
	wikipedia: 1.0,
};

// External providers are opt-in via the config `sources` array; internal ones run
// whenever named. These ids are the vocabulary an operator enables.
const EXTERNAL_SOURCES = new Set(['knowyourmeme', 'googletrends', 'hackernews', 'reddit', 'wikipedia']);
// knowyourmeme + googletrends ride in the default set: the freshest stream of
// named memes (KYM) and the broadest real-time attention signal (Google Trends) —
// exactly what the launcher exists to mint into.
const DEFAULT_SOURCES = ['coin_intel', 'trending', 'knowyourmeme', 'googletrends', 'x'];

// ── text hygiene ────────────────────────────────────────────────────────────────
const STOPWORDS = new Set([
	'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'has', 'had',
	'her', 'his', 'one', 'our', 'out', 'day', 'get', 'use', 'man', 'new', 'now', 'old',
	'see', 'him', 'two', 'how', 'its', 'who', 'did', 'yes', 'his', 'been', 'have', 'this',
	'that', 'with', 'from', 'they', 'will', 'your', 'what', 'when', 'were', 'them', 'then',
	'than', 'into', 'just', 'over', 'also', 'back', 'after', 'first', 'about', 'their',
	'would', 'there', 'could', 'other', 'these', 'which', 'while', 'where', 'being', 'here',
	'more', 'most', 'some', 'such', 'only', 'very', 'much', 'like', 'make', 'made', 'says',
	'said', 'time', 'year', 'week', 'today', 'launch', 'launches', 'crypto', 'token', 'tokens',
	'coin', 'coins', 'price', 'market', 'pump', 'solana', 'bitcoin', 'ethereum', 'usd',
	// crypto-generic noise (we mine culture, not the asset class itself)
	'sol', 'eth', 'btc', 'nft', 'nfts', 'dao', 'defi', 'web3', 'memecoin', 'altcoin', 'wallet',
	// common verbs / fillers that slip through title extraction as bare words
	'show', 'gets', 'get', 'using', 'used', 'uses', 'allows', 'allow', 'still', 'stop',
	'run', 'runs', 'build', 'builds', 'built', 'makes', 'making', 'decide', 'decides',
	'previewing', 'preview', 'launching', 'introducing', 'announces', 'announce', 'update',
	'release', 'released', 'report', 'reports', 'study', 'review', 'guide', 'best', 'top',
	'why', 'way', 'ways', 'thing', 'things', 'people', 'world', 'list', 'video', 'film',
]);

// Tokens shaped like a ticker / contract / explicit coin reference — stripped so we
// follow culture, not other people's coins (the $THREE rule, mechanically enforced).
const TICKER_SHAPE = /(^\$)|(^0x[0-9a-f]{6,})|(pump$)|(^[A-Z0-9]{2,6}usd[t]?$)/i;

// Brand-safety denylist: real tragedies, violence, death and disaster never become
// a coin theme. Belt-and-braces with the LLM system prompt — kept out at the source
// so such terms never even reach the model. Matched per-word with naive plural
// stemming so "earthquakes"/"deaths" are caught as readily as the singular.
const SENSITIVE_WORDS = new Set([
	'death', 'dead', 'die', 'dying', 'kill', 'killed', 'killing', 'murder', 'shooting',
	'shooter', 'massacre', 'terror', 'terrorist', 'war', 'invasion', 'genocide', 'earthquake',
	'quake', 'tsunami', 'hurricane', 'wildfire', 'flood', 'flooding', 'disaster', 'crash',
	'victim', 'funeral', 'obituary', 'suicide', 'assault', 'abuse', 'rape', 'hostage',
	'bombing', 'bomb', 'explosion', 'outbreak', 'pandemic', 'famine', 'refugee', 'grief',
	'mourning', 'tragedy', 'tragic', 'fatal', 'deadly', 'wounded', 'casualty', 'casualties',
]);
function isSensitive(term) {
	return String(term).toLowerCase().split(/\s+/).some((w) => {
		if (SENSITIVE_WORDS.has(w)) return true;
		const stem = w.replace(/(ies)$/, 'y').replace(/(es|s)$/, '');
		return SENSITIVE_WORDS.has(stem) || SENSITIVE_WORDS.has(w.replace(/s$/, ''));
	});
}

/** Normalise a candidate theme word; return null if it should be dropped. */
function normTerm(raw) {
	let t = String(raw || '')
		.replace(/^#/, '')
		.replace(/[^A-Za-z0-9 ]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!t) return null;
	const lower = t.toLowerCase();
	if (lower.length < 3 || lower.length > 28) return null;
	if (STOPWORDS.has(lower)) return null;
	if (TICKER_SHAPE.test(t)) return null;
	if (/^\d+$/.test(lower)) return null;
	if (isSensitive(lower)) return null;
	// Drop fragments left by stripping accents/punctuation (a stray 1-char word).
	if (/(^|\s)[a-z0-9](\s|$)/i.test(t)) return null;
	return t;
}

/**
 * Pull theme candidates from a free-text title/post. Capitalised proper-noun
 * entities ("Labubu", "World Cup") are the real narrative seeds, so they come
 * first. `entitiesOnly` (used for news/title sources like HN & Reddit) skips the
 * bare-word fallback entirely — that fallback only earns its keep on hashtag-rich
 * sources (X), where lowercase tags carry meaning.
 */
function extractThemes(text, { max = 4, entitiesOnly = false } = {}) {
	const clean = String(text || '').replace(/https?:\/\/\S+/g, ' ');
	const out = [];
	// Capitalised multi-word entities ("Labubu Craze", "World Cup") read as the
	// strongest narrative seeds — grab them first.
	const entities = clean.match(/\b([A-Z][a-z]{2,})(?:\s+[A-Z][a-z]{2,}){0,2}\b/g) || [];
	for (const e of entities) {
		const n = normTerm(e);
		if (n) out.push(n);
		if (out.length >= max) return out;
	}
	if (entitiesOnly) return out;
	const words = clean.match(/#?[A-Za-z][A-Za-z0-9]{3,18}/g) || [];
	for (const w of words) {
		const n = normTerm(w);
		if (n) out.push(n.toLowerCase());
		if (out.length >= max) break;
	}
	return out;
}

// ── shared fetch (key-less, time-bounded, never throws) ─────────────────────────
async function fetchJson(url, { timeoutMs = EXTERNAL_TIMEOUT_MS, headers } = {}) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			signal: ctrl.signal,
			headers: {
				'user-agent': 'three.ws-launcher/1.0 (+https://three.ws)',
				accept: 'application/json',
				...headers,
			},
		});
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Like fetchJson, but for text/XML payloads (RSS). Key-less, time-bounded, never throws. */
async function fetchText(url, { timeoutMs = EXTERNAL_TIMEOUT_MS, headers } = {}) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			signal: ctrl.signal,
			headers: {
				'user-agent': 'three.ws-launcher/1.0 (+https://three.ws)',
				accept: 'application/rss+xml, application/xml, text/xml, */*',
				...headers,
			},
		});
		if (!res.ok) return null;
		return await res.text();
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

// Minimal, dependency-free RSS reader: pull each <item>'s <title> and <link>.
// Handles CDATA wrappers and the channel-level title (which we skip by reading
// inside <item> blocks only). Good enough for the well-formed feeds we consume.
function decodeEntities(s) {
	return String(s || '')
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
		.replace(/&(?:amp|#0*38);/gi, '&')
		.replace(/&(?:lt|#0*60);/gi, '<')
		.replace(/&(?:gt|#0*62);/gi, '>')
		.replace(/&(?:quot|#0*34);/gi, '"')
		.replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
		.replace(/&#x?[0-9a-f]+;|&[a-z]+;/gi, ' ');
}
function parseRssItems(xml) {
	const items = [];
	const blocks = String(xml || '').match(/<item\b[\s\S]*?<\/item>/gi) || [];
	for (const b of blocks) {
		const title = b.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
		const link = b.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
		items.push({
			title: title ? decodeEntities(title[1]).trim() : '',
			link: link ? decodeEntities(link[1]).trim() : '',
		});
	}
	return items;
}

/** Memoise a provider's raw signals so a 60s tick never re-hits an external API. */
async function cached(key, ttl, fn) {
	try {
		const hit = await cacheGet(key);
		if (hit !== null && hit !== undefined) return hit;
	} catch { /* cache down — compute live */ }
	const val = await fn();
	try { await cacheSet(key, val, ttl); } catch { /* ignore */ }
	return val;
}

// ── internal providers ──────────────────────────────────────────────────────────

/**
 * Live pump.fun meta: the categories, tags and narratives of high-quality coins
 * first seen in the last 24h, weighted by their quality score. This is the single
 * best leading indicator of what is catching on the venue we deploy into.
 * @returns {Promise<Array<{term:string, weight:number, kind:string}>>}
 */
async function coinIntelSignals({ network, categories }) {
	const out = [];
	try {
		// Gate on the venue's OBSERVED score distribution, not an absolute bar:
		// pump.fun intel scores cluster in the single digits (24h avg ~7, p90 ~4,
		// max ~45), so the old >= 55 threshold silenced this provider entirely.
		// A modest junk floor + top-N by score keeps it live on quiet days and
		// selective on hot ones.
		const rows = await sql`
			select category, tags, narrative, quality_score
			from pump_coin_intel
			where network = ${network}
			  and first_seen_at > now() - interval '24 hours'
			  and quality_score is not null and quality_score >= 12
			  ${categories?.length ? sql`and category = any(${categories})` : sql``}
			order by quality_score desc nulls last
			limit 60
		`;
		for (const r of rows) {
			const q = Math.max(0.4, Math.min(1.4, Number(r.quality_score || 55) / 70));
			// Categories are generic sector words ('meme', 'animal') repeated on most
			// rows — useful direction, terrible coin themes. Emit them faint so the
			// specific tags/narratives always outrank them.
			if (r.category && r.category !== 'unknown') {
				const n = normTerm(r.category);
				if (n) out.push({ term: n.toLowerCase(), weight: q * 0.4, kind: 'category' });
			}
			if (Array.isArray(r.tags)) {
				for (const t of r.tags.slice(0, 5)) {
					const n = normTerm(t);
					if (n) out.push({ term: n.toLowerCase(), weight: q, kind: 'tag' });
				}
			}
			if (r.narrative) {
				for (const n of extractThemes(r.narrative, { max: 3 })) {
					out.push({ term: n.toLowerCase(), weight: q * 0.9, kind: 'narrative' });
				}
			}
		}
	} catch { /* intel table absent / empty — sparse is fine */ }
	return out;
}

/**
 * Conviction-scored hot sectors from the oracle: categories generating the most
 * prime/strong-tier coins right now. Higher signal than raw counts — these are
 * narratives the platform's own scorer is most convinced about.
 */
async function oracleSignals({ network }) {
	const out = [];
	try {
		const rows = await sql`
			select coalesce(category, 'unknown') as category,
			       count(*) filter (where tier = 'prime')  as prime_count,
			       count(*) filter (where tier = 'strong') as strong_count,
			       round(avg(score)::numeric, 1)           as avg_score
			from oracle_conviction
			where network = ${network}
			  and scored_at > now() - interval '24 hours'
			  and category is not null and category <> 'unknown'
			group by 1
			order by (count(*) filter (where tier = 'prime')) * 2
			         + (count(*) filter (where tier = 'strong')) desc
			limit 16
		`;
		for (const r of rows) {
			const n = normTerm(r.category);
			if (!n) continue;
			const momentum = Number(r.prime_count || 0) * 1.5 + Number(r.strong_count || 0);
			const score = Math.max(0.5, Math.min(2.0, momentum / 4 + Number(r.avg_score || 0) / 90));
			out.push({ term: n.toLowerCase(), weight: score, kind: 'category' });
		}
	} catch { /* oracle table absent — skip */ }
	return out;
}

/** Recent X chatter → hashtags / capitalised entities. */
async function xSignals() {
	const out = [];
	try {
		const rows = await sql`
			select text from x_posts
			where text is not null and created_at > now() - interval '48 hours'
			order by created_at desc limit 40
		`;
		for (const r of rows) {
			for (const n of extractThemes(r.text, { max: 3 })) {
				out.push({ term: n.toLowerCase(), weight: 0.8, kind: 'culture' });
			}
		}
	} catch { /* no X signal — fine */ }
	return out;
}

// ── external providers ──────────────────────────────────────────────────────────

/** Hacker News front page — the tech / internet zeitgeist. */
async function hackerNewsSignals() {
	return cached('launcher:trend:hn', PROVIDER_CACHE_TTL_S, async () => {
		const data = await fetchJson('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30');
		const hits = Array.isArray(data?.hits) ? data.hits : [];
		const out = [];
		for (const h of hits) {
			const pts = Math.max(0.4, Math.min(1.6, Number(h.points || 0) / 200));
			for (const n of extractThemes(h.title, { max: 3, entitiesOnly: true })) {
				out.push({ term: n.toLowerCase(), weight: pts, kind: 'culture' });
			}
		}
		return out;
	});
}

/** Reddit hot across a culture-leaning subreddit set. */
async function redditSignals() {
	return cached('launcher:trend:reddit', PROVIDER_CACHE_TTL_S, async () => {
		const subs = ['memes', 'solana', 'technology', 'worldnews'];
		const out = [];
		const batches = await Promise.all(
			subs.map((s) => fetchJson(`https://www.reddit.com/r/${s}/hot.json?limit=20&raw_json=1`)),
		);
		for (const data of batches) {
			const children = Array.isArray(data?.data?.children) ? data.data.children : [];
			for (const c of children) {
				const d = c?.data;
				if (!d || d.stickied) continue;
				const ups = Math.max(0.4, Math.min(1.8, Number(d.ups || 0) / 5000));
				for (const n of extractThemes(d.title, { max: 3, entitiesOnly: true })) {
					out.push({ term: n.toLowerCase(), weight: ups, kind: 'meme' });
				}
			}
		}
		return out;
	});
}

/**
 * Wikipedia top pageviews — what the world is actually looking up. The article
 * titles ARE the entities (people, events, films, sports), making this a clean
 * "current attention" signal. Uses the most recently completed UTC day.
 */
async function wikipediaSignals() {
	return cached('launcher:trend:wiki', PROVIDER_CACHE_TTL_S, async () => {
		const d = new Date(Date.now() - 36 * 3600 * 1000); // safely-published day
		const yyyy = d.getUTCFullYear();
		const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
		const dd = String(d.getUTCDate()).padStart(2, '0');
		const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${yyyy}/${mm}/${dd}`;
		const data = await fetchJson(url);
		const articles = Array.isArray(data?.items?.[0]?.articles) ? data.items[0].articles : [];
		const out = [];
		for (const a of articles.slice(0, 60)) {
			const title = String(a.article || '').replace(/_/g, ' ');
			// Drop Wikipedia housekeeping pages — not culture.
			if (/^(Main Page|Special:|Wikipedia:|Portal:|Category:|Help:|Template:)/i.test(title)) continue;
			if (/^\d+$/.test(title)) continue;
			const n = normTerm(title);
			if (!n) continue;
			const rank = Number(a.rank || 60);
			const weight = Math.max(0.5, 1.6 - rank / 50); // higher-ranked = hotter
			out.push({ term: n.toLowerCase(), weight, kind: 'event' });
		}
		return out;
	});
}

/**
 * Know Your Meme — the canonical catalogue of memes entering culture. Two feeds:
 *   confirmed.rss — entries newly CONFIRMED by KYM editors; each <title> IS the
 *                   meme's name ("Drooling Cat", "Train Dog"), so it's the single
 *                   cleanest "fresh named meme" signal anywhere.
 *   newsfeed.rss  — active meme news; the meme is the /memes/<slug> in each link,
 *                   which we de-slug into a theme.
 *
 * Both are reduced to generic THEME words (the $THREE rule): the downstream LLM
 * riffs on the culture and invents an original identity — KYM names are never
 * minted verbatim. Recency-decayed (feeds are newest-first), key-less, cached.
 * @returns {Promise<Array<{term:string, weight:number, kind:string}>>}
 */
async function knowYourMemeSignals() {
	return cached('launcher:trend:kym', PROVIDER_CACHE_TTL_S, async () => {
		const [confirmedXml, newsXml] = await Promise.all([
			fetchText('https://knowyourmeme.com/memes/confirmed.rss'),
			fetchText('https://knowyourmeme.com/newsfeed.rss'),
		]);
		const out = [];

		// Confirmed entries: the title is the meme name. Titles often carry alt
		// spellings as "Primary / Variant" — take the first clean variant.
		const confirmed = parseRssItems(confirmedXml).slice(0, 25);
		confirmed.forEach((item, i) => {
			const variant = item.title.split(/\s*\/\s*/).map((v) => normTerm(v)).find(Boolean);
			if (!variant) return;
			const weight = Math.max(0.6, 1.5 - i * 0.04); // newest-first decay
			out.push({ term: variant.toLowerCase(), weight, kind: 'meme' });
		});

		// Newsfeed: de-slug the /memes/<slug> link into a theme phrase.
		const news = parseRssItems(newsXml).slice(0, 25);
		news.forEach((item, i) => {
			const m = item.link.match(/\/memes\/(?:[a-z-]+\/)?([a-z0-9-]+)\b/i);
			if (!m) return;
			const phrase = m[1].replace(/-/g, ' ').trim();
			const n = normTerm(phrase);
			if (!n) return;
			const weight = Math.max(0.5, 1.1 - i * 0.03);
			out.push({ term: n.toLowerCase(), weight, kind: 'meme' });
		});

		return out;
	});
}

/**
 * Google Daily Search Trends — the broadest real-time "what is the world looking
 * up right now" signal. Each item is a trending search term with approximate
 * traffic and the news driving it. Weighted by traffic and, crucially, gated on
 * the news context for brand-safety: a term trending BECAUSE of a tragedy (whose
 * own words look clean) is dropped before it can become a coin theme — the news
 * headlines are scanned with isSensitive, belt-and-braces with the LLM prompt.
 * Reduced to generic themes (the $THREE rule). Key-less, cached, never throws.
 * @returns {Promise<Array<{term:string, weight:number, kind:string}>>}
 */
// Pure parse of a Google Trends RSS body → safe, weighted theme rows. Exported
// for unit tests (network-free); the provider just wraps this in fetch + cache.
function parseGoogleTrends(xml) {
	const blocks = String(xml || '').match(/<item\b[\s\S]*?<\/item>/gi) || [];
	const out = [];
	for (const b of blocks.slice(0, 25)) {
		const titleM = b.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
		const term = normTerm(decodeEntities(titleM ? titleM[1] : ''));
		if (!term) continue;
		// Read the news headlines driving the trend; skip anything sensitive even
		// when the bare term is clean (e.g. a name trending after a death).
		const news = (b.match(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/gi) || [])
			.map((m) => decodeEntities(m.replace(/<\/?ht:news_item_title>/gi, '')))
			.join(' ');
		if (isSensitive(`${term} ${news}`)) continue;
		const trafM = b.match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/i);
		const traffic = trafM ? Number(String(trafM[1]).replace(/[^\d]/g, '')) || 0 : 0;
		// 1k searches → ~0.78, 100k → ~1.3, capped — log-scaled so a viral spike
		// outranks routine chatter without swamping the cross-source signal.
		const weight = Math.max(0.6, Math.min(1.6, 0.6 + Math.log10(Math.max(10, traffic)) / 5));
		out.push({ term: term.toLowerCase(), weight, kind: 'event' });
	}
	return out;
}

async function googleTrendsSignals() {
	return cached('launcher:trend:gtrends', PROVIDER_CACHE_TTL_S, async () => {
		const xml = await fetchText('https://trends.google.com/trending/rss?geo=US');
		return parseGoogleTrends(xml);
	});
}

const PROVIDERS = {
	coin_intel: coinIntelSignals,
	trending: oracleSignals,
	knowyourmeme: knowYourMemeSignals,
	x: xSignals,
	googletrends: googleTrendsSignals,
	hackernews: hackerNewsSignals,
	reddit: redditSignals,
	wikipedia: wikipediaSignals,
};

// ── aggregation ────────────────────────────────────────────────────────────────

/**
 * Rank live cultural currents across the selected providers. Terms confirmed by
 * MULTIPLE independent sources are boosted (cross-source agreement is the strongest
 * signal a narrative is real and rising, not one channel's noise).
 *
 * @param {{network?:string, sources?:string[], categories?:string[], limit?:number, fresh?:boolean}} [opts]
 * @returns {Promise<{terms:Array<{term:string,score:number,sources:string[],kind:string}>, themes:string[], top:{term:string,score:number,sources:string[],kind:string}|null, providers:string[]}>}
 */
export async function rankNarratives({ network = 'mainnet', sources, categories = [], limit = MAX_TERMS, fresh = false } = {}) {
	const wanted = (Array.isArray(sources) && sources.length ? sources : DEFAULT_SOURCES)
		.map((s) => String(s).toLowerCase())
		.filter((s) => PROVIDERS[s]);
	const providers = wanted.length ? wanted : DEFAULT_SOURCES;

	const cacheKey = `launcher:narratives:${network}:${providers.slice().sort().join(',')}:${(categories || []).slice().sort().join(',')}`;
	if (!fresh) {
		try {
			const hit = await cacheGet(cacheKey);
			if (hit) return hit;
		} catch { /* compute live */ }
	}

	const settled = await Promise.all(
		providers.map(async (id) => {
			try {
				const rows = await PROVIDERS[id]({ network, categories });
				return { id, rows: Array.isArray(rows) ? rows : [] };
			} catch {
				return { id, rows: [] };
			}
		}),
	);

	/** @type {Map<string, {term:string, score:number, sources:Set<string>, kind:string, kinds:Map<string,number>}>} */
	const merged = new Map();
	// A single source may emit the same term on many rows (60 intel rows all
	// categorised 'meme'). Cap each source's total contribution per term so raw
	// repetition inside one channel can't drown genuinely distinct narratives —
	// cross-SOURCE agreement (the diversity boost below) is the signal, not
	// within-source volume.
	const PER_SOURCE_TERM_CAP = 2;
	const contributed = new Map();
	for (const { id, rows } of settled) {
		const sw = SOURCE_WEIGHT[id] ?? 1;
		for (const r of rows) {
			const term = String(r.term || '').trim();
			if (!term) continue;
			const ck = `${id}\u0000${term}`;
			const already = contributed.get(ck) || 0;
			if (already >= PER_SOURCE_TERM_CAP) continue;
			const add = Math.min((Number(r.weight) || 0.6) * sw, PER_SOURCE_TERM_CAP - already);
			contributed.set(ck, already + add);
			const cur = merged.get(term);
			if (cur) {
				cur.score += add;
				cur.sources.add(id);
				cur.kinds.set(r.kind || 'culture', (cur.kinds.get(r.kind || 'culture') || 0) + add);
			} else {
				merged.set(term, {
					term,
					score: add,
					sources: new Set([id]),
					kind: r.kind || 'culture',
					kinds: new Map([[r.kind || 'culture', add]]),
				});
			}
		}
	}

	const ranked = [...merged.values()]
		.map((m) => {
			// Cross-source confirmation multiplier: each extra independent source that
			// names a term lifts it well above any single channel's loudest item.
			const diversity = 1 + 0.45 * (m.sources.size - 1);
			// Dominant kind = whichever category contributed the most weight.
			let kind = m.kind;
			let best = -1;
			for (const [k, w] of m.kinds) if (w > best) { best = w; kind = k; }
			// Sector words ('meme', 'animal') are confirmed by every venue precisely
			// because they're generic — damp them below any SPECIFIC narrative so the
			// coiner rides "erling haaland running", never "animal".
			const kindDamp = kind === 'category' ? 0.35 : 1;
			return {
				term: m.term,
				score: Number((m.score * diversity * kindDamp).toFixed(3)),
				sources: [...m.sources],
				kind,
			};
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);

	const result = {
		terms: ranked,
		themes: ranked.map((r) => r.term),
		top: ranked[0] || null,
		providers,
	};

	if (ranked.length) {
		try { await cacheSet(cacheKey, result, AGG_CACHE_TTL_S); } catch { /* ignore */ }
	}
	return result;
}

export { EXTERNAL_SOURCES, DEFAULT_SOURCES };
// The canonical set of narrative provider ids — the single source of truth for
// every consumer that validates a requested `sources` list (admin config, public
// API). Derived from PROVIDERS so it can never drift out of sync again.
export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));

// Exported for unit tests (pure, network-free).
export { decodeEntities, parseRssItems, extractThemes, normTerm, parseGoogleTrends, isSensitive };
