// Wallet endpoints — dispatched by req.query.action.
//   GET    /api/auth/wallets                  → handleListWallets   (action undefined)
//   POST   /api/auth/wallets                  → handleLinkWallet    (action undefined)
//   GET    /api/auth/wallets/check            → handleCheck         (action === 'check')
//   POST   /api/auth/wallets/nonce            → handleNonce         (action === 'nonce')
//   POST   /api/auth/wallets/nonce-solana     → handleNonceSolana   (action === 'nonce-solana')
//   POST   /api/auth/wallets/link-solana      → handleLinkSolana    (action === 'link-solana')
//   DELETE /api/auth/wallets/<address>        → handleUnlinkWallet  (action === <address>)
//
// Dispatcher convention: undefined action → index (GET/POST), reserved literal
// actions handle nonce/link/check flows, and anything else is treated as an
// address for DELETE. _link-nonces.js remains a separate helper (underscore-
// prefixed, not file-routed by Vercel).

import { verifyMessage, getAddress } from 'ethers';
import { z } from 'zod';
import { sql } from '../../_lib/db.js';
import { getSessionUser } from '../../_lib/auth.js';
import { logAudit } from '../../_lib/audit.js';
import { cors, json, method, readJson, wrap, error } from '../../_lib/http.js';
import { parse } from '../../_lib/validate.js';
import { parseSiweMessage } from '../../_lib/siwe.js';
import { parseSiwsMessage, verifySiwsSignature } from '../../_lib/siws.js';
import { env } from '../../_lib/env.js';
import { issueNonce, consumeNonce, NONCE_TTL_SEC } from './_link-nonces.js';

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ALLOWED_SOLANA_CHAINS = new Set(['mainnet', 'devnet', 'testnet']);

const linkBody = z.object({
	message: z.string().min(64).max(4000),
	signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
});

const nonceBody = z.object({
	address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
	chainId: z.number().int().positive(),
});

export default wrap(async (req, res) => {
	const action = req.query?.action;

	// /api/auth/wallets — list (GET) or link (POST)
	if (action === undefined || action === '' || action === null) {
		return handleIndex(req, res);
	}

	// /api/auth/wallets/check — cheap pre-check: is this address already linked to the session user?
	if (action === 'check') {
		return handleCheck(req, res);
	}

	// /api/auth/wallets/nonce — issue link nonce (EVM/SIWE)
	if (action === 'nonce') {
		return handleNonce(req, res);
	}

	// /api/auth/wallets/nonce-solana — issue SIWS link message
	if (action === 'nonce-solana') {
		return handleNonceSolana(req, res);
	}

	// /api/auth/wallets/link-solana — verify SIWS + insert Solana wallet row
	if (action === 'link-solana') {
		return handleLinkSolana(req, res);
	}

	// /api/auth/wallets/primary — mark one of the caller's wallets as primary
	if (action === 'primary') {
		return handleSetPrimary(req, res);
	}

	// /api/auth/wallets/<address> — unlink wallet (action carries the address)
	return handleUnlinkWallet(req, res, action);
});

// ── Index: list (GET) and link (POST) ──────────────────────────────────────
// Link new wallets to authenticated user + list existing wallets.

async function handleIndex(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;

	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');

	if (req.method === 'GET') {
		return handleListWallets(session.id, res);
	} else if (req.method === 'POST') {
		return handleLinkWallet(session.id, req, res);
	} else if (!method(req, res, ['GET', 'POST'])) return;
}

async function handleListWallets(userId, res) {
	const rows = await sql`
		select address, chain_id, chain_type, created_at, is_primary
		from user_wallets
		where user_id = ${userId}
		order by created_at asc
	`;

	return json(res, 200, {
		wallets: rows.map((w) => ({
			address: w.address,
			chain_id: w.chain_id,
			chain_type: w.chain_type,
			created_at: w.created_at,
			is_primary: w.is_primary,
		})),
	});
}

