// Live on-chain balance + USD-price helpers, shared by /api/wallet/balances and
// /api/portfolio.
//
// Optimization strategy (2026-05-25):
//   - Solana: single Helius `getAssetsByOwner` (DAS) call returns native SOL +
//     all fungible token balances *with metadata*. Eliminates the previous
//     N+1 (getTokenAccountsByOwner + N×getAsset) burn (~200 Helius credits
//     per portfolio → ~10).
//   - Falls back to public RPC + token_metadata cache when Helius is missing
//     or rate-limited. DAS isn't available on public RPC, so metadata then
//     comes from our Postgres `token_metadata` cache.
//   - Jupiter Lite Price API replaces CoinGecko for Solana token prices —
//     faster, no rate limits, knows pump.fun bondings.
//   - Cache layer uses Upstash Redis if configured (shared across function
//     instances), in-memory otherwise.

import { cacheGet, cacheSet, cacheDel } from './cache.js';
import { getMetadataForMints } from './token-metadata.js';
import { solPriceUsd } from './sol-price.js';

const BALANCES_TTL_S = 60;
// Last-known-good snapshot lifetime. A long horizon so a wallet that briefly
// can't be read (Helius quota out + flaky public RPC) is served its real prior
// balances — flagged stale — instead of erroring out. Refreshed on every
// successful read.
const BALANCES_LKG_TTL_S = 24 * 60 * 60;

// The last-resort public RPCs, tried in order when Helius is absent or quota-
// exhausted. `api.mainnet-beta.solana.com` aggressively rate-limits and its CDN
// returns 404/403 under load — a single endpoint is a single point of failure
// (it was the source of the `upstream 404: Not Found` net-worth 502s), so we
// rotate a small pool. SOLANA_RPC_URL overrides the primary; SOLANA_RPC_FALLBACKS
// (comma-separated) appends more. Dedup, drop falsy.
const PUBLIC_SOL_RPCS = [
	process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
	...(process.env.SOLANA_RPC_FALLBACKS
		? process.env.SOLANA_RPC_FALLBACKS.split(',').map((s) => s.trim())
		: ['https://solana-rpc.publicnode.com']),
].filter((v, i, a) => v && a.indexOf(v) === i);
const PUMP_FRONTEND_BASE = process.env.PUMP_FRONTEND_BASE || 'https://frontend-api-v3.pump.fun';
function heliusRpc() {
	const key = process.env.HELIUS_API_KEY;
	return key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : null;
}

// Throttled warnings. The balance helpers are called on every portfolio /
// holder-gate / networth read; an upstream that is sustainedly degraded (a
// Helius month-quota exhaustion, a flaky public RPC) would otherwise emit one
// identical warning per request — exactly the production flood seen in the logs
// (70+ "[balances] helius failed" / "DAS path failed" lines for a single
// exhausted-quota window). Collapse repeats of the same category to one line per
// WARN_COOLDOWN_MS so a real outage stays visible without drowning the logs.
const _warnedAt = new Map();
const WARN_COOLDOWN_MS = 60_000;
function warnThrottled(category, msg) {
	const now = Date.now();
	if (now - (_warnedAt.get(category) || 0) < WARN_COOLDOWN_MS) return;
	_warnedAt.set(category, now);
	console.warn(msg);
}

// Helius quota circuit breaker. When Helius reports an exhausted plan quota
// ("max usage reached", JSON-RPC -32429, or a bare 429), every subsequent
// request would otherwise still hit Helius first, eat a doomed round-trip, warn,
// and only then fall back to the public RPC. Helius quota only clears on the
// provider's billing/usage cycle, so once we see it we skip Helius outright for a
// cooldown window and go straight to the public-RPC / DAS-fallback path. This is
// the balance-layer analogue of the market-data source breaker
// (api/_lib/market/token-market.js). Per-instance + best-effort: a cold lambda
// re-discovers the exhausted quota once, then skips for the window.
const HELIUS_QUOTA_COOLDOWN_MS = 10 * 60_000;
let heliusCooldownUntil = 0; // epoch ms; 0 = available
let heliusQuotaTrips = 0; // cumulative since cold start — trend for /healthz

