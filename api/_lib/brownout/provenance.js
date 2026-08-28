// @ts-check
// Where this response's data actually came from.
//
// The platform has fallbacks everywhere: provider ladders, retry policies,
// last-good tiers, degraded shapes. They work. The problem is that nobody can
// SEE them work. A 200 from /api/pump/dashboard looks identical whether its
// price came from Birdeye a moment ago or from a cached reading twenty minutes
// old after three providers refused, and the caller has no way to tell. That
// gap is where the expensive bugs live: this repo has already shipped a paid
// datapoint stamped `as_of: now` over an hour-old payload, and a token security
// verdict assembled out of remembered on-chain state. Both were invisible
// precisely because a degraded answer and a live one are the same bytes.
//
// So: every fetch through the shared wrappers records what it did, against the
// request that caused it, and the response carries a summary of that record.
//
//   x-brownout:       v=1;tier=stale;sources=3;ok=1;failed=2;ms=512
//   x-brownout-trace: birdeye;o=429;t=412, tokens-xyz;o=timeout;t=8000, dexscreener;o=ok;t=88
//
// The trace is emitted only when something actually degraded, so a healthy
// response pays one short header and no per-source cost.
//
// Freshness is a LATTICE, not a flag. `live` beat `cache` beat `stale` beat
// `fallback`, and a response's tier is the WORST tier that contributed to it,
// because a page assembled from one live read and one half-hour-old reading is
// not live. Reporting the best tier would be worse than reporting nothing: it
// would be a confident lie, and the whole point of this module is that a
// degraded answer must never be able to pass for a fresh one.
//
// Cost when nothing is listening: one AsyncLocalStorage lookup that returns
// undefined and an early return. No allocation, no header, no behaviour change.

import { AsyncLocalStorage } from 'node:async_hooks';

/** @typedef {'live'|'cache'|'stale'|'fallback'} Tier */
/** @typedef {'ok'|'fail'|'skip'} Outcome */

/**
 * Freshness lattice, best first. A response is only as fresh as its least
 * fresh contributing source.
 *  - live      answered by the upstream during this request
 *  - cache     served from a cache entry inside its intended TTL
 *  - stale     served past its TTL because the upstream could not answer
 *  - fallback  produced by a different method than the one asked for
 *              (a sibling provider, a lexical ranking, a constant table)
 * @type {Tier[]}
 */
export const TIERS = ['live', 'cache', 'stale', 'fallback'];
const TIER_RANK = new Map(TIERS.map((t, i) => [t, i]));

/** The worse (less fresh) of two tiers. Unknown tiers are ignored, never trusted. */
export function worstTier(a, b) {
	const ra = TIER_RANK.get(a);
	const rb = TIER_RANK.get(b);
	if (ra == null) return rb == null ? 'live' : b;
	if (rb == null) return a;
	return ra >= rb ? a : b;
}

/** @typedef {{ name: string, outcome: Outcome, ms: number, tier: Tier, detail?: string }} SourceRecord */
/** @typedef {{ sources: SourceRecord[], startedAt: number }} Ledger */

/** @type {AsyncLocalStorage<Ledger>} */
const storage = new AsyncLocalStorage();

/**
 * Run `fn` inside a fresh provenance ledger. Everything the shared fetch
 * wrappers do inside it is recorded against this request and nothing else,
 * which is what makes the record safe under concurrency: two requests running
 * in the same instance never see each other's sources.
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function withProvenance(fn) {
	return storage.run({ sources: [], startedAt: Date.now() }, fn);
}

/** The current request's ledger, or null outside a provenance context. */
export function currentLedger() {
	return storage.getStore() ?? null;
}

// A single request can fan out over hundreds of sources (a batch price read per
// mint). Recording every one would turn a header into a payload, so the ledger
// keeps the first N and counts the rest: the shape of the degradation is in the
// first few, and the count preserves the scale.
const MAX_RECORDED = 24;

/**
 * Record one upstream interaction against the current request.
 *
 * Safe to call from anywhere, including outside a request (it becomes a no-op),
 * so a helper never has to know whether its caller set a context up.
 *
 * @param {{ name: string, outcome: Outcome, ms?: number, tier?: Tier, detail?: string|number }} rec
 */
export function recordSource(rec) {
	const ledger = storage.getStore();
	if (!ledger || !rec?.name) return;
	if (ledger.sources.length >= MAX_RECORDED) {
		ledger.truncated = (ledger.truncated || 0) + 1;
		return;
	}
	ledger.sources.push({
		name: String(rec.name).slice(0, 48),
		outcome: rec.outcome === 'ok' || rec.outcome === 'skip' ? rec.outcome : 'fail',
		ms: Number.isFinite(rec.ms) ? Math.max(0, Math.round(Number(rec.ms))) : 0,
		tier: TIER_RANK.has(rec.tier) ? rec.tier : 'live',
		...(rec.detail != null ? { detail: String(rec.detail).slice(0, 32) } : {}),
	});
}

/**
 * Aggregate the ledger. `tier` is the worst tier of any source that actually
 * CONTRIBUTED (outcome ok); a failed attempt tells you the chain was exercised
 * but says nothing about the freshness of the answer that finally came back.
 *
 * @returns {{ tier: Tier, sources: number, ok: number, failed: number, ms: number, degraded: boolean, truncated: number, records: SourceRecord[] } | null}
 */
export function provenanceSummary() {
	const ledger = storage.getStore();
	if (!ledger || (!ledger.sources.length && !ledger.truncated)) return null;
	let tier = 'live';
	let ok = 0;
	let failed = 0;
	for (const s of ledger.sources) {
		if (s.outcome === 'ok') {
			ok++;
			tier = worstTier(tier, s.tier);
		} else if (s.outcome === 'fail') {
			failed++;
		}
	}
	return {
		tier,
		sources: ledger.sources.length + (ledger.truncated || 0),
		ok,
		failed,
		ms: Date.now() - ledger.startedAt,
		// Degraded means "a reader should not treat this as a clean live answer":
		// either something had to be retried or failed over, or what came back is
		// not fresh. Both are worth surfacing; neither is an error.
		degraded: failed > 0 || tier !== 'live',
		truncated: ledger.truncated || 0,
		records: ledger.sources,
	};
}

// Header values must be a single line of visible ASCII. A provider name is
// ours, not user input, but it still passes through here so a stray newline or
// separator can never split a header.
const headerSafe = (s) => String(s).replace(/[^\x21-\x7E]|[,;]/g, '_');

/**
 * The two header values for the current request, or null when nothing was
 * recorded. `trace` is present only when something degraded: a healthy response
 * should not pay for a per-source breakdown nobody will read.
 *
 * @returns {{ summary: string, trace: string|null } | null}
 */
export function provenanceHeaders() {
	const s = provenanceSummary();
	if (!s) return null;
	const summary =
		`v=1;tier=${s.tier};sources=${s.sources};ok=${s.ok};failed=${s.failed};ms=${s.ms}` +
		(s.degraded ? ';degraded=1' : '');
	if (!s.degraded) return { summary, trace: null };
	const trace = s.records
		.map((r) => `${headerSafe(r.name)};o=${headerSafe(r.detail ?? r.outcome)};t=${r.ms}`)
		.join(', ');
	return { summary, trace: trace || null };
}
