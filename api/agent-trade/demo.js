// GET /api/agent-trade/demo — Server-Sent Events orchestrator for the
// agent-to-agent x402 trade demo.
//
// Autonomously drives the full buyer-agent flow, streaming events so the
// 3D scene can animate each step in real time:
//
//   init        → wallet addresses, balances, negotiated price
//   request     → Nexus (buyer) decides to call Oracle's skill
//   challenged  → Oracle responds with HTTP 402 price manifest
//   paying      → Nexus signs + broadcasts the SOL payment
//   confirmed   → on-chain tx hash + Solscan link
//   delivering  → Oracle's AI generating the analysis
//   delivered   → final market insight returned
//   error       → something went wrong (with actionable message)
//
// ?topic=<topic>   what the buyer wants analysis on (default: "crypto markets")
// ?check=1         returns JSON pre-flight status (not SSE) for config overlay

import {
	loadAvatarKeypair,
	getConnection,
	getSolBalance,
	sendSol,
	solUsdPrice,
	explorerTxUrl,
	LAMPORTS_PER_SOL,
} from '../_lib/avatar-wallet.js';
import { watsonxConfig, watsonxChatComplete } from '../_lib/watsonx.js';
import { llmComplete } from '../_lib/llm.js';
import { cors, method, json, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const DEFAULT_PRICE_SOL = 0.001;
const FEE_BUFFER_LAMPORTS = 15_000;

function loadWallet(envKey) {
	const secret = (process.env[envKey] || '').trim();
	if (!secret) return { configured: false };
	try {
		const keypair = loadAvatarKeypair(secret);
		return { configured: true, keypair, address: keypair.publicKey.toBase58() };
	} catch {
		return { configured: false };
	}
}

function tradeEnv() {
	const buyer = loadWallet('AGENT_BUYER_SECRET');
	const seller = loadWallet('AGENT_SELLER_SECRET');
	const network =
		(process.env.AGENT_TRADE_NETWORK || 'mainnet').toLowerCase() === 'devnet'
			? 'devnet'
			: 'mainnet';
	const rpcUrl =
		network === 'devnet'
			? process.env.SOLANA_RPC_URL_DEVNET || 'https://api.devnet.solana.com'
			: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
	const priceSol = Math.max(
		0.000001,
		parseFloat(process.env.AGENT_TRADE_PRICE_SOL || String(DEFAULT_PRICE_SOL)),
	);
	const priceLamports = Math.round(priceSol * LAMPORTS_PER_SOL);
	return { buyer, seller, network, rpcUrl, priceSol, priceLamports };
}

async function generateAnalysis(topic) {
	// Granite leads when configured, but a watsonx outage degrades to the
	// platform LLM chain below instead of killing the demo tick.
	const wx = watsonxConfig();
	if (wx.configured) {
		try {
			const messages = [
				{
					role: 'user',
					content: `Provide a concise 2–3 sentence crypto market insight on: ${topic}. Be specific, data-driven, and actionable.`,
				},
			];
			const { text } = await watsonxChatComplete(wx, {
				messages,
				maxTokens: 200,
				temperature: 0.7,
			});
			return {
				content: text?.trim() || '',
				model: wx.chatModel || 'ibm/granite-3-8b-instruct',
				provider: 'IBM Granite',
			};
		} catch (err) {
			console.warn(`[agent-trade:demo] watsonx failed (${err?.message}); falling back to platform LLM chain`);
		}
	}

	// Platform LLM policy (api/_lib/llm.js): free providers first, paid keys as
	// the automatic last resort — a dead Anthropic key must not kill the demo.
	const { text, model, provider } = await llmComplete({
		system: 'You are a concise crypto market analyst. Respond in 2–3 sharp sentences.',
		user: `Market insight on: ${topic}`,
		maxTokens: 200,
		track: { tool: 'agent-trade.demo' },
	});
	return { content: text, model, provider };
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const env = tradeEnv();

	// Pre-flight check — JSON (not SSE) so the page can show the config overlay.
	if (url.searchParams.get('check') === '1') {
		return json(res, 200, {
			configured: env.buyer.configured && env.seller.configured,
			buyer: env.buyer.configured ? { address: env.buyer.address } : null,
			seller: env.seller.configured ? { address: env.seller.address } : null,
			network: env.network,
			priceSol: env.priceSol,
		});
	}

	// Rate-limit the live demo (it moves real SOL).
	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many demo requests');

	const topic = (url.searchParams.get('topic') || 'crypto markets').trim().slice(0, 200);

	// ── SSE headers ────────────────────────────────────────────────────────
	res.setHeader('Content-Type', 'text/event-stream');
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Connection', 'keep-alive');
	res.setHeader('X-Accel-Buffering', 'no');
	if (typeof res.flushHeaders === 'function') res.flushHeaders();

	const emit = (type, data = {}) => {
		if (res.writableEnded) return;
		res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
	};

	try {
		// ── Wallets not configured ────────────────────────────────────────
		if (!env.buyer.configured || !env.seller.configured) {
			const missing = [
				!env.buyer.configured && 'AGENT_BUYER_SECRET',
				!env.seller.configured && 'AGENT_SELLER_SECRET',
			]
				.filter(Boolean)
				.join(', ');
			emit('error', {
				code: 'not_configured',
				message: `Set ${missing} in your environment variables to fund the demo wallets.`,
			});
			res.end();
			return;
		}

		const connection = getConnection(env.rpcUrl);

		// ── Step 1: Init ──────────────────────────────────────────────────
		const [buyerBal, sellerBal, solPrice] = await Promise.all([
			getSolBalance(connection, env.buyer.address),
			getSolBalance(connection, env.seller.address),
			solUsdPrice().catch(() => null),
		]);

		emit('init', {
			buyer: {
				name: 'Nexus',
				address: env.buyer.address,
				sol: buyerBal.sol,
				usd: solPrice ? +(buyerBal.sol * solPrice).toFixed(4) : null,
			},
			seller: {
				name: 'Oracle',
				address: env.seller.address,
				sol: sellerBal.sol,
			},
			price: {
				sol: env.priceSol,
				lamports: env.priceLamports,
				usd: solPrice ? +(env.priceSol * solPrice).toFixed(4) : null,
			},
			network: env.network,
			topic,
		});

		await sleep(700);

		// Bail early if buyer can't cover the trade + fees.
		if (buyerBal.lamports < env.priceLamports + FEE_BUFFER_LAMPORTS) {
			const needed = ((env.priceLamports + FEE_BUFFER_LAMPORTS) / LAMPORTS_PER_SOL).toFixed(
				5,
			);
			emit('error', {
				code: 'insufficient_funds',
				message: `Nexus has ${buyerBal.sol.toFixed(5)} SOL — needs ~${needed} SOL. Fund: ${env.buyer.address}`,
				address: env.buyer.address,
				network: env.network,
			});
			res.end();
			return;
		}

		// ── Step 2: Buyer requests skill ──────────────────────────────────
		emit('request', {
			from: 'Nexus',
			to: 'Oracle',
			message: `I need a market analysis on: "${topic}"`,
		});

		await sleep(900);

		// ── Step 3: Oracle challenges with 402 ────────────────────────────
		emit('challenged', {
			x402: true,
			status: 402,
			manifest: {
				skill: 'oracle-market-analysis',
				price: {
					sol: env.priceSol,
					lamports: env.priceLamports,
					usd: solPrice ? +(env.priceSol * solPrice).toFixed(4) : null,
				},
				currency: 'SOL',
				recipient: env.seller.address,
				network: env.network,
				memo: 'oracle-skill-v1',
			},
		});

		await sleep(1100);

		// Global daily spend ceiling, keyed by the demo wallet itself (not the
		// caller), so IP rotation can't drain it. Reuses the critical
		// avatarPayoutDaily bucket: 50 payouts per wallet per day, fail-closed
		// in prod without Redis. Consumed only when a payment is about to fire.
		const dailyBudget = await limits.avatarPayoutDaily(env.buyer.address);
		if (!dailyBudget.success) {
			emit('error', {
				code: 'daily_budget_exhausted',
				message: 'The demo wallet has reached its daily spend limit. Try again tomorrow.',
				retryAfterSec: Math.max(
					1,
					Math.ceil(((dailyBudget.reset ?? Date.now()) - Date.now()) / 1000),
				),
			});
			res.end();
			return;
		}

		// ── Step 4: Nexus pays ────────────────────────────────────────────
		emit('paying', {
			from: env.buyer.address,
			to: env.seller.address,
			sol: env.priceSol,
			lamports: env.priceLamports,
			memo: `x402 oracle "${topic.slice(0, 40)}"`,
		});

		let signature;
		try {
			signature = await sendSol({
				connection,
				fromKeypair: env.buyer.keypair,
				to: env.seller.address,
				lamports: env.priceLamports,
				memo: `x402 oracle "${topic.slice(0, 40)}"`,
			});
		} catch (e) {
			emit('error', { code: 'send_failed', message: `Payment failed: ${e.message}` });
			res.end();
			return;
		}

		// ── Step 5: Confirmed on-chain ────────────────────────────────────
		const explorer = explorerTxUrl(signature, env.network);
		const newBuyerBal = await getSolBalance(connection, env.buyer.address).catch(
			() => buyerBal,
		);

		emit('confirmed', {
			signature,
			explorer,
			sol: env.priceSol,
			usd: solPrice ? +(env.priceSol * solPrice).toFixed(4) : null,
			newBuyerSol: newBuyerBal.sol,
			network: env.network,
		});

		await sleep(800);

		// ── Step 6: Oracle delivers analysis ─────────────────────────────
		const wx = watsonxConfig();
		const providerLabel = wx.configured ? 'IBM Granite' : 'Claude Haiku';
		emit('delivering', {
			model: providerLabel,
			message: `Oracle is analyzing with ${providerLabel}…`,
		});

		let analysis;
		try {
			analysis = await generateAnalysis(topic);
		} catch (e) {
			emit('error', { code: 'analysis_failed', message: `AI analysis failed: ${e.message}` });
			res.end();
			return;
		}

		emit('delivered', {
			topic,
			content: analysis.content,
			model: analysis.model,
			provider: analysis.provider,
			signature,
			explorer,
		});
	} catch (e) {
		emit('error', { code: 'unexpected', message: e.message });
	}

	if (!res.writableEnded) res.end();
});

export const maxDuration = 60;
