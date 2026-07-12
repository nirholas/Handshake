// @ts-check
// Source providers for the autonomous coin launcher — the "what to launch" half.
//
// Three flavours, all returning the SAME shape so the engine treats them
// uniformly: { kind, name, symbol, description, trigger_source, trigger_detail }.
//
//   random — wordlist salad. No network, no LLM. The cheap filler that keeps the
//            hybrid cadence ticking when no real trend is live.
//   meme   — LLM synthesises an ORIGINAL meme coin from open meme culture.
//   trend  — reads the cultural signal already in our own pump_coin_intel
//            (categories / tags / narratives of what is breaking out right now)
//            plus recent X chatter, and asks the LLM to coin an ORIGINAL token
//            riding that wave.
//
// Hard rule baked in: the LLM is instructed to invent original names/tickers and
// NEVER copy an existing token's identity. We mine themes (culture), not tickers
// (specific coins) — so this is trend-following, not cloning. The agent's avatar
// (attached later by the engine) is always the coin's visual identity.

import { sql } from './db.js';
import { llmComplete, llmConfigured } from './llm.js';
import { rankNarratives } from './launcher-trends.js';

// ── sanitisers ──────────────────────────────────────────────────────────────
// pump.fun caps: name ≤ 32, symbol ≤ 10. Symbols are uppercased alphanumerics.

/** @param {string} s */
export function sanitizeName(s) {
	return String(s || '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 32);
}

/** @param {string} s */
export function sanitizeSymbol(s) {
	const cleaned = String(s || '')
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, '')
		.slice(0, 10);
	return cleaned || 'THREE3';
}

// ── random (no LLM) ───────────────────────────────────────────────────────────
const ADJECTIVES = [
	'Turbo', 'Cosmic', 'Feral', 'Velvet', 'Quantum', 'Rogue', 'Lucid', 'Hyper',
	'Molten', 'Neon', 'Phantom', 'Atomic', 'Wild', 'Solar', 'Frostbit', 'Electric',
	'Savage', 'Mythic', 'Stellar', 'Chrome', 'Gilded', 'Vapor', 'Radiant', 'Drift',
];
const NOUNS = [
	'Otter', 'Comet', 'Goblin', 'Yeti', 'Falcon', 'Mantis', 'Kraken', 'Pixel',
	'Nomad', 'Bishop', 'Tiger', 'Sprout', 'Anvil', 'Specter', 'Lotus', 'Bandit',
	'Phoenix', 'Walrus', 'Cobra', 'Maple', 'Raven', 'Bison', 'Koi', 'Hawk',
];

