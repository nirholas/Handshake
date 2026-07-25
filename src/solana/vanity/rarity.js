/**
 * Verifiable rarity scoring for ground Solana vanity addresses — the honest math
 * behind the proof-of-grind gallery, leaderboard, appraisal tool, and share cards.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * A vanity address is a flex, but the flex is unverifiable hand-waving unless the
 * "rarity" is grounded in the *real* probability model. This module turns a
 * matched pattern into one honest number — `rarityScore` — plus a human tier
 * (Common → Mythic), derived entirely from the geometric difficulty of finding
 * the pattern, with documented, bounded bonuses for properties that genuinely
 * make a pattern harder/more special to obtain on purpose. No arbitrary numbers:
 * every term is explained and every bonus is expressed as an *additional bits of
 * difficulty* contribution so the units stay coherent.
 *
 * ── The base: bits of work ───────────────────────────────────────────────────
 * The grinder is a Bernoulli trial per candidate address. The expected number of
 * attempts to satisfy a prefix/suffix is `expectedAttempts()` from validation.js
 *, the mean of a geometric distribution over the *exact* Base58 positional
 * distribution, not a uniform 1/58 per character. The leading character is up to
 * 17× harder or 3.4× easier than uniform depending on which symbol it is (see
 * [base58-distribution.js](./base58-distribution.js)), so treating it as uniform
 * mis-states the work by more than a whole character's worth of difficulty. We
 * work in *bits*:
 *
 *     baseBits = log2(expectedAttempts(prefix, suffix, ignoreCase))
 *
 * This is the single source of truth — it is exactly the work the verifiable
 * receipt's `difficulty.expectedAttempts` already attests to, so a rarity claim
 * tied to a receipt is only as strong as that attested difficulty. baseBits is
 * what makes a 4-char prefix categorically rarer than a 2-char one.
 *
 * ── The bonuses: extra "specialness", in bits, all bounded ───────────────────
 * On top of raw difficulty, some patterns are *more desirable* than an arbitrary
 * string of equal length — and a grinder targeting them is doing strictly more
 * than a random match. We model that as small additive bonuses, each documented
 * and capped so they can never dwarf the honest base:
 *
 *   • DICTIONARY (real English word, ≥3 letters, from the vendored BIP-39 list):
 *     a recognizable word is a tiny fraction of equal-length strings. Bonus scales
 *     with word length; capped. Using the BIP-39 list (already vendored) keeps the
 *     wordlist real and auditable — no hand-typed sample.
 *   • PALINDROME (the pattern reads the same both ways, ≥3 chars): symmetric
 *     targets are a vanishing fraction of strings. Flat bonus.
 *   • REPEAT RUN (a single character repeated ≥3×, e.g. "aaa", "777"): visually
 *     striking and a small subset of strings. Bonus scales with run length.
 *   • DUAL-SIDED (both a prefix AND a suffix were requested): bookended addresses
 *     are deliberately harder to read off as "vanity" by luck. Small flat bonus.
 *
 * Bonuses are additive in bits, then the whole thing is summed:
 *
 *     rarityBits  = baseBits + bonusBits
 *     rarityScore = round(rarityBits * 100)        // integer, ~bits×100 for sorting
 *
 * The ×100 keeps the leaderboard sortable with integer keys (Redis sorted sets)
 * while preserving sub-bit resolution. Tiers are cut on rarityBits so they track
 * difficulty, not the arbitrary ×100.
 *
 * Everything here is pure + isomorphic (no I/O, no crypto) so it runs identically
 * in the browser (appraisal tool, gallery) and the server (publish/verify, OG
 * cards). Behaviour is pinned by fixed vectors in tests/vanity-rarity.test.js.
 */

import { difficultyModel, effectiveLength, DIFFICULTY_MODEL } from './validation.js';
import { ENGLISH_WORDLIST } from './bip39-english.js';

