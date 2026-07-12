// api/_lib/x402/self-facilitator.js
//
// three.ws SELF-HOSTED x402 facilitator — Solana verify + settle, fully in-house.
//
// Why this exists: the default settle path delegates to an EXTERNAL facilitator
// (PayAI) that co-signs the fee-payer and broadcasts. For the closed-loop
// agent-to-agent economy the platform runs against its OWN endpoints, we do not
// want any third party touching settlement or holding the sponsor key. This
// module IS the facilitator: it validates the buyer-signed Solana USDC transfer,
// co-signs it with OUR fee-payer key, broadcasts it over OUR RPC, and records the
// exact SOL fee burned. Point X402_FACILITATOR_URL_SOLANA at /api/x402-facilitator
// and no money, metadata, or signing authority ever leaves three.ws.
//
// SECURITY — the co-signing drain vector. The fee payer signs the WHOLE
// transaction, so a naive facilitator that blind-signs whatever /settle receives
// would let anyone drain the sponsor's SOL (submit a tx that SystemProgram-
// transfers the fee payer's lamports out, or sets an enormous priority fee).
// Defense: validateRingTransaction() refuses to co-sign anything whose program
// set is not EXACTLY {ComputeBudget, optional ATA-create for OUR recipient, one
// USDC TransferChecked to an allowlisted payTo}. No System instructions, capped
// compute-unit price, recipient must be a platform-controlled wallet. That single
// gate enforces BOTH "only our wallets settle here" and "the sponsor can't be
// drained".

