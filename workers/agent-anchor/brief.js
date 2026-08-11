// brief.js — pure feed-merge + script-split logic for the Newsroom Anchor.
//
// Kept dependency-free and side-effect-free so it can be unit-tested in
// isolation (tests/anchor-brief.test.js) and reused by the worker loop. The
// worker fetches the three live intel feeds, hands the raw payloads here to
// build a compact briefing, asks the brain to script an anchor read, then
// splits that read into a lower-third headline and a spoken body.

// Headline lives in the screen frame's `activity` (320-char hard cap server
// side) and in the lower-third overlay. We aim shorter so it reads cleanly.
export const HEADLINE_MAX = 120;
// Spoken body is synthesized by Magpie TTS (4096-char ceiling); keep an anchor
// read tight so a bulletin stays ~15–25s.
export const BODY_MAX = 700;
// The activity field the push endpoint stores (mirror of api/agent-screen-push).
export const ACTIVITY_MAX = 320;
// How many narrative items the anchor actually reads on air. The rest are
// summarized as a count so a busy market doesn't produce a 2-minute monologue.
export const MAX_ITEMS = 3;

function clean(str) {
	return String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
}

function num(v) {
	const n = typeof v === 'string' ? Number(v) : v;
	return Number.isFinite(n) ? n : null;
}

/** Human label for a sentiment score in [-1, 1]. */
export function sentimentLabel(score) {
	const s = num(score);
	if (s == null) return null;
	if (s >= 0.35) return 'bullish';
	if (s >= 0.1) return 'leaning positive';
	if (s <= -0.35) return 'bearish';
	if (s <= -0.1) return 'leaning negative';
	return 'mixed';
}

