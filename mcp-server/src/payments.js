// Shared x402 payment wiring for paid MCP tools.
//
// Every tool in mcp-server/src/tools/*.js wraps its handler in
// `paid(toolName, { schemeName, priceUsd, networks, inputSchema, ...}, fn)`.
// This file builds the single shared x402ResourceServer (one per process)
// that verifies + settles against the configured facilitators, and exposes
// `paid()` that produces the McpServer.tool() callback per the @x402/mcp
// transport spec (PaymentRequired in structuredContent + content[0].text,
// settlement response under _meta["x402/payment-response"]).
//
// Networks supported here:
//   - Base mainnet (eip155:8453) via CDP when CDP_API_KEY_ID/CDP_API_KEY_SECRET
//     are set, else via PayAI's facilitator. Receiver: MCP_EVM_PAYMENT_ADDRESS
//     (falls back to X402_PAY_TO_BASE).
//   - Solana mainnet via PayAI's Solana facilitator. Receiver:
//     MCP_SVM_PAYMENT_ADDRESS (falls back to X402_PAY_TO_SOLANA).
//
// Both EVM `exact` + `upto` are registered so the vanity grinder can use
// upto-style metered billing while the other tools stay on exact.
//
// `createPaymentWrapper` from @x402/mcp returns a function that wraps your
// async tool handler into an MCP-compatible callback. It handles the entire
// 402 dance: returns a 402 PaymentRequired result with both structuredContent
// + content[0].text when the client calls without _meta["x402/payment"];
// verifies the payment, runs the handler, settles, and attaches the
// SettleResponse to _meta["x402/payment-response"].

import { createCdpAuthHeaders } from '@coinbase/x402';
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { registerExactEvmScheme } from '@x402/evm/exact/server';
import { UptoEvmScheme as UptoEvmServerScheme } from '@x402/evm/upto/server';
import { registerExactSvmScheme } from '@x402/svm/exact/server';
import {
	createPaymentWrapper,
	createToolResourceUrl,
	extractPaymentFromMeta,
} from '@x402/mcp';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';

// CAIP-2 IDs we care about (mirrors api/_lib/x402-spec.js).
const NETWORK_BASE_MAINNET = 'eip155:8453';
const NETWORK_SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

const DEFAULT_BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DEFAULT_SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const env = (key, fallback) => {
	const v = process.env[key];
	return v && v.trim() ? v.trim() : fallback;
};

function requireEvmPayTo() {
	const addr = env('MCP_EVM_PAYMENT_ADDRESS') || env('X402_PAY_TO_BASE');
	if (!addr) {
		throw new Error(
			'mcp-server: set MCP_EVM_PAYMENT_ADDRESS (or X402_PAY_TO_BASE) to receive Base USDC payments',
		);
	}
	return addr;
}

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

// Build the CDP auth-headers async factory once and adapt it to the
// HTTPFacilitatorClient's per-path createAuthHeaders contract. The CDP SDK
// returns { verify, settle, supported, list } per call — we pick the slot
// matching the requested path.
function buildCdpFacilitator() {
	const id = env('CDP_API_KEY_ID');
	const secret = env('CDP_API_KEY_SECRET');
	if (!id || !secret) return null;
	const url = env('X402_CDP_FACILITATOR_URL', 'https://api.cdp.coinbase.com/platform/v2/x402');
	const factory = createCdpAuthHeaders(id, secret);
	return new HTTPFacilitatorClient({
		url,
		createAuthHeaders: async (path) => {
			const all = await factory();
			const map = { '/verify': 'verify', '/settle': 'settle', '/supported': 'supported' };
			const op = map[path] || (path?.includes('verify') ? 'verify' : path?.includes('settle') ? 'settle' : 'supported');
			return { headers: all?.[op] || {} };
		},
	});
}

