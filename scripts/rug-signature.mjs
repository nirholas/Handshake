// Rug signature: what the platform's own labeled data actually says a rug looks
// like. No hand-picked thresholds. This reads pump_coin_intel joined with the
// ground-truth outcome label (pump_coin_outcomes) and prints, per outcome
// bucket, the real distribution of every entry-time feature the intel watcher
// captures. The gap between the "rugged" column and the "won" column IS the
// signature: features whose distributions separate the two are the ones worth
// gating on; features that overlap are noise no matter how intuitive they seem.
//
//   node scripts/rug-signature.mjs                 # print the full table
//   node scripts/rug-signature.mjs --json          # machine-readable
//   node scripts/rug-signature.mjs --min-mc 3000   # only coins that reached a floor MC (ignore stillborn)
//
// "won"  = outcome in ('graduated','pumped')  (ath_multiple >= 3x or graduated)
// "rug"  = outcome = 'rugged'
// "flat" = outcome = 'flat'  (died without rugging or pumping)
//
// The point of separating "rug" from "flat": a coin that never traded is not a
// honeypot, it's just dead. The owner's honeypot is the one that LOOKED alive at
// entry (a real opening candle, a stairstep) and then dumped. To find its tell we
// must compare rugs against WINNERS on the features visible at entry, and against
// flats to make sure we're not just describing "low activity".

import './lib/gcloud-path.mjs';
import { createRequire } from 'node:module';
import { requireServiceEnvValue } from './lib/service-env.mjs';
const require = createRequire(import.meta.url);
const { Pool } = require('@neondatabase/serverless');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const minMcIdx = args.indexOf('--min-mc');
const minMc = minMcIdx >= 0 ? Number(args[minMcIdx + 1]) : 0;
// --active isolates the cohort a momentum bot would actually consider: a coin
// that had a real formed market in the observation window, not a stillborn mint.
// Without this, 50k dead-on-arrival "rugs" (unique_buyers=1) swamp every median
// and the honeypot signature (which lives among the LIVE-LOOKING coins) is
// invisible. Floor is generous so we keep the whole "looked alive" population.
const activeIdx = args.indexOf('--active');
const activeBuyers = activeIdx >= 0 ? Number(args[activeIdx + 1] || 10) : 0;
const ACTIVE = activeBuyers ? `and i.unique_buyers >= ${activeBuyers}` : '';

function resolveDatabaseUrl() {
	if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
	// Production's copy is a Secret Manager reference, not a literal on the
	// service, so this has to resolve the reference rather than read `.value`.
	return requireServiceEnvValue('DATABASE_URL');
}

// The entry-time features. Each is a SQL expression over pump_coin_intel (i) so
// derived ratios (sellers-per-buyer, sell/buy count) are computed in-DB. Keep
// these to things VISIBLE AT ENTRY: no post-hoc outcome fields.
const FEATURES = [
	['unique_buyers', 'i.unique_buyers'],
	['unique_sellers', 'i.unique_sellers'],
	['sellers_per_100_buyers', 'case when i.unique_buyers > 0 then round(100.0 * i.unique_sellers / i.unique_buyers, 1) else 0 end'],
	['buy_count', 'i.buy_count'],
	['sell_count', 'i.sell_count'],
	['sell_per_100_buys', 'case when i.buy_count > 0 then round(100.0 * i.sell_count / i.buy_count, 1) else 0 end'],
	['dev_buy_sol', 'round(i.dev_buy_lamports / 1e9, 3)'],
	['dev_sold_pct', '(i.dev_sold::int * 100)'],
	['snipe_ratio', 'round(i.snipe_ratio, 3)'],
	['bundle_score', 'round(i.bundle_score, 3)'],
	['organic_score', 'round(i.organic_score, 3)'],
	['concentration_top10', 'round(i.concentration_top10, 3)'],
	['fresh_wallet_ratio', 'round(i.fresh_wallet_ratio, 3)'],
	['quality_score', 'i.quality_score'],
	['largest_buy_sol', 'round(i.largest_buy_lamports / 1e9, 3)'],
];

