// POST /api/x402/inference-verify
//
// Free, keyless verifier for metered inference receipts (Roadmap phase 4).
// A node operator (or buyer, or auditor) posts a receipt object and gets back
// a per-check verdict: does the issuer signature verify, does the node's
// response signature verify over the metered job, do the prompt/response
// hashes re-derive from the raw text (when supplied), is the settlement
// transaction confirmed on-chain, and is the issuer the platform's published
// signer. Everything except the optional on-chain confirmation is computed
// locally by api/_lib/inference-settlement.js; this route is a thin HTTP
// wrapper over verifyInferenceReceipt() + the settlement confirmation shared
// with /api/x402/verify-receipt.
//
// Body: {
//   receipt:  object,                 // the `inferenceReceipt` from a paid
//                                     // /api/x402/llm-proxy response
//   prompt?:  string,                 // re-bind the prompt hash
//   content?: string,                 // re-bind the response hash
//   onchain?: boolean                 // also confirm payment.transaction (default true)
// }
// Response 200: { ok, checks: [{ name, ok, detail? }], settlement?, signers }

import { wrap, cors, method, json, error, readJson, rateLimited, setRateLimitHeaders } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';
import { verifyInferenceReceipt, signerPublicKey } from '../_lib/inference-settlement.js';

// The platform's published inference signers, so a verifier can pin them
// without out-of-band key distribution. Derived live from env; absent keys
// simply omit the field (verification still runs unpinned).
function publishedSigners() {
	const out = {};
	try {
		if (env.INFERENCE_SIGNING_KEY) out.responseSigner = signerPublicKey(env.INFERENCE_SIGNING_KEY);
		if (env.INFERENCE_RECEIPT_SIGNING_KEY) out.receiptSigner = signerPublicKey(env.INFERENCE_RECEIPT_SIGNING_KEY);
	} catch {
		/* a malformed key must never break verification of everyone else's receipts */
	}
	return out;
}

// Read-only on-chain confirmation of the settlement transaction, reusing the
// same resolveNetwork mapping as /api/x402/verify-receipt. Returns
// { verified, status, detail } and never throws: an RPC outage reports
// "unverifiable", never a false "confirmed".
async function confirmSettlement(network, transaction) {
	const n = String(network || '').toLowerCase().trim();
	const isSolana = n.startsWith('solana') || n === 'sol';
	const evmChain = n.match(/^eip155:(\d+)$/);
	const alias = { base: 8453, arbitrum: 42161, bsc: 56, xlayer: 196, ethereum: 1 }[n];
	if (!isSolana && !evmChain && !alias) {
		return { verified: false, status: 'unsupported_network', detail: `network "${network}" is not one we can look up` };
	}
	try {
		if (isSolana) {
			const { solanaConnection } = await import('../_lib/solana/connection.js');
			// Devnet receipts confirm against devnet: the CAIP-2 id tells us which.
			const devnet = n.includes('etwtrabzayq6imeykouru166vu2xqa1');
			const conn = solanaConnection({
				commitment: 'confirmed',
				...(devnet ? { url: process.env.SOLANA_DEVNET_RPC_URL || 'https://api.devnet.solana.com' } : {}),
			});
			const statuses = await conn.getSignatureStatuses([transaction], { searchTransactionHistory: true });
			const st = statuses?.value?.[0];
			if (!st) return { verified: false, status: 'not_found', detail: `signature not found on Solana ${devnet ? 'devnet' : 'mainnet'}` };
			if (st.err) return { verified: false, status: 'failed', detail: 'transaction failed on-chain', slot: st.slot ?? null };
			const confirmed = st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized';
			return { verified: confirmed, status: st.confirmationStatus || 'processed', detail: confirmed ? 'settlement confirmed on Solana' : 'seen but not yet confirmed', slot: st.slot ?? null };
		}
		const chainId = evmChain ? Number(evmChain[1]) : alias;
		const { evmFallbackProvider } = await import('../_lib/evm/rpc.js');
		const provider = await evmFallbackProvider(chainId);
		const r = await provider.getTransactionReceipt(transaction);
		if (!r) return { verified: false, status: 'not_found', detail: `transaction not found on chain ${chainId}` };
		const ok = Number(r.status) === 1;
		return { verified: ok, status: ok ? 'confirmed' : 'reverted', detail: ok ? `settlement confirmed on chain ${chainId}` : 'transaction reverted on-chain', block: r.blockNumber ?? null };
	} catch (err) {
		return { verified: false, status: 'rpc_unavailable', detail: `could not reach the chain RPC: ${err?.message || 'unknown error'}` };
	}
}

async function handle(req, res) {
	const ip = clientIp(req);
	const rl = await limits.x402DevToolIp(ip);
	if (!rl.success) return rateLimited(res, rl);
	setRateLimitHeaders(res, rl);

	let body = {};
	try {
		body = (await readJson(req)) || {};
	} catch (err) {
		return error(res, 400, 'invalid_json', err.message || 'request body must be valid JSON');
	}

	const receipt = body.receipt;
	if (!receipt || typeof receipt !== 'object') {
		return error(res, 400, 'missing_receipt', 'provide `receipt`: the inferenceReceipt object from a paid /api/x402/llm-proxy response', {
			example: { receipt: { receiptType: 'three-inference-receipt/v1', job: { /* … */ }, payment: { /* … */ }, signature: '…', signer: '…' }, prompt: '…', content: '…' },
		});
	}

	const signers = publishedSigners();
	// Pin the receipt issuer when we know who we are: a receipt signed by an
	// unknown key verifies cryptographically but is flagged, so an operator
	// pinning to three.ws catches self-signed impostor receipts by default.
	const verdict = verifyInferenceReceipt(receipt, {
		prompt: body.prompt,
		content: body.content,
		trustedSigner: signers.receiptSigner,
	});

	const out = {
		ok: verdict.ok,
		checks: verdict.checks,
		ts: new Date().toISOString(),
		signers,
	};
	if (verdict.reason) out.reason = verdict.reason;

	// Optional on-chain leg: confirm the settlement transaction the receipt
	// commits to actually landed on that chain. Skippable (onchain:false) for
	// fully offline verification.
	if (body.onchain !== false && receipt.payment?.transaction && receipt.payment?.network) {
		out.settlement = await confirmSettlement(receipt.payment.network, receipt.payment.transaction);
	}

	return json(res, 200, out, { 'cache-control': 'no-store' });
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['POST'])) return;
	return handle(req, res);
});
