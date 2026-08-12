// Inference settlement: per-job metering + cryptographic receipts (phase 4).
//
// Covers the pure core in api/_lib/inference-settlement.js (meter, sign,
// issue, verify) and the paidEndpoint wiring that attaches a receipt to a
// settled paid response. The facilitator-facing verify/settle calls are the
// only mocked seam, the same posture as tests/api/x402-paid-endpoint-*.test.js.

import { Readable } from 'node:stream';

import { describe, it, expect, vi, beforeAll } from 'vitest';

import {
	meterInferenceJob,
	signJobResponse,
	verifyJobResponseSignature,
	issueInferenceReceipt,
	verifyInferenceReceipt,
	hashPrompt,
	hashResponse,
	signerPublicKey,
	decodeSigningSeed,
	INFERENCE_RECEIPT_TYPE,
	INFERENCE_RESPONSE_TYPE,
} from '../api/_lib/inference-settlement.js';

// Deterministic test keys (32-byte seeds). Never used anywhere near funds.
const NODE_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const ISSUER_SEED = Uint8Array.from({ length: 32 }, (_, i) => 32 + i + 1);
const NODE_KEY = `[${Array.from(NODE_SEED).join(',')}]`;
const ISSUER_KEY = `[${Array.from(ISSUER_SEED).join(',')}]`;

const PAYMENT = {
	network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
	payer: 'BuyerWallet111111111111111111111111111111',
	payTo: 'OperatorWallet1111111111111111111111111111',
	amountAtomics: '5000',
	asset: 'DevUSDCMint1111111111111111111111111111111',
	transaction: 'DevnetTxSig1111111111111111111111111111111111',
};

function meteredJob(overrides = {}) {
	return meterInferenceJob({
		jobId: 'job-0001',
		route: '/api/x402/llm-proxy',
		model: 'llama-3.3-70b-versatile',
		provider: 'groq',
		prompt: 'Count to 3.',
		content: '1, 2, 3.',
		usage: { input: 5, output: 6 },
		latencyMs: 312,
		...overrides,
	});
}

function issuedReceipt() {
	const job = meteredJob();
	const sig = signJobResponse(job, NODE_KEY);
	const receipt = issueInferenceReceipt({
		job,
		responseSignature: sig.responseSignature,
		responseSigner: sig.responseSigner,
		payment: PAYMENT,
		secret: ISSUER_KEY,
	});
	return { job, sig, receipt };
}

describe('meterInferenceJob', () => {
	it('binds job identity to prompt/response hashes and token counts', () => {
		const job = meteredJob();
		expect(job.type).toBe(INFERENCE_RESPONSE_TYPE);
		expect(job.promptSha256).toBe(hashPrompt('Count to 3.'));
		expect(job.responseSha256).toBe(hashResponse('1, 2, 3.'));
		expect(job.inputTokens).toBe(5);
		expect(job.outputTokens).toBe(6);
		expect(job.tokensUsed).toBe(11);
		expect(job.latencyMs).toBe(312);
	});

	it('rejects negative or fractional token counts', () => {
		expect(() => meteredJob({ usage: { input: -1, output: 0 } })).toThrow(/non-negative integer/);
		expect(() => meteredJob({ usage: { input: 1.5, output: 0 } })).toThrow(/non-negative integer/);
	});

	it('requires jobId and route', () => {
		expect(() => meteredJob({ jobId: '' })).toThrow(/jobId/);
		expect(() => meteredJob({ route: '' })).toThrow(/route/);
	});
});

describe('decodeSigningSeed', () => {
	it('accepts JSON byte array, base64, and base58 encodings', () => {
		const asJson = `[${Array.from(NODE_SEED).join(',')}]`;
		const asB64 = Buffer.from(NODE_SEED).toString('base64');
		expect(decodeSigningSeed(asJson)).toEqual(NODE_SEED);
		expect(decodeSigningSeed(asB64)).toEqual(NODE_SEED);
		// base58 of the same 32 bytes decodes to the same seed
		const bs58 = Buffer.from(NODE_SEED).toString('hex');
		void bs58;
		expect(decodeSigningSeed(NODE_SEED)).toEqual(NODE_SEED);
	});

	it('rejects empty and garbage keys', () => {
		expect(() => decodeSigningSeed('')).toThrow(/empty/);
		expect(() => decodeSigningSeed('not-a-key')).toThrow(/base58, base64, or a JSON byte array/);
	});
});