// Real, auditable wordset. BIP-39 English is 2048 curated lowercase words (3–8
// letters) already vendored for the mnemonic grinder — we reuse it rather than
// hand-typing a sample list. Lowercased lookup; case-insensitive word detection.
const WORDSET = new Set(ENGLISH_WORDLIST);
const MIN_WORD_LEN = 3;

const log2 = (x) => Math.log(x) / Math.LN2;

// ── Bonus parameters (documented, bounded) ──────────────────────────────────
// Each is "extra bits of specialness". Kept small so a clever 3-char pattern can
// never out-rank a brute 5-char prefix on raw difficulty alone.
const DICT_BITS_PER_LETTER = 1.4; // a real word is ~2^len rarer; we credit a slice
const DICT_BITS_CAP = 9; // ≤ ~6-letter word's worth
const PALINDROME_BITS = 3.5;
const REPEAT_BITS_PER_EXTRA = 2.2; // beyond the first 2 chars of the run
const REPEAT_BITS_CAP = 8;
const DUAL_SIDED_BITS = 2;

/**
 * Honest tier ladder, cut on rarity *bits* (≈ log2 of expected attempts incl.
 * bonuses). The cut points are chosen so each tier is ~one order of magnitude of
 * additional work harder than the last, mapping to intuitions about grind cost:
 *
 *   Common     < 6 bits   (≲ 64 attempts — sub-2-char, trivial)
 *   Uncommon   6–11.7     (~3 chars)
 *   Rare       11.7–17.6  (~4 chars)
 *   Epic       17.6–23.4  (~5 chars)
 *   Legendary  23.4–29.3  (~6 chars)
 *   Mythic     ≥ 29.3     (≳ 6 chars or heavily bonused — vanishingly rare)
 *
 * 58^n in bits is n·log2(58) ≈ n·5.858, so the cuts land on whole-character
 * boundaries: 2,3,4,5,6 chars → 11.7, 17.6, 23.4, 29.3 bits.
 */
const CHAR_BITS = log2(58); // ≈ 5.8579

export const RARITY_TIERS = Object.freeze([
	{ id: 'mythic', label: 'Mythic', minBits: 5 * CHAR_BITS, accent: '#ff5db1', glow: 'rgba(255,93,177,0.5)' },
	{ id: 'legendary', label: 'Legendary', minBits: 4 * CHAR_BITS, accent: '#ffb020', glow: 'rgba(255,176,32,0.45)' },
	{ id: 'epic', label: 'Epic', minBits: 3 * CHAR_BITS, accent: '#a855f7', glow: 'rgba(168,85,247,0.45)' },
	{ id: 'rare', label: 'Rare', minBits: 2 * CHAR_BITS, accent: '#38bdf8', glow: 'rgba(56,189,248,0.4)' },
	{ id: 'uncommon', label: 'Uncommon', minBits: 1 * CHAR_BITS, accent: '#4ade80', glow: 'rgba(74,222,128,0.35)' },
	{ id: 'common', label: 'Common', minBits: 0, accent: '#94a3b8', glow: 'rgba(148,163,184,0.25)' },
]);

/**
 * Resolve the tier object for a given rarity-bits value.
 * @param {number} bits
 * @returns {{ id:string, label:string, accent:string, glow:string, minBits:number }}
 */
export function tierForBits(bits) {
	for (const t of RARITY_TIERS) if (bits >= t.minBits) return t;
	return RARITY_TIERS[RARITY_TIERS.length - 1];
}

/** Is `s` a real English (BIP-39) word, case-insensitively, ≥ MIN_WORD_LEN? */
function isDictionaryWord(s) {
	if (!s || s.length < MIN_WORD_LEN) return false;
	return WORDSET.has(s.toLowerCase());
}

/** Longest run of a single repeated character in `s` (1 for no repeat). */
function longestRepeatRun(s) {
	let best = s.length ? 1 : 0;
	let run = 1;
	for (let i = 1; i < s.length; i++) {
		run = s[i] === s[i - 1] ? run + 1 : 1;
		if (run > best) best = run;
	}
	return best;
}

