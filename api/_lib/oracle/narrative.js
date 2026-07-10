// Oracle — cultural narrative classifier.
//
// The user's ask: don't just tag a coin "meme" — understand the *thesis*. Is it
// a news-story meme riding a live headline? A culture/community coin? A tech/AI
// play? An animal? A celebrity? Each flavor behaves differently on pump.fun, so
// the conviction engine weights them differently (see conviction.js narrative
// pillar). This module produces that read.
//
// Three paths, all REAL:
//   1. llmComplete with live news context injected from the native three.ws
//      news engine — the LLM sees matching headlines and writes a precise
//      thesis ("rides today's Trump tariff announcement"). Virality is boosted
//      by real news signal.
//   2. llmComplete with no news context (fallback when no headline matches).
//   3. Deterministic keyword classifier when LLM is unavailable.
//
// Category set is aligned with the existing pump_coin_intel taxonomy so the two
// systems agree; Oracle adds the free-text `narrative` and `virality`.

import { llmComplete } from '../llm.js';
import { fetchRelevantHeadlines, viralityBonus } from './news-context.js';

export const CATEGORIES = [
	'meme', 'tech', 'ai', 'culture', 'community',
	'political', 'news', 'animal', 'celebrity', 'utility', 'unknown',
];
const CATEGORY_SET = new Set(CATEGORIES);

// Keyword lexicons for the deterministic fallback. Deliberately broad — the
// fallback only needs to be directionally right; the LLM path is the precise one.
const LEXICON = {
	ai: ['ai', 'agent', 'gpt', 'llm', 'neural', 'model', 'machine learning', 'inference', 'agentic', 'autonomous'],
	tech: ['protocol', 'chain', 'zk', 'rollup', 'defi', 'staking', 'oracle', 'infra', 'sdk', 'api', 'l2', 'rwa', 'depin'],
	animal: ['dog', 'cat', 'shiba', 'inu', 'frog', 'pepe', 'doge', 'wif', 'hat', 'bonk', 'monkey', 'ape', 'bird', 'penguin', 'hippo', 'capybara', 'goat'],
	political: ['trump', 'biden', 'maga', 'election', 'president', 'senate', '政', 'kamala', 'vance', '政府', 'government', 'vote'],
	celebrity: ['elon', 'musk', 'kanye', 'taylor', 'drake', 'mrbeast', 'ronaldo', 'messi', 'celebrity', 'star'],
	news: ['breaking', 'just in', 'announced', 'launches', 'report', 'headline', 'today', 'news', 'leaked', 'confirmed'],
	community: ['community', 'dao', 'cto', 'takeover', 'family', 'army', 'holders', 'together', 'movement'],
	culture: ['vibe', 'aesthetic', 'core', 'lore', 'meta', 'based', 'gigachad', 'sigma', 'brainrot', 'skibidi', 'rizz'],
	utility: ['tool', 'utility', 'dashboard', 'tracker', 'bot', 'scanner', 'terminal', 'app', 'platform'],
	meme: ['meme', 'coin', 'moon', 'pump', 'lol', 'kek', '420', '69', 'wojak', 'chad'],
};

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

function corpus({ name, symbol, description } = {}) {
	return [name, symbol, description].filter(Boolean).join(' ').toLowerCase();
}

/**
 * Deterministic keyword classifier. Real fallback — scores each category by
 * keyword hits, picks the best, and derives a baseline virality from signal
 * richness (links present, description length, punchy symbol).
 *
 * @param {object} meta { name, symbol, description, twitter, telegram, website }
 * @returns {{category:string, narrative:string, virality:number, confidence:number, tags:string[], source:'heuristic'}}
 */
export function heuristicNarrative(meta = {}) {
	const text = corpus(meta);
	const tags = [];
	let best = 'unknown';
	let bestHits = 0;

	// Category ordering matters for ties: more specific categories first.
	for (const cat of ['ai', 'tech', 'political', 'celebrity', 'animal', 'news', 'community', 'culture', 'utility', 'meme']) {
		let hits = 0;
		for (const kw of LEXICON[cat]) {
			if (kw && text.includes(kw)) { hits += 1; if (tags.length < 6 && !tags.includes(kw)) tags.push(kw); }
		}
		if (hits > bestHits) { bestHits = hits; best = cat; }
	}

	// Baseline virality from how much signal the launch carries.
	let virality = 30;
	if (meta.twitter) virality += 12;
	if (meta.telegram) virality += 8;
	if (meta.website) virality += 6;
	if (meta.description && meta.description.length > 40) virality += 8;
	if (meta.symbol && meta.symbol.length <= 5) virality += 6; // punchy tickers travel
	virality += Math.min(18, bestHits * 4);
	virality = clamp(virality);

	const narrative = bestHits
		? `Keyword read: ${best} (${tags.slice(0, 3).join(', ')})`
		: 'Unclassified — no strong narrative keywords detected';

	return {
		category: best,
		narrative,
		virality,
		confidence: bestHits ? clamp(30 + bestHits * 12, 0, 80) / 100 : 0.2,
		tags,
		source: 'heuristic',
		news_matched: false,
	};
}

