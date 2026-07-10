// Native crypto-news aggregation — the engine behind /api/news/feed, the
// related-news rail on /coin/:id, and the /markets surfaces. Ported from the
// cryptocurrency.cv aggregator (same team) after its Vercel deployment was
// retired; three.ws now fetches the source RSS/Atom feeds directly.
//
// Design: per-source in-memory cache (5 min TTL) with serve-stale-on-error —
// one slow or dead feed never blanks the page, and repeat requests within the
// TTL cost zero upstream calls. Every article is real, parsed from the
// publisher's own feed; nothing is fabricated.

import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { NEWS_SOURCES, sourcesForCategory } from './news-sources.js';

const FEED_TIMEOUT_MS = 7000;
const FRESH_MS = 300_000; // refetch a source after 5 min
const STALE_OK_MS = 24 * 3600_000; // serve a failed source's last-good copy up to 24h

// key → { articles, fetchedAt, ok }
const sourceCache = new Map();
// de-duplicated in-flight refreshes so concurrent requests share one fetch
const inflight = new Map();

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function stripHtml(s) {
	return String(s || '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;|&apos;/g, "'")
		.replace(/&#8217;|&rsquo;/g, "'")
		.replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
		.replace(/&#8211;|&ndash;|&#8212;|&mdash;/g, '—')
		.replace(/\s+/g, ' ')
		.trim();
}

// Same 16-hex content-addressed ID scheme as the historical archive, so live
// and archived records share an identity space.
export function articleId(link) {
	return createHash('sha256').update(String(link)).digest('hex').slice(0, 16);
}

// ── Sentiment (lexicon) ──────────────────────────────────────────────────────
// Fast keyword sentiment matching the archive's { score, label, confidence }
// shape. Used for live articles, which arrive without the offline enrichment
// the 662k archived records carry.

const POSITIVE = [
	'surge', 'surges', 'soar', 'soars', 'rally', 'rallies', 'jump', 'jumps', 'gain', 'gains',
	'all-time high', 'ath', 'record high', 'breakout', 'bullish', 'adoption', 'approval',
	'approve', 'approved', 'partnership', 'integration', 'launch', 'launches', 'upgrade',
	'milestone', 'inflow', 'inflows', 'accumulate', 'accumulation', 'outperform', 'recovery',
	'rebound', 'green', 'wins', 'settle', 'settlement approved',
];
const NEGATIVE = [
	'crash', 'crashes', 'plunge', 'plunges', 'dump', 'dumps', 'selloff', 'sell-off', 'slump',
	'hack', 'hacked', 'exploit', 'exploited', 'breach', 'stolen', 'scam', 'fraud', 'lawsuit',
	'sues', 'sued', 'charges', 'ban', 'bans', 'banned', 'crackdown', 'bearish', 'liquidation',
	'liquidations', 'outflow', 'outflows', 'bankruptcy', 'insolvent', 'collapse', 'warning',
	'red', 'drop', 'drops', 'falls', 'tumble', 'tumbles', 'rug pull', 'delist', 'delisting',
];

export function lexiconSentiment(text) {
	const t = ` ${String(text || '').toLowerCase()} `;
	let pos = 0;
	let neg = 0;
	for (const w of POSITIVE) if (t.includes(w)) pos++;
	for (const w of NEGATIVE) if (t.includes(w)) neg++;
	const hits = pos + neg;
	if (!hits) return { score: 0, label: 'neutral', confidence: 0.5 };
	const score = Math.max(-1, Math.min(1, (pos - neg) / Math.max(2, hits)));
	const label =
		score > 0.5 ? 'very_positive' : score > 0.1 ? 'positive' : score < -0.5 ? 'very_negative' : score < -0.1 ? 'negative' : 'neutral';
	return { score: Number(score.toFixed(2)), label, confidence: Math.min(0.9, 0.5 + hits * 0.1) };
}

// ── Ticker extraction ────────────────────────────────────────────────────────
// $SYMBOL mentions plus a wordlist of majors whose bare names/symbols are
// unambiguous in crypto headlines.

const TICKER_WORDS = new Map([
	['bitcoin', 'BTC'], ['btc', 'BTC'], ['ethereum', 'ETH'], ['eth', 'ETH'], ['ether', 'ETH'],
	['solana', 'SOL'], ['sol', 'SOL'], ['xrp', 'XRP'], ['ripple', 'XRP'], ['bnb', 'BNB'],
	['dogecoin', 'DOGE'], ['doge', 'DOGE'], ['cardano', 'ADA'], ['ada', 'ADA'],
	['tether', 'USDT'], ['usdt', 'USDT'], ['usdc', 'USDC'], ['avalanche', 'AVAX'],
	['avax', 'AVAX'], ['polkadot', 'DOT'], ['chainlink', 'LINK'], ['litecoin', 'LTC'],
	['polygon', 'MATIC'], ['tron', 'TRX'], ['shiba inu', 'SHIB'], ['shib', 'SHIB'],
	['sui', 'SUI'], ['aptos', 'APT'], ['near', 'NEAR'], ['arbitrum', 'ARB'], ['optimism', 'OP'],
	['pepe', 'PEPE'], ['bonk', 'BONK'], ['aave', 'AAVE'], ['uniswap', 'UNI'], ['maker', 'MKR'],
	['stellar', 'XLM'], ['monero', 'XMR'], ['cosmos', 'ATOM'], ['filecoin', 'FIL'],
	['hedera', 'HBAR'], ['injective', 'INJ'], ['celestia', 'TIA'], ['jito', 'JTO'],
	['jupiter', 'JUP'], ['worldcoin', 'WLD'], ['toncoin', 'TON'], ['hyperliquid', 'HYPE'],
]);

export function extractTickers(text) {
	const found = new Set();
	const t = String(text || '');
	for (const m of t.matchAll(/\$([A-Z][A-Z0-9]{1,9})\b/g)) found.add(m[1]);
	const lower = ` ${t.toLowerCase().replace(/[^a-z0-9$ ]/g, ' ')} `;
	for (const [word, sym] of TICKER_WORDS) {
		if (lower.includes(` ${word} `)) found.add(sym);
	}
	return [...found].slice(0, 8);
}

// ── Feed parsing ─────────────────────────────────────────────────────────────

function firstImage(html) {
	const m = String(html || '').match(/<img[^>]+src=["']([^"']+)["']/i);
	return m ? m[1] : null;
}

function normalizeLink(it) {
	// RSS: <link>url</link>. Atom: <link href="..."/> possibly an array with
	// rel variants — prefer rel="alternate", else the first href.
	if (typeof it?.link === 'string') return str(it.link);
	if (it?.link?.['@href']) return str(it.link['@href']);
	if (Array.isArray(it?.link)) {
		const alt = it.link.find((l) => l?.['@rel'] === 'alternate' && l?.['@href']);
		const any = it.link.find((l) => l?.['@href']);
		return str(alt?.['@href']) || str(any?.['@href']);
	}
	return null;
}

export function parseFeed(xml, sourceKey) {
	const src = NEWS_SOURCES[sourceKey];
	const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });
	const doc = parser.parse(xml);
	const items = doc?.rss?.channel?.item || doc?.feed?.entry || doc?.['rdf:RDF']?.item || [];
	return (Array.isArray(items) ? items : [items])
		.map((it) => {
			const link = normalizeLink(it);
			const title = stripHtml(str(it?.title?.['#text']) || str(it?.title) || '');
			if (!link || !title) return null;
			const rawDesc =
				str(it?.description) ||
				str(it?.summary?.['#text']) ||
				str(it?.summary) ||
				str(it?.['content:encoded']) ||
				str(it?.content?.['#text']) ||
				'';
			const image =
				str(it?.['media:content']?.['@url']) ||
				(Array.isArray(it?.['media:content']) ? str(it['media:content'][0]?.['@url']) : null) ||
				str(it?.['media:thumbnail']?.['@url']) ||
				str(it?.enclosure?.['@url']) ||
				firstImage(it?.['content:encoded'] || rawDesc);
			const pubDate = str(it?.pubDate) || str(it?.published) || str(it?.updated) || str(it?.['dc:date']);
			const iso = pubDate && !Number.isNaN(Date.parse(pubDate)) ? new Date(pubDate).toISOString() : null;
			const author =
				stripHtml(str(it?.['dc:creator']) || str(it?.author?.name) || str(it?.author) || '') || null;
			const description = stripHtml(rawDesc).slice(0, 320) || null;
			return {
				id: articleId(link),
				title,
				link,
				description,
				image,
				author,
				source: src?.name || sourceKey,
				source_key: sourceKey,
				category: src?.category || 'general',
				pub_date: iso,
				tickers: extractTickers(`${title} ${description || ''}`),
				sentiment: lexiconSentiment(`${title} ${description || ''}`),
			};
		})
		.filter(Boolean);
}

async function fetchSource(key) {
	const src = NEWS_SOURCES[key];
	const resp = await fetch(src.url, {
		headers: {
			accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
			'user-agent': 'Mozilla/5.0 (compatible; three.ws-news/1.0; +https://three.ws)',
		},
		signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
		redirect: 'follow',
	});
	if (!resp.ok) throw new Error(`${key} ${resp.status}`);
	return parseFeed(await resp.text(), key);
}

async function refreshSource(key) {
	if (inflight.has(key)) return inflight.get(key);
	const p = fetchSource(key)
		.then((articles) => {
			sourceCache.set(key, { articles, fetchedAt: Date.now(), ok: true });
			return articles;
		})
		.catch(() => {
			const prev = sourceCache.get(key);
			if (prev) {
				// keep last-good copy but mark the failure time so we retry next call
				sourceCache.set(key, { ...prev, fetchedAt: Date.now(), ok: false });
				return prev.articles;
			}
			sourceCache.set(key, { articles: [], fetchedAt: Date.now(), ok: false });
			return [];
		})
		.finally(() => inflight.delete(key));
	inflight.set(key, p);
	return p;
}

async function ensureSources(keys) {
	const now = Date.now();
	await Promise.all(
		keys.map((key) => {
			const hit = sourceCache.get(key);
			if (hit && now - hit.fetchedAt < FRESH_MS) return null;
			return refreshSource(key);
		}),
	);
	return keys.flatMap((key) => {
		const hit = sourceCache.get(key);
		if (!hit) return [];
		// drop sources whose last-good copy is ancient — stale beyond 24h reads as fake-live
		if (!hit.ok && now - hit.fetchedAt > STALE_OK_MS) return [];
		return hit.articles;
	});
}

function dedupe(articles) {
	const seen = new Set();
	const out = [];
	for (const a of articles) {
		const titleKey = a.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
		if (seen.has(a.id) || (titleKey && seen.has(titleKey))) continue;
		seen.add(a.id);
		if (titleKey) seen.add(titleKey);
		out.push(a);
	}
	return out;
}

/**
 * Aggregate live news across the registry.
 * @param {object} opts { category, source, q, limit, offset }
 * @returns {{ articles: Array, total: number, sources_ok: number, sources_total: number }}
 */
export async function getNews({ category, source, q, limit = 30, offset = 0 } = {}) {
	let keys;
	if (source && NEWS_SOURCES[source]) keys = [source];
	else if (source) return { articles: [], total: 0, sources_ok: 0, sources_total: 0 };
	else keys = sourcesForCategory(category);

	const all = await ensureSources(keys);
	let articles = dedupe(all).sort(
		(a, b) => new Date(b.pub_date || 0) - new Date(a.pub_date || 0),
	);
	if (q) {
		const needle = q.toLowerCase();
		articles = articles.filter((a) =>
			`${a.title} ${a.description || ''} ${a.tickers.join(' ')}`.toLowerCase().includes(needle),
		);
	}
	const total = articles.length;
	const sources_ok = keys.filter((k) => sourceCache.get(k)?.ok).length;
	return {
		articles: articles.slice(offset, offset + limit),
		total,
		sources_ok,
		sources_total: keys.length,
	};
}

/** Search all sources — used by the /coin/:id related-news rail. */
export async function searchNews(q, limit = 8) {
	return getNews({ q, limit });
}
