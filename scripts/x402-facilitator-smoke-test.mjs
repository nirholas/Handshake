#!/usr/bin/env node
// scripts/x402-facilitator-smoke-test.mjs
//
// Smoke test for the self-hosted x402 facilitator (api/x402-facilitator).
//
// TWO MODES, and the safe one is the default:
//
//   verify-only (DEFAULT, no --settle)
//     Drives the whole paying path except the broadcast: reads the facilitator's
//     capability documents, asserts the ring reports no config warnings, pulls a
//     real 402 challenge off /api/x402/ring-settle, signs a real USDC transfer
//     for that challenge, and POSTs it to the facilitator's /verify action.
//     /verify runs the same structural + on-chain settleability checks the money
//     path runs (validateRingTransaction then assertSettleable) and never
//     broadcasts, so a green run proves the rail end to end while moving zero
//     USDC and burning zero SOL. This is what the x402 sweep runs.
//
//   --settle
//     Drives ONE real, cents-capped USDC settlement through
//     /api/x402/ring-settle: the exact code path the production autonomous ring
//     loop uses (api/_lib/x402/pay.js:payX402 -> 402 challenge -> self-facilitator
//     verify+settle). Real money moves, so it requires an explicit --url and is
//     never pointed at a default target.
//
// Config is read from the shell first and .env / .env.local second (same
// secrets the ring pipelines use, never committed):
//   X402_SEED_SOLANA_SECRET_BASE58   ring payer keypair (signs the transfer)
//   X402_ASSET_MINT_SOLANA           USDC mint (defaults to mainnet USDC)
//   SOLANA_RPC_URL                   any working mainnet RPC
//
// Usage:
//   node scripts/x402-facilitator-smoke-test.mjs                          # verify-only vs https://three.ws
//   node scripts/x402-facilitator-smoke-test.mjs --url=https://<preview>  # verify-only vs a preview
//   node scripts/x402-facilitator-smoke-test.mjs --url=https://<preview> --settle --cap=0.05
//
// Exit code: 0 = every check passed, 1 = anything else (never silently
// "probably fine": a skipped, free, or failed result is a failed test).

import { config as dotenv } from 'dotenv';

// Shell env wins: dotenv never overrides a var that is already set, so an
// operator pointing this at a preview with different secrets stays in control.
dotenv({ path: new URL('../.env', import.meta.url), quiet: true });
dotenv({ path: new URL('../.env.local', import.meta.url), quiet: true });

const { PublicKey } = await import('@solana/web3.js');
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } =
	await import('@solana/spl-token');
const {
	payX402, bootstrapSolanaContext, buildPaymentTx, parseSolanaAccept,
	fetchWithTimeout, ringSelfPayDefault, nextAutoNonce, USDC_MINT,
} = await import('../api/_lib/x402/pay.js');

const args = process.argv.slice(2);
const opt = (name, def) => {
	const p = args.find((a) => a.startsWith(`--${name}=`));
	return p ? p.slice(name.length + 3) : def;
};

const DEFAULT_TARGET = 'https://three.ws';
const settleMode = args.includes('--settle');
const explicitUrl = opt('url', null);
const baseUrl = (explicitUrl || DEFAULT_TARGET).replace(/\/$/, '');
const capUsd = Number(opt('cap', '0.05'));

// A real settlement never runs against an implied target. Naming the deployment
// is the operator's acknowledgement that this call spends mainnet USDC.
if (settleMode && !explicitUrl) {
	console.error('--settle spends real USDC and refuses an implied target. Pass --url=https://<deployment> explicitly.');
	process.exit(1);
}
if (!USDC_MINT) {
	console.error('X402_ASSET_MINT_SOLANA resolved empty. Export the same value used on the target deploy.');
	process.exit(1);
}
if (settleMode && (!Number.isFinite(capUsd) || capUsd <= 0 || capUsd > 1)) {
	console.error('--cap must be a small positive USD number (<=1). Refusing to run a smoke test with a large cap.');
	process.exit(1);
}

const capAtomic = Math.round(capUsd * 1_000_000); // USDC = 6dp
const RING_SETTLE_URL = `${baseUrl}/api/x402/ring-settle`;
const SOLANA_NETWORK_PREFIX = 'solana:';

const checks = [];
function record(name, ok, detail) {
	checks.push({ name, ok, detail });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
	return ok;
}