function heliusAvailable(now = Date.now()) {
	return heliusCooldownUntil <= now;
}

/**
 * Point-in-time health of the Helius balance-RPC breaker, for /healthz and the
 * status page. Pure read of module state. `degraded` means we're currently in a
 * quota cooldown and serving balances from the public RPC — functional, but the
 * premium path is throttled. No key configured is reported as `configured:false`,
 * not a degradation (the public-RPC path is the intended fallback).
 * @returns {{ configured: boolean, available: boolean, degraded: boolean,
 *   cooldownRemainingMs: number, quotaTripsSinceStart: number }}
 */
export function heliusHealth() {
	const now = Date.now();
	const configured = !!heliusRpc();
	const available = heliusAvailable(now);
	return {
		configured,
		available,
		degraded: configured && !available,
		cooldownRemainingMs: available ? 0 : heliusCooldownUntil - now,
		quotaTripsSinceStart: heliusQuotaTrips,
	};
}

// True when an upstream error is a quota/rate-limit signal (vs. a transient blip
// worth retrying). Covers Helius's -32429 "max usage reached", a bare HTTP 429,
// and generic "quota/usage limit exceeded" bodies.
function isQuotaError(err) {
	const msg = String(err?.message || '');
	return /max usage reached|-32429|\b429\b|usage limit exceeded|quota exceeded|rate ?limit/i.test(msg);
}

function tripHeliusCooldown(err, category) {
	heliusCooldownUntil = Date.now() + HELIUS_QUOTA_COOLDOWN_MS;
	heliusQuotaTrips++;
	warnThrottled(
		category,
		`[balances] helius quota/rate-limited — skipping it for ${Math.round(HELIUS_QUOTA_COOLDOWN_MS / 60_000)}min, using public RPC: ${err?.message}`,
	);
}

/** Test seam: reset the Helius breaker + warn throttle between cases. */
export function __resetBalancesBreaker() {
	heliusCooldownUntil = 0;
	heliusQuotaTrips = 0;
	_warnedAt.clear();
}

async function fetchJson(url, opts = {}) {
	// A sick upstream (Helius/public RPC, Jupiter, CoinGecko, pump.fun) must never
	// hang the holder-gate / pricing path indefinitely — bound every request to 6s
	// unless the caller already supplied its own AbortSignal. A timeout rejects, so
	// solRpc()'s Helius→public-RPC failover and the price helpers' try/catch each
	// degrade rather than stall the whole portfolio read.
	const signal = opts.signal ?? AbortSignal.timeout(6000);
	const r = await fetch(url, { ...opts, signal });
	if (!r.ok) {
		const text = await r.text().catch(() => r.status.toString());
		throw Object.assign(new Error(`upstream ${r.status}: ${text}`), { status: 502 });
	}
	return r.json();
}

