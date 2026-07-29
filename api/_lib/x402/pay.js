// api/_lib/x402/pay.js
//
// Shared Solana x402 payment client for the autonomous spend loop and every
// run()-style registry entry. The autonomous loop (api/cron/x402-autonomous-loop.js)
// pays declarative registry entries inline; richer entries that monitor a queue,
// poll a worker, or fan a call across rows declare a run(ctx) function and use
// payX402() here to settle their own USDC payments with the same primitives.
//
// Real on-chain payments only. No mocks. If the seed keypair is not configured,
// loadSeedKeypair() throws and callers degrade gracefully.

import { readFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import bs58 from 'bs58';
import {
	Connection, PublicKey, Keypair, TransactionMessage, VersionedTransaction,
	ComputeBudgetProgram,
} from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync, createTransferCheckedInstruction,
	createAssociatedTokenAccountIdempotentInstruction,
	TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getMint,
} from '@solana/spl-token';

import { env } from '../env.js';
import { solanaConnection } from '../solana/connection.js';

export const USDC_MINT = env.X402_ASSET_MINT_SOLANA;
export const SOLANA_RPC = env.SOLANA_RPC_URL;
export const FETCH_TIMEOUT_MS = 20_000;

// ── Loud price-vs-cap skip ──────────────────────────────────────────────────────
// A silent skip when an endpoint's advertised price exceeds the caller's remaining
// per-run cap is exactly the bug the ring economy was built to kill: the flagship
// ring-settle ($1.00) was dropped every cycle because the volume loop's per-run
// cap ($0.05) was below it, and nobody saw it. Now the skip is LOUD — it names the
// endpoint, the price, the cap, and the envs to raise — throttled to once per hour
// per (url,cap) signature so a per-minute driver can't flood the logs.
const _capWarnAt = new Map();
const CAP_WARN_TTL_MS = 60 * 60 * 1000;
export function warnCapExceeded(url, priceAtomic, capAtomic) {
	const now = Date.now();
	const sig = `${url}|${capAtomic}`;
	const last = _capWarnAt.get(sig) || 0;
	if (now - last < CAP_WARN_TTL_MS) return;
	_capWarnAt.set(sig, now);
	if (_capWarnAt.size > 512) {
		for (const [k, t] of _capWarnAt) if (now - t >= CAP_WARN_TTL_MS) _capWarnAt.delete(k);
	}
	console.warn(
		`[x402-pay] price_exceeds_cap — ${url} advertises ${(priceAtomic / 1e6).toFixed(6)} USDC ` +
		`but the remaining per-run cap is ${(capAtomic / 1e6).toFixed(6)} USDC, so the call was SKIPPED ` +
		`(never settled). Raise the applicable cap to fit: X402_RING_TICK_CAP_ATOMIC (per-minute ring tick), ` +
		`X402_VOLUME_PER_RUN_CAP_ATOMIC (5-min volume loop), X402_RING_DAILY_CAP_ATOMIC / ` +
		`X402_AUTONOMOUS_DAILY_CAP_ATOMIC (daily), or lower X402_PRICE_RING_SETTLE.`,
	);
}

// ── Fee floor ─────────────────────────────────────────────────────────────────
// The ring's operating rule is "lowest fees always": 1-signature self-pay
// settlement (5,000 lamports base) with the priority fee pinned at the floor.
// These constants are the single source of truth for the ring's priority-fee
// config — buildPaymentTx uses them, and the ceiling guard below reasons about
// the same numbers, so the builder and the guard can never drift apart.

export const SIGNATURE_FEE_LAMPORTS = 5000;
export const RING_CU_LIMIT = 60_000;

// Priority fee for a ring payment at batch position `nonce`. Baseline 5
// µlamports; the nonce perturbation (see buildPaymentTx) tops out at 1001
// µlamports ≈ 60 lamports over 60k CU — negligible against the 5,000 base.
export function ringPriorityMicrolamports(nonce = 0) {
	return 5 + (Number(nonce) % 997);
}

// Compute-unit-limit jitter slots. Varying the CU LIMIT changes the compiled
// message bytes — and therefore the signature — while costing nothing: the
// priority fee is price × limit / 1e6, so at the baseline 5 µlamports even the
// top of this range is 0.32 lamports, which floors to zero. Unused compute
// units are not billed, so a slightly-high limit is free. This is what buys
// three orders of magnitude more distinct signatures than perturbing the price
// alone (which costs a lamport per step once it crosses 1e6/cuLimit).
export const RING_CU_JITTER_SLOTS = 4096;

