// POST /api/cz/claim                     verify an ECDSA signature, record the
//                                        claim, return the on-chain tx payload
// GET  /api/cz/claim?address=0x...       issue a fresh nonce to sign
//
// Backed by the `cz_claims` table (api/_lib/migrations/20260812140000_cz_claims.sql).
// One row per issued nonce: minted `pending` by the GET, flipped to `claimed`
// by the POST once the signature recovers to the address the nonce was issued
// for. Nonces expire after NONCE_TTL_MS so an abandoned one cannot be redeemed
// weeks later from a browser history entry or a proxy log.

import { randomBytes } from 'crypto';
import { verifyMessage, Interface } from 'ethers';
import { sql } from '../_lib/db.js';
import { cors, json, error, wrap, readJson, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';

const CZ_AGENT_ID = env.CZ_AGENT_ID || 'cz-preview';
const CZ_AGENT_NAME = env.CZ_AGENT_NAME || 'CZ Agent';
// Reads from env so the contract can be deployed without a code redeploy.
// Frontend skips the on-chain tx when the address is empty/zero.
const REGISTRY_CONTRACT = env.CZ_REGISTRY_CONTRACT || '0x0000000000000000000000000000000000000000';

// A nonce only has to survive the round trip from "connect wallet" to "approve
// the signature in the wallet popup". Fifteen minutes covers a slow human on a
// hardware wallet and still bounds how long a leaked nonce is worth anything.
const NONCE_TTL_MS = 15 * 60 * 1000;

const _iface = new Interface(['function transferAgent(string agentId, address newOwner)']);
function encodeTransferAgent(agentId, newOwner) {
	return _iface.encodeFunctionData('transferAgent', [agentId, newOwner]);
}

function claimMessage(nonce) {
	return `Claim CZ Agent\n\nNonce: ${nonce}`;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;

	const ip = clientIp(req);

	// GET: issue nonce
	if (req.method === 'GET') {
		const address = new URL(req.url, 'http://x').searchParams.get('address') || '';
		if (!/^0x[0-9a-fA-F]{40}$/.test(address))
			return error(
				res,
				400,
				'validation_error',
				'address must be a 0x-prefixed Ethereum address',
			);

		const rl = await limits.czClaimIp(ip);
		if (!rl.success) return rateLimited(res, rl, 'too many requests, try again in an hour');

		const nonce = randomBytes(16).toString('hex');
		await sql`
			insert into cz_claims (address, nonce, status)
			values (${address.toLowerCase()}, ${nonce}, 'pending')
		`;
		return json(res, 200, { nonce, expiresInSeconds: NONCE_TTL_MS / 1000 });
	}

	// POST: verify signature and record claim
	if (req.method === 'POST') {
		let body;
		try {
			body = await readJson(req);
		} catch (e) {
			return error(res, e.status || 400, 'validation_error', e.message);
		}

		const { signerAddress = '', signature = '', nonce = '' } = body ?? {};
		if (!signerAddress || !signature || !nonce)
			return error(
				res,
				400,
				'validation_error',
				'signerAddress, signature, and nonce are required',
			);
		if (typeof signerAddress !== 'string' || typeof signature !== 'string' || typeof nonce !== 'string')
			return error(res, 400, 'validation_error', 'signerAddress, signature, and nonce must be strings');
		if (!/^0x[0-9a-fA-F]{40}$/.test(signerAddress))
			return error(res, 400, 'validation_error', 'invalid signerAddress format');

		const rl = await limits.czClaimIp(ip);
		if (!rl.success) return rateLimited(res, rl, 'too many requests, try again in an hour');

		const rows = await sql`
			select id, address, status, created_at from cz_claims where nonce = ${nonce} limit 1
		`;
		const row = rows[0];
		if (!row) return error(res, 400, 'invalid_nonce', 'nonce not found');
		if (row.status !== 'pending') return error(res, 409, 'conflict', 'nonce already used');
		if (Date.now() - new Date(row.created_at).getTime() > NONCE_TTL_MS)
			return error(res, 400, 'nonce_expired', 'nonce expired, request a new one');
		if (row.address !== signerAddress.toLowerCase())
			return error(res, 403, 'forbidden', 'address does not match nonce');

		let recovered;
		try {
			recovered = verifyMessage(claimMessage(nonce), signature);
		} catch {
			return error(res, 400, 'invalid_signature', 'could not parse signature');
		}
		if (recovered.toLowerCase() !== signerAddress.toLowerCase())
			return error(res, 403, 'forbidden', 'signature does not match signer address');

		// Conditional on `pending` so two POSTs racing on the same nonce cannot
		// both be told they won the claim: exactly one update returns a row.
		const claimed = await sql`
			update cz_claims set status = 'claimed', claimed_at = now()
			where id = ${row.id} and status = 'pending'
			returning id
		`;
		if (!claimed[0]) return error(res, 409, 'conflict', 'nonce already used');

		return json(res, 200, {
			ok: true,
			agentId: CZ_AGENT_ID,
			agentName: CZ_AGENT_NAME,
			txPayload: {
				to: REGISTRY_CONTRACT,
				data: encodeTransferAgent(CZ_AGENT_ID, signerAddress),
				value: '0x0',
			},
		});
	}

	res.setHeader('allow', 'GET, POST, OPTIONS');
	return error(res, 405, 'method_not_allowed', 'method not allowed');
});
