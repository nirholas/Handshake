/**
 * ERC-8004 API dispatcher
 * -----------------------
 * GET  /api/erc8004/hydrate
 * POST /api/erc8004/import
 * POST /api/erc8004/pin
 *
 * Routed via vercel.json — see top of file path patterns.
 */

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';

import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, readBody, rateLimited } from '../_lib/http.js';
import { parse } from '../_lib/validate.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import {
	resolveOnChainAgent,
	resolveLatestValidation,
	invalidateValidationCache,
	SERVER_CHAIN_META,
} from '../_lib/onchain.js';
import { r2, publicUrl } from '../_lib/r2.js';
import { env } from '../_lib/env.js';
import { attestValidation, AttestError } from '../_lib/validation-attest.js';

export default wrap(async (req, res) => {
	const action = req.query?.action;

	switch (action) {
		case 'hydrate':
			return handleHydrate(req, res);
		case 'import':
			return handleImport(req, res);
		case 'pin':
			return handlePin(req, res);
		case 'validate':
			return handleValidate(req, res);
		case 'validation':
			return handleValidationRead(req, res);
		default:
			return error(res, 404, 'not_found', 'unknown erc8004 action');
	}
});

// ── hydrate ────────────────────────────────────────────────────────────────

async function handleHydrate(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');

	const ip = clientIp(req);
	const rl = await limits.authedReadIp(ip);
	if (!rl.success) return rateLimited(res, rl);

	// Get user's linked wallets.
	const wallets = await sql`
		SELECT address FROM user_wallets
		WHERE user_id = ${session.id}
	`;

	if (wallets.length === 0) {
		return json(res, 200, { agents: [] });
	}

	const walletAddresses = wallets.map((w) => w.address.toLowerCase());

	// Query erc8004_agents_index for agents owned by these wallets.
	const indexRows = await sql`
		SELECT chain_id, agent_id, owner, name, description, image, glb_url
		FROM erc8004_agents_index
		WHERE lower(owner) = ANY(${walletAddresses})
		AND active = true
		ORDER BY registered_at DESC NULLS LAST
	`;

	// For each index row, check if already imported by this user.
	const agents = [];
	for (const row of indexRows) {
		const [imported] = await sql`
			SELECT id FROM agent_identities
			WHERE user_id = ${session.id}
			  AND erc8004_agent_id = ${BigInt(row.agent_id)}
			  AND chain_id = ${row.chain_id}
			  AND deleted_at IS NULL
		`;

		agents.push({
			chainId: row.chain_id,
			agentId: row.agent_id,
			name: row.name || `Agent #${row.agent_id}`,
			description: row.description || '',
			image: row.image || null,
			glbUrl: row.glb_url || null,
			owner: row.owner,
			alreadyImported: !!imported,
		});
	}

	return json(res, 200, { agents });
}

// ── import ─────────────────────────────────────────────────────────────────

// agentId is a uint256 on-chain but we cap the decimal string length to 78
// (max digits for uint256) and require digits only so BigInt() can't throw.
const agentIdSchema = z
	.union([z.string(), z.number()])
	.transform((v) => (typeof v === 'number' ? String(v) : v.trim()))
	.refine((v) => /^\d{1,78}$/.test(v), { message: 'agentId must be a non-negative integer' });

const importBodySchema = z.object({
	chainId: z.number().int().positive().max(2_147_483_647),
	agentId: agentIdSchema,
});

async function handleImport(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');

	const ip = clientIp(req);
	const rl = await limits.authIp(ip);
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(importBodySchema, await readJson(req));
	const chainMeta = SERVER_CHAIN_META[body.chainId];
	if (!chainMeta) {
		return error(res, 400, 'bad_request', `unsupported chain ${body.chainId}`);
	}

	const agentId = body.agentId;

	// Check if already imported by this user.
	const [existing] = await sql`
		SELECT id FROM agent_identities
		WHERE user_id = ${session.id}
		  AND erc8004_agent_id = ${BigInt(agentId)}
		  AND chain_id = ${body.chainId}
		  AND deleted_at IS NULL
	`;

	if (existing) {
		return error(res, 409, 'conflict', 'agent already imported for this user');
	}

	// Look up the index row.
	const [indexRow] = await sql`
		SELECT owner, agent_uri FROM erc8004_agents_index
		WHERE chain_id = ${body.chainId} AND agent_id = ${agentId}
	`;

	if (!indexRow) {
		return error(res, 404, 'not_found', 'agent not found in index');
	}

	// Verify owner matches one of user's wallets.
	const wallets = await sql`
		SELECT address FROM user_wallets WHERE user_id = ${session.id}
	`;

	const userWallets = wallets.map((w) => w.address.toLowerCase());
	if (!userWallets.includes(indexRow.owner.toLowerCase())) {
		return error(res, 403, 'forbidden', 'you do not own this agent');
	}

	// Resolve on-chain agent metadata.
	let resolved;
	try {
		resolved = await resolveOnChainAgent({
			chainId: body.chainId,
			agentId,
			fetchManifest: true,
			timeoutMs: 5000,
		});
	} catch (err) {
		return error(res, 500, 'internal', `failed to resolve agent: ${err.message}`);
	}

	if (resolved.error) {
		return error(res, 400, 'bad_request', `failed to resolve agent: ${resolved.error}`);
	}

	const name = (resolved.name || `Agent #${agentId}`).slice(0, 255);
	const description = (resolved.description || '').slice(0, 1000);

	// Insert agent_identities row.
	const [inserted] = await sql`
		INSERT INTO agent_identities (
			user_id, name, description, avatar_id,
			chain_id, erc8004_agent_id, erc8004_registry, registration_cid
		)
		VALUES (
			${session.id},
			${name},
			${description},
			null,
			${body.chainId},
			${BigInt(agentId)},
			${chainMeta.registry},
			null
		)
		RETURNING id
	`;

	return json(res, 201, {
		agent: {
			id: inserted.id,
			erc8004_agent_id: agentId,
			erc8004_agent_id_chain_id: body.chainId,
			name,
			avatar_url: resolved.image,
		},
	});
}

