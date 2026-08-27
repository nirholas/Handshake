// x402-checkout — buyer-side helper for the drop-in modal.
//
// The buyer's wallet (Phantom for Solana, MetaMask for EVM) needs to sign the
// payment payload that goes into the `X-PAYMENT` header. For EVM that's an
// EIP-712 typed-data signature the wallet builds locally. For Solana the
// wallet only signs serialized transactions — it does NOT build instructions.
// So we expose this endpoint: client posts { accept, buyer }, server returns
// a partially-signed v0 transaction ready for Phantom to add the payer's sig.
//
// Endpoints:
//   POST /api/x402-checkout?action=prepare   { accept, buyer }
//      → { network, tx_base64 }              v0 SPL transferChecked, fee payer
//                                            is accept.extra.feePayer (the
//                                            facilitator's sponsor account)
//   POST /api/x402-checkout?action=encode    { signed_tx_base64, accept, resource_url }
//      → { x_payment }                       base64 paymentPayload ready for
//                                            X-PAYMENT header
//
// We split prepare + encode so the modal can show "Sign in your wallet…" while
// Phantom is open, then "Sending…" while we wrap the signed tx into the
// x402 envelope. Keeps each step short and visible.

import { z } from 'zod';
import { solanaConnection } from './_lib/solana/connection.js';
import {
	PublicKey,
	TransactionMessage,
	VersionedTransaction,
	ComputeBudgetProgram,
} from '@solana/web3.js';
import {
	TOKEN_PROGRAM_ID,
	ASSOCIATED_TOKEN_PROGRAM_ID,
	getAssociatedTokenAddressSync,
	createAssociatedTokenAccountIdempotentInstruction,
	createTransferCheckedInstruction,
} from '@solana/spl-token';
import { cors, json, method, readJson, wrap, error, rateLimited } from './_lib/http.js';
import { parse } from './_lib/validate.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { NETWORK_SOLANA_MAINNET, NETWORK_SOLANA_DEVNET } from './_lib/x402-spec.js';
import { confirmSolanaPayment } from './_lib/x402-solana-confirm.js';
import { ataExists, getRecentBlockhash, mintDecimals, respondRpcUnavailable } from './_lib/solana/read-guards.js';
import { env } from './_lib/env.js';

// Routed through env.* so the `api-mainnet.helius-rpc.com` misconfig is repaired
// (env.normalizeRpcUrl) — a bad host 404'd getAccountInfo on the USDC mint here.
const SOLANA_RPC = env.SOLANA_RPC_URL;
const SOLANA_DEVNET_RPC = env.SOLANA_RPC_URL_DEVNET;

// The three RPC reads on the prepare hot path (mint decimals, ATA existence, a
// recent blockhash) go through the shared money-path guards: canonical mints
// resolve locally, an ATA probe fails open to "missing" (the create is
// idempotent), and a blockhash is served from cache inside its validity window
// when every RPC endpoint fails. See api/_lib/solana/read-guards.js. The two
// helpers stay exported from here because the checkout tests exercise them.
export { ataExists, getRecentBlockhash };

// Build a PublicKey from a (schema-trimmed) address, converting web3.js's raw
// "Non-base58 character" / "Invalid public key" throw into a structured 400.
// Without this, a malformed address in the posted `accept` surfaces as an opaque
// 500 — the exact failure that took down USDC checkout when a stray newline rode
// in on the challenge's payTo.
function toPubkey(value, field) {
	try {
		return new PublicKey(value);
	} catch {
		const err = new Error(`${field} is not a valid Solana address`);
		err.status = 400;
		err.code = 'invalid_address';
		throw err;
	}
}

// Solana addresses arrive inside the 402 challenge's `accept` entry, which is
// built from operator-configured env (X402_PAY_TO_SOLANA / X402_FEE_PAYER_SOLANA).
// Those values are pasted into dashboards and routinely carry a trailing newline
// or stray spaces. `.trim()` here means a whitespace-tainted challenge still
// yields a working transaction instead of 500'ing on `new PublicKey()` — the
// same defensive posture as env.js's addr(). Length is checked post-trim.
const solanaAddress = z.string().trim().min(32).max(44);

export const acceptSchema = z.object({
	scheme: z.literal('exact'),
	network: z.string().trim().min(1).max(80),
	amount: z.string().regex(/^\d+$/),
	asset: solanaAddress,
	payTo: solanaAddress,
	maxTimeoutSeconds: z.number().int().positive().optional(),
	extra: z
		.object({
			name: z.string().optional(),
			decimals: z.number().int().nonnegative().optional(),
			feePayer: solanaAddress,
		})
		.passthrough(),
});

