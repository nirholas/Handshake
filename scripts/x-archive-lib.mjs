// Shared normalization + analysis for the @trythreews post archive.
//
// Two consumers: scripts/x-archive-import.mjs (file -> Postgres) and
// scripts/x-archive-analyze.mjs (archive -> engagement report). They must agree
// on exactly what a post is and how engagement is measured, so every rule lives
// here once and is covered by tests/x-archive.test.js.

import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const ARCHIVE_DIR = 'data/x-archive';

// X's web timeline abbreviates every counter past 999 ("6.3K", "1.2M"), so a
// scraped number above that threshold carries two significant figures and no
// more. Return both what we parsed and whether the source was exact, so an
// analysis can say "about 6.3K" rather than pretending it measured 6300.
export function parseCount(raw) {
	if (raw === null || raw === undefined) return { value: null, exact: false, label: null };
	const label = String(raw).trim();
	if (!label) return { value: null, exact: false, label: null };

	const m = label.replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*([KMB])?$/i);
	if (!m) return { value: null, exact: false, label };

	const n = Number(m[1]);
	const suffix = (m[2] || '').toUpperCase();
	const scale = suffix === 'B' ? 1e9 : suffix === 'M' ? 1e6 : suffix === 'K' ? 1e3 : 1;
	return { value: Math.round(n * scale), exact: scale === 1, label };
}

// A scraped counter that cannot be true. X's timeline renders like counts
// lazily, so a scroll-based scrape regularly captures a post at "0 likes" that
// clearly earned engagement: 56 of the first 214 @trythreews posts came back
// that way, including one with 6.8K views and 16 replies. Treating those as
// real zeros would drag every median down and fill the "worst posts" table with
// scraper artifacts instead of weak writing. They stay in the archive and are
// named in the report; `npm run x:archive:refresh` replaces them with exact
// counts from the X API.
export function isMetricsSuspect(post) {
	// The X API returns public_metrics exactly, so a zero from it is a real
	// zero and must not be second-guessed by a heuristic built for the scraper.
	if (post.metricsSource === 'x-api-v2') return post.likes === null || post.likes === undefined;
	if (post.likes === null || post.likes === undefined) return true;
	if (post.likes > 0) return false;
	return (post.retweets || 0) > 0 || (post.replies || 0) >= 2 || (post.views || 0) >= 1000;
}

function textList(v) {
	return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
}

