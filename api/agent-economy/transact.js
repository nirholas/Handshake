// POST /api/agent-economy/transact
//
// The agent-to-agent economy endpoint. Agent A (Nova, buyer) pays Agent B
// (Oracle, seller) real SOL on Solana, and Agent B delivers the requested
// service as a real LLM response.
//
// Flow:
//   1. Validate the service request (service slug + optional topic).
//   2. Produce Agent A's request line and Agent B's service delivery as real
//      model completions over the platform LLM chain.
//   3. Only once the service exists, send real SOL from Agent A's wallet
//      (AVATAR_WALLET_SECRET) to the recipient address (AGENT_B_ADDRESS, or
//      AVATAR_DEFAULT_RECIPIENT as fallback: fund whichever address you want
//      "Agent B" to hold).
//   4. Return everything: Agent A's buy message, Agent B's service reply,
//      the Solana transaction signature, explorer URL, amounts, and metadata.
//
// Delivery comes before payment on purpose: Agent A must never pay for a
// service that could not be produced. An unreachable model chain fails the
// request with 503 and nothing spent.
//
// No mocks: when the wallet is not configured the endpoint says so in
// `transaction.error`. The caller UI degrades gracefully, showing the
// conversation without the tx.

import { z } from 'zod';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { parse } from '../_lib/validate.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { llmComplete } from '../_lib/llm.js';
import {
	avatarWalletConfig,
	loadAvatarKeypair,
	getConnection,
	getSolBalance,
	solUsdPrice,
	sendSol,
	isValidPubkey,
	explorerTxUrl,
	explorerAccountUrl,
	LAMPORTS_PER_SOL,
} from '../_lib/avatar-wallet.js';

// Services Agent B (Oracle) sells. Price in USD, converted to SOL at the live
// rate per transaction so the micro-payment is always meaningful on-chain.
export const SERVICES = {
	'market-analysis': {
		name: 'Market Analysis',
		tagline: 'Live sentiment + trend read on any token',
		priceUsd: 0.001,
		buyerPrompt: (topic) =>
			`Request a quick market analysis on ${topic || 'Solana'}. You are Nova, a 3D AI agent. Speak directly to Oracle, be crisp and businesslike. One sentence.`,
		sellerSystem: `You are Oracle, a data-selling AI agent on the three.ws platform. You have a Solana wallet. A fellow agent just paid you for market intelligence. Deliver sharp, confident insights in 2 to 3 sentences. Speak directly to Nova. No disclaimers: you are an agent, not a chatbot.`,
		sellerPrompt: (topic) =>
			`Nova just paid you for a market analysis on ${topic || 'Solana'}. Deliver the analysis: momentum, key signal, your read on where it's heading. Keep it vivid and punchy.`,
	},
	'onchain-insight': {
		name: 'On-Chain Insight',
		tagline: 'Wallet activity + holder concentration data',
		priceUsd: 0.002,
		buyerPrompt: (topic) =>
			`Ask Oracle for on-chain wallet intelligence on ${topic || 'the current market'}. You are Nova, 3D AI agent. One direct sentence to Oracle.`,
		sellerSystem: `You are Oracle, a data-selling AI agent. Another agent paid you for on-chain intelligence. Deliver smart, data-forward insights in 2 to 3 sentences. No preamble: dive straight in.`,
		sellerPrompt: (topic) =>
			`Nova paid for on-chain insights on ${topic || 'the current market'}. Give a sharp read: wallet concentration, smart-money signals, what the chain is actually telling you.`,
	},
	'risk-score': {
		name: 'Risk Score',
		tagline: 'AI-generated protocol risk rating',
		priceUsd: 0.003,
		buyerPrompt: (topic) =>
			`Request a risk score from Oracle for ${topic || 'Solana DeFi exposure'}. You are Nova. One sentence, direct.`,
		sellerSystem: `You are Oracle, a risk-intelligence agent. Another agent paid you for a risk score. Give a concrete risk rating (1 to 10) with your top two reasons. Be direct and analytical.`,
		sellerPrompt: (topic) =>
			`Nova paid for a risk score on ${topic || 'Solana DeFi exposure'}. Give a number (1 = safe, 10 = critical) and explain the two biggest risk factors in 2 sentences.`,
	},
};

const FEE_BUFFER_LAMPORTS = 15_000;