async function solRpc(body, { allowFallback = true } = {}) {
	const helius = heliusRpc();
	// Skip Helius entirely while its quota is known-exhausted (breaker open) — no
	// doomed round-trip, no per-request warning. When fallback isn't allowed the
	// caller explicitly wants Helius, so we still try (and surface) it.
	if (helius && (allowFallback ? heliusAvailable() : true)) {
		try {
			return await fetchJson(helius, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
		} catch (err) {
			if (!allowFallback) throw err;
			if (isQuotaError(err)) tripHeliusCooldown(err, 'helius:quota');
			else warnThrottled('helius:fail', `[balances] helius failed, falling back to public RPC: ${err?.message}`);
		}
	}
	// Try each public RPC in turn — one endpoint's 404/403/429 under load must not
	// fail the whole read. Only when every fallback is exhausted do we throw.
	let lastErr;
	for (const url of PUBLIC_SOL_RPCS) {
		try {
			return await fetchJson(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr ?? Object.assign(new Error('no Solana RPC configured'), { status: 502 });
}

// -- Solana price helpers --

async function jupiterPrices(mints) {
	if (mints.length === 0) return {};
	const out = {};
	// Jupiter caps each request at ~100 ids
	for (let i = 0; i < mints.length; i += 100) {
		const chunk = mints.slice(i, i + 100).join(',');
		try {
			const data = await fetchJson(`https://lite-api.jup.ag/price/v3?ids=${chunk}`);
			if (data && typeof data === 'object') Object.assign(out, data);
		} catch (err) {
			console.warn('[balances] jupiter price chunk failed:', err?.message);
		}
	}
	return out;
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Native SOL/USD spot. Delegates to the canonical 7-source failover in
// api/_lib/sol-price.js (Jupiter/CoinGecko + Kraken/Coinbase/Bitfinex/DefiLlama/
// DIA), 60s-cached. Returns 0 when every source is exhausted — same "unpriced"
// contract the token-price path relies on.
async function solNativePrice() {
	return solPriceUsd();
}

/**
 * Pick a token's USD price, preferring a positive on-chain price (Helius
 * `price_info`) and otherwise falling back to Jupiter.
 *
 * A Helius price of exactly 0 means "Helius couldn't price this", NOT "free" —
 * so it must never suppress the Jupiter fallback. The previous `helius ?? jup`
 * did exactly that: `0 ?? jup` is `0` (nullish coalescing keeps the 0), which
 * zeroed out every coin Helius returned a 0 for (common for low-liquidity
 * pump.fun coins that Jupiter prices fine). That silently mis-valued holdings
 * to $0 — and broke the /play holder gate, which reads these USD values.
 */
export function pickTokenPrice(heliusPrice, jupiterPrice) {
	const helius = Number(heliusPrice) || 0;
	if (helius > 0) return helius;
	return Number(jupiterPrice) || 0;
}

/**
 * USD price for one pump.fun coin straight from its bonding curve / market cap.
 * price = usd_market_cap / circulating supply. Covers coins Jupiter can't route
 * yet (pre-graduation, very fresh) — exactly the long tail the holder gate must
 * price correctly. Returns 0 when pump.fun has no data for the mint (not a pump
 * coin, or no price yet).
 */
async function pumpFunMintUsd(mint) {
	const c = await fetchJson(new URL(`/coins/${mint}`, PUMP_FRONTEND_BASE).toString(), {
		headers: { accept: 'application/json' },
	});
	const mcap = Number(c?.usd_market_cap) || 0;
	const decimals = Number(c?.base_decimals ?? 6);
	const supply = Number(c?.total_supply_str || c?.total_supply) || 0;
	if (mcap > 0 && supply > 0) {
		const circulating = supply / Math.pow(10, decimals);
		if (circulating > 0) return mcap / circulating;
	}
	return 0;
}

/**
 * Authoritative USD price for a single Solana mint, independent of any wallet.
 * Jupiter Lite first (routable tokens, incl. graduated pump.fun coins), then the
 * pump.fun bonding curve (pre-graduation coins Jupiter doesn't price yet).
 * Returns 0 only when neither source can price the mint.
 */
export async function solanaMintUsdPrice(mint) {
	try {
		const data = await fetchJson(`https://lite-api.jup.ag/price/v3?ids=${mint}`);
		const p = Number(data?.[mint]?.usdPrice ?? data?.[mint]?.price) || 0;
		if (p > 0) return p;
	} catch (err) {
		console.warn('[balances] jupiter single-mint price failed:', err?.message);
	}
	try {
		const p = await pumpFunMintUsd(mint);
		if (p > 0) return p;
	} catch (err) {
		console.warn('[balances] pump.fun price fallback failed:', err?.message);
	}
	return 0;
}

// -- Solana balance path: Helius DAS getAssetsByOwner --

async function getSolanaBalancesViaDas(address) {
	const helius = heliusRpc();
	if (!helius) return null; // signal caller to take fallback path
	// Quota exhausted recently — don't even attempt DAS; take the public-RPC
	// fallback straight away. DAS is Helius-only, so a doomed call here just burns
	// latency and re-warns.
	if (!heliusAvailable()) return null;

	let allItems = [];
	let nativeLamports = 0;
	let page = 1;
	// Helius paginates at 1000/page; loop until empty.
	while (page < 6) {
		const resp = await fetchJson(helius, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 'getAssetsByOwner',
				method: 'getAssetsByOwner',
				params: {
					ownerAddress: address,
					page,
					limit: 1000,
					displayOptions: { showFungible: true, showNativeBalance: true },
				},
			}),
		});
		const result = resp?.result;
		if (!result) break;
		if (page === 1 && result.nativeBalance) {
			nativeLamports = Number(result.nativeBalance.lamports || 0);
		}
		const items = Array.isArray(result.items) ? result.items : [];
		allItems = allItems.concat(items);
		if (items.length < 1000) break;
		page += 1;
	}

	const fungible = allItems
		.filter((a) => a?.interface === 'FungibleToken' || a?.interface === 'FungibleAsset' || a?.token_info)
		.map((a) => {
			const ti = a.token_info || {};
			const decimals = ti.decimals ?? 0;
			const rawBalance = Number(ti.balance || 0);
			if (!rawBalance) return null;
			const amount = rawBalance / Math.pow(10, decimals);
			const md = a?.content?.metadata || {};
			const symbol = ti.symbol || md.symbol || a.id.slice(0, 6);
			const name = md.name || symbol;
			const logo = a?.content?.links?.image || a?.content?.files?.[0]?.uri || null;
			const priceFromHelius = ti.price_info?.price_per_token ?? null;
			return { mint: a.id, decimals, amount, symbol, name, logo, priceFromHelius };
		})
		.filter(Boolean)
		.filter((t) => t.amount > 0);

	// Persist metadata for everything we just resolved so other callers
	// (which may not use DAS) can hit cache instead of re-fetching.
	const metaPayload = fungible.map((t) => ({
		mint: t.mint,
		symbol: t.symbol,
		name: t.name,
		logo: t.logo,
		decimals: t.decimals,
	}));
	if (metaPayload.length > 0) {
		// Fire-and-forget — never block balance response on cache write.
		import('./token-metadata.js')
			.then((mod) => mod.getMetadataForMints([])) // ensure module loaded
			.catch(() => {});
		// Direct write (cheaper than going through getMetadataForMints):
		try {
			const { sql, sqlValues } = await import('./db.js');
			const now = new Date();
			const rows = metaPayload.map((m) => [
				m.mint,
				'solana',
				m.symbol,
				m.name,
				m.logo,
				m.decimals,
				'helius-das',
				now,
			]);
			await sql`
				INSERT INTO token_metadata (mint, chain, symbol, name, logo, decimals, source, refreshed_at)
				VALUES ${sqlValues(rows)}
				ON CONFLICT (mint) DO UPDATE SET
					symbol = EXCLUDED.symbol,
					name = EXCLUDED.name,
					logo = EXCLUDED.logo,
					decimals = EXCLUDED.decimals,
					refreshed_at = EXCLUDED.refreshed_at
			`;
		} catch (err) {
			console.warn('[balances] token_metadata persist failed:', err?.message);
		}
	}

	// Prices: trust Helius price_info first, fall back to Jupiter for any gaps.
	const missingPrice = fungible.filter((t) => !t.priceFromHelius).map((t) => t.mint);
	const jupPrices = missingPrice.length > 0 ? await jupiterPrices(missingPrice) : {};
	const solUsd = await solNativePrice();

	const tokens = fungible
		.map((t) => {
			const price = pickTokenPrice(
				t.priceFromHelius,
				jupPrices?.[t.mint]?.usdPrice ?? jupPrices?.[t.mint]?.price,
			);
			return {
				symbol: t.symbol,
				name: t.name,
				mint: t.mint,
				decimals: t.decimals,
				amount: t.amount,
				price,
				change24h: null,
				usd: t.amount * price,
				logo: t.logo,
			};
		})
		.sort((a, b) => (b.usd || 0) - (a.usd || 0));

	return {
		chain: 'solana',
		address,
		native: {
			symbol: 'SOL',
			name: 'Solana',
			amount: nativeLamports / 1e9,
			price: solUsd,
			change24h: null,
			usd: (nativeLamports / 1e9) * solUsd,
		},
		tokens,
	};
}

// -- Solana balance fallback: plain RPC + DB metadata cache --

async function getSolanaBalancesFallback(address) {
	const solResp = await solRpc({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] });
	const lamports = solResp.result?.value ?? 0;
	const solAmount = lamports / 1e9;

	const tokenResp = await solRpc({
		jsonrpc: '2.0',
		id: 2,
		method: 'getTokenAccountsByOwner',
		params: [
			address,
			{ programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
			{ encoding: 'jsonParsed' },
		],
	});

	const tokenAccounts = tokenResp.result?.value ?? [];
	const fungible = tokenAccounts
		.map((a) => {
			const info = a.account?.data?.parsed?.info;
			if (!info) return null;
			const { mint, tokenAmount } = info;
			if (!tokenAmount || !tokenAmount.uiAmount || tokenAmount.uiAmount === 0) return null;
			return { mint, amount: tokenAmount.uiAmount, decimals: tokenAmount.decimals };
		})
		.filter(Boolean);

	const mints = fungible.map((t) => t.mint);
	const [metadata, jupPrices, solUsd] = await Promise.all([
		getMetadataForMints(mints),
		jupiterPrices(mints),
		solNativePrice(),
	]);

	const tokens = fungible
		.map((t) => {
			const md = metadata.get(t.mint) || {};
			const priceInfo = jupPrices?.[t.mint] || {};
			const price = Number(priceInfo.usdPrice ?? priceInfo.price ?? 0);
			return {
				symbol: md.symbol || t.mint.slice(0, 6),
				name: md.name || md.symbol || t.mint.slice(0, 6),
				mint: t.mint,
				decimals: t.decimals,
				amount: t.amount,
				price,
				change24h: null,
				usd: t.amount * price,
				logo: md.logo || null,
			};
		})
		.sort((a, b) => (b.usd || 0) - (a.usd || 0));

	return {
		chain: 'solana',
		address,
		native: {
			symbol: 'SOL',
			name: 'Solana',
			amount: solAmount,
			price: solUsd,
			change24h: null,
			usd: solAmount * solUsd,
		},
		tokens,
	};
}

async function getSolanaBalances(address) {
	try {
		const viaDas = await getSolanaBalancesViaDas(address);
		if (viaDas) return viaDas;
	} catch (err) {
		// A quota error trips the breaker so subsequent reads skip Helius outright
		// rather than re-discovering the exhausted quota one doomed call at a time.
		if (isQuotaError(err)) tripHeliusCooldown(err, 'das:quota');
		else warnThrottled('das:fail', `[balances] DAS path failed, using fallback: ${err?.message}`);
	}
	return getSolanaBalancesFallback(address);
}

// -- EVM (Alchemy) — unchanged behavior, kept on CoinGecko since Jupiter is Solana-only --

async function getEvmBalances(address) {
	const alchemyKey = process.env.ALCHEMY_API_KEY;
	if (!alchemyKey) {
		const e = new Error('not_configured: ALCHEMY_API_KEY');
		e.status = 503;
		e.code = 'not_configured';
		e.missing = 'ALCHEMY_API_KEY';
		throw e;
	}

	const rpcUrl = `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`;

	const ethBalResp = await fetchJson(rpcUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'eth_getBalance',
			params: [address, 'latest'],
		}),
	});
	const ethWei = BigInt(ethBalResp.result ?? '0x0');
	const ethAmount = Number(ethWei) / 1e18;

	const tokenBalResp = await fetchJson(rpcUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 2,
			method: 'alchemy_getTokenBalances',
			params: [address],
		}),
	});

	const rawTokens = (tokenBalResp.result?.tokenBalances ?? []).filter(
		(t) => t.tokenBalance && t.tokenBalance !== '0x0' && t.tokenBalance !== '0x',
	);

	const metadataResults = await Promise.allSettled(
		rawTokens.map((t) =>
			fetchJson(rpcUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 'meta',
					method: 'alchemy_getTokenMetadata',
					params: [t.contractAddress],
				}),
			}),
		),
	);

	const cgTokenPrices = {};
	for (let i = 0; i < rawTokens.length; i += 80) {
		const chunk = rawTokens.slice(i, i + 80).map((t) => t.contractAddress).join(',');
		try {
			const part = await fetchJson(
				`https://api.coingecko.com/api/v3/simple/token_price/ethereum?contract_addresses=${chunk}&vs_currencies=usd&include_24hr_change=true`,
			);
			Object.assign(cgTokenPrices, part);
		} catch {
			// best-effort
		}
	}

	let ethUsdPrice = 0;
	let ethChange24h = 0;
	try {
		const cgEth = await fetchJson(
			'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&include_24hr_change=true',
		);
		ethUsdPrice = cgEth?.ethereum?.usd ?? 0;
		ethChange24h = cgEth?.ethereum?.usd_24h_change ?? 0;
	} catch {
		// best-effort
	}

	const tokens = rawTokens.map((t, i) => {
		const meta = metadataResults[i].status === 'fulfilled' ? metadataResults[i].value?.result : null;
		const decimals = meta?.decimals ?? 18;
		const rawBal = BigInt(t.tokenBalance || '0x0');
		const amount = Number(rawBal) / Math.pow(10, decimals);
		const priceInfo = cgTokenPrices[t.contractAddress.toLowerCase()] || {};
		const price = priceInfo.usd ?? 0;
		const change24h = priceInfo.usd_24h_change ?? null;
		return {
			symbol: meta?.symbol || t.contractAddress.slice(0, 8),
			name: meta?.name || meta?.symbol || t.contractAddress.slice(0, 8),
			contract: t.contractAddress,
			decimals,
			amount,
			price,
			change24h,
			usd: amount * price,
			logo: meta?.logo || null,
		};
	});

	tokens.sort((a, b) => (b.usd || 0) - (a.usd || 0));
	return {
		chain: 'evm',
		address,
		native: {
			symbol: 'ETH',
			name: 'Ethereum',
			amount: ethAmount,
			price: ethUsdPrice,
			change24h: ethChange24h,
			usd: ethAmount * ethUsdPrice,
		},
		tokens,
	};
}