/** Is `s` a palindrome (case-insensitive), length ≥ 3? */
function isPalindrome(s) {
	if (!s || s.length < 3) return false;
	const t = s.toLowerCase();
	for (let i = 0, j = t.length - 1; i < j; i++, j--) if (t[i] !== t[j]) return false;
	return true;
}

/**
 * Compute the full, documented rarity breakdown for a matched pattern.
 *
 * @param {object} pattern
 * @param {string} [pattern.prefix]
 * @param {string} [pattern.suffix]
 * @param {boolean} [pattern.ignoreCase=false]
 * @param {string} [pattern.model] difficulty model id; defaults to the current
 *   one. Pass a certificate's `difficulty.model` to reproduce a rarity claim
 *   exactly as it was issued.
 * @returns {{
 *   prefix:string, suffix:string, ignoreCase:boolean,
 *   expectedAttempts:number, baseBits:number, bonusBits:number, rarityBits:number,
 *   rarityScore:number, tier:string, tierLabel:string, accent:string,
 *   effectiveLength:number, model:string,
 *   bonuses: Array<{ id:string, label:string, bits:number, detail:string }>
 * }}
 */
export function computeRarity({ prefix = '', suffix = '', ignoreCase = false, model } = {}) {
	const pre = prefix || '';
	const suf = suffix || '';
	const attempts = difficultyModel(model)(pre, suf, ignoreCase);
	const baseBits = attempts > 1 ? log2(attempts) : 0;

	const bonuses = [];

	// DICTIONARY — credit each side that is a real word, independently.
	let dictBits = 0;
	for (const [side, str] of [['prefix', pre], ['suffix', suf]]) {
		if (isDictionaryWord(str)) {
			const b = Math.min(DICT_BITS_CAP, (str.length - (MIN_WORD_LEN - 1)) * DICT_BITS_PER_LETTER + DICT_BITS_PER_LETTER);
			dictBits += b;
			bonuses.push({ id: `dictionary-${side}`, label: `Real word "${str}"`, bits: round2(b), detail: `${side} "${str}" is an English word` });
		}
	}

	// PALINDROME — check prefix, suffix, and the full pattern string.
	const full = pre + suf;
	if (isPalindrome(full) && full.length >= 3) {
		bonuses.push({ id: 'palindrome', label: 'Palindrome', bits: PALINDROME_BITS, detail: `"${full}" reads the same both ways` });
	} else {
		for (const [side, str] of [['prefix', pre], ['suffix', suf]]) {
			if (isPalindrome(str)) {
				bonuses.push({ id: `palindrome-${side}`, label: 'Palindrome', bits: PALINDROME_BITS, detail: `${side} "${str}" reads the same both ways` });
			}
		}
	}

	// REPEAT RUN — credit the longest run across the combined pattern.
	const run = longestRepeatRun(full);
	if (run >= 3) {
		const b = Math.min(REPEAT_BITS_CAP, (run - 2) * REPEAT_BITS_PER_EXTRA);
		bonuses.push({ id: 'repeat', label: `${run}× repeat`, bits: round2(b), detail: `a character repeats ${run} times in a row` });
	}

	// DUAL-SIDED — both ends fixed.
	if (pre && suf) {
		bonuses.push({ id: 'dual-sided', label: 'Bookended', bits: DUAL_SIDED_BITS, detail: 'both a prefix and a suffix were ground' });
	}

	const bonusBits = bonuses.reduce((sum, b) => sum + b.bits, 0);
	// Tier on the full-precision bits so a value sitting exactly on a 58^n boundary
	// (e.g. a 3-char prefix = 3·log2(58)) lands in the tier its character count
	// implies, rather than slipping down a tier on a 2-decimal display rounding.
	const exactBits = baseBits + bonusBits;
	const rarityBits = round2(exactBits);
	const tier = tierForBits(exactBits);

	return {
		prefix: pre || null,
		suffix: suf || null,
		ignoreCase: !!ignoreCase,
		expectedAttempts: Math.round(attempts),
		baseBits: round2(baseBits),
		bonusBits: round2(bonusBits),
		rarityBits,
		rarityScore: Math.round(rarityBits * 100),
		tier: tier.id,
		tierLabel: tier.label,
		accent: tier.accent,
		effectiveLength: round2(effectiveLength(attempts)),
		model: model || DIFFICULTY_MODEL,
		bonuses,
	};
}

