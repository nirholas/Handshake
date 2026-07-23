// A2A (Agent-to-Agent) x402 transport — client side.
//
// Drives the two-leg handshake from the caller's perspective:
//   1. POST `{ method: "message/send", params: { message: { … } } }` to the
//      peer's A2A endpoint with the X-A2A-Extensions header. The peer replies
//      with a task in state `input-required` carrying `x402.payment.required`.
//   2. Build a `PaymentPayload`, POST it back with the same `taskId` and
//      `x402.payment.status: payment-submitted`. The peer verifies, runs the
//      handler, settles, and replies with state `completed` +
//      `x402.payment.receipts`.
//
// Rails:
//   • Solana (primary) — `exact` scheme as an SPL TransferChecked, built via the
//     official @x402/svm ExactSvmScheme, partially signed by the payer and
//     co-signed by the peer's facilitator fee payer. `createSolanaSigner(secret)`
//     yields the @solana/kit signer; `buildSolanaExactPayload()` the payload.
//   • EVM (fallback) — `exact` scheme as an EIP-3009 transferWithAuthorization.
//     `createPrivateKeySigner(privateKey)` uses viem's accounts API for Base /
//     other EVM chains; `buildEvmExactPayload()` builds the payload.

import { randomBytes, randomUUID } from 'node:crypto';

import bs58 from 'bs58';

import { fetchSafePublicUrlPinned } from '../ssrf-guard.js';

import {
	A2A_EXTENSIONS_HEADER,
	A2A_X402_EXTENSION_URI,
} from './a2a-server.js';

export { A2A_EXTENSIONS_HEADER, A2A_X402_EXTENSION_URI };

// Solana is the primary A2A settlement rail. CAIP-2 ids must match what the
// server advertises (api/_lib/x402/a2a-server.js → NETWORK_SOLANA_*).
export const NETWORK_SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const NETWORK_SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

export function isSolanaNetwork(network) {
	return (
		network === NETWORK_SOLANA_MAINNET ||
		network === NETWORK_SOLANA_DEVNET ||
		network === 'solana'
	);
}

function isEvmExactNetwork(network) {
	return /^eip155:\d+$/.test(network);
}

// ── Errors ────────────────────────────────────────────────────────────────

export class A2AClientError extends Error {
	constructor(code, message, details) {
		super(message);
		this.code = code;
		this.details = details;
	}
}

// ── Signers ───────────────────────────────────────────────────────────────

