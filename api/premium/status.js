// GET /api/premium/status?wallet=<base58>[&signature=<b58|b64>&issuedAt=<iso>]
//
// Pass state for one wallet. The keys/resources/history payload is private,
// account-scoped data (API-key inventory, rate limits, usage volume, full
// purchase history), so it is gated behind wallet-ownership proof: the caller
// signs `three.ws premium status\nWallet: <wallet>\nIssued At: <iso>` with the
// wallet's key (SIWS/ed25519), same class of check the sibling
// /api/x402/my-receipts uses. Key prefixes and usage counts only — the
// plaintext key is never re-derivable.
//
// Unauthenticated callers (no/invalid signature) get only the boolean pass
// state { active, pass } — wallet addresses are public, so the sensitive
// fields must not leak to anyone who can name a wallet.

import { cors, json, error, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { passStatus } from '../_lib/premium.js';
import { verifySiwsSignature } from '../_lib/siws.js';

const MAX_AGE_SECONDS = 300;

function ownershipMessage(wallet, issuedAt) {
	return `three.ws premium status\nWallet: ${wallet}\nIssued At: ${issuedAt}`;
}

function withinFreshnessWindow(issuedAt) {
	const ts = Date.parse(issuedAt);
	if (!Number.isFinite(ts)) return false;
	const ageSec = (Date.now() - ts) / 1000;
	return ageSec >= 0 && ageSec <= MAX_AGE_SECONDS;
}

function provesOwnership(wallet, signature, issuedAt) {
	if (!signature || !issuedAt || !withinFreshnessWindow(issuedAt)) return false;
	try {
		return verifySiwsSignature(ownershipMessage(wallet, issuedAt), signature, wallet);
	} catch {
		return false;
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.premiumStatusIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const wallet = (params.get('wallet') || '').trim();
	const signature = (params.get('signature') || '').trim();
	const issuedAt = (params.get('issuedAt') || '').trim();

	try {
		const status = await passStatus(wallet);
		if (provesOwnership(wallet, signature, issuedAt)) {
			return json(res, 200, status, { 'cache-control': 'no-store' });
		}
		// Public path: only the pass state, never keys / resources / history.
		return json(
			res,
			200,
			{ active: status.active, pass: status.pass, resources: [], keys: [], history: [] },
			{ 'cache-control': 'no-store' },
		);
	} catch (e) {
		return error(res, e.status || 502, e.code || 'status_failed', e.message);
	}
});
