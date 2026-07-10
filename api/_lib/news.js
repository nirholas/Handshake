// Native crypto-news aggregation — the engine behind /api/news/feed, the
// related-news rail on /coin/:id, the Oracle's narrative pillar, pump-intel's
// news-meme matcher, and the /markets surfaces. three.ws fetches the source
// RSS/Atom feeds directly; no third-party news API sits in this path.
//
// Design, at 38 live publisher feeds across 14 categories:
//
//   * Per-source in-memory cache (5 min TTL) with serve-stale-on-error, so one
//     slow or dead feed never blanks the page and repeat requests inside the
//     TTL cost zero upstream calls.
//   * A bounded worker pool (GLOBAL_CONCURRENCY) fronted by a per-domain
//     semaphore (DOMAIN_CONCURRENCY). Shared hosts carry many feeds — a naive
//     Promise.all over the registry earns an instant 429 from them and starves
//     slow feeds of their timeout budget.
//   * A refresh deadline: a request never blocks on a cold registry. It awaits
//     refreshes for REFRESH_DEADLINE_MS, returns whatever is cached, and lets
//     the stragglers land in cache for the next caller. Sources are refreshed
//     in tier order, so the highest-credibility outlets land first.
//   * Exponential backoff per source: a feed that 404s is not re-fetched every
//     five minutes forever. Failures push nextRetryAt out to MAX_BACKOFF_MS.
//
// Every article is real, parsed from the publisher's own feed; nothing is
// fabricated.

import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { NEWS_SOURCES, sourcesForCategory, sourcesForLanguage, sourcePriority } from './news-sources.js';

const FEED_TIMEOUT_MS = 7000;
const FRESH_MS = 300_000; // refetch a source after 5 min
const STALE_OK_MS = 24 * 3600_000; // serve a failed source's last-good copy up to 24h
const MAX_BACKOFF_MS = 6 * 3600_000; // a persistently dead feed (404/410) retries at most every 6h
const SOFT_BACKOFF_MS = 30 * 60_000; // a rate-limited or 5xx feed retries at most every 30 min
const REFRESH_DEADLINE_MS = 2500; // how long a request will wait on cold sources
const GLOBAL_CONCURRENCY = 16; // outbound feed fetches in flight, all domains
const DOMAIN_CONCURRENCY = 3; // outbound feed fetches in flight, per domain
const MAX_ARTICLES_PER_SOURCE = 40; // newest-N per feed keeps the working set bounded

// key → { articles, fetchedAt, ok, failures, nextRetryAt }
const sourceCache = new Map();
// de-duplicated in-flight refreshes so concurrent requests share one fetch
const inflight = new Map();

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// WordPress and its plugins append syndication boilerplate to every excerpt:
// "The post <title> appeared first on <site>.", "Continue reading…",
// "Read more on …", trailing "[…]". None of it is article text — strip it
// before the excerpt reaches a card, a digest summary, or an LLM prompt.
export function stripFeedBoilerplate(text) {
	return String(text || '')
		.replace(/\bThe post .*?appeared first on .*$/is, '')
		.replace(/\bThis (?:post|article) (?:was )?(?:first )?(?:published|appeared).*$/is, '')
		.replace(/\b(?:Continue reading|Read more|Read the full (?:story|article)|The post)\b[^.]*$/i, '')
		.replace(/\[[…\.]+\]\s*$/, '')
		.replace(/\s*(?:…|\.\.\.)\s*$/, '')
		.replace(/\s+/g, ' ')
		.trim();
}

// Cut at a word boundary and mark the elision, so an excerpt never ends
// mid-word ("…the game appeared f").
export function truncateWords(text, max) {
	const t = String(text || '').trim();
	if (!t) return null;
	if (t.length <= max) return t;
	const cut = t.slice(0, max);
	const lastSpace = cut.lastIndexOf(' ');
	return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:—–-]+$/, '')}…`;
}

// Models on the free tiers often wrap JSON in a ```json fence despite being
// told not to. Unwrap before JSON.parse rather than failing the completion.
export function stripJsonFence(text) {
	const t = String(text || '').trim();
	const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
	return (fenced ? fenced[1] : t).trim();
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
			// Some feeds (e.g. Bitcoin Magazine) prefix descriptions with their own
			// name and/or repeat the headline verbatim — strip the echo so cards
			// don't read "Source Title Title …".
			let descText = stripHtml(rawDesc);
			const srcName = src?.name || '';
			if (srcName && descText.toLowerCase().startsWith(srcName.toLowerCase())) {
				descText = descText.slice(srcName.length).trimStart();
			}
			if (title && descText.toLowerCase().startsWith(title.toLowerCase())) {
				descText = descText.slice(title.length).replace(/^[\s—–:-]+/, '');
			}
			const description = truncateWords(stripFeedBoilerplate(descText), 320);
			// Full body many feeds ship (WordPress content:encoded, Atom content).
			// Server-side only — the reader uses it when the publisher's site
			// blocks direct fetches; the feed API strips it from list payloads.
			const fullText = stripHtml(str(it?.['content:encoded']) || str(it?.content?.['#text']) || '');
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
				content_text: fullText.length > (description || '').length + 80 ? fullText.slice(0, 8000) : null,
			};
		})
		.filter(Boolean);
}