// Optional buyer-approved donations appended to the same signed transaction as
// the payment (charity split + round-up giving). The buyer always sees and
// signs these in the modal — the merchant only configures the destination/rule.
// Routes the same mint as the payment, so each tip is an extra transferChecked
// to the cause's ATA. Capped to keep a misconfigured giving rule from ever
// sweeping a buyer: ≤ 100 tokens and ≤ 50× the payment per recipient.
const TIP_ABS_MAX = 100_000_000n; // 100 USDC in 6-decimal atomics
const tipSchema = z.object({
	to: z.string().trim().min(32).max(44),
	amount: z.string().regex(/^\d+$/),
});

// Validate one buyer-approved donation against the safety caps. Pure and
// exported so the money-moving rules — well-formed recipient/amount, ≤ 100
// tokens AND ≤ 50× the payment, and recipient ≠ the merchant payout — are
// unit-testable without building a Solana transaction. The handler appends a
// transferChecked only for an `ok` result. Returns exactly one of:
//   { skip: true }                       — zero/negative amount, nothing to send
//   { ok: true, to: PublicKey, amount }  — validated, ready to route
//   { ok: false, code, message }         — rejected; caller emits a 400
export function validateTip(tip, { payTo, paymentAmount }) {
	let to;
	try {
		to = new PublicKey(tip.to);
	} catch {
		return { ok: false, code: 'invalid_tip', message: `donation recipient is not a valid address: ${tip.to}` };
	}
	let amount;
	try {
		amount = BigInt(tip.amount);
	} catch {
		return { ok: false, code: 'invalid_tip', message: 'donation amount must be a whole token amount' };
	}
	if (amount <= 0n) return { skip: true };
	if (amount > TIP_ABS_MAX || amount > paymentAmount * 50n) {
		return {
			ok: false,
			code: 'tip_too_large',
			message: 'donation exceeds the safety cap (≤ 100 tokens and ≤ 50× the payment) — check the giving configuration',
		};
	}
	if (to.equals(payTo)) {
		return { ok: false, code: 'invalid_tip', message: 'donation recipient cannot be the payment recipient' };
	}
	return { ok: true, to, amount };
}

export const prepareSchema = z.object({
	accept: acceptSchema,
	buyer: solanaAddress,
	tips: z.array(tipSchema).max(2).optional(),
});

const builderCodeBlockSchema = z
	.object({
		a: z.string().regex(/^[a-z0-9_]{1,32}$/),
		w: z
			.string()
			.regex(/^[a-z0-9_]{1,32}$/)
			.optional(),
		s: z
			.array(z.string().regex(/^[a-z0-9_]{1,32}$/))
			.max(32)
			.optional(),
	})
	.optional();

const encodeSchema = z.object({
	accept: acceptSchema,
	signed_tx_base64: z.string().min(40).max(20_000),
	resource_url: z.string().url(),
	builder_code: builderCodeBlockSchema,
});

