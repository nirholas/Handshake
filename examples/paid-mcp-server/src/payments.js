// x402 payment wiring for a paid MCP server: Solana USDC, exact scheme.
//
// This is the same shape the three.ws production connectors use. One shared
// x402ResourceServer per process verifies and settles against a facilitator;
// each paid tool wraps its handler with `paid()`, which returns the callback
// McpServer.registerTool() expects.
//
// The MCP transport convention (x402 v2):
//   - An unpaid tools/call answers with a PaymentRequired envelope.
//   - The client signs, retries, and puts the payload in _meta["x402/payment"].
//   - The settlement receipt comes back in _meta["x402/payment-response"].
//
// Operator environment (never the caller's):
//   X402_PAY_TO_SOLANA      Solana address that receives USDC. Required.
//   X402_FEE_PAYER_SOLANA   Fee payer for the settlement transaction. Optional.
//   X402_FACILITATOR_URL    Facilitator base URL. Optional.
//   X402_FACILITATOR_TOKEN  Bearer token, if your facilitator wants one. Optional.
//   X402_ASSET_MINT_SOLANA  USDC mint override. Optional.

import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { createPaymentWrapper, createToolResourceUrl } from '@x402/mcp';
import { registerExactSvmScheme } from '@x402/svm/exact/server';

const NETWORK_SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const DEFAULT_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEFAULT_FEE_PAYER = 'PayeRNCipcerPHCsYMTrX9pAYDm1LnPGzgb66NUDG5a';
const DEFAULT_FACILITATOR = 'https://facilitator.payai.network';

const env = (key, fallback) => {
	const value = process.env[key];
	return value && value.trim() ? value.trim() : fallback;
};

function payToAddress() {
	const address = env('X402_PAY_TO_SOLANA') || env('X402_PAY_TO');
	if (!address) {
		throw new Error('Set X402_PAY_TO_SOLANA to the Solana address that should receive USDC.');
	}
	return address;
}

/** Called at startup so a misconfigured server fails immediately, not on the first sale. */
export function assertPaymentEnv() {
	payToAddress();
}

let resourceServerPromise = null;
let initError = null;

export function getResourceServer() {
	if (resourceServerPromise) return resourceServerPromise;
	resourceServerPromise = (async () => {
		const facilitator = new HTTPFacilitatorClient({
			url: env('X402_FACILITATOR_URL', DEFAULT_FACILITATOR),
			createAuthHeaders: env('X402_FACILITATOR_TOKEN')
				? async () => ({ headers: { Authorization: `Bearer ${env('X402_FACILITATOR_TOKEN')}` } })
				: undefined,
		});
		const server = new x402ResourceServer([facilitator]);
		registerExactSvmScheme(server, {});
		try {
			await server.initialize();
		} catch (err) {
			initError = err;
			console.error(`[paid-mcp-server] facilitator initialize() failed: ${err.message}`);
		}
		return server;
	})();
	return resourceServerPromise;
}

export function getFacilitatorInitError() {
	return initError;
}

async function buildAccepts({ resourceServer, priceUsd, resourceUrl }) {
	return resourceServer.buildPaymentRequirementsFromOptions(
		[
			{
				scheme: 'exact',
				network: NETWORK_SOLANA_MAINNET,
				payTo: payToAddress(),
				price: priceUsd,
				maxTimeoutSeconds: 60,
				extra: {
					name: 'USDC',
					decimals: 6,
					asset: env('X402_ASSET_MINT_SOLANA', DEFAULT_USDC_MINT),
					feePayer: env('X402_FEE_PAYER_SOLANA', DEFAULT_FEE_PAYER),
				},
			},
		],
		{ resourceUrl },
	);
}

/**
 * Wrap a tool handler so the call requires payment.
 *
 * Wiring is built lazily on first invocation: registration stays free of secrets,
 * so a test (or `tools/list`) can enumerate the server without any payment env.
 *
 * @param {object} config
 * @param {string} config.toolName    Tool name as registered with MCP.
 * @param {string} config.description Human description, echoed into discovery.
 * @param {string} config.priceUsd    Price string, for example "$0.002".
 * @param {object} config.inputSchema JSON Schema for the tool arguments.
 * @param {object} [config.example]   Example arguments, shown in catalogs.
 * @param {Function} handler          async (args) => any. Runs only after payment verifies.
 * @returns {Function} MCP tool callback.
 */
export function paid(config, handler) {
	const { toolName, description, priceUsd, inputSchema, example } = config;
	if (!toolName) throw new Error('paid(): toolName is required');
	if (!priceUsd) throw new Error('paid(): priceUsd is required');

	let wrapperPromise = null;

	async function getWrapper() {
		if (wrapperPromise) return wrapperPromise;
		wrapperPromise = (async () => {
			const resourceServer = await getResourceServer();
			const resourceUrl = createToolResourceUrl(toolName);
			const accepts = await buildAccepts({ resourceServer, priceUsd, resourceUrl });
			const discovery = declareDiscoveryExtension({
				toolName,
				description,
				// No `transport`: the bazaar discovery spec only accepts
				// "streamable-http" and "sse" there, so declaring "stdio" made every
				// row fail validateDiscoveryExtensionSpec and get dropped by an
				// indexer. The field is optional, and a stdio server has no valid
				// value for it, so it is left off.
				inputSchema,
				example,
			});
			const wrap = createPaymentWrapper(resourceServer, {
				accepts,
				resource: { url: resourceUrl, description, mimeType: 'application/json' },
				extensions: discovery,
			});
			return wrap(async (args) => {
				const result = await handler(args);
				const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
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