async function handleLinkWallet(userId, req, res) {
	const body = parse(linkBody, await readJson(req));

	// 1. Parse SIWE message.
	const fields = parseSiweMessage(body.message);
	if (!fields) return error(res, 400, 'invalid_message', 'malformed SIWE message');

	// 2. Domain + URI must match this deployment.
	const appOrigin = env.APP_ORIGIN;
	const appHost = new URL(appOrigin).host;
	const vercelHost = process.env.VERCEL_URL || null;
	const isLocalDev =
		process.env.VERCEL_ENV !== 'production' && process.env.VERCEL_ENV !== 'preview';
	const allowedHosts = new Set([appHost, vercelHost].filter(Boolean));
	const domainOk =
		allowedHosts.has(fields.domain) || (isLocalDev && /^localhost(:\d+)?$/.test(fields.domain));
	if (!domainOk) return error(res, 400, 'invalid_domain', `domain must be ${appHost}`);
	try {
		const u = new URL(fields.uri);
		const allowedOrigins = new Set(
			[appOrigin, vercelHost ? `https://${vercelHost}` : null].filter(Boolean),
		);
		const originOk =
			allowedOrigins.has(u.origin) ||
			(isLocalDev && /^https?:\/\/localhost(:\d+)?$/.test(u.origin));
		if (!originOk) return error(res, 400, 'invalid_uri', 'uri origin mismatch');
	} catch {
		return error(res, 400, 'invalid_uri', 'uri not a valid URL');
	}

	// 3. Temporal checks.
	const now = Date.now();
	if (fields.expirationTime && Date.parse(fields.expirationTime) < now) {
		return error(res, 400, 'expired', 'message expired');
	}
	if (fields.notBefore && Date.parse(fields.notBefore) > now) {
		return error(res, 400, 'not_yet_valid', 'message not yet valid');
	}

	// 4. Verify nonce was issued to this user and burn it.
	const nonceData = consumeNonce(fields.nonce, userId);
	if (!nonceData) {
		return error(res, 400, 'invalid_nonce', 'unknown, expired, or invalid nonce');
	}

	// 5. Verify signature recovers the address claimed in the message.
	let recovered;
	try {
		recovered = verifyMessage(body.message, body.signature);
	} catch {
		return error(res, 401, 'invalid_signature', 'signature verification failed');
	}
	let claimed;
	try {
		claimed = getAddress(fields.address);
	} catch {
		return error(res, 400, 'invalid_address', 'address not checksummed correctly');
	}
	if (recovered.toLowerCase() !== claimed.toLowerCase()) {
		return error(res, 401, 'invalid_signature', 'signer does not match address');
	}

	const addrLower = claimed.toLowerCase();
	const chainId = fields.chainId || null;

	// 6. Check if this address is already linked to this user (idempotent).
	const existing = await sql`
		select id from user_wallets
		where user_id = ${userId} and address = ${addrLower}
	`;
	if (existing.length > 0) {
		return json(res, 200, { wallet: { address: claimed, chain_id: chainId } });
	}

	// 7. Check if this address is already linked to a different user.
	const conflict = await sql`
		select user_id from user_wallets
		where address = ${addrLower}
	`;
	if (conflict.length > 0) {
		return error(
			res,
			409,
			'address_in_use',
			'this address is already linked to another account',
		);
	}

	// 8. Insert the new wallet.
	await sql`
		insert into user_wallets (user_id, address, chain_id, is_primary)
		values (${userId}, ${addrLower}, ${chainId}, false)
	`;
	logAudit({
		userId,
		action: 'link_wallet',
		resourceId: addrLower,
		meta: { chain_id: chainId },
		req,
	});

	return json(res, 201, { wallet: { address: claimed, chain_id: chainId } });
}