export async function getBalances({ chain, address }) {
	const key = `bal:${chain}:${address}`;
	const cached = await cacheGet(key);
	if (cached) return cached;
	const lkgKey = `bal:lkg:${chain}:${address}`;
	try {
		const value = chain === 'solana' ? await getSolanaBalances(address) : await getEvmBalances(address);
		await cacheSet(key, value, BALANCES_TTL_S);
		// Durable last-known-good so a transient upstream outage serves the wallet's
		// real prior balances (flagged stale) instead of a 502.
		await cacheSet(lkgKey, value, BALANCES_LKG_TTL_S);
		return value;
	} catch (err) {
		// Stale-on-error: every live RPC path failed. Serve the last-known-good
		// snapshot tagged `stale` so the caller holds the wallet's last real look.
		// Only a wallet we have never read successfully re-throws.
		const lkg = await cacheGet(lkgKey);
		if (lkg) return { ...lkg, stale: true };
		throw err;
	}
}

export async function invalidateBalances({ chain, address }) {
	await cacheDel(`bal:${chain}:${address}`);
}

export function walletUsdTotal(balances) {
	const nativeUsd = balances?.native?.usd ?? 0;
	const tokensUsd = (balances?.tokens ?? []).reduce((s, t) => s + (t.usd ?? 0), 0);
	return nativeUsd + tokensUsd;
}