// EIP-3009 transferWithAuthorization signer powered by viem. Returns an
// object `{ address, network, signAuthorization }` consumable by
// payA2A() / buildEvmExactPayload().
export async function createPrivateKeySigner(privateKey) {
	if (!privateKey || typeof privateKey !== 'string') {
		throw new A2AClientError(
			'invalid_signer',
			'createPrivateKeySigner: privateKey hex string required',
		);
	}
	const { privateKeyToAccount } = await import('viem/accounts');
	const account = privateKeyToAccount(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`);
	return {
		address: account.address,
		signAuthorization: async ({ domain, message }) => {
			const types = {
				TransferWithAuthorization: [
					{ name: 'from', type: 'address' },
					{ name: 'to', type: 'address' },
					{ name: 'value', type: 'uint256' },
					{ name: 'validAfter', type: 'uint256' },
					{ name: 'validBefore', type: 'uint256' },
					{ name: 'nonce', type: 'bytes32' },
				],
			};
			return account.signTypedData({
				domain,
				types,
				primaryType: 'TransferWithAuthorization',
				message,
			});
		},
	};
}

// Decode a Solana secret key from any of the encodings used across this
// codebase: a JSON byte array (solana-keygen), base58 (Phantom export), or
// base64. Returns the 64-byte expanded secret key.
function decodeSolanaSecret(secret) {
	const trimmed = String(secret).trim();
	if (trimmed.startsWith('[')) {
		try {
			const bytes = Uint8Array.from(JSON.parse(trimmed));
			if (bytes.length === 64) return bytes;
		} catch {
			/* fall through to the error below */
		}
		throw new A2AClientError('invalid_signer', 'Solana secret: malformed 64-byte JSON array');
	}
	for (const decode of [() => bs58.decode(trimmed), () => new Uint8Array(Buffer.from(trimmed, 'base64'))]) {
		try {
			const bytes = decode();
			if (bytes.length === 64) return bytes;
		} catch {
			/* try the next encoding */
		}
	}
	throw new A2AClientError(
		'invalid_signer',
		'Solana secret must be a 64-byte key encoded as base58, base64, or a JSON array',
	);
}

// Build a Solana @solana/kit signer from a platform-funded payer secret. The
// returned signer carries `.address` (the payer's base58 pubkey) and signs the
// SPL TransferChecked payment built by buildSolanaExactPayload().
export async function createSolanaSigner(secret) {
	if (!secret || typeof secret !== 'string') {
		throw new A2AClientError('invalid_signer', 'createSolanaSigner: secret key string required');
	}
	const { createKeyPairSignerFromBytes } = await import('@solana/kit');
	return createKeyPairSignerFromBytes(decodeSolanaSecret(secret));
}

// ── Payload builders ──────────────────────────────────────────────────────

function randomHex32() {
	return `0x${randomBytes(32).toString('hex')}`;
}

// Build a Solana `exact` PaymentPayload for a Solana `accepts` entry, using the
// official @x402/svm scheme. It constructs an SPL TransferChecked from the
// payer's USDC ATA to the peer's, with the peer-advertised `extra.feePayer` as
// the transaction fee payer (co-signed by the facilitator on /settle), and
// partially signs it with `signer`. The base64 wire transaction lands in
// `payload.transaction` — exactly what the server's confirmSolanaPayment decodes
// and PayAI settles. Shape mirrors buildEvmExactPayload so the A2A submit leg is
// rail-agnostic.
export async function buildSolanaExactPayload({ accept, signer, resource, rpcUrl }) {
	if (accept.scheme !== 'exact') {
		throw new A2AClientError(
			'unsupported_scheme',
			`a2a-client: only exact scheme supported on Solana, got ${accept.scheme}`,
		);
	}
	if (!accept.extra?.feePayer) {
		throw new A2AClientError(
			'missing_fee_payer',
			'a2a-client: Solana accept entry is missing extra.feePayer (facilitator co-signer)',
			{ network: accept.network },
		);
	}
	if (!signer || typeof signer.address !== 'string') {
		throw new A2AClientError(
			'invalid_signer',
			'buildSolanaExactPayload: a @solana/kit signer is required (try createSolanaSigner)',
		);
	}
	const { ExactSvmScheme } = await import('@x402/svm');
	const scheme = new ExactSvmScheme(signer, rpcUrl ? { rpcUrl } : undefined);
	const built = await scheme.createPaymentPayload(2, accept);
	return {
		x402Version: built.x402Version || 2,
		scheme: 'exact',
		network: accept.network,
		resource,
		accepted: accept,
		payload: built.payload,
	};
}

const CHAIN_ID_BY_NETWORK = {
	'eip155:8453': 8453, // Base mainnet
	'eip155:84532': 84532, // Base sepolia
	'eip155:1': 1, // Ethereum mainnet
	'eip155:137': 137, // Polygon
	'eip155:42161': 42161, // Arbitrum
};

function chainIdFor(network) {
	if (CHAIN_ID_BY_NETWORK[network]) return CHAIN_ID_BY_NETWORK[network];
	const m = /^eip155:(\d+)$/.exec(network);
	if (m) return Number(m[1]);
	throw new A2AClientError('unsupported_network', `a2a-client: cannot derive chainId from ${network}`);
}

// Build an EIP-3009 `exact` PaymentPayload for an EVM `accepts` entry.
export async function buildEvmExactPayload({ accept, signer, resource }) {
	if (accept.scheme !== 'exact') {
		throw new A2AClientError(
			'unsupported_scheme',
			`a2a-client: only exact scheme supported here, got ${accept.scheme}`,
		);
	}
	const chainId = chainIdFor(accept.network);
	const validAfter = 0;
	const validBefore = Math.floor(Date.now() / 1000) + (accept.maxTimeoutSeconds || 600);
	const nonce = randomHex32();
	const domain = {
		name: accept.extra?.name || 'USD Coin',
		version: accept.extra?.version || '2',
		chainId,
		verifyingContract: accept.asset,
	};
	const message = {
		from: signer.address,
		to: accept.payTo,
		value: accept.amount,
		validAfter,
		validBefore,
		nonce,
	};
	const signature = await signer.signAuthorization({ domain, message });
	return {
		x402Version: 2,
		scheme: 'exact',
		network: accept.network,
		resource,
		accepted: accept,
		payload: {
			signature,
			authorization: {
				from: signer.address,
				to: accept.payTo,
				value: accept.amount,
				validAfter: String(validAfter),
				validBefore: String(validBefore),
				nonce,
			},
		},
	};
}

// ── A2A protocol helpers ──────────────────────────────────────────────────

function buildJsonRpcRequest({ id, message }) {
	return {
		jsonrpc: '2.0',
		id: id || randomUUID(),
		method: 'message/send',
		params: { message },
	};
}

async function postJsonRpc(endpoint, body, extraHeaders) {
	// The peer endpoint is caller-controlled (validated once upstream), so the
	// POST goes through the pinned SSRF guard: the socket connects only to the
	// pre-validated IP and every redirect hop is re-validated, closing the
	// 302-to-internal and DNS-rebinding paths a hostile peer could use to read
	// internal JSON services through us. maxBytes bounds the reply body.
	const res = await fetchSafePublicUrlPinned(
		endpoint,
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json',
				[A2A_EXTENSIONS_HEADER]: A2A_X402_EXTENSION_URI,
				...(extraHeaders || {}),
			},
			body: JSON.stringify(body),
		},
		{ maxBytes: 2 * 1024 * 1024 },
	);
	const text = await res.text();
	let parsed;
	try {
		parsed = text ? JSON.parse(text) : {};
	} catch (err) {
		throw new A2AClientError('parse_error', `non-JSON A2A reply: ${err.message}`, { text });
	}
	if (!res.ok) {
		throw new A2AClientError(
			'transport_error',
			`A2A peer returned HTTP ${res.status}`,
			{ status: res.status, body: parsed },
		);
	}
	if (parsed.error) {
		throw new A2AClientError(
			'jsonrpc_error',
			parsed.error.message || 'JSON-RPC error',
			parsed.error,
		);
	}
	return parsed.result;
}

function readTaskStatus(task) {
	if (!task || task.kind !== 'task') {
		throw new A2AClientError('invalid_reply', 'expected `kind: "task"` in A2A reply');
	}
	return task.status?.state;
}

function readPaymentRequired(task) {
	const meta = task.status?.message?.metadata;
	if (meta?.['x402.payment.status'] !== 'payment-required') return null;
	const required = meta['x402.payment.required'];
	if (!required || !Array.isArray(required.accepts) || !required.accepts.length) {
		throw new A2AClientError(
			'malformed_payment_required',
			'task carries payment-required status but no accepts list',
			required,
		);
	}
	return required;
}

function readReceipts(task) {
	const meta = task.status?.message?.metadata;
	if (!meta) return null;
	return {
		status: meta['x402.payment.status'] || null,
		receipts: Array.isArray(meta['x402.payment.receipts']) ? meta['x402.payment.receipts'] : [],
		error: meta['x402.payment.error'] || null,
		lifecycle: meta['x402.payment.lifecycle'] || null,
	};
}

// Default network preference list — Solana first, EVM fallback. Callers can
// override by passing `networkPreference` to `payA2A`.
const DEFAULT_NETWORK_PREFERENCE = [
	NETWORK_SOLANA_MAINNET,
	'eip155:8453',
	'eip155:84532',
	'eip155:1',
];

function pickAccept(accepts, preference) {
	const order = preference?.length ? preference : DEFAULT_NETWORK_PREFERENCE;
	for (const net of order) {
		const match = accepts.find((a) => a.network === net && a.scheme === 'exact');
		if (match) return match;
	}
	// Fall back to the first `exact` accept on any rail we can settle — Solana
	// preferred over EVM when both are offered without an explicit preference.
	const solana = accepts.find((a) => a.scheme === 'exact' && isSolanaNetwork(a.network));
	if (solana) return solana;
	const evm = accepts.find((a) => a.scheme === 'exact' && isEvmExactNetwork(a.network));
	if (evm) return evm;
	throw new A2AClientError(
		'no_supported_accept',
		'a2a-client: peer offered no supported scheme=exact accept on Solana or EVM',
		{ accepts: accepts.map(({ network, scheme }) => ({ network, scheme })) },
	);
}

// ── Public client ─────────────────────────────────────────────────────────

// Send an initial unpaid message and return the peer's payment-required task.
export async function requestQuote({ endpoint, text = 'Initiate paid skill.', taskId }) {
	const message = {
		kind: 'message',
		role: 'user',
		messageId: randomUUID(),
		...(taskId ? { taskId } : {}),
		parts: [{ kind: 'text', text }],
	};
	const task = await postJsonRpc(endpoint, buildJsonRpcRequest({ message }));
	const required = readPaymentRequired(task);
	if (!required) {
		throw new A2AClientError(
			'unexpected_state',
			`expected payment-required, got state ${readTaskStatus(task) || 'unknown'}`,
			{ task },
		);
	}
	return { task, required, taskId: task.id };
}

// Submit a signed PaymentPayload for the given taskId and return the
// completed (or failed) task.
export async function submitPayment({
	endpoint,
	taskId,
	paymentPayload,
	text = 'Here is the payment authorization.',
}) {
	const message = {
		kind: 'message',
		role: 'user',
		messageId: randomUUID(),
		taskId,
		parts: [{ kind: 'text', text }],
		metadata: {
			'x402.payment.status': 'payment-submitted',
			'x402.payment.payload': paymentPayload,
		},
	};
	const task = await postJsonRpc(endpoint, buildJsonRpcRequest({ message }));
	const receipts = readReceipts(task);
	const state = readTaskStatus(task);
	return { task, state, ...receipts };
}

// End-to-end: quote → sign → submit. Returns the completed task plus parsed
// receipt fields. Throws A2AClientError on transport / signing / settlement
// failure.
export async function payA2A({
	endpoint,
	signer,
	solanaSigner,
	rpcUrl,
	text,
	networkPreference,
	onQuote,
}) {
	if (!endpoint) throw new A2AClientError('invalid_args', 'payA2A: endpoint is required');
	const hasEvmSigner = signer && typeof signer.signAuthorization === 'function';
	const hasSolanaSigner = solanaSigner && typeof solanaSigner.address === 'string';
	if (!hasEvmSigner && !hasSolanaSigner) {
		throw new A2AClientError(
			'invalid_signer',
			'payA2A: a Solana signer (createSolanaSigner) or EVM signer (createPrivateKeySigner) is required',
		);
	}

	const { task: quoteTask, required, taskId } = await requestQuote({ endpoint, text });
	if (typeof onQuote === 'function') {
		try {
			await onQuote({ task: quoteTask, required, taskId });
		} catch (err) {
			throw new A2AClientError('quote_rejected', err.message || 'caller rejected the quote');
		}
	}

	// Restrict selection to rails we actually hold a signer for, so we never
	// pick a Solana accept with only an EVM signer in hand (or vice-versa).
	const payable = required.accepts.filter((a) =>
		isSolanaNetwork(a.network) ? hasSolanaSigner : hasEvmSigner,
	);
	if (!payable.length) {
		throw new A2AClientError(
			'no_supported_accept',
			'payA2A: no peer accept matches an available signer',
			{ accepts: required.accepts.map(({ network, scheme }) => ({ network, scheme })) },
		);
	}
	const accept = pickAccept(payable, networkPreference);
	const resource = required.resource || { url: endpoint, mimeType: 'application/json' };
	const paymentPayload = isSolanaNetwork(accept.network)
		? await buildSolanaExactPayload({ accept, signer: solanaSigner, resource, rpcUrl })
		: await buildEvmExactPayload({ accept, signer, resource });

	const result = await submitPayment({ endpoint, taskId, paymentPayload });

	if (result.state !== 'completed') {
		throw new A2AClientError(
			result.error || 'payment_failed',
			result.receipts?.[0]?.errorReason ||
				`A2A task ended in state ${result.state}`,
			result,
		);
	}
	return result;
}
