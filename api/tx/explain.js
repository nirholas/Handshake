import { Interface } from 'ethers';
import { env } from '../_lib/env.js';
import { wrap, cors, error, json, readJson, method, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { llmComplete, llmConfigured } from '../_lib/llm.js';
import { cacheGet, cacheSet } from '../_lib/cache.js';
import { solanaConnection } from '../_lib/solana/connection.js';

// Reduce a raw parsed transaction to the same shape Helius's enhanced endpoint
// returns, so the fallback path is transparent to the LLM summary and the UI.
// Native transfers come from lamport balance deltas; token transfers from the
// pre/post SPL token balances in the tx meta. No `description`/`type` (those are
// Helius value-adds) — the LLM summary fills that role downstream.
function parsedTxToExplain(tx) {
	if (!tx) return null;
	const meta = tx.meta || {};
	const keys = (tx.transaction?.message?.accountKeys || []).map((k) =>
		typeof k === 'string' ? k : k?.pubkey?.toString?.() ?? String(k?.pubkey ?? ''),
	);

	const nativeTransfers = [];
	const pre = meta.preBalances || [];
	const post = meta.postBalances || [];
	for (let i = 0; i < keys.length; i++) {
		const delta = (post[i] ?? 0) - (pre[i] ?? 0);
		if (delta !== 0) nativeTransfers.push({ account: keys[i], amount: delta });
	}

	const byKey = (arr) => {
		const m = new Map();
		for (const b of arr || []) m.set(`${b.accountIndex}:${b.mint}`, b);
		return m;
	};
	const preTok = byKey(meta.preTokenBalances);
	const postTok = byKey(meta.postTokenBalances);
	const tokenTransfers = [];
	for (const k of new Set([...preTok.keys(), ...postTok.keys()])) {
		const p = preTok.get(k);
		const q = postTok.get(k);
		const delta = BigInt(q?.uiTokenAmount?.amount ?? '0') - BigInt(p?.uiTokenAmount?.amount ?? '0');
		if (delta === 0n) continue;
		const ref = q || p;
		tokenTransfers.push({
			mint: ref.mint,
			owner: ref.owner || null,
			rawTokenAmount: { tokenAmount: delta.toString(), decimals: ref.uiTokenAmount?.decimals ?? null },
		});
	}

	return {
		tokenTransfers,
		nativeTransfers,
		description: '',
		type: '',
		feePayer: keys[0] || '',
		source: 'rpc-fallback',
	};
}

// A confirmed transaction is immutable, but the Helius enhanced-tx (/v0) and
// Alchemy RPC calls behind this endpoint — plus the LLM summary — were recomputed
// on every request, so re-explaining the same signature paid all three each time.
// Cache the finished explanation by chain:sig; a hit serves with zero upstream cost.
const EXPLAIN_TTL_SECONDS = 24 * 60 * 60; // 24h

const ERC20_TRANSFER_TOPIC =
	'0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const erc20Iface = new Interface([
	'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export default wrap(async (req, res) => {
	if (cors(req, res)) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try {
		body = await readJson(req);
	} catch (err) {
		return error(res, err.status ?? 400, 'bad_request', err.message);
	}

	const chain = String(body.chain || '').toLowerCase();
	const sig = String(body.sig || '').trim();

	if (!['solana', 'evm'].includes(chain)) {
		return error(res, 400, 'bad_request', 'chain must be solana or evm');
	}
	if (!sig) return error(res, 400, 'bad_request', 'sig required');
	// Validate the signature shape before forwarding to a keyed upstream so a
	// malformed value is rejected here, not bounced through Helius/Alchemy.
	if (chain === 'solana' && !/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(sig)) {
		return error(res, 400, 'bad_request', 'sig must be a base58 transaction signature');
	}
	if (chain === 'evm' && !/^0x[0-9a-fA-F]{64}$/.test(sig)) {
		return error(res, 400, 'bad_request', 'sig must be a 0x-prefixed 32-byte tx hash');
	}

	const cacheKey = `tx-explain:${chain}:${sig}`;
	const cachedExplain = await cacheGet(cacheKey).catch(() => null);
	if (cachedExplain) return json(res, 200, cachedExplain);

	// Only a cache MISS reaches the billed enhanced-tx upstream — gate that on the
	// shared DAS cost ceiling so a bot explaining thousands of distinct signatures
	// can't run up the Helius bill past a fixed hourly cap.
	const ceiling = await limits.heliusDasGlobal();
	if (!ceiling.success) return rateLimited(res, ceiling);

	let txData;

	if (chain === 'solana') {
		// Primary: Helius enhanced /v0 (rich description + type). On any upstream
		// failure, fall back to getParsedTransaction over the rotating multi-provider
		// RPC chain (Helius → Alchemy → Ankr → PublicNode → public) and reconstruct
		// the transfer shape ourselves — so a Helius outage still explains the tx.
		let enhanced = null;
		try {
			const resp = await fetch(
				`https://api.helius.xyz/v0/transactions/?api-key=${env.HELIUS_API_KEY}`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ transactions: [sig] }),
				},
			);
			if (resp.ok) {
				const data = await resp.json();
				if (Array.isArray(data) && data.length > 0) enhanced = data[0];
			} else {
				console.warn('[tx/explain] Helius enhanced %s — falling back to RPC', resp.status);
			}
		} catch (err) {
			console.warn('[tx/explain] Helius enhanced unreachable — falling back to RPC:', err?.message);
		}

		if (enhanced) {
			txData = {
				tokenTransfers: enhanced.tokenTransfers || [],
				nativeTransfers: enhanced.nativeTransfers || [],
				description: enhanced.description || '',
				type: enhanced.type || '',
				feePayer: enhanced.feePayer || '',
			};
		} else {
			let parsed = null;
			try {
				const conn = solanaConnection({ network: 'mainnet' });
				parsed = await conn.getParsedTransaction(sig, {
					maxSupportedTransactionVersion: 0,
					commitment: 'confirmed',
				});
			} catch (err) {
				console.error('[tx/explain] RPC fallback failed:', err?.message);
				return error(res, 502, 'upstream_error', 'transaction lookup failed upstream');
			}
			if (!parsed) {
				return error(res, 404, 'not_found', 'Transaction not found');
			}
			txData = parsedTxToExplain(parsed);
		}
	} else {
		// EVM failover chain: keyed Alchemy first, then an optional configured RPC,
		// then keyless public nodes — so an Alchemy outage or quota cap still
		// resolves the tx. Try each until one responds cleanly.
		const evmEndpoints = [
			env.ALCHEMY_API_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}` : null,
			env.MAINNET_RPC_URL || null,
			// Keyless, datacenter-reachable lanes. dRPC/1rpc lead (verified answering
			// from a serverless IP); publicnode last (403s from Vercel egress).
			// eth.llamarpc.com removed — its Cloudflare bot-wall 403s server-side POSTs.
			'https://eth.drpc.org',
			'https://1rpc.io/eth',
			'https://ethereum-rpc.publicnode.com',
		].filter(Boolean);

		const rpcAt = (url) => (id, methodName, params) =>
			fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', id, method: methodName, params }),
			});

		let txJson = null;
		let receiptJson = null;
		let lastErr = 'no endpoints configured';
		for (const url of evmEndpoints) {
			try {
				const rpc = rpcAt(url);
				const [txResp, receiptResp] = await Promise.all([
					rpc(1, 'eth_getTransactionByHash', [sig]),
					rpc(2, 'eth_getTransactionReceipt', [sig]),
				]);
				if (!txResp.ok || !receiptResp.ok) {
					lastErr = `status ${txResp.status}/${receiptResp.status}`;
					continue;
				}
				const [tj, rj] = await Promise.all([txResp.json(), receiptResp.json()]);
				if (tj.error) {
					lastErr = tj.error?.message || 'rpc error';
					continue;
				}
				// Clean response (result may legitimately be null for an unknown tx).
				txJson = tj;
				receiptJson = rj;
				break;
			} catch (err) {
				lastErr = err?.message || 'network error';
			}
		}

		if (!txJson) {
			console.error('[tx/explain] all EVM RPC endpoints failed:', lastErr);
			return error(res, 502, 'upstream_error', 'transaction lookup failed upstream');
		}
		if (!txJson.result) {
			return error(res, 404, 'not_found', 'Transaction not found');
		}

		const tx = txJson.result;
		const receipt = receiptJson?.result;
		const logs = [];
		for (const log of receipt?.logs || []) {
			if (log.topics[0] !== ERC20_TRANSFER_TOPIC) continue;
			try {
				const parsed = erc20Iface.parseLog({ topics: log.topics, data: log.data });
				logs.push({
					token: log.address,
					from: parsed.args[0],
					to: parsed.args[1],
					amount: parsed.args[2].toString(),
				});
			} catch {
				// skip logs that don't conform
			}
		}

		txData = {
			from: tx.from,
			to: tx.to,
			value: tx.value,
			logs,
		};
	}

	// Optional plain-English summary via the platform LLM chain (api/_lib/llm.js):
	// free providers first with full failover, so one rate-limited key doesn't
	// silently drop summaries platform-wide.
	if (llmConfigured()) {
		try {
			const { text } = await llmComplete({
				system: 'You summarize on-chain transactions in one concise plain-English paragraph.',
				user: `Summarize this on-chain ${chain} transaction in one plain-English paragraph. Be concise. Data: ${JSON.stringify(txData)}`,
				maxTokens: 200,
				timeoutMs: 10_000,
				track: { tool: 'tx.explain' },
			});
			if (text) txData.summary = text;
		} catch {
			// summary is optional — silently skip
		}
	}

	await cacheSet(cacheKey, txData, EXPLAIN_TTL_SECONDS).catch(() => {});
	return json(res, 200, txData);
});
