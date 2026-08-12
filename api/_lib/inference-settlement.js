// Inference settlement — per-job metering and cryptographic receipts for paid
// inference work (Roadmap phase 4). Pure core: no fetch, no chain, no DB, no
// env. The I/O lives in the callers:
//
//   api/x402/llm-proxy.js        — meters each paid job, signs the response,
//                                  issues the receipt after settlement.
//   api/_lib/inference-jobs.js   — durable persistence of metered jobs.
//   api/x402/inference-verify.js — free HTTP verifier built on verifyInferenceReceipt.
//   scripts/inference-receipt-verify.mjs — offline CLI for node operators.
//
// Two signature layers, both ed25519 over domain-tagged canonical JSON (the
// same construction as the 3D provenance credentials in provenance-3d.js):
//
//   1. Response signature: the node signs the metered job core (job id,
//      prompt hash, response hash, token counts, model, provider). Proves the
//      node stands behind THIS output for THIS prompt.
//   2. Receipt signature: the settlement issuer signs the job core + the
//      response signature + the payment facts (network, payer, payTo, amount,
//      asset, settlement transaction). One signature atomically ties the money
//      to the exact work performed, so a node operator can prove "I was paid
//      X for exactly this job" and a buyer can prove "this payment bought
//      exactly this answer".
//
// Spec: specs/inference-receipts.md. Tests: tests/inference-settlement.test.js.

import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

import { sha256Hex } from './provenance-3d.js';

export const INFERENCE_RESPONSE_TYPE = 'three-inference-response/v1';
export const INFERENCE_RECEIPT_TYPE = 'three-inference-receipt/v1';

// Domain-separation tags prepended to the canonical bytes before signing, so a
// signature from any other three.ws signing scheme (vanity receipts, 3D
// provenance, agent manifests) can never be replayed as an inference artifact.
const TAG_RESPONSE = Buffer.from('three-inference-response/v1\n', 'utf8');
const TAG_RECEIPT = Buffer.from('three-inference-receipt/v1\n', 'utf8');

// Deterministic JSON: object keys sorted recursively so signer and verifier
// produce byte-identical messages regardless of key insertion order. Same
// algorithm as provenance-3d.js (kept local so this module's wire format is
// self-contained and never drifts with another feature's needs).
function canonicalize(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
	if (value && typeof value === 'object') {
		const keys = Object.keys(value).sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
	}
	return JSON.stringify(value === undefined ? null : value);
}

function taggedBytes(tag, value) {
	return Buffer.concat([tag, Buffer.from(canonicalize(value), 'utf8')]);
}

function assertHash(hex, field) {
	if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) {
		throw new Error(`${field} must be a 64-char lowercase sha256 hex string`);
	}
}

function assertTokenCount(n, field) {
	if (!Number.isInteger(n) || n < 0) {
		throw new Error(`${field} must be a non-negative integer, got ${n}`);
	}
}

/** sha256 (hex) of the exact prompt string the job ran. */
export function hashPrompt(prompt) {
	return sha256Hex(Buffer.from(String(prompt ?? ''), 'utf8'));
}

/** sha256 (hex) of the exact completion text the node returned. */
export function hashResponse(content) {
	return sha256Hex(Buffer.from(String(content ?? ''), 'utf8'));
}

/**
 * Meter one inference job: bind the job identity to the hashes of its input
 * and output and the measured token counts. This object is the signed unit:
 * everything a verifier needs to re-derive the commitment from the raw
 * prompt/content lands here.
 *
 * @param {object} args
 * @param {string} args.jobId        unique job identifier (uuid)
 * @param {string} args.route        paid route that served the job
 * @param {string} args.model        concrete model that produced the output
 * @param {string} args.provider     provider lane that ran it (groq, ovh, ...)
 * @param {string} args.prompt       raw prompt text (hashed, never stored here)
 * @param {string} args.content      raw completion text (hashed, never stored here)
 * @param {{ input?: number, output?: number }} [args.usage] provider-reported counts
 * @param {number} [args.latencyMs]  measured wall-clock latency
 * @returns {object} the metered job core
 */
export function meterInferenceJob({ jobId, route, model, provider, prompt, content, usage, latencyMs }) {
	if (!jobId || typeof jobId !== 'string') throw new Error('meterInferenceJob: jobId is required');
	if (!route || typeof route !== 'string') throw new Error('meterInferenceJob: route is required');
	const inputTokens = usage?.input ?? 0;
	const outputTokens = usage?.output ?? 0;
	assertTokenCount(inputTokens, 'usage.input');
	assertTokenCount(outputTokens, 'usage.output');
	const job = {
		type: INFERENCE_RESPONSE_TYPE,
		jobId,
		route,
		model: String(model || 'unknown'),
		provider: String(provider || 'unknown'),
		promptSha256: hashPrompt(prompt),
		responseSha256: hashResponse(content),
		inputTokens,
		outputTokens,
		tokensUsed: inputTokens + outputTokens,
	};
	if (Number.isFinite(latencyMs)) job.latencyMs = Math.round(latencyMs);
	return job;
}

