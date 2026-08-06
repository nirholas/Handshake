// @ts-check
// Switchboard oracle via Crossbar: keyless REST simulation of a Switchboard
// On-Demand feed. Crossbar asks the live oracle network to run the feed's job
// definition right now and returns the computed value, so this is a fresh
// multi-exchange read with a methodology fully independent of every other rung
// in the price chains, and it needs no key, no wallet, and no on-chain
// tooling.
//
// Endpoint (verified live 2026-08-05):
//   GET https://crossbar.switchboard.xyz/v2/simulate/{feedHash}
//   -> { feeds: [{ feedHash: "0x...", feedName: "Surge Stream SOL/USD, WEIGHTED",
//        results: ["74.02000000"], network: "mainnet" }], totalFeeds: 1, ... }
// The legacy path (GET /simulate/{feedHash} -> [{ feedHash, results }]) serves
// the same data as a bare array; the parser accepts both shapes so a Crossbar
// rollback never blanks the rung. Feed hashes are the canonical 32-byte ids
// from docs.switchboard.xyz (the hash of the feed's job definition), NOT
// Solana account pubkeys.

const CROSSBAR_BASE = 'https://crossbar.switchboard.xyz';

// Canonical Switchboard SOL/USD feed (docs.switchboard.xyz, "Surge Stream
// SOL/USD, WEIGHTED"). Verified live against the endpoint above.
export const SWITCHBOARD_SOL_USD_FEED = '0x822512ee9add93518eca1c105a38422841a76c590db079eebb283deb2c14caa9';

/** Lowercased hex without the 0x prefix, so both id spellings compare equal. */
const normalizeHash = (h) => String(h || '').toLowerCase().replace(/^0x/, '');

/**
 * Extract the simulated value for `feedHash` from a Crossbar simulation
 * payload (v2 `{ feeds: [...] }` object or legacy bare array). A feed can
 * carry several oracle results; the median is taken so one outlier sample
 * cannot skew the price. Returns null (a failover MISS) when the feed is
 * absent or produced no positive finite result.
 *
 * @param {unknown} payload parsed JSON body of /v2/simulate/{feedHash}
 * @param {string} feedHash the feed id that was requested
 * @returns {number | null}
 */
export function parseCrossbarSimulation(payload, feedHash) {
	const want = normalizeHash(feedHash);
	if (!want) return null;
	const feeds = Array.isArray(/** @type {any} */ (payload)?.feeds)
		? /** @type {any} */ (payload).feeds
		: Array.isArray(payload)
			? payload
			: [];
	for (const feed of feeds) {
		if (normalizeHash(feed?.feedHash) !== want) continue;
		const nums = (Array.isArray(feed?.results) ? feed.results : [])
			.map(Number)
			.filter((n) => Number.isFinite(n) && n > 0)
			.sort((a, b) => a - b);
		if (!nums.length) return null;
		const mid = Math.floor(nums.length / 2);
		return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
	}
	return null;
}

/**
 * A failover-fetch provider rung (see src/shared/failover-fetch.js) for any
 * Switchboard feed hash. Drop it into any `fetchFirst` chain.
 *
 * @param {string} feedHash canonical feed id, with or without the 0x prefix
 * @param {{ name?: string }} [opts]
 * @returns {{ name: string, url: string, parse: (r: Response) => Promise<number | null> }}
 */
export function switchboardProvider(feedHash, { name = 'switchboard' } = {}) {
	const hash = normalizeHash(feedHash);
	return {
		name,
		url: `${CROSSBAR_BASE}/v2/simulate/0x${hash}`,
		parse: async (r) => parseCrossbarSimulation(await r.json(), hash),
	};
}
