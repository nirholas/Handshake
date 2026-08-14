// Fit the Oracle conviction CALIBRATION from realized production outcomes.
//
// scripts/oracle-fit.mjs fits the model's per-bucket weights against the
// labeled training set, where "good" = graduated or hit >= 3x ATH. This script
// answers the different, harder question the product actually makes to a user:
// of the coins Oracle has already scored and the market has already resolved,
// what fraction of each score band WON, where a win is the platform's own
// definition (graduated, or >= 2x ATH without rugging)?
//
// The two numbers were never the same, and nothing reconciled them, so a card
// reading "conviction 99" was quoting a training-label probability of 95%+
// while the same band realized 26%. This script measures the realized rate,
// smooths it into a monotone ladder with pool-adjacent-violators (isotonic
// regression), and writes conviction-calibration.json. conviction.js then
// serves the realized hit rate alongside every score, and the public tier
// boundaries are set from the plateaus this fit exposes.
//
//   node scripts/oracle-calibrate.mjs           # fit + report
//   node scripts/oracle-calibrate.mjs --write   # also update the shipped JSON
//
// Data source: the production database when DATABASE_URL is set, otherwise the
// live /api/oracle/backtest endpoint, which runs this exact aggregation
// server-side. Both read the same two tables; neither invents a number.

import { readFileSync, writeFileSync } from 'node:fs';

const OUT_PATH = new URL('../api/_lib/oracle/conviction-calibration.json', import.meta.url);
const NETWORK = process.env.ORACLE_NETWORK || 'mainnet';
const API_ORIGIN = process.env.ORACLE_API_ORIGIN || 'https://three.ws';

// Keep in sync with api/oracle/backtest.js and tests/oracle/win-definition.test.js.
const WIN_DEFINITION = 'graduated or (ath_multiple >= 2 and not rugged)';

