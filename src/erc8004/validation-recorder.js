/**
 * ValidationRegistry bridge — turn a glTF-Validator report into an on-chain
 * validation record.
 *
 * Usage:
 *   import { recordValidation } from './erc8004/validation-recorder.js';
 *   await recordValidation({ agentId, report, signer, pinToIPFS, apiToken });
 */

import { Contract } from 'ethers';
import { REGISTRY_DEPLOYMENTS, VALIDATION_REGISTRY_ABI } from './abi.js';
import { pinFile } from './agent-registry.js';
import {
	KIND_GLB_SCHEMA,
	reportPassed,
	hashReport,
	responseForPassed,
	responsePassed,
	validationRequestHash,
} from './validation-report.js';

// Re-export the pure report helpers so existing importers of this module keep
// working. The canonical implementations live in validation-report.js — a
// dependency-light module the server attestor can import without pulling in the
// browser-only agent-registry/Three.js stack.
export { reportPassed, hashReport, buildGlbReport, failureReason } from './validation-report.js';

/**
 * Record a validation result on-chain. Optionally pin the full report to IPFS
 * first so verifiers can fetch the details behind the hash.
 *
 * The registry is request/response based, so this drives both legs from the one
 * connected wallet: it opens the request (which the registry only lets the agent's
 * owner or an approved operator do) naming that same wallet as the validator, then
 * answers it. When a request for this wallet already exists, only the answer is
 * sent, which is also how a re-validation updates the record in place.
 *
 * @param {object} opts
 * @param {number|bigint} opts.agentId
 * @param {object} opts.report                   glTF-Validator report
 * @param {import('ethers').Signer} opts.signer  The agent's owner or an approved operator
 * @param {number} [opts.chainId]                Defaults to signer's network
 * @param {string} [opts.apiToken]               IPFS pinning token (optional)
 * @param {boolean} [opts.pin=true]              Pin report to IPFS before recording
 * @param {string} [opts.kind='glb-schema']
 * @returns {Promise<{txHash: string, requestTxHash: string|null, requestHash: string,
 *   proofHash: string, proofURI: string, passed: boolean, score: number}>}
 */
export async function recordValidation({
	agentId,
	report,
	signer,
	chainId,
	apiToken,
	pin = true,
	kind = KIND_GLB_SCHEMA,
}) {
	if (!signer) throw new Error('signer is required');
	if (!report) throw new Error('report is required');

	const resolvedChainId = chainId ?? Number((await signer.provider.getNetwork()).chainId);
	const deployment = REGISTRY_DEPLOYMENTS[resolvedChainId];
	if (!deployment || !deployment.validationRegistry) {
		throw new Error(`No Validation Registry deployed on chain ${resolvedChainId}.`);
	}

	const proofHash = hashReport(report);
	const passed = reportPassed(report);
	const score = responseForPassed(passed);

	let proofURI = '';
	if (pin && apiToken) {
		const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
		const cid = await pinFile(blob, apiToken);
		proofURI = `ipfs://${cid}`;
	}

	const contract = new Contract(deployment.validationRegistry, VALIDATION_REGISTRY_ABI, signer);
	const validator = await signer.getAddress();
	const requestHash = validationRequestHash({ chainId: resolvedChainId, agentId, seed: proofHash, kind });

	const existing = await readValidationStatus(contract, requestHash);
	if (existing && existing.validator.toLowerCase() !== validator.toLowerCase()) {
		throw new Error(`This report is already registered to validator ${existing.validator}.`);
	}

	let requestTxHash = null;
	if (!existing) {
		const reqTx = await contract.validationRequest(validator, agentId, proofURI || `report:${proofHash}`, requestHash);
		await reqTx.wait();
		requestTxHash = reqTx.hash;
	}

	const tx = await contract.validationResponse(requestHash, score, proofURI, proofHash, kind);
	await tx.wait();

	return { txHash: tx.hash, requestTxHash, requestHash, proofHash, proofURI, passed, score };
}

/** Read one request's status, or null when the registry has never seen that id. */
async function readValidationStatus(contract, requestHash) {
	try {
		const s = await contract.getValidationStatus(requestHash);
		return {
			validator: s[0],
			agentId: s[1],
			response: Number(s[2]),
			responseHash: s[3],
			tag: s[4],
			lastUpdate: Number(s[5]),
		};
	} catch {
		return null;
	}
}

/**
 * Read an agent's validations of a given kind, newest first. Unanswered requests
 * carry an empty tag on chain and are skipped: they are pending, not verdicts.
 *
 * @param {object} opts
 * @param {number|bigint} opts.agentId
 * @param {import('ethers').Provider | import('ethers').Signer} opts.runner
 * @param {number} opts.chainId
 * @param {string} [opts.kind='glb-schema']
 * @param {number} [opts.limit=20]  How many of the most recent requests to inspect.
 * @returns {Promise<Array<{requestHash: string, validator: string, response: number,
 *   responseHash: string, tag: string, lastUpdate: number, passed: boolean}>>}
 */
export async function getValidations({ agentId, runner, chainId, kind = KIND_GLB_SCHEMA, limit = 20 }) {
	const deployment = REGISTRY_DEPLOYMENTS[chainId];
	if (!deployment || !deployment.validationRegistry) {
		throw new Error(`No Validation Registry deployed on chain ${chainId}.`);
	}
	const contract = new Contract(deployment.validationRegistry, VALIDATION_REGISTRY_ABI, runner);
	const hashes = await contract.getAgentValidations(agentId);
	const recent = Array.from(hashes || []).slice(-limit).reverse();
	const statuses = await Promise.all(recent.map((hash) => readValidationStatus(contract, hash).then((s) => (s ? { ...s, requestHash: hash } : null))));
	return statuses
		.filter((s) => s && s.tag === kind)
		.map((s) => ({ ...s, passed: responsePassed(s.response) }))
		.sort((a, b) => b.lastUpdate - a.lastUpdate);
}

/**
 * The most recent answered validation of a kind, or null when there is none.
 * @param {object} opts  Same shape as getValidations().
 */
export async function getLatestValidation(opts) {
	const all = await getValidations(opts);
	return all[0] || null;
}