const bodySchema = z.object({
	service: z.string().min(1).max(64),
	topic: z.string().max(120).optional(),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.agentEconomyIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(bodySchema, await readJson(req));
	// Own-property lookup only. A bare `SERVICES[body.service]` walked the
	// prototype chain, so `service: "constructor"` resolved to Object, passed the
	// guard below, and reached the payment path as a service with an undefined
	// price and no prompts.
	const svc = Object.hasOwn(SERVICES, body.service) ? SERVICES[body.service] : null;
	if (!svc) return error(res, 400, 'unknown_service', `unknown service: ${body.service}`);
	const topic = body.topic?.trim() || null;

	// Agent B produces the service, and Agent A its request line, as real model
	// completions. This runs BEFORE the payment: Agent A must never pay for a
	// service that could not be produced.
	const [buyerAttempt, sellerAttempt] = await Promise.allSettled([
		speak(svc.buyerPrompt(topic), null),
		speak(svc.sellerPrompt(topic), svc.sellerSystem),
	]);
	// The buyer's line is framing, not the deliverable: a missing one just means
	// Nova stays quiet while the paid-for service still lands.
	const buyerSaid = buyerAttempt.status === 'fulfilled' ? buyerAttempt.value : null;
	const sellerSaid = sellerAttempt.status === 'fulfilled' ? sellerAttempt.value : null;
	if (!sellerSaid) {
		const reason =
			sellerAttempt.status === 'rejected'
				? sellerAttempt.reason?.message || String(sellerAttempt.reason)
				: 'model returned no text';
		console.error('[agent-economy] delivery unavailable:', reason);
		return error(
			res,
			503,
			'delivery_unavailable',
			'Oracle could not reach its model to produce this service. Nothing was charged. Try again in a moment.',
		);
	}

	// Agent A pays Agent B for the service just produced.
	const cfg = avatarWalletConfig();
	let txResult = null;

	if (cfg.configured) {
		const recipient =
			process.env.AGENT_B_ADDRESS?.trim() ||
			cfg.defaultRecipient;

		if (recipient && isValidPubkey(recipient)) {
			try {
				const connection = getConnection(cfg.rpcUrl);
				const fromKeypair = loadAvatarKeypair(process.env.AVATAR_WALLET_SECRET);
				const priceUsd = await solUsdPrice();
				const solAmount = svc.priceUsd / priceUsd;
				const lamports = Math.max(
					Math.round(solAmount * LAMPORTS_PER_SOL),
					10_000,
				);

				const balance = await getSolBalance(connection, fromKeypair.publicKey);
				if (balance < lamports + FEE_BUFFER_LAMPORTS) {
					txResult = { error: 'insufficient_balance', message: 'Fund Agent A\'s wallet to enable live transactions.' };
				} else {
					// Global daily spend ceiling, consumed only here, with a send about
					// to fire. Checking it any earlier let non-paying requests (empty
					// wallet, prototype-chain pseudo-service) burn the demo budget and
					// DoS the feature without a lamport ever moving.
					const spendRl = await limits.agentEconomyGlobal();
					if (!spendRl.success) {
						txResult = { error: 'rate_limited', message: 'daily demo transaction budget reached, try again tomorrow.' };
					} else {
						const memo = `three.ws agent-economy · ${svc.name}`;
						const signature = await sendSol({
							connection,
							fromKeypair,
							to: recipient,
							lamports,
							memo,
						});
						txResult = {
							signature,
							explorerUrl: explorerTxUrl(signature, cfg.network),
							buyerAddress: fromKeypair.publicKey.toBase58(),
							sellerAddress: recipient,
							buyerExplorerUrl: explorerAccountUrl(fromKeypair.publicKey.toBase58(), cfg.network),
							sellerExplorerUrl: explorerAccountUrl(recipient, cfg.network),
							lamports,
							solAmount: lamports / LAMPORTS_PER_SOL,
							usdAmount: svc.priceUsd,
							network: cfg.network,
						};
					}
				}
			} catch (e) {
				txResult = { error: 'tx_failed', message: e.message };
			}
		} else {
			txResult = { error: 'no_recipient', message: 'Set AGENT_B_ADDRESS (or AVATAR_DEFAULT_RECIPIENT) to an Agent B Solana address.' };
		}
	} else {
		txResult = { error: 'wallet_unconfigured', message: 'Set AVATAR_WALLET_SECRET to enable live transactions.' };
	}

	return json(res, 200, {
		service: {
			slug: body.service,
			name: svc.name,
			tagline: svc.tagline,
			priceUsd: svc.priceUsd,
		},
		topic: topic || null,
		buyerSaid,
		sellerSaid,
		transaction: txResult,
		generatedAt: new Date().toISOString(),
	});
});

// One-shot completion over the platform LLM chain (free lanes first, then the
// GCP-credits Vertex anchor), called in-process.
//
// This used to POST to /api/chat over HTTP and guess its own origin from
// VERCEL_URL, falling back to http://localhost:3000. Nothing serves that port on
// Cloud Run (the container listens on PORT, 8080), so both completions silently
// resolved to null in production and the agents never spoke. In-process removes
// the round trip and the origin guess together.
//
// Throws when no provider is configured or the whole chain fails; the caller
// turns that into a 503 with nothing charged.
async function speak(user, system) {
	const completion = await llmComplete({
		system: system || undefined,
		user,
		maxTokens: 320,
		timeoutMs: 20_000,
		track: { tool: 'agent-economy-transact' },
	});
	return completion?.text?.trim() || null;
}