/**
 * Decode an ed25519 secret key from the encodings used across this codebase:
 * base58, base64, or a JSON byte array. Accepts a 64-byte expanded secret key
 * or a 32-byte seed; returns the 32-byte seed @noble/curves signs with.
 */
export function decodeSigningSeed(secret) {
	if (secret instanceof Uint8Array) {
		if (secret.length === 32 || secret.length === 64) return secret.slice(0, 32);
		throw new Error('signing key must be a 32-byte seed or 64-byte secret key');
	}
	const trimmed = String(secret || '').trim();
	if (!trimmed) throw new Error('signing key is empty');
	if (trimmed.startsWith('[')) {
		try {
			const bytes = Uint8Array.from(JSON.parse(trimmed));
			if (bytes.length === 32 || bytes.length === 64) return bytes.slice(0, 32);
		} catch (err) {
			throw new Error(`signing key: malformed JSON byte array (${err.message})`);
		}
	}
	for (const decode of [
		() => bs58.decode(trimmed),
		() => new Uint8Array(Buffer.from(trimmed, 'base64')),
	]) {
		try {
			const bytes = decode();
			if (bytes.length === 32 || bytes.length === 64) return bytes.slice(0, 32);
		} catch {
			/* try the next encoding */
		}
	}
	throw new Error('signing key must be base58, base64, or a JSON byte array (32 or 64 bytes)');
}

/** The base58 ed25519 public key for a signing seed (any accepted encoding). */
export function signerPublicKey(secret) {
	return bs58.encode(ed25519.getPublicKey(decodeSigningSeed(secret)));
}

/**
 * Sign the metered job core. This is the node's attestation: "this output,
 * these token counts, this prompt hash — I produced them for this job id."
 * Returns { responseSignature, responseSigner } (both base58).
 */
export function signJobResponse(job, secret) {
	if (!job || job.type !== INFERENCE_RESPONSE_TYPE) {
		throw new Error('signJobResponse: pass the metered job object from meterInferenceJob()');
	}
	const seed = decodeSigningSeed(secret);
	const msg = taggedBytes(TAG_RESPONSE, job);
	return {
		responseSignature: bs58.encode(ed25519.sign(msg, seed)),
		responseSigner: bs58.encode(ed25519.getPublicKey(seed)),
	};
}

/** Verify a response signature against the metered job core. Pure + offline. */
export function verifyJobResponseSignature(job, responseSignature, responseSigner) {
	try {
		const msg = taggedBytes(TAG_RESPONSE, job);
		return ed25519.verify(bs58.decode(responseSignature), msg, bs58.decode(responseSigner));
	} catch {
		return false;
	}
}

/**
 * Issue the settlement receipt: one signature tying the payment facts to the
 * exact metered job and the node's response signature.
 *
 * @param {object} args
 * @param {object} args.job                    metered job from meterInferenceJob()
 * @param {string} args.responseSignature      from signJobResponse()
 * @param {string} args.responseSigner         from signJobResponse()
 * @param {object} args.payment                { network, payer, payTo, amountAtomics, asset, transaction }
 * @param {string|Uint8Array} args.secret      issuer signing key
 * @param {string} [args.issuedAt]             ISO timestamp (default: now)
 * @returns {object} the signed receipt
 */
export function issueInferenceReceipt({ job, responseSignature, responseSigner, payment, secret, issuedAt }) {
	if (!job || job.type !== INFERENCE_RESPONSE_TYPE) {
		throw new Error('issueInferenceReceipt: pass the metered job object from meterInferenceJob()');
	}
	assertHash(job.promptSha256, 'job.promptSha256');
	assertHash(job.responseSha256, 'job.responseSha256');
	assertTokenCount(job.inputTokens, 'job.inputTokens');
	assertTokenCount(job.outputTokens, 'job.outputTokens');
	if (!payment || typeof payment !== 'object') throw new Error('issueInferenceReceipt: payment is required');
	for (const field of ['network', 'payer', 'payTo', 'asset', 'transaction']) {
		if (!payment[field] || typeof payment[field] !== 'string') {
			throw new Error(`issueInferenceReceipt: payment.${field} is required`);
		}
	}
	if (payment.amountAtomics == null || !/^\d+$/.test(String(payment.amountAtomics))) {
		throw new Error('issueInferenceReceipt: payment.amountAtomics must be a decimal string');
	}
	const core = {
		receiptType: INFERENCE_RECEIPT_TYPE,
		issuedAt: issuedAt || new Date().toISOString(),
		job,
		responseSignature,
		responseSigner,
		payment: {
			network: payment.network,
			payer: payment.payer,
			payTo: payment.payTo,
			amountAtomics: String(payment.amountAtomics),
			asset: payment.asset,
			transaction: payment.transaction,
		},
	};
	const seed = decodeSigningSeed(secret);
	const signer = bs58.encode(ed25519.getPublicKey(seed));
	const signature = bs58.encode(ed25519.sign(taggedBytes(TAG_RECEIPT, { ...core, signer }), seed));
	return { ...core, signer, signature };
}