// Map a nonce to the (priority price, compute limit) pair that makes this
// payment's transaction byte-unique.
//
// Signature collisions are the mechanism behind the duplicate-settle defect
// measured on mainnet 2026-07-28: Ed25519 signatures are deterministic, so two
// ring payments with the same payer/payTo/mint/amount, built against one shared
// tick blockhash with the same fee config, compile to THE SAME transaction and
// therefore the same signature. Only one can land; the rest were being credited
// off it (12,674 of 59,271 settles, 21.4%).
//
// Self-pay has 5,000 lamports of headroom under the ceiling, so the full 997
// price slots are available: 997 × 4096 ≈ 4.08M distinct fee configs.
// Sponsor mode sits EXACTLY at the 10,000-lamport ceiling at baseline, so it may
// only use price slots whose priority still floors to zero lamports — with the
// jitter range topping out at 64,095 CU that means price ≤ 15, i.e. 11 slots
// (5..15) — still 11 × 4096 ≈ 45k configs, all at zero extra fee.
export function ringFeeConfig(nonce = 0, { selfPay = true } = {}) {
	const n = Math.abs(Number(nonce) || 0);
	const priceSlots = selfPay ? 997 : 11;
	const microLamports = 5 + (n % priceSlots);
	const cuLimit = RING_CU_LIMIT + (Math.floor(n / priceSlots) % RING_CU_JITTER_SLOTS);
	return { microLamports, cuLimit };
}

// Default nonce for payX402 callers that do not manage batch positions.
//
// This was a per-PROCESS sequential counter, which is precisely why the fix was
// needed: every Cloud Run instance started it at the same value and walked the
// same short cycle, so two instances paying the same endpoint the same amount in
// one blockhash window produced identical transactions. Drawing from a large
// space with a CSPRNG removes the cross-instance correlation entirely — there is
// no shared state to synchronise. Collisions are now a birthday problem over
// millions of slots rather than a certainty, and the facilitator's credit gate
// (settle-credit.js) makes any residual collision a clean refusal instead of a
// double credit.
export const RING_NONCE_SPACE = 997 * RING_CU_JITTER_SLOTS;
export function nextAutoNonce() {
	return randomInt(0, RING_NONCE_SPACE);
}

// Self-pay is the OPERATIVE DEFAULT for ring-internal payments: the buyer pays
// its own fee → 1 signature = 5,000 lamports, half the 2-signature sponsored
// base, and the facilitator broadcasts without co-signing. An explicit
// X402_RING_SELF_PAY=false is still honored (sponsor mode stays available for
// gasless buyers); anything else — unset included — means self-pay.
export function ringSelfPayDefault() {
	return String(process.env.X402_RING_SELF_PAY ?? '').trim().toLowerCase() !== 'false';
}

// Hard per-transaction fee ceiling for ring payments (lamports). The default
// 10,000 admits the worst legitimate case (2-signature sponsor mode at the
// baseline priority fee) and nothing more; the self-pay path runs at ~5,000.
export function ringMaxFeePerTxLamports() {
	return Number(process.env.X402_RING_MAX_FEE_PER_TX_LAMPORTS || 10_000);
}

// Worst-case lamports a payment with this fee config can cost on-chain. Pure —
// the fee-floor regression tests assert the ring's builders stay under the
// ceiling for every possible nonce, and payX402 applies the same math at
// runtime. Priority lamports use integer floor division, mirroring the
// facilitator's guard math (self-facilitator.js) and the runtime's sub-lamport
// truncation.
export function expectedFeeLamports({ selfPay, priorityMicrolamports = 0, cuLimit = RING_CU_LIMIT }) {
	const signatures = selfPay ? 1 : 2;
	const priorityLamports = Math.floor(
		(Number(priorityMicrolamports) * Number(cuLimit)) / 1_000_000,
	);
	return SIGNATURE_FEE_LAMPORTS * signatures + priorityLamports;
}

