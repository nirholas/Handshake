/**
 * Permissions API dispatcher
 * --------------------------
 * POST /api/permissions/grant
 * GET  /api/permissions/list
 * GET  /api/permissions/metadata
 * POST /api/permissions/redeem
 * POST /api/permissions/revoke
 * GET  /api/permissions/verify
 *
 * Routed via vercel.json — see top of file path patterns.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ethers, Wallet, JsonRpcProvider, Contract, Interface, getAddress, isAddress } from 'ethers';

import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { parse } from '../_lib/validate.js';
import { env } from '../_lib/env.js';
import { recordEvent } from '../_lib/usage.js';
import { SERVER_CHAIN_META } from '../_lib/onchain.js';
import {
	DELEGATION_MANAGER_DEPLOYMENTS,
	DELEGATION_MANAGER_ABI,
	EIP712_DOMAIN,
	DELEGATION_TYPES,
} from '../../src/erc7710/abi.js';
import {
	isDelegationValid,
	redeemDelegation,
	PermissionError,
} from '../../src/permissions/toolkit.js';

export default wrap(async (req, res) => {
	const action = req.query?.action;

	switch (action) {
		case 'grant':
			return handleGrant(req, res);
		case 'list':
			return handleList(req, res);
		case 'metadata':
			return handleMetadata(req, res);
		case 'redeem':
			return handleRedeem(req, res);
		case 'revoke':
			return handleRevoke(req, res);
		case 'verify':
			return handleVerify(req, res);
		default:
			return error(res, 404, 'not_found', 'unknown permissions action');
	}
});

// ── grant ──────────────────────────────────────────────────────────────────

const ROOT_AUTHORITY = '0x0000000000000000000000000000000000000000000000000000000000000000';

const hexAddr = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address');
const hexBytes = z.string().regex(/^0x([0-9a-fA-F]{2})*$/, 'must be 0x-prefixed hex bytes');
const hexBytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hex value');

const caveatSchema = z.object({
	enforcer: hexAddr,
	terms: hexBytes.default('0x'),
	args: hexBytes.default('0x'),
});

const delegationSchema = z.object({
	delegator: hexAddr,
	delegate: hexAddr,
	authority: hexBytes32.optional(),
	caveats: z.array(caveatSchema).default([]),
	salt: z.union([
		z
			.string()
			.regex(/^(0x[0-9a-fA-F]+|\d+)$/, 'salt must be a decimal or 0x-prefixed hex integer'),
		z.number().int().nonnegative(),
	]),
	signature: hexBytes,
	hash: hexBytes32,
});

const scopeSchema = z.object({
	token: z.string().min(1),
	maxAmount: z.string().min(1),
	period: z.enum(['daily', 'weekly', 'once']),
	targets: z.array(hexAddr).min(1),
	expiry: z.number().int().positive(),
});

const grantBodySchema = z.object({
	agentId: z.string().uuid(),
	chainId: z.number().int().positive(),
	delegation: delegationSchema,
	scope: scopeSchema,
});

async function handleGrant(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.permissionsGrant(user.id);
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const raw = await readJson(req);
	const parsed = grantBodySchema.safeParse(raw);
	if (!parsed.success) {
		const msg = parsed.error.issues
			.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
			.join('; ');
		return error(res, 400, 'validation_error', msg);
	}
	const { agentId, chainId, delegation, scope } = parsed.data;

	// chainId must be a supported DelegationManager deployment
	if (!(chainId in DELEGATION_MANAGER_DEPLOYMENTS)) {
		return error(res, 400, 'chain_not_supported', `chainId ${chainId} is not supported`);
	}

	// Owner gate: agent must exist and belong to the authenticated user
	const [agent] = await sql`
		select id, user_id from agent_identities
		where id = ${agentId} and deleted_at is null
		limit 1
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');
	if (agent.user_id !== user.id) return error(res, 403, 'not_owner', 'you do not own this agent');

	// Wallet linkage: delegation.delegator must be a wallet linked to the authenticated user
	const delegatorLower = delegation.delegator.toLowerCase();
	const [linkedWallet] = await sql`
		select address from user_wallets
		where user_id = ${user.id} and address = ${delegatorLower}
		limit 1
	`;
	if (!linkedWallet) {
		return error(
			res,
			409,
			'wallet_not_linked',
			'delegation.delegator is not linked to your account',
		);
	}

	// Signature verification — two steps:
	// 1. Re-derive the EIP-712 hash from delegation fields and compare with delegation.hash
	//    (prevents chain-hop replay: different contract address → different hash).
	// 2. Recover the signer from the signature and verify it matches delegation.delegator.
	const managerAddr = DELEGATION_MANAGER_DEPLOYMENTS[chainId];
	const eip712Domain = EIP712_DOMAIN({ chainId, verifyingContract: managerAddr });
	let derivedHash;
	try {
		const structValue = {
			delegate: delegation.delegate,
			delegator: delegation.delegator,
			authority: delegation.authority || ROOT_AUTHORITY,
			caveats: delegation.caveats.map((c) => ({
				enforcer: c.enforcer,
				terms: c.terms,
				args: c.args,
			})),
			salt: BigInt(delegation.salt),
		};

		derivedHash = ethers.TypedDataEncoder.hash(eip712Domain, DELEGATION_TYPES, structValue);

		if (derivedHash.toLowerCase() !== delegation.hash.toLowerCase()) {
			return error(
				res,
				400,
				'hash_mismatch',
				'delegation.hash does not match the delegation fields',
			);
		}

		const recovered = ethers.verifyTypedData(
			eip712Domain,
			DELEGATION_TYPES,
			structValue,
			delegation.signature,
		);
		if (recovered.toLowerCase() !== delegatorLower) {
			return error(
				res,
				400,
				'signature_invalid',
				'signature does not match delegation.delegator',
			);
		}
	} catch (err) {
		if (err instanceof PermissionError) {
			return error(res, 400, err.code || 'signature_invalid', err.message);
		}
		return error(res, 400, 'signature_invalid', err.message || 'invalid delegation signature');
	}

	// On-chain revocation check (isDelegationValid from task 04)
	const rpcUrl = SERVER_CHAIN_META[chainId]?.rpc;
	const validity = await isDelegationValid({ hash: delegation.hash, chainId, rpcUrl }).catch(
		(err) => {
			if (err instanceof PermissionError) return { valid: false, reason: err.code };
			console.warn('[grant] isDelegationValid error', err?.message);
			return { valid: true }; // RPC unavailable; proceed and rely on indexer for revocation
		},
	);
	if (!validity.valid) {
		return error(
			res,
			400,
			validity.reason || 'signature_invalid',
			'delegation is not valid on-chain',
		);
	}

	// Scope sanity checks
	const nowSec = Math.floor(Date.now() / 1000);
	if (scope.expiry <= nowSec + 60) {
		return error(
			res,
			400,
			'validation_error',
			'scope.expiry must be at least 60 seconds in the future',
		);
	}
	if (scope.expiry > nowSec + 365 * 24 * 3600) {
		return error(res, 400, 'validation_error', 'scope.expiry must be within 365 days');
	}
	let maxAmountBig;
	try {
		maxAmountBig = BigInt(scope.maxAmount);
	} catch {
		return error(res, 400, 'validation_error', 'scope.maxAmount must be a numeric string');
	}
	if (maxAmountBig <= 0n) {
		return error(res, 400, 'validation_error', 'scope.maxAmount must be positive');
	}
	let targets;
	try {
		targets = scope.targets.map((t) => ethers.getAddress(t));
	} catch {
		return error(res, 400, 'validation_error', 'scope.targets contains an invalid address');
	}

	const delegationHash = derivedHash;
	const expiresAt = new Date(scope.expiry * 1000).toISOString();
	const delegatorAddr = ethers.getAddress(delegation.delegator);
	const delegateAddr = ethers.getAddress(delegation.delegate);

	const delegationJson = {
		delegator: delegation.delegator,
		delegate: delegation.delegate,
		authority: delegation.authority || ROOT_AUTHORITY,
		caveats: delegation.caveats,
		salt: String(delegation.salt),
		// signature stored as part of the envelope; not logged separately
		signature: delegation.signature,
		hash: delegationHash,
	};
	const scopeJson = { ...scope, targets };

	// Persist — delegation_hash is UNIQUE; on conflict return 409
	const rows = await sql`
		insert into agent_delegations (
			agent_id, chain_id, delegator_address, delegate_address,
			delegation_hash, delegation_json, scope, expires_at
		)
		values (
			${agentId},
			${chainId},
			${delegatorAddr.toLowerCase()},
			${delegateAddr.toLowerCase()},
			${delegationHash},
			${JSON.stringify(delegationJson)}::jsonb,
			${JSON.stringify(scopeJson)}::jsonb,
			${expiresAt}
		)
		on conflict (delegation_hash) do nothing
		returning id
	`;

	if (!rows || rows.length === 0) {
		const [existing] = await sql`
			select id from agent_delegations where delegation_hash = ${delegationHash} limit 1
		`;
		return error(res, 409, 'duplicate_delegation', 'this delegation has already been granted', {
			id: existing?.id,
		});
	}

	const { id } = rows[0];

	recordEvent({ userId: user.id, agentId, kind: 'permissions.grant' });

	return json(res, 200, { ok: true, id, delegationHash, expiresAt });
}

// ── list ───────────────────────────────────────────────────────────────────

const LIST_PUBLIC_CACHE = 'public, max-age=30, s-maxage=60';
const VALID_STATUSES = new Set(['active', 'revoked', 'expired', 'all']);

async function handleList(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;

	if (req.method !== 'GET') {
		res.setHeader('allow', 'GET, OPTIONS');
		return error(res, 405, 'method_not_allowed', 'method not allowed');
	}

	const rl = await limits.read(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const url = new URL(req.url, 'http://x');
	const agentId = url.searchParams.get('agentId') || null;
	const delegator = url.searchParams.get('delegator') || null;

	if (!agentId && !delegator) {
		return error(res, 400, 'missing_filter', 'agentId or delegator query param is required');
	}

	const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	if (agentId && !UUID_RE.test(agentId)) {
		return error(res, 400, 'invalid_id', 'agentId must be a valid UUID');
	}

	const statusParam = url.searchParams.get('status') || 'active';
	if (!VALID_STATUSES.has(statusParam)) {
		return error(
			res,
			400,
			'validation_error',
			'status must be active, revoked, expired, or all',
		);
	}

	const chainIdParam = url.searchParams.get('chainId');
	const chainId = chainIdParam ? parseInt(chainIdParam, 10) : null;
	if (chainIdParam && (Number.isNaN(chainId) || chainId <= 0)) {
		return error(res, 400, 'validation_error', 'chainId must be a positive integer');
	}

	const limitParam = Math.min(
		200,
		Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)),
	);
	const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));

	// agentId-only path: public, no auth required
	if (agentId && !delegator) {
		const rows = await sql`
			SELECT
				id, chain_id, delegator_address, delegate_address, delegation_hash,
				scope, status, expires_at, created_at, last_redeemed_at, redemption_count
			FROM agent_delegations
			WHERE agent_id = ${agentId}
			  AND (${statusParam} = 'all' OR status = ${statusParam})
			  AND (${chainId}::integer IS NULL OR chain_id = ${chainId}::integer)
			ORDER BY created_at DESC
			LIMIT ${limitParam} OFFSET ${offset}
		`;

		const delegations = rows.map(toListPublicShape);
		const body = { ok: true, delegations };
		if (rows.length === limitParam) body.nextOffset = offset + limitParam;

		return json(res, 200, body, { 'cache-control': LIST_PUBLIC_CACHE });
	}

	// delegator path (or both provided): session required
	const session = await getSessionUser(req, res);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) {
		return error(res, 401, 'unauthorized', 'sign in required to list delegations by delegator');
	}
	const userId = session?.id ?? bearer?.userId;

	// Verify the session user owns this delegator address
	const targetDelegator = delegator || null;
	if (targetDelegator) {
		const [wallet] = await sql`
			SELECT 1 FROM user_wallets
			WHERE user_id = ${userId}
			  AND lower(address) = lower(${targetDelegator})
			LIMIT 1
		`;
		if (!wallet) {
			return error(
				res,
				403,
				'forbidden',
				'delegator address does not belong to your account',
			);
		}
	}

	const whereAgentId = agentId;
	const rows = await sql`
		SELECT
			id, chain_id, delegator_address, delegate_address, delegation_hash,
			delegation_json, scope, status, expires_at, created_at, last_redeemed_at, redemption_count
		FROM agent_delegations
		WHERE (${whereAgentId}::uuid IS NULL OR agent_id = ${whereAgentId}::uuid)
		  AND (${targetDelegator}::text IS NULL OR lower(delegator_address) = lower(${targetDelegator}::text))
		  AND (${statusParam} = 'all' OR status = ${statusParam})
		  AND (${chainId}::integer IS NULL OR chain_id = ${chainId}::integer)
		ORDER BY created_at DESC
		LIMIT ${limitParam} OFFSET ${offset}
	`;

	const delegations = rows.map(toListAuthShape);
	const body = { ok: true, delegations };
	if (rows.length === limitParam) body.nextOffset = offset + limitParam;

	return json(res, 200, body);
}

function toListPublicShape(row) {
	return {
		id: row.id,
		chainId: row.chain_id,
		delegator: row.delegator_address,
		delegate: row.delegate_address,
		delegationHash: row.delegation_hash,
		scope: row.scope,
		status: row.status,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
		lastRedeemedAt: row.last_redeemed_at,
		redemptionCount: row.redemption_count,
	};
}

function toListAuthShape(row) {
	return {
		...toListPublicShape(row),
		delegationJson: row.delegation_json,
	};
}

// ── metadata ───────────────────────────────────────────────────────────────

function metadataCorsHeaders(res) {
	res.setHeader('access-control-allow-origin', '*');
	res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
	res.setHeader('access-control-allow-headers', 'content-type');
	res.setHeader('access-control-max-age', '86400');
}

async function handleMetadata(req, res) {
	if (req.method === 'OPTIONS') {
		metadataCorsHeaders(res);
		res.statusCode = 204;
		res.end();
		return;
	}

	metadataCorsHeaders(res);

	if (req.method !== 'GET') {
		res.setHeader('allow', 'GET, OPTIONS');
		return error(res, 405, 'method_not_allowed', 'method not allowed');
	}

	const rl = await limits.read(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const url = new URL(req.url, 'http://x');
	const agentId = url.searchParams.get('agentId');
	if (!agentId) return error(res, 400, 'missing_param', 'agentId is required');

	const chainIdParam = url.searchParams.get('chainId');
	const chainId = chainIdParam ? parseInt(chainIdParam, 10) : null;
	if (chainIdParam && (Number.isNaN(chainId) || chainId <= 0)) {
		return error(res, 400, 'validation_error', 'chainId must be a positive integer');
	}

	// Verify agent exists
	const [agent] = await sql`
		SELECT id FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
		LIMIT 1
	`;
	if (!agent) {
		return json(res, 404, { ok: false, error: 'agent_not_found' });
	}

	const rows = await sql`
		SELECT
			chain_id, delegator_address, delegate_address, delegation_hash,
			delegation_json, scope, expires_at, created_at, revoked_at
		FROM agent_delegations
		WHERE agent_id = ${agentId}
		  AND status = 'active'
		  AND (${chainId}::integer IS NULL OR chain_id = ${chainId}::integer)
		ORDER BY expires_at DESC
	`;

	const delegations = rows.map((r) => ({
		chainId: r.chain_id,
		delegator: r.delegator_address,
		delegate: r.delegate_address,
		hash: r.delegation_hash,
		scope: r.scope,
		expiresAt: r.expires_at,
		createdAt: r.created_at,
		envelope: r.delegation_json,
	}));

	// delegationManager: use the filtered chain if provided, otherwise first delegation's chain
	const resolveChain = chainId ?? rows[0]?.chain_id ?? null;
	const delegationManager = resolveChain
		? (DELEGATION_MANAGER_DEPLOYMENTS[resolveChain] ?? null)
		: null;

	// Last-Modified: max of created_at and revoked_at across returned rows
	let lastModified = null;
	for (const r of rows) {
		const candidates = [r.created_at, r.revoked_at].filter(Boolean);
		for (const d of candidates) {
			if (!lastModified || d > lastModified) lastModified = d;
		}
	}

	const body = {
		ok: true,
		agentId,
		spec: 'erc-7715/0.1',
		delegationManager,
		delegations,
	};

	const bodyStr = JSON.stringify(body);
	const etag = `"${createHash('sha256').update(bodyStr).digest('hex').slice(0, 32)}"`;

	res.setHeader('cache-control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
	res.setHeader('etag', etag);
	if (lastModified) res.setHeader('last-modified', new Date(lastModified).toUTCString());

	// ETag short-circuit
	if (req.headers['if-none-match'] === etag) {
		res.statusCode = 304;
		res.end();
		return;
	}

	res.statusCode = 200;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.end(bodyStr);
}

// ── redeem ─────────────────────────────────────────────────────────────────

// Idempotency cache (in-memory, 10-minute TTL)
const idempotencyCache = new Map();
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

function idempotencyGet(key) {
	const entry = idempotencyCache.get(key);
	if (!entry) return null;
	if (Date.now() > entry.expiresAt) {
		idempotencyCache.delete(key);
		return null;
	}
	return entry.result;
}

function idempotencySet(key, result) {
	// Purge expired entries opportunistically.
	const now = Date.now();
	for (const [k, v] of idempotencyCache) {
		if (now > v.expiresAt) idempotencyCache.delete(k);
	}
	idempotencyCache.set(key, { result, expiresAt: now + IDEMPOTENCY_TTL_MS });
}

const hexData = z.string().regex(/^0x[0-9a-fA-F]*$/, 'must be 0x-prefixed hex');
const weiValue = z.string().regex(/^\d+$/, 'value must be a decimal integer string');

const callSchema = z.object({
	to: z.string().refine((v) => isAddress(v), 'to must be a valid EIP-55 address'),
	value: weiValue.default('0'),
	data: hexData.default('0x'),
});

const redeemBodySchema = z.object({
	id: z.string().uuid(),
	calls: z.array(callSchema).min(1).max(4),
});

// ERC-20 selector helpers
const TRANSFER_SELECTOR = '0xa9059cbb';
const TRANSFER_FROM_SELECTOR = '0x23b872dd';

// Decode token amount from ERC-20 transfer/transferFrom calldata.
// Param slots (0-indexed) start at hex[8 + n*64]. Returns null if unrecognised.
function decodeErc20AmountFixed(data) {
	if (!data || data.length < 10) return null;
	const hex = data.startsWith('0x') ? data.slice(2) : data;
	const sel = '0x' + hex.slice(0, 8).toLowerCase();
	try {
		if (sel === TRANSFER_SELECTOR && hex.length >= 8 + 64 + 64) {
			// slot 1 (0-indexed) = amount
			return BigInt('0x' + hex.slice(8 + 64, 8 + 64 + 64));
		}
		if (sel === TRANSFER_FROM_SELECTOR && hex.length >= 8 + 64 + 64 + 64) {
			// slot 2 (0-indexed) = amount
			return BigInt('0x' + hex.slice(8 + 64 + 64, 8 + 64 + 64 + 64));
		}
	} catch {
		return null;
	}
	return null;
}

function periodStart(period) {
	const now = new Date();
	if (period === 'daily') {
		return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	}
	if (period === 'weekly') {
		const day = now.getUTCDay(); // 0=Sun
		const diff = day === 0 ? -6 : 1 - day; // back to Monday
		const monday = new Date(now);
		monday.setUTCDate(now.getUTCDate() + diff);
		monday.setUTCHours(0, 0, 0, 0);
		return monday;
	}
	// 'once' or unknown: entire history counts
	return new Date(0);
}

const PERMISSIONS_PUBLIC_RPCS = {
	1:        'https://cloudflare-eth.com',
	8453:     'https://mainnet.base.org',
	84532:    'https://sepolia.base.org',
	11155111: 'https://rpc.sepolia.org',
	421614:   'https://sepolia-rollup.arbitrum.io/rpc',
	11155420: 'https://sepolia.optimism.io',
};

function getRpcUrl(chainId) {
	return (
		process.env[`RPC_URL_${chainId}`] ||
		// Shared fallback names that might already exist in the project
		(chainId === 84532 ? process.env.BASE_SEPOLIA_RPC_URL : null) ||
		(chainId === 11155111 ? process.env.SEPOLIA_RPC_URL : null) ||
		PERMISSIONS_PUBLIC_RPCS[chainId] ||
		null
	);
}

async function handleRedeem(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	// Feature flag — 503 when disabled
	if (!env.PERMISSIONS_RELAYER_ENABLED) {
		return error(res, 503, 'feature_disabled', 'relayer not enabled on this deployment');
	}

	// Rate limit — strict bucket since each request costs gas
	const ip = clientIp(req);
	const rl = await limits.strict(ip);
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	// Auth — agent bearer only (no user sessions on this machine endpoint)
	const token = extractBearer(req);
	const bearer = await authenticateBearer(token);
	if (!bearer) return error(res, 401, 'unauthorized', 'valid bearer token required');
	if (!hasScope(bearer.scope, 'permissions:redeem')) {
		return error(
			res,
			403,
			'insufficient_scope',
			"token must include 'permissions:redeem' scope",
		);
	}

	// Idempotency-Key check (before parsing body — key is in header)
	const idempotencyKey = req.headers['idempotency-key'] || null;

	// Parse body
	let body;
	try {
		body = parse(redeemBodySchema, await readJson(req));
	} catch (err) {
		return error(res, err.status || 400, err.code || 'validation_error', err.message);
	}
	const { id, calls } = body;

	// Idempotency-Key early return
	if (idempotencyKey) {
		const cached = idempotencyGet(`${id}:${idempotencyKey}`);
		if (cached) return json(res, 200, cached);
	}

	// Load delegation row
	const [row] = await sql`
		SELECT id, agent_id, chain_id, delegation_hash, delegation_json, scope,
		       status, expires_at, redemption_count, last_redeemed_at
		FROM agent_delegations
		WHERE id = ${id}
		LIMIT 1
	`;
	if (!row) return error(res, 404, 'delegation_not_found', 'delegation not found');

	// Check status
	if (row.status === 'revoked') {
		return error(res, 409, 'delegation_revoked', 'delegation has been revoked');
	}

	// Check expiry; auto-flip status if expired
	const now = new Date();
	if (new Date(row.expires_at) <= now) {
		// Side-effect: mark as expired without blocking
		sql`UPDATE agent_delegations SET status = 'expired' WHERE id = ${id}`.catch(() => {});
		return error(res, 409, 'delegation_expired', 'delegation has expired');
	}

	if (row.status !== 'active') {
		return error(res, 409, 'delegation_expired', `delegation status is '${row.status}'`);
	}

	const scope = row.scope;
	const chainId = row.chain_id;

	// ── Server-side scope checks (cheap, prevent paying gas on doomed tx) ────

	// 1. Target allow-list
	const allowedTargets = new Set((scope.targets || []).map((t) => t.toLowerCase()));
	for (const call of calls) {
		if (!allowedTargets.has(call.to.toLowerCase())) {
			return error(
				res,
				403,
				'target_not_allowed',
				`call target ${call.to} is not in scope.targets`,
			);
		}
	}

	// 2. Native ETH: reject non-zero value if token is ERC-20
	const isNative = scope.token === 'native';
	if (!isNative) {
		for (const call of calls) {
			if (BigInt(call.value) > 0n) {
				return error(
					res,
					403,
					'scope_exceeded',
					'non-zero ETH value not allowed for ERC-20 scoped delegation',
				);
			}
		}
	}

	// 3. Amount cap: compute period spend from usage_events history
	const maxAmount = BigInt(scope.maxAmount || '0');
	const pStart = periodStart(scope.period || 'daily');

	if (isNative) {
		// Sum ETH values in this request
		const requestAmount = calls.reduce((s, c) => s + BigInt(c.value), 0n);

		// Query period history
		const [histRow] = await sql`
			SELECT COALESCE(SUM((meta->>'amount')::numeric), 0) AS spent
			FROM usage_events
			WHERE kind = 'permissions.redeem'
			  AND meta->>'delegation_id' = ${id}
			  AND created_at >= ${pStart.toISOString()}
		`;
		const historicalSpend = BigInt(Math.floor(Number(histRow?.spent ?? '0')));

		if (requestAmount + historicalSpend > maxAmount) {
			return error(
				res,
				403,
				'scope_exceeded',
				'ETH spend would exceed scope.maxAmount for this period',
				{
					maxAmount: scope.maxAmount,
					periodSpent: historicalSpend.toString(),
					requested: requestAmount.toString(),
				},
			);
		}
	} else {
		// ERC-20: decode transfer amounts from call data
		let requestAmount = 0n;
		for (const call of calls) {
			const decoded = decodeErc20AmountFixed(call.data);
			if (decoded === null) {
				return error(
					res,
					403,
					'scope_exceeded',
					`call to ${call.to} does not look like an ERC-20 transfer or transferFrom`,
				);
			}
			requestAmount += decoded;
		}

		const [histRow] = await sql`
			SELECT COALESCE(SUM((meta->>'amount')::numeric), 0) AS spent
			FROM usage_events
			WHERE kind = 'permissions.redeem'
			  AND meta->>'delegation_id' = ${id}
			  AND created_at >= ${pStart.toISOString()}
		`;
		const historicalSpend = BigInt(Math.floor(Number(histRow?.spent ?? '0')));

		if (requestAmount + historicalSpend > maxAmount) {
			return error(
				res,
				403,
				'scope_exceeded',
				'token spend would exceed scope.maxAmount for this period',
				{
					maxAmount: scope.maxAmount,
					periodSpent: historicalSpend.toString(),
					requested: requestAmount.toString(),
				},
			);
		}
	}

	// ── Build signer ───────────────────────────────────────────────────────
	const rpcUrl = getRpcUrl(chainId);
	if (!rpcUrl) {
		return error(
			res,
			502,
			'rpc_error',
			`no RPC URL configured for chain ${chainId} (set RPC_URL_${chainId})`,
		);
	}

	let signer;
	try {
		const provider = new JsonRpcProvider(rpcUrl);
		// AGENT_RELAYER_KEY is never logged — only use it to construct the Wallet
		signer = new Wallet(env.AGENT_RELAYER_KEY, provider);
	} catch {
		return error(res, 500, 'internal_error', 'failed to initialise relayer signer');
	}

	// ── Submit on-chain ────────────────────────────────────────────────────
	let txHash, receipt;
	try {
		({ txHash, receipt } = await redeemDelegation({
			delegation: row.delegation_json,
			delegationHash: row.delegation_hash,
			calls,
			signer,
			chainId,
		}));
	} catch (err) {
		if (err instanceof PermissionError && err.code === 'delegation_revoked') {
			// Auto-sync status in DB
			sql`UPDATE agent_delegations SET status = 'revoked' WHERE id = ${id}`.catch(() => {});
			return error(res, 409, 'delegation_revoked', err.message);
		}
		// RPC or provider error
		console.error('[permissions/redeem] on-chain error', err?.code, err?.message);
		return error(res, 502, 'rpc_error', err?.message || 'on-chain call failed');
	}

	// ── Update DB ──────────────────────────────────────────────────────────
	await sql`
		UPDATE agent_delegations
		SET redemption_count = redemption_count + 1,
		    last_redeemed_at = NOW()
		WHERE id = ${id}
	`;

	// Compute amount redeemed for usage tracking
	const redeemAmount = isNative
		? calls.reduce((s, c) => s + BigInt(c.value), 0n).toString()
		: calls
				.reduce((s, c) => {
					const a = decodeErc20AmountFixed(c.data);
					return s + (a ?? 0n);
				}, 0n)
				.toString();

	recordEvent({
		userId: bearer.userId,
		apiKeyId: bearer.apiKeyId ?? null,
		agentId: row.agent_id,
		kind: 'permissions.redeem',
		status: 'ok',
		meta: {
			delegation_id: id,
			chain_id: chainId,
			tx_hash: txHash,
			gas_used: receipt.gasUsed,
			amount: redeemAmount,
		},
	});

	const result = { ok: true, txHash, receipt };

	if (idempotencyKey) {
		idempotencySet(`${id}:${idempotencyKey}`, result);
	}

	return json(res, 200, result);
}

// ── revoke ─────────────────────────────────────────────────────────────────

const revokeBodySchema = z.object({
	id: z.string().uuid(),
	txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 66-char 0x-prefixed hex string'),
});

const revokeIface = new Interface(DELEGATION_MANAGER_ABI);
const _revokeEvent = revokeIface.getEvent('DisabledDelegation');
if (!_revokeEvent) throw new Error('DisabledDelegation event not found in DELEGATION_MANAGER_ABI — check src/erc7710/abi.js');
const DISABLED_TOPIC = _revokeEvent.topicHash;

const RPC_TIMEOUT_MS = 5000;

function withTimeout(promise, ms) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`rpc timeout after ${ms}ms`)), ms);
		Promise.resolve(promise).then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e) => {
				clearTimeout(t);
				reject(e);
			},
		);
	});
}

async function handleRevoke(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.permissionsRevoke(user.id);
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const raw = await readJson(req);
	const parsed = revokeBodySchema.safeParse(raw);
	if (!parsed.success) {
		const msg = parsed.error.issues
			.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
			.join('; ');
		return error(res, 400, 'validation_error', msg);
	}
	const { id, txHash } = parsed.data;

	// Lookup delegation + agent owner in one join
	const [row] = await sql`
		SELECT d.*, a.user_id AS agent_owner_user_id
		FROM agent_delegations d
		JOIN agent_identities a ON a.id = d.agent_id AND a.deleted_at IS NULL
		WHERE d.id = ${id}
		LIMIT 1
	`;
	if (!row) return error(res, 404, 'delegation_not_found', 'delegation not found');

	// Authorization: agent owner OR the delegator wallet linked to this user
	const isAgentOwner = row.agent_owner_user_id === user.id;
	let isDelegator = false;
	if (!isAgentOwner) {
		const [wallet] = await sql`
			SELECT address FROM user_wallets
			WHERE user_id = ${user.id} AND address = ${row.delegator_address}
			LIMIT 1
		`;
		isDelegator = !!wallet;
	}
	if (!isAgentOwner && !isDelegator) {
		return error(res, 403, 'forbidden', 'you are not authorized to revoke this delegation');
	}

	// Build a read-only provider for the delegation's chain
	const chainMeta = SERVER_CHAIN_META[row.chain_id];
	if (!chainMeta) {
		return error(res, 400, 'chain_not_supported', `chainId ${row.chain_id} is not supported`);
	}
	const managerAddr = DELEGATION_MANAGER_DEPLOYMENTS[row.chain_id];
	if (!managerAddr) {
		return error(
			res,
			400,
			'chain_not_supported',
			`no DelegationManager for chainId ${row.chain_id}`,
		);
	}

	const provider = new JsonRpcProvider(chainMeta.rpc, row.chain_id, { staticNetwork: true });

	// Fetch receipt (up to 3 attempts with short back-off for propagation lag)
	let receipt = null;
	for (let attempt = 0; attempt < 3 && !receipt; attempt++) {
		if (attempt > 0) await new Promise((r) => setTimeout(r, 800));
		receipt = await withTimeout(provider.getTransactionReceipt(txHash), RPC_TIMEOUT_MS).catch(
			() => null,
		);
	}
	if (!receipt) return error(res, 400, 'tx_not_found', 'transaction receipt not found');

	if (receipt.status === 0) {
		return error(res, 400, 'tx_reverted', 'transaction was reverted on-chain');
	}

	// Decode DisabledDelegation event: (bytes32 indexed delegationHash, address indexed delegator, address indexed delegate, ...)
	// topics[0] = event sig, topics[1] = delegationHash, topics[2] = delegator, topics[3] = delegate
	const disabledLog = receipt.logs.find((log) => log.topics[0] === DISABLED_TOPIC);
	if (!disabledLog) {
		return error(res, 400, 'tx_mismatch', 'transaction contains no DisabledDelegation event');
	}

	const loggedHash = disabledLog.topics[1]; // bytes32 indexed — raw topic IS the value
	if (loggedHash.toLowerCase() !== row.delegation_hash.toLowerCase()) {
		return error(res, 400, 'tx_mismatch', 'transaction revoked a different delegation hash');
	}

	// Second confirmation: call disabledDelegations(hash) on-chain
	const manager = new Contract(managerAddr, DELEGATION_MANAGER_ABI, provider);
	const isDisabled = await withTimeout(
		manager.disabledDelegations(row.delegation_hash),
		RPC_TIMEOUT_MS,
	).catch(() => null);
	if (!isDisabled) {
		return error(
			res,
			400,
			'not_yet_disabled',
			'delegation is not yet marked disabled on-chain',
		);
	}

	// Flip status active → revoked; 0 rows = already revoked / never active
	const updated = await sql`
		UPDATE agent_delegations
		SET status = 'revoked', revoked_at = NOW(), tx_hash_revoke = ${txHash}
		WHERE id = ${id} AND status = 'active'
		RETURNING revoked_at
	`;
	if (!updated || updated.length === 0) {
		const [current] = await sql`SELECT status FROM agent_delegations WHERE id = ${id} LIMIT 1`;
		const currentStatus = current?.status ?? 'unknown';
		return error(
			res,
			409,
			'already_revoked',
			`delegation cannot be revoked (current status: ${currentStatus})`,
		);
	}

	const revokedAt = updated[0].revoked_at;

	recordEvent({ userId: user.id, agentId: row.agent_id, kind: 'permissions.revoke' });

	return json(res, 200, { ok: true, status: 'revoked', revokedAt });
}

// ── verify ─────────────────────────────────────────────────────────────────

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const CACHE_VALID = 'public, max-age=30, s-maxage=60';
const CACHE_INVALID = 'public, max-age=300, s-maxage=600';

async function handleVerify(req, res) {
	res.setHeader('access-control-allow-origin', '*');
	res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
	res.setHeader('access-control-allow-headers', 'content-type');
	res.setHeader('access-control-max-age', '86400');
	if (req.method === 'OPTIONS') {
		res.statusCode = 204;
		res.end();
		return;
	}

	if (req.method !== 'GET') {
		res.setHeader('allow', 'GET, OPTIONS');
		return error(res, 405, 'method_not_allowed', 'method not allowed');
	}

	const rl = await limits.read(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const url = new URL(req.url, 'http://x');
	const hash = url.searchParams.get('hash');
	const chainIdRaw = url.searchParams.get('chainId');

	if (!hash) return error(res, 400, 'validation_error', 'hash query param is required');
	if (!HASH_RE.test(hash))
		return error(res, 400, 'validation_error', 'hash must be 0x + 64 hex chars');
	if (!chainIdRaw) return error(res, 400, 'validation_error', 'chainId query param is required');

	const chainId = parseInt(chainIdRaw, 10);
	if (Number.isNaN(chainId) || chainId <= 0)
		return error(res, 400, 'validation_error', 'chainId must be a positive integer');
	if (!DELEGATION_MANAGER_DEPLOYMENTS[chainId])
		return error(res, 400, 'validation_error', `chainId ${chainId} is not supported`);

	const checkedAt = new Date().toISOString();

	const [row] = await sql`
		SELECT status, expires_at
		FROM agent_delegations
		WHERE delegation_hash = ${hash} AND chain_id = ${chainId}
		LIMIT 1
	`;

	if (row?.status === 'revoked') {
		return verifyRespond(
			res,
			{ ok: true, valid: false, reason: 'delegation_revoked', checkedAt, chainId, hash },
			CACHE_INVALID,
		);
	}

	if (row?.status === 'expired' || (row?.expires_at && new Date(row.expires_at) <= new Date())) {
		return verifyRespond(
			res,
			{ ok: true, valid: false, reason: 'delegation_expired', checkedAt, chainId, hash },
			CACHE_INVALID,
		);
	}

	// On-chain check — 5 s timeout
	let disabled;
	try {
		disabled = await verifyWithTimeout(verifyCheckDisabled(hash, chainId), 5000);
	} catch (err) {
		console.error('[verify] rpc error', err);
		res.statusCode = 502;
		res.setHeader('content-type', 'application/json; charset=utf-8');
		res.setHeader('cache-control', 'no-store');
		res.end(JSON.stringify({ ok: false, error: 'rpc_error', message: err.message }));
		return;
	}

	if (disabled) {
		// Self-heal: if DB still tracks it as active, flip to revoked without blocking the response.
		if (row?.status === 'active') {
			queueMicrotask(() => {
				sql`
					UPDATE agent_delegations
					SET status = 'revoked', revoked_at = NOW()
					WHERE delegation_hash = ${hash} AND status = 'active'
				`.catch((e) => console.error('[verify] self-heal failed', e));
			});
		}
		return verifyRespond(
			res,
			{ ok: true, valid: false, reason: 'delegation_revoked', checkedAt, chainId, hash },
			CACHE_INVALID,
		);
	}

	const body = { ok: true, valid: true, checkedAt, chainId, hash };
	if (!row) body.reason = 'unknown_to_platform';
	return verifyRespond(res, body, CACHE_VALID);
}

async function verifyCheckDisabled(hash, chainId) {
	const rpcUrl = process.env[`RPC_URL_${chainId}`];
	if (!rpcUrl) throw new Error(`no RPC configured for chainId ${chainId}`);
	const provider = new JsonRpcProvider(rpcUrl);
	const manager = new Contract(
		DELEGATION_MANAGER_DEPLOYMENTS[chainId],
		DELEGATION_MANAGER_ABI,
		provider,
	);
	return manager.isDelegationDisabled(hash);
}

function verifyWithTimeout(promise, ms) {
	return Promise.race([
		promise,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error(`RPC timeout after ${ms}ms`)), ms),
		),
	]);
}

function verifyRespond(res, body, cacheControl) {
	const str = JSON.stringify(body);
	const etag = `"${createHash('sha256').update(str).digest('hex').slice(0, 16)}"`;
	res.statusCode = 200;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('cache-control', cacheControl);
	res.setHeader('etag', etag);
	res.end(str);
}
