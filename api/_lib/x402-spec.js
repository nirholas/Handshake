// x402 protocol — facilitator-mediated micropayments.
// Spec: https://x402.org / https://github.com/coinbase/x402
//
// This module implements the *standard* x402 wire flow used by agentic.market,
// x402scan, and Coinbase's Bazaar. v2 wire format (April 2026 spec):
//
//   {
//     "x402Version": 2,
//     "error": "X-PAYMENT header is required",
//     "resource": { "url": "...", "description": "...", "mimeType": "application/json" },
//     "accepts": [
//       { "scheme": "exact", "network": "eip155:8453", "amount": "1000",
//         "asset": "0x...", "payTo": "0x...", "maxTimeoutSeconds": 60, "extra": {...} }
//     ],
//     "extensions": { "bazaar": { info: { input, output }, schema } }
//   }
//
// In addition to the body, the same envelope is emitted base64-encoded as the
// `payment-required` HTTP response header — required by agentic.market's
// Bazaar validator, which reads the header on its discovery probe.
//
// Networks use CAIP-2 IDs in v2: `eip155:<chainId>` for EVM, `solana:<genesis-prefix>`
// for Solana. The legacy `api/_lib/x402.js` is the unrelated Pump.fun agent-skill flow.
//
// Server flow on a paid resource:
//   1. No X-PAYMENT header → 402 with the body shape above.
//   2. Client retries with X-PAYMENT (base64-encoded PaymentPayload).
//   3. Server POSTs facilitator /verify with { x402Version, paymentPayload, paymentRequirements }
//      → { isValid, invalidReason?, payer? }
//   4. If isValid, do the work.
//   5. Server POSTs facilitator /settle (same body) → { success, transaction, network, payer }
//      Server attaches a base64 settlement object as `X-PAYMENT-RESPONSE` on the success reply.

import { createHash } from 'crypto';

import { createCdpAuthHeaders } from '@coinbase/x402';
import {
	EIP2612_GAS_SPONSORING,
	ERC20_APPROVAL_GAS_SPONSORING,
	declareEip2612GasSponsoringExtension,
	declareErc20ApprovalGasSponsoringExtension,
} from '@x402/extensions';

import { env } from './env.js';
import { X402Error } from './x402-errors.js';
import {
	PAYMENT_EVENT_TOPIC as BSC_PAYMENT_EVENT_TOPIC,
	settleDirectPayment,
	verifyDirectPayment,
} from './x402-bsc-direct.js';
import {
	BUILDER_CODE,
	declareBuilderCodeExtension,
	verifyClientEcho as verifyBuilderCodeEcho,
} from './x402-builder-code.js';

export { X402Error };
// Re-export both gas-sponsoring declarators together so callers building 402
// bodies don't have to mix imports between this module and @x402/extensions.
// build402Body advertises both extensions as a pair when a Permit2 accept is
// present, and the public surface should match.
export { declareEip2612GasSponsoringExtension, declareErc20ApprovalGasSponsoringExtension };
export { BUILDER_CODE, declareBuilderCodeExtension };

export const X402_VERSION = 2;

// Extension keys we advertise alongside the bazaar discovery entry. Both
// gas-sponsoring extensions are non-binding hints to clients: when a
// requirement opts into the Permit2 asset-transfer method, the facilitator
// (CDP's x402ExactPermit2Proxy) lets the payer skip broadcasting the Permit2
// approval themselves. EIP-2612 sponsorship is the preferred path for tokens
// that implement EIP-2612 (Base USDC v2 does — the facilitator submits the
// off-chain permit via settleWithPermit). ERC-20 approval sponsorship is the
// universal fallback for any other ERC-20: the client signs (but does not
// broadcast) a raw approve(Permit2, MaxUint256) tx and the facilitator
// broadcasts it atomically before settling. Legacy clients stay on the
// EIP-3009 accept entry (offered first) and ignore both extensions.
export const EIP2612_EXTENSION_KEY = EIP2612_GAS_SPONSORING.key;
export const ERC20_APPROVAL_EXTENSION_KEY = ERC20_APPROVAL_GAS_SPONSORING.key;

// CAIP-2 network IDs as advertised by Coinbase x402 facilitators (PayAI, CDP).
// Solana mainnet's CAIP-2 namespace uses the truncated genesis-block hash.
export const NETWORK_BASE_MAINNET = 'eip155:8453';
export const NETWORK_BASE_SEPOLIA = 'eip155:84532';
export const NETWORK_ARBITRUM_MAINNET = 'eip155:42161';
export const NETWORK_OPTIMISM_MAINNET = 'eip155:10';
export const NETWORK_BSC_MAINNET = 'eip155:56';
export const NETWORK_SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const NETWORK_SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

// Networks the CDP facilitator settles when credentials are configured.
const CDP_EVM_NETWORKS = new Set([
	NETWORK_BASE_MAINNET,
	NETWORK_BASE_SEPOLIA,
	NETWORK_ARBITRUM_MAINNET,
	NETWORK_OPTIMISM_MAINNET,
]);

// Networks that settle via on-chain pay(bytes32) calls rather than a
// facilitator (see x402-bsc-direct.js). The accept entry uses scheme='direct'
// and the client is responsible for broadcasting the tx + paying gas.
const DIRECT_NETWORKS = new Set([NETWORK_BSC_MAINNET]);