// ── Stage 1: capability documents ───────────────────────────────────────────
// The facilitator index and /supported are public probes. If either stops
// advertising exact/solana, every paying client silently routes elsewhere.
async function checkCapabilityDocs() {
	const index = await fetchWithTimeout(`${baseUrl}/api/x402-facilitator`, { method: 'GET' });
	const doc = index.body && typeof index.body === 'object' ? index.body : null;
	if (!index.ok || !doc) {
		return record('facilitator index reachable', false, `HTTP ${index.status} from ${baseUrl}/api/x402-facilitator`);
	}
	const kinds = Array.isArray(doc.kinds) ? doc.kinds : [];
	const solanaExact = kinds.find(
		(k) => k?.scheme === 'exact' && String(k?.network || '').startsWith(SOLANA_NETWORK_PREFIX),
	);
	record(
		'facilitator index reachable',
		true,
		`enabled=${doc.enabled} payTo=${doc.payTo || 'unset'} feePayer=${doc.feePayer || 'unset'} asset=${doc.asset || 'unset'}`,
	);
	record('facilitator advertises exact/solana', Boolean(solanaExact), solanaExact ? `network=${solanaExact.network}` : `kinds=${JSON.stringify(kinds)}`);
	record('self facilitator enabled', doc.enabled === true, doc.enabled === true ? null : 'X402_SELF_FACILITATOR_ENABLED is not true on the target: settlement falls through to an external facilitator');
	record('facilitator receiver configured', Boolean(doc.payTo && doc.asset), doc.payTo && doc.asset ? null : 'payTo or asset missing: 402 challenges cannot advertise a Solana accept');

	const supported = await fetchWithTimeout(`${baseUrl}/api/x402-facilitator/supported`, { method: 'GET' });
	const supportedKinds = Array.isArray(supported.body?.kinds) ? supported.body.kinds : [];
	const supportedSolana = supportedKinds.some(
		(k) => k?.scheme === 'exact' && String(k?.network || '').startsWith(SOLANA_NETWORK_PREFIX),
	);
	record(
		'/supported capability probe',
		supported.ok && supportedSolana,
		supported.ok && supportedSolana ? `kinds=${supportedKinds.length}` : `HTTP ${supported.status} body=${JSON.stringify(supported.body).slice(0, 200)}`,
	);
}

// ── Stage 2: ring configuration ─────────────────────────────────────────────
// config_warnings is the ring's own self-diagnosis (missing payer, price above
// cap, unfunded fee wallet). A non-empty list means the loop is degraded even
// when every individual endpoint answers.
async function checkRingConfig() {
	const status = await fetchWithTimeout(`${baseUrl}/api/x402-status`, { method: 'GET' });
	const accepts = Array.isArray(status.body?.accepts) ? status.body.accepts : [];
	const solanaAccepts = accepts.filter((a) => String(a?.network || '').startsWith(SOLANA_NETWORK_PREFIX));
	record(
		'x402-status advertises a Solana accept',
		status.ok && solanaAccepts.length > 0,
		status.ok ? `accepts=${accepts.length} solana=${solanaAccepts.length}` : `HTTP ${status.status}`,
	);

	const ring = await fetchWithTimeout(`${baseUrl}/api/x402-ring`, { method: 'GET' });
	if (!ring.ok || !ring.body || typeof ring.body !== 'object') {
		return record('ring reports no config warnings', false, `HTTP ${ring.status} from ${baseUrl}/api/x402-ring`);
	}
	const warnings = Array.isArray(ring.body.config_warnings) ? ring.body.config_warnings : [];
	record('ring reports no config warnings', warnings.length === 0, warnings.length ? JSON.stringify(warnings) : null);
	const settlements = ring.body.settlements || {};
	console.log(`        settlements so far: count=${settlements.count ?? '?'} gross_usdc=${settlements.gross_usdc ?? '?'}`);
}

// ── Stage 3: the 402 challenge ──────────────────────────────────────────────
// An unpaid POST is a read: the paywall answers 402 with the requirements and
// changes no state. Returns the parsed Solana accept for stage 4.
async function fetchChallenge() {
	const probe = await fetchWithTimeout(RING_SETTLE_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'user-agent': 'threews-x402-facilitator-smoke/1.0' },
		body: JSON.stringify({ note: 'facilitator-smoke-test', seq: 1 }),
	});
	if (probe.status !== 402) {
		record('ring-settle issues a 402 challenge', false, `expected HTTP 402, got ${probe.status}: ${JSON.stringify(probe.body).slice(0, 200)}`);
		return null;
	}
	const accept = parseSolanaAccept(probe.body);
	if (!accept) {
		record('402 challenge carries a Solana accept', false, `accepts=${JSON.stringify(probe.body?.accepts || []).slice(0, 300)}`);
		return null;
	}
	record('ring-settle issues a 402 challenge', true, `price=${(Number(accept.amount) / 1e6).toFixed(6)} USDC payTo=${accept.payTo}`);
	record('402 challenge carries a Solana accept', accept.asset === USDC_MINT, accept.asset === USDC_MINT ? `asset=${accept.asset}` : `advertised asset ${accept.asset} is not the configured mint ${USDC_MINT}`);
	return accept;
}

