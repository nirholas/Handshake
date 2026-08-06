/**
 * ERC-8004 ValidationRegistry attestor (server-side).
 *
 * Turns an agent's GLB into a signed, on-chain validation attestation:
 *
 *   1. Fetch the GLB (SSRF-guarded) and run it through the platform's one glTF
 *      validator — the same inspector behind /api/x402/model-check. Parse-success
 *      ⇒ structurally valid; parse-failure ⇒ a hard error in the report.
 *   2. Independently sha256 the exact bytes (byte-check, surfaced separately —
 *      a passing schema validation never overrides byte identity, per spec).
 *   3. Build the canonical report and pin it to R2. `hashReport()` keccaks the
 *      report's compact JSON, so a verifier fetches the pinned file, re-stringifies
 *      it without indentation, re-hashes, and compares against the chain.
 *   4. Answer the agent's on-chain validation request from the platform validator
 *      key with validationResponse(requestHash, score, proofURI, proofHash, kind),
 *      opening the request first when the platform is allowed to.
 *
 * Best-effort by contract: callers wrap this in try/catch — a validation failure
 * (or missing key / undeployed registry / no open request) must never block or
 * revert the registration itself. Errors carry a machine-readable `.code` so the
 * caller can surface a clear ops state instead of a silent skip.
 */

import { createHash } from 'node:crypto';
import { Contract, Wallet } from 'ethers';

import { env } from './env.js';
import { CHAIN_BY_ID, VALIDATION_REGISTRY_ABI, validationRegistryFor } from './erc8004-chains.js';
import { evmRpcEndpoints } from './evm/rpc.js';
import { putObject, publicUrl } from './r2.js';
import { assertSafePublicUrl, SsrfBlockedError } from './ssrf-guard.js';
import { inspectModel, suggestOptimizations } from './model-inspect.js';
import {
	buildGlbReport,
	hashReport,
	reportPassed,
	responseForPassed,
	validationRequestHash,
	KIND_GLB_SCHEMA,
} from '../../src/erc8004/validation-report.js';

// Just the ERC-721 authority reads the registry itself checks before accepting a
// validationRequest: enough to tell "we can open this request" from "the owner
// has to".
const IDENTITY_AUTH_ABI = [
	'function ownerOf(uint256 tokenId) external view returns (address)',
	'function getApproved(uint256 tokenId) external view returns (address)',
	'function isApprovedForAll(address owner, address operator) external view returns (bool)',
];

const MAX_FETCH_BYTES = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

class AttestError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'AttestError';
		this.code = code;
	}
}

/**
 * Fetch + validate a GLB. Never throws on an *invalid model* — an unparseable
 * GLB is a valid outcome (a failing report). Only throws on transport/SSRF
 * problems the caller can't attribute to the model.
 *
 * @param {string} glbUrl
 * @param {string} validatedAt  ISO timestamp (caller-supplied).
 * @returns {Promise<{ report: object, passed: boolean, sha256: string, byteLength: number }>}
 */