function buildPayAiBaseFacilitator() {
	const url = env('X402_FACILITATOR_URL_BASE') || env('X402_FACILITATOR_URL', 'https://facilitator.payai.network');
	const token = env('X402_FACILITATOR_TOKEN_BASE') || env('X402_FACILITATOR_TOKEN');
	return new HTTPFacilitatorClient({
		url,
		createAuthHeaders: token
			? async () => ({ headers: { Authorization: `Bearer ${token}` } })
			: undefined,
	});
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

// Build a single shared x402ResourceServer, register every scheme/network we
// advertise on a tool, and call .initialize() to fetch facilitator /supported
// (caches kinds + extensions for the per-network/per-scheme path).
//
// `initialize()` MUST run before any verify/settle — without it the server
// has no notion of which facilitator handles which network and will throw on
// the first paid call. We memoize the promise so concurrent tool calls don't
// race during startup.
export function getResourceServer() {
	if (resourceServerPromise) return resourceServerPromise;
	resourceServerPromise = (async () => {
		const facilitators = [];
		const cdp = buildCdpFacilitator();
		if (cdp) facilitators.push(cdp);
		facilitators.push(buildPayAiBaseFacilitator());
		facilitators.push(buildPayAiSolanaFacilitator());

		const server = new x402ResourceServer(facilitators);
		registerExactEvmScheme(server, {});
		// upto on EVM is needed by the vanity grinder (metered billing).
		server.register('eip155:*', new UptoEvmServerScheme());
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

// Build the per-tool `accepts` list. Default networks are Base + Solana for
// `exact`-priced tools; `upto` tools only support EVM today because @x402/svm
// doesn't ship an upto scheme.
async function buildAcceptsForTool({ resourceServer, scheme, priceUsd, networks, resourceUrl, extra }) {
	const opts = [];
	for (const net of networks) {
		if (net === NETWORK_BASE_MAINNET) {
			opts.push({
				scheme,
				network: NETWORK_BASE_MAINNET,
				payTo: requireEvmPayTo(),
				price: priceUsd,
				maxTimeoutSeconds: 60,
				extra: {
					name: 'USD Coin',
					version: '2',
					decimals: 6,
					asset: env('X402_ASSET_ADDRESS_BASE', DEFAULT_BASE_USDC),
					...(extra?.evm || {}),
				},
			});
		} else if (net === NETWORK_SOLANA_MAINNET) {
			if (scheme !== 'exact') continue; // upto on SVM not supported by @x402/svm@2.12.
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
		} else {
			throw new Error(`mcp-server: unsupported network ${net}`);
		}
	}
	if (opts.length === 0) {
		throw new Error(`mcp-server: no networks resolved for scheme=${scheme}`);
	}
	return resourceServer.buildPaymentRequirementsFromOptions(opts, { resourceUrl });
}

/**
 * Wrap a tool handler with x402 payment.
 *
 * @param {object} cfg
 * @param {string} cfg.toolName              — e.g. "get_pose_seed"
 * @param {string} cfg.description           — human-readable description
 * @param {string} [cfg.scheme='exact']      — 'exact' or 'upto'
 * @param {string|number} cfg.priceUsd       — Price like "$0.001" (max for `upto`)
 * @param {string[]} [cfg.networks]          — default ['eip155:8453','solana:...']
 * @param {object} cfg.inputSchema           — JSON Schema for the tool's args
 * @param {object} [cfg.example]             — example invocation for bazaar
 * @param {object} [cfg.outputExample]       — example output for bazaar
 * @param {object} [cfg.extra]               — extra fields per-network
 * @param {object} [cfg.hooks]               — { onBeforeExecution, onAfterExecution, onAfterSettlement }
 * @param {Function} handler                 — async (args, { settle? }) → { content }
 * @returns {Promise<Function>} MCP tool callback for McpServer.tool()
 */
export async function paid(cfg, handler) {
	const {
		toolName,
		description,
		scheme = 'exact',
		priceUsd,
		networks = scheme === 'upto' ? [NETWORK_BASE_MAINNET] : [NETWORK_BASE_MAINNET, NETWORK_SOLANA_MAINNET],
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

/**
 * Wrap an `upto`-scheme tool whose handler decides the actual settlement
 * amount based on resource consumption. The `priceUsd` becomes the
 * authorized maximum; the handler returns `{ result, settleAmount }` where
 * `settleAmount` is a percent string ("50%"), atomic units ("250000"), or a
 * USD price ("$0.25"). The wrapper settles via x402ResourceServer's
 * settlementOverrides — facilitator enforces settle <= max.
 *
 * Unlike `paid()` (which uses `createPaymentWrapper`), this wrapper
 * implements the MCP transport flow manually so it can plumb
 * `settlementOverrides.amount` through `settlePayment`. The 402 response
 * shape (structuredContent + content[0].text + isError:true) matches the
 * v2 MCP transport spec.
 */
export async function paidUpto(cfg, handler) {
	const {
		toolName,
		description,
		priceUsd,
		networks = [NETWORK_BASE_MAINNET],
		inputSchema,
		example,
		outputExample,
		extra,
	} = cfg;

	if (!toolName) throw new Error('paidUpto(): toolName is required');
	if (!priceUsd) throw new Error('paidUpto(): priceUsd is required (max)');
	if (!inputSchema) throw new Error('paidUpto(): inputSchema is required');

	const resourceServer = await getResourceServer();
	const resourceUrl = createToolResourceUrl(toolName);
	const accepts = await buildAcceptsForTool({
		resourceServer,
		scheme: 'upto',
		priceUsd,
		networks,
		resourceUrl,
		extra,
	});
	const resourceInfo = { url: resourceUrl, description, mimeType: 'application/json' };
	const bazaar = declareDiscoveryExtension({
		toolName,
		description,
		transport: 'stdio',
		inputSchema,
		example,
		output: outputExample ? { example: outputExample } : undefined,
	});

	const paymentRequiredResult = async (errorMessage) => {
		const paymentRequired = await resourceServer.createPaymentRequiredResponse(
			accepts,
			resourceInfo,
			errorMessage,
			bazaar,
		);
		return {
			structuredContent: paymentRequired,
			content: [{ type: 'text', text: JSON.stringify(paymentRequired) }],
			isError: true,
		};
	};

	return async (args, extra) => {
		const _meta = extra?._meta;
		const paymentPayload = extractPaymentFromMeta({ name: toolName, arguments: args, _meta });
		if (!paymentPayload) {
			return paymentRequiredResult('Payment required to access this tool');
		}
		const matched = resourceServer.findMatchingRequirements(accepts, paymentPayload);
		if (!matched) {
			return paymentRequiredResult('No matching payment requirements for this payload');
		}
		const verify = await resourceServer.verifyPayment(paymentPayload, matched, bazaar);
		if (!verify.isValid) {
			return paymentRequiredResult(verify.invalidReason || 'Payment verification failed');
		}
		let handlerOutput;
		try {
			handlerOutput = await handler(args, { context: extra, requirement: matched });
		} catch (err) {
			return paymentRequiredResult(`Tool failed before settlement: ${err.message}`);
		}
		const { result, settleAmount } = handlerOutput;
		if (!result) {
			return paymentRequiredResult('Tool handler returned no result');
		}
		// Defense-in-depth: cap settleAmount at the matched requirement's max.
		// The facilitator will reject an override that exceeds what the client
		// signed, but a buggy/compromised handler returning an inflated
		// settleAmount should fail fast server-side with a clear error rather
		// than reaching the facilitator with a value that looks valid against
		// other concurrent payments. Numeric settleAmount only — percent
		// strings ("50%") and $-strings ("$0.25") pass through to the
		// facilitator unchanged.
		let overrides;
		if (settleAmount) {
			const amountStr = String(settleAmount);
			if (/^\d+$/.test(amountStr)) {
				let requested;
				try { requested = BigInt(amountStr); }
				catch {
					return paymentRequiredResult(`Settlement failed: settleAmount ${amountStr} did not parse as atomic units`);
				}
				let maxAuthorized = 0n;
				try { maxAuthorized = BigInt(matched.amount || '0'); }
				catch { maxAuthorized = 0n; }
				if (maxAuthorized > 0n && requested > maxAuthorized) {
					return paymentRequiredResult(
						`Settlement failed: handler returned settleAmount ${requested.toString()} exceeding authorized max ${maxAuthorized.toString()}`,
					);
				}
				overrides = { amount: amountStr };
			} else {
				overrides = { amount: amountStr };
			}
		}
		let settle;
		try {
			settle = await resourceServer.settlePayment(paymentPayload, matched, bazaar, undefined, overrides);
		} catch (err) {
			return paymentRequiredResult(`Settlement failed: ${err.message}`);
		}
		const text = typeof result === 'string' ? result : JSON.stringify(result);
		return {
			content: [{ type: 'text', text }],
			_meta: { 'x402/payment-response': settle },
		};
	};
}

export { NETWORK_BASE_MAINNET, NETWORK_SOLANA_MAINNET };