// ── Check ──────────────────────────────────────────────────────────────────
// GET /api/auth/wallets/check?chain_type=<solana|evm>&address=<addr>
// Returns { linked: bool } — true iff the address is already linked to the
// session user with a matching chain_type. Used by the Solana deploy flow
// to skip the SIWS prompt when the wallet is already linked. Unauthenticated
// callers get { linked: false } (200) — the address simply isn't linked to
// "the current session" when there is no session.

const checkAddressRe = /^[A-Za-z0-9]{1,128}$/;

async function handleCheck(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	if (!session) return json(res, 200, { linked: false });

	const chainType = String(req.query?.chain_type || '').toLowerCase();
	const address = String(req.query?.address || '');
	if (!chainType || !address || !checkAddressRe.test(address)) {
		return error(res, 400, 'invalid_request', 'chain_type and address required');
	}

	// EVM addresses normalize to lowercase; Solana base58 is case-sensitive.
	const addrLookup = chainType === 'solana' ? address : address.toLowerCase();

	const rows = await sql`
		select 1 from user_wallets
		where user_id = ${session.id}
		  and address = ${addrLookup}
		  and chain_type = ${chainType}
		limit 1
	`;

	return json(res, 200, { linked: rows.length > 0 });
}

// ── Nonce ──────────────────────────────────────────────────────────────────
// Issue a nonce + EIP-4361 (SIWE) message for wallet linking.
// Caller must already be authenticated; the resulting message ties the wallet
// signature to the active session's user.

async function handleNonce(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');

	const { address, chainId } = parse(nonceBody, await readJson(req));

	const nonce = issueNonce(session.id);

	const appOrigin = env.APP_ORIGIN;
	const domain = new URL(appOrigin).host;
	const issuedAt = new Date().toISOString();
	const expirationTime = new Date(Date.now() + NONCE_TTL_SEC * 1000).toISOString();

	const message = [
		`${domain} wants you to sign in with your Ethereum account:`,
		address,
		``,
		`Link this wallet to three.ws account ${session.email}`,
		``,
		`URI: ${appOrigin}`,
		`Version: 1`,
		`Chain ID: ${chainId}`,
		`Nonce: ${nonce}`,
		`Issued At: ${issuedAt}`,
		`Expiration Time: ${expirationTime}`,
	].join('\n');

	return json(res, 200, { nonce, message, ttl: NONCE_TTL_SEC });
}

// ── Solana: nonce ──────────────────────────────────────────────────────────
// Issue a nonce + SIWS link message tying the wallet signature to the active
// session's user. Mirrors handleNonce for EVM but builds a Sign-In with
// Solana (CAIP-122 / SIP-0) message with a "Link this wallet" statement.

const nonceSolanaBody = z.object({
	address: z.string().regex(SOLANA_ADDRESS_RE),
	chainId: z.string().optional(),
});

async function handleNonceSolana(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');

	const { address, chainId } = parse(nonceSolanaBody, await readJson(req));
	const chain = chainId && ALLOWED_SOLANA_CHAINS.has(chainId) ? chainId : 'mainnet';

	const nonce = issueNonce(session.id);

	const appOrigin = env.APP_ORIGIN;
	const domain = new URL(appOrigin).host;
	const issuedAt = new Date().toISOString();
	const expirationTime = new Date(Date.now() + NONCE_TTL_SEC * 1000).toISOString();

	const message = [
		`${domain} wants you to sign in with your Solana account:`,
		address,
		``,
		`Link this wallet to three.ws account ${session.email}`,
		``,
		`URI: ${appOrigin}`,
		`Version: 1`,
		`Chain ID: ${chain}`,
		`Nonce: ${nonce}`,
		`Issued At: ${issuedAt}`,
		`Expiration Time: ${expirationTime}`,
	].join('\n');

	return json(res, 200, { nonce, message, ttl: NONCE_TTL_SEC });
}

// ── Solana: link ───────────────────────────────────────────────────────────
// Verify a SIWS message+signature signed by `address`, then insert (or no-op)
// a user_wallets row with chain_type='solana' for the session user.

