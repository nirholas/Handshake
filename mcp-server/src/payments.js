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

// Platform's canonical Solana USDC payout address (the documented
// X402_PAY_TO_SOLANA receiver). Used as the DEFAULT payTo so the server always
// advertises a valid recipient — and always boots — even on a deployment that
// never set a payout address (e.g. a connector reviewer running
// `npx @three-ws/mcp-server` with zero env). A real operator overrides it with
// MCP_SVM_PAYMENT_ADDRESS.
const DEFAULT_SVM_PAY_TO = 'wwwwwDxFWRn7grgr3Esrsg5C6NvDoDHSA4gaCffccrU';

// Base58 Solana address: 32–44 chars, excluding 0 O I l.
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Read an env var, treating an empty value OR a literal "${VAR}" templating miss
// as "not set". Without the placeholder guard an unsubstituted `${...}` (seen in
// the field when an MCP host forwards a config var for an unset shell variable)
// leaks straight into the advertised payTo, and every PaymentRequired ships a
// recipient no client can pay.
function configuredValue(key) {
	const v = env(key);
	if (!v) return null;
	if (/^\$\{[^}]*\}$/.test(v)) return null;
	return v;
}

function requireSvmPayTo() {
	const configured =
		configuredValue('MCP_SVM_PAYMENT_ADDRESS') ||
		configuredValue('X402_PAY_TO_SOLANA') ||
		configuredValue('X402_PAY_TO');
	if (!configured) return DEFAULT_SVM_PAY_TO;
	if (!SOLANA_ADDRESS_RE.test(configured)) {
		// A *configured* but malformed address is an operator mistake — fail loud
		// rather than silently route funds to the platform default or advertise an
		// unpayable challenge. (An *unset* address, by contrast, falls back to the
		// default above so the server still boots and challenges cleanly.)
		throw new Error(
			`mcp-server: payout address "${configured}" is not a valid base58 Solana address ` +
				'(set MCP_SVM_PAYMENT_ADDRESS to a 32–44 char base58 wallet)',
		);
	}
	return configured;
}

/**
 * Server-side review entitlement. A connector reviewer driving a plain MCP host
 * (claude.ai, Claude Desktop) cannot mint x402 payments, so every paid tool
 * would answer 402 and the reviewer could never see a real result. When the
 * operator sets MCP_REVIEW_SECRET on the server AND the caller's env carries a
 * matching MCP_REVIEW_MODE, paid tools run their REAL handler and skip the USDC
 * charge — genuine results, no mock. Gated on a shared secret so a published
 * deployment that never sets MCP_REVIEW_SECRET can never be bypassed for free
 * (review mode is OFF by default).
 *
 * @returns {boolean} true when a valid reviewer entitlement is present
 */
export function reviewModeActive() {
	const secret = configuredValue('MCP_REVIEW_SECRET');
	if (!secret) return false;
	const presented = configuredValue('MCP_REVIEW_MODE');
	return Boolean(presented) && presented === secret;
}

/**
 * Resolve and validate the payout configuration at startup. With the built-in
 * DEFAULT_SVM_PAY_TO this NO LONGER blocks boot when no address is set — it only
 * throws when a *configured* address is malformed — so a connector reviewer can
 * run the server with zero payment env. Called once by the stdio entry point;
 * does NOT run during `buildServer()`/tests, so tool registration stays
 * secret-free.
 *
 * @returns {string} the resolved Solana payout address
 */
export function assertPaymentEnv() {
	return requireSvmPayTo();
}

function svmFeePayer() {
	return env('X402_FEE_PAYER_SOLANA', 'PayeRNCipcerPHCsYMTrX9pAYDm1LnPGzgb66NUDG5a');
}

