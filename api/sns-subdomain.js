// Mint subdomains under the platform-owned parent .sol (default: threews.sol)
// for AGENT identities. For user/username-claim subdomains, use the existing
// POST /api/threews/subdomain endpoint.
//
// GET  /api/sns-subdomain?label=<label>          → availability check.
// POST /api/sns-subdomain { agent_id, label?, owner_address?, space? }
//
// - agent_id           : required. The agent to attach the subdomain to.
// - label              : optional, defaults to the agent's name slugified.
//                        1–63 chars of [a-z0-9-], passes the shared denylist.
// - owner_address      : optional. Solana base58 wallet to receive ownership.
//                        Defaults to the agent's own solana_address. When
//                        provided, must be a wallet linked to the caller.
// - space              : optional, 1000–10000. Bytes reserved on the subdomain
//                        registry. Default 2000.
//
// The platform keypair (THREEWS_SOL_PARENT_SECRET_BASE58) signs both the
// subdomain creation and the immediate transfer of ownership. The caller's
// wallet does not need to sign.
//
// On success, the new subdomain's SNS URL record is set to
// https://three.ws/a/<agent_id> so Brave users typing `<label>.threews.sol`
// land on the agent page. The mapping is also written to the agent's
// meta.sns_domain so x402 manifests can show recipient_name without an
// additional SNS round-trip.

import { getSessionUser, authenticateBearer, extractBearer } from './_lib/auth.js';
import { sql } from './_lib/db.js';
import { cors, json, method, error, readJson, wrap } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import {
	PARENT_LABEL,
	fullDomain,
	getSubdomainOwner,
	hasOwnerKey,
	normalizeLabel,
	getStorefrontOrigin,
} from './_lib/threews-sns.js';
import { createNamedSubdomain } from '../src/solana/sns-subdomain.js';

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

function slugifyName(name) {
	const s = String(name || '')
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 63);
	return s || null;
}

async function handleCheck(req, res) {
	const rl = await limits.snsResolve(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const url = new URL(req.url, 'http://x');
	const label = normalizeLabel(url.searchParams.get('label'));
	if (!label) {
		return error(res, 400, 'validation_error', 'label must match [a-z0-9-]{1,63} and not be reserved');
	}
	const owner = await getSubdomainOwner(label);
	return json(res, 200, {
		data: {
			label,
			parent: `${PARENT_LABEL}.sol`,
			full_name: fullDomain(label),
			available: !owner,
			owner,
		},
	});
}

async function handleMint(req, res, auth) {
	if (!hasOwnerKey()) {
		return error(res, 503, 'config_missing', 'subdomain minting unavailable — platform owner key not configured');
	}

	const body = await readJson(req).catch(() => ({}));
	const agentId = typeof body?.agent_id === 'string' ? body.agent_id.trim() : null;
	if (!agentId) {
		return error(res, 400, 'validation_error', 'agent_id is required (for user/username-claim subdomains use POST /api/threews/subdomain)');
	}

	const [agent] = await sql`
		SELECT id, name, meta FROM agent_identities
		WHERE id = ${agentId} AND user_id = ${auth.userId} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	const agentSol = agent.meta?.solana_address;
	if (!agentSol) {
		return error(res, 412, 'agent_missing_wallet', 'agent has no solana wallet — provision one via POST /api/agents/:id/solana');
	}

	let labelInput = typeof body?.label === 'string' && body.label.trim()
		? body.label
		: slugifyName(agent.name);
	const label = normalizeLabel(labelInput);
	if (!label) {
		return error(res, 400, 'validation_error', 'label must match [a-z0-9-]{1,63} and not be reserved');
	}

	let recipientWallet = typeof body?.owner_address === 'string' ? body.owner_address.trim() : '';
	if (recipientWallet) {
		if (!ADDR_RE.test(recipientWallet)) {
			return error(res, 400, 'validation_error', 'owner_address must be a base58 Solana public key');
		}
		const [walletRow] = await sql`
			SELECT id FROM user_wallets
			WHERE user_id = ${auth.userId} AND address = ${recipientWallet} AND chain_type = 'solana'
			LIMIT 1
		`;
		if (!walletRow) return error(res, 403, 'forbidden', 'owner_address must be linked to your account');
	} else {
		recipientWallet = agentSol;
	}

	const onChainOwner = await getSubdomainOwner(label);
	if (onChainOwner) {
		return error(res, 409, 'conflict', `${fullDomain(label)} is already registered on-chain to ${onChainOwner}`);
	}

	const space = Number.isInteger(body?.space) && body.space >= 1000 && body.space <= 10000 ? body.space : 2000;
	const urlOverride = `${getStorefrontOrigin()}/a/${encodeURIComponent(agentId)}`;

	let minted;
	try {
		minted = await createNamedSubdomain({
			label,
			newOwner: recipientWallet,
			space,
			urlOverride,
		});
	} catch (err) {
		console.error('[api/sns-subdomain] mint_failed', err);
		const status = err?.status || 502;
		const code = err?.code || 'upstream_error';
		return error(res, status, code, err?.message || 'subdomain mint failed');
	}

	// Attach the new SNS identity to the agent. Stored as the full ".sol"
	// name so downstream consumers (x402 manifest's `recipient_name`, agent
	// page, marketplace card) can use it without re-resolving.
	const nextMeta = {
		...(agent.meta || {}),
		sns_domain: minted.fullName,
		sns_owner_wallet: recipientWallet,
	};
	await sql`UPDATE agent_identities SET meta = ${JSON.stringify(nextMeta)}::jsonb WHERE id = ${agentId}`;

	return json(res, 201, {
		data: {
			ok: true,
			agent_id: agentId,
			full_name: minted.fullName,
			parent: minted.parent,
			owner: minted.owner,
			signature: minted.signature,
			explorer: `https://solscan.io/tx/${minted.signature}`,
			url_record: minted.url_record,
			agent_url: urlOverride,
		},
	});
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	if (req.method === 'GET') return handleCheck(req, res);

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in or provide a bearer token');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	return handleMint(req, res, auth);
});
