/**
 * Owner leg of an ERC-8004 validation attestation.
 *
 * The deployed ValidationRegistry only accepts a validation request from the
 * agent's ERC-721 owner (or an approved operator), and only the validator named
 * in that request may answer it. So when the platform validator is not an
 * operator on the agent, POST /api/erc8004/validate cannot attest by itself: it
 * answers with 409 `validation_request_required` plus the exact call to make.
 * This module makes that call from the owner's wallet.
 *
 * Usage (the badge does this for you):
 *   const res = await requestValidation(chainId, agentId, glbUrl);
 *   if (res.error === 'validation_request_required') {
 *     await openValidationRequest(res.request);
 *     await requestValidation(chainId, agentId, glbUrl, res.request.requestHash);
 *   }
 */

import { BrowserProvider, Contract } from 'ethers';

import { VALIDATION_REGISTRY_ABI } from './abi.js';
import { requestSwitchChain } from './chains.js';

/**
 * Open the validation request the server asked for, signed by the connected
 * wallet. Resolves to the request transaction hash.
 *
 * @param {object} request  The `request` object from a validation_request_required response.
 * @param {number} request.chainId
 * @param {string} request.registry          ValidationRegistry address.
 * @param {string} request.validatorAddress  Validator the request is addressed to.
 * @param {string|number} request.agentId
 * @param {string} request.requestURI        What is being validated (the GLB URL).
 * @param {string} request.requestHash       bytes32 id the validator will answer.
 * @returns {Promise<string>} Transaction hash.
 */
export async function openValidationRequest({
	chainId,
	registry,
	validatorAddress,
	agentId,
	requestURI,
	requestHash,
}) {
	if (!window.ethereum) {
		throw new Error('No wallet detected. Connect the wallet that owns this agent to request validation.');
	}
	if (!registry || !validatorAddress || !requestHash) {
		throw new Error('Incomplete validation request from the server.');
	}

	let provider = new BrowserProvider(window.ethereum);
	const current = Number((await provider.getNetwork()).chainId);
	if (current !== Number(chainId)) {
		await requestSwitchChain(Number(chainId));
		// The provider caches the network it was built on, so rebuild after a switch.
		provider = new BrowserProvider(window.ethereum);
	}

	const signer = await provider.getSigner();
	const contract = new Contract(registry, VALIDATION_REGISTRY_ABI, signer);
	const tx = await contract.validationRequest(
		validatorAddress,
		BigInt(agentId),
		requestURI || '',
		requestHash,
	);
	await tx.wait();
	return tx.hash;
}
