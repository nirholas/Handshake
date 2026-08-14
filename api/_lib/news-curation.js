// Editorial display filter for the crypto-news reader.
// ---------------------------------------------------------------------------
// three.ws ingests ~190 feeds. Many are crypto-native (every article is on
// topic); a smaller set are broad outlets — WSJ, CNBC, the SEC, the Fed, world
// news desks — that run crypto stories AND a lot that isn't. We WANT to keep
// pulling the broad ones: their crypto coverage is high-value, and the macro /
// regulatory context feeds the archive and the agents' knowledge corpus. What
// we do NOT want is a world-politics headline or a general-markets note landing
// in a crypto feed.
//
// So this is a DISPLAY filter, not an ingestion filter. It runs on what a human
// sees (the /markets/news feed, the RSS mirror, the daily digest, related
// coverage), never on what we archive or what the agents read. Two gates:
//
//   1. Relevance — a broad source's article shows only if the article itself is
//      about crypto (a detected ticker, or a term from the crypto lexicon).
//      Crypto-native sources always pass.
//   2. Quality  — a credibility floor. Scored sources must clear it; unscored
//      crypto-native outlets are presumed acceptable (they were hand-added to
//      the registry), and archived rows with no registry entry are never nuked.
//
// The floor is overridable at runtime via NEWS_MIN_CREDIBILITY so the bar can
// be tuned without a code change.

import { NEWS_SOURCES } from './news-sources.js';
import { env } from './env.js';

// Categories whose every source is crypto-first. An article from one of these
// is on topic by definition; only the quality gate applies. `institutional` and
// `etf` are included: they are exchanges, custodians, and crypto-ETF issuers
// (Kraken, Fireblocks, ARK, CoinShares), i.e. crypto-native even though the
// name isn't a coin.
const CRYPTO_NATIVE_CATEGORIES = new Set([
	'general',
	'bitcoin',
	'ethereum',
	'layer2',
	'solana',
	'altl1',
	'defi',
	'nft',
	'gaming',
	'trading',
	'derivatives',
	'research',
	'onchain',
	'quant',
	'stablecoin',
	'depin',
	'mining',
	'security',
	'institutional',
	'etf',
]);

// Everything else — mainstream, geopolitical, macro, journalism, asia, fintech,
// developer — is a mixed source: its article must prove it is about crypto.

// Crypto topical lexicon for the per-article relevance gate. Kept lowercase and
// matched as WHOLE WORDS against `${title} ${description}` (see CRYPTO_TERM_RE
// below). Deliberately broad on the crypto side (better to admit a borderline
// crypto story than drop a real one), while excluding the generic finance words
// that a non-crypto markets story would trip ("stocks", "inflation", "GDP" are
// NOT here).
const CRYPTO_TERMS = [
	'crypto',
	'bitcoin',
	'btc',
	'ethereum',
	'ether',
	'blockchain',
	'stablecoin',
	// The major stablecoins by name and symbol. "Tether" used to squeak through
	// only because the old substring test found "ether" inside it; a mainstream
	// outlet's Tether story is squarely on topic and now says so explicitly.
	'tether',
	'usdt',
	'usdc',
	'defi',
	'web3',
	'altcoin',
	'memecoin',
	'token',
	'nft',
	'solana',
	'ripple',
	'xrp',
	'dogecoin',
	'coinbase',
	'binance',
	'onchain',
	'on-chain',
	'digital asset',
	'digital-asset',
	'tokeniz', // tokenize / tokenization / tokenized
	'spot etf',
	'crypto etf',
	'bitcoin etf',
	'ether etf',
	'ethereum etf',
	'satoshi',
	'halving',
	'staking',
	'metamask',
	'ledger',
	'dao',
	'wallet',
];

// Terms that are deliberately a PREFIX, not a word, because they head a family
// of endings the whole-word matcher would otherwise reject: cryptocurrency /
// cryptoassets, tokenize / tokenization / tokenized.
const CRYPTO_PREFIX_TERMS = new Set(['crypto', 'tokeniz']);

// Whole-word matcher for the lexicon.
//
// This was a plain `includes()` substring test, and short terms quietly matched
// inside ordinary English: "defi" fired on "defied", which put three Indian
// equities headlines ("FIIs dumped … but 8 defied the selloff") at the top of
// the crypto news feed and the daily digest. "deficit", "definition", and
// "defiance" were the same story waiting to happen, and "ether" matched inside
// "tether". A leading \b plus a trailing "not another letter" guard keeps every
// real hit (matching is case-insensitive, so DeFi/BTC/DAO all land, and the
// guard still admits the hyphenated compounds crypto writing is full of:
// blockchain-based, wallet-to-wallet) while refusing the mid-word ones. An
// optional plural "s" keeps DAOs, NFTs, and wallets matching.
const CRYPTO_TERM_RE = new RegExp(
	CRYPTO_TERMS.map((term) => {
		const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		return CRYPTO_PREFIX_TERMS.has(term) ? `\\b${escaped}` : `\\b${escaped}s?(?![a-z])`;
	}).join('|'),
	'i',
);

/** Runtime-tunable credibility floor (0–1). */
export const DEFAULT_MIN_CREDIBILITY = (() => {
	const raw = Number(env.NEWS_MIN_CREDIBILITY);
	return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.6;
})();

function sourceOf(a) {
	return NEWS_SOURCES[a?.source_key] || null;
}

/**
 * Is this article about crypto enough to show in a crypto feed?
 *
 * Crypto-native source → yes. Otherwise it needs a detected ticker or a crypto
 * lexicon hit in its title/description.
 */
export function isCryptoRelevant(a) {
	if (!a) return false;
	const src = sourceOf(a);
	if (src && CRYPTO_NATIVE_CATEGORIES.has(src.category)) return true;

	// A source we don't know (archived row, or a key not in the registry) can't
	// be judged by category — fall through to the content test rather than
	// assuming either way.
	if (Array.isArray(a.tickers) && a.tickers.length) return true;

	return CRYPTO_TERM_RE.test(`${String(a.title || '')} ${String(a.description || '')}`);
}

/**
 * Does the source clear the quality floor?
 *
 * Scored source → credibility ≥ floor. Unscored source in the registry →
 * presumed acceptable (it was curated in by hand). Source not in the registry
 * at all (legacy archive rows) → never dropped on quality grounds; the
 * relevance gate still applies to it.
 */
export function passesQualityFloor(a, min = DEFAULT_MIN_CREDIBILITY) {
	const src = sourceOf(a);
	if (!src) return true;
	if (typeof src.credibility === 'number') return src.credibility >= min;
	return true;
}

/**
 * The combined display gate. `true` → show it to a human.
 *
 * @param {object} a article
 * @param {{minCredibility?: number}} [opts]
 */
export function isDisplayable(a, opts = {}) {
	const min = typeof opts.minCredibility === 'number' ? opts.minCredibility : DEFAULT_MIN_CREDIBILITY;
	return isCryptoRelevant(a) && passesQualityFloor(a, min);
}
