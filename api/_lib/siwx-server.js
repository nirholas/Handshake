// Server-side glue between @x402/extensions/sign-in-with-x and our
// paidEndpoint() wrapper. Keeps the verification path, extension declaration,
// and EVM smart-wallet verifier in one place so each new endpoint doesn't
// have to repeat them.
//
// The SIWX flow:
//   1. paidEndpoint() declares the 'sign-in-with-x' extension in every 402
//      body (declareSiwxExtensionFor below).
//   2. A returning buyer sends `SIGN-IN-WITH-X: <base64>` instead of the
//      X-PAYMENT header. authenticateSiwx() parses, validates, verifies
//      the CAIP-122 signature, looks up the (resource, address) grant in
//      siwx_payments, and on success the handler runs without settlement.
//   3. A fresh buyer settles with X-PAYMENT as usual; recordSiwxPayment()
//      then writes the grant so step 2 works next time.

import {
	createSIWxResourceServerExtension,
	declareSIWxExtension,
	parseSIWxHeader,
	validateSIWxMessage,
	verifySIWxSignature,
	SIGN_IN_WITH_X,
} from '@x402/extensions/sign-in-with-x';

const siwxResourceServerExtension = createSIWxResourceServerExtension();
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

import { env } from './env.js';
import { siwxStorage, normalizeAddress } from './siwx-storage.js';

export { SIGN_IN_WITH_X };

// Lazily build a viem PublicClient so verifySIWxSignature can verify
// smart-contract wallets (EIP-1271) and counterfactual wallets (EIP-6492).
// Uses our private RPC (env.BASE_RPC_URL) to avoid leaking buyer addresses
// to a public node. Returns undefined when BASE_RPC_URL isn't configured —
// the upstream verifier then falls back to EOA-only verification.
let _baseClient;
function getEvmVerifier() {
	if (!env.BASE_RPC_URL) return undefined;
	if (!_baseClient) {
		_baseClient = createPublicClient({
			chain: base,
			transport: http(env.BASE_RPC_URL),
		});
	}
	return _baseClient.verifyMessage.bind(_baseClient);
}

export function hasEvmVerifier() {
	return Boolean(env.BASE_RPC_URL);
}

// Build the SIWX extension block for the 402 body. `declareSIWxExtension`
// alone returns a stub: the SDK pipeline normally calls
// `siwxResourceServerExtension.enrichPaymentRequiredResponse` to fill in
// nonce, issuedAt, domain, uri, and the supportedChains list. paidEndpoint()
// doesn't run that pipeline, so we invoke enrich() ourselves with the
// context (resourceUrl + requirements) the helper already has.
export async function declareSiwxExtensionFor({
	networks,
	resourceUrl,
	statement,
	expirationSeconds = 300,
}) {
	const list = Array.isArray(networks) ? networks : [networks];
	const unique = [...new Set(list.filter(Boolean))];
	if (!unique.length) {
		throw new Error('declareSiwxExtensionFor: at least one network required');
	}
	if (!resourceUrl) {
		throw new Error('declareSiwxExtensionFor: resourceUrl required');
	}
	const stub = declareSIWxExtension({
		network: unique.length === 1 ? unique[0] : unique,
		statement,
		expirationSeconds,
	});
	const declaration = stub[SIGN_IN_WITH_X];
	const enriched = await siwxResourceServerExtension.enrichPaymentRequiredResponse(declaration, {
		resourceInfo: { url: resourceUrl },
		requirements: unique.map((network) => ({ network })),
	});
	return { [SIGN_IN_WITH_X]: enriched };
}

// Given an incoming Vercel request, attempt to authenticate via
// SIGN-IN-WITH-X. Returns:
//   { ok: true, address, network } on full success.
//   { ok: false, status, code, error } on validation / verification / grant
//     failure (caller emits the matching HTTP status).
//   null when the header is absent — caller continues with the X-PAYMENT
//     flow.
export async function authenticateSiwx({ req, resourceUrl }) {
	const header =
		req.headers['sign-in-with-x'] ||
		req.headers['SIGN-IN-WITH-X'] ||
		req.headers['Sign-In-With-X'];
	if (!header) return null;

	let payload;
	try {
		payload = parseSIWxHeader(String(header));
	} catch (err) {
		return { ok: false, status: 400, code: 'siwx_parse_failed', error: err.message };
	}

	const validation = await validateSIWxMessage(payload, resourceUrl, {
		maxAge: 5 * 60 * 1000,
		checkNonce: async (n) => !(await siwxStorage.hasUsedNonce(n)),
	});
	if (!validation.valid) {
		return { ok: false, status: 401, code: 'siwx_message_invalid', error: validation.error };
	}

	const verification = await verifySIWxSignature(payload, { evmVerifier: getEvmVerifier() });
	if (!verification.valid || !verification.address) {
		return { ok: false, status: 401, code: 'siwx_signature_invalid', error: verification.error };
	}

	const normalizedAddress = normalizeAddress(payload.chainId, verification.address);
	if (!(await siwxStorage.hasPaid(resourceUrl, normalizedAddress))) {
		return {
			ok: false,
			status: 402,
			code: 'siwx_not_paid',
			error: 'wallet has not paid for this resource',
		};
	}

	await siwxStorage.recordNonce(payload.nonce, {
		resource: resourceUrl,
		address: normalizedAddress,
	});

	return { ok: true, address: normalizedAddress, network: payload.chainId };
}

// Record a fresh payment so the wallet can re-enter via SIWX next time. Called
// from paidEndpoint() after a successful facilitator settle. The `payer` is the
// canonical CAIP-122 address (lowercase hex for EVM, Base58 for Solana); the
// caller already normalizes via normalizeAddress() before passing it in.
export async function recordSiwxPayment({ resourceUrl, payer, network, ttlSeconds = null }) {
	if (!payer) return;
	await siwxStorage.recordPayment(resourceUrl, payer, { network, ttlSeconds });
}