// Load the autonomous payer keypair. Seed wallet preferred; agent wallet is the
// documented fallback. In non-prod a local test wallet file is honored so the
// loop and manual tests can run without env wiring.
// Decode a 64-byte Solana secret key from any of the encodings that end up in
// env vars in practice: base58 (the canonical form), a JSON array of 64 ints
// (Solana CLI keypair file pasted verbatim), or base64. Tolerates the paste
// artifacts that broke production — surrounding quotes, whitespace, and
// newlines — instead of letting bs58 throw "Non-base58 character" and silently
// pausing every x402 engine on the ring. Returns null when nothing decodes.
export function decodeSeedSecret(secret) {
	const raw = String(secret ?? '').trim().replace(/^["']|["']$/g, '').trim();
	if (!raw) return null;
	if (raw.startsWith('[')) {
		try {
			const arr = JSON.parse(raw);
			if (Array.isArray(arr) && arr.length === 64) return Uint8Array.from(arr);
		} catch { /* fall through */ }
		return null;
	}
	// Strip embedded whitespace/newlines (multi-line paste) before decoding.
	const compact = raw.replace(/\s+/g, '');
	try {
		const bytes = bs58.decode(compact);
		if (bytes.length === 64) return bytes;
	} catch { /* try base64 next */ }
	try {
		const buf = Buffer.from(compact, 'base64');
		// Buffer.from is lenient — require a clean round-trip so a mistyped
		// base58 string can't half-decode into 64 garbage bytes.
		if (buf.length === 64 && buf.toString('base64').replace(/=+$/, '') === compact.replace(/=+$/, '')) {
			return Uint8Array.from(buf);
		}
	} catch { /* undecodable */ }
	return null;
}

export function loadSeedKeypair() {
	const secret = process.env.X402_SEED_SOLANA_SECRET_BASE58
		|| process.env.X402_AGENT_SOLANA_SECRET_BASE58;
	if (secret) {
		const bytes = decodeSeedSecret(secret);
		if (!bytes) {
			throw new Error('x402 pay: seed keypair undecodable — X402_SEED_SOLANA_SECRET_BASE58 must be 64 bytes as base58, base64, or a JSON array of 64 ints');
		}
		return Keypair.fromSecretKey(bytes);
	}
	if (process.env.NODE_ENV !== 'production') {
		try {
			const arr = JSON.parse(readFileSync('/home/codespace/.config/x402-test-wallets/solana.json', 'utf8'));
			return Keypair.fromSecretKey(Uint8Array.from(arr));
		} catch { /* fall through */ }
	}
	throw new Error('x402 pay: seed keypair not configured (set X402_SEED_SOLANA_SECRET_BASE58)');
}

export async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, { ...opts, signal: ctrl.signal, redirect: 'manual' });
		let body = null;
		try { body = await res.json(); } catch { try { body = await res.text(); } catch { body = null; } }
		return { ok: res.ok, status: res.status, headers: res.headers, body };
	} finally {
		clearTimeout(t);
	}
}

export function parseSolanaAccept(challenge) {
	if (!challenge || !Array.isArray(challenge.accepts)) return null;
	return challenge.accepts.find(
		(a) => typeof a?.network === 'string' && a.network.startsWith('solana'),
	) || null;
}

export function buildPaymentTx({ accept, buyer, blockhash, mintInfo, receiverAtaExists, nonce = 0, selfPay = false }) {
	const mint = new PublicKey(accept.asset);
	const payTo = new PublicKey(accept.payTo);
	// Self-pay: the buyer IS the fee payer → the transaction needs only ONE
	// signature (5000 lamports base) instead of two (buyer + sponsor = 10000), and
	// the facilitator broadcasts it without co-signing. Sponsor mode keeps the
	// advertised fee payer so a buyer without SOL can still be sponsored.
	const feePayer = selfPay ? buyer.publicKey : new PublicKey(accept.extra.feePayer);
	const amount = BigInt(accept.amount);

	const senderAta = getAssociatedTokenAddressSync(
		mint, buyer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
	);
	const receiverAta = getAssociatedTokenAddressSync(
		mint, payTo, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
	);

	// `nonce` selects the (priority price, compute limit) pair that makes this
	// transaction byte-unique, so a batch pipeline firing several identical-amount
	// payments (same payer/payTo/mint) against one shared blockhash produces a
	// DISTINCT signature per call. Two byte-identical transfers compile to the same
	// message → same signature → only one can ever land, and the others used to be
	// credited off it. See ringFeeConfig for the sizing of the two dimensions.
	const { microLamports, cuLimit } = ringFeeConfig(nonce, { selfPay });
	const ixs = [
		ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
		ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
	];
	if (!receiverAtaExists) {
		ixs.push(createAssociatedTokenAccountIdempotentInstruction(
			feePayer, receiverAta, payTo, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
		));
	}
	ixs.push(createTransferCheckedInstruction(
		senderAta, mint, receiverAta, buyer.publicKey,
		amount, mintInfo.decimals, [], TOKEN_PROGRAM_ID,
	));

	const msg = new TransactionMessage({
		payerKey: feePayer,
		recentBlockhash: blockhash,
		instructions: ixs,
	}).compileToV0Message();
	const vtx = new VersionedTransaction(msg);
	vtx.sign([buyer]);
	return Buffer.from(vtx.serialize()).toString('base64');
}

