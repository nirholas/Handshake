// @three-ws/x402-server — the SELLER half of x402.
//
// Framework-agnostic merchant middleware + primitives that issue a 402 Payment
// Required challenge, verify the buyer's X-PAYMENT header against a facilitator,
// run the work, settle on-chain, and emit the X-PAYMENT-RESPONSE receipt — the
// exact verify → dispatch → settle order the three.ws rails enforce in
// production. This is NOT the buyer side: it never signs or pays. Pair it with
// the buyer-side @three-ws/x402-fetch in a test.
//
// Every wire shape here is grounded in the real platform source:
//   - challenge envelope + accept entries → api/_lib/x402-spec.js (build402Body /
//     paymentRequirements)
//   - facilitator /verify + /settle bodies → api/_lib/x402-spec.js
//     (callFacilitator: { x402Version, paymentPayload, paymentRequirements })
//   - fee split (clamp 10%, carved out of price, never marks up the buyer) →
//     api/_lib/marketplace-platform-fee.js
//
// See README.md for the full reference.

import { createHttp, ThreeWsError } from './http.js';

export { ThreeWsError, PaymentRequiredError, DEFAULT_BASE_URL } from './http.js';

// v2 wire format (api/_lib/x402-spec.js X402_VERSION).
export const X402_VERSION = 2;

// CAIP-2 network IDs, mirrored from x402-spec.js. Solana mainnet uses the
// truncated genesis-block hash; EVM uses eip155:<chainId>.
export const NETWORK_SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const NETWORK_BASE_MAINNET = 'eip155:8453';
export const NETWORK_BASE_SEPOLIA = 'eip155:84532';

// The facilitator that settles Solana + Base by default. PayAI's public
// facilitator is the platform default in api/_lib/env.js
// (X402_FACILITATOR_URL_SOLANA / _BASE both fall back to it). Override per-route
// with the `facilitator` option.
export const DEFAULT_FACILITATOR_URL = 'https://facilitator.payai.network';

// Hard ceiling on the platform fee — a guard so a fat-fingered config can never
// charge an absurd fee (api/_lib/marketplace-platform-fee.js MAX_FEE_BPS).
export const MAX_FEE_BPS = 1000; // 10%