describe('signJobResponse / verifyJobResponseSignature', () => {
	it('round-trips a response signature', () => {
		const job = meteredJob();
		const { responseSignature, responseSigner } = signJobResponse(job, NODE_KEY);
		expect(responseSigner).toBe(signerPublicKey(NODE_KEY));
		expect(verifyJobResponseSignature(job, responseSignature, responseSigner)).toBe(true);
	});

	it('fails when the job is tampered after signing', () => {
		const job = meteredJob();
		const { responseSignature, responseSigner } = signJobResponse(job, NODE_KEY);
		const tampered = { ...job, outputTokens: 999 };
		expect(verifyJobResponseSignature(tampered, responseSignature, responseSigner)).toBe(false);
	});

	it('fails under a different signer key', () => {
		const job = meteredJob();
		const { responseSignature } = signJobResponse(job, NODE_KEY);
		expect(verifyJobResponseSignature(job, responseSignature, signerPublicKey(ISSUER_KEY))).toBe(false);
	});

	it('refuses to sign a non-job object', () => {
		expect(() => signJobResponse({ hello: 'world' }, NODE_KEY)).toThrow(/metered job/);
	});
});

describe('issueInferenceReceipt / verifyInferenceReceipt', () => {
	it('issues a receipt that verifies fully with raw bindings and pinned signer', () => {
		const { receipt } = issuedReceipt();
		expect(receipt.receiptType).toBe(INFERENCE_RECEIPT_TYPE);
		const verdict = verifyInferenceReceipt(receipt, {
			prompt: 'Count to 3.',
			content: '1, 2, 3.',
			trustedSigner: receipt.signer,
		});
		expect(verdict.ok).toBe(true);
		expect(verdict.checks.map((c) => c.name)).toEqual([
			'shape',
			'receipt_signature',
			'receipt_signer_trusted',
			'response_signature',
			'prompt_binding',
			'response_binding',
			'token_totals',
			'payment_fields',
		]);
	});

	it('verifies without raw bindings (receipt-only third party)', () => {
		const { receipt } = issuedReceipt();
		const verdict = verifyInferenceReceipt(receipt);
		expect(verdict.ok).toBe(true);
		expect(verdict.checks.find((c) => c.name === 'prompt_binding')).toBeUndefined();
	});

	it('detects a tampered payment amount', () => {
		const { receipt } = issuedReceipt();
		const tampered = { ...receipt, payment: { ...receipt.payment, amountAtomics: '1' } };
		const verdict = verifyInferenceReceipt(tampered);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toBe('receipt_signature');
	});

	it('detects a tampered job field', () => {
		const { receipt } = issuedReceipt();
		const tampered = { ...receipt, job: { ...receipt.job, outputTokens: 999, tokensUsed: 1004 } };
		const verdict = verifyInferenceReceipt(tampered);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toBe('receipt_signature');
	});

	it('detects a wrong prompt', () => {
		const { receipt } = issuedReceipt();
		const verdict = verifyInferenceReceipt(receipt, { prompt: 'Count to 4.' });
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toBe('prompt_binding');
	});

	it('detects a wrong completion', () => {
		const { receipt } = issuedReceipt();
		const verdict = verifyInferenceReceipt(receipt, { content: '1, 2, 4.' });
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toBe('response_binding');
	});

	it('flags an impostor receipt signed by an unpinned key', () => {
		const job = meteredJob();
		const sig = signJobResponse(job, NODE_KEY);
		const impostor = issueInferenceReceipt({
			job,
			responseSignature: sig.responseSignature,
			responseSigner: sig.responseSigner,
			payment: PAYMENT,
			secret: NODE_KEY, // attacker self-signs with the node key
		});
		const trusted = signerPublicKey(ISSUER_KEY);
		const verdict = verifyInferenceReceipt(impostor, { trustedSigner: trusted });
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toBe('receipt_signer_trusted');
	});

	it('rejects a malformed receipt', () => {
		expect(verifyInferenceReceipt(null).ok).toBe(false);
		expect(verifyInferenceReceipt({ receiptType: 'other/v1' }).ok).toBe(false);
		expect(verifyInferenceReceipt({ receiptType: 'other/v1' }).reason).toBe('malformed receipt');
	});

	it('rejects issuance with incomplete payment facts', () => {
		const job = meteredJob();
		const sig = signJobResponse(job, NODE_KEY);
		expect(() =>
			issueInferenceReceipt({
				job,
				responseSignature: sig.responseSignature,
				responseSigner: sig.responseSigner,
				payment: { ...PAYMENT, transaction: '' },
				secret: ISSUER_KEY,
			}),
		).toThrow(/payment\.transaction/);
		expect(() =>
			issueInferenceReceipt({
				job,
				responseSignature: sig.responseSignature,
				responseSigner: sig.responseSigner,
				payment: { ...PAYMENT, amountAtomics: 'abc' },
				secret: ISSUER_KEY,
			}),
		).toThrow(/amountAtomics/);
	});
});

