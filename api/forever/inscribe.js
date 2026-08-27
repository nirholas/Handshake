// POST /api/forever/inscribe
//
// Creates a real Bitcoin text inscription via OrdinalsBot. The message is
// embedded into a Taproot witness on Bitcoin mainnet, where it lives forever.
//
// Body: { message: string, receiveAddress?: string, feeRate?: number }
//   - message: 1 to 1500 chars of UTF-8 text to inscribe
//   - receiveAddress: optional Taproot (bc1p...) address that receives the
//     inscription. If omitted, falls back to the platform vault address
//     (env.BTC_INSCRIPTION_RECEIVE_ADDRESS).
//   - feeRate: optional sats/vB. Defaults to 8 (medium). Range 1 to 200.
//
// Response 200:
//   { orderId, charge: { address, amount, currency, lightning_invoice? },
//     receiveAddress, feeRate, sizeBytes, mempoolUrl, ordinalsUrl?, status }
//
// Errors:
//   400: invalid body / message / address / fee rate
//   401: not signed in and no valid bearer token
//   429: per-IP ceiling, or OrdinalsBot throttling the platform key
//   502: OrdinalsBot upstream error
//   503: receive address not provided and none configured

import { bech32m } from '@scure/base';
import { cors, error, json, readJson, rateLimited } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { fetchUpstream } from '../_lib/upstream-fetch.js';

const ORDINALSBOT_BASE_URL =
	process.env.ORDINALSBOT_BASE_URL || 'https://api.ordinalsbot.com';

const MAX_MESSAGE_BYTES = 1500;
const MIN_FEE_RATE = 1;
const MAX_FEE_RATE = 200;
const DEFAULT_FEE_RATE = 8;

// Bitcoin Taproot (P2TR / bc1p...) is the only address class OrdinalsBot will
// send inscriptions to. Mainnet HRP "bc", witness version 1, bech32m, 62 chars.
const TAPROOT_RE = /^bc1p[02-9ac-hj-np-z]{58}$/;

// A P2TR address encodes the witness version plus a 32-byte program, which is
// 1 + ceil(256 / 5) = 53 bech32 words.
const TAPROOT_WORD_COUNT = 53;

/**
 * Full bech32m validation, not just the character shape. A single mistyped
 * character keeps the bc1p... shape and only the checksum catches it, and
 * OrdinalsBot answers a bad address with an opaque proxy error that tells the
 * user nothing. Verifying here turns that into a precise 400 and spares the
 * upstream order-create call entirely.
 */
function hasValidTaprootChecksum(address) {
	try {
		const decoded = bech32m.decode(address, 90);
		return (
			decoded.prefix === 'bc' &&
			decoded.words[0] === 1 &&
			decoded.words.length === TAPROOT_WORD_COUNT
		);
	} catch {
		return false;
	}
}

/** OrdinalsBot reports failures as a string or an array of strings. */
function upstreamMessage(data) {
	const raw = data?.message ?? data?.error;
	if (Array.isArray(raw)) return raw.filter(Boolean).map(String).join('; ');
	if (typeof raw === 'string') return raw;
	return '';
}

function validateMessage(raw) {
	if (typeof raw !== 'string') {
		return { error: 'message must be a string' };
	}
	const message = raw.trim();
	if (message.length === 0) {
		return { error: 'message cannot be empty' };
	}
	const bytes = Buffer.byteLength(message, 'utf8');
	if (bytes > MAX_MESSAGE_BYTES) {
		return {
			error: `message too long: ${bytes} bytes (max ${MAX_MESSAGE_BYTES})`,
		};
	}
	return { message, bytes };
}

function validateAddress(raw) {
	if (raw === undefined || raw === null || raw === '') return { address: null };
	if (typeof raw !== 'string') return { error: 'receiveAddress must be a string' };
	const address = raw.trim();
	if (address === '') return { address: null };
	if (!TAPROOT_RE.test(address)) {
		return {
			error:
				'receiveAddress must be a Bitcoin Taproot address (bc1p...). Ordinals can only be received by Taproot wallets.',
		};
	}
	if (!hasValidTaprootChecksum(address)) {
		return {
			error:
				'receiveAddress failed its bech32m checksum, so it is not a real Taproot address. Copy the bc1p... address again from your wallet.',
		};
	}
	return { address };
}

function validateFeeRate(raw) {
	if (raw === undefined || raw === null || raw === '') {
		return { feeRate: DEFAULT_FEE_RATE };
	}
	const n = Number(raw);
	if (!Number.isFinite(n) || !Number.isInteger(n)) {
		return { error: 'feeRate must be an integer' };
	}
	if (n < MIN_FEE_RATE || n > MAX_FEE_RATE) {
		return { error: `feeRate must be between ${MIN_FEE_RATE} and ${MAX_FEE_RATE} sats/vB` };
	}
	return { feeRate: n };
}

function buildTextDataURL(message) {
	const base64 = Buffer.from(message, 'utf8').toString('base64');
	return `data:text/plain;charset=utf-8;base64,${base64}`;
}