// Canonical USDC addresses per lane (api/_lib/env.js defaults). `asset: 'usdc'`
// resolves to these; pin explicit addresses with `asset: { solana, base }`.
const CANONICAL_USDC = {
	solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
	// Circle's Base Sepolia testnet USDC — a distinct mint from Base mainnet.
	// Advertising the mainnet address on a testnet accept makes the facilitator
	// verify against a token the buyer never signed for.
	'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

// $THREE — the three.ws platform token, the second main x402 settlement asset
// alongside USDC. Solana-only (it's an SPL mint). `asset: 'three'` resolves to
// it; `acceptThree: true` advertises it next to USDC on the Solana lane, exactly
// as api/_lib/x402-spec.js does server-side. 6 decimals.
const CANONICAL_THREE = {
	solana: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
};
const THREE_DECIMALS = 6;

// Maps the ergonomic lane name → CAIP-2 network id. Solana leads when both are
// present, matching paymentRequirements()'s Solana-first ordering.
const LANE_NETWORK = {
	solana: NETWORK_SOLANA_MAINNET,
	base: NETWORK_BASE_MAINNET,
	'base-sepolia': NETWORK_BASE_SEPOLIA,
};

const LANES = ['solana', 'base', 'base-sepolia'];

/**
 * Create an x402-server client bound to a facilitator URL, fetch, and optional
 * auth headers. Most callers can use the zero-config defaults
 * (`buildChallenge`/`verifyPayment`/`settlePayment`/`paid`); use this to reuse a
 * facilitator override or a custom fetch across many routes.
 *
 * @param {object} [options]
 * @param {string} [options.facilitator]  facilitator base URL for /verify + /settle.
 * @param {string} [options.baseUrl]  alias for `facilitator` (resolved the same way).
 * @param {typeof fetch} [options.fetch]  fetch implementation (default global fetch).
 * @param {string} [options.apiKey]  bearer token attached to facilitator calls.
 * @param {Record<string,string>} [options.headers]  default headers on every call.
 */
export function createX402Server(options = {}) {
	const facilitatorUrl = options.facilitator || options.baseUrl || DEFAULT_FACILITATOR_URL;
	const request = createHttp({ ...options, baseUrl: facilitatorUrl });

	/**
	 * Build the v2 402 envelope: `{ x402Version, error, resource, accepts,
	 * extensions }` — the same object you base64 into the PAYMENT-REQUIRED header.
	 * Mirrors api/_lib/x402-spec.js build402Body + paymentRequirements.
	 */
	function buildChallenge(opts = {}) {
		return buildChallengeEnvelope(opts);
	}

	/**
	 * Decode the base64 X-PAYMENT header and verify it against `requirements` (the
	 * accepts[] you advertised) via the facilitator's /verify. Returns
	 * `{ ok: true, payer, accept, raw }` on success, or `{ ok: false, code,
	 * reason, body }` (a fresh 402 body) on a rejected/under-paid payment.
	 * **Run the work only when `ok`.** Mirrors x402-spec.js verifyPayment.
	 */
	async function verifyPayment(args = {}, expected) {
		// Two call shapes: verifyPayment({ paymentHeader, requirements }) and the
		// README's positional verifyPayment(xPaymentHeader, expected).
		let header;
		let requirements;
		let signal;
		if (typeof args === 'string') {
			header = args;
			requirements = expectedToRequirements(expected);
		} else {
			header = args.paymentHeader ?? args.xPaymentHeader;
			requirements = expectedToRequirements(args.requirements ?? expected);
			signal = args.signal;
		}
		return runVerify({ request, paymentHeader: header, requirements, signal });
	}

	/**
	 * Settle a verified payment on-chain via the facilitator's /settle and return
	 * the receipt `{ network, payer, transaction, raw }` — the object you base64
	 * into the X-PAYMENT-RESPONSE header. Run this AFTER the work succeeds, never
	 * before. Mirrors x402-spec.js settlePayment.
	 */
	async function settlePayment(args = {}) {
		const verified = args.verified || args;
		return runSettle({ request, verified, signal: args?.signal });
	}

	/**
	 * Wrap a request handler so it requires payment. Returns a `(req, res, next?)`
	 * function usable as Express/Connect middleware, a Vercel/Node http handler,
	 * or — via the `adapter` option — a fetch-style `(request) => Response`
	 * handler. Unpaid requests get a 402 challenge; paid ones verify → run the
	 * handler → settle.
	 */
	function paid(opts, handler) {
		return buildPaidHandler({ buildChallenge, verifyPayment, settlePayment }, opts, handler);
	}

	return { buildChallenge, verifyPayment, settlePayment, paid };
}

// A lazily-created shared client backs the zero-config default functions, so
// `import { paid }` works with no setup (mirrors forge's defaultClient()).
let shared = null;
function defaultClient() {
	return (shared ||= createX402Server());
}

/** Build the v2 402 challenge envelope. */
export function buildChallenge(opts) {
	return defaultClient().buildChallenge(opts);
}
/** Verify an X-PAYMENT header against the offered requirements. */
export function verifyPayment(args, expected) {
	return defaultClient().verifyPayment(args, expected);
}
/** Settle a verified payment and return its receipt. */
export function settlePayment(args) {
	return defaultClient().settlePayment(args);
}
/** Wrap a handler so it demands payment (Express / Vercel / fetch-style). */
export function paid(opts, handler) {
	return defaultClient().paid(opts, handler);
}

// ── Challenge construction ───────────────────────────────────────────────

// Build one v2 accept entry per advertised lane, in the platform's Solana-first
// order. Each entry carries scheme/network/amount/asset/payTo/maxTimeoutSeconds
// + the per-lane `extra` block (Solana needs a feePayer; Base pins the EIP-712
// domain name "USD Coin"). Grounded in paymentRequirements().
function buildAccepts({ price, asset, payTo, network, feePayer, maxTimeoutSeconds, resourceUrl, acceptThree, threeAmount }) {
	if (price === undefined || price === null || String(price) === '') {
		throw new ThreeWsError('buildChallenge() needs a `price` in atomic units.', { code: 'invalid_input' });
	}
	const amount = String(price);
	if (!/^\d+$/.test(amount)) {
		throw new ThreeWsError(`price must be a whole atomic amount string, got "${amount}".`, { code: 'invalid_input' });
	}
	if (!payTo || typeof payTo !== 'object') {
		throw new ThreeWsError('buildChallenge() needs `payTo` with at least one lane (solana / base).', { code: 'invalid_input' });
	}

	// Which lanes to advertise: explicit `network`, else every lane present in
	// payTo (Solana leads).
	const requested = network ? (Array.isArray(network) ? network : [network]) : LANES.filter((l) => payTo[l]);
	const lanes = [...new Set(requested)];

	// Validate the optional flat $THREE amount once, up front. Omit → reuse the
	// USDC `price`.
	let threeAmt = null;
	if (acceptThree) {
		threeAmt = threeAmount === undefined || threeAmount === null || String(threeAmount) === '' ? amount : String(threeAmount);
		if (!/^\d+$/.test(threeAmt)) {
			throw new ThreeWsError(`threeAmount must be a whole atomic amount string, got "${threeAmt}".`, { code: 'invalid_input' });
		}
	}

	const out = [];
	for (const lane of lanes) {
		if (!LANES.includes(lane)) {
			throw new ThreeWsError(`Unknown network lane "${lane}". Expected one of: ${LANES.join(', ')}.`, { code: 'invalid_input' });
		}
		const to = payTo[lane];
		if (!to) {
			throw new ThreeWsError(`network includes "${lane}" but payTo.${lane} is not set.`, { code: 'invalid_input' });
		}
		out.push(buildAccept({ lane, amount, asset, payTo: to, feePayer, maxTimeoutSeconds, resourceUrl }));
		// $THREE rides immediately after the USDC Solana accept — the platform's
		// two main assets, Solana-first — so a wallet's token chooser surfaces both
		// while a first-accept client still settles USDC. Mirrors paymentRequirements().
		if (lane === 'solana' && acceptThree) {
			out.push(buildAccept({ lane: 'solana', amount: threeAmt, asset: 'three', payTo: to, feePayer, maxTimeoutSeconds, resourceUrl }));
		}
	}
	if (!out.length) {
		throw new ThreeWsError('No payable lanes — set payTo for solana and/or base.', { code: 'invalid_input' });
	}
	return out;
}

function buildAccept({ lane, amount, asset, payTo, feePayer, maxTimeoutSeconds, resourceUrl }) {
	const network = LANE_NETWORK[lane];
	const assetAddress = resolveAsset(asset, lane);
	const accept = {
		scheme: 'exact',
		network,
		amount,
		asset: assetAddress,
		payTo,
		maxTimeoutSeconds: Number.isInteger(maxTimeoutSeconds) && maxTimeoutSeconds > 0 ? maxTimeoutSeconds : 60,
		...(resourceUrl ? { resource: resourceUrl } : {}),
	};
	if (lane === 'solana') {
		// PayAI's Solana facilitator rejects with `missing_fee_payer` unless the
		// accept advertises the sponsor account that co-signs the SPL transfer.
		if (!feePayer) {
			throw new ThreeWsError('Solana accepts need a `feePayer` (the facilitator sponsor account) — set X402_FEE_PAYER_SOLANA.', { code: 'missing_fee_payer' });
		}
		// `extra` names the settlement token — $THREE when this is a THREE accept,
		// USDC otherwise — so a wallet labels the choice correctly.
		const isThree = asset === 'three' || assetAddress === CANONICAL_THREE.solana;
		accept.extra = isThree
			? { name: 'THREE', decimals: THREE_DECIMALS, feePayer }
			: { name: 'USDC', decimals: 6, feePayer };
	} else {
		// `name` MUST match the on-chain EIP-712 domain. Base USDC's domain name
		// is "USD Coin" (not "USDC") — using "USDC" recomputes the wrong domain
		// hash and the facilitator rejects the signature.
		accept.extra = { name: 'USD Coin', version: '2', decimals: 6 };
	}
	return accept;
}

function resolveAsset(asset, lane) {
	if (asset === 'three') {
		// $THREE is an SPL mint — Solana only. Advertising it on an EVM lane is a
		// misconfiguration, not a silent USDC fallback.
		if (lane !== 'solana') {
			throw new ThreeWsError(`$THREE settlement is Solana-only — lane "${lane}" can't advertise THREE.`, { code: 'invalid_input' });
		}
		return CANONICAL_THREE.solana;
	}
	if (!asset || asset === 'usdc') return CANONICAL_USDC[lane];
	if (typeof asset === 'string') return asset;
	if (typeof asset === 'object') {
		// A pin can target the exact lane, or `base` can stand in for `base-sepolia`.
		const pinned = asset[lane] ?? (lane === 'base-sepolia' ? asset.base : undefined);
		return pinned || CANONICAL_USDC[lane];
	}
	return CANONICAL_USDC[lane];
}

// Assemble the full v2 envelope. Accepts either a pre-built `accepts[]` (raw
// path from the README) or the ergonomic { price, asset, payTo, ... } shape.
function buildChallengeEnvelope({
	price,
	asset,
	payTo,
	network,
	feeBps,
	feeTo,
	feePayer,
	acceptThree,
	threeAmount,
	accepts,
	maxTimeoutSeconds,
	resourceUrl,
	description,
	mimeType = 'application/json',
	serviceName,
	tags,
	iconUrl,
	error = 'X-PAYMENT header is required',
	extensions: extraExtensions,
} = {}) {
	const list = Array.isArray(accepts) && accepts.length
		? accepts
		: buildAccepts({ price, asset, payTo, network, feePayer, maxTimeoutSeconds, resourceUrl, acceptThree, threeAmount });

	const resource = { url: resourceUrl ?? null, mimeType };
	if (typeof description === 'string' && description.length) resource.description = description;
	if (typeof serviceName === 'string' && serviceName.length) resource.serviceName = serviceName.slice(0, 32);
	if (Array.isArray(tags) && tags.length) resource.tags = tags.slice(0, 5);
	if (typeof iconUrl === 'string' && iconUrl.length) resource.iconUrl = iconUrl;

	const extensions = { ...(extraExtensions || {}) };

	const envelope = {
		x402Version: X402_VERSION,
		error,
		resource,
		accepts: list,
		extensions,
	};

	// Surface the fee plan when configured — split out of the price, never marked
	// up onto the buyer. `null` means no fee applies (see feeSplit).
	if (feeBps != null && feeTo) {
		envelope.fee = feeSplit(list[0]?.amount ?? price, feeBps, feeTo);
	}
	return envelope;
}

// ── Fee split ────────────────────────────────────────────────────────────

/**
 * Split a platform fee OUT of the listed price: `fee = floor(price × bps /
 * 10_000)`, `net = price − fee`. The buyer's total is never marked up — they
 * pay `price`, the creator nets `net`, the treasury receives `fee`. Returns
 * `null` when no fee applies (rate 0, no recipient, or a sub-atomic fee) so the
 * creator receives the whole price. `bps` is clamped to `[0, MAX_FEE_BPS]`.
 * Mirrors api/_lib/marketplace-platform-fee.js (resolveMarketplaceFee).
 *
 * @param {bigint|number|string} priceAtomics
 * @param {number} bps
 * @param {string} recipient
 * @returns {{ price: string, net: string, fee: string, bps: number, recipient: string } | null}
 */
export function feeSplit(priceAtomics, bps, recipient) {
	const clamped = clampBps(bps);
	if (clamped <= 0 || !recipient) return null;

	let price;
	try {
		price = BigInt(String(priceAtomics ?? '0').split('.')[0]);
	} catch {
		return null;
	}
	if (price <= 0n) return null;

	const fee = (price * BigInt(clamped)) / 10_000n;
	if (fee <= 0n) return null; // sub-atomic fee — charge nothing, creator keeps all

	return {
		price: price.toString(),
		net: (price - fee).toString(),
		fee: fee.toString(),
		bps: clamped,
		recipient,
	};
}

function clampBps(bps) {
	const n = Number(bps);
	if (!Number.isFinite(n) || n < 0) return 0;
	return Math.min(Math.floor(n), MAX_FEE_BPS);
}

// ── Verify / settle ───────────────────────────────────────────────────────

function decodePaymentHeader(header) {
	if (!header) {
		throw new ThreeWsError('X-PAYMENT header is required.', { code: 'payment_required', status: 402 });
	}
	let json;
	try {
		json = base64Decode(String(header));
	} catch (err) {
		throw new ThreeWsError(`X-PAYMENT base64 decode failed: ${err?.message || err}`, { code: 'invalid_payment', status: 400 });
	}
	let payload;
	try {
		payload = JSON.parse(json);
	} catch (err) {
		throw new ThreeWsError(`X-PAYMENT JSON parse failed: ${err?.message || err}`, { code: 'invalid_payment', status: 400 });
	}
	if (!payload || typeof payload !== 'object') {
		throw new ThreeWsError('X-PAYMENT must decode to a JSON object.', { code: 'invalid_payment', status: 400 });
	}
	return payload;
}

// Match the decoded payload to one of the offered requirements by network,
// falling back to the first entry. Mirrors x402-spec.js selectRequirement's
// non-EVM path (the facilitator does the deep EIP-712/Permit2 matching).
function selectRequirement(paymentPayload, requirements) {
	const network = paymentPayload?.network || paymentPayload?.accepted?.network;
	if (network) {
		const found = requirements.find((r) => r.network === network);
		if (!found) {
			throw new ThreeWsError(`payment network "${network}" is not offered by this resource.`, { code: 'unsupported_network', status: 400 });
		}
		return found;
	}
	return requirements[0];
}

async function runVerify({ request, paymentHeader, requirements, signal }) {
	const all = Array.isArray(requirements) ? requirements : [requirements];
	const payable = all.filter(Boolean);
	if (!payable.length) {
		throw new ThreeWsError('verifyPayment() needs the `requirements` (your accepts[]) to match against.', { code: 'invalid_input' });
	}

	let paymentPayload;
	let requirement;
	try {
		paymentPayload = decodePaymentHeader(paymentHeader);
		requirement = selectRequirement(paymentPayload, payable);
	} catch (err) {
		// Surface a rejected payment as a structured result (not a throw) plus a
		// fresh 402 body — `paid()` re-challenges the buyer.
		return rejected(err, payable);
	}

	let result;
	try {
		result = await request('/verify', {
			method: 'POST',
			body: { x402Version: X402_VERSION, paymentPayload, paymentRequirements: requirement },
			signal,
		});
	} catch (err) {
		// A facilitator outage is NOT a rejected payment — no funds moved, safe to
		// retry. Bubble it as a typed error so paid() maps it to 502.
		throw mapFacilitatorError(err, '/verify');
	}

	if (!result || result.isValid !== true) {
		const reason = result?.invalidReason || 'payment rejected by facilitator';
		return rejected(new ThreeWsError(`payment rejected: ${reason}`, { code: 'invalid_payment', status: 402 }), payable);
	}

	return {
		ok: true,
		payer: result.payer || null,
		network: requirement.network,
		amount: requirement.amount,
		accept: requirement,
		paymentPayload,
		requirement,
		raw: result,
	};
}

async function runSettle({ request, verified, signal }) {
	const paymentPayload = verified?.paymentPayload;
	const requirement = verified?.requirement || verified?.accept;
	if (!requirement || !paymentPayload) {
		throw new ThreeWsError('settlePayment() requires the object returned by verifyPayment().', { code: 'invalid_input' });
	}

	let result;
	try {
		result = await request('/settle', {
			method: 'POST',
			body: { x402Version: X402_VERSION, paymentPayload, paymentRequirements: requirement },
			signal,
		});
	} catch (err) {
		// Verified + work ran, but settlement status is unknown — the caller must
		// check on-chain before retrying to avoid double-paying.
		throw mapFacilitatorError(err, '/settle', 'settle_uncertain');
	}

	if (!result || result.success !== true) {
		throw new ThreeWsError(`settle failed: ${result?.errorReason || 'unknown reason'}`, { code: 'settle_failed', status: 502, body: result });
	}

	// Cross-check the facilitator's claimed network/payer against what we verified
	// (defense-in-depth, mirrors x402-spec.js settlePayment).
	if (result.network && requirement.network && result.network !== requirement.network) {
		throw new ThreeWsError(`facilitator /settle network mismatch: requested ${requirement.network}, got ${result.network}.`, { code: 'facilitator_bad_response', status: 502 });
	}
	if (verified.payer && result.payer && String(result.payer).toLowerCase() !== String(verified.payer).toLowerCase()) {
		throw new ThreeWsError(`facilitator /settle payer mismatch: verified ${verified.payer}, settled ${result.payer}.`, { code: 'facilitator_bad_response', status: 502 });
	}

	return {
		network: result.network || requirement.network,
		payer: result.payer || verified.payer || null,
		transaction: result.transaction || null,
		raw: result,
	};
}

// A rejected (under-paid / malformed / wrong-network) payment → a structured
// result carrying a fresh 402 body so paid() can re-challenge.
function rejected(err, requirements) {
	const code = err?.code || 'payment_required';
	const status = err?.status === 400 ? 402 : err?.status || 402;
	return {
		ok: false,
		code,
		status,
		reason: err?.message || 'payment required',
		body: {
			x402Version: X402_VERSION,
			error: err?.message || 'payment required',
			accepts: requirements,
		},
	};
}

// A facilitator that is unreachable or 5xx is a transient infra fault, never a
// rejected payment. `/verify` failures mean no funds moved; `/settle` failures
// are uncertain (verified + work ran).
function mapFacilitatorError(err, path, fallbackCode = 'facilitator_unreachable') {
	if (err instanceof ThreeWsError && err.code !== 'network_error' && err.status && err.status < 500) {
		return err;
	}
	const code = err?.code === 'network_error' ? fallbackCode : (err?.code || fallbackCode);
	return new ThreeWsError(`facilitator ${path} failed: ${err?.message || err}`, {
		code: fallbackCode === 'settle_uncertain' ? 'settle_uncertain' : code,
		status: 502,
		body: err?.body ?? null,
	});
}

// ── paid() middleware factory ──────────────────────────────────────────────

// A tiny adapter layer lets one factory serve Express/Connect/Vercel (`req,res`)
// AND fetch-style (`Request → Response`) runtimes. The default adapter reads
// node-style req/res; pass `{ adapter: fetchAdapter }` for the fetch lane.

function buildPaidHandler({ buildChallenge, verifyPayment, settlePayment }, opts = {}, handler) {
	if (typeof handler !== 'function') {
		throw new ThreeWsError('paid(options, handler) needs a handler function.', { code: 'invalid_input' });
	}
	const {
		price,
		asset = 'usdc',
		payTo,
		network,
		feeBps = 0,
		feeTo,
		feePayer,
		facilitator,
		maxTimeoutSeconds,
		description,
		serviceName,
		tags,
		iconUrl,
		onSettled,
		// Response ordering. Default (false) is DELIVER-THEN-SETTLE: run the work,
		// settle, then flush the response with the X-PAYMENT-RESPONSE receipt
		// header attached — the buyer never receives the good before the payment
		// settles. Set `streaming: true` for handlers that must write their own
		// body (binary download, SSE, res.pipe): settlement runs FIRST and the
		// receipt header is emitted up-front, so a self-flushing handler is paid
		// by construction. Mirrors api/_lib/x402-paid-endpoint.js.
		streaming = false,
		adapter = nodeAdapter,
	} = opts;

	// Validate the fee config up front: a fee needs both a rate and a recipient,
	// or it ships inert (rate 0 → no fee, no surprise billing).
	if (feeBps > 0 && !feeTo) {
		throw new ThreeWsError('feeBps > 0 requires feeTo (the fee recipient) — no recipient, no fee.', { code: 'invalid_input' });
	}

	// One route-scoped server when a custom facilitator is set (reused for both
	// verify and settle); else the shared default client.
	const scoped = facilitator ? createX402Server({ facilitator }) : null;
	const verify = scoped ? scoped.verifyPayment : verifyPayment;
	const settle = scoped ? scoped.settlePayment : settlePayment;

	async function runSettle(verified) {
		const receipt = await settle({ verified });
		if (typeof onSettled === 'function') {
			try { onSettled(receipt); } catch { /* a webhook/log error must not unsettle a paid call */ }
		}
		return receipt;
	}

	return async function paidHandler(...args) {
		const ctx = adapter.read(...args);
		const challengeBody = buildChallenge({
			price, asset, payTo, network, feePayer, maxTimeoutSeconds,
			resourceUrl: ctx.url, description, serviceName, tags, iconUrl, feeBps, feeTo,
		});
		const accepts = challengeBody.accepts;

		const header = ctx.header('x-payment');
		if (!header) {
			return adapter.challenge(ctx, challengeBody, args);
		}

		// 1 — verify. No work runs unless the payment is valid.
		const verified = await verify({ paymentHeader: header, requirements: accepts });
		if (!verified.ok) {
			return adapter.challenge(ctx, verified.body || challengeBody, args, verified.status || 402);
		}

		const payment = {
			payer: verified.payer,
			network: verified.network,
			amount: verified.amount,
			accept: verified.accept,
		};

		// Streaming (settle-then-stream): settle up-front, emit the receipt header,
		// then let the handler own the response body. Requires an adapter that can
		// stream (node); other adapters fall back to deliver-then-settle.
		if (streaming && typeof adapter.stream === 'function') {
			const receipt = await runSettle(verified);
			return adapter.stream(ctx, handler, payment, receipt, args);
		}

		// 2 — dispatch the work. The adapter buffers any response the handler
		// writes so nothing reaches the buyer before settlement. A throw here
		// SKIPS settlement (no funds move on a failed call) and surfaces a 500.
		let dispatched;
		try {
			dispatched = await adapter.dispatch(ctx, handler, payment, args);
		} catch (err) {
			return adapter.fail(ctx, err, args);
		}
		if (dispatched && dispatched.__handled) return dispatched.value;

		// 3 — settle, AFTER the work succeeded. Settlement is the last step, and
		// the buffered response is flushed with the receipt header in respond().
		const receipt = await runSettle(verified);
		return adapter.respond(ctx, dispatched, receipt, args);
	};
}

// Node / Express / Vercel adapter: `(req, res)`.
//
// The buyer must never receive the good before settlement, and the 200 must
// carry the base64 X-PAYMENT-RESPONSE receipt. A handler that writes its own
// response (`res.json`/`res.send`/`res.end`) would flush both problems away, so
// dispatch() BUFFERS every write; respond() then settles, injects the receipt
// header, and flushes for real. Handlers may also just RETURN a value — the
// wrapper serialises it. Streaming handlers opt out via `streaming: true`.
const nodeAdapter = {
	read(req, res) {
		return {
			req,
			res,
			url: absoluteUrl(req),
			header: (name) => headerOf(req, name),
		};
	},
	challenge(ctx, body, _args, status = 402) {
		const { res } = ctx;
		res.statusCode = status;
		res.setHeader?.('content-type', 'application/json; charset=utf-8');
		res.setHeader?.('cache-control', 'no-store');
		// v2: the same envelope ships base64 in the PAYMENT-REQUIRED header so a
		// Bazaar validator reads discovery off the header during its probe.
		res.setHeader?.('PAYMENT-REQUIRED', base64Encode(JSON.stringify(body)));
		res.end?.(JSON.stringify(body));
		return undefined;
	},
	// Run the (req, res, payment) handler with a buffered response so no bytes
	// reach the buyer until settlement. Captures the handler's return value too,
	// for handlers that return a value instead of writing.
	async dispatch(ctx, handler, payment) {
		ctx._buffer = bufferNodeResponse(ctx.res);
		const value = await handler(ctx.req, ctx.res, payment);
		return { __handled: false, value };
	},
	respond(ctx, dispatched, receipt) {
		const { res } = ctx;
		const buffer = ctx._buffer;
		const receiptHeader = base64Encode(JSON.stringify(receipt));

		// Write-style handler (Express res.json/send/end): flush the buffered
		// response with the receipt header injected ahead of the real end().
		if (buffer && buffer.ended) {
			buffer.flush({ 'X-PAYMENT-RESPONSE': receiptHeader });
			return receipt;
		}

		// Return-value handler: the handler returned a value without writing.
		// Serialise it as JSON with the receipt header. Restore the real methods
		// first so our end() below actually flushes.
		if (buffer) buffer.restore();
		const value = dispatched?.value;
		const body = value === undefined ? { ok: true } : value;
		if (!res.statusCode || res.statusCode === 200) res.statusCode = 200;
		try { res.setHeader?.('content-type', 'application/json; charset=utf-8'); } catch { /* headers sent */ }
		try { res.setHeader?.('X-PAYMENT-RESPONSE', receiptHeader); } catch { /* headers sent */ }
		res.end?.(typeof body === 'string' ? body : JSON.stringify(body));
		return receipt;
	},
	// settle-then-stream: settlement already ran; attach the receipt header
	// up-front, then hand the raw response to the (self-flushing) handler.
	async stream(ctx, handler, payment, receipt) {
		const { res } = ctx;
		try { res.setHeader?.('X-PAYMENT-RESPONSE', base64Encode(JSON.stringify(receipt))); } catch { /* headers sent */ }
		await handler(ctx.req, ctx.res, payment);
		return receipt;
	},
	// The work threw AFTER a valid payment but BEFORE settlement — no funds
	// moved. Discard any buffered partial output and return a clean 500 so the
	// buyer can retry (their payment authorization is still spendable).
	fail(ctx, err) {
		const { res } = ctx;
		const buffer = ctx._buffer;
		if (buffer) buffer.restore();
		if (res && !res.writableEnded) {
			res.statusCode = err?.status && err.status >= 400 && err.status < 600 ? err.status : 500;
			try { res.setHeader?.('content-type', 'application/json; charset=utf-8'); } catch { /* headers sent */ }
			res.end?.(JSON.stringify({ error: err?.code || 'handler_error', message: err?.message || 'the paid work failed; payment was not settled' }));
		}
		return undefined;
	},
};

// Wrap a Node ServerResponse so writes are captured instead of flushed. Returns
// a controller: `ended` reflects whether the handler called end(); `flush(extra)`
// restores the real methods, sets `extra` headers, and emits the buffered body;
// `restore()` puts the real methods back without flushing.
function bufferNodeResponse(res) {
	const orig = { write: res.write, end: res.end, writeHead: res.writeHead };
	const chunks = [];
	const state = { ended: false, pendingCb: null };

	res.write = function bufferedWrite(chunk, enc, cb) {
		if (chunk) chunks.push(toBuffer(chunk, typeof enc === 'string' ? enc : undefined));
		const done = typeof enc === 'function' ? enc : cb;
		if (typeof done === 'function') done();
		return true;
	};
	res.end = function bufferedEnd(chunk, enc, cb) {
		if (chunk && typeof chunk !== 'function') chunks.push(toBuffer(chunk, typeof enc === 'string' ? enc : undefined));
		state.ended = true;
		state.pendingCb = typeof chunk === 'function' ? chunk : typeof enc === 'function' ? enc : typeof cb === 'function' ? cb : null;
		return res;
	};
	// Capture an explicit status (and any header map) from writeHead without
	// sending it; headers flush together at real end().
	res.writeHead = function bufferedWriteHead(status, ...rest) {
		if (typeof status === 'number') res.statusCode = status;
		const headerMap = rest.find((r) => r && typeof r === 'object' && !Array.isArray(r));
		if (headerMap && typeof res.setHeader === 'function') {
			for (const [k, v] of Object.entries(headerMap)) { try { res.setHeader(k, v); } catch { /* ignore */ } }
		}
		return res;
	};

	function restore() {
		res.write = orig.write;
		res.end = orig.end;
		res.writeHead = orig.writeHead;
	}

	return {
		get ended() { return state.ended; },
		restore,
		flush(extraHeaders) {
			restore();
			if (extraHeaders && typeof res.setHeader === 'function') {
				for (const [k, v] of Object.entries(extraHeaders)) { try { res.setHeader(k, v); } catch { /* headers sent */ } }
			}
			const body = chunks.length ? Buffer.concat(chunks) : undefined;
			if (typeof orig.end === 'function') orig.end.call(res, body);
			if (state.pendingCb) { try { state.pendingCb(); } catch { /* callback error is not ours to own */ } }
		},
	};
}

function toBuffer(chunk, enc) {
	if (Buffer.isBuffer(chunk)) return chunk;
	if (chunk instanceof Uint8Array) return Buffer.from(chunk);
	return Buffer.from(String(chunk), enc || 'utf8');
}

// Fetch-style adapter: `(request) => Response`. The handler receives
// `(request, payment)` and returns a `Response` (or a plain object → JSON).
export const fetchAdapter = {
	read(request) {
		return {
			request,
			url: request?.url || null,
			header: (name) => request?.headers?.get?.(name) ?? null,
		};
	},
	challenge(_ctx, body, _args, status = 402) {
		return jsonResponse(body, status, {
			'cache-control': 'no-store',
			'PAYMENT-REQUIRED': base64Encode(JSON.stringify(body)),
		});
	},
	async dispatch(ctx, handler, payment) {
		const value = await handler(ctx.request, payment);
		// The fetch handler returns its result; we settle, then attach the receipt
		// header to the Response in respond().
		return { __handled: false, value };
	},
	respond(_ctx, dispatched, receipt) {
		const value = dispatched?.value;
		const headers = { 'X-PAYMENT-RESPONSE': base64Encode(JSON.stringify(receipt)) };
		if (value && typeof value === 'object' && typeof value.headers?.set === 'function') {
			// It's a Response — clone and add the receipt header.
			const res = new Response(value.body, value);
			res.headers.set('X-PAYMENT-RESPONSE', headers['X-PAYMENT-RESPONSE']);
			return res;
		}
		return jsonResponse(value ?? { ok: true }, 200, headers);
	},
	// The work threw after a valid payment but before settlement — no funds
	// moved. Return a clean 500 so the buyer can retry.
	fail(_ctx, err) {
		const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 500;
		return jsonResponse({ error: err?.code || 'handler_error', message: err?.message || 'the paid work failed; payment was not settled' }, status);
	},
};

// ── small helpers ──────────────────────────────────────────────────────────

function headerOf(req, name) {
	if (!req) return null;
	const h = req.headers;
	if (!h) return null;
	if (typeof h.get === 'function') return h.get(name) ?? null;
	return h[name] ?? h[name.toLowerCase()] ?? null;
}

function absoluteUrl(req) {
	if (!req) return null;
	if (typeof req.url === 'string' && /^https?:\/\//.test(req.url)) return req.url;
	const host = headerOf(req, 'host') || 'localhost';
	const proto = headerOf(req, 'x-forwarded-proto') || 'https';
	const path = req.url || '/';
	return `${proto}://${host}${path}`;
}

function jsonResponse(body, status, headers) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
	});
}

function base64Encode(str) {
	if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf8').toString('base64');
	// Browser/Workers fallback.
	return btoa(unescape(encodeURIComponent(str)));
}

function base64Decode(str) {
	if (typeof Buffer !== 'undefined') return Buffer.from(str, 'base64').toString('utf8');
	return decodeURIComponent(escape(atob(str)));
}

// Normalize the `expected` argument (an accepts[] array, a challenge envelope,
// a { requirements } wrapper, or a single accept) into a flat requirements[].
function expectedToRequirements(expected) {
	if (!expected) return [];
	if (Array.isArray(expected)) return expected;
	if (Array.isArray(expected.accepts)) return expected.accepts;
	if (Array.isArray(expected.requirements)) return expected.requirements;
	return [expected];
}