// ── Stage 4: signed-payment verification (no broadcast) ─────────────────────
// Builds the same signed transfer payX402 would send and hands it to the
// facilitator's /verify action. /verify decodes it, enforces the payTo
// allowlist, the settleable-mint pin, the fee ceiling and the instruction shape,
// then simulates settleability against the RPC. It never broadcasts, so this
// exercises the money path without moving money.
async function checkSignedVerify() {
	const accept = await fetchChallenge();
	if (!accept) return;

	const ctx = await bootstrapSolanaContext();
	console.log(`        payer pubkey: ${ctx.buyer.publicKey.toBase58()}`);

	const selfPay = ringSelfPayDefault();
	const receiverAta = getAssociatedTokenAddressSync(
		new PublicKey(accept.asset), new PublicKey(accept.payTo),
		false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
	);
	const receiverAtaInfo = await ctx.conn.getAccountInfo(receiverAta).catch(() => null);
	const txBase64 = buildPaymentTx({
		accept, buyer: ctx.buyer, blockhash: ctx.blockhash, mintInfo: ctx.mintInfo,
		receiverAtaExists: receiverAtaInfo !== null,
		nonce: nextAutoNonce(), selfPay,
	});

	const verifyRes = await fetchWithTimeout(`${baseUrl}/api/x402-facilitator/verify`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'user-agent': 'threews-x402-facilitator-smoke/1.0' },
		body: JSON.stringify({
			paymentPayload: {
				x402Version: 2,
				scheme: 'exact',
				network: accept.network,
				resource: { url: RING_SETTLE_URL, mimeType: 'application/json' },
				payload: { transaction: txBase64 },
				accepted: accept,
			},
			paymentRequirements: accept,
		}),
	});
	const verdict = verifyRes.body && typeof verifyRes.body === 'object' ? verifyRes.body : null;
	record(
		'facilitator verifies a real signed payment',
		Boolean(verifyRes.ok && verdict?.isValid),
		verdict?.isValid
			? `payer=${verdict.payer} asset=${verdict.asset} selfPay=${selfPay} (nothing broadcast)`
			: `HTTP ${verifyRes.status} reason=${verdict?.invalidReason || JSON.stringify(verifyRes.body).slice(0, 200)}`,
	);
}

// ── Stage 5 (--settle only): one real capped settlement ─────────────────────
async function checkRealSettlement() {
	const ctx = await bootstrapSolanaContext();
	console.log(`\nPaying ${RING_SETTLE_URL} (capped at $${capUsd.toFixed(2)}, payer ${ctx.buyer.publicKey.toBase58()})...`);
	const result = await payX402({
		url: RING_SETTLE_URL,
		body: { note: 'facilitator-smoke-test', seq: 1 },
		buyer: ctx.buyer,
		conn: ctx.conn,
		blockhash: ctx.blockhash,
		mintInfo: ctx.mintInfo,
		remainingCap: capAtomic,
	});
	console.log(JSON.stringify(result, null, 2));
	record(
		'real settlement landed on-chain',
		Boolean(result.success && result.paid && result.txSig),
		result.txSig ? `https://solscan.io/tx/${result.txSig}` : `status=${result.status} err=${result.errorMsg}`,
	);
}

async function main() {
	console.log('\n=== x402 self-facilitator smoke test ===');
	console.log(`target:      ${baseUrl}`);
	console.log(`mode:        ${settleMode ? `settle (real USDC, capped at $${capUsd.toFixed(2)} / ${capAtomic} atomic)` : 'verify-only (no money moves)'}\n`);

	await checkCapabilityDocs();
	await checkRingConfig();
	await checkSignedVerify();
	if (settleMode) await checkRealSettlement();

	const failed = checks.filter((c) => !c.ok);
	console.log(`\n--- summary ---`);
	console.log(`  passed: ${checks.length - failed.length}/${checks.length}`);
	if (failed.length) {
		console.log(`  failed: ${failed.map((c) => c.name).join(', ')}`);
		process.exit(1);
	}
	console.log(settleMode
		? '\nPASS. Re-check the target /api/x402-ring so settlements.count moved and config_warnings is still empty.'
		: '\nPASS. The rail verifies end to end with no settlement. Add --settle --url=<deployment> to move real USDC.');
}

main().catch((err) => {
	console.error('\nFAIL, smoke test threw:', err);
	process.exit(1);
});