// Resolve the ordered facilitator URL list. A comma-separated
// X402_FACILITATOR_URLS_SOLANA configures redundancy; the single-URL env vars
// are kept for back-compat, and PayAI is the last-resort default. Earlier URLs
// get precedence at init — if the primary's /supported fetch is unreachable, a
// later facilitator that responded takes over the Solana `exact` kind, so a
// facilitator outage no longer leaves the server unable to settle.
function solanaFacilitatorUrls() {
	const list = env('X402_FACILITATOR_URLS_SOLANA', '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const single = env('X402_FACILITATOR_URL_SOLANA') || env('X402_FACILITATOR_URL');
	const ordered = [];
	const seen = new Set();
	for (const url of [...list, single, 'https://facilitator.payai.network']) {
		if (url && !seen.has(url)) {
			seen.add(url);
			ordered.push(url);
		}
	}
	return ordered;
}

function buildSolanaFacilitators() {
	const token = env('X402_FACILITATOR_TOKEN_SOLANA') || env('X402_FACILITATOR_TOKEN');
	const createAuthHeaders = token
		? async () => ({ headers: { Authorization: `Bearer ${token}` } })
		: undefined;
	return solanaFacilitatorUrls().map(
		(url) => new HTTPFacilitatorClient({ url, createAuthHeaders }),
	);
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
		const server = new x402ResourceServer(buildSolanaFacilitators());
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
async function buildAcceptsForTool({
	resourceServer,
	scheme,
	priceUsd,
	networks,
	resourceUrl,
	extra,
}) {
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
 * The x402 wiring (resource server init, `accepts` requirements, payment
 * wrapper) is built LAZILY on the first invocation — NOT when the tool is
 * registered. This keeps tool registration (names/descriptions/schemas)
 * free of any runtime payment env: `buildServer()` can enumerate every tool
 * without MCP_SVM_PAYMENT_ADDRESS, and only an actual paid call triggers the
 * env requirement. The wrapper is memoized so the first call pays the init cost
 * once and every subsequent call reuses it.
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
 * @returns {Function} MCP tool callback for McpServer.tool()
 */
export function paid(cfg, handler) {
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

	// Lazily build (and memoize) the payment wrapper. This is the ONLY place
	// that touches payment env (requireSvmPayTo) and the facilitator, so it
	// runs on first invocation rather than at registration time.
	let wrapperPromise = null;
	async function getWrapper() {
		if (wrapperPromise) return wrapperPromise;
		wrapperPromise = (async () => {
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
				hooks,
			});

			return wrap(async (args, context) => {
				const result = await handler(args, context);
				return buildToolResult(result);
			});
		})();
		return wrapperPromise;
	}

	// The callback McpServer.registerTool() invokes. Defers all payment wiring
	// to the first real call.
	return async function paidToolCallback(args, context) {
		// Reviewer entitlement: run the real handler with no payment wrapper and
		// no charge so a connector reviewer gets a genuine result instead of a 402.
		// The handler shape is identical to the paid path (buildToolResult), and
		// every handler reads only `args` — context is passed through for parity.
		if (reviewModeActive()) {
			const result = await handler(args, context);
			return buildToolResult(result);
		}
		const wrapped = await getWrapper();
		const result = await wrapped(args, context);
		return annotatePaymentRequired(result, { toolName, priceUsd });
	};
}

// Make the @x402/mcp PaymentRequired result self-explanatory to a human
// reviewing the connector, WITHOUT breaking x402 interop. The official x402
// client keys off BOTH `isError: true` and the `structuredContent` envelope to
// auto-detect-and-pay, so we keep them byte-for-byte and only APPEND a
// plain-language content block stating the price, the asset (USDC on Solana),
// the recipient, and how to proceed — so a 402 reads as the expected paid-tool
// response, never a crash. A non-challenge result passes through untouched.
function annotatePaymentRequired(result, { toolName, priceUsd }) {
	const sc = result?.structuredContent;
	const isChallenge = sc && sc.x402Version != null && Array.isArray(sc.accepts);
	if (!isChallenge) return result;
	const accept = sc.accepts[0] || {};
	const human =
		`Payment required — this is the EXPECTED response for a paid tool, not an error. ` +
		`Calling "${toolName}" costs ${priceUsd} in USDC on Solana` +
		`${accept.payTo ? ` (paid to ${accept.payTo})` : ''}. ` +
		`To execute it, supply an x402 "exact" payment in _meta["x402/payment"] and call again, ` +
		`or set the reviewer entitlement (MCP_REVIEW_MODE) to run it without payment. ` +
		`Full machine-readable requirements are in structuredContent.accepts.`;
	const content = Array.isArray(result.content) ? [...result.content] : [];
	content.push({ type: 'text', text: human });
	return { ...result, content };
}

/**
 * Wrap a tool handler as a FREE (no-payment) MCP tool callback — the
 * counterpart to `paid()` for tools the platform offers at zero cost (the free
 * NVIDIA NIM / Microsoft TRELLIS text→3D lane).
 *
 * It funnels the handler's return value through the SAME `buildToolResult`
 * envelope every paid tool uses (text mirror + structuredContent + isError on
 * `toolError`), so a free tool is indistinguishable from a paid one to the
 * client EXCEPT that it never emits a 402 PaymentRequired challenge and never
 * touches payment env: no x402 resource server, no facilitator, no pay-to
 * address. That keeps the free lane working on a deployment that has not
 * configured MCP_SVM_PAYMENT_ADDRESS at all.
 *
 * @param {object} cfg
 * @param {string} cfg.toolName      — e.g. "forge_free" (used only in error messages)
 * @param {object} [cfg.inputSchema] — JSON Schema for the args (parity with paid(); unused here)
 * @param {Function} handler         — async (args, context) → result
 * @returns {Function} MCP tool callback for McpServer.registerTool()
 */
export function free(cfg, handler) {
	const { toolName } = cfg || {};
	if (!toolName) throw new Error('free(): toolName is required');
	if (typeof handler !== 'function') throw new Error('free(): handler must be a function');
	return async function freeToolCallback(args, context) {
		const result = await handler(args, context);
		return buildToolResult(result);
	};
}

/**
 * Build the MCP `CallToolResult` envelope from a handler's return value.
 *
 * This is the single place every tool's output is shaped — paid (via `paid()`)
 * and free (via `free()`) alike — so every tool gets the same modern MCP
 * contract:
 *
 *   - `content[0].text` — the JSON (or raw string) blob. Always present, so
 *     pre-2025-06-18 clients that only read text keep working unchanged.
 *   - `structuredContent` — the handler's object verbatim, surfaced as MCP
 *     structured tool output (spec 2025-06-18). Clients that support it get a
 *     ready-to-use object and skip the `JSON.parse(content[0].text)` dance.
 *     Only emitted for plain objects (the spec requires an object, not an
 *     array or scalar); string/array returns fall back to text-only.
 *   - `isError: true` — set ONLY for the explicit `toolError()` envelope
 *     (`ok === false`). This flags the failure to the LLM AND, via the x402
 *     payment wrapper, cancels the payment instead of settling it — so a caller
 *     is never charged for an invalid-input / provider / timeout error. It is
 *     deliberately NOT set for partial-data successes (e.g. a snapshot whose
 *     `price` sub-field carries `{ error }` but whose overall call succeeded),
 *     which have no top-level `ok: false`.
 *
 * @param {unknown} result  — whatever the tool handler returned
 * @returns {{ content: Array<{type:'text',text:string}>, structuredContent?: object, isError?: true }}
 */
export function buildToolResult(result) {
	const text = typeof result === 'string' ? result : JSON.stringify(result);
	const envelope = { content: [{ type: 'text', text }] };
	const isPlainObject = result !== null && typeof result === 'object' && !Array.isArray(result);
	if (isPlainObject) {
		envelope.structuredContent = result;
		if (result.ok === false) {
			envelope.isError = true;
		}
	}
	return envelope;
}

/**
 * Standard tool error envelope. Every tool's error path returns this shape so
 * MCP clients can branch on a stable `{ ok: false, error: <code>, message }`
 * contract instead of the per-tool ad-hoc shapes this server used to emit.
 *
 * @param {string} code     — machine-readable error code (snake_case)
 * @param {string} message  — human-readable explanation
 * @param {object} [extra]  — optional extra fields merged into the envelope
 * @returns {{ ok: false, error: string, message: string }}
 */
export function toolError(code, message, extra) {
	return { ok: false, error: code, message, ...(extra || {}) };
}

export { NETWORK_SOLANA_MAINNET };
