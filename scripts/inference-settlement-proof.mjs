#!/usr/bin/env node
// Proof run for Roadmap phase 4: one inference job metered, settled on the
// x402 test lane, and its receipt verified against the job signature.
//
// NO REAL FUNDS. Every identity in this run is a throwaway keypair generated
// fresh per run, and the settlement asset is an SPL mint this script creates on
// the test ledger seconds earlier. Nothing here touches a platform wallet, a
// mainnet mint, or a real balance.
//
// What this script proves, end to end:
//   1. A real LLM completion runs through the platform provider chain and is
//      metered (prompt/response hashes + provider-reported token counts).
//   2. The node signs the metered job core (ed25519).
//   3. A real x402 payment is built (SPL TransferChecked), verified by the
//      in-house facilitator, and settled on-chain: verifyPayment →
//      settlePayment from api/_lib/x402-spec.js, exactly as
//      api/_lib/x402-paid-endpoint.js runs them in production.
//   4. The settlement receipt is issued over job + response signature +
//      payment facts and verified with verifyInferenceReceipt, including the
//      on-chain confirmation leg (getSignatureStatuses).
//
// ── Lanes ─────────────────────────────────────────────────────────────────
// `local` (a solana-test-validator on this machine) is the reproducible lane
// and the default when one is reachable. Start it with:
//
//     solana-test-validator --ledger /tmp/three-ws-proof-ledger --reset --quiet
//
// `devnet` is the shared public lane. It settles identically, but its faucet is
// rate-limited per IP and is frequently dry on shared CI egress, which is why
// it is not the default. Force either lane with INFERENCE_PROOF_LANE=local|devnet.
//
// The local lane is named honestly: a test validator mints a fresh genesis on
// every reset, so the script reads that genesis hash and derives the lane's real
// CAIP-2 id from it (see api/_lib/x402/solana-networks.js). The receipt records
// the ledger the payment actually settled on, never a devnet label it did not
// earn.
//
// ── The database the settle gate needs ────────────────────────────────────
// settlePayment() runs the settle-credit gate, which fails closed without a
// database (by design: see api/_lib/x402/settle-credit.js). A local Postgres
// behind a Neon-protocol proxy satisfies it without touching any real data:
//
//     docker network create threews-proof-net
//     docker run -d --name threews-proof-pg --network threews-proof-net \
//       -e POSTGRES_PASSWORD=proof -e POSTGRES_DB=threews postgres:16-alpine
//     docker run -d --name threews-proof-neon --network threews-proof-net -p 4444:4444 \
//       -e PG_CONNECTION_STRING=postgres://postgres:proof@threews-proof-pg:5432/threews \
//       ghcr.io/timowilhelm/local-neon-http-proxy:main
//     docker cp api/_lib/migrations threews-proof-pg:/migrations
//     docker exec threews-proof-pg sh -c \
//       'psql -U postgres -d threews -f /migrations/20260729000000_x402_settle_sig_unique.sql'
//
// Run: node scripts/inference-settlement-proof.mjs
// Optional env: INFERENCE_PROOF_PROMPT, INFERENCE_PROOF_LANE,
// INFERENCE_PROOF_LOCAL_RPC, SOLANA_DEVNET_RPC_URL, DATABASE_URL,
// INFERENCE_PROOF_NEON_HTTP_ENDPOINT.

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

const log = (step, msg) => console.log(`\x1b[36m[${step}]\x1b[0m ${msg}`);

const LOCAL_RPC = process.env.INFERENCE_PROOF_LOCAL_RPC || 'http://127.0.0.1:8899';
const DEVNET_RPC = process.env.SOLANA_DEVNET_RPC_URL || 'https://api.devnet.solana.com';
const START_VALIDATOR = `solana-test-validator --ledger /tmp/three-ws-proof-ledger --reset --quiet`;

async function rpc(url, method, params) {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	const data = await res.json();
	if (data.error) throw new Error(`${method}: ${JSON.stringify(data.error)}`);
	return data.result;
}