// Take a Base/Arbitrum/etc. EIP-3009 accept entry and return a sibling that
// asks the client to use the Permit2 asset-transfer method instead. The
// `assetTransferMethod` field is what @x402/evm's ExactEvmScheme keys on; with
// `supportsEip2612: true` set, the scheme will sign an EIP-2612 permit when
// its Permit2 allowance is insufficient and stuff it into the payment payload
// extensions for the facilitator to submit.
//
// Returns null when:
//   1. The source accept is not an EVM `exact` entry (BSC direct + Solana).
//   2. CDP credentials are missing — Permit2 settlement is a CDP-only path
//      (PayAI's facilitator only advertises `exact` with EIP-3009). Emitting
//      a Permit2 sibling we can't actually settle would mislead clients into
//      signing a typed-data we'd then reject at /verify time.
export function permit2VariantOf(accept) {
	if (!accept || accept.scheme !== 'exact') return null;
	if (typeof accept.network !== 'string' || !accept.network.startsWith('eip155:')) return null;
	if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET) return null;
	return {
		...accept,
		extra: {
			...(accept.extra || {}),
			assetTransferMethod: 'permit2',
			supportsEip2612: true,
		},
	};
}

// Emit an EIP-3009 accept followed by its Permit2 sibling. EIP-3009 stays
// first so the browser modal in public/x402.js (which only implements
// transferWithAuthorization) keeps selecting it; @x402/* SDK clients can pick
// the Permit2 entry to get gasless Permit2 onboarding via EIP-2612 sponsorship.
function pushEvmAccepts(out, accept) {
	out.push(accept);
	const sibling = permit2VariantOf(accept);
	if (sibling) out.push(sibling);
}

// One v2 PaymentRequirements entry per supported network. Base mainnet first
// — agentic.market's validator inspects the first entry for its supported-network
// check, and Base is the most broadly recognized option in the Bazaar.
//
// In v2, `resource` / `description` / `mimeType` are top-level on the 402 body
// (not per-accepts), and the price field is `amount` (not `maxAmountRequired`).
export function paymentRequirements(resourceUrl) {
	const common = {
		scheme: 'exact',
		amount: env.X402_MAX_AMOUNT_REQUIRED,
		maxTimeoutSeconds: 60,
		...(resourceUrl ? { resource: resourceUrl } : {}),
	};
	const out = [];
	if (env.X402_PAY_TO_BASE) {
		pushEvmAccepts(out, {
			...common,
			network: NETWORK_BASE_MAINNET,
			payTo: env.X402_PAY_TO_BASE,
			asset: env.X402_ASSET_ADDRESS_BASE,
			// `name` MUST match the on-chain EIP-712 domain. Base USDC's domain
			// name is "USD Coin" (not "USDC"); using "USDC" here makes the
			// facilitator recompute the wrong domain hash → invalid signature.
			extra: { name: 'USD Coin', version: '2', decimals: 6 },
		});
	}
	if (env.X402_PAY_TO_SOLANA) {
		out.push({
			...common,
			network: NETWORK_SOLANA_MAINNET,
			payTo: env.X402_PAY_TO_SOLANA,
			asset: env.X402_ASSET_MINT_SOLANA,
			// PayAI's Solana facilitator requires clients to build the SPL transfer
			// with this account as fee payer; without it, /verify rejects with
			// `missing_fee_payer`.
			extra: { name: 'USDC', decimals: 6, feePayer: env.X402_FEE_PAYER_SOLANA },
		});
	}
	if (env.X402_PAY_TO_BSC) {
		// BSC uses the contract-mediated "direct" scheme — see x402-bsc-direct.js
		// for the wire flow. Clients call ThreeWSPayments.pay(ref) themselves and
		// hand back the resulting tx hash via the X-PAYMENT header.
		out.push({
			...common,
			scheme: 'direct',
			network: NETWORK_BSC_MAINNET,
			payTo: env.X402_PAY_TO_BSC,
			asset: env.X402_ASSET_ADDRESS_BSC,
			extra: {
				name: 'Binance-Peg USD Coin',
				decimals: 6,
				contract: env.X402_PAY_TO_BSC,
				method: 'pay(bytes32)',
				eventTopic: BSC_PAYMENT_EVENT_TOPIC,
			},
		});
	}
	return out;
}

// Lazy CDP auth-headers factory. createCdpAuthHeaders() returns an async fn that,
// when invoked, returns { verify, settle, supported, list } header maps — each
// including a Correlation-Context tag and (when keys are set) a per-operation
// signed JWT in Authorization. We instantiate once per process; the inner fn
// re-signs on every call (JWTs are short-lived).
let cdpHeadersFactoryCache = null;
function getCdpHeadersFactory() {
	if (!cdpHeadersFactoryCache) {
		cdpHeadersFactoryCache = createCdpAuthHeaders(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET);
	}
	return cdpHeadersFactoryCache;
}