function databaseUrl() {
	if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
	for (const file of ['../.env.local', '../.env']) {
		try {
			const m = readFileSync(new URL(file, import.meta.url), 'utf8').match(/^DATABASE_URL=(.+)$/m);
			if (m) return m[1].trim().replace(/^["']|["']$/g, '');
		} catch { /* try the next candidate */ }
	}
	return null;
}

/** Read the per-band resolved counts straight from the database. */
async function loadFromDb(url) {
	const { neon } = await import('@neondatabase/serverless');
	const sql = neon(url);
	const rows = await sql`
		select
			least(width_bucket(c.score, 0, 100, 10), 10)                          as bucket,
			count(*)::int                                                         as n,
			count(*) filter (where o.graduated or (o.ath_multiple >= 2 and not coalesce(o.rugged, false)))::int as wins
		from oracle_conviction c
		join pump_coin_outcomes o on o.mint = c.mint
		where c.network = ${NETWORK}
		  and (o.graduated or o.rugged or o.ath_multiple is not null)
		group by 1
		order by 1
	`;
	const bands = rows
		.filter((r) => r.bucket >= 1 && r.bucket <= 10)
		.map((r) => ({ lo: (r.bucket - 1) * 10, hi: r.bucket * 10, n: Number(r.n), wins: Number(r.wins) }));
	return { source: 'database', bands };
}

/** Read the same aggregation from the live backtest endpoint. */
async function loadFromApi() {
	const url = `${API_ORIGIN}/api/oracle/backtest?period=all&network=${NETWORK}`;
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	if (!res.ok) throw new Error(`backtest endpoint answered ${res.status} (${url})`);
	const body = await res.json();
	if (!Array.isArray(body.calibration) || !body.calibration.length) {
		throw new Error('backtest endpoint returned no calibration bands');
	}
	const bands = body.calibration.map((c) => ({ lo: c.lo, hi: c.hi, n: Number(c.n), wins: Number(c.wins) }));
	return { source: `api:${API_ORIGIN}`, bands };
}

/**
 * Pool-adjacent-violators: the standard isotonic-regression fit. Returns a
 * non-decreasing rate per band, sample-weighted, so a band that dips below its
 * neighbour (noise, not signal) is merged with it instead of published as a
 * ladder that goes backwards.
 *
 * @param {Array<{n:number, wins:number}>} bands
 * @returns {number[]} calibrated rate per input band
 */
export function isotonic(bands) {
	const blocks = bands.map((b) => ({ n: b.n, wins: b.wins, span: 1 }));
	for (let i = 1; i < blocks.length; i++) {
		while (i > 0 && rate(blocks[i - 1]) > rate(blocks[i])) {
			const merged = {
				n: blocks[i - 1].n + blocks[i].n,
				wins: blocks[i - 1].wins + blocks[i].wins,
				span: blocks[i - 1].span + blocks[i].span,
			};
			blocks.splice(i - 1, 2, merged);
			i -= 1;
		}
	}
	const out = [];
	for (const b of blocks) for (let k = 0; k < b.span; k++) out.push(rate(b));
	return out;
}

function rate(block) {
	return block.n > 0 ? block.wins / block.n : 0;
}

/**
 * Group adjacent bands the data cannot tell apart: the ladder's real rungs.
 * Isotonic already merges outright violations, but it leaves neighbours that
 * differ by a fraction of a point as separate blocks, and those are not
 * separate claims about the world. Bands within `tol` relative distance of each
 * other collapse into one rung, so the report shows the boundaries a tier
 * ladder can actually stand on.
 */
function plateaus(bands, tol = 0.05) {
	const out = [];
	for (const b of bands) {
		const last = out[out.length - 1];
		const close = last && Math.abs(last.calibrated - b.calibrated) <= tol * Math.max(last.calibrated, b.calibrated);
		if (close) {
			// Weighted mean of the CALIBRATED rates, never a re-pool of the raw
			// wins: recomputing wins/n here would undo the isotonic fit and can
			// hand back a rung ladder that steps backwards.
			last.calibrated = (last.calibrated * last.n + b.calibrated * b.n) / (last.n + b.n);
			last.hi = b.hi; last.n += b.n; last.wins += b.wins;
		} else {
			out.push({ lo: b.lo, hi: b.hi, n: b.n, wins: b.wins, calibrated: b.calibrated });
		}
	}
	return out;
}

// Guarded so the fit helpers above can be imported (and unit-tested) without a
// bare `import` firing a production query and a file write.
if (!import.meta.main) {
	// Imported for its exports only.
} else {

const dbUrl = databaseUrl();
const { source, bands: raw } = dbUrl ? await loadFromDb(dbUrl) : await loadFromApi();

const resolved = raw.reduce((a, b) => a + b.n, 0);
const wins = raw.reduce((a, b) => a + b.wins, 0);
if (resolved < 5000) {
	console.error(`Only ${resolved} resolved coins; refusing to calibrate on so little.`);
	process.exit(2);
}
const baseRate = wins / resolved;
const smoothed = isotonic(raw);
const bands = raw.map((b, i) => ({
	lo: b.lo,
	hi: b.hi,
	n: b.n,
	wins: b.wins,
	observed: Number((b.wins / b.n).toFixed(4)),
	calibrated: Number(smoothed[i].toFixed(4)),
	lift: Number((smoothed[i] / baseRate).toFixed(2)),
}));

console.log(`source: ${source}`);
console.log(`resolved coins: ${resolved.toLocaleString()}  wins: ${wins.toLocaleString()}  base rate: ${(100 * baseRate).toFixed(2)}%`);
console.log('\nband      n       observed  calibrated  lift');
for (const b of bands) {
	console.log(
		`${String(b.lo).padStart(3)}-${String(b.hi).padEnd(4)} ${String(b.n).padStart(7)}  ` +
		`${(100 * b.observed).toFixed(1).padStart(7)}%  ${(100 * b.calibrated).toFixed(1).padStart(8)}%  ${b.lift.toFixed(2)}x`,
	);
}
console.log('\nladder rungs (adjacent bands the data cannot tell apart):');
for (const p of plateaus(bands)) {
	console.log(`  ${p.lo}-${p.hi}: ${(100 * p.calibrated).toFixed(1)}% over n=${p.n} (${(p.calibrated / baseRate).toFixed(2)}x base)`);
}
console.log('\nTier boundaries in conviction.js should sit on these rung edges.');

const out = {
	version: 1,
	fitted_at: new Date().toISOString(),
	source,
	network: NETWORK,
	win_definition: WIN_DEFINITION,
	resolved_n: resolved,
	wins_n: wins,
	base_rate: Number(baseRate.toFixed(4)),
	bands,
};

if (process.argv.includes('--write')) {
	writeFileSync(OUT_PATH, JSON.stringify(out, null, '\t') + '\n');
	console.log(`\nwrote ${OUT_PATH.pathname}`);
} else {
	console.log('\n(dry run; pass --write to update conviction-calibration.json)');
}

}
