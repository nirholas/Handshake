// Coin Intelligence — classification. Answers "what kind of coin is this?"
//
// Category: meme | tech | ai | culture | community | political | news | animal |
//           celebrity | utility | unknown
//
// Three layers, and it NEVER fails (Rule 9):
//   1. A deterministic keyword heuristic — instant, free, always available.
//   2. Real-time news headline matching via the native three.ws news engine
//      (2-min cached). This gives is_news_meme ground truth — not a guess.
//   3. An LLM pass (free-first via llmComplete) that refines category, extracts
//      tags + a one-line narrative thesis.
// If the LLM is unavailable or times out, the heuristic + news-match stand.

import { llmComplete } from '../../../api/_lib/llm.js';
import { matchNewsHeadline } from '../../../api/_lib/pump-intel/news-matcher.js';

const CATEGORIES = [
	'meme', 'tech', 'ai', 'culture', 'community',
	'political', 'news', 'animal', 'celebrity', 'utility', 'unknown',
];

// Ordered keyword tables — first strong hit wins for the heuristic seed. Lower
// tables are weaker; AI is checked before tech (it's a tech subtype we surface
// separately), animal before meme (animals are usually memes but worth tagging).
const KEYWORDS = [
	['ai', /\b(ai|artificial intelligence|gpt|llm|agent|neural|machine learning|ml|model|inference|gpu|compute)\b/i],
	['animal', /\b(dog|doge|shib|inu|cat|kitty|frog|pepe|monkey|ape|bear|bull|penguin|hippo|capybara|wolf|fox|duck|goat|hamster)\b/i],
	['political', /\b(trump|biden|maga|election|president|senator|congress|vote|government|liberty|freedom|patriot|democrat|republican)\b/i],
	['celebrity', /\b(elon|musk|kanye|drake|taylor|swift|messi|ronaldo|kardashian|mrbeast|celebrity)\b/i],
	['tech', /\b(protocol|chain|defi|stake|staking|yield|swap|dex|node|validator|zk|rollup|layer|infra|sdk|oracle|bridge)\b/i],
	['utility', /\b(tool|utility|payment|pay|wallet|launchpad|scanner|tracker|bot|dashboard|api)\b/i],
	['culture', /\b(culture|art|music|fashion|sport|game|gaming|movie|anime|meme culture|lifestyle|vibe)\b/i],
	['community', /\b(community|dao|family|gang|army|holders|together|movement|cult|society|club)\b/i],
];

function tokenize(text) {
	return (text || '')
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.split(/\s+/)
		.filter((w) => w.length >= 3 && w.length <= 20);
}

/**
 * Instant deterministic classification. Always returns a result.
 * @returns {{ category: string, tags: string[], confidence: number, source: 'heuristic' }}
 */
export function heuristicClassify({ name, symbol, description } = {}) {
	const haystack = `${name || ''} ${symbol || ''} ${description || ''}`;
	for (const [cat, re] of KEYWORDS) {
		const m = haystack.match(re);
		if (m) {
			return {
				category: cat,
				tags: [m[0].toLowerCase()].filter(Boolean),
				confidence: 0.45,
				source: 'heuristic',
			};
		}
	}
	// No keyword hit: short tickers with descriptions read as memes; otherwise unknown.
	const words = tokenize(`${name || ''} ${description || ''}`);
	return {
		category: words.length ? 'meme' : 'unknown',
		tags: [],
		confidence: words.length ? 0.3 : 0.15,
		source: 'heuristic',
	};
}

const SYSTEM = `You are a pump.fun coin classifier. Given a coin's name, symbol, and description, classify it precisely. Be literal and grounded — do not hype. Output ONLY strict JSON, no prose.`;

function buildUser({ name, symbol, description, twitter, telegram, website }) {
	// Truncate and XML-delimit each field so a token creator can't inject LLM
	// instructions via a crafted coin name/description and force a mis-classify.
	const safe = (s, max) => String(s || '').slice(0, max);
	return `Classify this pump.fun coin.

<name>${safe(name, 64) || '(none)'}</name>
<symbol>${safe(symbol, 10) || '(none)'}</symbol>
<description>${safe(description, 300) || '(none)'}</description>
Has socials: ${[twitter && 'twitter', telegram && 'telegram', website && 'website'].filter(Boolean).join(', ') || 'none'}

Output strict JSON:
{
  "category": one of ${JSON.stringify(CATEGORIES)},
  "is_news_meme": boolean,        // true if it references a current/recent news story or trending event
  "tags": ["3-6 short lowercase tags"],
  "narrative": "one literal sentence: what this coin is about and why someone made it",
  "confidence": 0.0-1.0
}

Rules: pick the single best category. "ai" for AI/agent themes, "tech" for protocol/defi/infra, "animal" for animal mascots, "meme" only when nothing more specific fits. Never invent facts not implied by the inputs.`;
}

