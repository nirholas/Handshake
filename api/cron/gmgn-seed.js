// GET/POST /api/cron/gmgn-seed — seed wallet_reputation from gmgn.ai smart money rankings.
//
// gmgn.ai maintains the industry-standard Solana smart money taxonomy: smart_degen,
// pump_smart, launchpad_smart, KOL wallets, snipers, etc. These labels predate our
// system by years and cover wallets that may never appear in our own pump_coin_wallets
// table. Seeding them gives the Oracle pedigree pillar ground truth across the
// entire ecosystem rather than only wallets we've personally observed.
//
// How it works:
//   1. Fetch each wallet-ranking tab from gmgn.ai's public (unauthenticated) API.
//      The API patterns were reverse-engineered from their network traffic (see
//      nirholas/scrape-smart-wallets). No API key required; we respect rate limits.
//   2. Translate gmgn tags → our label taxonomy (smart_money/sniper/dumper/neutral).
//   3. Upsert into wallet_reputation. Only sets label + smart_money_score from the
//      gmgn signal; our own on-chain observed stats (wins/duds etc.) are never
//      overwritten — they accumulate independently and take precedence on the score
//      once we have sufficient observed history (≥5 judged coins).
//   4. Idempotent: safe to run daily. Caps at 500 wallets per run.
//
// This runs once/day at off-peak hours — wallet rankings don't change minute-to-minute.
// The per-run cap and respectful delays make it a good citizen even without auth.

import { json, method, wrapCron } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { requireCron } from '../_lib/cron-auth.js';

const NETWORK = 'mainnet';
const CHAIN = 'sol';
const GMGN_BASE = 'https://gmgn.ai';
const MAX_WALLETS_PER_RUN = 500;
const FETCH_TIMEOUT_MS = 8000;
// Be respectful: 300ms between gmgn requests so we don't hammer them.
const INTER_REQUEST_DELAY_MS = 300;

// gmgn tab → our label. smart_degen/pump_smart = proven smart money buyers.
// launchpad_smart = launch specialists. renowned = KOL (community influence).
// snipe_bot = sniper (high win rate but different risk profile). top_dev = creators.
const TAG_MAP = {
	smart_degen:     { label: 'smart_money', score: 82 },
	pump_smart:      { label: 'smart_money', score: 78 },
	launchpad_smart: { label: 'smart_money', score: 72 },
	renowned:        { label: 'neutral',     score: 60 }, // KOL — influence, not edge
	snipe_bot:       { label: 'sniper',      score: 65 },
	top_dev:         { label: 'neutral',     score: 55 }, // creators — not necessarily smart buyers
	fresh_wallet:    { label: 'fresh',       score: 30 },
};

const TIMEFRAME = '7d';

// kol-quest GitHub fallback — pre-scraped Solana wallet list (smart_degen, kol, sniper, top_dev).
// Used when GMGN's Cloudflare protection returns 403 on server-side requests.
const KOLQUEST_FALLBACK_URL = 'https://raw.githubusercontent.com/nirholas/kol-quest/main/site/data/solwallets.json';

const KQ_CATEGORY_MAP = {
	smart_degen: { label: 'smart_money', score: 80 },
	pump_smart:  { label: 'smart_money', score: 76 },
	kol:         { label: 'neutral',     score: 60 },
	sniper:      { label: 'sniper',      score: 65 },
	top_dev:     { label: 'neutral',     score: 55 },
};

async function fetchKolQuestFallback() {
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS * 2);
		const r = await fetch(KOLQUEST_FALLBACK_URL, { signal: ctrl.signal });
		clearTimeout(timer);
		if (!r.ok) return [];
		const data = await r.json();
		const results = [];
		const smartMoney = data?.smartMoney?.wallets || {};
		for (const [category, entries] of Object.entries(smartMoney)) {
			const mapping = KQ_CATEGORY_MAP[category];
			if (!mapping || !Array.isArray(entries)) continue;
			for (const entry of entries) {
				const wallet = entry.wallet_address || entry.address;
				if (!wallet || wallet.length < 32) continue;
				results.push({ wallet, label: mapping.label, score: mapping.score });
			}
		}
		const kolList = data?.kol?.wallets || [];
		const kolMapping = KQ_CATEGORY_MAP['kol'];
		for (const entry of kolList) {
			const wallet = entry.wallet_address || entry.address;
			if (!wallet || wallet.length < 32) continue;
			results.push({ wallet, label: kolMapping.label, score: kolMapping.score });
		}
		return results;
	} catch {
		return [];
	}
}

