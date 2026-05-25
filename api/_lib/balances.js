// Live on-chain balance + USD-price helpers, shared by /api/wallet/balances and
// /api/portfolio. Server-side memoizes results per (chain, address) for 60s to
// shield upstream RPCs and CoinGecko from per-page-load fan-out.

const RPC_CACHE_TTL_MS = 60_000;
const _cache = new Map(); // key: `${chain}:${address}` → { at, value }

function cacheGet(key) {
	const hit = _cache.get(key);
	if (!hit) return null;
	if (Date.now() - hit.at > RPC_CACHE_TTL_MS) {
		_cache.delete(key);
		return null;
	}
	return hit.value;
}
function cacheSet(key, value) {
	_cache.set(key, { at: Date.now(), value });
}

async function fetchJson(url, opts = {}) {
	const r = await fetch(url, opts);
	if (!r.ok) {
		const text = await r.text().catch(() => r.status.toString());
		throw Object.assign(new Error(`upstream ${r.status}: ${text}`), { status: 502 });
	}
	return r.json();
}

// Helius primary, public mainnet-beta fallback. Helius is required for `getAsset`
// (DAS) — token metadata silently degrades when we fall back, but balances still
// resolve, which is better than 503ing the whole portfolio when Helius is rate-
// limited or out of credits.
const PUBLIC_SOL_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
function heliusRpc() {
	const key = process.env.HELIUS_API_KEY;
	return key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : null;
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

async function getSolanaBalances(address) {
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
		.filter(Boolean)
		.sort((a, b) => b.amount - a.amount);

	// CoinGecko caps each request at ~100 contract addresses; chunk to stay safe.
	const cgTokenPrices = {};
	for (let i = 0; i < fungible.length; i += 80) {
		const chunk = fungible.slice(i, i + 80).map((t) => t.mint).join(',');
		try {
			const part = await fetchJson(
				`https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${chunk}&vs_currencies=usd&include_24hr_change=true`,
			);
			Object.assign(cgTokenPrices, part);
		} catch {
			// best-effort
		}
	}

	let solUsdPrice = 0;
	let solChange24h = 0;
	try {
		const cgSol = await fetchJson(
			'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true',
		);
		solUsdPrice = cgSol?.solana?.usd ?? 0;
		solChange24h = cgSol?.solana?.usd_24h_change ?? 0;
	} catch {
		// best-effort
	}

	// DAS metadata (getAsset) is Helius-only — skip entirely if no key, since
	// public mainnet-beta returns "method not found" for every mint.
	const helius = heliusRpc();
	const metaResults = helius
		? await Promise.all(
				fungible.map((t) =>
					fetchJson(helius, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							jsonrpc: '2.0',
							id: 'meta',
							method: 'getAsset',
							params: { id: t.mint },
						}),
					}).catch(() => null),
				),
			)
		: fungible.map(() => null);

	const tokens = fungible.map((t, i) => {
		const priceInfo = cgTokenPrices[t.mint.toLowerCase()] || cgTokenPrices[t.mint] || {};
		const price = priceInfo.usd ?? 0;
		const change24h = priceInfo.usd_24h_change ?? null;
		const das = metaResults[i];
		const symbol = das?.result?.content?.metadata?.symbol || t.mint.slice(0, 6);
		const name = das?.result?.content?.metadata?.name || symbol;
		const logo = das?.result?.content?.links?.image || null;
		return {
			symbol,
			name,
			mint: t.mint,
			decimals: t.decimals,
			amount: t.amount,
			price,
			change24h,
			usd: t.amount * price,
			logo,
		};
	});

	tokens.sort((a, b) => (b.usd || 0) - (a.usd || 0));
	return {
		chain: 'solana',
		address,
		native: {
			symbol: 'SOL',
			name: 'Solana',
			amount: solAmount,
			price: solUsdPrice,
			change24h: solChange24h,
			usd: solAmount * solUsdPrice,
		},
		tokens,
	};
}

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

	const rawTokens = (tokenBalResp.result?.tokenBalances ?? [])
		.filter((t) => t.tokenBalance && t.tokenBalance !== '0x0' && t.tokenBalance !== '0x');

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
	const key = `${chain}:${address}`;
	const cached = cacheGet(key);
	if (cached) return cached;
	const value = chain === 'solana' ? await getSolanaBalances(address) : await getEvmBalances(address);
	cacheSet(key, value);
	return value;
}

export function invalidateBalances({ chain, address }) {
	_cache.delete(`${chain}:${address}`);
}

export function walletUsdTotal(balances) {
	const nativeUsd = balances?.native?.usd ?? 0;
	const tokensUsd = (balances?.tokens ?? []).reduce((s, t) => s + (t.usd ?? 0), 0);
	return nativeUsd + tokensUsd;
}