function facilitatorFor(network) {
	if (
		network === NETWORK_SOLANA_MAINNET ||
		network === NETWORK_SOLANA_DEVNET ||
		network === 'solana'
	)
		return { url: env.X402_FACILITATOR_URL_SOLANA, token: env.X402_FACILITATOR_TOKEN_SOLANA };
	// BSC settles via on-chain pay() — no facilitator needed. The {direct:true}
	// marker tells verifyPayment/settlePayment to bypass HTTP entirely and call
	// the local verifier in x402-bsc-direct.js.
	if (DIRECT_NETWORKS.has(network) || network === 'bsc') {
		return { direct: true };
	}
	// EVM mainnets supported by Coinbase CDP. When CDP keys are set, route all
	// of them through CDP (required for CDP Bazaar / agentic.market — only
	// endpoints whose first verify+settle is processed by CDP get cataloged).
	// Base mainnet falls back to X402_FACILITATOR_URL_BASE (PayAI by default)
	// when CDP keys are absent; other EVM chains require CDP.
	if (CDP_EVM_NETWORKS.has(network) || network === 'base') {
		if (env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET) {
			return { url: env.X402_CDP_FACILITATOR_URL, cdp: true };
		}
		if (network === NETWORK_BASE_MAINNET || network === NETWORK_BASE_SEPOLIA || network === 'base') {
			return { url: env.X402_FACILITATOR_URL_BASE, token: env.X402_FACILITATOR_TOKEN_BASE };
		}
		throw new X402Error(
			'facilitator_unconfigured',
			`network ${network} requires CDP credentials (set CDP_API_KEY_ID + CDP_API_KEY_SECRET)`,
			500,
		);
	}
	throw new X402Error('unsupported_network', `unsupported network: ${network}`, 400);
}

// Operations the CDP SDK pre-builds headers for; map our internal path to the SDK key.
const CDP_OP_FOR_PATH = { '/verify': 'verify', '/settle': 'settle', '/supported': 'supported' };

// Return { Authorization?, Correlation-Context? } for a facilitator call. For CDP
// we ask the SDK for per-operation headers (it adds telemetry + signed JWT);
// for bearer-token facilitators (PayAI self-hosted) we return a static Bearer.
// Wraps any SDK/JWT-signing error as an X402Error so the caller can map to 5xx
// cleanly instead of leaking a raw stack.
async function authHeadersFor(config, path) {
	if (config.cdp) {
		try {
			const factory = getCdpHeadersFactory();
			const all = await factory();
			const op = CDP_OP_FOR_PATH[path];
			return (op && all[op]) || {};
		} catch (err) {
			throw new X402Error(
				'facilitator_auth_failed',
				`CDP auth header generation failed: ${err.message}`,
				500,
			);
		}
	}
	return config.token ? { Authorization: `Bearer ${config.token}` } : {};
}

function decodePaymentHeader(header) {
	if (!header) throw new X402Error('payment_required', 'X-PAYMENT header required', 402);
	let json;
	try {
		json = Buffer.from(String(header), 'base64').toString('utf8');
	} catch (err) {
		throw new X402Error(
			'invalid_payment',
			`X-PAYMENT base64 decode failed: ${err.message}`,
			400,
		);
	}
	let payload;
	try {
		payload = JSON.parse(json);
	} catch (err) {
		throw new X402Error('invalid_payment', `X-PAYMENT JSON parse failed: ${err.message}`, 400);
	}
	if (!payload || typeof payload !== 'object') {
		throw new X402Error('invalid_payment', 'X-PAYMENT must decode to a JSON object', 400);
	}
	return payload;
}