const linkSolanaBody = z.object({
	message: z.string().min(32).max(4000),
	signature: z.string().min(1).max(256),
	// When true and the wallet is already linked to a different account, the
	// signature proves ownership of the keypair and the row is moved to the
	// session user atomically. The default keeps the safe "409 first, confirm
	// second" UX: the caller must opt in to a takeover.
	takeover: z.boolean().optional(),
});

async function handleLinkSolana(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');

	const body = parse(linkSolanaBody, await readJson(req));

	const fields = parseSiwsMessage(body.message);
	if (!fields) return error(res, 400, 'invalid_message', 'malformed SIWS message');

	// Domain + URI must match this deployment.
	const appOrigin = env.APP_ORIGIN;
	const appHost = new URL(appOrigin).host;
	const vercelHost = process.env.VERCEL_URL || null;
	const isLocalDev =
		process.env.VERCEL_ENV !== 'production' && process.env.VERCEL_ENV !== 'preview';
	const allowedHosts = new Set([appHost, vercelHost].filter(Boolean));
	const domainOk =
		allowedHosts.has(fields.domain) || (isLocalDev && /^localhost(:\d+)?$/.test(fields.domain));
	if (!domainOk) return error(res, 400, 'invalid_domain', `domain must be ${appHost}`);

	try {
		const u = new URL(fields.uri);
		const allowedOrigins = new Set(
			[appOrigin, vercelHost ? `https://${vercelHost}` : null].filter(Boolean),
		);
		const originOk =
			allowedOrigins.has(u.origin) ||
			(isLocalDev && /^https?:\/\/localhost(:\d+)?$/.test(u.origin));
		if (!originOk) return error(res, 400, 'invalid_uri', 'uri origin mismatch');
	} catch {
		return error(res, 400, 'invalid_uri', 'uri not a valid URL');
	}

	if (fields.chainId && !ALLOWED_SOLANA_CHAINS.has(fields.chainId)) {
		return error(res, 400, 'invalid_chain', 'unknown Solana chain ID');
	}

	const now = Date.now();
	if (fields.expirationTime && Date.parse(fields.expirationTime) < now) {
		return error(res, 400, 'expired', 'message expired');
	}
	if (fields.notBefore && Date.parse(fields.notBefore) > now) {
		return error(res, 400, 'not_yet_valid', 'message not yet valid');
	}

	// Burn the per-user link nonce.
	const nonceData = consumeNonce(fields.nonce, session.id);
	if (!nonceData) {
		return error(res, 400, 'invalid_nonce', 'unknown, expired, or invalid nonce');
	}

	let valid;
	try {
		valid = verifySiwsSignature(body.message, body.signature, fields.address);
	} catch {
		return error(res, 401, 'invalid_signature', 'signature verification failed');
	}
	if (!valid) return error(res, 401, 'invalid_signature', 'signer does not match address');

	const addr = fields.address;
	const chain = fields.chainId || 'mainnet';

	// Idempotent: already linked to this user → success.
	const [existing] = await sql`
		select id from user_wallets
		where user_id = ${session.id} and address = ${addr}
		limit 1
	`;
	if (existing) {
		return json(res, 200, { wallet: { address: addr, chain_type: 'solana', chain_id: chain } });
	}

	// Conflict: linked to a different user.
	const [conflict] = await sql`
		select user_id from user_wallets where address = ${addr} limit 1
	`;
	if (conflict) {
		// Signature already verified above — the caller controls the keypair.
		// With explicit takeover consent, move the wallet row to the session
		// user atomically. Without it, surface 409 so the UI can confirm.
		if (!body.takeover) {
			return error(
				res,
				409,
				'address_in_use',
				'this address is already linked to another account',
				{ takeover_available: true },
			);
		}

		await sql.transaction([
			sql`delete from user_wallets where address = ${addr}`,
			sql`insert into user_wallets (user_id, address, chain_type, is_primary)
				values (${session.id}, ${addr}, 'solana', false)`,
		]);
		logAudit({
			userId: conflict.user_id,
			action: 'unlink_wallet_transferred',
			resourceId: addr,
			meta: { to_user_id: session.id },
			req,
		});
		logAudit({
			userId: session.id,
			action: 'link_wallet_solana_takeover',
			resourceId: addr,
			meta: { from_user_id: conflict.user_id },
			req,
		});
		return json(res, 200, {
			wallet: { address: addr, chain_type: 'solana', chain_id: chain },
			transferred: true,
		});
	}

	await sql`
		insert into user_wallets (user_id, address, chain_type, is_primary)
		values (${session.id}, ${addr}, 'solana', false)
	`;
	logAudit({ userId: session.id, action: 'link_wallet_solana', resourceId: addr, req });

	return json(res, 201, { wallet: { address: addr, chain_type: 'solana', chain_id: chain } });
}