// ── Non-RSS sources ──────────────────────────────────────────────────────────
// A source with `kind: 'json'` is shaped by an adapter here instead of by
// parseFeed. The bar for adding one is high: free, keyless, and reachable from
// a datacenter IP (which is what Cloud Run is). Three of cryptocurrency.cv's
// four JSON sources no longer clear it and are deliberately absent —
// CryptoCompare now answers 401, DeFiLlama's /raises answers 402, and Reddit
// answers 403 to cloud egress. Shipping them would mean four sources that fail
// forever.

const JSON_ADAPTERS = {
	// Exchange listing/delisting notices. Market-moving, and published to no RSS
	// feed anywhere. The list endpoint returns title + code + releaseDate only;
	// the canonical permalink is /support/announcement/detail/<code>.
	binance_announcements(data, key) {
		const src = NEWS_SOURCES[key];
		const articles = data?.data?.catalogs?.[0]?.articles;
		if (!Array.isArray(articles)) throw new Error(`${key} unexpected payload`);
		return articles
			.map((a) => {
				const title = stripHtml(a?.title);
				if (!title || !a?.code) return null;
				const link = `https://www.binance.com/en/support/announcement/detail/${a.code}`;
				const iso = Number.isFinite(a.releaseDate) ? new Date(a.releaseDate).toISOString() : null;
				return {
					id: articleId(link),
					title,
					link,
					description: null,
					image: null,
					author: null,
					source: src.name,
					source_key: key,
					category: src.category,
					pub_date: iso,
					tickers: extractTickers(title),
					sentiment: lexiconSentiment(title),
					content_text: null,
				};
			})
			.filter(Boolean);
	},
};

// ── Concurrency control ──────────────────────────────────────────────────────
// Feeds cluster on shared hosts (medium.com, substack.com, mirror.xyz each
// carry many). Firing every feed at once earns a 429 from exactly those hosts,
// so cap globally *and* per domain.

function feedDomain(url) {
	try {
		return new URL(url).hostname;
	} catch {
		return 'invalid';
	}
}

/**
 * Counting semaphore. `release()` hands the slot directly to the next waiter
 * rather than decrementing, so a slot is never double-issued.
 */
function semaphore(limit) {
	let active = 0;
	const waiters = [];
	return {
		async acquire() {
			if (active < limit) {
				active++;
				return;
			}
			await new Promise((resolve) => waiters.push(resolve));
		},
		release() {
			const next = waiters.shift();
			if (next) next();
			else active--;
		},
	};
}

const globalGate = semaphore(GLOBAL_CONCURRENCY);
const domainGates = new Map();

function domainGate(domain) {
	if (!domainGates.has(domain)) domainGates.set(domain, semaphore(DOMAIN_CONCURRENCY));
	return domainGates.get(domain);
}

// ── Per-source fetch ─────────────────────────────────────────────────────────

async function fetchSource(key) {
	const src = NEWS_SOURCES[key];
	const gate = domainGate(feedDomain(src.url));
	// Domain gate first, then the global gate: a request queued behind a busy
	// domain must not occupy a global slot that another domain's feed could use.
	await gate.acquire();
	await globalGate.acquire();
	try {
		const json = src.kind === 'json';
		const resp = await fetch(src.url, {
			headers: {
				accept: json
					? 'application/json'
					: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
				// A polite, identifying bot UA gets through more publisher WAFs than a
				// spoofed browser UA does — a fake Chrome string without the matching
				// TLS/header fingerprint reads as a scraper and earns a 403.
				'user-agent': 'Mozilla/5.0 (compatible; three.ws-news/1.0; +https://three.ws)',
				'accept-language': 'en-US,en;q=0.9',
			},
			signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
			redirect: 'follow',
		});
		if (!resp.ok) {
			const err = new Error(`${key} ${resp.status}`);
			err.status = resp.status;
			throw err;
		}
		if (json) return JSON_ADAPTERS[key](await resp.json(), key);
		return parseFeed(await resp.text(), key);
	} finally {
		globalGate.release();
		gate.release();
	}
}

/** Exponential backoff so a permanently dead feed stops costing us a request every 5 min. */
function backoffFor(failures, status) {
	// A 429/408/5xx (or a timeout, which arrives with no status) means "later",
	// not "gone" — park those under a soft ceiling so a rate-limited publisher
	// recovers within the hour. A 404/410/403 is a real verdict: hard ceiling.
	const transient = !status || status === 429 || status === 408 || (status >= 500 && status < 600);
	const ceiling = transient ? SOFT_BACKOFF_MS : MAX_BACKOFF_MS;
	return Math.min(FRESH_MS * 2 ** Math.max(0, failures - 1), ceiling);
}

