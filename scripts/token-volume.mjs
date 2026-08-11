#!/usr/bin/env node
/**
 * Lifetime + 24h DEX volume for a Solana token, summed across every pool that
 * trades it. No provider reports a cumulative figure, so this sums GeckoTerminal
 * daily OHLCV per pool from each pool's first candle, including the pump.fun
 * bonding curve pool when the token launched there.
 *
 * Usage: node scripts/token-volume.mjs [mint] [--json]
 * Default mint is $THREE.
 */

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const GT = 'https://api.geckoterminal.com/api/v2';
const NETWORK = 'solana';
const MAX_POOL_PAGES = 10;
/** GeckoTerminal's keyless tier allows ~30 requests/minute. Stay under it by pacing every call. */
const MIN_REQUEST_GAP_MS = 2400;
const MAX_BACKOFF_MS = 60_000;
const MAX_ATTEMPTS = 8;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let nextSlotAt = 0;

async function waitForSlot() {
	const now = Date.now();
	const wait = Math.max(0, nextSlotAt - now);
	nextSlotAt = Math.max(now, nextSlotAt) + MIN_REQUEST_GAP_MS;
	if (wait > 0) await sleep(wait);
}

function retryDelay(res, attempt) {
	const header = Number(res?.headers?.get('retry-after'));
	if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, MAX_BACKOFF_MS);
	return Math.min(3000 * 2 ** attempt, MAX_BACKOFF_MS);
}

async function gecko(path) {
	let lastError = new Error(`GeckoTerminal request never ran: ${path}`);
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		await waitForSlot();
		let res;
		try {
			res = await fetch(`${GT}${path}`, { headers: { accept: 'application/json' } });
		} catch (err) {
			lastError = err;
			await sleep(retryDelay(null, attempt));
			continue;
		}
		if (res.status === 429 || res.status >= 500) {
			lastError = new Error(`GeckoTerminal ${res.status} on ${path}`);
			const pause = retryDelay(res, attempt);
			nextSlotAt = Date.now() + pause;
			await sleep(pause);
			continue;
		}
		if (!res.ok) throw new Error(`GeckoTerminal ${res.status} on ${path}`);
		return res.json();
	}
	throw lastError;
}

async function listPools(mint) {
	const pools = [];
	for (let page = 1; page <= MAX_POOL_PAGES; page++) {
		const body = await gecko(`/networks/${NETWORK}/tokens/${mint}/pools?page=${page}`);
		const batch = body.data ?? [];
		if (!batch.length) break;
		pools.push(...batch);
		if (batch.length < 20) break;
	}
	return pools;
}

async function poolVolume(pool) {
	const address = pool.attributes.address;
	const body = await gecko(
		`/networks/${NETWORK}/pools/${address}/ohlcv/day?aggregate=1&limit=1000&currency=usd`
	);
	const candles = body.data?.attributes?.ohlcv_list ?? [];
	let lifetimeUsd = 0;
	let firstTradeAt = null;
	for (const [ts, , , , , volume] of candles) {
		lifetimeUsd += Number(volume) || 0;
		if (firstTradeAt === null || ts < firstTradeAt) firstTradeAt = ts;
	}
	return {
		address,
		name: pool.attributes.name,
		dex: pool.relationships?.dex?.data?.id ?? null,
		lifetimeUsd,
		volume24hUsd: Number(pool.attributes.volume_usd?.h24) || 0,
		liquidityUsd: Number(pool.attributes.reserve_in_usd) || 0,
		activeDays: candles.length,
		firstTradeAt: firstTradeAt ? new Date(firstTradeAt * 1000).toISOString().slice(0, 10) : null,
	};
}

const usd = (n) =>
	n >= 1_000_000
		? `$${(n / 1_000_000).toFixed(2)}M`
		: `$${Math.round(n).toLocaleString('en-US')}`;

async function main() {
	const args = process.argv.slice(2);
	const asJson = args.includes('--json');
	const mint = args.find((a) => !a.startsWith('--')) ?? THREE_MINT;

	const pools = await listPools(mint);
	if (!pools.length) {
		console.error(`No GeckoTerminal pools indexed for ${mint}`);
		process.exit(1);
	}

	const rows = [];
	const failed = [];
	for (const pool of pools) {
		try {
			rows.push(await poolVolume(pool));
		} catch (err) {
			failed.push({ address: pool.attributes.address, name: pool.attributes.name, reason: err.message });
		}
	}
	rows.sort((a, b) => b.lifetimeUsd - a.lifetimeUsd);

	const totals = rows.reduce(
		(acc, r) => ({
			lifetimeUsd: acc.lifetimeUsd + r.lifetimeUsd,
			volume24hUsd: acc.volume24hUsd + r.volume24hUsd,
			liquidityUsd: acc.liquidityUsd + r.liquidityUsd,
		}),
		{ lifetimeUsd: 0, volume24hUsd: 0, liquidityUsd: 0 }
	);

	if (asJson) {
		console.log(
			JSON.stringify({ mint, complete: failed.length === 0, pools: rows, failed, totals }, null, 2)
		);
		return;
	}

	console.log(`${mint}  ${rows.length} of ${pools.length} pools read\n`);
	for (const r of rows.filter((r) => r.lifetimeUsd >= 1000)) {
		console.log(
			`${usd(r.lifetimeUsd).padStart(10)} lifetime  ${usd(r.volume24hUsd).padStart(9)} 24h  ` +
				`since ${r.firstTradeAt ?? 'n/a'}  ${r.name}  ${r.address}`
		);
	}
	const dust = rows.filter((r) => r.lifetimeUsd < 1000);
	if (dust.length) {
		const dustTotal = dust.reduce((s, r) => s + r.lifetimeUsd, 0);
		console.log(`${usd(dustTotal).padStart(10)} lifetime  across ${dust.length} dust pools`);
	}
	const label = failed.length ? 'LIFETIME VOLUME (PARTIAL)' : 'LIFETIME VOLUME';
	console.log(
		`\n${label} ${usd(totals.lifetimeUsd)}   24H ${usd(totals.volume24hUsd)}   ` +
			`LIQUIDITY ${usd(totals.liquidityUsd)}`
	);
	if (failed.length) {
		console.log(`\n${failed.length} pool(s) unread, so the lifetime total is a floor:`);
		for (const f of failed) console.log(`  ${f.name}  ${f.address}  ${f.reason}`);
		process.exitCode = 2;
	}
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