function pick(arr) {
	return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * A complete, original coin from wordlists. Always succeeds — this is the
 * guaranteed fallback every other provider degrades to.
 * @returns {{kind:'random', name:string, symbol:string, description:string, trigger_source:string, trigger_detail:object}}
 */
export function randomCoin() {
	const adj = pick(ADJECTIVES);
	const noun = pick(NOUNS);
	const name = sanitizeName(`${adj} ${noun}`);
	const symbol = sanitizeSymbol((adj.slice(0, 4) + noun.slice(0, 4)).toUpperCase());
	return {
		kind: 'random',
		name,
		symbol,
		description: `${name} — an autonomous three.ws launch. Fully on-chain, avatar-fronted, $THREE-aligned.`,
		trigger_source: 'random',
		trigger_detail: { adj, noun },
	};
}

// ── cultural signal ───────────────────────────────────────────────────────────

/**
 * Rank the live cultural currents worth riding, fused across every configured
 * signal (live pump.fun meta, oracle conviction, X chatter, and — when enabled —
 * Hacker News / Reddit / Wikipedia culture). Returns the ranked terms (with
 * momentum + which sources confirmed each) so the coiner can ride the single
 * strongest wave, not a flat bag of words. Always mines THEMES, never tickers.
 * @param {{network?:string, categories?:string[], sources?:string[]}} opts
 * @returns {Promise<Array<{term:string, score:number, sources:string[], kind:string}>>}
 */
export async function gatherNarratives({ network = 'mainnet', categories = [], sources } = {}) {
	const { terms } = await rankNarratives({ network, categories, sources });
	return terms;
}

/**
 * Backward-compatible theme list (deduped strings, hottest first) over the fused
 * narrative ranker. Never specific tickers.
 * @param {{network?:string, categories?:string[], sources?:string[], limit?:number}} opts
 * @returns {Promise<string[]>}
 */
export async function gatherThemes({ network = 'mainnet', categories = [], sources, limit = 24 } = {}) {
	const terms = await gatherNarratives({ network, categories, sources });
	return terms.map((t) => t.term).slice(0, limit);
}

// ── LLM synthesis ─────────────────────────────────────────────────────────────

const SYNTH_SYSTEM =
	'You are the lead memecoin strategist for three.ws, a Solana launch platform ' +
	'competing to be the top deployer on pump.fun. Your job: read the live cultural ' +
	'currents you are given and coin ONE original token that rides the strongest one ' +
	'while it is still rising — the kind degens screenshot and share. ' +
	'Absolute rules: ' +
	'(1) Never copy, reference, or imitate the name or ticker of any existing real ' +
	'cryptocurrency or token — riff on the CULTURE, invent a fresh identity. ' +
	'(2) name ≤ 32 chars; symbol 3-8 uppercase letters/digits, no spaces, instantly ' +
	'readable and tickerable, and an OBVIOUS contraction of the name (a trader who ' +
	'sees only the ticker should guess the name). (3) Playful, internet-native, culturally sharp — never ' +
	'offensive, hateful, or referencing real tragedies/victims. ' +
	'(4) The description is one punchy line that makes the meme legible at a glance. ' +
	'Respond with STRICT JSON only: {"name":"","symbol":"","description":""}.';

function parseCoinJson(text) {
	if (!text) return null;
	const m = text.match(/\{[\s\S]*\}/);
	if (!m) return null;
	try {
		const o = JSON.parse(m[0]);
		if (!o || typeof o !== 'object' || !o.name || !o.symbol) return null;
		// Descriptions get their own hygiene — sanitizeName caps at the 32-char
		// pump.fun NAME limit and was truncating every description mid-word.
		const description = String(o.description || '').replace(/\s+/g, ' ').trim().slice(0, 180);
		return {
			name: sanitizeName(o.name),
			symbol: sanitizeSymbol(o.symbol),
			description: description || `${sanitizeName(o.name)} on three.ws`,
		};
	} catch {
		return null;
	}
}

// Normalise a name/symbol for repeat detection: case- and punctuation-blind.
function noveltyKey(s) {
	return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * True when the coin repeats an identity in the avoid list (same symbol or same
 * normalised name). This is what stopped the meme lane re-minting "KEKWZ" 189
 * times in a week: without memory of its own picks the model converges on the
 * same joke every tick.
 * @param {{name:string, symbol:string}} coin
 * @param {Array<{name?:string, symbol?:string}>} avoid
 */
export function isRepeatPick(coin, avoid = []) {
	if (!avoid.length) return false;
	const sym = noveltyKey(coin.symbol);
	const name = noveltyKey(coin.name);
	return avoid.some((a) => (a.symbol && noveltyKey(a.symbol) === sym) || (a.name && noveltyKey(a.name) === name));
}

/**
 * Ask the LLM to coin an original token, riding the ranked live narratives when
 * supplied. `avoid` (recent picks) is fed into the prompt and enforced after
 * parsing — a repeat gets ONE retry with the collision named, then degrades.
 * Degrades to randomCoin() on any LLM failure — never throws, never blocks a
 * tick. Callers that must not ship filler check `.degraded` on the result.
 * @param {{narratives?:Array<{term:string,score:number,sources:string[],kind:string}>, themes?:string[], flavor?:'trend'|'meme', triggerSource?:string, avoid?:Array<{name?:string, symbol?:string}>}} opts
 */
export async function synthesizeCoin({ narratives = [], themes = [], flavor = 'meme', triggerSource, avoid = [] } = {}) {
	if (!llmConfigured()) return { ...randomCoin(), degraded: 'llm_unconfigured' };

	// Prefer the ranked narratives (momentum + confirming sources) so the model
	// understands WHICH wave is strongest, not just a flat list.
	const ranked = narratives.length
		? narratives
		: themes.map((t) => ({ term: t, score: 1, sources: [], kind: 'culture' }));
	const top = ranked[0] || null;

	let userPrompt;
	if (ranked.length) {
		const lines = ranked
			.slice(0, 12)
			.map((n, i) => `${i + 1}. ${n.term}${n.kind ? ` [${n.kind}]` : ''}${n.sources?.length ? ` (confirmed by ${n.sources.length} source${n.sources.length === 1 ? '' : 's'})` : ''}`)
			.join('\n');
		userPrompt =
			`Live cultural currents on the internet right now, strongest first:\n${lines}\n\n` +
			`Coin ONE original memecoin riding ${top ? `"${top.term}"` : 'the strongest current'} ` +
			`(or fuse it with another current below it if that makes a sharper meme). ` +
			`Riff on the culture — never name it after an existing token. Make the ticker instantly memeable.`;
	} else {
		userPrompt = 'Coin ONE original, funny, internet-native memecoin from current meme culture. Make the ticker instantly memeable.';
	}
	const avoidTickers = [...new Set(avoid.map((a) => sanitizeSymbol(a.symbol || '')).filter((s) => s && s !== 'THREE3'))].slice(0, 40);
	if (avoidTickers.length) {
		userPrompt += `\n\nAlready launched recently — your pick must not reuse or resemble any of these tickers: ${avoidTickers.join(', ')}.`;
	}

	const attempt = async (prompt) => {
		const out = await llmComplete({ system: SYNTH_SYSTEM, user: prompt, maxTokens: 220, timeoutMs: 12_000 });
		return parseCoinJson(out?.text);
	};

	let coin;
	try {
		coin = await attempt(userPrompt);
		if (coin && isRepeatPick(coin, avoid)) {
			coin = await attempt(
				`${userPrompt}\n\nYou already minted "${coin.name}" (${coin.symbol}). Pick a DIFFERENT current or a genuinely different angle — a fresh name and ticker.`,
			);
		}
	} catch {
		return { ...randomCoin(), degraded: 'llm_error' };
	}

	if (!coin) return { ...randomCoin(), degraded: 'llm_unparseable' };
	if (isRepeatPick(coin, avoid)) return { ...randomCoin(), degraded: 'repeat_pick' };

	return {
		kind: flavor === 'trend' ? 'trend' : 'meme',
		name: coin.name,
		symbol: coin.symbol,
		description: coin.description,
		trigger_source: triggerSource || (flavor === 'trend' ? 'narratives' : 'meme-llm'),
		trigger_detail: {
			top_narrative: top?.term || null,
			top_kind: top?.kind || null,
			top_sources: top?.sources || [],
			themes: ranked.slice(0, 12).map((n) => n.term),
		},
	};
}

// Weighted-sample one of the strongest currents to LEAD the prompt. The model
// anchors hard on whichever narrative is named first, so always sending the #1
// term made every launch of the day ride the same theme; rotating the lead
// across the top of the ranking gives a slate variety while staying on-signal.
function rotateLead(narratives) {
	if (narratives.length <= 1) return narratives;
	const top = narratives.slice(0, 6);
	const total = top.reduce((sum, n) => sum + Math.max(0.1, n.score), 0);
	let roll = Math.random() * total;
	let lead = top[top.length - 1];
	for (const n of top) {
		roll -= Math.max(0.1, n.score);
		if (roll <= 0) { lead = n; break; }
	}
	return [lead, ...narratives.filter((n) => n !== lead)];
}

// ── dispatcher ────────────────────────────────────────────────────────────────

/**
 * Choose a coin for a tick given the configured mode. Hybrid prefers a live
 * trend, falls back to a meme, and injects random filler when no signal exists.
 * `sources` selects which narrative providers feed trend/hybrid mode (see
 * launcher-trends.js); empty ⇒ the default internal set. `avoid` is the recent
 * pick history the LLM must not repeat (see synthesizeCoin).
 * @param {{mode:string, network?:string, categories?:string[], sources?:string[], avoid?:Array<{name?:string, symbol?:string}>}} cfg
 */
export async function pickSource({ mode, network = 'mainnet', categories = [], sources, avoid = [] } = {}) {
	if (mode === 'random') return randomCoin();
	if (mode === 'meme') return synthesizeCoin({ flavor: 'meme', avoid });

	if (mode === 'trend') {
		const narratives = await gatherNarratives({ network, categories, sources });
		if (narratives.length >= 2) return synthesizeCoin({ narratives: rotateLead(narratives), flavor: 'trend', avoid });
		// No live trend → still honour 'trend' intent with a meme rather than stall.
		return synthesizeCoin({ flavor: 'meme', triggerSource: 'trend-fallback', avoid });
	}

	// hybrid (default): trend first, meme second, occasional random filler.
	const narratives = await gatherNarratives({ network, categories, sources });
	if (narratives.length >= 2) return synthesizeCoin({ narratives: rotateLead(narratives), flavor: 'trend', avoid });
	if (Math.random() < 0.5) return synthesizeCoin({ flavor: 'meme', triggerSource: 'hybrid', avoid });
	return randomCoin();
}