// Build the per-tick shared Solana state once (blockhash + USDC mint info) so a
// run() that pays several rows reuses one blockhash. Standalone callers (manual
// tests) call this to bootstrap a full context without the cron loop.
export async function bootstrapSolanaContext({ buyer } = {}) {
	if (!USDC_MINT) throw new Error('x402 pay: X402_ASSET_MINT_SOLANA not configured');
	const payer = buyer || loadSeedKeypair();
	const conn = solanaConnection({ url: SOLANA_RPC, commitment: 'confirmed' });
	const [{ blockhash }, mintInfo] = await Promise.all([
		conn.getLatestBlockhash('confirmed'),
		getMint(conn, new PublicKey(USDC_MINT)),
	]);
	return { buyer: payer, conn, blockhash, mintInfo };
}

// Settle a single x402 payment against `url`. Probes for the 402 challenge,
// builds + signs the Solana USDC transfer, and replays with the X-PAYMENT header.
//
// Returns a structured outcome — never throws for protocol/network faults:
//   { success, paid, free, skipped, amountAtomic, txSig, status, responseBody, errorMsg }
//
//   paid    — a USDC payment settled on-chain (success true)
//   free    — endpoint answered 200 with no 402 (no payment needed)
//   skipped — a guard rejected the call before paying (cap, asset mismatch, …)
export async function payX402({
	url, method = 'POST', body = null,
	buyer, conn, blockhash, mintInfo,
	remainingCap = Infinity,
	userAgent = 'threews-x402-autonomous/1.0',
	// Batch pipelines pass their own position; everyone else gets a distinct
	// per-process nonce below so same-amount payments sharing a tick blockhash
	// never compile to the same signature (see nextAutoNonce).
	nonce = null,
	// Self-pay: buyer is its own fee payer → 1 signature (5000 lamports) instead
	// of 2. Half the base fee, no sponsor co-sign. The ring's operative default;
	// only an explicit X402_RING_SELF_PAY=false selects sponsor mode. See
	// ringSelfPayDefault() and buildPaymentTx.
	selfPay = ringSelfPayDefault(),
	// Optional pre-broadcast recipient gate. Called with the resolved Solana
	// `accept` (payTo, asset, amount, …) AFTER the 402 challenge is parsed and
	// BEFORE the payment tx is built/signed. Return `{ abort: true, reason }` to
	// refuse the payment without moving money — the ring agent buyers use this to
	// enforce that every counterparty is inside ringAllowedAddresses(). Returning
	// null/undefined continues the normal flow. Sync or async; a thrown hook is
	// treated as an abort (fail-closed), never a crash.
	onAccept = null,
}) {
	// ringFeeConfig applies the sponsor-mode price constraint itself (sponsor sits
	// exactly at the fee ceiling, so only zero-lamport priority slots are legal),
	// which leaves the full compute-limit jitter available in both modes.
	if (nonce == null) nonce = nextAutoNonce();
	const reqInit = {
		method,
		headers: { 'content-type': 'application/json', 'user-agent': userAgent },
		...(body != null ? { body: JSON.stringify(body) } : {}),
	};

	// Step 1 — probe for the 402 challenge.
	const probe = await fetchWithTimeout(url, reqInit);

	if (probe.status !== 402) {
		return {
			success: probe.ok, paid: false, free: true, skipped: false,
			amountAtomic: 0, txSig: null, status: probe.status,
			responseBody: probe.body,
			errorMsg: probe.ok ? null : `http_${probe.status}`,
		};
	}

	const accept = parseSolanaAccept(probe.body);
	if (!accept) {
		return { success: false, paid: false, free: false, skipped: true, amountAtomic: 0, txSig: null, status: 402, responseBody: probe.body, errorMsg: 'no_solana_accept' };
	}
	if (!USDC_MINT || accept.asset !== USDC_MINT) {
		return { success: false, paid: false, free: false, skipped: true, amountAtomic: 0, txSig: null, status: 402, responseBody: probe.body, errorMsg: `unexpected_asset:${accept.asset}` };
	}
	if (!selfPay && !accept.extra?.feePayer) {
		return { success: false, paid: false, free: false, skipped: true, amountAtomic: 0, txSig: null, status: 402, responseBody: probe.body, errorMsg: 'missing_fee_payer' };
	}

	// Pre-broadcast recipient gate. A thrown hook is a fail-closed refusal, never
	// a crash — the whole point is to stop money moving to an unexpected payTo.
	if (typeof onAccept === 'function') {
		let hook;
		try {
			hook = await onAccept(accept);
		} catch (err) {
			hook = { abort: true, reason: `onaccept_error:${String(err?.message || err).slice(0, 80)}` };
		}
		if (hook?.abort) {
			return {
				success: false, paid: false, free: false, skipped: true, refusedByHook: true,
				amountAtomic: Number(accept.amount || 0), txSig: null, status: 402,
				responseBody: probe.body, errorMsg: hook.reason || 'onaccept_abort',
			};
		}
	}

	const amountAtomic = Number(accept.amount || 0);
	if (amountAtomic > remainingCap) {
		warnCapExceeded(url, amountAtomic, Number.isFinite(remainingCap) ? remainingCap : 0);
		return { success: false, paid: false, free: false, skipped: true, amountAtomic, txSig: null, status: 402, responseBody: probe.body, errorMsg: 'cap_would_exceed' };
	}

	// Fee ceiling — refuse to send a payment whose fee config could exceed
	// X402_RING_MAX_FEE_PER_TX_LAMPORTS. A structured skip, not a throw: the
	// caller records it like any other guard rejection. This is the runtime
	// twin of the fee-floor regression tests over expectedFeeLamports().
	const feeConfig = ringFeeConfig(nonce, { selfPay });
	const worstCaseFeeLamports = expectedFeeLamports({
		selfPay,
		priorityMicrolamports: feeConfig.microLamports,
		cuLimit: feeConfig.cuLimit,
	});
	const maxFeeLamports = ringMaxFeePerTxLamports();
	if (worstCaseFeeLamports > maxFeeLamports) {
		return {
			success: false, paid: false, free: false, skipped: true,
			amountAtomic, txSig: null, status: 402, responseBody: probe.body,
			errorMsg: `fee_ceiling_exceeded:${worstCaseFeeLamports}>${maxFeeLamports}`,
		};
	}

	// Step 2 — does the receiver ATA already exist? (saves an idempotent create ix)
	const receiverAta = getAssociatedTokenAddressSync(
		new PublicKey(accept.asset), new PublicKey(accept.payTo),
		false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
	);
	const receiverAtaInfo = await conn.getAccountInfo(receiverAta).catch(() => null);

	// Step 3 — build the signed transaction + X-PAYMENT envelope.
	const txBase64 = buildPaymentTx({
		accept, buyer, blockhash, mintInfo,
		receiverAtaExists: receiverAtaInfo !== null,
		nonce, selfPay,
	});
	const xPayment = Buffer.from(JSON.stringify({
		x402Version: 2,
		scheme: 'exact',
		network: accept.network,
		resource: { url, mimeType: 'application/json' },
		payload: { transaction: txBase64 },
		accepted: accept,
	})).toString('base64');

	// Step 4 — replay the request carrying the payment.
	const paidRes = await fetchWithTimeout(url, {
		...reqInit,
		headers: { ...reqInit.headers, 'x-payment': xPayment },
	});

	let txSig = null;
	if (paidRes.ok) {
		const responseHeader = paidRes.headers?.get?.('x-payment-response');
		if (responseHeader) {
			try {
				const settled = JSON.parse(Buffer.from(responseHeader, 'base64').toString('utf8'));
				txSig = settled?.transaction || null;
			} catch { /* non-fatal */ }
		}
	}

	return {
		success: paidRes.ok, paid: paidRes.ok, free: false, skipped: false,
		amountAtomic, txSig, status: paidRes.status,
		responseBody: paidRes.body,
		errorMsg: paidRes.ok ? null : `http_${paidRes.status}`,
	};
}