function refreshSource(key) {
	if (inflight.has(key)) return inflight.get(key);
	const p = fetchSource(key)
		.then((articles) => {
			const trimmed = articles
				.sort((a, b) => new Date(b.pub_date || 0) - new Date(a.pub_date || 0))
				.slice(0, MAX_ARTICLES_PER_SOURCE);
			sourceCache.set(key, {
				articles: trimmed,
				fetchedAt: Date.now(),
				ok: true,
				failures: 0,
				nextRetryAt: Date.now() + FRESH_MS,
			});
			return trimmed;
		})
		.catch((err) => {
			const prev = sourceCache.get(key);
			const failures = (prev?.failures || 0) + 1;
			// keep the last-good copy; push the next attempt out exponentially
			sourceCache.set(key, {
				articles: prev?.articles || [],
				fetchedAt: prev?.ok ? prev.fetchedAt : Date.now(),
				lastFailAt: Date.now(),
				lastStatus: err?.status || null,
				ok: false,
				failures,
				nextRetryAt: Date.now() + backoffFor(failures, err?.status),
			});
			return prev?.articles || [];
		})
		.finally(() => inflight.delete(key));
	inflight.set(key, p);
	return p;
}

/**
 * Bring `keys` as close to fresh as `deadlineMs` allows, then return every
 * article currently cached for them. Refreshes that miss the deadline keep
 * running and populate the cache for the next request — a cold start degrades
 * to "fewer sources this round", never to a hung request.
 */
async function ensureSources(keys, deadlineMs = REFRESH_DEADLINE_MS) {
	const now = Date.now();
	const stale = keys
		.filter((key) => {
			if (inflight.has(key)) return false;
			const hit = sourceCache.get(key);
			if (!hit) return true;
			if (now < (hit.nextRetryAt || 0)) return false; // backing off
			return now - hit.fetchedAt >= FRESH_MS;
		})
		// highest-credibility sources first, so a deadline-truncated round still
		// returns the outlets that matter most
		.sort((a, b) => sourcePriority(a) - sourcePriority(b));

	if (stale.length) {
		// refreshSource never rejects and self-throttles on the domain + global
		// gates, so kicking them all off here queues rather than stampedes.
		const started = stale.map((key) => refreshSource(key));
		await Promise.race([Promise.all(started), sleep(deadlineMs)]);
	}

	return keys.flatMap((key) => {
		const hit = sourceCache.get(key);
		if (!hit) return [];
		// drop sources whose last-good copy is ancient — stale beyond 24h reads as fake-live
		const age = Date.now() - hit.fetchedAt;
		if (!hit.ok && age > STALE_OK_MS) return [];
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
 *
 * `lang` defaults to 'en'. The registry carries international feeds in 17
 * languages, and folding them into the default view would interleave Korean and
 * Chinese headlines into an English feed. They are opt-in: pass a language code
 * for one, or 'all' for the whole registry.
 *
 * @param {object} opts { category, source, lang, q, limit, offset }
 * @returns {{ articles: Array, total: number, sources_ok: number, sources_total: number }}
 */
export async function getNews({ category, source, lang = 'en', q, limit = 30, offset = 0 } = {}) {
	let keys;
	if (source && NEWS_SOURCES[source]) keys = [source];
	else if (source) return { articles: [], total: 0, sources_ok: 0, sources_total: 0 };
	else {
		keys = sourcesForCategory(category);
		if (lang && lang !== 'all') {
			const inLang = new Set(sourcesForLanguage(lang));
			keys = keys.filter((k) => inLang.has(k));
		}
	}

	// A caller who names one source is asking for that source specifically —
	// give it the full feed timeout rather than the shared fan-out deadline.
	const deadline = keys.length === 1 ? FEED_TIMEOUT_MS + 500 : REFRESH_DEADLINE_MS;
	const all = await ensureSources(keys, deadline);
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
	// content_text is a server-side field for the article reader; list payloads
	// stay light.
	const page = articles.slice(offset, offset + limit).map(({ content_text, ...a }) => a);
	return {
		articles: page,
		total,
		sources_ok,
		sources_total: keys.length,
	};
}

/** Search all sources — used by the /coin/:id related-news rail. */
export async function searchNews(q, limit = 8) {
	return getNews({ q, limit });
}

/**
 * Locate one article (with its feed-provided full text, when the publisher
 * ships one) by link or 16-hex id across every cached source. Used by the
 * reader endpoint as the trusted fallback when a publisher blocks direct
 * page fetches — the content still comes from the publisher's own feed.
 */
export async function findArticle({ link, id }) {
	const keys = sourcesForCategory('all');
	const all = await ensureSources(keys);
	const wantId = id || (link ? articleId(link) : null);
	if (!wantId && !link) return null;
	return all.find((a) => a.id === wantId || (link && a.link === link)) || null;
}