// Percentile summary for one feature across one bucket, plus the base rate.
async function distribution(pool, expr, bucketPred) {
	const q = `
		select
			count(*)                                          as n,
			round(percentile_cont(0.5) within group (order by v)::numeric, 3)  as p50,
			round(percentile_cont(0.25) within group (order by v)::numeric, 3) as p25,
			round(percentile_cont(0.75) within group (order by v)::numeric, 3) as p75,
			round(avg(v)::numeric, 3)                         as mean
		from (
			select (${expr})::numeric as v
			from pump_coin_intel i
			join pump_coin_outcomes o on o.mint = i.mint
			where i.network = 'mainnet'
			  and ${bucketPred}
			  ${ACTIVE}
			  and (${expr}) is not null
			  ${minMc ? `and coalesce(o.ath_market_cap_usd, 0) >= ${minMc}` : ''}
		) s`;
	const { rows } = await pool.query(q);
	return rows[0];
}

const BUCKETS = {
	won: `o.outcome in ('graduated','pumped')`,
	rug: `o.outcome = 'rugged'`,
	flat: `o.outcome = 'flat'`,
};

async function main() {
	const pool = new Pool({ connectionString: resolveDatabaseUrl() });
	try {
		// Bucket sizes first: how much labeled evidence do we actually have?
		const counts = {};
		for (const [name, pred] of Object.entries(BUCKETS)) {
			const { rows } = await pool.query(
				`select count(*)::int as n from pump_coin_intel i
				 join pump_coin_outcomes o on o.mint = i.mint
				 where i.network='mainnet' and ${pred}
				 ${ACTIVE}
				 ${minMc ? `and coalesce(o.ath_market_cap_usd,0) >= ${minMc}` : ''}`,
			);
			counts[name] = rows[0].n;
		}

		const table = [];
		for (const [label, expr] of FEATURES) {
			const row = { feature: label };
			for (const bucket of Object.keys(BUCKETS)) {
				row[bucket] = await distribution(pool, expr, BUCKETS[bucket]);
			}
			// Separation: how far the rug median sits from the winner median,
			// scaled by the winner IQR so it is comparable across features. A
			// big |sep| means the feature actually discriminates rugs from wins.
			const w = row.won, r = row.rug;
			const iqr = Math.max(1e-9, Number(w.p75) - Number(w.p25));
			row.separation = Number((((Number(r.p50) - Number(w.p50)) / iqr)).toFixed(2));
			table.push(row);
		}

		if (asJson) {
			console.log(JSON.stringify({ minMc, counts, features: table }, null, 2));
			return;
		}

		console.log(`\nRug signature from labeled outcomes${minMc ? ` (ATH MC >= $${minMc})` : ''}`);
		console.log(`buckets: won=${counts.won}  rug=${counts.rug}  flat=${counts.flat}\n`);
		const pad = (s, n) => String(s).padStart(n);
		console.log(
			pad('feature', 22),
			pad('won.p50', 9), pad('rug.p50', 9), pad('flat.p50', 9),
			pad('sep(σIQR)', 11),
		);
		console.log('-'.repeat(72));
		// Sort by absolute separation: the strongest tells float to the top.
		table.sort((a, b) => Math.abs(b.separation) - Math.abs(a.separation));
		for (const row of table) {
			console.log(
				pad(row.feature, 22),
				pad(row.won.p50, 9), pad(row.rug.p50, 9), pad(row.flat.p50, 9),
				pad(row.separation, 11),
			);
		}
		console.log('\nsep = (rug.p50 - won.p50) / won.IQR. |sep| > ~0.8 is a real, separating tell.');
		console.log('positive sep: rugs run HIGHER on this feature; negative: rugs run LOWER.\n');
	} finally {
		await pool.end();
	}
}

main().catch((e) => {
	console.error(e.message || e);
	process.exit(1);
});