import bs58 from 'bs58';
import { PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync,
	TOKEN_PROGRAM_ID,
	ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

import { env } from '../env.js';
import { solanaConnection } from '../solana/connection.js';

const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey(
	'ComputeBudget111111111111111111111111111111',
);
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

// SPL Token instruction tag for TransferChecked. Plain Transfer (3) is rejected —
// TransferChecked commits the mint + decimals, so we can trust the decoded mint.
const SPL_TRANSFER_CHECKED = 12;
// ComputeBudget instruction tags.
const CB_SET_UNIT_LIMIT = 2;
const CB_SET_UNIT_PRICE = 3;

// Fee-drain guards. A malicious priority fee is paid by the SPONSOR, so cap it.
// The honest ring builder (pay.js) uses ≤1001 µlamports × 60k CU ≈ 60 lamports;
// these ceilings sit far above that but bound any adversarial submission.
const MAX_CU_LIMIT = Number(process.env.X402_SELF_FAC_MAX_CU_LIMIT || 300_000);
const MAX_CU_PRICE_MICROLAMPORTS = Number(
	process.env.X402_SELF_FAC_MAX_CU_PRICE || 100_000,
);
const MAX_PRIORITY_LAMPORTS = Number(
	process.env.X402_SELF_FAC_MAX_PRIORITY_LAMPORTS || 20_000,
);
// Rent an idempotent ATA-create locks on the sponsor for a NEW recipient token
// account (~0.00204 SOL). Reclaimable by closing the ATA. Bounded, one-time.
const ATA_RENT_LAMPORTS = 2_039_280;

export const SELF_FACILITATOR_ENABLED =
	String(process.env.X402_SELF_FACILITATOR_ENABLED || '').toLowerCase() === 'true';

// Sponsor SOL floor — the hard stop that keeps the loop from draining our SOL.
// Below this the facilitator refuses to settle (returns success:false), which
// pauses the paying loop until the sponsor is topped up. Default 0.02 SOL.
export const SPONSOR_SOL_FLOOR_LAMPORTS = Number(
	process.env.X402_SPONSOR_SOL_FLOOR_LAMPORTS || 20_000_000,
);

let _feePayerCache = null;
// Load the sponsor (fee-payer) keypair the facilitator co-signs with. Its public
// key MUST equal env.X402_FEE_PAYER_SOLANA (the address the 402 challenge
// advertises) or endpoints would advertise a fee payer we cannot actually sign.
export function loadFeePayerKeypair() {
	if (_feePayerCache) return _feePayerCache;
	const b58 = process.env.X402_FEE_PAYER_SECRET_BASE58;
	if (!b58) {
		throw new Error(
			'self-facilitator: X402_FEE_PAYER_SECRET_BASE58 not set (the sponsor key that co-signs + pays SOL)',
		);
	}
	const raw = bs58.decode(b58);
	if (raw.length !== 64) {
		throw new Error(`self-facilitator: fee-payer key expected 64 bytes, got ${raw.length}`);
	}
	const kp = Keypair.fromSecretKey(raw);
	const advertised = env.X402_FEE_PAYER_SOLANA;
	if (advertised && kp.publicKey.toBase58() !== advertised) {
		throw new Error(
			`self-facilitator: fee-payer secret pubkey ${kp.publicKey.toBase58()} != advertised X402_FEE_PAYER_SOLANA ${advertised}`,
		);
	}
	_feePayerCache = kp;
	return kp;
}

// The set of recipient (payTo) addresses this facilitator will settle to. ONLY
// platform-controlled wallets belong here — that is what keeps every settled
// dollar inside three.ws. Defaults to X402_PAY_TO_SOLANA; add ring treasuries via
// X402_SELF_FACILITATOR_PAYTO_ALLOWLIST (comma-separated).
export function payToAllowlist() {
	const out = new Set();
	if (env.X402_PAY_TO_SOLANA) out.add(env.X402_PAY_TO_SOLANA);
	const extra = String(process.env.X402_SELF_FACILITATOR_PAYTO_ALLOWLIST || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	for (const a of extra) out.add(a);
	return out;
}

function readU32LE(data, offset) {
	return (
		data[offset] |
		(data[offset + 1] << 8) |
		(data[offset + 2] << 16) |
		(data[offset + 3] << 24)
	) >>> 0;
}

function readU64LE(data, offset) {
	let v = 0n;
	for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[offset + i]);
	return v;
}

// Decode + STRICTLY validate a buyer-signed ring payment transaction. Returns
// { ok:true, decoded } when it is a clean single-USDC-transfer to an allowlisted
// recipient with a bounded sponsor fee, or { ok:false, reason } otherwise. Never
// throws on adversarial input — a bad tx is a clean refusal, not a 5xx.
export function validateRingTransaction({ txBase64, requirement, feePayerPubkey, allowlist }) {
	let tx;
	try {
		tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
	} catch (err) {
		return { ok: false, reason: `deserialize_failed:${err.message}` };
	}
	const msg = tx.message;

	// Address-table lookups would hide accounts we can't statically resolve.
	// The ring builder never uses them; reject to keep validation total.
	if (msg.addressTableLookups && msg.addressTableLookups.length > 0) {
		return { ok: false, reason: 'address_table_lookups_forbidden' };
	}

	const keys = msg.staticAccountKeys;
	if (!keys || keys.length === 0) return { ok: false, reason: 'no_account_keys' };

	// Every account index in a (possibly adversarial) compiled instruction must
	// resolve to a real static key. An out-of-range index would dereference
	// undefined and throw a TypeError, breaking the "never throws" contract this
	// facilitator's security model relies on — treat any bad index as a refusal.
	const idxInRange = (i) => Number.isInteger(i) && i >= 0 && i < keys.length;

	// Fee payer is always account index 0. Whether it must equal the configured
	// sponsor (sponsor mode) or may be the buyer itself (self-pay, 1 signature) is
	// decided AFTER we learn the transfer authority below.
	const feePayer = keys[0];

	const mint = new PublicKey(requirement.asset);
	const requiredAmount = BigInt(requirement.amount);
	const payTo = new PublicKey(requirement.payTo);

	if (!allowlist.has(payTo.toBase58())) {
		return { ok: false, reason: `pay_to_not_allowlisted:${payTo.toBase58()}` };
	}

	const expectedReceiverAta = getAssociatedTokenAddressSync(
		mint, payTo, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
	);

	let transferCount = 0;
	let payer = null;
	let transferAmount = 0n;
	let cuLimit = 200_000; // Solana default when unset
	let cuPrice = 0n;
	let ataCreatePresent = false;

	const ixs = msg.compiledInstructions;
	try {
	for (const ix of ixs) {
		if (!idxInRange(ix.programIdIndex)) {
			return { ok: false, reason: 'malformed_instruction' };
		}
		const programId = keys[ix.programIdIndex];
		const data = ix.data; // Uint8Array
		const accts = ix.accountKeyIndexes;

		if (programId.equals(SYSTEM_PROGRAM_ID)) {
			// A top-level System instruction could move the sponsor's SOL. Never allow.
			return { ok: false, reason: 'system_instruction_forbidden' };
		}

		if (programId.equals(COMPUTE_BUDGET_PROGRAM_ID)) {
			const tag = data[0];
			if (tag === CB_SET_UNIT_LIMIT) {
				cuLimit = readU32LE(data, 1);
			} else if (tag === CB_SET_UNIT_PRICE) {
				cuPrice = readU64LE(data, 1);
			}
			// Other compute-budget tags carry no fund movement; ignore.
			continue;
		}

		if (programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
			// Only permit creating OUR recipient's ATA, funded by the sponsor.
			// Accounts: [funder, ata, owner, mint, systemProgram, tokenProgram].
			if (accts.length < 4 || !accts.slice(0, 4).every(idxInRange)) {
				return { ok: false, reason: 'malformed_instruction' };
			}
			const funder = keys[accts[0]];
			const ata = keys[accts[1]];
			const owner = keys[accts[2]];
			const ixMint = keys[accts[3]];
			if (!ata.equals(expectedReceiverAta)) {
				return { ok: false, reason: 'ata_create_wrong_account' };
			}
			if (!owner.equals(payTo)) return { ok: false, reason: 'ata_create_wrong_owner' };
			if (!ixMint.equals(mint)) return { ok: false, reason: 'ata_create_wrong_mint' };
			if (!funder.equals(feePayer)) return { ok: false, reason: 'ata_create_wrong_funder' };
			ataCreatePresent = true;
			continue;
		}

		if (programId.equals(TOKEN_PROGRAM_ID)) {
			// The ONLY value-moving instruction we permit: one TransferChecked of
			// the required USDC from the buyer to OUR recipient ATA.
			// Accounts: [source, mint, destination, authority].
			if (data[0] !== SPL_TRANSFER_CHECKED) {
				return { ok: false, reason: `token_ix_not_transfer_checked:${data[0]}` };
			}
			transferCount += 1;
			if (transferCount > 1) return { ok: false, reason: 'multiple_transfers' };

			const source = keys[accts[0]];
			const ixMint = keys[accts[1]];
			const dest = keys[accts[2]];
			const authority = keys[accts[3]];

			if (!ixMint.equals(mint)) return { ok: false, reason: 'transfer_wrong_mint' };
			if (!dest.equals(expectedReceiverAta)) {
				return { ok: false, reason: 'transfer_wrong_destination' };
			}
			// The buyer (authority) must own the source ATA and must be a signer.
			const expectedSource = getAssociatedTokenAddressSync(
				mint, authority, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
			);
			if (!source.equals(expectedSource)) {
				return { ok: false, reason: 'transfer_source_not_authority_ata' };
			}
			// authority must be a required signer (index < numRequiredSignatures).
			const authIndex = accts[3];
			if (authIndex >= msg.header.numRequiredSignatures) {
				return { ok: false, reason: 'authority_not_signer' };
			}

			// TransferChecked data: [12, u64 amount, u8 decimals].
			transferAmount = readU64LE(data, 1);
			payer = authority.toBase58();
			continue;
		}

		// Any other program touching this transaction is disallowed.
		return { ok: false, reason: `program_not_allowed:${programId.toBase58()}` };
	}

	if (transferCount !== 1) return { ok: false, reason: 'no_usdc_transfer' };
	if (payer == null) return { ok: false, reason: 'no_authority' };
	if (transferAmount < requiredAmount) {
		return {
			ok: false,
			reason: `amount_below_required:${transferAmount}<${requiredAmount}`,
		};
	}

	// Self-pay vs sponsor mode. Self-pay: the buyer pays its own SOL fee (fee payer
	// == the USDC authority) → 1 signature, no sponsor, cheapest. Sponsor mode: the
	// fee payer must be the configured sponsor. Either way the sponsor can never be
	// coerced into spending USDC: in sponsor mode fee payer ≠ authority (this
	// branch), and self-pay only lets the buyer spend its own funds.
	const selfPay = feePayer.toBase58() === payer;
	if (!selfPay) {
		if (!feePayerPubkey || feePayer.toBase58() !== feePayerPubkey) {
			return { ok: false, reason: `fee_payer_not_sponsor:${feePayer.toBase58()}` };
		}
	}

	// Bound the priority fee the fee-paying wallet will pay.
	if (cuLimit > MAX_CU_LIMIT) return { ok: false, reason: `cu_limit_too_high:${cuLimit}` };
	if (cuPrice > BigInt(MAX_CU_PRICE_MICROLAMPORTS)) {
		return { ok: false, reason: `cu_price_too_high:${cuPrice}` };
	}
	const priorityLamports = Number((cuPrice * BigInt(cuLimit)) / 1_000_000n);
	if (priorityLamports > MAX_PRIORITY_LAMPORTS) {
		return { ok: false, reason: `priority_fee_too_high:${priorityLamports}` };
	}

	const baseFee = 5000 * msg.header.numRequiredSignatures;
	const estFeeLamports = baseFee + priorityLamports + (ataCreatePresent ? ATA_RENT_LAMPORTS : 0);

	return {
		ok: true,
		decoded: {
			tx,
			payer,
			payTo: payTo.toBase58(),
			mint: mint.toBase58(),
			amountAtomic: Number(transferAmount),
			feePayer: feePayer.toBase58(),
			selfPay,
			estFeeLamports,
			ataCreatePresent,
		},
	};
}

// Extract the base64 signed transaction from an x402 payment payload.
export function txBase64FromPayload(paymentPayload) {
	return (
		paymentPayload?.payload?.transaction ||
		paymentPayload?.transaction ||
		null
	);
}

// ── Sponsor SOL guard ────────────────────────────────────────────────────────
// Cache the sponsor SOL balance briefly so a high-throughput settle stream does
// not hit getBalance on every payment. The floor check is the hard stop that
// keeps the loop from ever draining our SOL: below the floor, settle refuses and
// the paying loop stalls until the sponsor is topped up.
const _solCache = new Map(); // pubkeyB58 → { lamports, at }
const SOL_CACHE_MS = 20_000;

export async function sponsorSolLamports(conn, feePayerPubkey, now = Date.now()) {
	const key = feePayerPubkey.toBase58();
	const hit = _solCache.get(key);
	if (hit && hit.lamports != null && now - hit.at < SOL_CACHE_MS) return hit.lamports;
	const lamports = await conn.getBalance(feePayerPubkey, 'confirmed');
	_solCache.set(key, { lamports, at: now });
	return lamports;
}

// Debit the cache right after a settle so the next check sees the balance
// approaching the floor without another RPC round-trip.
function bumpSolCache(pubkeyB58, deltaLamports) {
	const hit = _solCache.get(pubkeyB58);
	if (hit && hit.lamports != null) hit.lamports = Math.max(0, hit.lamports - deltaLamports);
}

async function confirmSignature(conn, signature, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const { value } = await conn.getSignatureStatuses([signature]);
		const st = value?.[0];
		if (st) {
			if (st.err) return { confirmed: false, err: JSON.stringify(st.err) };
			if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') {
				return { confirmed: true };
			}
		}
		if (Date.now() > deadline) return { confirmed: false, err: 'confirm_timeout' };
		await new Promise((r) => setTimeout(r, 1200));
	}
}