/**
 * Appraise an arbitrary Base58 address against a target pattern the way a buyer
 * would request it — for the "paste any address" appraisal tool. Given an address
 * and how many leading/trailing characters to treat as the "vanity" (auto-detected
 * by default), returns the rarity of that pattern plus a grind-cost estimate.
 *
 * @param {string} address - Base58 Solana address.
 * @param {object} [opts]
 * @param {number} [opts.prefixLen] - chars from the start to treat as prefix.
 * @param {number} [opts.suffixLen] - chars from the end to treat as suffix.
 * @param {boolean} [opts.ignoreCase=false]
 * @param {number} [opts.ratePerSecond=20000000] - assumed grind rate for cost est.
 * @returns {object} rarity breakdown + { grindSeconds, grindHuman }
 */
export function appraiseAddress(address, opts = {}) {
	const addr = String(address || '').trim();
	const { ignoreCase = false, ratePerSecond = 20_000_000 } = opts;
	// Auto-detect the most generous interpretation when no explicit split given:
	// the longest leading dictionary word / repeat / and a sensible default of the
	// first 4 chars as prefix (a recognizable "vanity" the owner likely targeted).
	let prefixLen = Number.isInteger(opts.prefixLen) ? opts.prefixLen : autoPrefixLen(addr);
	let suffixLen = Number.isInteger(opts.suffixLen) ? opts.suffixLen : 0;
	prefixLen = Math.max(0, Math.min(prefixLen, addr.length));
	suffixLen = Math.max(0, Math.min(suffixLen, addr.length - prefixLen));

	const prefix = addr.slice(0, prefixLen);
	const suffix = suffixLen ? addr.slice(addr.length - suffixLen) : '';
	const rarity = computeRarity({ prefix, suffix, ignoreCase });
	const grindSeconds = rarity.expectedAttempts / Math.max(1, ratePerSecond);
	return { address: addr, ...rarity, grindSeconds, grindHuman: humanizeSeconds(grindSeconds), ratePerSecond };
}

// Pick a leading prefix length that captures the "intent" of a vanity: the
// longest of {leading dictionary word, leading repeat run, 4}, capped to a
// realistic grindable length so the appraisal isn't dominated by random tails.
function autoPrefixLen(addr) {
	let best = Math.min(4, addr.length);
	// Leading repeat run.
	let run = 1;
	for (let i = 1; i < addr.length && addr[i] === addr[0]; i++) run++;
	if (run >= 3) best = Math.max(best, Math.min(run, 8));
	// Leading dictionary word (longest prefix that is a real word).
	for (let n = Math.min(8, addr.length); n >= MIN_WORD_LEN; n--) {
		if (isDictionaryWord(addr.slice(0, n))) {
			best = Math.max(best, n);
			break;
		}
	}
	return best;
}

function humanizeSeconds(seconds) {
	if (!Number.isFinite(seconds) || seconds <= 0) return 'instant';
	if (seconds < 1) return 'under a second';
	if (seconds < 60) return `~${Math.round(seconds)} seconds`;
	if (seconds < 3600) return `~${Math.round(seconds / 60)} minutes`;
	if (seconds < 86400) return `~${Math.round(seconds / 3600)} hours`;
	if (seconds < 31_536_000) return `~${Math.round(seconds / 86400)} days`;
	const years = seconds / 31_536_000;
	if (years < 1e6) return `~${Math.round(years).toLocaleString('en-US')} years`;
	return `~${years.toExponential(1)} years`;
}

function round2(n) {
	return Math.round(n * 100) / 100;
}

export { CHAR_BITS };