// ── Lane resolution ───────────────────────────────────────────────────────
// Done before importing the rail so SOLANA_RPC_URL and the local-lane network
// id are in place for every module that reads them.
const requestedLane = (process.env.INFERENCE_PROOF_LANE || 'auto').toLowerCase();
if (!['auto', 'local', 'devnet'].includes(requestedLane)) {
	console.error(`INFERENCE_PROOF_LANE must be auto, local, or devnet (got ${requestedLane})`);
	process.exit(2);
}

async function localValidatorGenesis() {
	try {
		return await rpc(LOCAL_RPC, 'getGenesisHash', []);
	} catch {
		return null;
	}
}

let lane;
let rpcUrl;
let laneGenesis = null;
if (requestedLane === 'devnet') {
	lane = 'devnet';
	rpcUrl = DEVNET_RPC;
} else {
	laneGenesis = await localValidatorGenesis();
	if (laneGenesis) {
		lane = 'local';
		rpcUrl = LOCAL_RPC;
	} else if (requestedLane === 'local') {
		console.error(`No solana-test-validator answering at ${LOCAL_RPC}. Start one with:\n\n    ${START_VALIDATOR}\n`);
		process.exit(2);
	} else {
		lane = 'devnet';
		rpcUrl = DEVNET_RPC;
		log('lane', `no local validator at ${LOCAL_RPC}; falling back to the shared devnet lane`);
	}
}

process.env.X402_SELF_FACILITATOR_ENABLED = 'true';
process.env.SOLANA_RPC_URL = rpcUrl;

// The settle path runs the DB-backed settle-credit gate (one on-chain signature
// credits at most one payment, api/_lib/x402/settle-credit.js). That gate fails
// CLOSED with no database, and relaxing it for a proof run would defeat the
// exact double-credit defence it was built for, so the proof brings its own
// Postgres rather than bypassing it. `api/_lib/db.js` speaks Neon's HTTP
// protocol; INFERENCE_PROOF_NEON_HTTP_ENDPOINT points that driver at a local
// Neon-compatible proxy in front of an ordinary Postgres. See the header.
if (process.env.INFERENCE_PROOF_NEON_HTTP_ENDPOINT) {
	const { neonConfig } = await import('@neondatabase/serverless');
	neonConfig.fetchEndpoint = process.env.INFERENCE_PROOF_NEON_HTTP_ENDPOINT;
	log('lane', `neon HTTP driver pointed at ${process.env.INFERENCE_PROOF_NEON_HTTP_ENDPOINT}`);
}

const { caip2ForGenesisHash } = await import('../api/_lib/x402/solana-networks.js');
const { NETWORK_SOLANA_DEVNET } = await import('../api/_lib/x402-spec.js');

let laneNetwork;
if (lane === 'local') {
	laneNetwork = caip2ForGenesisHash(laneGenesis);
	// Teach the rail this ledger's real CAIP-2 id for the duration of the run.
	process.env.X402_SOLANA_LOCAL_NETWORK = laneNetwork;
} else {
	laneNetwork = NETWORK_SOLANA_DEVNET;
}
log('lane', `${lane} lane: rpc=${rpcUrl} network=${laneNetwork}`);

const {
	meterInferenceJob,
	signJobResponse,
	issueInferenceReceipt,
	verifyInferenceReceipt,
	signerPublicKey,
} = await import('../api/_lib/inference-settlement.js');
const { llmComplete } = await import('../api/_lib/llm.js');
const { verifyPayment, settlePayment } = await import('../api/_lib/x402-spec.js');
const { loadFeePayerKeypair } = await import('../api/_lib/x402/self-facilitator.js');
const { createSolanaSigner, buildSolanaExactPayload } = await import('../api/_lib/x402/a2a-client.js');
const { Connection, Keypair } = await import('@solana/web3.js');
const { createMint, getOrCreateAssociatedTokenAccount, mintTo } = await import('@solana/spl-token');
const { ed25519 } = await import('@noble/curves/ed25519.js');
const bs58 = (await import('bs58')).default;

