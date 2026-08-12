#!/usr/bin/env node
// Proof run for Roadmap phase 4: one inference job metered, settled on the
// x402 test lane, and its receipt verified against the job signature. No real
// funds: the settlement lane is Solana DEVNET via the platform's self-hosted
// facilitator (X402_SELF_FACILITATOR_ENABLED), co-signed by a throwaway
// sponsor keypair generated fresh per run and funded by a devnet SOL airdrop.
//
// What this script proves, end to end:
//   1. A real LLM completion runs through the platform provider chain and is
//      metered (prompt/response hashes + provider-reported token counts).
//   2. The node signs the metered job core (ed25519, INFERENCE_SIGNING_KEY).
//   3. A devnet x402 payment is built (SPL TransferChecked), verified by the
//      in-house facilitator, and settled on-chain: verifyPayment →
//      settlePayment from api/_lib/x402-spec.js against
//      NETWORK_SOLANA_DEVNET, exactly as api/_lib/x402-paid-endpoint.js runs
//      them in production.
//   4. The settlement receipt is issued over job + response signature +
//      payment facts and verified with verifyInferenceReceipt, including the
//      on-chain confirmation leg (getSignatureStatuses on devnet).
//
// Run: node scripts/inference-settlement-proof.mjs
// Optional env: INFERENCE_PROOF_PROMPT, VERTEX_CLAUDE_ENABLED=1 to run the
// completion on Vertex Claude (GCP credits) instead of the free chain.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Same .env loader the repo's other ops scripts use: first wins, shell env
// always overrides the file. Missing file is fine: every lane this script
// needs either comes from the shell env or from a free provider.
try {
	for (const line of readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
	}
} catch {
	/* no .env on this machine; env vars may still come from the shell */
}

// Devnet settlement wiring, set before importing the rail so env.js reads it.
// The proof needs no DATABASE_URL: logPaymentEvent is not on this path, and
// the metered-job insert is exercised separately against the schema.
process.env.X402_SELF_FACILITATOR_ENABLED = 'true';
process.env.SOLANA_RPC_URL = process.env.SOLANA_DEVNET_RPC_URL || 'https://api.devnet.solana.com';

const {
	meterInferenceJob,
	signJobResponse,
	issueInferenceReceipt,
	verifyInferenceReceipt,
	signerPublicKey,
} = await import('../api/_lib/inference-settlement.js');
const { llmComplete } = await import('../api/_lib/llm.js');
const {
	NETWORK_SOLANA_DEVNET,
	verifyPayment,
	settlePayment,
} = await import('../api/_lib/x402-spec.js');
const { loadFeePayerKeypair } = await import('../api/_lib/x402/self-facilitator.js');
const { createSolanaSigner, buildSolanaExactPayload } = await import('../api/_lib/x402/a2a-client.js');
const { ed25519 } = await import('@noble/curves/ed25519.js');
const bs58 = (await import('bs58')).default;

const log = (step, msg) => console.log(`\x1b[36m[${step}]\x1b[0m ${msg}`);

// Fresh throwaway identities for the run: payer, payee, sponsor (fee payer),
// node signing key, receipt issuer key. Nothing here touches a real wallet.
const fresh = () => ed25519.utils.randomSecretKey?.() ?? ed25519.utils.randomPrivateKey();
const seedToFull = (seed) => {
	// Solana keypairs are 64 bytes: 32-byte seed + 32-byte pubkey.
	const pub = ed25519.getPublicKey(seed);
	return new Uint8Array([...seed, ...pub]);
};

const payerSeed = fresh();
const payeeSeed = fresh();
const sponsorSeed = fresh();
const nodeSeed = fresh();
const issuerSeed = fresh();
const payerSecret58 = bs58.encode(seedToFull(payerSeed));
const payerPub = bs58.encode(ed25519.getPublicKey(payerSeed));
const payeePub = bs58.encode(ed25519.getPublicKey(payeeSeed));
const sponsorSecret58 = bs58.encode(seedToFull(sponsorSeed));
const sponsorPub = bs58.encode(ed25519.getPublicKey(sponsorSeed));