function coerceCategory(c) {
	const v = String(c || '').toLowerCase().trim();
	return CATEGORIES.includes(v) ? v : 'unknown';
}

function parseJson(text) {
	if (!text) return null;
	// Tolerate code fences / leading prose.
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return null;
	try { return JSON.parse(match[0]); } catch { return null; }
}

/**
 * Full classification: heuristic seed → real-time news match → LLM refinement.
 * Always resolves to a usable record — never throws.
 *
 * @returns {Promise<{category, tags, narrative, is_news_meme, news_headline, news_url, confidence, source}>}
 */
export async function classifyCoin(coin = {}, { timeoutMs = 12_000, useLlm = true } = {}) {
	const seed = heuristicClassify(coin);

	// Layer 2: real-time news headline match (fast, cached, no LLM cost).
	// Runs in parallel with any subsequent LLM call so it never adds latency.
	const newsMatchPromise = (coin.name || coin.symbol || coin.description)
		? matchNewsHeadline(coin).catch(() => ({ matched: false, headline: null, url: null, confidence: 0 }))
		: Promise.resolve({ matched: false, headline: null, url: null, confidence: 0 });

	// LLM disabled (cost control), or nothing to feed it — keep heuristic + news.
	if (!useLlm || (!coin.name && !coin.symbol && !coin.description)) {
		const news = await newsMatchPromise;
		const category = (news.matched && seed.category === 'unknown') ? 'news' : seed.category;
		return {
			...seed,
			category,
			narrative: null,
			is_news_meme: news.matched,
			news_headline: news.headline,
			news_url: news.url,
			confidence: news.matched ? Math.max(seed.confidence, news.confidence) : seed.confidence,
		};
	}

	// Layer 3: LLM + news in parallel
	const [llmResult, news] = await Promise.allSettled([
		llmComplete({
			system: SYSTEM,
			user: buildUser(coin),
			maxTokens: 300,
			timeoutMs,
		}),
		newsMatchPromise,
	]);

	const newsMatch = news.status === 'fulfilled' ? news.value
		: { matched: false, headline: null, url: null, confidence: 0 };

	try {
		const raw = llmResult.status === 'fulfilled' ? llmResult.value : null;
		const parsed = raw ? parseJson(typeof raw === 'string' ? raw : raw?.text) : null;

		if (!parsed) {
			// LLM failed — heuristic + news match
			const category = (newsMatch.matched && seed.category === 'unknown') ? 'news' : seed.category;
			return {
				...seed,
				category,
				narrative: null,
				is_news_meme: newsMatch.matched,
				news_headline: newsMatch.headline,
				news_url: newsMatch.url,
				confidence: newsMatch.matched ? Math.max(seed.confidence, newsMatch.confidence) : seed.confidence,
			};
		}

		const tags = Array.isArray(parsed.tags)
			? parsed.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 6)
			: seed.tags;
		const conf = Number(parsed.confidence);

		// news-matcher overrides LLM's is_news_meme when it found a real headline —
		// a real URL is more trustworthy than the model's guess.
		const is_news_meme = newsMatch.matched || !!parsed.is_news_meme;
		const llmCategory = coerceCategory(parsed.category);
		const category = (newsMatch.matched && llmCategory !== 'news') ? 'news' : llmCategory;

		return {
			category,
			tags: tags.length ? tags : seed.tags,
			narrative: parsed.narrative ? String(parsed.narrative).slice(0, 280) : null,
			is_news_meme,
			news_headline: newsMatch.headline,
			news_url: newsMatch.url,
			confidence: Number.isFinite(conf)
				? Math.max(0, Math.min(1, newsMatch.matched ? Math.max(conf, newsMatch.confidence) : conf))
				: (newsMatch.matched ? Math.max(seed.confidence, newsMatch.confidence) : 0.6),
			source: 'llm',
		};
	} catch {
		// LLM parse failed — heuristic + news
		const category = (newsMatch.matched && seed.category === 'unknown') ? 'news' : seed.category;
		return {
			...seed,
			category,
			narrative: null,
			is_news_meme: newsMatch.matched,
			news_headline: newsMatch.headline,
			news_url: newsMatch.url,
			confidence: newsMatch.matched ? Math.max(seed.confidence, newsMatch.confidence) : seed.confidence,
		};
	}
}

export const _internals = { CATEGORIES, KEYWORDS, tokenize };