/** Compact USD formatting for spoken numbers ($1.2M, $940K, $0.04). */
export function fmtUsd(v) {
	const n = num(v);
	if (n == null) return null;
	const abs = Math.abs(n);
	if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
	if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
	if (abs >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
	if (abs >= 1) return `$${n.toFixed(2)}`;
	return `$${n.toPrecision(2)}`;
}

/**
 * Merge the three raw feed payloads into a compact, anchor-ready briefing.
 *
 * @param {object} feeds
 * @param {{ intel?: Array }|null} [feeds.intel]      — /api/aixbt/intel result
 * @param {{ articles?: Array }|null} [feeds.news]      /api/news/feed result (narrative failover)
 * @param {object|null}            [feeds.sentiment]  — /api/social/sentiment-pulse result
 * @param {object|null}            [feeds.pump]       — pump snapshot result
 * @returns {{ items, sentiment, market, available, offline, isQuiet, narrativeSource }}
 */
export function mergeBrief(feeds = {}) {
	const offline = [];

	// ── Narrative intel (the spine of every bulletin) ────────────────────────
	const rawIntel = Array.isArray(feeds.intel?.intel)
		? feeds.intel.intel
		: Array.isArray(feeds.intel)
			? feeds.intel
			: null;
	let items = [];
	let narrativeSource = null;
	if (rawIntel != null) {
		items = rawIntel
			.map((i) => ({
				category: clean(i?.category) || null,
				headline: clean(i?.description || i?.summary),
				project: clean(i?.project) || null,
				attribution: null,
				ticker: clean(i?.ticker) || null,
				observations: num(i?.observations),
				official: Boolean(i?.official_source),
			}))
			.filter((i) => i.headline)
			// Most-observed / official-sourced narratives lead the broadcast.
			.sort((a, b) => {
				if (a.official !== b.official) return a.official ? -1 : 1;
				return (b.observations || 0) - (a.observations || 0);
			});
		if (items.length) narrativeSource = 'aixbt';
	}
	// Failover rung: when the aixbt lane is down or empty, the aggregated
	// publisher feed keeps a real narrative spine on air instead of leaving the
	// anchor to read a price-only bulletin. Already recency-ordered upstream, and
	// the sort below is stable, so feed order survives.
	if (!items.length) {
		const articles = Array.isArray(feeds.news?.articles)
			? feeds.news.articles
			: Array.isArray(feeds.news)
				? feeds.news
				: null;
		if (articles) {
			items = articles
				.map((a) => ({
					category: clean(a?.category) || null,
					headline: clean(a?.title),
					project: clean(a?.source) || null,
					attribution: clean(a?.source) || null,
					ticker: null,
					observations: null,
					official: false,
				}))
				.filter((i) => i.headline);
			if (items.length) narrativeSource = 'news';
		}
	}
	// Only a spine with nothing in either lane counts as offline: a live feed
	// that simply had no items is quiet, not down.
	if (rawIntel == null && !items.length) offline.push('narrative');
	const totalItems = items.length;
	const topItems = items.slice(0, MAX_ITEMS);

	// ── Sentiment pulse ──────────────────────────────────────────────────────
	let sentiment = null;
	const ov = feeds.sentiment?.overall;
	if (feeds.sentiment == null || feeds.sentiment?.ok === false) {
		offline.push('sentiment');
	} else if (ov && num(ov.count)) {
		sentiment = {
			score: num(ov.score),
			label: sentimentLabel(ov.score),
			count: num(ov.count),
			posPct: num(ov.posPct),
			negPct: num(ov.negPct),
		};
	}

	// ── Market snapshot ──────────────────────────────────────────────────────
	let market = null;
	if (feeds.pump == null) {
		offline.push('flow');
	} else {
		const meta = feeds.pump.meta || {};
		const vol = feeds.pump.volume24h || {};
		const change =
			num(feeds.pump.price?.priceChange24hPct) ??
			num(vol.priceChange24hPct);
		market = {
			symbol: clean(meta.symbol) || null,
			name: clean(meta.name) || null,
			priceUsd: num(feeds.pump.priceUsd) ?? num(feeds.pump.price?.usdPrice),
			change24h: change,
			volume24h: num(vol.volume24hUsd),
			dex: clean(vol.dex) || null,
		};
		// A snapshot that returned nothing useful counts as offline flow.
		if (market.priceUsd == null && market.volume24h == null) {
			market = null;
			offline.push('flow');
		}
	}

	const isQuiet = topItems.length === 0 && !sentiment && !market;

	return {
		items: topItems,
		moreItems: Math.max(0, totalItems - topItems.length),
		sentiment,
		market,
		available: {
			narrative: topItems.length > 0,
			sentiment: !!sentiment,
			flow: !!market,
		},
		narrativeSource,
		offline,
		isQuiet,
	};
}

/**
 * Render the briefing into a plain-text digest the brain turns into a read.
 * Deterministic so the test can assert exactly what the model is handed.
 */
export function briefDigest(brief) {
	const lines = [];
	if (brief.items.length) {
		lines.push('NARRATIVES:');
		brief.items.forEach((it, i) => {
			const tag = it.category ? ` [${it.category}]` : '';
			// Publisher attribution replaces the observation count on the news
			// failover lane, where "how many accounts said it" does not exist.
			const src = it.observations
				? ` (${it.observations} obs)`
				: it.attribution
					? ` (via ${it.attribution})`
					: '';
			lines.push(`${i + 1}.${tag} ${it.headline}${src}`);
		});
		if (brief.moreItems) lines.push(`(+${brief.moreItems} more narratives moving)`);
	}
	if (brief.sentiment) {
		const pos = brief.sentiment.posPct != null ? `, ${brief.sentiment.posPct}% positive` : '';
		lines.push(
			`SENTIMENT: ${brief.sentiment.label} across ${brief.sentiment.count} recent comments${pos}.`,
		);
	}
	if (brief.market) {
		const bits = [];
		if (brief.market.priceUsd != null) bits.push(`price ${fmtUsd(brief.market.priceUsd)}`);
		if (brief.market.change24h != null) {
			const sign = brief.market.change24h >= 0 ? '+' : '';
			bits.push(`${sign}${brief.market.change24h.toFixed(1)}% 24h`);
		}
		if (brief.market.volume24h != null) bits.push(`${fmtUsd(brief.market.volume24h)} 24h volume`);
		if (bits.length) lines.push(`FLOW: ${bits.join(', ')}.`);
	}
	if (brief.offline.length) {
		lines.push(`OFFLINE FEEDS: ${brief.offline.join(', ')} — do not invent data for these.`);
	}
	return lines.join('\n');
}

const ANCHOR_SYSTEM = [
	'You are a live market-news anchor for three.ws.',
	'Read the market to the viewer in plain, confident language — no jargon, no hashtags, no emojis.',
	'Cover the top one to three narratives, one headline plus one line of context each.',
	'Never recommend buying or selling, and never name or promote a specific token ticker or mint other than $THREE — describe the narrative or the flow instead.',
	'If a feed is offline, simply omit it; never invent numbers.',
	'Respond with EXACTLY this shape:',
	'Line 1: HEADLINE: <a punchy on-screen headline, max 90 characters>',
	'Then a blank line.',
	'Then the spoken anchor read: 2 to 4 short sentences, ready to be read aloud.',
].join(' ');

/**
 * Build the { system, messages } payload for POST /api/brain/chat from a brief.
 * Quiet markets get a graceful "nothing moving" prompt rather than silence.
 */
export function buildAnchorMessages(brief) {
	const digest = brief.isQuiet
		? 'The market is quiet right now — no fresh narratives, sentiment, or flow came back this cycle.'
		: briefDigest(brief);
	return {
		system: ANCHOR_SYSTEM,
		messages: [
			{
				role: 'user',
				content: brief.isQuiet
					? `${digest}\n\nGive a brief, calm "quiet market" anchor read acknowledging the lull and that you'll be back with the next bulletin.`
					: `Here is the current market intel. Script the next bulletin.\n\n${digest}`,
			},
		],
	};
}

function stripWrappingQuotes(s) {
	return s.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '').trim();
}