async function fetchTab(tag) {
	const url = `${GMGN_BASE}/defi/quotation/v1/rank/${CHAIN}/wallets/${TIMEFRAME}?tag=${tag}&orderby=pnl&direction=desc&limit=100`;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (compatible; three.ws oracle/1.0)',
				'Accept': 'application/json',
				'Referer': 'https://gmgn.ai/',
			},
			signal: ctrl.signal,
		});
		if (!res.ok) return [];
		const data = await res.json();
		// gmgn returns { code: 0, data: { rank: [...] } } or { rank: [...] }
		return data?.data?.rank || data?.rank || [];
	} catch {
		return [];
	} finally {
		clearTimeout(timer);
	}
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Upsert a batch of seeded wallets into wallet_reputation.
 * Only touches label + smart_money_score if the wallet has < 5 judged coins
 * in our own system — once we've observed them ourselves we trust our own data.
 * @returns {Promise<{ written: number, failed: number }>} rows actually written
 *   vs rejected, so the response reports what landed rather than what was tried.
 */
async function upsertSeeded(batch) {
	if (!batch.length) return { written: 0, failed: 0 };
	// Build values for a single multi-row upsert.
	const values = batch.map((w) => ({
		wallet: w.wallet,
		network: NETWORK,
		label: w.label,
		score: w.score,
	}));

	// Postgres doesn't support VALUES with json arrays easily via tagged sql;
	// process in chunks of 50 with individual upserts. allSettled keeps one bad
	// row from sinking the chunk, so the count has to come from the fulfilled
	// results: counting chunk.length reported a clean run while every write was
	// rejecting, which is exactly the failure this cron would need to surface.
	let written = 0;
	let failed = 0;
	const CHUNK = 50;
	for (let i = 0; i < values.length; i += CHUNK) {
		const chunk = values.slice(i, i + CHUNK);
		const settled = await Promise.allSettled(chunk.map((v) =>
			sql`
				insert into wallet_reputation (wallet, network, label, smart_money_score, first_seen_at, updated_at)
				values (${v.wallet}, ${v.network}, ${v.label}, ${v.score}, now(), now())
				on conflict (wallet, network) do update set
					label = case
						when wallet_reputation.coins_traded >= 5 then wallet_reputation.label
						else excluded.label
					end,
					smart_money_score = case
						when wallet_reputation.coins_traded >= 5 then wallet_reputation.smart_money_score
						else greatest(wallet_reputation.smart_money_score, excluded.smart_money_score)
					end,
					updated_at = now()
			`,
		));
		for (const r of settled) {
			if (r.status === 'fulfilled') written++;
			else {
				failed++;
				// The first fault message plus a total, not one line per row: a chunk
				// that fails wholesale (schema drift, permissions, a dead connection)
				// would otherwise print the same line fifty times.
				if (failed === 1) console.warn(`[gmgn-seed] wallet_reputation upsert failed: ${r.reason?.message || r.reason}`);
			}
		}
	}
	if (failed) console.warn(`[gmgn-seed] ${failed} of ${values.length} upserts failed`);
	return { written, failed };
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const started = Date.now();
	const tags = Object.keys(TAG_MAP);
	const collected = new Map(); // wallet → { label, score } — dedup, keep highest score

	// Try GMGN live API first.
	for (const tag of tags) {
		const mapping = TAG_MAP[tag];
		const rows = await fetchTab(tag);
		for (const row of rows) {
			const wallet = row?.wallet_address || row?.address || row?.wallet;
			if (!wallet || typeof wallet !== 'string' || wallet.length < 32) continue;
			const existing = collected.get(wallet);
			if (!existing || mapping.score > existing.score) {
				collected.set(wallet, { wallet, label: mapping.label, score: mapping.score });
			}
			if (collected.size >= MAX_WALLETS_PER_RUN) break;
		}
		if (collected.size >= MAX_WALLETS_PER_RUN) break;
		await sleep(INTER_REQUEST_DELAY_MS);
	}

	// Fall back to kol-quest GitHub data if GMGN returned nothing (Cloudflare block).
	let fallbackUsed = false;
	if (collected.size === 0) {
		fallbackUsed = true;
		const fallbackRows = await fetchKolQuestFallback();
		for (const row of fallbackRows) {
			const existing = collected.get(row.wallet);
			if (!existing || row.score > existing.score) {
				collected.set(row.wallet, row);
			}
			if (collected.size >= MAX_WALLETS_PER_RUN) break;
		}
	}

	const batch = [...collected.values()];
	const { written, failed } = await upsertSeeded(batch);

	return json(res, 200, {
		ok: failed === 0,
		fetched: collected.size,
		upserted: written,
		upsert_failed: failed,
		tags_tried: tags.length,
		fallback_used: fallbackUsed,
		ms: Date.now() - started,
	});
});
