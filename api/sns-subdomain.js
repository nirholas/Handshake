// Mint subdomains under the platform-owned parent .sol (default: threews.sol).
//
// GET  /api/sns-subdomain?label=<label>          → availability check.
// POST /api/sns-subdomain
//   body { label, agent_id?, owner_address?, space? }
//
// - label              : required, 1–63 chars of [a-z0-9-], no leading/trailing hyphen.
// - owner_address      : optional. Solana base58 wallet to receive ownership.
//                        Defaults to the agent's own solana_address when agent_id
//                        is given, otherwise to the caller's primary linked
//                        Solana wallet.
// - agent_id           : optional. When set, the new subdomain is attached as
//                        the agent's SNS identity (meta.sns_domain).
// - space              : optional, 1000–10000. Bytes reserved on the subdomain
//                        registry. Default 2000.
//
// The platform keypair (THREEWS_SOL_PARENT_SECRET_BASE58) signs both the
// subdomain creation and the immediate transfer of ownership. The caller's
// wallet does not need to sign.

import { getSessionUser, authenticateBearer, extractBearer } from './_lib/auth.js';
import { sql } from './_lib/db.js';
import { cors, json, method, error, readJson, wrap } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import {
	checkSubdomainAvailability,
	createNamedSubdomain,
	getParentDomain,
	normalizeLabel,
} from '../src/solana/sns-subdomain.js';
import { Connection } from '@solana/web3.js';

const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

async function resolveTargetOwner({ userId, agentId, ownerAddress }) {
	if (ownerAddress) {
		if (!ADDR_RE.test(ownerAddress)) {
			return { error: { status: 400, code: 'validation_error', msg: 'owner_address must be a base58 Solana public key' } };
		}
		const [linked] = await sql`
			SELECT id FROM user_wallets
			WHERE user_id = ${userId} AND address = ${ownerAddress} AND chain_type = 'solana'
			LIMIT 1
		`;
		if (!linked) {
			return { error: { status: 403, code: 'forbidden', msg: 'owner_address is not a Solana wallet linked to your account' } };
		}
		return { address: ownerAddress };
	}

	if (agentId) {
		const [agent] = await sql`
			SELECT id, meta FROM agent_identities
			WHERE id = ${agentId} AND user_id = ${userId} AND deleted_at IS NULL
		`;
		if (!agent) return { error: { status: 404, code: 'not_found', msg: 'agent not found' } };
		const addr = agent.meta?.solana_address;
		if (!addr) {
			return { error: { status: 412, code: 'agent_missing_wallet', msg: 'agent has no solana wallet — provision one via POST /api/agents/:id/solana before minting a subdomain' } };
		}
		return { address: addr, agent };
	}

	const [primary] = await sql`
		SELECT address FROM user_wallets
		WHERE user_id = ${userId} AND chain_type = 'solana'
		ORDER BY (is_primary IS TRUE) DESC, created_at ASC
		LIMIT 1
	`;
	if (!primary) {
		return { error: { status: 412, code: 'no_solana_wallet', msg: 'link a Solana wallet first via POST /api/auth/wallet, or pass owner_address / agent_id' } };
	}
	return { address: primary.address };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;

	if (req.method === 'GET') {
		const rl = await limits.snsResolve(clientIp(req));
		if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

		const url = new URL(req.url, 'http://x');
		const label = normalizeLabel(url.searchParams.get('label'));
		const parentDomain = getParentDomain().replace(/\.sol$/, '');
		if (!label) {
			return error(res, 400, 'validation_error', 'label must be 1–63 lowercase [a-z0-9-] chars with no leading/trailing hyphen');
		}
		const connection = new Connection(SOLANA_RPC, 'confirmed');
		const availability = await checkSubdomainAvailability({ connection, parentDomain, label });
		return json(res, 200, {
			data: {
				label,
				parent: `${parentDomain}.sol`,
				full_name: `${label}.${parentDomain}.sol`,
				available: !availability.exists,
				owner: availability.owner,
			},
		});
	}

	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in or provide a bearer token');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = await readJson(req).catch(() => ({}));
	const label = normalizeLabel(body?.label);
	if (!label) {
		return error(res, 400, 'validation_error', 'label must be 1–63 lowercase [a-z0-9-] chars with no leading/trailing hyphen');
	}
	const agentId = typeof body?.agent_id === 'string' ? body.agent_id.trim() : null;
	const ownerAddress = typeof body?.owner_address === 'string' ? body.owner_address.trim() : null;
	const space = Number.isInteger(body?.space) && body.space >= 1000 && body.space <= 10000 ? body.space : 2000;

	const target = await resolveTargetOwner({ userId: auth.userId, agentId, ownerAddress });
	if (target.error) return error(res, target.error.status, target.error.code, target.error.msg);

	let minted;
	try {
		minted = await createNamedSubdomain({ label, newOwner: target.address, space });
	} catch (err) {
		const status = err?.status || 500;
		const code = err?.code || 'mint_failed';
		return error(res, status, code, err?.message || 'subdomain mint failed');
	}

	// Attach to the agent's identity when requested. We store the resolved
	// full name (e.g. "nich.threews.sol") so x402 manifests can carry it
	// directly via recipient_name without re-resolving.
	if (agentId && target.agent) {
		const nextMeta = { ...(target.agent.meta || {}), sns_domain: minted.fullName, sns_owner_wallet: target.address };
		await sql`UPDATE agent_identities SET meta = ${JSON.stringify(nextMeta)}::jsonb WHERE id = ${agentId}`;
	}

	return json(res, 201, {
		data: {
			ok: true,
			full_name: minted.fullName,
			parent: minted.parent,
			owner: minted.owner,
			signature: minted.signature,
			explorer: `https://solscan.io/tx/${minted.signature}`,
			url_record: minted.url_record,
			storefront_path: `/u/${label}`,
			attached_to_agent: agentId && target.agent ? agentId : null,
		},
	});
});