/** First sentence of a body, used as a headline fallback. */
function firstSentence(text) {
	const m = /^(.*?[.!?])(\s|$)/.exec(text);
	return clean(m ? m[1] : text);
}

/**
 * Split a scripted anchor read into a lower-third headline and a spoken body.
 * Tolerant of the model dropping the "HEADLINE:" marker or the blank line.
 *
 * @param {string} script
 * @returns {{ headline: string, body: string }}
 */
export function splitScript(script) {
	const text = clean(script);
	if (!text) return { headline: '', body: '' };

	// Work line-by-line so the marker + blank-line contract is honored when present.
	const lines = String(script).split(/\r?\n/).map((l) => l.trim());
	const nonEmpty = lines.filter(Boolean);

	let headline = '';
	let body = '';

	const markerIdx = nonEmpty.findIndex((l) => /^headline\s*:/i.test(l));
	if (markerIdx !== -1) {
		headline = stripWrappingQuotes(nonEmpty[markerIdx].replace(/^headline\s*:/i, '').trim());
		body = clean(nonEmpty.slice(markerIdx + 1).join(' '));
	} else if (nonEmpty.length > 1) {
		// No marker: treat the first line as the headline, the rest as the read.
		headline = stripWrappingQuotes(nonEmpty[0]);
		body = clean(nonEmpty.slice(1).join(' '));
	} else {
		// Single blob: derive a headline from the first sentence, speak the whole thing.
		headline = firstSentence(text);
		body = text;
	}

	if (!body) body = headline;
	if (!headline) headline = firstSentence(body);

	if (headline.length > HEADLINE_MAX) headline = headline.slice(0, HEADLINE_MAX - 1).trimEnd() + '…';
	if (body.length > BODY_MAX) body = body.slice(0, BODY_MAX - 1).trimEnd() + '…';

	return { headline, body };
}
