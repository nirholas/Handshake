// RugCheck: keyless Solana token risk reports (api.rugcheck.xyz).
//
// The Oracle market aggregator (api/_lib/oracle/market.js) uses this as the
// second security opinion next to GoPlus. GoPlus states the on-chain facts
// (mint/freeze authority, transfer fee, holder concentration); RugCheck runs
// its own risk engine over the same mint and answers with an overall 0-100
// score, named risk findings, and the LP-lock coverage GoPlus does not have.
// Either source failing degrades its slice to null, never the whole read.
//
// Endpoint (verified live 2026-08-05, no key, no auth):
//   GET https://api.rugcheck.xyz/v1/tokens/{mint}/report/summary
//   -> { tokenProgram, tokenType, risks: [{ name, value, description, score,
//        level }], score, score_normalised, lpLockedPct }
// `score_normalised` is 0-100 with HIGHER meaning MORE risk; each finding's
// `level` is RugCheck's own grading ("warn" / "danger"). Unknown or invalid
// mints answer 400 with an error body.

const RUGCHECK_API = 'https://api.rugcheck.xyz/v1';
const FETCH_TIMEOUT_MS = 6000;

const num = (v) => {
	const n = typeof v === 'string' ? parseFloat(v) : Number(v);
	return Number.isFinite(n) ? n : null;
};

/**
 * Map RugCheck's normalized 0-100 score onto the platform's shared risk
 * ladder. Same cut points as buildTokenRisk (api/_lib/token-market.js), so
 * "high" means the same thing wherever a holder reads it.
 *
 * @param {number|null} scoreNormalised 0-100, higher = riskier
 * @returns {'low'|'medium'|'high'|'critical'|null}
 */
export function rugcheckLevel(scoreNormalised) {
	if (scoreNormalised == null || !Number.isFinite(scoreNormalised)) return null;
	if (scoreNormalised >= 70) return 'critical';
	if (scoreNormalised >= 45) return 'high';
	if (scoreNormalised >= 22) return 'medium';
	return 'low';
}

/**
 * Fetch and normalize RugCheck's summary risk report for one Solana mint.
 *
 * Returns null when RugCheck does not know the mint or answers with a
 * non-2xx / malformed body; throws only on transport failure (timeout, DNS),
 * which fan-out callers catch to null, mirroring the GoPlus adapter in
 * oracle/market.js.
 *
 * @param {string} mint Solana mint address
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<null | {
 *   mint: string,
 *   score_normalised: number|null,
 *   level: 'low'|'medium'|'high'|'critical'|null,
 *   risks: Array<{ name: string, description: string|null, level: string|null, score: number|null }>,
 *   lp_locked_pct: number|null,
 *   token_program: string|null,
 * }>}
 */
export async function fetchRugcheckSummary(mint, opts = {}) {
	const r = await fetch(`${RUGCHECK_API}/tokens/${encodeURIComponent(mint)}/report/summary`, {
		headers: { accept: 'application/json' },
		signal: opts.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!r.ok) return null;
	const d = await r.json().catch(() => null);
	if (!d || typeof d !== 'object') return null;
	const score = num(d.score_normalised);
	// A real report always carries the normalized score and/or a risks array;
	// anything else (error bodies, shape drift) is treated as "no report".
	if (score == null && !Array.isArray(d.risks)) return null;
	const clamped = score == null ? null : Math.max(0, Math.min(100, score));
	return {
		mint,
		score_normalised: clamped,
		level: rugcheckLevel(clamped),
		risks: (Array.isArray(d.risks) ? d.risks : [])
			.filter((x) => x && x.name)
			.map((x) => ({
				name: String(x.name),
				description: x.description || null,
				level: x.level || null,
				score: num(x.score),
			})),
		lp_locked_pct: num(d.lpLockedPct),
		token_program: d.tokenProgram || null,
	};
}
