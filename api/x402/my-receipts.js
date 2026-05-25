// GET /api/x402/my-receipts?address=<addr>&signature=<sig>&issuedAt=<iso>&network=<evm|solana>&sinceUnix=<n>
//
// Buyer-side read endpoint for the x402 Offer & Receipt extension (USE-17).
// Returns every signed receipt we issued to the requested wallet so a buyer
// can re-fetch their proof-of-purchase artifacts long after the original
// payment-response header was dropped from their client.
//
// Authentication: the buyer signs a personal_sign-style message proving
// control of the wallet whose receipts they're requesting. We recover the
// signer per-family:
//   - EVM (network=evm or 0x-hex address): viem verifyMessage. Supports EOAs
//     and EIP-1271 contract signatures.
//   - Solana (network=solana or base58 address): tweetnacl/ed25519 verify
//     against the base58-encoded signature.
// In both cases the signed message includes an `issuedAt` ISO timestamp so
// old signatures can't be replayed indefinitely (5-minute window).

import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';

import { cors, error, json, method } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { listReceiptsForPayer } from '../_lib/x402/receipt-storage.js';
import { verifySiwsSignature } from '../_lib/siws.js';

const MAX_AGE_SECONDS = 300;
const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
const SOL_RE = /^[A-HJ-NP-Za-km-z1-9]{32,44}$/;

// Lightweight viem client used purely for verifyMessage (which works for EOAs
// and EIP-1271 contract signatures). Mainnet RPC is fine — verifyMessage only
// hits the chain for contract-wallet sigs, and we use the public default.
let _client;
function getClient() {
	if (!_client) _client = createPublicClient({ chain: mainnet, transport: http() });
	return _client;
}

function buildExpectedMessage(address, issuedAt, network) {
	// Network is part of the message domain so an EVM signature can't be
	// replayed as a Solana one (and vice versa). Address case normalized to
	// match the storage layer's lowercasing for EVM; Solana base58 is
	// case-sensitive and stays verbatim.
	const normalized = network === 'solana' ? address : address.toLowerCase();
	return `three.ws x402 receipts read\nNetwork: ${network}\nAddress: ${normalized}\nIssued At: ${issuedAt}`;
}

function withinFreshnessWindow(issuedAt) {
	const ts = Date.parse(issuedAt);
	if (!Number.isFinite(ts)) return false;
	const ageSec = (Date.now() - ts) / 1000;
	return ageSec >= 0 && ageSec <= MAX_AGE_SECONDS;
}

function detectNetwork(address, declared) {
	if (declared === 'evm' || declared === 'solana') return declared;
	if (EVM_RE.test(address)) return 'evm';
	if (SOL_RE.test(address)) return 'solana';
	return null;
}

export default async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const url = new URL(req.url, 'http://x');
	const address = String(url.searchParams.get('address') || '').trim();
	const signature = String(url.searchParams.get('signature') || '').trim();
	const issuedAt = String(url.searchParams.get('issuedAt') || '').trim();
	const declaredNetwork = String(url.searchParams.get('network') || '').trim().toLowerCase();
	const sinceUnix = url.searchParams.get('sinceUnix');
	const limit = url.searchParams.get('limit');

	const network = detectNetwork(address, declaredNetwork);
	if (!network) {
		return error(
			res,
			400,
			'invalid_address',
			'address must be a 0x EVM address or a base58 Solana address',
		);
	}

	if (network === 'evm') {
		if (!EVM_RE.test(address)) {
			return error(res, 400, 'invalid_address', 'EVM address must be 0x + 40 hex chars');
		}
		if (!/^0x[a-fA-F0-9]+$/.test(signature)) {
			return error(res, 400, 'invalid_signature', 'EVM signature must be 0x-hex');
		}
	} else {
		if (!SOL_RE.test(address)) {
			return error(res, 400, 'invalid_address', 'Solana address must be base58 (32-44 chars)');
		}
		// Phantom emits base58 (87-88 chars). Other Solana wallets emit base64.
		// verifySiwsSignature handles both formats.
		if (!signature || signature.length < 60) {
			return error(res, 400, 'invalid_signature', 'Solana signature must be base58 or base64');
		}
	}

	if (!issuedAt || !withinFreshnessWindow(issuedAt)) {
		return error(
			res,
			401,
			'stale_signature',
			`issuedAt must be a recent ISO timestamp (within ${MAX_AGE_SECONDS}s)`,
		);
	}

	const message = buildExpectedMessage(address, issuedAt, network);
	let valid = false;
	try {
		if (network === 'evm') {
			valid = await getClient().verifyMessage({ address, message, signature });
		} else {
			valid = verifySiwsSignature(message, signature, address);
		}
	} catch (err) {
		return error(res, 400, 'signature_check_failed', err.message);
	}
	if (!valid) {
		return error(
			res,
			401,
			'invalid_signature',
			'signature does not recover to the requested address',
		);
	}

	// Storage layer stores EVM addresses lowercased and Solana addresses as-is;
	// match that convention so the join hits.
	const payerKey = network === 'evm' ? address.toLowerCase() : address;
	let rows;
	try {
		rows = await listReceiptsForPayer({ payer: payerKey, sinceUnix, limit });
	} catch (err) {
		return error(res, 502, 'receipt_query_failed', err.message);
	}

	json(res, 200, {
		network,
		address: payerKey,
		count: rows.length,
		receipts: rows,
	});
}
