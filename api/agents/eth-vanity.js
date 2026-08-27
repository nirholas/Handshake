// /api/agents/:id/eth-vanity — assign / read / delete a CREATE2 vanity record.
// /api/agents/:id/eth-vanity/deployed — record an on-chain deployment.
//
// Stores the salt + factory + initCode(Hash) the owner ground in the
// browser at /eth-vanity. No secret material — the predicted address
// is a deterministic function of (deployer, salt, initCodeHash).
//
// Server invariants enforced on POST:
//  • predicted_address == keccak256(0xff‖deployer‖salt‖init_code_hash)[12:]
//  • if init_code is provided, keccak256(init_code) == init_code_hash
//
// Server invariants enforced on POST /deployed:
//  • the chain RPC must return non-empty bytecode at predicted_address.
//    No trust in the client's claim — we verify.
//
// Persisted under agent_identities.meta.eth_vanity:
//   {
//     deployer:           "0x…20 bytes…",
//     init_code_hash:     "0x…32 bytes…",
//     init_code:          "0x…" | null,
//     salt:               "0x…32 bytes…",
//     predicted_address:  "0x…20 bytes…",
//     prefix:             "beef" | "Beef" | null,
//     suffix:             "cafe" | null,
//     deployer_label:     "CreateX" | null,
//     case_sensitive:     boolean,
//     created_at:         ISO,
//     deployments:        [{ chain_id, tx_hash, at, verified: bool }]
//   }

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { requireCsrf } from '../_lib/csrf.js';
import { sql } from '../_lib/db.js';
import { cors, json, method, error, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { fetchAnyJson } from '../_lib/upstream-fetch.js';
import { evmRpcEndpoints } from '../_lib/evm/rpc.js';
import { CHAIN_BY_ID } from '../_lib/erc8004-chains.js';

const HEX_RE  = /^0x[0-9a-f]+$/i;
const ADDR_RE = /^0x[0-9a-f]{40}$/i;
const HASH_RE = /^0x[0-9a-f]{64}$/i;
const TX_RE   = /^0x[0-9a-f]{64}$/i;

// The chains a deployment can be verified on are exactly the chains the shared
// EVM RPC layer knows (erc8004-chains.js): operator override, keyed Alchemy,
// then the chain's curated public nodes, tried in that order. A chain outside
// that table records the deploy *unverified* with a warning flag.
const SUPPORTED_CHAIN_IDS = Object.keys(CHAIN_BY_ID).map(Number);

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

function _hexToBytes(hex) {
	const h = hex.startsWith('0x') ? hex.slice(2) : hex;
	const out = new Uint8Array(h.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16);
	return out;
}
function _bytesToHex(b) {
	let s = ''; for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
	return s;
}

function _verifyCreate2(deployer, salt, initCodeHash, predicted) {
	const buf = new Uint8Array(85);
	buf[0] = 0xff;
	buf.set(_hexToBytes(deployer), 1);
	buf.set(_hexToBytes(salt), 21);
	buf.set(_hexToBytes(initCodeHash), 53);
	const digest = keccak_256(buf);
	const derived = '0x' + _bytesToHex(digest.subarray(12));
	return derived.toLowerCase() === predicted.toLowerCase();
}

/**
 * Verify on-chain that bytecode exists at `address` on `chainId`. Uses
 * eth_getCode across the chain's priority-ordered RPC endpoints, each on its
 * own deadline. Returns:
 *   { ok: true,  bytecodeHash }   → contract is deployed
 *   { ok: false, reason }         → not deployed / RPC unreachable / wrong chain
 *
 * We don't hard-fail when the chain isn't in the shared table; the caller
 * can choose to record the deployment as unverified.
 */
async function _verifyDeployed(chainId, address) {
	const endpoints = evmRpcEndpoints(Number(chainId));
	if (!CHAIN_BY_ID[Number(chainId)] || !endpoints.length) {
		return { ok: false, reason: 'unsupported_chain', supported: SUPPORTED_CHAIN_IDS };
	}
	try {
		// Operator override, keyed Alchemy, then the chain's public nodes in turn,
		// so one node rate-limiting us never records a real deployment as unverified.
		const { value: data } = await fetchAnyJson(endpoints, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
		}, { name: `evm-getcode:${chainId}`, timeoutMs: 6_000, label: 'eth_getCode' });
		if (data.error) return { ok: false, reason: data.error.message || 'rpc_error' };
		const code = String(data.result || '0x');
		if (code === '0x' || code === '0x0') return { ok: false, reason: 'no_code_at_address' };
		// Use the keccak hash of the runtime bytecode as a stable identifier
		// so we can detect cross-chain divergence later.
		try {
			const bytes = _hexToBytes(code);
			return { ok: true, bytecodeHash: '0x' + _bytesToHex(keccak_256(bytes)) };
		} catch {
			return { ok: true, bytecodeHash: null };
		}
	} catch (e) {
		return { ok: false, reason: e?.message || 'rpc_unreachable' };
	}
}

