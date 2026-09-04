// The X Layer (OKX Agent Payments Protocol) EIP-3009 verifier, exercised with
// REAL signatures from a real key: only the RPC boundary is mocked, so the
// EIP-712 hashing, the signature and the recovery are the production ones.
//
// The case that matters is the first one. Every OKX agentic wallet is an
// EIP-7702 delegated EOA, so the address carries delegation code and viem's
// verifyTypedData answers false for the EOA's own signature (it asks the
// delegate's ERC-1271, which hashes its own wrapper). Verifying that way
// rejected OKX's own listing QA payment on 2026-08-27.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const h = vi.hoisted(() => ({
	client: { verifyTypedData: vi.fn(), readContract: vi.fn() },
}));

vi.mock('viem', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, createPublicClient: vi.fn(() => h.client) };
});

process.env.X402_PAY_TO_XLAYER ||= '0x4022de2D36C334E73C7a108805Cea11C0564f402';
process.env.X402_ASSET_ADDRESS_XLAYER ||= '0x779ded0c9e1022225f8e0630b35a9b54be713736';

const { verifyOkxXLayerPayment, okxXLayerAccept } = await import('../../api/_lib/x402-xlayer-okx.js');

const PAY_TO = '0x4022de2D36C334E73C7a108805Cea11C0564f402';
const ASSET = '0x779ded0c9e1022225f8e0630b35a9b54be713736';
const AMOUNT = '10000';

const requirement = {
	...okxXLayerAccept('https://three.ws/api/okx/3d/forge-draft', AMOUNT),
	payTo: PAY_TO,
	asset: ASSET,
};

const TYPES = {
	TransferWithAuthorization: [
		{ name: 'from', type: 'address' },
		{ name: 'to', type: 'address' },
		{ name: 'value', type: 'uint256' },
		{ name: 'validAfter', type: 'uint256' },
		{ name: 'validBefore', type: 'uint256' },
		{ name: 'nonce', type: 'bytes32' },
	],
};

// A real authorization, signed by a real key against USD₮0's real EIP-712 domain.
async function signedPayment({ account, value = AMOUNT } = {}) {
	const signer = account || privateKeyToAccount(generatePrivateKey());
	const message = {
		from: signer.address,
		to: PAY_TO,
		value: BigInt(value),
		validAfter: 0n,
		validBefore: BigInt(Math.floor(Date.now() / 1000) + 600),
		nonce: `0x${'ab'.repeat(32)}`,
	};
	const signature = await signer.signTypedData({
		domain: { name: 'USD₮0', version: '1', chainId: 196, verifyingContract: ASSET },
		types: TYPES,
		primaryType: 'TransferWithAuthorization',
		message,
	});
	return {
		signer,
		payload: {
			x402Version: 2,
			accepted: requirement,
			payload: {
				authorization: {
					from: message.from,
					to: message.to,
					value: message.value.toString(),
					validAfter: '0',
					validBefore: message.validBefore.toString(),
					nonce: message.nonce,
				},
				signature,
			},
		},
	};
}

// authorizationState → unused, balanceOf → funded.
function chainStateOk() {
	h.client.readContract.mockImplementation(({ functionName }) =>
		functionName === 'authorizationState' ? Promise.resolve(false) : Promise.resolve(10n ** 18n),
	);
}

beforeEach(() => {
	h.client.verifyTypedData.mockReset();
	h.client.readContract.mockReset();
	chainStateOk();
});

describe('verifyOkxXLayerPayment', () => {
	it('accepts an EIP-7702 delegated EOA whose ERC-1271 delegate rejects the raw digest', async () => {
		// What X Layer actually answers for an OKX agentic wallet: the delegate's
		// isValidSignature says no, because it signs over its own wrapper hash.
		h.client.verifyTypedData.mockResolvedValue(false);
		const { signer, payload } = await signedPayment();

		const verified = await verifyOkxXLayerPayment({ paymentPayload: payload, requirement });

		expect(verified.isValid).toBe(true);
		expect(verified.payer).toBe(signer.address);
		expect(verified.amount).toBe(AMOUNT);
		// Recovery answered it, so no contract call was needed at all.
		expect(h.client.verifyTypedData).not.toHaveBeenCalled();
	});

	it('still verifies a smart account through ERC-1271 when recovery cannot name the payer', async () => {
		h.client.verifyTypedData.mockResolvedValue(true);
		const { payload } = await signedPayment();
		// A contract account's proof is not a recoverable ECDSA signature.
		payload.payload.signature = `0x${'cd'.repeat(120)}`;

		const verified = await verifyOkxXLayerPayment({ paymentPayload: payload, requirement });

		expect(verified.isValid).toBe(true);
		expect(h.client.verifyTypedData).toHaveBeenCalledTimes(1);
	});

	it('rejects a signature that neither recovers to the payer nor validates on-chain', async () => {
		h.client.verifyTypedData.mockResolvedValue(false);
		const { payload } = await signedPayment();
		// Same shape, a different signer: recovery names someone else.
		const other = await signedPayment();
		payload.payload.signature = other.payload.payload.signature;

		await expect(verifyOkxXLayerPayment({ paymentPayload: payload, requirement })).rejects.toThrow(
			/signature does not verify/,
		);
	});

	it('rejects an authorization paid to the wrong recipient before any chain read', async () => {
		const { payload } = await signedPayment();
		payload.payload.authorization.to = '0x1111111111111111111111111111111111111111';

		await expect(verifyOkxXLayerPayment({ paymentPayload: payload, requirement })).rejects.toThrow(
			/does not match required payTo/,
		);
		expect(h.client.readContract).not.toHaveBeenCalled();
	});

	it('reports insufficient_balance the way the approved sellers do', async () => {
		h.client.verifyTypedData.mockResolvedValue(false);
		h.client.readContract.mockImplementation(({ functionName }) =>
			functionName === 'authorizationState' ? Promise.resolve(false) : Promise.resolve(0n),
		);
		const { payload } = await signedPayment();

		await expect(verifyOkxXLayerPayment({ paymentPayload: payload, requirement })).rejects.toThrow(
			'insufficient_balance',
		);
	});
});
