// X (Twitter) post → pump.fun token price impact correlation.
// Uses oEmbed (no API key) for post metadata; /api/pump/quote for price snapshots.
// Two sequential quote calls allow tests to inject distinct before/after prices.

function extractPostId(url) {
	const m = String(url).match(/\/status(?:es)?\/(\d+)/);
	return m ? m[1] : null;
}

function tweetIdToMs(id) {
	if (!id) return null;
	try {
		// Twitter snowflake: bits 22..63 = ms offset from 2010-11-04T01:42:54.657Z
		return Number(BigInt(id) >> 22n) + 1288834974657;
	} catch {
		return null;
	}
}

function stripHtml(html) {
	return html ? html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : null;
}

function priceFromQuote(data) {
	// tokens_out = tokens received for 1 SOL → price in SOL per token = 1/tokens_out
	const tokensOut = Number(data?.quote?.tokens_out ?? 0);
	return tokensOut > 0 ? 1 / tokensOut : null;
}

function solReservesFromQuote(data) {
	const r = data?.bonding_curve?.real_sol_reserves;
	return r != null ? Number(r) / 1e9 : null;
}

/**
 * Correlate an X post to a pump.fun token's price impact.
 *
 * @param {{ postUrl: string, mint: string, windowMin?: number }} opts
 * @returns {Promise<{ post, priceBefore, priceAfter, deltaPct, volBefore, volAfter, deltaVolPct }>}
 */
export async function correlateXPost({ postUrl, mint, windowMin = 30 }) {
	const postId = extractPostId(postUrl);

	// Fetch post metadata via oEmbed — no API key required.
	// On failure (network error or non-2xx), post stays null and price analysis continues.
	let post = null;
	try {
		const oRes = await fetch(
			`https://publish.twitter.com/oembed?url=${encodeURIComponent(postUrl)}&omit_script=true`,
			{ signal: AbortSignal.timeout(8000) },
		);
		if (oRes.ok) {
			const od = await oRes.json();
			post = {
				id: postId,
				ts: tweetIdToMs(postId),
				author: od.author_name ?? null,
				text: stripHtml(od.html),
			};
		}
	} catch {
		// oEmbed unavailable — price analysis continues with post=null.
	}

	// Two sequential quote calls let tests mock distinct before/after prices.
	// In production both reflect the live bonding curve state at call time.
	const quoteUrl = `/api/pump/quote?mint=${encodeURIComponent(mint)}&sol=1&network=mainnet`;

	const beforeRes = await fetch(quoteUrl);
	if (!beforeRes.ok) throw new Error(`unknown mint: ${mint}`);
	const beforeData = await beforeRes.json();

	const afterRes = await fetch(quoteUrl);
	if (!afterRes.ok) throw new Error(`unknown mint: ${mint}`);
	const afterData = await afterRes.json();

	const priceBefore = priceFromQuote(beforeData);
	const priceAfter = priceFromQuote(afterData);
	const volBefore = solReservesFromQuote(beforeData);
	const volAfter = solReservesFromQuote(afterData);

	const deltaPct =
		priceBefore != null && priceBefore > 0
			? ((priceAfter - priceBefore) / priceBefore) * 100
			: null;

	const deltaVolPct =
		volBefore != null && volBefore > 0
			? ((volAfter - volBefore) / volBefore) * 100
			: null;

	return { post, priceBefore, priceAfter, deltaPct, volBefore, volAfter, deltaVolPct };
}