export default async function handler(req, res, id, action) {
	if (cors(req, res, { methods: 'GET,POST,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST', 'DELETE'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = req.method === 'GET'
		? await limits.walletRead(auth.userId)
		: await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const [row] = await sql`SELECT id, user_id, meta FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	if (!row) return error(res, 404, 'not_found', 'agent not found');
	if (row.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	let meta = { ...(row.meta || {}) };

	if (req.method !== 'GET') {
		if (!(await requireCsrf(req, res, auth.userId))) return;
	}

	if (req.method === 'DELETE') {
		delete meta.eth_vanity;
		await sql`UPDATE agent_identities SET meta = ${JSON.stringify(meta)}::jsonb WHERE id = ${id}`;
		return json(res, 200, { data: { ok: true } });
	}

	if (req.method === 'POST') {
		const body = await readJson(req).catch(() => ({}));

		// ── Sub-action: record an on-chain deployment ───────────────────────
		if (action === 'deployed' || body.mark_deployed) {
			if (!meta.eth_vanity) return error(res, 404, 'not_found', 'no vanity record to mark deployed');
			const chainId = Number(body.chain_id);
			const txHash = String(body.tx_hash || '');
			if (!Number.isInteger(chainId) || chainId <= 0) return error(res, 400, 'validation_error', 'chain_id must be a positive integer');
			if (!TX_RE.test(txHash)) return error(res, 400, 'validation_error', 'tx_hash must be 0x + 64 hex');

			// Verify bytecode is actually present at the predicted address on
			// the claimed chain. Defends against malicious clients faking
			// deploys to spoof badge / passport state.
			const v = await _verifyDeployed(chainId, meta.eth_vanity.predicted_address);
			const verified = v.ok;
			const reason   = v.ok ? null : v.reason;

			const existing = Array.isArray(meta.eth_vanity.deployments) ? meta.eth_vanity.deployments : [];
			// Replace any prior unverified record for the same chain rather than duplicating.
			const others = existing.filter((d) => d.chain_id !== chainId);
			const entry = {
				chain_id:      chainId,
				tx_hash:       txHash.toLowerCase(),
				at:            new Date().toISOString(),
				verified,
				bytecode_hash: v.bytecodeHash || null,
				...(reason ? { unverified_reason: reason } : {}),
			};
			meta.eth_vanity = {
				...meta.eth_vanity,
				deployments: [...others, entry].sort((a, b) => a.chain_id - b.chain_id),
				// Back-compat: keep the legacy single-deploy field set to the latest verified.
				deployed: verified ? entry : meta.eth_vanity.deployed || null,
			};
			await sql`UPDATE agent_identities SET meta = ${JSON.stringify(meta)}::jsonb WHERE id = ${id}`;
			return json(res, verified ? 200 : 202, {
				data: { record: meta.eth_vanity, verified, reason },
			});
		}

		// ── Save / replace ─────────────────────────────────────────────────
		const deployer = String(body.deployer || '').toLowerCase();
		const salt     = String(body.salt || '').toLowerCase();
		const ich      = String(body.init_code_hash || body.initCodeHash || '').toLowerCase();
		const pred     = String(body.predicted_address || body.address || '').toLowerCase();
		const initCode = body.init_code || body.initCode || null;
		const prefixIn = body.prefix ? String(body.prefix) : null;
		const suffixIn = body.suffix ? String(body.suffix) : null;
		const label    = body.deployer_label ? String(body.deployer_label).slice(0, 64) : null;
		const caseSensitive = !!body.case_sensitive;

		if (!ADDR_RE.test(deployer)) return error(res, 400, 'validation_error', 'deployer must be 0x + 40 hex');
		if (!HASH_RE.test(salt))     return error(res, 400, 'validation_error', 'salt must be 0x + 64 hex');
		if (!HASH_RE.test(ich))      return error(res, 400, 'validation_error', 'init_code_hash must be 0x + 64 hex');
		if (!ADDR_RE.test(pred))     return error(res, 400, 'validation_error', 'predicted_address must be 0x + 40 hex');
		if (initCode != null && (typeof initCode !== 'string' || !HEX_RE.test(initCode))) {
			return error(res, 400, 'validation_error', 'init_code must be a 0x-prefixed hex string');
		}
		// Patterns: allow either case (case-sensitive grinding preserves casing).
		const prefix = prefixIn ? prefixIn.replace(/^0x/i, '') : null;
		const suffix = suffixIn ? suffixIn.replace(/^0x/i, '') : null;
		if (prefix && !/^[0-9a-fA-F]+$/.test(prefix)) return error(res, 400, 'validation_error', 'prefix must be hex');
		if (suffix && !/^[0-9a-fA-F]+$/.test(suffix)) return error(res, 400, 'validation_error', 'suffix must be hex');

		if (!_verifyCreate2(deployer, salt, ich, pred)) {
			return error(res, 400, 'validation_error', 'predicted_address does not match keccak256(0xff‖deployer‖salt‖init_code_hash)');
		}

		if (initCode) {
			const computed = '0x' + _bytesToHex(keccak_256(_hexToBytes(initCode)));
			if (computed.toLowerCase() !== ich) {
				return error(res, 400, 'validation_error', 'init_code does not hash to init_code_hash');
			}
		}

		if (meta.eth_vanity) {
			return error(res, 409, 'conflict', 'agent already has an eth vanity record. DELETE /api/agents/:id/eth-vanity first to replace');
		}

		meta.eth_vanity = {
			deployer,
			init_code_hash: ich,
			init_code: initCode || null,
			salt,
			predicted_address: pred,
			prefix,
			suffix,
			deployer_label: label,
			case_sensitive: caseSensitive,
			created_at: new Date().toISOString(),
			deployments: [],
			deployed: null, // legacy
		};
		await sql`UPDATE agent_identities SET meta = ${JSON.stringify(meta)}::jsonb WHERE id = ${id}`;
		return json(res, 201, { data: meta.eth_vanity });
	}

	// ── GET ─────────────────────────────────────────────────────────────────
	// Return 200 + null for the "no record yet" state. 404 is reserved for
	// missing parent resources (agent not found). Mirrors the SNS endpoint.
	return json(res, 200, { data: meta.eth_vanity || null });
}

// Re-exported so the test suite can hit the verifier directly without
// spinning up the full Vercel handler shape.
export const __test__ = { _verifyCreate2, _verifyDeployed };
