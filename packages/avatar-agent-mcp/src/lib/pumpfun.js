// pump.fun + on-chain snapshot data. Pulls live numbers from public APIs
// and the Solana RPC. No fallbacks, no mocked numbers — if a source is
// unreachable the field is null so callers see the gap clearly.
//
// Sources:
//   - Jupiter Lite price API (lite-api.jup.ag/price/v3)
//   - Dexscreener tokens API (api.dexscreener.com/latest/dex/tokens/<mint>)
//   - pump.fun frontend-api-v3 (frontend-api-v3.pump.fun/coins/<mint>)
//   - Solana getTokenLargestAccounts via the configured RPC
//   - Optional Helius DAS getAsset (HELIUS_API_KEY)

import { Connection, PublicKey } from '@solana/web3.js';

import { HELIUS_API_KEY, SOLANA_RPC_URL } from '../config.js';

async function fetchJson(url, init = {}, timeoutMs = 8000) {
	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, { ...init, signal: controller.signal });
		if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
		return await res.json();
	} finally {
		clearTimeout(t);
	}
}

export async function getJupiterPrice(mint) {
	try {
		const data = await fetchJson(`https://lite-api.jup.ag/price/v3?ids=${mint}`);
		const entry = data?.[mint];
		if (!entry) return null;
		return {
			usdPrice: entry.usdPrice ?? null,
			priceChange24hPct: entry.priceChange24h ?? null,
			liquidityUsd: entry.liquidity ?? null,
			decimals: entry.decimals ?? null,
			blockId: entry.blockId ?? null,
		};
	} catch (err) {
		return { error: err.message };
	}
}

export async function getDexscreener(mint) {
	try {
		const data = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
		const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
		if (pairs.length === 0) return null;
		const pair = pairs.reduce((best, p) => {
			const v = Number(p?.volume?.h24 || 0);
			return v > (best?.vol || 0) ? { pair: p, vol: v } : best;
		}, null)?.pair;
		if (!pair) return null;
		return {
			volume24hUsd: Number(pair.volume?.h24 || 0),
			priceUsd: pair.priceUsd ? Number(pair.priceUsd) : null,
			priceChange24hPct: pair.priceChange?.h24 ?? null,
			liquidityUsd: pair.liquidity?.usd ?? null,
			fdvUsd: pair.fdv ?? null,
			marketCapUsd: pair.marketCap ?? null,
			pairAddress: pair.pairAddress,
			dex: pair.dexId,
			chain: pair.chainId,
			url: pair.url,
			txns24h: pair.txns?.h24 ?? null,
		};
	} catch (err) {
		return { error: err.message };
	}
}

export async function getPumpFunMeta(mint) {
	try {
		const data = await fetchJson(`https://frontend-api-v3.pump.fun/coins/${mint}`);
		if (!data || data.error) return null;
		return {
			name: data.name || null,
			symbol: data.symbol || null,
			description: data.description || null,
			imageUrl: data.image_uri || null,
			twitter: data.twitter || null,
			telegram: data.telegram || null,
			website: data.website || null,
			creator: data.creator || null,
			createdAtMs: data.created_timestamp || null,
			complete: !!data.complete,
			marketCapUsd: data.usd_market_cap ?? null,
			marketCapQuote: data.market_cap ?? null,
			totalSupply: data.total_supply_str || data.total_supply || null,
			poolAddress: data.pool_address || null,
			lastTradeTimestampMs: data.last_trade_timestamp || null,
			athMarketCapUsd: data.ath_market_cap ?? null,
			athMarketCapTimestampMs: data.ath_market_cap_timestamp || null,
			program: data.program || null,
		};
	} catch (err) {
		return { error: err.message };
	}
}

export async function getTopHolders(mint) {
	try {
		const conn = new Connection(SOLANA_RPC_URL, 'confirmed');
		const res = await conn.getTokenLargestAccounts(new PublicKey(mint));
		const top = (res?.value || []).map((acct) => ({
			address: acct.address.toBase58(),
			uiAmount: acct.uiAmount,
			amount: acct.amount,
			decimals: acct.decimals,
		}));
		return {
			topHolderCount: top.length,
			topHolders: top,
		};
	} catch (err) {
		return { error: err.message };
	}
}

export async function getHeliusInfo(mint) {
	if (!HELIUS_API_KEY) return null;
	try {
		const url = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
		const body = {
			jsonrpc: '2.0',
			id: 'getAsset',
			method: 'getAsset',
			params: { id: mint, options: { showFungible: true } },
		};
		const data = await fetchJson(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		const supply = data?.result?.token_info?.supply ?? null;
		const decimals = data?.result?.token_info?.decimals ?? null;
		const priceInfo = data?.result?.token_info?.price_info ?? null;
		return {
			supply: supply !== null ? String(supply) : null,
			decimals,
			heliusPriceUsd: priceInfo?.price_per_token ?? null,
		};
	} catch (err) {
		return { error: err.message };
	}
}

export async function snapshot(mint) {
	const [price, ds, meta, holders, helius] = await Promise.all([
		getJupiterPrice(mint),
		getDexscreener(mint),
		getPumpFunMeta(mint),
		getTopHolders(mint),
		getHeliusInfo(mint),
	]);
	return {
		token: mint,
		fetchedAt: new Date().toISOString(),
		price,
		volume24h: ds,
		meta,
		holders,
		helius,
		image: meta?.imageUrl || null,
		pumpUrl: `https://pump.fun/coin/${mint}`,
		sources: {
			price: 'https://lite-api.jup.ag/price/v3',
			volume24h: 'https://api.dexscreener.com',
			meta: 'https://frontend-api-v3.pump.fun',
			holders: SOLANA_RPC_URL,
			helius: HELIUS_API_KEY ? 'https://mainnet.helius-rpc.com' : null,
		},
	};
}