export async function validateGlb(glbUrl, validatedAt) {
	let parsed;
	try {
		parsed = await assertSafePublicUrl(glbUrl, { allowHttp: true });
	} catch (err) {
		if (err instanceof SsrfBlockedError) throw new AttestError('invalid_glb_url', err.message);
		throw err;
	}

	let upstream;
	try {
		upstream = await fetch(parsed.toString(), {
			redirect: 'follow',
			headers: { accept: 'model/gltf-binary,model/gltf+json,application/octet-stream' },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch (err) {
		throw new AttestError('glb_fetch_failed', `could not fetch GLB: ${err.message}`);
	}
	if (!upstream.ok) {
		throw new AttestError('glb_fetch_failed', `GLB fetch returned ${upstream.status}`);
	}

	const contentLength = Number(upstream.headers.get('content-length') || 0);
	if (contentLength && contentLength > MAX_FETCH_BYTES) {
		throw new AttestError('glb_too_large', `GLB is ${contentLength} bytes; max ${MAX_FETCH_BYTES}`);
	}
	const bytes = new Uint8Array(await upstream.arrayBuffer());
	if (bytes.byteLength > MAX_FETCH_BYTES) {
		throw new AttestError('glb_too_large', `GLB is ${bytes.byteLength} bytes; max ${MAX_FETCH_BYTES}`);
	}

	const sha256 = createHash('sha256').update(bytes).digest('hex');

	let inspect = null;
	let suggestions = [];
	let error = null;
	try {
		inspect = await inspectModel(bytes, { fileSize: bytes.byteLength });
		suggestions = suggestOptimizations(inspect);
	} catch (err) {
		// Unparseable model → a failing report, not a thrown attestation.
		error = err?.message || 'model failed to parse';
	}

	const report = buildGlbReport({
		url: parsed.toString(),
		sha256,
		byteLength: bytes.byteLength,
		inspect,
		suggestions,
		error,
		validatedAt,
	});

	return { report, passed: reportPassed(report), sha256, byteLength: bytes.byteLength };
}

/**
 * Pin the report JSON to R2 and return its public URL.
 * @param {object} report
 * @param {number} chainId
 * @param {string|number} agentId
 * @returns {Promise<string>}
 */
async function pinReport(report, chainId, agentId) {
	const body = Buffer.from(JSON.stringify(report, null, 2));
	const key = `erc8004/validation/${chainId}/${agentId}/${report.byteCheck?.sha256 || 'report'}.json`;
	await putObject({ key, body, contentType: 'application/json' });
	return publicUrl(key);
}

/** Read a request's on-chain status. Returns null when no such request exists. */
async function readRequest(registry, requestHash) {
	try {
		const s = await registry.getValidationStatus(requestHash);
		return {
			validator: s[0],
			agentId: s[1],
			response: Number(s[2]),
			responseHash: s[3],
			tag: s[4],
			lastUpdate: Number(s[5]),
		};
	} catch (err) {
		// The registry reverts require("unknown") for a hash it has never seen.
		if (err?.code === 'CALL_EXCEPTION' || /unknown/i.test(String(err?.shortMessage || err?.message))) {
			return null;
		}
		throw new AttestError('registry_read_failed', `could not read validation status: ${err.message}`);
	}
}

/**
 * Can `validator` open a validation request for this agent? The registry allows
 * the agent's ERC-721 owner, a per-token approved operator, or an operator
 * approved for all of the owner's tokens.
 */
async function canOpenRequest({ identityAddr, provider, agentId, validator }) {
	if (!identityAddr) return false;
	const identity = new Contract(identityAddr, IDENTITY_AUTH_ABI, provider);
	const id = BigInt(agentId);
	let owner;
	try {
		owner = await identity.ownerOf(id);
	} catch {
		return false;
	}
	if (owner.toLowerCase() === validator.toLowerCase()) return true;
	const [approved, forAll] = await Promise.all([
		identity.getApproved(id).catch(() => null),
		identity.isApprovedForAll(owner, validator).catch(() => false),
	]);
	return Boolean(forAll) || (approved && approved.toLowerCase() === validator.toLowerCase());
}

/**
 * Full attestation: validate the GLB, pin the report, answer on-chain.
 *
 * The deployed ValidationRegistry is two-legged: the agent's owner (or an
 * approved operator) opens a request naming a validator, and only that validator
 * may answer it. So this runs one of three ways:
 *
 *   - a request for our validator already exists  → answer it (this is also the
 *     re-validation path: answering again updates the record in place);
 *   - no request, but the platform validator is the owner/an approved operator
 *     → open the request itself, then answer it;
 *   - no request and no authority → throw `validation_request_required` carrying
 *     the exact call the owner's wallet must submit, so the UI can prompt for it.
 *
 * Best-effort by contract: callers wrap this in try/catch and registration is
 * never blocked by the outcome.
 *
 * @param {object} p
 * @param {number} p.chainId
 * @param {string|number} p.agentId
 * @param {string} p.glbUrl
 * @param {string} p.validatedAt  ISO timestamp (caller-supplied; deterministic hashing).
 * @param {string} [p.requestHash] Answer this exact request (the owner just opened it).
 * @returns {Promise<{
 *   passed: boolean, proofHash: string, proofURI: string, txHash: string,
 *   requestHash: string, requestTxHash: string|null, score: number,
 *   sha256: string, validatedAt: string, kind: string, chainId: number,
 *   agentId: string, validator: string, report: object,
 * }>}
 */
export async function attestValidation({ chainId, agentId, glbUrl, validatedAt, requestHash: pinnedHash }) {
	const chain = CHAIN_BY_ID[chainId];
	if (!chain) throw new AttestError('unsupported_chain', `unsupported chain ${chainId}`);

	const registryAddr = validationRegistryFor(chainId);
	if (!registryAddr) {
		throw new AttestError(
			'validation_registry_not_deployed',
			`ValidationRegistry is not deployed on ${chain.name} (chain ${chainId}).`,
		);
	}

	const pk = env.VALIDATOR_PRIVATE_KEY;
	if (!pk) {
		throw new AttestError(
			'validator_key_not_configured',
			'VALIDATOR_PRIVATE_KEY is not set, so no attestation can be signed.',
		);
	}

	// 1. Validate the GLB (this part never throws on an invalid model).
	const { report, passed, sha256 } = await validateGlb(glbUrl, validatedAt);

	// 2. Provider + wallet. evmFallbackProvider is read-tuned; for the write we
	//    use a plain JsonRpcProvider on the priority endpoint list.
	const { JsonRpcProvider, Network } = await import('ethers');
	const network = Network.from(chainId);
	const endpoints = evmRpcEndpoints(chainId);
	const provider = new JsonRpcProvider(endpoints[0], network, { staticNetwork: network });
	const wallet = new Wallet(pk, provider);
	const registry = new Contract(registryAddr, VALIDATION_REGISTRY_ABI, wallet);

	// 3. Find (or open) the request this attestation answers.
	const requestHash = pinnedHash || validationRequestHash({ chainId, agentId, seed: `0x${sha256}` });
	const existing = await readRequest(registry, requestHash);

	if (existing && existing.validator.toLowerCase() !== wallet.address.toLowerCase()) {
		throw new AttestError(
			'request_not_for_validator',
			`Request ${requestHash} names validator ${existing.validator}, not the platform validator ${wallet.address}.`,
		);
	}
	if (existing && String(existing.agentId) !== String(agentId)) {
		throw new AttestError(
			'request_agent_mismatch',
			`Request ${requestHash} belongs to agent ${existing.agentId}, not ${agentId}.`,
		);
	}

	let requestTxHash = null;
	if (!existing) {
		const authorized = await canOpenRequest({
			identityAddr: chain.registry,
			provider,
			agentId,
			validator: wallet.address,
		});
		if (!authorized) {
			const err = new AttestError(
				'validation_request_required',
				`Agent ${agentId} has no open validation request for ${wallet.address}. The agent owner must call ` +
					`validationRequest(${wallet.address}, ${agentId}, <glbUrl>, ${requestHash}) on ${registryAddr}, then retry.`,
			);
			err.request = {
				chainId,
				agentId: String(agentId),
				registry: registryAddr,
				validatorAddress: wallet.address,
				requestURI: glbUrl,
				requestHash,
			};
			throw err;
		}
		let reqTx;
		try {
			reqTx = await registry.validationRequest(wallet.address, BigInt(agentId), glbUrl, requestHash);
		} catch (err) {
			throw new AttestError('request_failed', `validationRequest reverted: ${err.shortMessage || err.message}`);
		}
		await reqTx.wait();
		requestTxHash = reqTx.hash;
	}

	// 4. Pin the report, then answer the request. `responseURI` is emitted but not
	//    stored by the registry, so the pinned URL is recovered from the event (or
	//    our index cache); `responseHash` is the integrity check that binds them.
	const proofURI = await pinReport(report, chainId, agentId);
	const proofHash = hashReport(report);
	const score = responseForPassed(passed);

	let tx;
	try {
		tx = await registry.validationResponse(requestHash, score, proofURI, proofHash, KIND_GLB_SCHEMA);
	} catch (err) {
		throw new AttestError('response_failed', `validationResponse reverted: ${err.shortMessage || err.message}`);
	}
	await tx.wait();

	return {
		passed,
		score,
		proofHash,
		proofURI,
		txHash: tx.hash,
		requestHash,
		requestTxHash,
		sha256,
		validatedAt,
		kind: KIND_GLB_SCHEMA,
		chainId,
		agentId: String(agentId),
		validator: wallet.address,
		report,
	};
}

export { AttestError };
