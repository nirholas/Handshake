import lexiconData from './lexicon.json' with { type: 'json' };

// Terms match on word boundaries, not as bare substrings. Substring matching
// read "partnered" as the bearish term "red", "pump" as the bullish "up" (on
// top of "pump" itself), "path" as "ath" and "download" as "down", so a
// plainly positive pump.fun callout could score negative. Word boundaries are
// only applied to the alphanumeric ends of a term, which leaves the emoji
// entries (🚀, 📉, ⚠️) and hyphenated ones (sell-off) matching as before. The
// lexicon carries the inflections that matter (mooning, dumping, scammer)
// explicitly, and each inflection now counts once instead of also firing its
// shorter stem.
function termPattern(term) {
	const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const head = /^[a-z0-9]/.test(term) ? '(?<![a-z0-9])' : '';
	const tail = /[a-z0-9]$/.test(term) ? '(?![a-z0-9])' : '';
	return new RegExp(`${head}${escaped}${tail}`, 'g');
}

const POS_TERMS = lexiconData.positive.map((t) => termPattern(t.toLowerCase()));
const NEG_TERMS = lexiconData.negative.map((t) => termPattern(t.toLowerCase()));

function countMatches(text, terms) {
	const lower = text.toLowerCase();
	let count = 0;
	for (const term of terms) {
		count += lower.match(term)?.length ?? 0;
	}
	return count;
}

/**
 * Score sentiment for a batch of social posts using a deterministic lexicon.
 * @param {Array<{id?: string, ts?: string|number, text: string, author?: string}>} posts
 * @returns {{
 *   score: number,
 *   posPct: number,
 *   negPct: number,
 *   neuPct: number,
 *   count: number,
 *   examples: { pos: string[], neg: string[] }
 * }}
 */
export function scoreSentiment(posts) {
	if (!Array.isArray(posts) || posts.length === 0) {
		return { score: 0, posPct: 0, negPct: 0, neuPct: 100, count: 0, examples: { pos: [], neg: [] } };
	}

	let posCount = 0;
	let negCount = 0;
	let neuCount = 0;
	const posExamples = [];
	const negExamples = [];

	for (const post of posts) {
		const text = String(post.text || '');
		const p = countMatches(text, POS_TERMS);
		const n = countMatches(text, NEG_TERMS);

		if (p > n) {
			posCount++;
			if (posExamples.length < 3) posExamples.push(text);
		} else if (n > p) {
			negCount++;
			if (negExamples.length < 3) negExamples.push(text);
		} else {
			neuCount++;
		}
	}

	const total = posts.length;
	const score = total > 0 ? (posCount - negCount) / total : 0;
	const posPct = (posCount / total) * 100;
	const negPct = (negCount / total) * 100;
	const neuPct = (neuCount / total) * 100;

	const posPctR = Math.round(posPct * 10) / 10;
	const negPctR = Math.round(negPct * 10) / 10;
	return {
		score: Math.round(score * 1000) / 1000,
		posPct: posPctR,
		negPct: negPctR,
		neuPct: Math.round((100 - posPctR - negPctR) * 10) / 10, // ensures sum === 100
		count: total,
		examples: { pos: posExamples, neg: negExamples },
	};
}