// ── validate (POST) ──────────────────────────────────────────────────────────
// Run an agent's GLB through the platform glTF validator and record a signed
// attestation on the ValidationRegistry. Re-runnable: each call records a fresh
// attestation, so the badge reflects the latest GLB. Best-effort — config /
// allow-list / undeployed-registry problems return a clear ops error and never
// affect the agent's registration.

const validateBodySchema = z.object({
	chainId: z.number().int().positive().max(2_147_483_647),
	agentId: agentIdSchema,
	// Optional — when omitted we resolve the GLB from the index / on-chain manifest.
	glbUrl: z.string().url().max(2048).optional(),
});

// AttestError.code → HTTP status. Config/precondition problems are 503 (the
// platform must be wired), model/transport problems are 422/502.
const ATTEST_STATUS = {
	validator_key_not_configured: 503,
	validation_registry_not_deployed: 503,
	validator_not_allowlisted: 503,
	no_rpc: 503,
	unsupported_chain: 400,
	invalid_glb_url: 422,
	glb_fetch_failed: 502,
	glb_too_large: 413,
	registry_read_failed: 502,
	record_failed: 502,
};

async function handleValidate(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	if (bearer && !hasScope(bearer.scope, 'avatars:write'))
		return error(res, 403, 'insufficient_scope', 'avatars:write scope required');

	const rl = await limits.registerIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(validateBodySchema, await readJson(req));
	const chainMeta = SERVER_CHAIN_META[body.chainId];
	if (!chainMeta) return error(res, 400, 'bad_request', `unsupported chain ${body.chainId}`);

	// Resolve the GLB to validate: explicit > index row > on-chain manifest body.
	let glbUrl = body.glbUrl || null;
	if (!glbUrl) {
		const [row] = await sql`
			SELECT glb_url FROM erc8004_agents_index
			WHERE chain_id = ${body.chainId} AND agent_id = ${body.agentId}
		`;
		glbUrl = row?.glb_url || null;
	}
	if (!glbUrl) {
		const resolved = await resolveOnChainAgent({
			chainId: body.chainId,
			agentId: body.agentId,
			fetchManifest: true,
			timeoutMs: 5000,
		}).catch(() => null);
		glbUrl = resolved?.bodyURI || null;
	}
	if (!glbUrl) {
		return error(res, 422, 'no_glb', 'no GLB found for this agent to validate');
	}

	const validatedAt = new Date().toISOString();
	let result;
	try {
		result = await attestValidation({
			chainId: body.chainId,
			agentId: body.agentId,
			glbUrl,
			validatedAt,
		});
	} catch (err) {
		const code = err instanceof AttestError ? err.code : 'attest_failed';
		const status = ATTEST_STATUS[code] || 500;
		// Record the ops error for visibility — best-effort, never blocks.
		await sql`
			UPDATE erc8004_agents_index
			SET validation_error = ${code}, validation_at = now()
			WHERE chain_id = ${body.chainId} AND agent_id = ${body.agentId}
		`.catch(() => {});
		return error(res, status, code, err.message);
	}

	// Persist the latest attestation to the index cache (best-effort) and bust the
	// on-chain read cache so the badge reflects this attestation immediately.
	await sql`
		UPDATE erc8004_agents_index
		SET validation_passed = ${result.passed},
		    validation_kind = ${result.kind},
		    validation_proof_hash = ${result.proofHash},
		    validation_proof_uri = ${result.proofURI},
		    validation_tx = ${result.txHash},
		    validator_address = ${result.validator.toLowerCase()},
		    validation_at = ${validatedAt},
		    validation_error = null
		WHERE chain_id = ${body.chainId} AND agent_id = ${body.agentId}
	`.catch(() => {});
	await invalidateValidationCache({ chainId: body.chainId, agentId: body.agentId }).catch(() => {});

	const explorerTx = `${chainMeta.explorer}/tx/${result.txHash}`;
	return json(res, 200, {
		ok: true,
		validation: {
			chainId: body.chainId,
			agentId: body.agentId,
			passed: result.passed,
			kind: result.kind,
			proofHash: result.proofHash,
			proofURI: result.proofURI,
			txHash: result.txHash,
			txExplorer: explorerTx,
			validator: result.validator,
			validatedAt,
			byteCheckSha256: result.sha256,
			issues: result.report.issues,
		},
	});
}