process.env.X402_FEE_PAYER_SECRET_BASE58 = sponsorSecret58;
process.env.X402_FEE_PAYER_SOLANA = sponsorPub;

// Devnet USDC mint (Circle's well-known devnet SPL USDC). The payment moves
// devnet USDC from the throwaway payer to the throwaway payee; the payer is
// funded by the faucet step below (or a cached env secret on re-runs).
const DEVNET_USDC_MINT = process.env.INFERENCE_PROOF_DEVNET_USDC_MINT || '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

async function airdrop(pubkeyB58, sol = 1) {
	const lamports = Math.round(sol * 1e9);
	// The public RPC's own airdrop is per-IP rate-limited and shared by every
	// CI runner on the planet; the official faucet host is the documented
	// alternate source. Try the RPC first (one less moving part), then the
	// faucet, and report BOTH errors when neither can fund the wallet so the
	// operator sees the real blocker instead of a generic 429.
	const attempts = [];
	try {
		const data = await rpcCall('requestAirdrop', [pubkeyB58, lamports]);
		return data;
	} catch (err) {
		attempts.push(`rpc: ${err.message}`);
	}
	try {
		const res = await fetch('https://faucet.solana.com/api/airdrop', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ pubkey: pubkeyB58, lamports, network: 'devnet' }),
		});
		const data = await res.json().catch(() => ({}));
		const sig = data?.signature || data?.result;
		if (!res.ok || !sig) throw new Error(`HTTP ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
		return sig;
	} catch (err) {
		attempts.push(`faucet.solana.com: ${err.message}`);
	}
	throw new Error(`airdrop failed on every source — ${attempts.join(' | ')}`);
}

async function rpcCall(method, params) {
	const res = await fetch(process.env.SOLANA_RPC_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	const data = await res.json();
	if (data.error) throw new Error(`${method}: ${JSON.stringify(data.error)}`);
	return data.result;
}

async function confirmSig(sig) {
	for (let i = 0; i < 30; i++) {
		const r = await rpcCall('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
		const st = r?.value?.[0];
		if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return st;
		await new Promise((r2) => setTimeout(r2, 1000));
	}
	throw new Error(`signature ${sig} not confirmed within 30s`);
}

const prompt = process.env.INFERENCE_PROOF_PROMPT || 'Count to 3.';
log('meter', `running real inference through the platform provider chain: ${JSON.stringify(prompt)}`);

const t0 = Date.now();
const completion = await llmComplete({
	system: 'You are a helpful assistant. Be concise.',
	user: prompt,
	maxTokens: 10,
	timeoutMs: 30_000,
});
const latencyMs = Date.now() - t0;
log('meter', `provider=${completion.provider} model=${completion.model} usage=${JSON.stringify(completion.usage)} latency=${latencyMs}ms`);
log('meter', `content=${JSON.stringify(completion.text)}`);

const job = meterInferenceJob({
	jobId: randomUUID(),
	route: '/api/x402/llm-proxy',
	model: completion.model,
	provider: completion.provider,
	prompt,
	content: completion.text,
	usage: { input: completion.usage?.input ?? 0, output: completion.usage?.output ?? 0 },
	latencyMs,
});
log('meter', `job ${job.jobId}: promptSha256=${job.promptSha256.slice(0, 16)}… responseSha256=${job.responseSha256.slice(0, 16)}… tokens=${job.tokensUsed}`);

const nodeKey = `[${Array.from(nodeSeed).join(',')}]`;
const issuerKey = `[${Array.from(issuerSeed).join(',')}]`;
const sig = signJobResponse(job, nodeKey);
log('sign', `response signature by node ${sig.responseSigner} (${sig.responseSignature.slice(0, 16)}…)`);

// ── Devnet settlement over the existing x402 rail ─────────────────────────
// Fund the payer + sponsor with devnet SOL, and the payer with devnet USDC
// from a faucet when available. The facilitator co-signs with the sponsor.
log('settle', `funding throwaway wallets on devnet (payer=${payerPub.slice(0, 12)}… sponsor=${sponsorPub.slice(0, 12)}…)`);
await confirmSig(await airdrop(sponsorPub, 1));
log('settle', 'sponsor funded with 1 devnet SOL');
await confirmSig(await airdrop(payerPub, 1));
log('settle', 'payer funded with 1 devnet SOL');

const amountAtomics = '5000';

// The payer needs devnet USDC at its ATA. Devnet USDC is freely mintable from
// Circle's faucet off-chain; inside this script we create the ATA and attempt
// a sponsored self-fund only when the payer already holds a balance. Check the
// balance; if zero, the settle leg reports exactly which funding step is
// missing rather than forging a settlement.
const payerAtaInfo = await rpcCall('getTokenAccountsByOwner', [
	payerPub,
	{ mint: DEVNET_USDC_MINT },
	{ encoding: 'jsonParsed' },
]).catch(() => null);
const payerBalance = payerAtaInfo?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.amount ?? '0';
log('settle', `payer devnet USDC balance: ${payerBalance} atomics`);
if (BigInt(payerBalance) < BigInt(amountAtomics)) {
	log('settle', 'payer holds no devnet USDC; funding it via the Circle devnet faucet is an interactive step.');
	log('settle', `fund ${payerPub} at https://faucet.circle.com (Solana devnet USDC), then re-run with INFERENCE_PROOF_PAYER_SECRET set.`);
	console.log('\nPROOF RESULT: inference metered + signed; settlement leg blocked on devnet USDC funding (no real funds involved).');
	console.log(JSON.stringify({ job, responseSignature: sig }, null, 2));
	process.exit(3);
}