// ── Set primary ────────────────────────────────────────────────────────────
// Mark one of the caller's wallets as primary; demote every other row in
// the same transaction so exactly one wallet is primary at a time.
//
// Body: { address }. EVM addresses are stored lowercased; Solana base58 is
// case-sensitive — we try the literal address first, then the lowercased
// form as a fallback for EVM callers who send a mixed-case checksum.

async function handleSetPrimary(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');

	const body = await readJson(req).catch(() => null);
	const rawAddress = body?.address;
	if (!rawAddress || typeof rawAddress !== 'string') {
		return error(res, 400, 'validation_error', 'address required');
	}

	const candidates = [rawAddress, rawAddress.toLowerCase()].filter(
		(v, i, a) => a.indexOf(v) === i,
	);

	const [wallet] = await sql`
		select id, address, is_primary
		from user_wallets
		where user_id = ${session.id}
		  and address = any(${candidates}::text[])
		limit 1
	`;
	if (!wallet) return error(res, 404, 'not_found', 'wallet not found');

	if (!wallet.is_primary) {
		await sql.transaction([
			sql`update user_wallets set is_primary = false where user_id = ${session.id} and is_primary = true`,
			sql`update user_wallets set is_primary = true  where id = ${wallet.id}`,
		]);
		logAudit({
			userId: session.id,
			action: 'set_primary_wallet',
			resourceId: wallet.address,
			req,
		});
	}

	return json(res, 200, { primary: { address: wallet.address } });
}

// ── Unlink ─────────────────────────────────────────────────────────────────
// Unlink a wallet from authenticated user.
// Refuse if it's the only wallet AND user has no email+password.

async function handleUnlinkWallet(req, res, address) {
	if (cors(req, res, { methods: 'DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['DELETE'])) return;

	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');

	if (!address) return error(res, 400, 'missing_address', 'address required');

	const addrLower = address.toLowerCase();

	// 1. Check that this wallet belongs to the user.
	const [wallet] = await sql`
		select id from user_wallets
		where user_id = ${session.id} and address = ${addrLower}
		limit 1
	`;
	if (!wallet) return error(res, 404, 'not_found', 'wallet not found');

	// 2. Check if this is the only wallet.
	const [count] = await sql`
		select count(*) as n from user_wallets
		where user_id = ${session.id}
	`;
	const walletCount = count.n;

	if (walletCount === 1) {
		// 3. If only wallet, check if user has password-based auth.
		const [user] = await sql`
			select password_hash from users where id = ${session.id} limit 1
		`;
		if (!user.password_hash) {
			return error(
				res,
				400,
				'cannot_remove_last_wallet',
				'cannot remove the last wallet if account has no password',
			);
		}
	}

	// 4. Delete the wallet.
	await sql`delete from user_wallets where user_id = ${session.id} and address = ${addrLower}`;
	logAudit({ userId: session.id, action: 'unlink_wallet', resourceId: addrLower, req });

	return json(res, 200, { removed: true });
}