// ── validation (GET) ─────────────────────────────────────────────────────────
// Walletless read of the latest on-chain attestation — powers the "Validated"
// badge on any surface without a wallet or RPC in the browser.

async function handleValidationRead(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.pumpMetaIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const chainId = Number(req.query?.chainId);
	const agentId = String(req.query?.agentId ?? '').trim();
	if (!Number.isInteger(chainId) || chainId <= 0) {
		return error(res, 400, 'bad_request', 'chainId is required');
	}
	if (!/^\d{1,78}$/.test(agentId)) {
		return error(res, 400, 'bad_request', 'agentId must be a non-negative integer');
	}

	const validation = await resolveLatestValidation({ chainId, agentId });
	res.setHeader('cache-control', 'public, max-age=30, s-maxage=60');
	return json(res, 200, { validation });
}

// ── pin ────────────────────────────────────────────────────────────────────

const ALLOWED = new Set([
	'model/gltf-binary',
	'model/gltf+json',
	'application/json',
	'application/octet-stream',
	'image/png',
	'image/jpeg',
	'image/webp',
]);

const MAX_SIZE = 25 * 1024 * 1024; // 25 MB

async function handlePin(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', 'POST only');

	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');

	const ip = clientIp(req);
	const rl = await limits.authIp(ip);
	if (!rl.success) return rateLimited(res, rl, 'too many uploads');

	const ct = (req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
	if (!ALLOWED.has(ct))
		return error(res, 415, 'unsupported_media_type', 'unsupported content-type');

	const body = await readRaw(req, MAX_SIZE);

	// Determine extension from content-type
	const ext = getExt(ct);

	// Try IPFS first (web3.storage or nft.storage)
	const web3Token = process.env.WEB3_STORAGE_TOKEN;
	const nftToken = process.env.NFT_STORAGE_TOKEN;

	if (web3Token) {
		const result = await uploadToWeb3Storage(web3Token, ext, body, ct);
		return json(res, 200, result);
	}

	if (nftToken) {
		const result = await uploadToNftStorage(nftToken, ext, body, ct);
		return json(res, 200, result);
	}

	// Fallback to R2 with warning
	const key = `erc8004/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
	await r2.send(
		new PutObjectCommand({
			Bucket: env.S3_BUCKET,
			Key: key,
			Body: body,
			ContentType: ct,
		}),
	);

	const url = publicUrl(key);
	return json(res, 200, {
		cid: null,
		uri: url,
		url,
		warning: 'R2-only pin — not decentralized',
	});
}

function getExt(ct) {
	switch (ct) {
		case 'application/json':
			return 'json';
		case 'model/gltf-binary':
			return 'glb';
		case 'image/png':
			return 'png';
		case 'image/jpeg':
			return 'jpg';
		case 'image/webp':
			return 'webp';
		default:
			return 'bin';
	}
}

async function uploadToWeb3Storage(token, ext, body, ct) {
	const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
	const formData = new FormData();
	const blob = new Blob([body], { type: ct });
	formData.append('file', blob, filename);

	const response = await fetch('https://api.web3.storage/upload', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
		},
		body: formData,
	});

	if (!response.ok) {
		throw new Error(`web3.storage upload failed: ${response.status} ${response.statusText}`);
	}

	const data = await response.json();
	const cid = data.cid;

	// web3.storage and nft.storage guarantee content-addressable uploads:
	// same bytes → same CID every time, idempotent by design.
	const uri = `ipfs://${cid}/${filename}`;
	const url = `https://w3s.link/ipfs/${cid}/${filename}`;

	return { cid, uri, url };
}

async function uploadToNftStorage(token, ext, body, ct) {
	const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
	const formData = new FormData();
	const blob = new Blob([body], { type: ct });
	formData.append('file', blob, filename);

	const response = await fetch('https://api.nft.storage/upload', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
		},
		body: formData,
	});

	if (!response.ok) {
		throw new Error(`nft.storage upload failed: ${response.status} ${response.statusText}`);
	}

	const data = await response.json();
	const cid = data.value.cid;

	// nft.storage guarantees content-addressable uploads: same bytes → same CID.
	const uri = `ipfs://${cid}/${filename}`;
	const url = `https://w3s.link/ipfs/${cid}/${filename}`;

	return { cid, uri, url };
}

// Delegates to the shared readBody (api/_lib/http.js). For the binary/model
// content-types this endpoint accepts, the Cloud Run server's Express body
// parsers never touch the stream, so this behaves exactly as the old
// raw-stream reader did; for the json/octet-stream types they DO pre-parse,
// re-reading the raw stream directly (the old implementation) hangs forever.
function readRaw(req, limit) {
	return readBody(req, limit);
}