// ── The facilitator, on loopback ──────────────────────────────────────────
// With the self-hosted facilitator enabled, the rail resolves it to
// `${APP_ORIGIN}/api/x402-facilitator` and calls it over HTTP. APP_ORIGIN
// defaults to https://three.ws, so a proof run left alone would ask PRODUCTION
// to co-sign a test-lane payment (and be refused by its allowlist, which is the
// correct answer to the wrong question). Serve the real facilitator handler on
// loopback under this run's env instead: same handler, same wire contract, and
// nothing leaves the machine.
const { createServer } = await import('node:http');
const facilitatorHandler = (await import('../api/x402-facilitator/[action].js')).default;
const facilitatorServer = createServer((req, res) => {
	const url = new URL(req.url, 'http://127.0.0.1');
	req.query = { action: url.pathname.split('/').filter(Boolean).pop() };
	facilitatorHandler(req, res);
});
await new Promise((resolve) => facilitatorServer.listen(0, '127.0.0.1', resolve));
facilitatorServer.unref();
process.env.PUBLIC_APP_ORIGIN = `http://127.0.0.1:${facilitatorServer.address().port}`;
log('lane', `self-hosted facilitator served on loopback at ${process.env.PUBLIC_APP_ORIGIN}/api/x402-facilitator`);

// Fresh throwaway identities for the run: payer, payee, sponsor (fee payer),
// node signing key, receipt issuer key. Nothing here touches a real wallet.
const fresh = () => ed25519.utils.randomSecretKey?.() ?? ed25519.utils.randomPrivateKey();
const seedToFull = (seed) => new Uint8Array([...seed, ...ed25519.getPublicKey(seed)]);

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

async function confirmSig(sig, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const r = await rpc(rpcUrl, 'getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
		const st = r?.value?.[0];
		if (st?.err) throw new Error(`signature ${sig} failed on-chain: ${JSON.stringify(st.err)}`);
		if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return st;
		await new Promise((r2) => setTimeout(r2, 500));
	}
	throw new Error(`signature ${sig} not confirmed within ${timeoutMs}ms`);
}

async function airdrop(pubkeyB58, sol) {
	const lamports = Math.round(sol * 1e9);
	try {
		return await rpc(rpcUrl, 'requestAirdrop', [pubkeyB58, lamports]);
	} catch (err) {
		if (lane === 'local') throw err;
		// The public devnet faucet is rate-limited per IP and shared by every CI
		// runner on the planet. Name the reproducible lane rather than leaving the
		// operator staring at a bare 429.
		throw new Error(
			`devnet airdrop failed (${err.message}).\n` +
			`The public faucet is dry or rate-limited for this IP. Run the proof on the local lane instead:\n\n    ${START_VALIDATOR}\n\nthen re-run this script.`,
		);
	}
}

// ── 1. Meter a real inference job ─────────────────────────────────────────
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

// ── 2. The node signs the metered job ─────────────────────────────────────
const nodeKey = `[${Array.from(nodeSeed).join(',')}]`;
const issuerKey = `[${Array.from(issuerSeed).join(',')}]`;
const sig = signJobResponse(job, nodeKey);
log('sign', `response signature by node ${sig.responseSigner} (${sig.responseSignature.slice(0, 16)}…)`);

// ── 3. Provision the test lane and settle over the x402 rail ──────────────
// The sponsor pays every setup fee and co-signs the payment as the facilitator
// fee payer, so the payer wallet needs no SOL at all: it holds only the SPL
// balance it is about to spend, exactly like a real gasless x402 buyer.
log('settle', `funding the throwaway sponsor on ${lane} (${sponsorPub})`);
await confirmSig(await airdrop(sponsorPub, 2));
log('settle', 'sponsor funded with 2 SOL');

const connection = new Connection(rpcUrl, 'confirmed');
const sponsorKeypair = Keypair.fromSeed(sponsorSeed);

