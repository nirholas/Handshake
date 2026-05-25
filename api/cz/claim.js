// POST /api/cz/claim  — verify ECDSA signature, record claim intent, return on-chain tx payload
// GET  /api/cz/claim?address=0x...  — issue a fresh nonce for signing
//
// Requires this table (run once before deploy):
//   create table if not exists cz_claims (
//     id          uuid        primary key default gen_random_uuid(),
//     address     text        not null,
//     nonce       text        not null unique,
//     status      text        not null default 'pending',  -- pending | claimed
//     created_at  timestamptz not null default now(),
//     claimed_at  timestamptz
//   );

import { randomBytes } from 'crypto';
import { verifyMessage, Interface } from 'ethers';
import { sql } from '../_lib/db.js';
import { cors, json, error, wrap, readJson } from '../_lib/http.js';
import { clientIp } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';

const CZ_AGENT_ID = env.CZ_AGENT_ID || 'cz-preview';
const CZ_AGENT_NAME = env.CZ_AGENT_NAME || 'CZ Agent';
// Reads from env so the contract can be deployed without a code redeploy.
// Frontend skips the on-chain tx when the address is empty/zero.
const REGISTRY_CONTRACT = env.CZ_REGISTRY_CONTRACT || '0x0000000000000000000000000000000000000000';

const _iface = new Interface(['function transferAgent(string agentId, address newOwner)']);
function encodeTransferAgent(agentId, newOwner) {
	return _iface.encodeFunctionData('transferAgent', [agentId, newOwner]);
}

// Inline sliding-window rate limiter: 5 requests / hour per IP.
// Using in-memory here because this is a one-shot flow with minimal traffic.
const _buckets = new Map();
function checkRate(ip) {
	const now = Date.now();
	const window = 60 * 60 * 1000;
	const kept = (_buckets.get(ip) || []).filter((t) => t > now - window);
	if (kept.length >= 5) return false;
	kept.push(now);
	_buckets.set(ip, kept);
	return true;
}

function claimMessage(nonce) {
	return `Claim CZ Agent\n\nNonce: ${nonce}`;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;

	const ip = clientIp(req);

	// ── GET: issue nonce ──────────────────────────────────────────────────────
	if (req.method === 'GET') {
		const address = new URL(req.url, 'http://x').searchParams.get('address') || '';
		if (!/^0x[0-9a-fA-F]{40}$/.test(address))
			return error(
				res,
				400,
				'validation_error',
				'address must be a 0x-prefixed Ethereum address',
			);

		if (!checkRate(ip))
			return error(res, 429, 'rate_limited', 'too many requests — try again in an hour');

		const nonce = randomBytes(16).toString('hex');
		await sql`
			insert into cz_claims (address, nonce, status)
			values (${address.toLowerCase()}, ${nonce}, 'pending')
		`;
		return json(res, 200, { nonce });
	}

	// ── POST: verify signature and record claim ───────────────────────────────
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
		if (!/^0x[0-9a-fA-F]{40}$/.test(signerAddress))
			return error(res, 400, 'validation_error', 'invalid signerAddress format');

		if (!checkRate(ip))
			return error(res, 429, 'rate_limited', 'too many requests — try again in an hour');

		const rows = await sql`
			select id, address, status from cz_claims where nonce = ${nonce} limit 1
		`;
		const row = rows[0];
		if (!row) return error(res, 400, 'invalid_nonce', 'nonce not found');
		if (row.status !== 'pending') return error(res, 409, 'conflict', 'nonce already used');
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

		await sql`
			update cz_claims set status = 'claimed', claimed_at = now() where id = ${row.id}
		`;

		const txPayload = {
			to: REGISTRY_CONTRACT,
			data: encodeTransferAgent(CZ_AGENT_ID, signerAddress),
			value: '0x0',
		};

		return json(res, 200, {
			ok: true,
			agentId: CZ_AGENT_ID,
			agentName: CZ_AGENT_NAME,
			txPayload,
		});
	}

	res.setHeader('allow', 'GET, POST, OPTIONS');
	return error(res, 405, 'method_not_allowed', 'method not allowed');
});