function hostOf(url) {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

// Facilitator HTTP timeout. Defaults to 15s; tunable via env so chains/
// networks with congested settlement (e.g. Solana under load) don't fail
// settle for legitimate payments. Caller-supplied per-call override wins
// when present so we can keep verify quick and give settle a longer leash.
const FACILITATOR_TIMEOUT_MS_DEFAULT = (() => {
	const raw = Number(env.X402_FACILITATOR_TIMEOUT_MS);
	if (Number.isFinite(raw) && raw >= 1_000 && raw <= 120_000) return raw;
	return 15_000;
})();

// Upstream statuses that signal a transient facilitator / payment-network
// hiccup (gateway down, settlement service overloaded) rather than a rejected
// payment. A 4xx — including 402 (payment required), 409 (idempotency
// conflict), and 400-with-isValid:false — is a definitive answer and is never
// retried.
const TRANSIENT_FACILITATOR_STATUS = new Set([502, 503, 504]);

function summarizeUpstream(data, text) {
	return String(data.error || data.message || data.invalidReason || text.slice(0, 200) || '').slice(0, 300);
}

async function callFacilitator(network, path, body, { timeoutMs, idempotencyKey, retries = 1 } = {}) {
	const config = facilitatorFor(network);
	const url = `${config.url}${path}`;
	const host = hostOf(config.url);
	const headers = {
		'content-type': 'application/json',
		accept: 'application/json',
		...(await authHeadersFor(config, path)),
	};
	if (idempotencyKey) {
		// Both casing variants appear in the wild (PayAI uses `Idempotency-Key`,
		// some Cloudflare-fronted facilitators normalize to lowercase). Send both
		// for maximum compatibility — fetch headers are case-insensitive on the
		// wire so this is just a Node-level convenience.
		headers['Idempotency-Key'] = idempotencyKey;
	}
	// Retries are only safe for idempotent calls: /verify mutates no state, and
	// /settle carries the deterministic Idempotency-Key from buildIdempotencyKey
	// so a re-sent settle is de-duplicated by the facilitator instead of paying
	// twice. A settle without a key (legacy callers) gets a single attempt — we
	// won't risk a double-spend to recover from a blip.
	const retryable = path === '/verify' || Boolean(idempotencyKey);
	const serializedBody = JSON.stringify(body);

	let attempt = 0;
	for (;;) {
		let res;
		try {
			res = await fetch(url, {
				method: 'POST',
				headers,
				body: serializedBody,
				signal: AbortSignal.timeout(timeoutMs || FACILITATOR_TIMEOUT_MS_DEFAULT),
			});
		} catch (err) {
			// Network failure / timeout — transient. Retry once for idempotent
			// calls before giving up.
			if (retryable && attempt < retries) {
				attempt += 1;
				console.warn(`[x402] facilitator ${path} unreachable (host=${host}, network=${network}): ${err.message} — retry ${attempt}/${retries} in 500ms`);
				await new Promise((r) => setTimeout(r, 500));
				continue;
			}
			// Server logs keep the host for diagnosis; user-facing X402Error message
			// omits it so we don't leak internal facilitator topology to clients.
			console.warn(`[x402] facilitator ${path} unreachable (host=${host}, network=${network}): ${err.message}`);
			throw new X402Error(
				'facilitator_unreachable',
				`facilitator ${path} (network=${network}) fetch failed: ${err.message}`,
				502,
			);
		}
		const text = await res.text();
		let data = {};
		if (text) {
			try {
				data = JSON.parse(text);
			} catch {
				console.warn(`[x402] facilitator ${path} non-JSON (host=${host}, network=${network}, status=${res.status})`);
				throw new X402Error(
					'facilitator_bad_response',
					`facilitator ${path} (network=${network}) returned non-JSON (status ${res.status})`,
					502,
				);
			}
		}
		if (!res.ok) {
			// PayAI returns 400 with { isValid: false } for invalid payments —
			// pass through so verifyPayment can emit a clean 402 to the caller.
			if (path === '/verify' && data.isValid === false) return data;
			const detail = summarizeUpstream(data, text);
			// Transient upstream 5xx — the payment network or settlement service
			// blinked. Retry once for idempotent calls; the Idempotency-Key keeps
			// a re-sent settle from double-paying.
			if (retryable && TRANSIENT_FACILITATOR_STATUS.has(res.status) && attempt < retries) {
				attempt += 1;
				console.warn(`[x402] facilitator ${path} ${res.status} (host=${host}, network=${network}): ${detail} — retry ${attempt}/${retries} in 500ms`);
				await new Promise((r) => setTimeout(r, 500));
				continue;
			}
			console.warn(`[x402] facilitator ${path} ${res.status} (host=${host}, network=${network}): ${detail}`);
			throw new X402Error(
				'facilitator_error',
				`facilitator ${path} (network=${network}) ${res.status}: ${detail}`,
				502,
			);
		}
		return data;
	}
}

// Probe `/supported` on each configured facilitator and report whether the
// scheme/network pairs we advertise are actually supported. Used by
// /api/x402-status to surface misconfigurations before a paying client hits them.
//
// When CDP credentials are configured we probe every CDP-supported EVM network,
// not just Base — `wk.js` advertises Arbitrum acceptance for /api/x402/model-check
// and `permit2VariantOf` emits Permit2 siblings on any EVM `exact` accept, so
// the status surface needs to confirm the facilitator supports each of those
// networks. Without CDP creds, Base is the only EVM we can actually settle.
export async function probeFacilitators() {
	const evmNetworks = env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET
		? [...CDP_EVM_NETWORKS].filter((n) => n !== NETWORK_BASE_SEPOLIA)
		: [NETWORK_BASE_MAINNET];
	const targets = [
		...evmNetworks.map((network) => ({ network, ...facilitatorFor(network) })),
		{ network: NETWORK_SOLANA_MAINNET, ...facilitatorFor(NETWORK_SOLANA_MAINNET) },
	];
	const seen = new Map();
	const results = [];
	for (const t of targets) {
		if (!t.url) {
			results.push({
				network: t.network,
				ok: false,
				reason: 'no facilitator URL configured',
			});
			continue;
		}
		let entry = seen.get(t.url);
		if (!entry) {
			entry = (async () => {
				try {
					const probeUrl = `${t.url}/supported`;
					const headers = {
						accept: 'application/json',
						...(await authHeadersFor(t, '/supported')),
					};
					const res = await fetch(probeUrl, {
						headers,
						signal: AbortSignal.timeout(10_000),
					});
					if (!res.ok) return { error: `status ${res.status}` };
					const json = await res.json();
					return { kinds: Array.isArray(json?.kinds) ? json.kinds : [] };
				} catch (err) {
					return { error: err.message };
				}
			})();
			seen.set(t.url, entry);
		}
		const data = await entry;
		if (data.error) {
			results.push({
				network: t.network,
				url: t.url,
				ok: false,
				reason: `/supported probe failed: ${data.error}`,
			});
			continue;
		}
		const matching = data.kinds.filter(
			(k) =>
				k.scheme === 'exact' &&
				k.network === t.network &&
				(k.x402Version ?? 1) === X402_VERSION,
		);
		const supports = matching.length > 0;
		// Aggregate the extension keys the facilitator advertises for this
		// scheme/network. Each /supported `kind` carries an `extensions: string[]`
		// list (see @x402/core server schema). We surface whether each gas-
		// sponsoring extension is present so /api/x402-status can flag silently-
		// degraded setups where we advertise an extension but the facilitator
		// won't actually settle it.
		const advertisedExtensions = new Set();
		for (const k of matching) {
			if (Array.isArray(k.extensions)) {
				for (const ext of k.extensions) advertisedExtensions.add(ext);
			}
		}
		results.push({
			network: t.network,
			url: t.url,
			ok: supports,
			reason: supports
				? `facilitator advertises exact/${t.network}`
				: `facilitator does NOT advertise scheme=exact network=${t.network} (configure X402_FACILITATOR_URL_${t.network.toUpperCase()} to a facilitator that does)`,
			extensions: [...advertisedExtensions],
			supportsEip2612GasSponsoring: advertisedExtensions.has(EIP2612_EXTENSION_KEY),
			supportsErc20ApprovalGasSponsoring: advertisedExtensions.has(ERC20_APPROVAL_EXTENSION_KEY),
		});
	}
	return results;
}

// Inspect the payload to determine which asset-transfer method the client
// signed with. EIP-3009 transferWithAuthorization payloads carry
// `payload.authorization`; Permit2 PermitWitnessTransferFrom payloads carry
// `payload.permit2Authorization`. Returns null if the structure is unknown
// (e.g. Solana SPL transfer, BSC direct), in which case the caller falls back
// to the first matching network entry.
function detectAssetTransferMethod(paymentPayload) {
	const inner = paymentPayload?.payload;
	if (!inner || typeof inner !== 'object') return null;
	if (inner.permit2Authorization) return 'permit2';
	if (inner.authorization) return 'eip3009';
	return null;
}

// Match the decoded payload to one of the offered requirements. The match is
// by (network, assetTransferMethod) when we can detect the method from the
// payload shape — needed because we now publish two accept entries per EVM
// network (EIP-3009 first, Permit2 sibling second), and the facilitator's
// /verify call has to receive the same `extra` block the client signed
// against. Falls back to first-match-by-network for non-EVM payloads (Solana
// SPL, BSC direct).
function selectRequirement(paymentPayload, allRequirements) {
	const network = paymentPayload?.network || paymentPayload?.paymentRequirements?.network;
	const method = detectAssetTransferMethod(paymentPayload);
	const matchesMethod = (r) => {
		if (!method) return true;
		const reqMethod = r.extra?.assetTransferMethod || 'eip3009';
		return reqMethod === method;
	};
	if (network) {
		const found = allRequirements.find((r) => r.network === network && matchesMethod(r));
		if (!found)
			throw new X402Error(
				'unsupported_network',
				`payment network "${network}" (assetTransferMethod="${method || 'unknown'}") is not offered`,
				402,
			);
		return found;
	}
	if (method) {
		const found = allRequirements.find(matchesMethod);
		if (found) return found;
	}
	return allRequirements[0];
}

// Extract the signed amount from a v2 PaymentPayload, regardless of scheme.
// Returns a BigInt in the asset's atomic units (USDC → 6-decimal micros).
// Returns null when the payload's amount can't be located without trusting
// the facilitator — Solana SPL transfers carry the amount inside an opaque
// serialized transaction we won't parse client-side, so we leave that check
// to the facilitator + the on-chain confirmation. Returning null means
// "facilitator-trusted amount"; returning a BigInt means "we just verified
// the signed amount equals or exceeds the requirement".
//
// Defense-in-depth: a compromised facilitator could otherwise verify a
// payment for a smaller amount than the requirement and we'd happily
// deliver the resource. Per the audit, this is the underpayment vector.
function decodeSignedAmount(paymentPayload) {
	const inner = paymentPayload?.payload;
	if (!inner || typeof inner !== 'object') return null;
	// EIP-3009 transferWithAuthorization — `authorization.value` is the
	// EIP-712 typed-data field clients sign. uint256 string in atomic units.
	if (inner.authorization && typeof inner.authorization === 'object') {
		const v = inner.authorization.value;
		if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') {
			try { return BigInt(v); } catch { return null; }
		}
	}
	// Permit2 PermitWitnessTransferFrom — `permitted.amount` is what the user
	// authorizes. @x402/evm exposes the structured permit object pre-broadcast.
	if (inner.permit2Authorization && typeof inner.permit2Authorization === 'object') {
		const permitted = inner.permit2Authorization?.permit?.permitted;
		const v = permitted?.amount;
		if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') {
			try { return BigInt(v); } catch { return null; }
		}
		// Some clients flatten to `permit2Authorization.amount`.
		const flat = inner.permit2Authorization.amount;
		if (typeof flat === 'string' || typeof flat === 'number' || typeof flat === 'bigint') {
			try { return BigInt(flat); } catch { return null; }
		}
	}
	return null;
}

