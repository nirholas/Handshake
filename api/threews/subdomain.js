// /api/threews/subdomain
//
// GET  ?label=<label>            → availability check on `<label>.threews.sol`.
//                                  Returns { available, owner, claim, full }.
// POST { label, owner_wallet? }  → mint `<label>.threews.sol`, set its URL
//                                  record to https://three.ws/u/<label>, and
//                                  transfer ownership to `owner_wallet` (or
//                                  to the caller's default agent wallet).
//                                  Requires authentication.
// DELETE                          → release the caller's stored subdomain
//                                  claim (does NOT release the on-chain
//                                  subdomain; that's still owned by the
//                                  recipient wallet).
//
// Constraint: `label` must equal the caller's `username`. Subdomains showcase
// the user's profile at /u/<label> — making them divergent would let users
// impersonate other handles.

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';
import {
	PARENT_LABEL,
	fullDomain,
	getSubdomainOwner,
	hasOwnerKey,
	mintSubdomain,
	normalizeLabel,
} from '../_lib/threews-sns.js';

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

async function handleCheck(req, res) {
	const url = new URL(req.url, 'http://x');
	const label = normalizeLabel(url.searchParams.get('label'));
	if (!label) {
		return error(res, 400, 'validation_error', 'label must match [a-z0-9-]{1,63} and not be reserved');
	}

	const [claim] = await sql`
		SELECT s.label, s.parent, s.owner_wallet, s.url_record, s.created_at,
		       u.id AS user_id, u.username, u.display_name
		FROM user_subdomains s
		JOIN users u ON u.id = s.user_id
		WHERE s.label = ${label} AND s.parent = ${PARENT_LABEL}
		LIMIT 1
	`;

	let owner = null;
	if (claim) {
		owner = claim.owner_wallet;
	} else {
		owner = await getSubdomainOwner(label);
	}

	return json(res, 200, {
		data: {
			full: fullDomain(label),
			label,
			parent: PARENT_LABEL,
			available: !owner,
			owner,
			claim: claim ? {
				user_id: claim.user_id,
				username: claim.username,
				display_name: claim.display_name,
				owner_wallet: claim.owner_wallet,
				url_record: claim.url_record,
				created_at: claim.created_at,
			} : null,
			showcase_url: claim ? `${env.APP_ORIGIN}/u/${claim.username}` : null,
		},
	}, { 'cache-control': 'public, max-age=30' });
}

async function handleMint(req, res, auth) {
	if (!hasOwnerKey()) {
		return error(res, 503, 'config_missing', 'subdomain minting unavailable — platform owner key not configured');
	}

	const body = await readJson(req).catch(() => ({}));
	const label = normalizeLabel(body?.label);
	if (!label) {
		return error(res, 400, 'validation_error', 'label must match [a-z0-9-]{1,63} and not be reserved');
	}

	const [user] = await sql`
		SELECT id, username FROM users
		WHERE id = ${auth.userId} AND deleted_at IS NULL
	`;
	if (!user) return error(res, 404, 'not_found', 'user not found');
	if (!user.username) {
		return error(res, 409, 'no_username', 'set a username on your account before claiming a subdomain');
	}
	if (user.username.toLowerCase() !== label) {
		return error(res, 409, 'username_mismatch', `subdomain label must match your username (@${user.username})`);
	}

	const [existing] = await sql`
		SELECT id FROM user_subdomains
		WHERE label = ${label} AND parent = ${PARENT_LABEL}
		LIMIT 1
	`;
	if (existing) return error(res, 409, 'conflict', `${fullDomain(label)} is already claimed`);

	const onChainOwner = await getSubdomainOwner(label);
	if (onChainOwner) {
		return error(res, 409, 'conflict', `${fullDomain(label)} is already registered on-chain to ${onChainOwner}`);
	}

	let recipientWallet = typeof body?.owner_wallet === 'string' ? body.owner_wallet.trim() : '';
	if (recipientWallet && !ADDR_RE.test(recipientWallet)) {
		return error(res, 400, 'validation_error', 'owner_wallet must be a base58 Solana public key');
	}
	if (recipientWallet) {
		// Caller must have linked this wallet to their account so we don't mint
		// a subdomain to a third-party wallet.
		const [walletRow] = await sql`
			SELECT id FROM user_wallets
			WHERE user_id = ${auth.userId} AND address = ${recipientWallet} AND chain_type = 'solana'
			LIMIT 1
		`;
		if (!walletRow) return error(res, 403, 'forbidden', 'owner_wallet must be linked to your account');
	} else {
		// Fall back to the caller's default agent Solana wallet.
		const [defaultAgent] = await sql`
			SELECT meta->>'solana_address' AS sol FROM agent_identities
			WHERE user_id = ${auth.userId} AND deleted_at IS NULL
			ORDER BY created_at ASC
			LIMIT 1
		`;
		if (!defaultAgent?.sol) {
			return error(res, 409, 'no_wallet', 'pass owner_wallet or create an agent first (which provisions a Solana wallet)');
		}
		recipientWallet = defaultAgent.sol;
	}

	let minted;
	try {
		minted = await mintSubdomain({ label, recipientWallet });
	} catch (err) {
		console.error('[threews/subdomain] mint_failed', err);
		const status = err?.status || 502;
		const code = err?.code || 'upstream_error';
		return error(res, status, code, err?.message || 'subdomain mint failed');
	}

	const [row] = await sql`
		INSERT INTO user_subdomains (user_id, label, parent, owner_wallet, url_record, signature)
		VALUES (${auth.userId}, ${label}, ${PARENT_LABEL}, ${recipientWallet}, ${minted.url_record}, ${minted.signature})
		RETURNING id, label, parent, owner_wallet, url_record, signature, created_at
	`;

	return json(res, 201, {
		data: {
			...row,
			full: minted.fullName,
			showcase_url: `${env.APP_ORIGIN}/u/${user.username}`,
			explorer: `https://solscan.io/tx/${minted.signature}`,
		},
	});
}

async function handleDelete(req, res, auth) {
	const url = new URL(req.url, 'http://x');
	const label = normalizeLabel(url.searchParams.get('label'));
	if (!label) return error(res, 400, 'validation_error', 'label required');

	const rows = await sql`
		DELETE FROM user_subdomains
		WHERE user_id = ${auth.userId} AND label = ${label} AND parent = ${PARENT_LABEL}
		RETURNING id, label, parent
	`;
	if (rows.length === 0) return error(res, 404, 'not_found', 'claim not found');
	return json(res, 200, { data: { released: rows[0], note: 'on-chain ownership unchanged' } });
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST', 'DELETE'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	if (req.method === 'GET') return handleCheck(req, res);

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	if (req.method === 'POST') return handleMint(req, res, auth);
	return handleDelete(req, res, auth);
});
