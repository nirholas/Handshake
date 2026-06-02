// Shared x402 payment wiring for paid MCP tools — Solana mainnet only.
//
// Every tool in mcp-server/src/tools/*.js wraps its handler in
// `paid(cfg, fn)`. This file builds the single shared x402ResourceServer
// (one per process) that verifies + settles USDC payments on Solana via
// PayAI's Solana facilitator, and exposes `paid()` that produces the
// McpServer.tool() callback per the @x402/mcp transport spec
// (PaymentRequired in structuredContent + content[0].text, settlement
// response under _meta["x402/payment-response"]).
//
// Network: Solana mainnet (solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp).
//   Receiver: MCP_SVM_PAYMENT_ADDRESS (falls back to X402_PAY_TO_SOLANA /
//   X402_PAY_TO). Asset: USDC (EPjFW…), 6 decimals. Fee payer:
//   X402_FEE_PAYER_SOLANA.
//
// Only the `exact` scheme is supported: @x402/svm ships no `upto` scheme, so
// metered/`upto` billing is not available on Solana. Tools that previously
// metered (the vanity grinder) charge a flat exact price instead.
//
// `createPaymentWrapper` from @x402/mcp returns a function that wraps your
// async tool handler into an MCP-compatible callback. It handles the entire
// 402 dance: returns a 402 PaymentRequired result with both structuredContent
// + content[0].text when the client calls without _meta["x402/payment"];
// verifies the payment, runs the handler, settles, and attaches the
// SettleResponse to _meta["x402/payment-response"].

import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { registerExactSvmScheme } from '@x402/svm/exact/server';
import { createPaymentWrapper, createToolResourceUrl } from '@x402/mcp';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';

// CAIP-2 id for Solana mainnet (mirrors api/_lib/x402-spec.js).
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
			'mcp-server: set MCP_SVM_PAYMENT_ADDRESS (or X402_PAY_TO_SOLANA / X402_PAY_TO) to receive Solana USDC payments',
		);
	}
	return addr;
}

function svmFeePayer() {
	return env('X402_FEE_PAYER_SOLANA', '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4');
}

function buildPayAiSolanaFacilitator() {
	const url = env('X402_FACILITATOR_URL_SOLANA') || env('X402_FACILITATOR_URL', 'https://facilitator.payai.network');
	const token = env('X402_FACILITATOR_TOKEN_SOLANA') || env('X402_FACILITATOR_TOKEN');
	return new HTTPFacilitatorClient({
		url,
		createAuthHeaders: token
			? async () => ({ headers: { Authorization: `Bearer ${token}` } })
			: undefined,
	});
}

let resourceServerPromise = null;
let lastInitError = null;

// Build a single shared x402ResourceServer, register the Solana `exact`
// scheme, and call .initialize() to fetch the facilitator's /supported (caches
// kinds + extensions for the verify/settle path).
//
// `initialize()` MUST run before any verify/settle — without it the server has
// no notion of which facilitator handles Solana and will throw on the first
// paid call. We memoize the promise so concurrent tool calls don't race during
// startup.
export function getResourceServer() {
	if (resourceServerPromise) return resourceServerPromise;
	resourceServerPromise = (async () => {
		const server = new x402ResourceServer([buildPayAiSolanaFacilitator()]);
		registerExactSvmScheme(server, {});
		try {
			await server.initialize();
		} catch (err) {
			lastInitError = err;
			// Don't fatally throw — the server can still emit 402 challenges and
			// /supported may have been partially populated. Operators will see
			// the real failure when a tool tries to verify a payment.
			console.error(`[mcp-server] facilitator initialize() failed: ${err.message}`);
		}
		return server;
	})();
	return resourceServerPromise;
}

export function getLastFacilitatorInitError() {
	return lastInitError;
}

// Build the per-tool `accepts` list. Every paid tool settles in USDC on Solana
// mainnet via the `exact` scheme.
async function buildAcceptsForTool({ resourceServer, scheme, priceUsd, networks, resourceUrl, extra }) {
	const opts = [];
	for (const net of networks) {
		if (net !== NETWORK_SOLANA_MAINNET) {
			throw new Error(`mcp-server: unsupported network ${net} (Solana mainnet only)`);
		}
		opts.push({
			scheme,
			network: NETWORK_SOLANA_MAINNET,
			payTo: requireSvmPayTo(),
			price: priceUsd,
			maxTimeoutSeconds: 60,
			extra: {
				name: 'USDC',
				decimals: 6,
				asset: env('X402_ASSET_MINT_SOLANA', DEFAULT_SOLANA_USDC),
				feePayer: svmFeePayer(),
				...(extra?.svm || {}),
			},
		});
	}
	if (opts.length === 0) {
		throw new Error(`mcp-server: no networks resolved for scheme=${scheme}`);
	}
	return resourceServer.buildPaymentRequirementsFromOptions(opts, { resourceUrl });
}

/**
 * Wrap a tool handler with x402 payment (USDC on Solana, `exact` scheme).
 *
 * @param {object} cfg
 * @param {string} cfg.toolName              — e.g. "get_pose_seed"
 * @param {string} cfg.description           — human-readable description
 * @param {string} [cfg.scheme='exact']      — only 'exact' is supported on Solana
 * @param {string|number} cfg.priceUsd       — Price like "$0.001"
 * @param {string[]} [cfg.networks]          — default ['solana:5eykt4…']
 * @param {object} cfg.inputSchema           — JSON Schema for the tool's args
 * @param {object} [cfg.example]             — example invocation for bazaar
 * @param {object} [cfg.outputExample]       — example output for bazaar
 * @param {object} [cfg.extra]               — extra fields (extra.svm)
 * @param {object} [cfg.hooks]               — { onBeforeExecution, onAfterExecution, onAfterSettlement }
 * @param {Function} handler                 — async (args, { settle? }) → result
 * @returns {Promise<Function>} MCP tool callback for McpServer.tool()
 */
export async function paid(cfg, handler) {
	const {
		toolName,
		description,
		scheme = 'exact',
		priceUsd,
		networks = [NETWORK_SOLANA_MAINNET],
		inputSchema,
		example,
		outputExample,
		extra,
		hooks,
	} = cfg;

	if (!toolName) throw new Error('paid(): toolName is required');
	if (!description) throw new Error('paid(): description is required');
	if (!priceUsd) throw new Error('paid(): priceUsd is required (e.g. "$0.001")');
	if (!inputSchema) throw new Error('paid(): inputSchema is required');
	if (scheme !== 'exact') {
		throw new Error(`paid(): only the 'exact' scheme is supported on Solana (got '${scheme}')`);
	}

	const resourceServer = await getResourceServer();
	const resourceUrl = createToolResourceUrl(toolName);
	const accepts = await buildAcceptsForTool({
		resourceServer,
		scheme,
		priceUsd,
		networks,
		resourceUrl,
		extra,
	});

	const bazaar = declareDiscoveryExtension({
		toolName,
		description,
		transport: 'stdio',
		inputSchema,
		example,
		output: outputExample ? { example: outputExample } : undefined,
	});

	const wrap = createPaymentWrapper(resourceServer, {
		accepts,
		resource: { url: resourceUrl, description, mimeType: 'application/json' },
		extensions: bazaar,
		hooks,
	});

	return wrap(async (args, context) => {
		const result = await handler(args, context);
		const text = typeof result === 'string' ? result : JSON.stringify(result);
		return {
			content: [{ type: 'text', text }],
		};
	});
}

export { NETWORK_SOLANA_MAINNET };