// A purpose-made 6-decimal SPL mint for this run. Creating it here is what
// makes the proof non-interactive: no third-party token faucet, no pre-funded
// wallet, and no real asset anywhere in the transcript.
const mint = await createMint(connection, sponsorKeypair, sponsorKeypair.publicKey, null, 6);
log('settle', `created test SPL mint ${mint.toBase58()} (6 decimals, authority = throwaway sponsor)`);

// The self-facilitator refuses to settle to a payTo it does not know, or in a
// mint the platform does not issue 402s for. Both guards stay ON for the proof:
// they are pointed at this run's throwaway payee and its freshly created test
// mint, which is exactly how an operator configures a test lane.
process.env.X402_SELF_FACILITATOR_PAYTO_ALLOWLIST = payeePub;
process.env.X402_ASSET_MINT_SOLANA = mint.toBase58();

const amountAtomics = '5000';
const payerAta = await getOrCreateAssociatedTokenAccount(connection, sponsorKeypair, mint, Keypair.fromSeed(payerSeed).publicKey);
await getOrCreateAssociatedTokenAccount(connection, sponsorKeypair, mint, Keypair.fromSeed(payeeSeed).publicKey);
const mintSig = await mintTo(connection, sponsorKeypair, mint, payerAta.address, sponsorKeypair, 1_000_000);
await confirmSig(mintSig);
log('settle', `payer ${payerPub} funded with 1000000 atomics of the test mint`);

const requirement = {
	scheme: 'exact',
	network: laneNetwork,
	amount: amountAtomics,
	maxTimeoutSeconds: 60,
	resource: 'https://three.ws/api/x402/llm-proxy',
	payTo: payeePub,
	asset: mint.toBase58(),
	extra: { name: 'PROOF-USD', decimals: 6, feePayer: sponsorPub },
};

const signer = await createSolanaSigner(payerSecret58);
const payload = await buildSolanaExactPayload({
	accept: requirement,
	signer,
	resource: requirement.resource,
	rpcUrl,
});
const paymentHeader = Buffer.from(JSON.stringify(payload)).toString('base64');
log('settle', 'payment payload built (SPL TransferChecked, partially signed by payer)');

const feePayer = loadFeePayerKeypair();
log('settle', `self-facilitator sponsor key loaded: ${feePayer.publicKey.toBase58()}`);

const verified = await verifyPayment({ paymentHeader, requirements: [requirement] });
log('settle', `facilitator /verify: payer=${verified.payer}`);

const settled = await settlePayment({ verified });
log('settle', `settled on ${lane}: tx=${settled.transaction}`);

// ── 4. Issue and verify the receipt ───────────────────────────────────────
const receipt = issueInferenceReceipt({
	job,
	responseSignature: sig.responseSignature,
	responseSigner: sig.responseSigner,
	payment: {
		network: laneNetwork,
		payer: verified.payer,
		payTo: payeePub,
		amountAtomics,
		asset: mint.toBase58(),
		transaction: settled.transaction,
	},
	secret: issuerKey,
});
log('receipt', `issued by ${receipt.signer} (signature ${receipt.signature.slice(0, 16)}…)`);

// Full verification: both signatures, the raw prompt/content bindings, the
// pinned issuer, and the on-chain leg.
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

// A receipt that still verifies after the response text is altered would prove
// nothing, so the run also demonstrates the negative: one flipped character in
// the completion must break the binding.
const tampered = verifyInferenceReceipt(receipt, { prompt, content: `${completion.text} ` });
if (tampered.ok) {
	console.error('\nPROOF FAILED: receipt verified against altered response content');
	process.exit(1);
}
log('verify', `tamper check: altering the response invalidates the receipt (${tampered.reason})`);

const st = await confirmSig(settled.transaction);
log('verify', `on-chain settlement confirmed at slot ${st.slot}`);

console.log(`\nPROOF RESULT: PASS. One inference job metered, settled on the ${lane} test lane, receipt verified against the job signature.`);
console.log(JSON.stringify({ lane, network: laneNetwork, jobId: job.jobId, tx: settled.transaction, receipt }, null, 2));
