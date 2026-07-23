// Wallet P&L analytics — FIFO cost-basis computation for a Solana wallet.
//
// Trade shape expected from any data source:
//   { type: 'buy'|'sell', mint: string, tokenAmount: number, solAmount: number,
//     usdPrice: number, timestamp: number }
//
// `usdPrice` is USD per SOL at the time of the trade.
// `tokenAmount` is in the token's smallest unit (or human-readable — caller must be consistent).

export const WINDOW_SECONDS = { '24h': 86400, '7d': 604800, '30d': 2592000, all: Infinity };

// Mutates `lots` in place. Returns realizedPnlUsd for this sell.
function consumeFifo(lots, sellTokens, proceedsUsd) {
	let remaining = sellTokens;
	let totalCost = 0;
	for (const lot of lots) {
		if (remaining <= 0) break;
		const take = Math.min(lot.tokens, remaining);
		const costPerToken = lot.tokens > 0 ? lot.costUsd / lot.tokens : 0;
		totalCost += take * costPerToken;
		lot.costUsd -= take * costPerToken;
		lot.tokens -= take;
		remaining -= take;
	}
	// Drop fully consumed lots.
	while (lots.length > 0 && lots[0].tokens <= 0) lots.shift();
	return proceedsUsd - totalCost;
}

/**
 * Pure FIFO P&L computation. Exported for unit testing.
 *
 * @param {{ trades: Array, currentPrices?: Object, windowSecs?: number }} opts
 * @returns {{ realizedUsd, unrealizedUsd, totalUsd, winRate, trades, volumeUsd, openPositions }}
 */
export function computeWalletPnl({ trades, currentPrices = {}, windowSecs = Infinity }) {
	const now = Date.now() / 1000;
	const cutoff = Number.isFinite(windowSecs) ? now - windowSecs : 0;

	const sorted = trades
		.filter((t) => t.timestamp >= cutoff)
		.sort((a, b) => a.timestamp - b.timestamp);

	// Per-mint FIFO lots { tokens, costUsd }
	const lots = {};
	let realizedUsd = 0;
	let closedTrades = 0;
	let winningTrades = 0;
	let volumeUsd = 0;

	for (const trade of sorted) {
		const { mint, type, tokenAmount, solAmount, usdPrice } = trade;
		const tradeUsd = solAmount * usdPrice;
		volumeUsd += tradeUsd;

		if (type === 'buy') {
			if (!lots[mint]) lots[mint] = [];
			lots[mint].push({ tokens: tokenAmount, costUsd: tradeUsd });
		} else if (type === 'sell') {
			if (!lots[mint] || lots[mint].length === 0) continue;
			const pnl = consumeFifo(lots[mint], tokenAmount, tradeUsd);
			realizedUsd += pnl;
			closedTrades++;
			if (pnl > 0) winningTrades++;
		}
	}

	// Unrealized P&L from open positions.
	let unrealizedUsd = 0;
	const openPositions = [];

	for (const [mint, mintLots] of Object.entries(lots)) {
		const active = mintLots.filter((l) => l.tokens > 0);
		if (active.length === 0) continue;
		const totalTokens = active.reduce((s, l) => s + l.tokens, 0);
		const totalCost = active.reduce((s, l) => s + l.costUsd, 0);
		const currentPrice = currentPrices[mint] ?? 0;
		const currentValueUsd = totalTokens * currentPrice;
		const unrealized = currentValueUsd - totalCost;
		unrealizedUsd += unrealized;
		openPositions.push({ mint, tokens: totalTokens, costUsd: totalCost, currentValueUsd, unrealizedUsd: unrealized });
	}

	const winRate = closedTrades > 0 ? winningTrades / closedTrades : 0;

	return {
		realizedUsd,
		unrealizedUsd,
		totalUsd: realizedUsd + unrealizedUsd,
		winRate,
		trades: sorted.length,
		volumeUsd,
		openPositions,
	};
}

// Attempts to load wallet trades from PUMPFUN_BOT_URL (server-side only).
// Returns [] when the bot is unavailable or the tool is not supported.
async function defaultFetchTrades(wallet) {
	const botUrl =
		typeof process !== 'undefined' ? (process.env?.PUMPFUN_BOT_URL ?? '') : '';
	if (!botUrl) return [];
	const headers = { 'content-type': 'application/json' };
	if (process.env?.PUMPFUN_BOT_TOKEN)
		headers.authorization = `Bearer ${process.env.PUMPFUN_BOT_TOKEN}`;
	try {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), 8000);
		const res = await fetch(botUrl.replace(/\/$/, ''), {
			method: 'POST',
			headers,
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'getWalletTrades', arguments: { wallet, limit: 500 } },
			}),
			signal: ctrl.signal,
		});
		clearTimeout(t);
		if (!res.ok) return [];
		const j = await res.json();
		const payload = j?.result?.structuredContent ?? j?.result?.content ?? [];
		return Array.isArray(payload) ? payload : [];
	} catch {
		return [];
	}
}

/**
 * @param {{ wallet: string, window?: string, _fetchTrades?: Function }} opts
 * @returns {Promise<{ wallet, window, realizedUsd, unrealizedUsd, totalUsd, winRate, trades, openPositions }>}
 */
export async function getWalletPnl({ wallet, window: win = '7d', _fetchTrades } = {}) {
	if (!wallet) throw new Error('wallet address is required');
	const windowSecs = WINDOW_SECONDS[win] ?? WINDOW_SECONDS['7d'];
	const fetchFn = _fetchTrades ?? defaultFetchTrades;
	const trades = await fetchFn(wallet, windowSecs);
	const result = computeWalletPnl({ trades, windowSecs });
	return { wallet, window: win, ...result };
}