/**
 * Verify an inference receipt. Pure and offline; on-chain confirmation of the
 * settlement transaction is a separate, optional step (the HTTP verifier and
 * the CLI both layer it on top; this function is the cryptographic core).
 *
 * @param {object} receipt the receipt object (as JSON)
 * @param {object} [opts]
 * @param {string} [opts.prompt]         raw prompt; when given, re-binds promptSha256
 * @param {string} [opts.content]        raw completion; when given, re-binds responseSha256
 * @param {string} [opts.trustedSigner]  pin the receipt issuer to this base58 pubkey
 * @returns {{ ok: boolean, checks: Array<{ name: string, ok: boolean, detail?: string }>, reason?: string }}
 */
export function verifyInferenceReceipt(receipt, { prompt, content, trustedSigner } = {}) {
	const checks = [];
	const check = (name, ok, detail) => {
		checks.push(detail ? { name, ok, detail } : { name, ok });
		return ok;
	};

	if (!receipt || typeof receipt !== 'object') {
		check('shape', false, 'receipt must be a JSON object');
		return { ok: false, checks, reason: 'not an object' };
	}
	if (
		!check('shape',
			receipt.receiptType === INFERENCE_RECEIPT_TYPE &&
			typeof receipt.signature === 'string' &&
			typeof receipt.signer === 'string' &&
			receipt.job && typeof receipt.job === 'object' &&
			receipt.payment && typeof receipt.payment === 'object',
			receipt.receiptType === INFERENCE_RECEIPT_TYPE ? undefined : `receiptType must be ${INFERENCE_RECEIPT_TYPE}`)
	) {
		return { ok: false, checks, reason: 'malformed receipt' };
	}

	const { job, payment } = receipt;

	// The receipt's own signature covers everything except `signature` itself.
	let receiptSigOk = false;
	try {
		const { signature, ...core } = receipt;
		receiptSigOk = ed25519.verify(
			bs58.decode(signature),
			taggedBytes(TAG_RECEIPT, core),
			bs58.decode(receipt.signer),
		);
	} catch {
		receiptSigOk = false;
	}
	check('receipt_signature', receiptSigOk, receiptSigOk ? undefined : 'issuer signature does not verify over the receipt core');

	if (trustedSigner) {
		check('receipt_signer_trusted', receipt.signer === trustedSigner,
			receipt.signer === trustedSigner ? undefined : `issuer ${receipt.signer} is not the pinned signer ${trustedSigner}`);
	}

	const responseSigOk = verifyJobResponseSignature(job, receipt.responseSignature, receipt.responseSigner);
	check('response_signature', responseSigOk, responseSigOk ? undefined : 'node response signature does not verify over the metered job');

	if (prompt !== undefined) {
		const want = hashPrompt(prompt);
		check('prompt_binding', job.promptSha256 === want,
			job.promptSha256 === want ? undefined : `prompt hashes to ${want}, receipt commits to ${job.promptSha256}`);
	}
	if (content !== undefined) {
		const want = hashResponse(content);
		check('response_binding', job.responseSha256 === want,
			job.responseSha256 === want ? undefined : `content hashes to ${want}, receipt commits to ${job.responseSha256}`);
	}

	const tokensOk =
		Number.isInteger(job.inputTokens) && job.inputTokens >= 0 &&
		Number.isInteger(job.outputTokens) && job.outputTokens >= 0 &&
		job.tokensUsed === job.inputTokens + job.outputTokens;
	check('token_totals', tokensOk, tokensOk ? undefined : 'tokensUsed must equal inputTokens + outputTokens');

	const paymentOk =
		typeof payment.network === 'string' && payment.network.length > 0 &&
		typeof payment.payer === 'string' && payment.payer.length > 0 &&
		typeof payment.payTo === 'string' && payment.payTo.length > 0 &&
		typeof payment.asset === 'string' && payment.asset.length > 0 &&
		typeof payment.transaction === 'string' && payment.transaction.length > 0 &&
		/^\d+$/.test(String(payment.amountAtomics ?? ''));
	check('payment_fields', paymentOk, paymentOk ? undefined : 'payment must carry network, payer, payTo, asset, transaction, amountAtomics');

	const failed = checks.find((c) => !c.ok);
	return { ok: !failed, checks, ...(failed ? { reason: failed.name } : {}) };
}