// Who wrote a post, read from its permalink. A profile scrape returns the whole
// timeline, and a repost or quote of someone else's post keeps THEIR permalink,
// so the author is the one fact that separates "we wrote this" from "we
// amplified this". The scrape's own isRetweet flag does not: it came back false
// for all 145 reposts in the first @trythreews archive. Getting this wrong
// silently credits another account's reach to our writing.
export function authorOf(raw, fallbackHandle) {
	const m = String(raw.url || '').match(/(?:twitter|x)\.com\/([^/]+)\/status\//i);
	return m ? m[1].toLowerCase() : fallbackHandle;
}

// One scraped tweet -> the canonical row shape shared by the DB and the report.
export function normalizePost(raw, { handle, metricsSource = 'scrape' }) {
	const id = String(raw.id || '').trim();
	if (!id) throw new Error('tweet is missing an id');
	const posted = raw.timestamp ? new Date(raw.timestamp) : null;
	if (!posted || Number.isNaN(posted.getTime())) throw new Error(`tweet ${id} has no usable timestamp`);

	const metrics = raw.metrics || {};
	const likes = parseCount(metrics.likes);
	const retweets = parseCount(metrics.retweets);
	const replies = parseCount(metrics.replies);
	const views = parseCount(metrics.views);
	const media = raw.media || {};
	const type = raw.type || {};
	const extracted = raw.extracted || {};
	const authorHandle = authorOf(raw, handle);

	const post = {
		tweetId: id,
		handle,
		authorHandle,
		isOwn: authorHandle === handle.toLowerCase(),
		url: raw.url || `https://x.com/${handle}/status/${id}`,
		text: typeof raw.text === 'string' ? raw.text : '',
		postedAt: posted.toISOString(),
		isRetweet: Boolean(type.isRetweet) || authorHandle !== handle.toLowerCase(),
		isReply: Boolean(type.isReply),
		isPinned: Boolean(type.isPinned),
		hasImage: Boolean(media.hasImage),
		hasVideo: Boolean(media.hasVideo),
		hasCard: Boolean(media.hasCard),
		hashtags: textList(extracted.hashtags),
		mentions: textList(extracted.mentions),
		urls: textList(extracted.urls),
		likes: likes.value,
		retweets: retweets.value,
		replies: replies.value,
		views: views.value,
		viewsLabel: views.label,
		viewsExact: views.exact,
		metricsSource,
		measuredAt: raw.scrapedAt || null,
	};

	post.metricsSuspect = isMetricsSuspect(post);
	return post;
}

// A whole scrape file -> { handle, scrapedAt, posts, sha256 }.
export function normalizeScrape(doc, { sourceText = null } = {}) {
	const handle = String(doc.profile || '').replace(/^@/, '').trim();
	if (!handle) throw new Error('scrape file has no `profile` handle');
	const scrapedAt = doc.scrapedAt ? new Date(doc.scrapedAt) : null;
	if (!scrapedAt || Number.isNaN(scrapedAt.getTime())) throw new Error('scrape file has no usable `scrapedAt`');
	if (!Array.isArray(doc.tweets)) throw new Error('scrape file has no `tweets` array');

	// A file written by scripts/x-archive-refresh.mjs declares its provenance;
	// anything else is a timeline scrape with the counter caveats that implies.
	const metricsSource = doc.source === 'x-api-v2' ? 'x-api-v2' : 'scrape';

	const seen = new Set();
	const posts = [];
	for (const raw of doc.tweets) {
		const post = normalizePost(raw, { handle, metricsSource });
		if (seen.has(post.tweetId)) continue; // a scrape can re-see a post while scrolling
		seen.add(post.tweetId);
		post.measuredAt = post.measuredAt || scrapedAt.toISOString();
		posts.push(post);
	}

	return {
		handle,
		metricsSource,
		scrapedAt: scrapedAt.toISOString(),
		posts,
		sha256: sourceText === null ? null : createHash('sha256').update(sourceText).digest('hex'),
	};
}

export async function readScrapeFile(file) {
	const sourceText = await readFile(file, 'utf8');
	const scrape = normalizeScrape(JSON.parse(sourceText), { sourceText });
	return { ...scrape, sourceFile: file };
}

export async function listArchiveFiles(dir) {
	let names = [];
	try {
		names = await readdir(dir);
	} catch (err) {
		if (err.code === 'ENOENT') return [];
		throw err;
	}
	return names.filter((n) => n.endsWith('.json')).sort().map((n) => path.join(dir, n));
}

// Merge every scrape of an account into one post list. Later measurements win,
// so a post scraped twice carries its freshest counters while keeping the
// earlier ones as history.
export function mergeScrapes(scrapes) {
	const byId = new Map();
	const history = new Map();
	for (const scrape of [...scrapes].sort((a, b) => a.scrapedAt.localeCompare(b.scrapedAt))) {
		for (const post of scrape.posts) {
			const prior = byId.get(post.tweetId);
			byId.set(post.tweetId, prior ? { ...prior, ...post } : post);
			const list = history.get(post.tweetId) || [];
			list.push({
				capturedAt: post.measuredAt,
				likes: post.likes,
				retweets: post.retweets,
				replies: post.replies,
				views: post.views,
			});
			history.set(post.tweetId, list);
		}
	}
	return {
		posts: [...byId.values()].sort((a, b) => b.postedAt.localeCompare(a.postedAt)),
		history,
	};
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export const ENGAGEMENT_WEIGHTS = { likes: 1, retweets: 1, replies: 1 };

// Total engagements, excluding views. Views measure delivery; likes, reposts
// and replies measure whether anyone cared, and only the second is a signal
// about the writing.
export function engagements(post) {
	return (post.likes || 0) + (post.retweets || 0) + (post.replies || 0);
}

// Engagements per 100 impressions. Null when views were never measured, so a
// post with no view count is left out of the rate view rather than scored 0.
export function engagementRate(post) {
	if (!post.views) return null;
	return (engagements(post) / post.views) * 100;
}

export function median(nums) {
	const xs = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
	if (!xs.length) return null;
	const mid = Math.floor(xs.length / 2);
	return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

export function mean(nums) {
	const xs = nums.filter((n) => Number.isFinite(n));
	if (!xs.length) return null;
	return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function percentile(nums, p) {
	const xs = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
	if (!xs.length) return null;
	const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
	return xs[idx];
}

// The content dimensions we can measure from a scraped post without guessing.
// Each is a predicate over the post; the report scores every one against the
// corpus median so a claim reads as "threads land 2.1x the median", not as a
// raw average that one viral post dominates.
export const FORMAT_DIMENSIONS = [
	{ key: 'image', label: 'Has an image', test: (p) => p.hasImage },
	{ key: 'video', label: 'Has a video', test: (p) => p.hasVideo },
	{ key: 'card', label: 'Has a link card', test: (p) => p.hasCard },
	{ key: 'no_media', label: 'Text only', test: (p) => !p.hasImage && !p.hasVideo && !p.hasCard },
	{ key: 'mention', label: 'Mentions an account', test: (p) => p.mentions.length > 0 },
	{ key: 'link', label: 'Contains a link', test: (p) => p.urls.length > 0 || /https?:\/\//.test(p.text) },
	{ key: 'cashtag', label: 'Names $THREE', test: (p) => /\$THREE\b/i.test(p.text) },
	{ key: 'question', label: 'Asks a question', test: (p) => p.text.includes('?') },
	{ key: 'numbers', label: 'Leads with a number', test: (p) => /^\W*\d/.test(p.text.trim()) },
	{ key: 'reply', label: 'Is a reply', test: (p) => p.isReply },
	{ key: 'multiline', label: 'Multi-paragraph', test: (p) => p.text.split(/\n\s*\n/).length > 1 },
];

export const LENGTH_BUCKETS = [
	{ key: 'xs', label: '1-99 chars', min: 0, max: 99 },
	{ key: 's', label: '100-179 chars', min: 100, max: 179 },
	{ key: 'm', label: '180-279 chars', min: 180, max: 279 },
	{ key: 'l', label: '280-499 chars', min: 280, max: 499 },
	{ key: 'xl', label: '500+ chars', min: 500, max: Infinity },
];

// Topic tagging by keyword. Deliberately explicit rather than clustered: a
// keyword list is auditable, and a wrong tag is a one-line fix instead of an
// unexplainable embedding.
export const TOPICS = [
	{ key: 'token', label: 'Token / $THREE', patterns: [/\$THREE/i, /\btoken\b/i, /\bholders?\b/i, /market cap/i] },
	{ key: 'avatar', label: 'Avatars / 3D', patterns: [/\bavatars?\b/i, /\b3d\b/i, /\bglb\b/i, /\brig(ged|ging)?\b/i, /\bmesh\b/i] },
	{ key: 'agent', label: 'Agents', patterns: [/\bagents?\b/i, /\bmcp\b/i, /\bskills?\b/i, /\bautonomous\b/i] },
	{ key: 'payments', label: 'Payments / x402', patterns: [/x402/i, /\busdc\b/i, /\bpayments?\b/i, /\bwallet\b/i] },
	{ key: 'shipping', label: 'Shipped / changelog', patterns: [/\bship(ped|ping)?\b/i, /\blive now\b/i, /\bjust launched\b/i, /\bnew:/i, /\brelease[ds]?\b/i] },
	{ key: 'partner', label: 'Partner / ecosystem', patterns: [/\bpartner/i, /\bverified on\b/i, /\bnow on\b/i, /\bintegrat/i, /\blisted\b/i] },
	{ key: 'build_log', label: 'Build log / behind the scenes', patterns: [/\bwe (built|spent|shipped|rewrote)\b/i, /\bhow we\b/i, /\bunder the hood\b/i, /\bbenchmark/i] },
	{ key: 'commentary', label: 'Industry commentary', patterns: [/\bindustry\b/i, /\beveryone\b/i, /\bmost (people|teams)\b/i, /\bthe problem with\b/i, /\bhot take\b/i] },
];

export function topicsOf(post) {
	const hits = TOPICS.filter((t) => t.patterns.some((re) => re.test(post.text))).map((t) => t.key);
	return hits.length ? hits : ['other'];
}

export function lengthBucketOf(post) {
	const len = post.text.length;
	return LENGTH_BUCKETS.find((b) => len >= b.min && len <= b.max)?.key || 'xs';
}

function summarizeGroup(posts, baselineMedian) {
	const eng = posts.map(engagements);
	const rates = posts.map(engagementRate).filter((r) => r !== null);
	const med = median(eng);
	return {
		count: posts.length,
		medianEngagements: med,
		meanEngagements: mean(eng),
		bestEngagements: eng.length ? Math.max(...eng) : null,
		medianRatePct: median(rates),
		lift: med !== null && baselineMedian ? med / baselineMedian : null,
	};
}

// The whole report, as data. The markdown renderer in x-archive-analyze.mjs is
// a pure function of this object, so the same numbers can feed a page or an API
// later without re-deriving anything.
export function analyze(posts, { handle = null, minPostsForLift = 5 } = {}) {
	// Only what the account itself wrote. Reposts and quotes of other accounts
	// carry the original author's engagement, which is not evidence about our
	// writing, and the scraper's counters for them are unreliable besides.
	const own = (p) => (p.isOwn === undefined ? !p.isRetweet : p.isOwn);
	const amplified = posts.filter((p) => !own(p));
	const ownPosts = posts.filter(own);
	const suspect = ownPosts.filter((p) => (p.metricsSuspect === undefined ? isMetricsSuspect(p) : p.metricsSuspect));
	const suspectIds = new Set(suspect.map((p) => p.tweetId));
	const corpus = ownPosts.filter((p) => !suspectIds.has(p.tweetId));
	const eng = corpus.map(engagements);
	const baseline = median(eng) || 0;
	const rates = corpus.map(engagementRate).filter((r) => r !== null);

	const totals = corpus.reduce(
		(acc, p) => {
			acc.likes += p.likes || 0;
			acc.retweets += p.retweets || 0;
			acc.replies += p.replies || 0;
			acc.views += p.views || 0;
			return acc;
		},
		{ likes: 0, retweets: 0, replies: 0, views: 0 },
	);

	const sortedByDate = [...corpus].sort((a, b) => a.postedAt.localeCompare(b.postedAt));
	const byMonth = new Map();
	for (const p of corpus) {
		const key = p.postedAt.slice(0, 7);
		if (!byMonth.has(key)) byMonth.set(key, []);
		byMonth.get(key).push(p);
	}

	const byHour = new Map();
	const byWeekday = new Map();
	for (const p of corpus) {
		const d = new Date(p.postedAt);
		const h = d.getUTCHours();
		const w = d.getUTCDay();
		if (!byHour.has(h)) byHour.set(h, []);
		if (!byWeekday.has(w)) byWeekday.set(w, []);
		byHour.get(h).push(p);
		byWeekday.get(w).push(p);
	}

	const topicGroups = new Map();
	for (const p of corpus) {
		for (const key of topicsOf(p)) {
			if (!topicGroups.has(key)) topicGroups.set(key, []);
			topicGroups.get(key).push(p);
		}
	}

	const lengthGroups = new Map();
	for (const p of corpus) {
		const key = lengthBucketOf(p);
		if (!lengthGroups.has(key)) lengthGroups.set(key, []);
		lengthGroups.get(key).push(p);
	}

	const mentionCounts = new Map();
	for (const p of corpus) {
		for (const m of new Set(p.mentions.map((x) => x.toLowerCase()))) {
			const cur = mentionCounts.get(m) || { handle: m, posts: 0, engagements: 0 };
			cur.posts++;
			cur.engagements += engagements(p);
			mentionCounts.set(m, cur);
		}
	}

	const rank = (list, n) => [...list].sort((a, b) => engagements(b) - engagements(a)).slice(0, n);

	return {
		handle,
		generatedFrom: {
			posts: posts.length,
			ownPosts: ownPosts.length,
			analyzed: corpus.length,
			retweetsExcluded: amplified.length,
			suspectExcluded: suspect.length,
			suspectSample: suspect
				.slice()
				.sort((a, b) => (b.views || 0) - (a.views || 0))
				.slice(0, 5)
				.map((p) => ({ tweetId: p.tweetId, url: p.url, postedAt: p.postedAt, views: p.views, replies: p.replies })),
			firstPostAt: sortedByDate[0]?.postedAt || null,
			lastPostAt: sortedByDate[sortedByDate.length - 1]?.postedAt || null,
		},
		// Reposts are excluded from every measurement above, but who we amplify
		// is its own marketing fact, so it is reported rather than dropped.
		amplified: {
			count: amplified.length,
			byAuthor: [...amplified.reduce((m, p) => m.set(p.authorHandle || 'unknown', (m.get(p.authorHandle || 'unknown') || 0) + 1), new Map())]
				.map(([author, count]) => ({ author, count }))
				.sort((a, b) => b.count - a.count)
				.slice(0, 15),
		},
		totals,
		distribution: {
			medianEngagements: baseline,
			meanEngagements: mean(eng),
			p75: percentile(eng, 75),
			p90: percentile(eng, 90),
			p99: percentile(eng, 99),
			max: eng.length ? Math.max(...eng) : null,
			medianRatePct: median(rates),
			ratedPosts: rates.length,
			// Share of all engagement earned by the top decile: the number that
			// says whether the account is carried by a few posts or by a floor.
			topDecileShare: (() => {
				const sorted = [...eng].sort((a, b) => b - a);
				const total = sorted.reduce((a, b) => a + b, 0);
				if (!total) return null;
				const cut = Math.max(1, Math.round(sorted.length * 0.1));
				return sorted.slice(0, cut).reduce((a, b) => a + b, 0) / total;
			})(),
		},
		top: {
			byEngagements: rank(corpus, 15),
			byLikes: [...corpus].sort((a, b) => (b.likes || 0) - (a.likes || 0)).slice(0, 10),
			byRate: corpus
				.filter((p) => engagementRate(p) !== null && (p.views || 0) >= 500)
				.sort((a, b) => engagementRate(b) - engagementRate(a))
				.slice(0, 10),
			byReplies: [...corpus].sort((a, b) => (b.replies || 0) - (a.replies || 0)).slice(0, 10),
			worst: [...corpus].sort((a, b) => engagements(a) - engagements(b)).slice(0, 10),
		},
		formats: FORMAT_DIMENSIONS.map((d) => {
			const hit = corpus.filter(d.test);
			const miss = corpus.filter((p) => !d.test(p));
			return {
				key: d.key,
				label: d.label,
				with: summarizeGroup(hit, baseline),
				without: summarizeGroup(miss, baseline),
				significant: hit.length >= minPostsForLift && miss.length >= minPostsForLift,
			};
		}),
		lengths: LENGTH_BUCKETS.map((b) => ({
			key: b.key,
			label: b.label,
			...summarizeGroup(lengthGroups.get(b.key) || [], baseline),
		})),
		topics: [...topicGroups.entries()]
			.map(([key, group]) => ({
				key,
				label: TOPICS.find((t) => t.key === key)?.label || 'Other',
				...summarizeGroup(group, baseline),
				best: rank(group, 3),
			}))
			.sort((a, b) => (b.lift || 0) - (a.lift || 0)),
		timing: {
			byHourUtc: [...byHour.entries()]
				.map(([hour, group]) => ({ hour, ...summarizeGroup(group, baseline) }))
				.sort((a, b) => a.hour - b.hour),
			byWeekdayUtc: [...byWeekday.entries()]
				.map(([weekday, group]) => ({ weekday, ...summarizeGroup(group, baseline) }))
				.sort((a, b) => a.weekday - b.weekday),
		},
		cadence: [...byMonth.entries()]
			.map(([month, group]) => ({ month, ...summarizeGroup(group, baseline) }))
			.sort((a, b) => a.month.localeCompare(b.month)),
		mentions: [...mentionCounts.values()]
			.map((m) => ({ ...m, meanEngagements: m.engagements / m.posts }))
			.sort((a, b) => b.meanEngagements - a.meanEngagements)
			.filter((m) => m.posts >= 2)
			.slice(0, 20),
	};
}