// Settle a validated ring payment: co-sign with the sponsor, broadcast over our
// RPC, confirm. Returns the x402-wire settle shape { success, transaction,
// network, payer } plus feeLamports for the burn meter. Never throws for a
// rejected payment — a refusal is a clean { success:false, reason }.
export async function settleRingPayment({ paymentPayload, requirement, conn, feePayer }) {
	const network = requirement.network;
	const connection = conn || solanaConnection({ url: env.SOLANA_RPC_URL, commitment: 'confirmed' });

	const txBase64 = txBase64FromPayload(paymentPayload);
	if (!txBase64) return { success: false, reason: 'missing_transaction' };

	// The sponsor pubkey only authorizes SPONSOR-mode payments; a self-pay tx
	// carries its own fee payer and needs no sponsor key at all.
	const sponsorPubkey = feePayer?.publicKey?.toBase58() || env.X402_FEE_PAYER_SOLANA || null;
	const validation = validateRingTransaction({
		txBase64,
		requirement,
		feePayerPubkey: sponsorPubkey,
		allowlist: payToAllowlist(),
	});
	if (!validation.ok) return { success: false, reason: validation.reason };
	const decoded = validation.decoded;
	const { tx, payer, estFeeLamports, selfPay } = decoded;

	// Hard stop: never settle if the fee-paying wallet is below its SOL floor.
	// Self-pay → the payer pays its own fee; sponsor mode → the sponsor pays.
	const feeWallet = new PublicKey(decoded.feePayer);
	const solLamports = await sponsorSolLamports(connection, feeWallet);
	if (solLamports < SPONSOR_SOL_FLOOR_LAMPORTS) {
		return {
			success: false,
			reason: `fee_wallet_below_floor:${solLamports}<${SPONSOR_SOL_FLOOR_LAMPORTS}`,
			sponsorSolLamports: solLamports,
		};
	}

	// Sponsor mode co-signs the fee payer (buyer already signed); a self-pay tx is
	// already fully signed and just needs broadcasting.
	if (!selfPay) {
		let sponsor;
		try {
			sponsor = feePayer || loadFeePayerKeypair();
		} catch (err) {
			return { success: false, reason: `sponsor_key_unconfigured:${err.message}` };
		}
		try {
			tx.sign([sponsor]);
		} catch (err) {
			return { success: false, reason: `cosign_failed:${err.message}` };
		}
	}

	let signature;
	try {
		signature = await connection.sendRawTransaction(tx.serialize(), {
			skipPreflight: false,
			maxRetries: 5,
		});
	} catch (err) {
		const m = String(err?.message || err);
		// A resent settle (idempotent replay) hits "already processed" — the prior
		// broadcast landed. Recover the signature from the tx and report success.
		if (/already been processed|AlreadyProcessed|already processed/i.test(m)) {
			const sig = tx.signatures?.[0] ? bs58.encode(tx.signatures[0]) : null;
			if (sig) {
				return {
					success: true,
					transaction: sig,
					network,
					payer,
					feeLamports: estFeeLamports,
					replayed: true,
				};
			}
		}
		return { success: false, reason: `broadcast_failed:${m}`.slice(0, 300) };
	}

	const conf = await confirmSignature(connection, signature);
	if (!conf.confirmed) {
		return { success: false, reason: `not_confirmed:${conf.err}`, transaction: signature };
	}

	bumpSolCache(feeWallet.toBase58(), estFeeLamports);

	// Best-effort: read the real network fee for accurate burn accounting.
	let feeLamports = estFeeLamports;
	try {
		const parsed = await connection.getParsedTransaction(signature, {
			maxSupportedTransactionVersion: 0,
			commitment: 'confirmed',
		});
		if (parsed?.meta?.fee != null) {
			feeLamports = parsed.meta.fee + (decoded.ataCreatePresent ? ATA_RENT_LAMPORTS : 0);
		}
	} catch { /* estimate stands */ }

	return { success: true, transaction: signature, network, payer, feeLamports };
}

// Verify shape for /verify — validate without broadcasting.
export function verifyRingPayment({ paymentPayload, requirement, feePayerPubkey }) {
	const txBase64 = txBase64FromPayload(paymentPayload);
	if (!txBase64) return { isValid: false, invalidReason: 'missing_transaction' };
	const validation = validateRingTransaction({
		txBase64,
		requirement,
		feePayerPubkey: feePayerPubkey || (env.X402_FEE_PAYER_SOLANA || null),
		allowlist: payToAllowlist(),
	});
	if (!validation.ok) return { isValid: false, invalidReason: validation.reason };
	return {
		isValid: true,
		network: requirement.network,
		asset: validation.decoded.mint,
		payer: validation.decoded.payer,
	};
}
