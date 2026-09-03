// x402 payment wiring for ibm-x402-mcp — Solana USDC, exact scheme.
//
// Mirrors the pattern from mcp-server/src/payments.js. Builds a single shared
// x402ResourceServer per process that verifies + settles USDC on Solana
// mainnet via PayAI's facilitator. Every paid tool wraps its handler in
// `paid(cfg, fn)`, which returns the McpServer.tool() callback per the @x402/mcp
// transport spec (PaymentRequired in structuredContent, settlement under
// _meta["x402/payment-response"]).
//
// Environment (server operator — NOT the end user):
//   MCP_SVM_PAYMENT_ADDRESS  — Solana wallet that receives USDC (required)
//   X402_PAY_TO_SOLANA       — fallback alias
//   X402_PAY_TO              — fallback alias
//   X402_FEE_PAYER_SOLANA    — transaction fee payer (optional, defaults to three.ws fee payer)
//   X402_FACILITATOR_URL     — PayAI facilitator URL (optional)
//   X402_FACILITATOR_TOKEN   — Bearer token for facilitator (optional)
//   X402_ASSET_MINT_SOLANA   — USDC mint override (optional)

import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { registerExactSvmScheme } from '@x402/svm/exact/server';
import { createPaymentWrapper, createToolResourceUrl } from '@x402/mcp';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';

const NETWORK_SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const DEFAULT_SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const env = (key, fallback) => {
	const v = process.env[key];
	return v && v.trim() ? v.trim() : fallback;
};

function requireSvmPayTo() {
	const addr = env('MCP_SVM_PAYMENT_ADDRESS') || env('X402_PAY_TO_SOLANA') || env('X402_PAY_TO');
	if (!addr) {
		throw new Error(
			'set MCP_SVM_PAYMENT_ADDRESS to your Solana wallet address to receive USDC payments.',
		);
	}
	return addr;
}

export function assertPaymentEnv() {
	requireSvmPayTo();
}

function svmFeePayer() {
	return env('X402_FEE_PAYER_SOLANA', 'PayeRNCipcerPHCsYMTrX9pAYDm1LnPGzgb66NUDG5a');
}

function buildFacilitator() {
	const url = env('X402_FACILITATOR_URL', 'https://facilitator.payai.network');
	const token = env('X402_FACILITATOR_TOKEN');
	return new HTTPFacilitatorClient({
		url,
		createAuthHeaders: token
			? async () => ({ headers: { Authorization: `Bearer ${token}` } })
			: undefined,
	});
}

let resourceServerPromise = null;
let lastInitError = null;

export function getResourceServer() {
	if (resourceServerPromise) return resourceServerPromise;
	resourceServerPromise = (async () => {
		const server = new x402ResourceServer([buildFacilitator()]);
		registerExactSvmScheme(server, {});
		try {
			await server.initialize();
		} catch (err) {
			lastInitError = err;
			console.error(`[ibm-x402-mcp] facilitator initialize() failed: ${err.message}`);
		}
		return server;
	})();
	return resourceServerPromise;
}

export function getLastFacilitatorInitError() {
	return lastInitError;
}

async function buildAccepts({ resourceServer, priceUsd, resourceUrl }) {
	return resourceServer.buildPaymentRequirementsFromOptions(
		[
			{
				scheme: 'exact',
				network: NETWORK_SOLANA_MAINNET,
				payTo: requireSvmPayTo(),
				price: priceUsd,
				maxTimeoutSeconds: 60,
				extra: {
					name: 'USDC',
					decimals: 6,
					asset: env('X402_ASSET_MINT_SOLANA', DEFAULT_SOLANA_USDC),
					feePayer: svmFeePayer(),
				},
			},
		],
		{ resourceUrl },
	);
}

/**
 * Wrap a tool handler with Solana USDC x402 payment (exact scheme).
 *
 * Payment wiring is built lazily on first invocation — tool registration stays
 * secret-free so buildServer() can enumerate tools without payment env.
 *
 * @param {object} cfg
 * @param {string} cfg.toolName
 * @param {string} cfg.description
 * @param {string} cfg.priceUsd         — e.g. "$0.02"
 * @param {object} cfg.inputSchema      — JSON Schema for tool args
 * @param {object} [cfg.example]
 * @param {object} [cfg.outputExample]
 * @param {Function} handler            — async (args) → any
 * @returns {Function} MCP tool callback
 */
export function paid(cfg, handler) {
	const { toolName, description, priceUsd, inputSchema, example, outputExample } = cfg;

	if (!toolName) throw new Error('paid(): toolName is required');
	if (!priceUsd) throw new Error('paid(): priceUsd is required');

	let wrapperPromise = null;

	async function getWrapper() {
		if (wrapperPromise) return wrapperPromise;
		wrapperPromise = (async () => {
			const resourceServer = await getResourceServer();
			const resourceUrl = createToolResourceUrl(toolName);
			const accepts = await buildAccepts({ resourceServer, priceUsd, resourceUrl });

			const bazaar = declareDiscoveryExtension({
				toolName,
				description,
				// No `transport`: the bazaar discovery spec only accepts
				// "streamable-http" and "sse" there, so declaring "stdio" made every
				// row fail validateDiscoveryExtensionSpec and get dropped by an
				// indexer. The field is optional, and a stdio server has no valid
				// value for it, so it is left off.
				inputSchema,
				example,
				output: outputExample ? { example: outputExample } : undefined,
			});

			const wrap = createPaymentWrapper(resourceServer, {
				accepts,
				resource: { url: resourceUrl, description, mimeType: 'application/json' },
				extensions: bazaar,
			});

			return wrap(async (args) => {
				const result = await handler(args);
				const text = typeof result === 'string' ? result : JSON.stringify(result);
				return { content: [{ type: 'text', text }] };
			});
		})();
		return wrapperPromise;
	}

	return async function paidToolCallback(args, context) {
		const wrapped = await getWrapper();
		return wrapped(args, context);
	};
}

export function toolError(code, message, extra) {
	return { ok: false, error: code, message, ...(extra || {}) };
}