async function createOrdinalsBotOrder({ message, receiveAddress, feeRate }) {
	const sizeBytes = Buffer.byteLength(message, 'utf8');
	const body = {
		files: [
			{
				name: 'forever.txt',
				size: sizeBytes,
				type: 'text/plain;charset=utf-8',
				dataURL: buildTextDataURL(message),
			},
		],
		receiveAddress,
		fee: feeRate,
		lowPostage: true,
	};
	const headers = { 'content-type': 'application/json' };
	if (process.env.ORDINALSBOT_API_KEY) {
		headers['x-api-key'] = process.env.ORDINALSBOT_API_KEY;
	}
	// Placing an order is a paid, non-idempotent action: bound it with a deadline
	// but never retry it, because a retry after a request that actually landed
	// would buy a second inscription. Every status is returned untouched so the
	// existing non-JSON and error-status handling below is unchanged.
	const res = await fetchUpstream(`${ORDINALSBOT_BASE_URL}/order`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	}, { timeoutMs: 30_000, attempts: 1, okWhen: () => true, label: 'ordinalsbot-order' });
	const text = await res.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		const err = new Error(`OrdinalsBot returned non-JSON (${res.status})`);
		err.status = 502;
		err.upstream = text.slice(0, 300);
		throw err;
	}
	// OrdinalsBot signals failure two different ways: a non-2xx status, and a
	// 200 carrying {status:"error"}. Neither status is usable as our own. It
	// answers a rejected payload with a bare 404 and echoes its own internal
	// axios text, and a key or quota fault would arrive as 401/403. Passing any
	// of those through would tell the caller their request was not found or that
	// THEY are unauthorized, and the 200 case would ship an error envelope under
	// a success status that the client reads as a created order. Every upstream
	// fault is our gateway's fault: 502, except a throttle we can honestly relay.
	if (!res.ok || data.status === 'error') {
		const detail = upstreamMessage(data);
		const err = new Error(
			detail
				? `OrdinalsBot rejected the inscription order: ${detail}`
				: `OrdinalsBot returned ${res.status}`,
		);
		err.status = res.status === 429 ? 429 : 502;
		err.upstream = detail || null;
		throw err;
	}
	return data;
}

function shapeChargeResponse(order, { receiveAddress, feeRate, sizeBytes }) {
	const charge = order.charge || {};
	const address = charge.address || order.payAddress;
	const amount = Number(charge.amount ?? order.fileCost ?? 0);
	const lightning = charge.lightning_invoice || charge.lightningInvoice || null;
	const status = order.status || charge.status || 'pending';

	return {
		orderId: order.id || order.orderId,
		status,
		charge: {
			address,
			amount,
			amountBtc: amount ? amount / 1e8 : null,
			currency: 'BTC',
			lightningInvoice:
				typeof lightning === 'object' && lightning ? lightning.payreq || null : lightning,
			expiresAt: charge.expires_at || charge.expiresAt || null,
		},
		receiveAddress,
		feeRate,
		sizeBytes,
		mempoolBaseUrl: 'https://mempool.space',
		ordinalsViewerBaseUrl: 'https://ordinals.com/inscription',
	};
}

export default async function handler(req, res) {
	if (cors(req, res, { origins: '*', methods: 'POST,OPTIONS' })) return;
	if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', 'POST only');

	// Creating an OrdinalsBot order spends the platform's API key/quota. Require a
	// signed-in user or a valid bearer token, and rate-limit per IP, so the endpoint
	// can't be scripted anonymously to spam third-party order creation.
	const session = await getSessionUser(req).catch(() => null);
	let authed = !!session;
	if (!authed) {
		const bearer = extractBearer(req);
		if (bearer) authed = !!(await authenticateBearer(bearer).catch(() => null));
	}
	if (!authed) return error(res, 401, 'unauthorized', 'sign in or provide a valid bearer token');

	const rl = await limits.inscribeIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try {
		body = await readJson(req);
	} catch (e) {
		return error(res, e.status || 400, 'bad_request', e.message || 'invalid request body');
	}
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return error(res, 400, 'bad_request', 'request body must be a JSON object');
	}

	const msg = validateMessage(body.message);
	if (msg.error) return error(res, 400, 'invalid_message', msg.error);

	const addr = validateAddress(body.receiveAddress);
	if (addr.error) return error(res, 400, 'invalid_receive_address', addr.error);

	const fee = validateFeeRate(body.feeRate);
	if (fee.error) return error(res, 400, 'invalid_fee_rate', fee.error);

	const vaultAddress = (process.env.BTC_INSCRIPTION_RECEIVE_ADDRESS || '').trim();
	const receiveAddress = addr.address || vaultAddress || null;
	if (!receiveAddress) {
		return error(
			res,
			503,
			'no_receive_address',
			'No Taproot receive address provided and BTC_INSCRIPTION_RECEIVE_ADDRESS is not configured. Send your bc1p... address in the request body.',
		);
	}
	// The vault address comes from config, so it skipped the request validation
	// above. A typo there would mint inscriptions into an unspendable address,
	// so hold it to the same bar and fail loudly instead of silently upstream.
	if (!addr.address && !(TAPROOT_RE.test(receiveAddress) && hasValidTaprootChecksum(receiveAddress))) {
		return error(
			res,
			503,
			'invalid_vault_address',
			'BTC_INSCRIPTION_RECEIVE_ADDRESS is not a valid Bitcoin Taproot address. Send your own bc1p... address in the request body.',
		);
	}

	let order;
	try {
		order = await createOrdinalsBotOrder({
			message: msg.message,
			receiveAddress,
			feeRate: fee.feeRate,
		});
	} catch (e) {
		const status = e.status === 429 ? 429 : 502;
		return error(
			res,
			status,
			status === 429 ? 'upstream_rate_limited' : 'inscription_failed',
			e.message,
			e.upstream ? { upstream: e.upstream } : {},
		);
	}

	const shaped = shapeChargeResponse(order, {
		receiveAddress,
		feeRate: fee.feeRate,
		sizeBytes: msg.bytes,
	});

	return json(res, 200, shaped);
}