export default wrap(async (req, res) => {
	// Public, cross-origin endpoint — the drop-in script runs on any merchant
	// site and POSTs here. No credentials, allow any origin.
	if (cors(req, res, { origins: '*', methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const action = req.query?.action;
	if (action === 'prepare') {
		try {
			return await handlePrepare(req, res);
		} catch (err) {
			// Every read on the prepare path is already fail-open or cache-backed, so
			// reaching here means the chain was unreadable with nothing cached. Answer
			// a typed 503 with Retry-After instead of an opaque internal_error.
			if (respondRpcUnavailable(res, err)) return;
			throw err;
		}
	}
	if (action === 'encode') return handleEncode(req, res);
	return error(res, 404, 'not_found', `unknown action: ${action ?? '(none)'}`);
});

function isSolanaNetwork(network) {
	return (
		network === NETWORK_SOLANA_MAINNET ||
		network === NETWORK_SOLANA_DEVNET ||
		network === 'solana'
	);
}

function rpcFor(network) {
	if (network === NETWORK_SOLANA_DEVNET) return SOLANA_DEVNET_RPC;
	return SOLANA_RPC;
}

async function handlePrepare(req, res) {
	// Per-IP rate limit: prepare fans out to multiple Solana RPC round-trips, so
	// throttle anonymous callers to stop quota-drain / cost amplification against
	// the (potentially paid) upstream RPC.
	const rl = await limits.x402PayIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many prepare requests');

	const body = parse(prepareSchema, await readJson(req));
	const { accept, buyer, tips } = body;
	if (!isSolanaNetwork(accept.network)) {
		return error(
			res,
			400,
			'unsupported_network',
			`prepare only builds Solana transactions; got network=${accept.network}. EVM clients sign EIP-712 typed data locally and don't need this endpoint.`,
		);
	}

	const rpc = rpcFor(accept.network);
	const conn = solanaConnection({ url: rpc, commitment: 'confirmed' });
	const mint = toPubkey(accept.asset, 'asset');
	const payTo = toPubkey(accept.payTo, 'payTo');
	const feePayer = toPubkey(accept.extra.feePayer, 'feePayer');
	const buyerPubkey = toPubkey(buyer, 'buyer');
	const amount = BigInt(accept.amount);

	const senderAta = getAssociatedTokenAddressSync(
		mint,
		buyerPubkey,
		false,
		TOKEN_PROGRAM_ID,
		ASSOCIATED_TOKEN_PROGRAM_ID,
	);
	const receiverAta = getAssociatedTokenAddressSync(
		mint,
		payTo,
		false,
		TOKEN_PROGRAM_ID,
		ASSOCIATED_TOKEN_PROGRAM_ID,
	);
	const decimals = await mintDecimals(conn, mint);

	// Base payment needs ~60k CU; each donation adds a transfer (+ possibly an ATA
	// create), so budget headroom per tip. Unused CU isn't charged — this only
	// raises the ceiling so a tip can't blow the limit and fail the whole tx.
	const tipCount = Array.isArray(tips) ? tips.length : 0;
	const ixs = [
		ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 + tipCount * 40_000 }),
		ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
	];
	if (!(await ataExists(conn, receiverAta))) {
		ixs.push(
			createAssociatedTokenAccountIdempotentInstruction(
				feePayer,
				receiverAta,
				payTo,
				mint,
				TOKEN_PROGRAM_ID,
				ASSOCIATED_TOKEN_PROGRAM_ID,
			),
		);
	}
	ixs.push(
		createTransferCheckedInstruction(
			senderAta,
			mint,
			receiverAta,
			buyerPubkey,
			amount,
			decimals,
			[],
			TOKEN_PROGRAM_ID,
		),
	);

	// Buyer-approved donations (charity + round-up). Each becomes an extra
	// transferChecked of the same mint to the cause's ATA, signed by the buyer in
	// the same transaction. Validate the destination, bound the amount, and dedupe
	// against the merchant's own payout so a tip can never silently inflate it.
	if (Array.isArray(tips) && tips.length) {
		for (const tip of tips) {
			const v = validateTip(tip, { payTo, paymentAmount: amount });
			if (v.skip) continue; // zero/negative amount, nothing to send
			if (!v.ok) return error(res, 400, v.code, v.message);
			const tipAta = getAssociatedTokenAddressSync(mint, v.to, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
			if (!(await ataExists(conn, tipAta))) {
				ixs.push(
					createAssociatedTokenAccountIdempotentInstruction(feePayer, tipAta, v.to, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
				);
			}
			ixs.push(
				createTransferCheckedInstruction(senderAta, mint, tipAta, buyerPubkey, v.amount, decimals, [], TOKEN_PROGRAM_ID),
			);
		}
	}

	const blockhash = await getRecentBlockhash(conn, rpc);
	const message = new TransactionMessage({
		payerKey: feePayer,
		recentBlockhash: blockhash,
		instructions: ixs,
	}).compileToV0Message();
	const vtx = new VersionedTransaction(message);

	const txBase64 = Buffer.from(vtx.serialize()).toString('base64');
	return json(res, 200, {
		network: accept.network,
		tx_base64: txBase64,
		recent_blockhash: blockhash,
	});
}

async function handleEncode(req, res) {
	// Per-IP rate limit — same anonymous, cross-origin surface as prepare.
	const rl = await limits.x402PayIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many encode requests');

	const body = parse(encodeSchema, await readJson(req));
	const { accept, signed_tx_base64, resource_url, builder_code } = body;

	// Defense-in-depth: verify the signed transaction actually pays the declared
	// amount to the declared recipient before wrapping it into the X-PAYMENT
	// header. The downstream facilitator /verify also checks, but a bad tx caught
	// here gives the user a clear error before the payment even hits the wire.
	if (accept.asset && accept.payTo && accept.amount) {
		const check = confirmSolanaPayment({
			paymentPayload: { payload: { transaction: signed_tx_base64 } },
			requirement: { asset: accept.asset, payTo: accept.payTo, amount: accept.amount },
		});
		if (check.confirmed === false) {
			return error(res, 400, 'invalid_payment', check.reason || 'transaction does not meet payment requirements');
		}
		// confirmSolanaPayment is deliberately conservative: anything it cannot
		// decode comes back `inconclusive` so a parsing quirk never rejects a real
		// payment. One inconclusive reason is not a quirk though: a blob that does
		// not deserialize into a transaction at all can never settle anywhere, and
		// wrapping it into an X-PAYMENT header only moves the failure to the
		// facilitator, where the buyer sees an opaque error after "Sending…"
		// instead of a clear one at the step that produced the bad signature.
		if (check.reason === 'undeserializable_transaction') {
			return error(res, 400, 'invalid_payment', 'signed_tx_base64 is not a decodable Solana transaction');
		}
	}

	const payload = {
		x402Version: 2,
		scheme: 'exact',
		network: accept.network,
		resource: { url: resource_url, mimeType: 'application/json' },
		accepted: accept,
		payload: { transaction: signed_tx_base64 },
	};
	if (builder_code) {
		payload.extensions = { 'builder-code': builder_code };
	}
	const xPayment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
	return json(res, 200, { x_payment: xPayment });
}