const requirement = {
	scheme: 'exact',
	network: NETWORK_SOLANA_DEVNET,
	amount: amountAtomics,
	maxTimeoutSeconds: 60,
	resource: 'https://three.ws/api/x402/llm-proxy',
	payTo: payeePub,
	asset: DEVNET_USDC_MINT,
	extra: { name: 'USDC', decimals: 6, feePayer: sponsorPub },
};

const signer = await createSolanaSigner(payerSecret58);
const payload = await buildSolanaExactPayload({
	accept: requirement,
	signer,
	resource: requirement.resource,
	rpcUrl: process.env.SOLANA_RPC_URL,
});
const paymentHeader = Buffer.from(JSON.stringify(payload)).toString('base64');
log('settle', 'payment payload built (SPL TransferChecked, partially signed by payer)');

const feePayer = loadFeePayerKeypair();
log('settle', `self-facilitator sponsor key loaded: ${feePayer.publicKey.toBase58()}`);

const verified = await verifyPayment({ paymentHeader, requirements: [requirement] });
log('settle', `facilitator /verify: payer=${verified.payer}`);

const settled = await settlePayment({ verified });
log('settle', `settled on devnet: tx=${settled.transaction}`);

const receipt = issueInferenceReceipt({
	job,
	responseSignature: sig.responseSignature,
	responseSigner: sig.responseSigner,
	payment: {
		network: NETWORK_SOLANA_DEVNET,
		payer: verified.payer,
		payTo: payeePub,
		amountAtomics,
		asset: DEVNET_USDC_MINT,
		transaction: settled.transaction,
	},
	secret: issuerKey,
});
log('receipt', `issued by ${receipt.signer} (signature ${receipt.signature.slice(0, 16)}…)`);

// Full verification: signatures, raw bindings, pinned issuer, on-chain leg.
const verdict = verifyInferenceReceipt(receipt, {
	prompt,
	content: completion.text,
	trustedSigner: signerPublicKey(issuerKey),
});
for (const c of verdict.checks) {
	console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
}
if (!verdict.ok) {
	console.error(`\nPROOF FAILED: ${verdict.reason}`);
	process.exit(1);
}

// On-chain confirmation leg, same read-only call the CLI runs.
const st = await confirmSig(settled.transaction);
log('verify', `on-chain settlement confirmed at slot ${st.slot}`);

console.log('\nPROOF RESULT: PASS — one inference job metered, settled on the devnet test lane, receipt verified against the job signature.');
console.log(JSON.stringify({ jobId: job.jobId, tx: settled.transaction, receipt }, null, 2));