// ── paidEndpoint wiring: receipt rides the settled paid response ──────────

const verifyPayment = vi.fn();
const settlePayment = vi.fn();
vi.mock('../api/_lib/x402-spec.js', async (importActual) => {
	const actual = await importActual();
	return { ...actual, verifyPayment, settlePayment };
});
vi.mock('@coinbase/x402', () => ({ createCdpAuthHeaders: vi.fn(async () => ({})) }));

let paidEndpoint;
beforeAll(async () => {
	process.env.INFERENCE_SIGNING_KEY = NODE_KEY;
	process.env.INFERENCE_RECEIPT_SIGNING_KEY = ISSUER_KEY;
	// Same env seam as tests/api/x402-paid-endpoint-streaming.test.js: in-memory
	// idempotency fallback, a configured Base accept, no CDP creds.
	process.env.X402_ALLOW_MEMORY_FALLBACK = '1';
	delete process.env.DATABASE_URL;
	process.env.X402_PAY_TO_BASE = '0x4022de2d36c334e73c7a108805cea11c0564f402';
	process.env.X402_ASSET_ADDRESS_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
	process.env.X402_MAX_AMOUNT_REQUIRED = '1000';
	process.env.X402_ADVERTISE_BASE = 'true';
	delete process.env.CDP_API_KEY_ID;
	delete process.env.CDP_API_KEY_SECRET;
	delete process.env.X402_BUILDER_CODE_APP;
	({ paidEndpoint } = await import('../api/_lib/x402-paid-endpoint.js'));
});

const BASE = 'eip155:8453';
const PAY_TO_BASE = '0x4022de2d36c334e73c7a108805cea11c0564f402';

