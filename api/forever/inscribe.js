// POST /api/forever/inscribe
//
// Creates a real Bitcoin text inscription via OrdinalsBot. The message is
// embedded into a Taproot witness on Bitcoin mainnet, where it lives forever.
//
// Body: { message: string, receiveAddress?: string, feeRate?: number }
//   - message: 1–1500 chars of UTF-8 text to inscribe
//   - receiveAddress: optional Taproot (bc1p…) address that receives the
//     inscription. If omitted, falls back to the platform vault address
//     (env.BTC_INSCRIPTION_RECEIVE_ADDRESS).
//   - feeRate: optional sats/vB. Defaults to 8 (medium). Range 1–200.
//
// Response 200:
//   { orderId, charge: { address, amount, currency, lightning_invoice? },
//     receiveAddress, feeRate, sizeBytes, mempoolUrl, ordinalsUrl?, status }
//
// Errors:
//   400 — invalid message / address / fee rate
//   502 — OrdinalsBot upstream error
//   503 — receive address not configured and none provided

import { cors, error, json, readJson } from '../_lib/http.js';

const ORDINALSBOT_BASE_URL =
	process.env.ORDINALSBOT_BASE_URL || 'https://api.ordinalsbot.com';

const MAX_MESSAGE_BYTES = 1500;
const MIN_FEE_RATE = 1;
const MAX_FEE_RATE = 200;
const DEFAULT_FEE_RATE = 8;

// Bitcoin Taproot (P2TR / bc1p…) — the only address class OrdinalsBot will
// send inscriptions to. Mainnet HRP "bc", witness version 1, bech32m, 62 chars.
const TAPROOT_RE = /^bc1p[02-9ac-hj-np-z]{58}$/;

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
	if (!raw) return { address: null };
	if (typeof raw !== 'string') return { error: 'receiveAddress must be a string' };
	const address = raw.trim();
	if (!TAPROOT_RE.test(address)) {
		return {
			error:
				'receiveAddress must be a Bitcoin Taproot address (bc1p…). Ordinals can only be received by Taproot wallets.',
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
	const res = await fetch(`${ORDINALSBOT_BASE_URL}/order`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	});
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
	if (!res.ok || data.status === 'error') {
		const err = new Error(data.message || data.error || `OrdinalsBot returned ${res.status}`);
		err.status = res.status >= 500 ? 502 : res.status || 502;
		err.upstream = data;
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

	let body;
	try {
		body = await readJson(req);
	} catch (e) {
		return error(res, e.status || 400, 'bad_request', e.message || 'invalid request body');
	}

	const msg = validateMessage(body.message);
	if (msg.error) return error(res, 400, 'invalid_message', msg.error);

	const addr = validateAddress(body.receiveAddress);
	if (addr.error) return error(res, 400, 'invalid_receive_address', addr.error);

	const fee = validateFeeRate(body.feeRate);
	if (fee.error) return error(res, 400, 'invalid_fee_rate', fee.error);

	const receiveAddress =
		addr.address || process.env.BTC_INSCRIPTION_RECEIVE_ADDRESS || null;
	if (!receiveAddress) {
		return error(
			res,
			503,
			'no_receive_address',
			'No Taproot receive address provided and BTC_INSCRIPTION_RECEIVE_ADDRESS is not configured. Send your bc1p… address in the request body.',
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
		return error(res, e.status || 502, 'inscription_failed', e.message, {
			upstream: e.upstream,
		});
	}

	const shaped = shapeChargeResponse(order, {
		receiveAddress,
		feeRate: fee.feeRate,
		sizeBytes: msg.bytes,
	});

	return json(res, 200, shaped);
}
