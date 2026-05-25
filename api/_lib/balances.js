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

const BALANCES_TTL_S = 60;

const PUBLIC_SOL_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
function heliusRpc() {
	const key = process.env.HELIUS_API_KEY;
	return key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : null;
}

async function fetchJson(url, opts = {}) {
	const r = await fetch(url, opts);
	if (!r.ok) {
		const text = await r.text().catch(() => r.status.toString());
		throw Object.assign(new Error(`upstream ${r.status}: ${text}`), { status: 502 });
	}
	return r.json();
}

async function solRpc(body, { allowFallback = true } = {}) {
	const helius = heliusRpc();
	if (helius) {
		try {
			return await fetchJson(helius, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
		} catch (err) {
			if (!allowFallback) throw err;
			console.warn('[balances] helius failed, falling back to public RPC:', err?.message);
		}
	}
	return fetchJson(PUBLIC_SOL_RPC, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
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

async function solNativePrice() {
	try {
		const data = await fetchJson(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`);
		const usd = data?.[SOL_MINT]?.usdPrice ?? data?.[SOL_MINT]?.price ?? 0;
		return Number(usd) || 0;
	} catch {
		try {
			const cg = await fetchJson(
				'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true',
			);
			return cg?.solana?.usd ?? 0;
		} catch {
			return 0;
		}
	}
}

// -- Solana balance path: Helius DAS getAssetsByOwner --

async function getSolanaBalancesViaDas(address) {
	const helius = heliusRpc();
	if (!helius) return null; // signal caller to take fallback path

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
			const { sql } = await import('./db.js');
			await sql`
				INSERT INTO token_metadata (mint, chain, symbol, name, logo, decimals, source, refreshed_at)
				SELECT * FROM ${sql(
					metaPayload.map((m) => [
						m.mint,
						'solana',
						m.symbol,
						m.name,
						m.logo,
						m.decimals,
						'helius-das',
						new Date(),
					]),
				)}
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
			const price =
				t.priceFromHelius ??
				Number(jupPrices?.[t.mint]?.usdPrice ?? jupPrices?.[t.mint]?.price ?? 0) ??
				0;
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
		console.warn('[balances] DAS path failed, using fallback:', err?.message);
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
	const value = chain === 'solana' ? await getSolanaBalances(address) : await getEvmBalances(address);
	await cacheSet(key, value, BALANCES_TTL_S);
	return value;
}

export async function invalidateBalances({ chain, address }) {
	await cacheDel(`bal:${chain}:${address}`);
}

export function walletUsdTotal(balances) {
	const nativeUsd = balances?.native?.usd ?? 0;
	const tokensUsd = (balances?.tokens ?? []).reduce((s, t) => s + (t.usd ?? 0), 0);
	return nativeUsd + tokensUsd;
}