// Build a deterministic idempotency key per (verified-payment-payload, requirement).
// Idempotent retries of /settle (timeouts, transient 5xx) will hash to the same
// key and let the facilitator de-duplicate, preventing double-settlement. Hashing
// the full payload+requirement means two distinct payments by the same payer
// generate distinct keys.
function buildIdempotencyKey({ paymentPayload, requirement }) {
	const material = JSON.stringify({
		// Order matters for deterministic hashing — stringify the fields in a
		// fixed shape rather than the raw payload (which has insertion-order
		// dependence in some clients).
		network: requirement?.network,
		payTo: requirement?.payTo,
		asset: requirement?.asset,
		amount: requirement?.amount,
		scheme: requirement?.scheme,
		payload: paymentPayload,
	});
	return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

// Verify a base64 X-PAYMENT header against the offered requirements.
// Returns { paymentPayload, requirement, payer, directVerified? } on success.
// For direct-scheme networks (BSC), the on-chain verification result is stashed
// on `directVerified` so settlePayment can synthesise a response without
// re-hitting the RPC.
//
// `builderCode` is the extension block we declared on the 402 challenge —
// when present, we reject any payment whose `extensions[BUILDER_CODE].a`
// does not exactly echo the declared app code (anti-tamper). Built so the
// resource server enforces the echo invariant the spec normally puts on the
// facilitator — important because not every facilitator implements it yet,
// and the on-chain calldata suffix needs trustworthy `a` to be useful.
//
// When the caller doesn't pass `builderCode`, we derive it from
// X402_BUILDER_CODE_APP so the raw-verifyPayment routes (model-check,
// mint-to-mesh, revenue-vision, mcp/auth) get echo enforcement symmetric
// with build402Body's auto-declaration. Pass `builderCode: null`
// explicitly to opt out (e.g. test harnesses).
export async function verifyPayment({ paymentHeader, requirements, builderCode }) {
	const all = Array.isArray(requirements) ? requirements : [requirements];
	const paymentPayload = decodePaymentHeader(paymentHeader);
	const requirement = selectRequirement(paymentPayload, all);
	const effectiveBuilderCode =
		builderCode === undefined && env.X402_BUILDER_CODE_APP
			? declareBuilderCodeExtension({ a: env.X402_BUILDER_CODE_APP })
			: builderCode;
	if (effectiveBuilderCode) {
		const payloadBuilder = paymentPayload?.extensions?.[BUILDER_CODE];
		const echo = verifyBuilderCodeEcho({
			required: effectiveBuilderCode,
			payload: payloadBuilder,
		});
		if (!echo.ok) {
			throw new X402Error('builder_code_tampered', echo.reason, 402);
		}
	}
	// Defense-in-depth amount check. For EVM (EIP-3009 + Permit2) the signed
	// amount is inside the payload; reject under-payment before we even ask
	// the facilitator. For Solana SPL (amount inside an opaque serialized tx)
	// we still rely on the facilitator + on-chain confirmation.
	const signedAmount = decodeSignedAmount(paymentPayload);
	if (signedAmount !== null) {
		let required;
		try { required = BigInt(requirement.amount); }
		catch {
			throw new X402Error('invalid_requirement', `requirement.amount must parse as BigInt, got "${requirement.amount}"`, 500);
		}
		if (signedAmount < required) {
			throw new X402Error(
				'invalid_payment',
				`signed payment amount ${signedAmount.toString()} is below required ${required.toString()}`,
				402,
			);
		}
	}
	const config = facilitatorFor(requirement.network);
	if (config.direct) {
		const directVerified = await verifyDirectPayment({ paymentPayload, requirement });
		return {
			paymentPayload,
			requirement,
			payer: directVerified.payer,
			directVerified,
		};
	}
	const result = await callFacilitator(requirement.network, '/verify', {
		x402Version: X402_VERSION,
		paymentPayload,
		paymentRequirements: requirement,
	});
	if (!result.isValid) {
		throw new X402Error(
			'invalid_payment',
			`payment rejected: ${result.invalidReason || 'unknown reason'}`,
			402,
		);
	}
	// Facilitator response cross-check. When it echoes network/asset (most do),
	// confirm they match the requirement we sent — a compromised or buggy
	// facilitator could otherwise verify a payment intended for chain A as if
	// it were chain B. Missing echoed fields don't fail (older facilitators).
	if (result.network && result.network !== requirement.network) {
		throw new X402Error(
			'facilitator_bad_response',
			`facilitator /verify network mismatch: requested ${requirement.network}, got ${result.network}`,
			502,
		);
	}
	if (result.asset && requirement.asset && String(result.asset).toLowerCase() !== String(requirement.asset).toLowerCase()) {
		throw new X402Error(
			'facilitator_bad_response',
			`facilitator /verify asset mismatch: requested ${requirement.asset}, got ${result.asset}`,
			502,
		);
	}
	return { paymentPayload, requirement, payer: result.payer || null };
}

// Settle the verified payment on-chain via the matching facilitator.
// For direct-scheme networks (BSC), the user already broadcast the tx during
// verifyPayment — settle just synthesises the response shape callers expect.
//
// Two call shapes supported:
//   1. settlePayment({ verified })   ← preferred. `verified` is the object
//      verifyPayment returned. Payer-binding is enforced.
//   2. settlePayment({ paymentPayload, requirement, directVerified })
//      ← legacy. Payer-binding cannot be enforced (no `verified.payer`
//      anchor). Kept so external/older callers don't break, but new code
//      should pass `verified`.
export async function settlePayment(args) {
	const verified = args?.verified || null;
	const paymentPayload = verified?.paymentPayload || args?.paymentPayload;
	const requirement = verified?.requirement || args?.requirement;
	const directVerified = verified?.directVerified || args?.directVerified;
	const verifiedPayer = verified?.payer || args?.verifiedPayer || null;

	if (!requirement) {
		throw new X402Error('settle_failed', 'settlePayment requires `verified` or `requirement`', 500);
	}

	const config = facilitatorFor(requirement.network);
	if (config.direct) {
		if (!directVerified) {
			throw new X402Error(
				'settle_failed',
				'direct-scheme settle requires the verify step to run first',
				500,
			);
		}
		return settleDirectPayment({ verified: directVerified, requirement });
	}
	const idempotencyKey = buildIdempotencyKey({ paymentPayload, requirement });
	const result = await callFacilitator(
		requirement.network,
		'/settle',
		{
			x402Version: X402_VERSION,
			paymentPayload,
			paymentRequirements: requirement,
		},
		{ idempotencyKey },
	);
	if (!result.success) {
		throw new X402Error(
			'settle_failed',
			`settle failed: ${result.errorReason || 'unknown reason'}`,
			502,
		);
	}
	// Defense-in-depth: a compromised facilitator could return success for
	// settlement on a different chain or to a different recipient. Cross-check
	// the network/payer it claims against the requirement we sent and the
	// payer we verified earlier. Missing echoed fields are tolerated for
	// backward-compat with older facilitator implementations.
	if (result.network && result.network !== requirement.network) {
		throw new X402Error(
			'facilitator_bad_response',
			`facilitator /settle network mismatch: requested ${requirement.network}, got ${result.network}`,
			502,
		);
	}
	if (verifiedPayer && result.payer && String(result.payer).toLowerCase() !== String(verifiedPayer).toLowerCase()) {
		throw new X402Error(
			'facilitator_bad_response',
			`facilitator /settle payer mismatch: verified ${verifiedPayer}, settled ${result.payer}`,
			502,
		);
	}
	return result;
}

// `extensions` is the extension envelope returned with the success body
// (e.g. `{ "offer-receipt": { info: { receipt: ... }, schema: ... } }` per the
// Offer & Receipt extension §5.1). Callers leave it undefined when no
// extensions are configured for the route.
export function encodePaymentResponseHeader(settleResult, extensions) {
	const body = {
		success: true,
		transaction: settleResult.transaction,
		network: settleResult.network,
		payer: settleResult.payer,
	};
	if (extensions && Object.keys(extensions).length > 0) {
		body.extensions = extensions;
	}
	return Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
}

// Long-form description used for the top-level `resource.description` and
// (lightly trimmed) for the bazaar extension. Stays in one place so the 402
// challenge, the /.well-known/x402.json discovery file, and any operator
// dashboards stay in sync.
export const RESOURCE_DESCRIPTION =
	'three.ws MCP — Streamable HTTP transport (MCP 2025-06-18) exposing 3D avatar viewer, glTF/GLB model validation/inspection/optimization, and Solana agent data as JSON-RPC 2.0 tool calls. Pay-per-call in USDC on Base mainnet (eip155:8453) or Solana mainnet. ≤256 tools/call output, ≤32-message JSON-RPC batches. Operated by three.ws.';

// Build the bazaar.schema *meta-schema* — the JSON Schema that validates the
// `{input, output}` shape of the extension itself, NOT the endpoint's response
// body. The user's response-body schema gets nested at
// `schema.properties.output.properties.example`. Matches the reference
// @x402/extensions/bazaar createDiscoveryExtension output exactly; deviating
// from it causes agentic.market's parser to reject the endpoint with
// "v2 discovery extension validation failed" even when all surface-level
// checks (Transport, Payment Requirements, Bazaar Extension) pass.
export function buildBazaarSchema({ method, queryParamsSchema, bodyType, bodySchema, outputSchema }) {
	const upperMethod = String(method || 'GET').toUpperCase();
	const isBodyMethod = ['POST', 'PUT', 'PATCH'].includes(upperMethod);
	const inputProperties = {
		type: { type: 'string', const: 'http' },
		method: {
			type: 'string',
			enum: isBodyMethod ? ['POST', 'PUT', 'PATCH'] : ['GET', 'HEAD', 'DELETE'],
		},
	};
	const inputRequired = ['type', 'method'];
	if (isBodyMethod) {
		inputProperties.bodyType = { type: 'string', enum: ['json', 'form-data', 'text'] };
		inputProperties.body = bodySchema && typeof bodySchema === 'object' ? bodySchema : { type: 'object' };
		inputRequired.push('bodyType', 'body');
	} else if (queryParamsSchema && typeof queryParamsSchema === 'object') {
		inputProperties.queryParams = { type: 'object', ...queryParamsSchema };
	}
	const schema = {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		properties: {
			input: {
				type: 'object',
				properties: inputProperties,
				required: inputRequired,
				additionalProperties: false,
			},
		},
		required: ['input'],
	};
	if (outputSchema && typeof outputSchema === 'object') {
		schema.properties.output = {
			type: 'object',
			properties: {
				type: { type: 'string' },
				example: { type: 'object', ...outputSchema },
			},
			required: ['type'],
		};
	}
	return schema;
}

// Bazaar discovery extension — shape required by agentic.market's validator.
// `info.input.{type,method,body|queryParams|pathParams}` describes how to call
// the resource; `info.output.{type,example}` shows what comes back; top-level
// `schema` is the meta-schema built by `buildBazaarSchema` above.
//
// This is the v2 `declareDiscoveryExtension` shape. The flat
// `{method,input,inputSchema,output:{example,schema}}` shape v1 used is no
// longer indexed by the CDP Bazaar.
export function bazaarExtension() {
	const exampleBody = {
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/call',
		params: {
			name: 'validate_model',
			arguments: { url: 'https://example.com/model.glb' },
		},
	};
	const exampleResponse = {
		jsonrpc: '2.0',
		id: 1,
		result: {
			content: [
				{ type: 'text', text: '{"ok":true,"warnings":[],"meta":{"vertices":12345}}' },
			],
		},
	};
	const requestBodySchema = {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		required: ['jsonrpc', 'method'],
		properties: {
			jsonrpc: { type: 'string', const: '2.0' },
			id: { type: ['string', 'number'] },
			method: {
				type: 'string',
				enum: ['initialize', 'tools/list', 'tools/call', 'ping'],
				description: 'MCP JSON-RPC method.',
			},
			params: {
				type: 'object',
				description:
					'For tools/call: { name, arguments }. Tool names include validate_model, inspect_model, optimize_model, search_public_avatars, solana_register, solana_reputation, and others — see tools/list.',
			},
		},
	};
	const responseBodySchema = {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		properties: {
			jsonrpc: { type: 'string', const: '2.0' },
			id: { type: ['string', 'number'] },
			result: {
				type: 'object',
				properties: {
					content: {
						type: 'array',
						items: {
							type: 'object',
							required: ['type', 'text'],
							properties: {
								type: { type: 'string', enum: ['text'] },
								text: { type: 'string' },
							},
						},
					},
				},
			},
			error: {
				type: 'object',
				properties: {
					code: { type: 'number' },
					message: { type: 'string' },
				},
			},
		},
	};
	return {
		discoverable: true,
		info: {
			input: {
				type: 'http',
				method: 'POST',
				body: exampleBody,
				bodyType: 'json',
			},
			output: {
				type: 'json',
				example: exampleResponse,
			},
		},
		schema: buildBazaarSchema({
			method: 'POST',
			bodyType: 'json',
			bodySchema: requestBodySchema,
			outputSchema: responseBodySchema,
		}),
	};
}

// True when any offered requirement asks the client to use the Permit2
// asset-transfer method. When so, we automatically advertise BOTH gas-
// sponsoring extensions at the top level — the facilitator (CDP's
// x402ExactPermit2Proxy) submits the approval atomically with settlement so
// the payer never broadcasts the approval tx themselves. EIP-2612 is the
// preferred path for tokens that implement it (Base USDC v2 does);
// ERC-20 approval is the universal fallback that works with any ERC-20.
// permit2VariantOf already gates Permit2 emission on CDP creds being
// present, so by the time any accept reaches this check, the facilitator
// can honor both extensions.
function hasPermit2Accept(accepts) {
	const list = Array.isArray(accepts) ? accepts : [accepts];
	return list.some((a) => a?.extra?.assetTransferMethod === 'permit2');
}

// Build the v2 PaymentRequired body. Top-level `resource` carries url/description/
// mimeType (per v2 spec); per-accept entries no longer repeat them.
//
// `description`, `mimeType`, and `bazaar` are per-route — each paid endpoint
// wants its own catalog entry on agentic.market, not the MCP boilerplate.
// Callers may pass an `extensions` object to add or override entries (e.g. an
// endpoint that wants to declare a custom extension); when omitted we still
// emit `bazaar` plus, when any accept opts into Permit2, `eip2612GasSponsoring`.
// We also auto-declare the ERC-8021 `builder-code` extension when
// X402_BUILDER_CODE_APP is configured, so every paid endpoint contributes to
// on-chain attribution without having to opt in per-route.
// USE-13: `serviceName`, `tags`, `iconUrl` belong on the `resource` object
// per the Bazaar spec. Facilitators apply soft-drop validation so silently
// invalid fields are skipped, but we keep them within limits here too —
// printable-ASCII, ≤32 chars (serviceName/tag), ≤5 tags, absolute https URL.
export function build402Body({
	resourceUrl,
	accepts,
	error = 'X-PAYMENT header is required',
	description = RESOURCE_DESCRIPTION,
	mimeType = 'application/json',
	bazaar = bazaarExtension(),
	extensions: extraExtensions,
	serviceName,
	tags,
	iconUrl,
}) {
	const extensions = { bazaar };
	if (hasPermit2Accept(accepts)) {
		Object.assign(
			extensions,
			declareEip2612GasSponsoringExtension(),
			declareErc20ApprovalGasSponsoringExtension(),
		);
	}
	if (env.X402_BUILDER_CODE_APP && !extraExtensions?.[BUILDER_CODE]) {
		extensions[BUILDER_CODE] = declareBuilderCodeExtension({
			a: env.X402_BUILDER_CODE_APP,
		});
	}
	if (extraExtensions && typeof extraExtensions === 'object') {
		Object.assign(extensions, extraExtensions);
	}
	const resource = { url: resourceUrl, description, mimeType };
	if (typeof serviceName === 'string' && serviceName.length) {
		resource.serviceName = serviceName;
	}
	if (Array.isArray(tags) && tags.length) {
		resource.tags = tags.slice(0, 5);
	}
	if (typeof iconUrl === 'string' && iconUrl.length) {
		resource.iconUrl = iconUrl;
	}
	return {
		x402Version: X402_VERSION,
		error,
		resource,
		accepts: Array.isArray(accepts) ? accepts : [accepts],
		extensions,
	};
}

export function send402(res, opts = {}) {
	res.statusCode = 402;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	// v2 spec: the full envelope ({x402Version, error, resource, accepts,
	// extensions}) ships in the response body. `@x402/fetch` and other SDK
	// clients read it from there. We ALSO base64-encode the same envelope as
	// the `PAYMENT-REQUIRED` HTTP header — agentic.market's Bazaar validator
	// pulls discovery off the header during its probe and rejects entries
	// where the two differ.
	const body = build402Body(opts);
	res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(body), 'utf8').toString('base64'));
	res.end(JSON.stringify(body));
}

// Resolve the canonical resource URL the client hit, so the facilitator can
// match the payer's signed payload against the same string we advertise.
//
// We always anchor on env.APP_ORIGIN (set via PUBLIC_APP_ORIGIN) rather than
// trusting `x-forwarded-host` / `host`. Trusting those headers lets a caller
// craft a 402 challenge that advertises an attacker-controlled `resource.url`,
// which agents may then call or display.
export function resolveResourceUrl(_req, path) {
	return `${env.APP_ORIGIN}${path}`;
}
