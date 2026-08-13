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
// SPL Memo, both live program ids. The reference x402 SVM client (@x402/svm,
// which our own buildSolanaExactPayload delegates to) attaches a memo to every
// `exact` payment it builds, so a facilitator that rejects memos cannot settle
// a payment built by the standard client at all. Memo writes to the transaction
// log and owns no accounts: it cannot move a lamport or a token, which is why it
// is skipped here the same way a ComputeBudget instruction is. Its compute cost
// still counts against the CU/fee ceiling enforced below.
const MEMO_PROGRAM_IDS = [
	new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
	new PublicKey('Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo'),
];

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

// Minimum atomic amount (USDC, 6-decimals) a SPONSOR-mode settle must move. Each
// sponsor co-sign burns ~5000 lamports (≈0.001 USDC) of our SOL, so settling a
// 1-atomic dust transfer is a pure fee-burn grief: the attacker donates a
// sub-fee amount while we pay to broadcast it. Requiring the settle to at least
// cover its own base fee means a settle can never be net-negative for the
// platform. Default 1000 atomic = $0.001; raise via env if micro-tips aren't a
// concern. Self-pay settles pay their own fee, so this floor does not apply.
export const MIN_SPONSOR_SETTLE_ATOMIC = Math.max(
	0,
	Number(process.env.X402_SELF_FAC_MIN_SETTLE_ATOMIC || 1000),
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

	// The mint must be one the platform actually issues 402s for (USDC, plus
	// $THREE when configured). The requirement is caller-supplied: without
	// this pin a junk mint passes every check below — including the
	// sponsor-funded ATA create — so each call would burn sponsor ATA rent +
	// fees settling a worthless transfer, repeatable per fresh mint. Fail
	// closed when no settleable mint is configured at all.
	const settleableMints = [env.X402_ASSET_MINT_SOLANA, env.THREE_TOKEN_MINT].filter(Boolean);
	if (!settleableMints.includes(mint.toBase58())) {
		return { ok: false, reason: `mint_not_settleable:${mint.toBase58()}` };
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

		if (MEMO_PROGRAM_IDS.some((id) => programId.equals(id))) {
			// Carries no fund movement (see MEMO_PROGRAM_IDS). Skipped, not counted.
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

			// Accounts: [source, mint, destination, authority].
			if (accts.length < 4 || !accts.slice(0, 4).every(idxInRange)) {
				return { ok: false, reason: 'malformed_instruction' };
			}
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
	} catch (err) {
		// Totality backstop: any unexpected throw while decoding adversarial
		// instruction bytes becomes a clean refusal, never a 5xx.
		return { ok: false, reason: `decode_error:${err?.message || err}` };
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

// Last observed floor state, readable synchronously. buildRequirements (the
// 402 challenge builder) is sync and hot, so it cannot await a balance read,
// but it CAN consult what the settle path most recently observed and stop
// advertising a Solana accept that is guaranteed to die at settle. Validity is
// deliberately longer than the balance cache: during a dry spell settles keep
// probing (refreshing this), and 60s of staleness only delays re-advertising
// by less than the treasury-topup cadence that refunds the wallet.
const FLOOR_STATE_MS = 60_000;
let _floorState = { below: false, at: 0 };

export function sponsorKnownBelowFloor(now = Date.now()) {
	return _floorState.below && now - _floorState.at < FLOOR_STATE_MS;
}

function noteFloorState(lamports, now) {
	_floorState = { below: lamports < SPONSOR_SOL_FLOOR_LAMPORTS, at: now };
}

// Keep the floor state warm on instances that never settle.
//
// The state above is per-process and was only written by the settle path, so a
// Cloud Run instance serving nothing but 402 challenges never learned the
// sponsor was dry and kept advertising a Solana accept that could not settle.
// Callers on the challenge path invoke this WITHOUT awaiting: it refreshes at
// most once per SOL_CACHE_MS per instance, swallows every error (an RPC blip
// must never affect a challenge), and leaves the state untouched on failure so
// the fail-open default stands. First request after a cold start still
// advertises Solana; every request after it is accurate.
let _floorRefreshInFlight = null;

export function refreshSponsorFloorState(now = Date.now()) {
	const pubkey = env.X402_FEE_PAYER_SOLANA;
	if (!pubkey) return;
	if (_floorRefreshInFlight) return;
	const hit = _solCache.get(pubkey);
	if (hit && hit.lamports != null && now - hit.at < SOL_CACHE_MS) return;

	_floorRefreshInFlight = (async () => {
		try {
			const conn = solanaConnection({ url: env.SOLANA_RPC_URL, commitment: 'confirmed' });
			const lamports = await conn.getBalance(new PublicKey(pubkey), 'confirmed');
			_solCache.set(pubkey, { lamports, at: Date.now() });
			noteFloorState(lamports, Date.now());
		} catch {
			/* RPC unreachable: keep the last known state, fail open */
		} finally {
			_floorRefreshInFlight = null;
		}
	})();
}

export async function sponsorSolLamports(conn, feePayerPubkey, now = Date.now()) {
	const key = feePayerPubkey.toBase58();
	const hit = _solCache.get(key);
	if (hit && hit.lamports != null && now - hit.at < SOL_CACHE_MS) return hit.lamports;
	const lamports = await conn.getBalance(feePayerPubkey, 'confirmed');
	_solCache.set(key, { lamports, at: now });
	noteFloorState(lamports, now);
	return lamports;
}

// Debit the cache right after a settle so the next check sees the balance
// approaching the floor without another RPC round-trip.
function bumpSolCache(pubkeyB58, deltaLamports) {
	const hit = _solCache.get(pubkeyB58);
	if (hit && hit.lamports != null) {
		hit.lamports = Math.max(0, hit.lamports - deltaLamports);
		noteFloorState(hit.lamports, Date.now());
	}
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
// network, payer } plus feeLamports for the burn meter and feePayer/selfPay for
// per-wallet fee attribution. Never throws for a rejected payment — a refusal
// is a clean { success:false, reason }.
//
// `feeMeter` is the optional wallet fee governor hook (wallet-fee-meter.js):
// called after the hard SOL floor passes, with the wallet that will actually
// pay this transaction's fee. A { ok:false } verdict refuses the settle before
// any co-sign/broadcast; a hook error fails OPEN — the floor is the hard
// protection, the meter is pacing.
export async function settleRingPayment({ paymentPayload, requirement, conn, feePayer, feeMeter }) {
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

	// Anti fee-burn: a sponsor-mode settle must move at least enough to cover the
	// SOL fee we're about to burn co-signing it. Blocks the dust-transfer grief
	// (1-atomic allowlisted transfers spammed to pump down sponsor SOL). Self-pay
	// settles pay their own fee, so a dust self-pay costs us nothing — exempt them.
	if (!selfPay && decoded.amountAtomic < MIN_SPONSOR_SETTLE_ATOMIC) {
		return {
			success: false,
			reason: `amount_below_min_settle:${decoded.amountAtomic}<${MIN_SPONSOR_SETTLE_ATOMIC}`,
		};
	}

	// Hard stop: never settle if the fee-paying wallet is below its SOL floor.
	// Self-pay → the payer pays its own fee; sponsor mode → the sponsor pays.
	const feeWallet = new PublicKey(decoded.feePayer);
	const solLamports = await sponsorSolLamports(connection, feeWallet);
	if (solLamports < SPONSOR_SOL_FLOOR_LAMPORTS) {
		return {
			success: false,
			reason: `fee_wallet_below_floor:${solLamports}<${SPONSOR_SOL_FLOOR_LAMPORTS}`,
			sponsorSolLamports: solLamports,
			feePayer: decoded.feePayer,
			selfPay,
		};
	}

	// Wallet fee governor: admit this settle only if the fee-paying wallet still
	// has daily fee budget. Governs every tenant of a shared wallet at the one
	// choke point they all pass through, instead of throttling one pipeline while
	// the others drain the same runway.
	if (feeMeter) {
		let meterVerdict = null;
		try {
			meterVerdict = await feeMeter({
				feeWalletB58: decoded.feePayer,
				solLamports,
				estFeeLamports,
				selfPay,
			});
		} catch { /* meter fault → fail open; the SOL floor above is the hard stop */ }
		if (meterVerdict && meterVerdict.ok === false) {
			return {
				success: false,
				reason: meterVerdict.reason || 'fee_runway_exhausted',
				sponsorSolLamports: solLamports,
				feePayer: decoded.feePayer,
				selfPay,
			};
		}
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
	// Set only when the preflight-off resend below is attempted and also fails, so
	// the reported reason distinguishes "our read node was stale" from "the payment
	// was genuinely unsendable".
	let preflightRetryNote = '';
	try {
		signature = await connection.sendRawTransaction(tx.serialize(), {
			skipPreflight: false,
			maxRetries: 5,
		});
	} catch (err) {
		const m = String(err?.message || err);
		const sig = tx.signatures?.[0] ? bs58.encode(tx.signatures[0]) : null;
		// A resent settle (idempotent replay) hits "already processed" — the prior
		// broadcast landed. Recover the signature from the tx and report success.
		if (/already been processed|AlreadyProcessed|already processed/i.test(m)) {
			if (sig) {
				return {
					success: true,
					transaction: sig,
					network,
					payer,
					feeLamports: estFeeLamports,
					feePayer: decoded.feePayer,
					selfPay,
					replayed: true,
				};
			}
		}
		// web3.js drops the structured preflight cause (res.error.data.err), so on
		// some RPCs a duplicate-signature rejection arrives as a bare "Transaction
		// simulation failed" with empty logs — including our own maxRetries resend
		// racing the first landing. Probe the signature: if it already landed with no
		// error, this IS this payment's settlement, not a stranger's. The x402
		// authorization is single-use (payment-identifier-server.js reserves a SHA-256
		// lock on the signed X-PAYMENT before settle, and the on-chain nonce is consumed
		// on first settle), so no other payment can reproduce this exact signature.
		// Failing closed here 502'd payments that had actually settled — the dominant
		// settle_failed wave. Recover success identically to the message-matched
		// idempotent-replay branch above; the buyer is owed the product, not a 502.
		// Only a blockhash rejection proves the transaction never reached a validator.
		// Every other failure leaves its fate UNKNOWN — including an RPC whose reply
		// web3.js could not even parse ("Expected the value to satisfy a union of
		// `type | type`", seen when a fallback endpoint answers in a non-standard
		// shape). That class skipped the probe entirely and reported failure on a
		// payment that may well have settled, so probe on everything except the one
		// provably-never-landed case.
		const provablyNeverLanded = /blockhash not found/i.test(m);
		let alreadyLanded = false;
		if (sig && !provablyNeverLanded) {
			try {
				// searchTransactionHistory so a tx that landed a moment earlier and aged
				// out of the recent-status cache is still found — else the probe returns
				// null and we wrongly fail a settled payment.
				const st = (await connection.getSignatureStatuses([sig], { searchTransactionHistory: true }))
					?.value?.[0];
				alreadyLanded = st != null && st.err == null;
			} catch { /* probe is best-effort; the generic reason below stands */ }
		}
		if (alreadyLanded) {
			return {
				success: true,
				transaction: sig,
				network,
				payer,
				feeLamports: estFeeLamports,
				feePayer: decoded.feePayer,
				selfPay,
				replayed: true,
			};
		}
		// A preflight "blockhash not found" is usually a FALSE rejection, not a dead
		// transaction. The buyer builds and signs the payment against THEIR RPC, so the
		// blockhash it carries is real; we then preflight it on whichever node our
		// rotating pool happens to answer with, and a node lagging even a few slots
		// behind the buyer's has simply never seen that hash. web3.js surfaces that as a
		// hard send failure, so a perfectly valid payment was reported broadcast_failed
		// and the buyer 502'd having already been charged for the handler.
		// Re-sending with preflight OFF hands the decision to the validator instead of
		// our read node: if the hash is live the settle lands, and if it genuinely
		// expired the transaction is dropped without landing and without a fee, so the
		// only cost is the confirm wait below. Resending the identical signed bytes is
		// idempotent (Solana dedupes by signature), so this cannot double-settle.
		if (provablyNeverLanded) {
			try {
				signature = await connection.sendRawTransaction(tx.serialize(), {
					skipPreflight: true,
					maxRetries: 5,
				});
			} catch (retryErr) {
				preflightRetryNote = ` preflight_retry_failed:${String(retryErr?.message || retryErr).slice(0, 120)}`;
			}
		}
		// Only report a broadcast failure if the preflight-off resend above did not
		// produce a signature; otherwise fall through to the confirm step below.
		if (signature == null) {
			// The dominant broadcast failure reaches production logs with NO cause at all:
			// web3.js renders the preflight rejection as "Transaction simulation failed.
			// Logs: []" and drops the structured cause (res.error.data.err), while its own
			// getLogs() only reads back a LANDED transaction, useless for a tx that never
			// landed. Re-simulate on the failure path to recover that cause. Deliberately
			// replaceRecentBlockhash:false, unlike the assertSettleable pre-check: the point
			// is to see whether the blockhash this send actually carried was unknown to the
			// endpoint that answered, which is how a rotating multi-RPC pool fails when the
			// hash is fetched from one node and the send lands on another.
			let cause = '';
			if (!/Logs: \[[^\]]/.test(m)) {
				try {
					const sim = await connection.simulateTransaction(tx, {
						sigVerify: false,
						replaceRecentBlockhash: false,
						commitment: 'confirmed',
					});
					const simErr = sim?.value?.err ?? null;
					const simLogs = Array.isArray(sim?.value?.logs) ? sim.value.logs : [];
					if (simErr) {
						cause = ` cause:${typeof simErr === 'object' ? JSON.stringify(simErr) : String(simErr)}`;
					} else {
						// The re-simulation came back CLEAN: this transaction is valid, and the
						// node that answered the send rejected it anyway. Left unmarked this was
						// the worst log line in the settle path, a "Logs: []" failure with no
						// cause appended, indistinguishable from "the cause probe found nothing"
						// and from a real program error. It names the actual condition instead:
						// our rotating pool asked one node to preflight a transaction another
						// node's blockhash built, which is the expected failure shape while the
						// paid RPC tier is exhausted and traffic is riding throttled free nodes.
						cause = ' cause:resim_clean_preflight_false_negative';
					}
					if (simLogs.length) cause += ` logs:${simLogs.slice(-3).join(' | ')}`;
				} catch (reSimErr) {
					cause = ` cause_probe_failed:${String(reSimErr?.message || reSimErr).slice(0, 120)}`;
				}
			}
			// web3.js appends the LAST simulation-log lines to the message, so the
			// failure cause sits at the END. A head-only truncation kept only the
			// ComputeBudget preamble and hid the failing instruction from every
			// production log. Keep the head (error class) and the tail (cause).
			const detail = `${m}${cause}${preflightRetryNote}`.replace(/\s+/g, ' ').trim();
			const full = `broadcast_failed:${detail}`;
			const reason = full.length <= 480 ? full : `${full.slice(0, 200)} … ${full.slice(-276)}`;
			return { success: false, reason };
		}
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

	return {
		success: true,
		transaction: signature,
		network,
		payer,
		feeLamports,
		feePayer: decoded.feePayer,
		selfPay,
	};
}

// Prove a shape-valid payment can ACTUALLY settle before /verify returns valid.
//
// validateRingTransaction() is a static decode: it proves the tx is SHAPED right
// (amount ≥ required, correct mint/recipient/authority, bounded fee) but not that
// broadcasting it would succeed. Without this check a buyer can sign a perfectly-
// formed TransferChecked from a source ATA holding ZERO USDC — static validation
// passes, the paid flow (verify → run handler → settle) executes the expensive
// handler and pays the upstream provider, then settle reverts `insufficient funds`
// and the buyer gets a 502 having paid nothing. The platform ate the provider cost.
// This closes that deliver-before-settle drain: the handler never runs unless the
// payment can settle. The external PayAI facilitator simulates on /verify for the
// same reason; the in-house one must not be weaker.
//
// Primary check is a full simulation (sigVerify:false so the sponsor's co-signature
// isn't required yet; replaceRecentBlockhash:true so an aged blockhash isn't the
// failure) — it catches a zero/low source balance, a frozen ATA, and an unfundable
// fee payer in one RPC. If simulation itself is unavailable (RPC blip) we fall back
// to a direct source-ATA balance read so the zero-balance vector stays closed, and
// fail CLOSED only when neither can run — an unverifiable payment must never reach
// the handler.
async function assertSettleable({ tx, connection, requirement, decoded }) {
	try {
		const sim = await connection.simulateTransaction(tx, {
			sigVerify: false,
			replaceRecentBlockhash: true,
			commitment: 'confirmed',
		});
		const simErr = sim?.value?.err ?? null;
		if (simErr) {
			const s = typeof simErr === 'object' ? JSON.stringify(simErr) : String(simErr);
			return { ok: false, reason: `simulation_failed:${s}`.slice(0, 160) };
		}
		return { ok: true };
	} catch (simUnavailable) {
		// Simulation RPC unreachable — do not fail open. Read the source ATA balance
		// directly; this alone still stops a transfer signed from a zero-balance ATA.
		try {
			const mint = new PublicKey(decoded.mint);
			const authority = new PublicKey(decoded.payer);
			const sourceAta = getAssociatedTokenAddressSync(
				mint, authority, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
			);
			const bal = await connection.getTokenAccountBalance(sourceAta, 'confirmed');
			const have = BigInt(bal?.value?.amount ?? '0');
			const need = BigInt(requirement.amount);
			if (have < need) {
				return { ok: false, reason: `insufficient_source_balance:${have}<${need}` };
			}
			return { ok: true };
		} catch (balUnavailable) {
			return {
				ok: false,
				reason: `settle_precheck_unavailable:${String(
					balUnavailable?.message || simUnavailable?.message || balUnavailable,
				).slice(0, 100)}`,
			};
		}
	}
}

// Verify shape for /verify — validate statically, then prove settleability on-chain
// WITHOUT broadcasting. Async: the settleability proof is one RPC round-trip.
export async function verifyRingPayment({ paymentPayload, requirement, feePayerPubkey, conn }) {
	const txBase64 = txBase64FromPayload(paymentPayload);
	if (!txBase64) return { isValid: false, invalidReason: 'missing_transaction' };
	const validation = validateRingTransaction({
		txBase64,
		requirement,
		feePayerPubkey: feePayerPubkey || (env.X402_FEE_PAYER_SOLANA || null),
		allowlist: payToAllowlist(),
	});
	if (!validation.ok) return { isValid: false, invalidReason: validation.reason };

	const connection =
		conn || solanaConnection({ url: env.SOLANA_RPC_URL, commitment: 'confirmed' });
	const settleable = await assertSettleable({
		tx: validation.decoded.tx,
		connection,
		requirement,
		decoded: validation.decoded,
	});
	if (!settleable.ok) return { isValid: false, invalidReason: settleable.reason };

	return {
		isValid: true,
		network: requirement.network,
		asset: validation.decoded.mint,
		payer: validation.decoded.payer,
	};
}
