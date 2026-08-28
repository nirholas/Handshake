/**
 * Jupiter v6 swap integration — quote and swap any SPL token pair.
 * Uses the Jupiter REST API (no on-chain program calls needed for quoting).
 * Swap execution deserialises the versioned transaction and signs it with
 * the injected browser wallet (Phantom / Backpack / Solflare).
 */

import { createJupiterApiClient } from '@jup-ag/api';
import { detectSolanaWallet, SOLANA_RPC } from '../erc8004/solana-deploy.js';
import { fetchFirst } from '../shared/failover-fetch.js';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Jupiter consolidated quote-api.jup.ag/v6 and token.jup.ag onto lite-api.jup.ag;
// the old hosts now fail every request.
const JUPITER_API_URL = 'https://lite-api.jup.ag/swap/v1';
// Every source above returns an array of token records; only these four fields
// are read downstream, and a rung with none of them is treated as a miss so the
// chain moves on rather than caching an empty picker.
function normalizeTokenList(raw) {
	const rows = Array.isArray(raw) ? raw : [];
	const out = rows
		.map((t) => ({
			address: t?.address || t?.id || null,
			symbol: t?.symbol || '',
			name: t?.name || '',
			decimals: Number.isFinite(t?.decimals) ? t.decimals : 0,
		}))
		.filter((t) => t.address && t.symbol);
	return out.length ? out : null;
}

const JUPITER_TOKENS_URL = 'https://lite-api.jup.ag/tokens/v2/tag?query=verified';
const FETCH_TIMEOUT_MS = 10_000;
const QUOTE_TTL_MS = 15_000;

let _client = null;
function getClient() {
	if (!_client) _client = createJupiterApiClient({ basePath: JUPITER_API_URL });
	return _client;
}

async function loadWeb3() {
	const mod = await import('@solana/web3.js');
	return mod;
}

/**
 * Get a swap quote from Jupiter.
 *
 * @param {object}        opts
 * @param {string}        opts.inputMint    Base58 SPL mint (or WSOL_MINT for native SOL).
 * @param {string}        opts.outputMint   Base58 SPL mint.
 * @param {number}        opts.amountIn     Input amount in **UI units** (e.g. 1.5 for 1.5 SOL).
 * @param {number}        [opts.decimalsIn] Input token decimals (default 9 for SOL).
 * @param {number}        [opts.slippageBps] Default 50 (0.5%).
 * @returns {Promise<JupiterQuote>}
 */
export async function quoteJupiter({ inputMint, outputMint, amountIn, decimalsIn = 9, slippageBps = 50 }) {
	const rawAmount = Math.floor(amountIn * 10 ** decimalsIn);
	if (rawAmount <= 0) throw new Error('amountIn must be positive');

	const client = getClient();
	const quote = await client.quoteGet({
		inputMint,
		outputMint,
		amount: rawAmount,
		slippageBps,
		onlyDirectRoutes: false,
		asLegacyTransaction: false,
	});

	if (!quote) throw new Error('Jupiter returned no routes');

	return {
		inputMint,
		outputMint,
		inAmount: Number(quote.inAmount),
		outAmount: Number(quote.outAmount),
		priceImpactPct: Number(quote.priceImpactPct),
		slippageBps: quote.slippageBps,
		routePlan: quote.routePlan?.map((r) => r.swapInfo?.label).filter(Boolean),
		expiresAtMs: Date.now() + QUOTE_TTL_MS,
		_raw: quote,
	};
}

/**
 * Execute a Jupiter swap using the browser wallet.
 * Requires user approval — wallet will show a confirmation dialog.
 *
 * @param {JupiterQuote}  quote   Result of quoteJupiter().
 * @param {object}        [opts]
 * @param {boolean}       [opts.wrapUnwrapSOL=true]
 * @param {string}        [opts.network='mainnet']
 * @returns {Promise<{txid: string, inputMint: string, outputMint: string, outAmount: number}>}
 */
export async function executeJupiterSwap(quote, { wrapUnwrapSOL = true, network = 'mainnet' } = {}) {
	const wallet = detectSolanaWallet();
	if (!wallet) throw new Error('No Solana wallet found. Connect Phantom / Backpack / Solflare.');
	if (!wallet.publicKey) throw new Error('Wallet is not connected.');

	const client = getClient();
	const { web3 } = await loadWeb3().then((m) => ({ web3: m }));

	const { swapTransaction } = await client.swapPost({
		swapRequest: {
			quoteResponse: quote._raw,
			userPublicKey: wallet.publicKey.toString(),
			wrapAndUnwrapSol: wrapUnwrapSOL,
			dynamicComputeUnitLimit: true,
			prioritizationFeeLamports: 'auto',
		},
	});

	const txBuf = Buffer.from(swapTransaction, 'base64');
	const { VersionedTransaction, Connection } = await import('@solana/web3.js');
	const tx = VersionedTransaction.deserialize(txBuf);

	const rpcUrl = SOLANA_RPC[network] || SOLANA_RPC['mainnet'];
	const connection = new Connection(rpcUrl, 'confirmed');

	const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
	tx.message.recentBlockhash = blockhash;

	const signedTx = await wallet.signTransaction(tx);
	const rawTx = signedTx.serialize();

	const txid = await connection.sendRawTransaction(rawTx, { skipPreflight: false, maxRetries: 3 });
	await connection.confirmTransaction({ signature: txid, blockhash, lastValidBlockHeight }, 'confirmed');

	return {
		txid,
		inputMint: quote.inputMint,
		outputMint: quote.outputMint,
		outAmount: quote.outAmount,
	};
}

/**
 * Convenience: fetch token list from Jupiter (top tokens only, cached 5 min).
 * @returns {Promise<Array<{address: string, symbol: string, name: string, decimals: number}>>}
 */
let _tokenListCache = null;
let _tokenListTs = 0;
const TOKEN_LIST_TTL = 5 * 60_000;

export async function getJupiterTopTokens() {
	if (_tokenListCache && Date.now() - _tokenListTs < TOKEN_LIST_TTL) return _tokenListCache;
	// The token picker is unusable without a list, and Jupiter's lite host is one
	// box: fall through to its own mirror and then to the Solana Labs registry,
	// normalising each shape to the fields the picker reads.
	const list = await fetchFirst([
		{
			name: 'jup-lite',
			url: JUPITER_TOKENS_URL,
			parse: async (r) => normalizeTokenList(await r.json()),
		},
		{
			name: 'jup-tokens',
			url: 'https://tokens.jup.ag/tokens?tags=verified',
			parse: async (r) => normalizeTokenList(await r.json()),
		},
		{
			name: 'solana-labs',
			url: 'https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json',
			parse: async (r) => normalizeTokenList((await r.json())?.tokens),
		},
	], { timeoutMs: FETCH_TIMEOUT_MS, label: 'jupiter-token-list' });
	_tokenListCache = list;
	_tokenListTs = Date.now();
	return _tokenListCache;
}

/**
 * Resolve a token symbol (e.g. "SOL") to its mint address.
 * Returns null if not found.
 * @param {string} symbol
 * @returns {Promise<string|null>}
 */
export async function resolveTokenMint(symbol) {
	const tokens = await getJupiterTopTokens();
	const upper = symbol.toUpperCase();
	const match = tokens.find((t) => t.symbol.toUpperCase() === upper);
	return match?.address ?? null;
}
