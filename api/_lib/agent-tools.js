// api/_lib/agent-tools.js - the server-executable tool registry for the
// general agent loop (/api/agent/run).
//
// Every tool here is READ-ONLY and runs entirely server-side over surfaces the
// platform already operates: CoinGecko through the cached geckoFetch lane,
// public Solana RPC through the failover connection, the trade firewall, the
// smart-money index, and SNS resolution. Nothing signs, sends, or mutates;
// fund-moving actions live client-side behind the wallet-approval modal and
// the /api/agent/guard preflight, and are deliberately NOT represented here.
//
// Shape: `name` and OpenAI function-calling `parameters` feed the model;
// `handler(args)` returns a JSON-serializable result. Handlers throw on bad
// input; the loop feeds the error back to the model as a tool error result.

import { geckoFetch } from './coingecko.js';
import { solanaPublicConnection } from './agent-pumpfun.js';
import { assessTradeSafety } from './trade-firewall.js';
import { getSmartMoneyForMint } from './smart-money.js';
import { resolveSnsName } from '../../src/solana/sns.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// The round-trip probe size the firewall simulates a buy+sell with when the
// caller has no live quote: 0.1 SOL, small enough to be simulable and large
// enough that a honeypot's sell trap shows.
const SAFETY_PROBE_LAMPORTS = 100_000_000;

function str(v, max = 200) {
	return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export const AGENT_TOOLS = {
	web_search: {
		description:
			'Search the web (DuckDuckGo instant answers). Returns an abstract and related topics. Use for general knowledge and current context; use the token tools for anything crypto-specific.',
		parameters: {
			type: 'object',
			properties: { query: { type: 'string', description: 'Search query' } },
			required: ['query'],
		},
		async handler(args) {
			const query = str(args?.query, 400);
			if (!query) throw new Error('query is required');
			const res = await fetch(
				`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`,
				{ signal: AbortSignal.timeout(8000) },
			);
			if (!res.ok) throw new Error(`search upstream ${res.status}`);
			const d = await res.json();
			return {
				abstract: d.AbstractText || '',
				source: d.AbstractURL || '',
				topics: (d.RelatedTopics || [])
					.map((t) => t.Text)
					.filter(Boolean)
					.slice(0, 5),
			};
		},
	},

	token_price: {
		description:
			'Live USD price, 24h change, and market cap for a crypto asset by name, symbol, or CoinGecko id (e.g. "solana", "SOL", "bitcoin").',
		parameters: {
			type: 'object',
			properties: { query: { type: 'string', description: 'Coin name, symbol, or CoinGecko id' } },
			required: ['query'],
		},
		async handler(args) {
			const query = str(args?.query, 100);
			if (!query) throw new Error('query is required');
			const search = await geckoFetch(`/search?query=${encodeURIComponent(query)}`);
			const coin = search?.coins?.[0];
			if (!coin?.id) return { found: false, query };
			const prices = await geckoFetch(
				`/simple/price?ids=${encodeURIComponent(coin.id)}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`,
			);
			const row = prices?.[coin.id] || {};
			return {
				found: true,
				id: coin.id,
				name: coin.name,
				symbol: coin.symbol,
				priceUsd: row.usd ?? null,
				change24hPct: row.usd_24h_change ?? null,
				marketCapUsd: row.usd_market_cap ?? null,
			};
		},
	},

	trending_tokens: {
		description: 'The crypto assets trending on CoinGecko right now (top searched, with rank and price in BTC).',
		parameters: { type: 'object', properties: {} },
		async handler() {
			const data = await geckoFetch('/search/trending');
			return {
				trending: (data?.coins || []).slice(0, 10).map(({ item }) => ({
					id: item?.id,
					name: item?.name,
					symbol: item?.symbol,
					marketCapRank: item?.market_cap_rank ?? null,
					priceBtc: item?.price_btc ?? null,
				})),
			};
		},
	},

	sol_balance: {
		description: 'Native SOL balance of a Solana wallet address (mainnet).',
		parameters: {
			type: 'object',
			properties: { address: { type: 'string', description: 'Base58 Solana wallet address' } },
			required: ['address'],
		},
		async handler(args) {
			const address = str(args?.address, 60);
			if (!BASE58_RE.test(address)) throw new Error('address must be a base58 Solana address');
			const { PublicKey } = await import('@solana/web3.js');
			const lamports = await solanaPublicConnection('mainnet').getBalance(
				new PublicKey(address),
				'confirmed',
			);
			return { address, lamports, sol: lamports / LAMPORTS_PER_SOL };
		},
	},

	token_safety: {
		description:
			'Rug/honeypot safety verdict for a Solana token mint from the three.ws trade firewall: allow/warn/block with per-check reasons. Simulates a small buy+sell round trip where possible.',
		parameters: {
			type: 'object',
			properties: {
				mint: { type: 'string', description: 'Base58 token mint address' },
				network: { type: 'string', enum: ['mainnet', 'devnet'], description: 'Default: mainnet' },
			},
			required: ['mint'],
		},
		async handler(args) {
			const mint = str(args?.mint, 60);
			if (!BASE58_RE.test(mint)) throw new Error('mint must be a base58 Solana address');
			const out = await assessTradeSafety({
				mint,
				network: args?.network === 'devnet' ? 'devnet' : 'mainnet',
				side: 'buy',
				quoteAmount: SAFETY_PROBE_LAMPORTS,
			});
			return {
				mint,
				verdict: out.verdict,
				score: out.score,
				simulated: out.simulated,
				reasons: out.reasons,
			};
		},
	},

	smart_money: {
		description:
			'Smart-money activity on a Solana token mint: how many tracked profitable wallets hold or recently traded it.',
		parameters: {
			type: 'object',
			properties: {
				mint: { type: 'string', description: 'Base58 token mint address' },
				network: { type: 'string', enum: ['mainnet', 'devnet'], description: 'Default: mainnet' },
			},
			required: ['mint'],
		},
		async handler(args) {
			const mint = str(args?.mint, 60);
			if (!BASE58_RE.test(mint)) throw new Error('mint must be a base58 Solana address');
			return getSmartMoneyForMint(mint, args?.network === 'devnet' ? 'devnet' : 'mainnet');
		},
	},

	resolve_sol_name: {
		description: 'Resolve a .sol name (SNS) to its owner wallet address.',
		parameters: {
			type: 'object',
			properties: { name: { type: 'string', description: 'SNS name, e.g. "toly.sol"' } },
			required: ['name'],
		},
		async handler(args) {
			const name = str(args?.name, 100);
			if (!name) throw new Error('name is required');
			const address = await resolveSnsName(name);
			return { name, address: address || null, resolved: Boolean(address) };
		},
	},
};

/** OpenAI function-calling schema array for the whole registry. */
export function agentToolSchemas() {
	return Object.entries(AGENT_TOOLS).map(([name, t]) => ({
		type: 'function',
		function: { name, description: t.description, parameters: t.parameters },
	}));
}

/** Handler map in the shape @three-ws/agent-runtime's call_tool executor expects. */
export function agentToolHandlers() {
	return Object.fromEntries(Object.entries(AGENT_TOOLS).map(([name, t]) => [name, t.handler]));
}