// Tolerant JSON extraction — models occasionally wrap JSON in prose or fences.
function parseJsonish(text) {
	if (!text) return null;
	let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
	const start = t.indexOf('{');
	const end = t.lastIndexOf('}');
	if (start === -1 || end === -1 || end < start) return null;
	try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

const SYSTEM_BASE = `You are Oracle, a pump.fun launch analyst. Classify a new token's CULTURAL NARRATIVE from its metadata.
Return ONLY minified JSON, no prose, with exactly these keys:
{"category": one of ["meme","tech","ai","culture","community","political","news","animal","celebrity","utility","unknown"],
 "narrative": "one crisp sentence naming the actual thesis/story (e.g. 'rides today\\'s <headline> news', 'CTO community revival', 'AI agent infra')",
 "virality": integer 0-100 (how likely this catches sustained attention; reward live news hooks, recognizable culture, clean tickers; punish generic/empty),
 "tags": array of up to 5 short lowercase tags,
 "confidence": number 0-1}
Be decisive. If it's a meme riding a current event, prefer "news". If it's a community/CTO takeover, prefer "community". If empty/spam, category "unknown" with low virality.`;

function buildSystem(headlines) {
	if (!headlines.length) return SYSTEM_BASE;
	const headlineBlock = headlines
		.map((h, i) => `${i + 1}. "${h.title}"${h.published_at ? ` (${h.published_at.slice(0, 10)})` : ''}`)
		.join('\n');
	return `${SYSTEM_BASE}\n\nLIVE CRYPTO HEADLINES RIGHT NOW:\n${headlineBlock}\nIf the token clearly rides one of these headlines, reference it directly in "narrative" and score virality higher (70+).`;
}

/**
 * Classify a coin's narrative. Tries the LLM with live news context (free-first);
 * on any failure returns the deterministic heuristic. Never throws.
 *
 * @param {object} meta { name, symbol, description, twitter, telegram, website, tags }
 * @param {object} [opts] { timeoutMs }
 * @returns {Promise<{category:string, narrative:string, virality:number, confidence:number, tags:string[], source:'llm'|'heuristic', news_matched:boolean}>}
 */
export async function classifyNarrative(meta = {}, opts = {}) {
	// Fetch live headlines in parallel with prompt construction — adds real news
	// signal for coins riding current events; safe no-op on network failure.
	const headlines = await fetchRelevantHeadlines(meta).catch(() => []);

	const user = JSON.stringify({
		name: meta.name || null,
		symbol: meta.symbol || null,
		description: (meta.description || '').slice(0, 600) || null,
		links: {
			twitter: meta.twitter || null,
			telegram: meta.telegram || null,
			website: meta.website || null,
		},
	});

	let res;
	try {
		res = await llmComplete({
			system: buildSystem(headlines),
			user,
			maxTokens: 220,
			timeoutMs: opts.timeoutMs ?? 12_000,
			track: { tool: 'oracle_narrative' },
		});
	} catch {
		return { ...heuristicNarrative(meta), news_matched: false };
	}

	const parsed = parseJsonish(res?.text);
	if (!parsed || typeof parsed !== 'object') return { ...heuristicNarrative(meta), news_matched: false };

	const category = CATEGORY_SET.has(String(parsed.category)) ? String(parsed.category) : 'unknown';
	// Apply a live-news virality bonus on top of the LLM's own estimate.
	const bonus = viralityBonus(headlines);
	const virality = clamp(Math.round(Number(parsed.virality)) + bonus);
	if (!Number.isFinite(virality)) return { ...heuristicNarrative(meta), news_matched: false };

	return {
		category,
		narrative: String(parsed.narrative || '').slice(0, 200) || 'No narrative provided',
		virality,
		confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
		tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 5).map((t) => String(t).toLowerCase().slice(0, 24)) : [],
		source: 'llm',
		news_matched: headlines.length > 0,
	};
}