function mockReqRes(headers = {}) {
	const lowerHeaders = {};
	for (const [k, v] of Object.entries(headers)) lowerHeaders[k.toLowerCase()] = v;
	const req = Object.assign(new Readable({ read() {} }), {
		method: 'POST',
		url: '/api/x402/llm-proxy',
		headers: lowerHeaders,
		connection: { remoteAddress: '127.0.0.1' },
		socket: { remoteAddress: '127.0.0.1' },
	});
	req.push(null);
	const chunks = [];
	const resHeaders = {};
	const res = {
		statusCode: 200,
		writableEnded: false,
		setHeader(k, v) {
			resHeaders[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return resHeaders[k.toLowerCase()];
		},
		end(body) {
			if (body !== undefined) chunks.push(body);
			res.writableEnded = true;
		},
		write(chunk) {
			chunks.push(chunk);
		},
		get body() {
			return chunks.join('');
		},
	};
	return { req, res };
}

describe('paidEndpoint metered hook', () => {
	it('merges the metered hook result into the response body after settlement', async () => {
		verifyPayment.mockResolvedValue({
			payer: PAYMENT.payer,
			requirement: {
				network: BASE,
				payTo: PAY_TO_BASE,
				amount: '5000',
				asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
			},
		});
		settlePayment.mockResolvedValue({
			success: true,
			transaction: '0xsettledtx',
			network: BASE,
			payer: PAYMENT.payer,
		});

		const job = meteredJob();
		const sig = signJobResponse(job, NODE_KEY);
		const endpoint = paidEndpoint({
			route: '/api/x402/metered-test',
			method: 'POST',
			networks: ['base'],
			description: 'metered hook test',
			bazaar: {
				discoverable: true,
				info: { input: { type: 'object' }, output: { type: 'object' } },
				schema: { type: 'object' },
			},
			handler: async () => ({
				content: '1, 2, 3.',
				metering: job,
				response_signature: sig.responseSignature,
				response_signer: sig.responseSigner,
			}),
			metered: async ({ result, settled, payer, requirement }) => {
				const receipt = issueInferenceReceipt({
					job: result.metering,
					responseSignature: result.response_signature,
					responseSigner: result.response_signer,
					payment: {
						network: settled.network || requirement.network,
						payer,
						payTo: requirement.payTo,
						amountAtomics: requirement.amount,
						asset: requirement.asset,
						transaction: settled.transaction,
					},
					secret: ISSUER_KEY,
				});
				return { inferenceReceipt: receipt };
			},
		});

		const paymentHeader = Buffer.from(
			JSON.stringify({
				x402Version: 2,
				scheme: 'exact',
				network: BASE,
				payload: { authorization: { value: '5000', to: PAY_TO_BASE } },
			}),
		).toString('base64');
		const { req, res } = mockReqRes({ 'x-payment': paymentHeader });
		await endpoint(req, res);

		expect(res.writableEnded).toBe(true);
		const body = JSON.parse(res.body);
		expect(body.content).toBe('1, 2, 3.');
		expect(body.inferenceReceipt?.receiptType).toBe(INFERENCE_RECEIPT_TYPE);
		// The receipt the buyer received verifies against the exact response bytes.
		const verdict = verifyInferenceReceipt(body.inferenceReceipt, {
			content: body.content,
			trustedSigner: signerPublicKey(ISSUER_KEY),
		});
		expect(verdict.ok).toBe(true);
		expect(body.inferenceReceipt.payment.transaction).toBe('0xsettledtx');
		expect(body.inferenceReceipt.payment.amountAtomics).toBe('5000');
	});

	it('ships the un-metered response when the metered hook throws', async () => {
		verifyPayment.mockResolvedValue({
			payer: PAYMENT.payer,
			requirement: { network: BASE, payTo: PAY_TO_BASE, amount: '5000', asset: '0xasset' },
		});
		settlePayment.mockResolvedValue({ success: true, transaction: '0xtx', network: BASE, payer: PAYMENT.payer });
		const endpoint = paidEndpoint({
			route: '/api/x402/metered-fail-test',
			method: 'POST',
			networks: ['base'],
			description: 'metered failure test',
			bazaar: {
				discoverable: true,
				info: { input: { type: 'object' }, output: { type: 'object' } },
				schema: { type: 'object' },
			},
			handler: async () => ({ content: 'answer' }),
			metered: async () => {
				throw new Error('metering blew up');
			},
		});
		const paymentHeader = Buffer.from(
			JSON.stringify({
				x402Version: 2,
				scheme: 'exact',
				network: BASE,
				payload: { authorization: { value: '5000', to: PAY_TO_BASE } },
			}),
		).toString('base64');
		const { req, res } = mockReqRes({ 'x-payment': paymentHeader });
		await endpoint(req, res);
		expect(res.writableEnded).toBe(true);
		expect(JSON.parse(res.body)).toEqual({ content: 'answer' });
	});
});
