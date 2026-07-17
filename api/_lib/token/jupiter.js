// Shared Jupiter (lite-api) swap client for the $THREE token lanes.
//
// The programmatic buyback (buyback.js) and the x402 micro-buy loop (microbuy.js)
// both market-buy $THREE on Jupiter. This module is the ONE place that talks to
// the Jupiter quote + swap API so the two lanes can never drift on endpoint, error
// handling, or transaction-build options. It builds nothing on-chain and holds no
// keys — callers own signing, broadcasting, and confirmation.
//
// BUY-ONLY by construction: nothing here sells $THREE. Every helper is a generic
// (inputMint → outputMint) swap primitive; the $THREE lanes only ever call it with
// outputMint = $THREE, and there is no sell path anywhere in the token/ tree.

const JUP_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
const JUP_SWAP_URL = 'https://lite-api.jup.ag/swap/v1/swap';

/**
 * GET a Jupiter route + throw a coded error on a non-2xx / unparseable response,
 * so a caller records the precise reason instead of an opaque failure.
 */
export async function fetchJson(url, opts) {
	const r = await fetch(url, opts);
	const body = await r.json().catch(() => ({}));
	if (!r.ok) {
		throw Object.assign(new Error(`jupiter ${r.status}: ${JSON.stringify(body).slice(0, 200)}`), {
			code: 'jupiter_error',
			status: r.status,
		});
	}
	return body;
}

/**
 * ExactIn quote: how much `outputMint` a given `amount` of `inputMint` buys.
 * @param {{ inputMint: string, outputMint: string, amount: bigint|number|string, slippageBps: number }} args
 * @returns {Promise<object>} the raw Jupiter quoteResponse
 */
export async function jupiterQuote({ inputMint, outputMint, amount, slippageBps }) {
	const u = new URL(JUP_QUOTE_URL);
	u.searchParams.set('inputMint', inputMint);
	u.searchParams.set('outputMint', outputMint);
	u.searchParams.set('amount', String(amount));
	u.searchParams.set('slippageBps', String(slippageBps));
	u.searchParams.set('swapMode', 'ExactIn');
	return fetchJson(u.toString(), { headers: { accept: 'application/json' } });
}

/**
 * Build the (unsigned) swap transaction (base64) for a quote. The caller
 * deserializes, signs, broadcasts, and confirms it.
 * @param {{ quote: object, userPublicKey: string, wrapAndUnwrapSol?: boolean, maxPriorityLamports?: number, priorityLevel?: string }} args
 * @returns {Promise<string>} base64 VersionedTransaction bytes
 */
export async function jupiterSwapTx({
	quote,
	userPublicKey,
	wrapAndUnwrapSol = false,
	maxPriorityLamports = 1_000_000,
	priorityLevel = 'medium',
}) {
	const data = await fetchJson(JUP_SWAP_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({
			quoteResponse: quote,
			userPublicKey,
			// USDC→$THREE never touches wrapped SOL; let Jupiter manage the $THREE ATA.
			wrapAndUnwrapSol,
			dynamicComputeUnitLimit: true,
			prioritizationFeeLamports: {
				priorityLevelWithMaxLamports: { maxLamports: maxPriorityLamports, priorityLevel },
			},
		}),
	});
	if (!data.swapTransaction) {
		throw Object.assign(new Error('jupiter returned no swapTransaction'), { code: 'no_swap_tx' });
	}
	return data.swapTransaction;
}
