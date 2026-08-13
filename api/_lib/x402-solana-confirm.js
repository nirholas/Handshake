// Server-side defense-in-depth for Solana "exact" payments.
//
// The Solana x402 flow puts a fully-signed, base64-serialized transaction in
// `paymentPayload.payload.transaction`; the facilitator (PayAI) simulates it on
// /verify and co-signs + submits it on /settle. Unlike the EVM path — where the
// EIP-712 signature exposes the amount and recipient directly (decodeSignedAmount
// / decodeSignedRecipient in x402-spec.js) — the Solana amount lives inside that
// opaque transaction, so historically we trusted the facilitator entirely.
//
// This module closes that gap WITHOUT an RPC round-trip: it statically decodes
// the signed transaction and reads the SPL-Token TransferChecked instruction the
// buyer actually signed, then asserts it pays at least the required amount, in
// the required mint, to the ATA owned by our payTo. A compromised or buggy
// facilitator therefore cannot get us to deliver a resource for an underpaid or
// mis-routed Solana transfer.
//
// The check is conservative: it only returns a definitive `{ ok: false }` when
// it positively decodes a token transfer that pays us too little (or pays the
// wrong recipient/mint). Anything it can't decode (unexpected payload shape,
// non-standard instruction layout) returns `{ inconclusive: true }` and the
// caller falls back to facilitator trust — so we never reject a valid payment
// over a parsing quirk.

import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import {
	ASSOCIATED_TOKEN_PROGRAM_ID,
	TOKEN_PROGRAM_ID,
	getAssociatedTokenAddressSync,
} from '@solana/spl-token';

// SPL-Token instruction discriminators (first byte of instruction data).
const IX_TRANSFER = 3;
const IX_TRANSFER_CHECKED = 12;

// The CAIP-2 ids and the rail predicate live in x402/solana-networks.js, a leaf
// module, so x402-spec.js (which imports us) can share one definition without a
// circular import. Re-exported here because callers already import it from us.
export { isSolanaNetwork } from './x402/solana-networks.js';

// Normalize a VersionedTransaction's message into a flat list of
// { programId: PublicKey, accountKeys: PublicKey[], data: Uint8Array } so we can
// walk instructions without caring about v0-vs-legacy message internals. Returns
// null when the message can't be normalized.
function readInstructions(message) {
	const keys = message.staticAccountKeys || message.accountKeys;
	if (!Array.isArray(keys) || keys.length === 0) return null;
	const compiled = message.compiledInstructions || message.instructions;
	if (!Array.isArray(compiled)) return null;
	const out = [];
	for (const ix of compiled) {
		const programIdIndex = ix.programIdIndex;
		const accountIndexes = ix.accountKeyIndexes || ix.accounts;
		const data = ix.data;
		if (typeof programIdIndex !== 'number' || !accountIndexes) continue;
		const programId = keys[programIdIndex];
		if (!programId) continue;
		const accountKeys = [];
		for (const i of accountIndexes) {
			if (keys[i]) accountKeys.push(keys[i]);
		}
		// Legacy messages carry base58-encoded instruction data as a string; v0
		// compiled instructions carry a Uint8Array. Only the latter is parseable
		// here, and that's what our Solana builder emits.
		out.push({ programId, accountKeys, data: data instanceof Uint8Array ? data : null });
	}
	return out;
}

function readU64LE(data, offset) {
	return Buffer.from(data.buffer, data.byteOffset + offset, 8).readBigUInt64LE(0);
}

// Decode the SPL-Token transfers in a signed Solana payment transaction and sum
// the atomic amount routed to the receiver ATA owned by `payTo` for `asset`.
// Returns { ok, reason?, paidToPayTo, sawTokenTransfer }.
function decodeSolanaTransfer({ transactionBase64, asset, payTo }) {
	let tx;
	try {
		tx = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));
	} catch {
		return { inconclusive: true, reason: 'undeserializable_transaction' };
	}
	const instructions = readInstructions(tx.message);
	if (!instructions) return { inconclusive: true, reason: 'unreadable_message' };

	let mint;
	let receiverAta;
	try {
		mint = new PublicKey(asset);
		// allowOwnerOffCurve=true so a PDA payTo never throws here; for a normal
		// wallet this yields the same ATA the buyer-side builder derived.
		receiverAta = getAssociatedTokenAddressSync(
			mint,
			new PublicKey(payTo),
			true,
			TOKEN_PROGRAM_ID,
			ASSOCIATED_TOKEN_PROGRAM_ID,
		);
	} catch {
		return { inconclusive: true, reason: 'bad_asset_or_payto' };
	}
	const receiverAtaStr = receiverAta.toBase58();
	const mintStr = mint.toBase58();

	let paidToPayTo = 0n;
	let sawTokenTransfer = false;

	for (const ix of instructions) {
		if (!ix.programId.equals(TOKEN_PROGRAM_ID) || !ix.data || ix.data.length < 1) continue;
		const kind = ix.data[0];

		if (kind === IX_TRANSFER_CHECKED) {
			// accounts: [source, mint, destination, owner, ...signers]
			// data: [12, amount(u64 LE), decimals(u8)]
			if (ix.accountKeys.length < 3 || ix.data.length < 10) continue;
			sawTokenTransfer = true;
			const ixMint = ix.accountKeys[1].toBase58();
			const ixDest = ix.accountKeys[2].toBase58();
			if (ixDest === receiverAtaStr && ixMint === mintStr) {
				paidToPayTo += readU64LE(ix.data, 1);
			}
		} else if (kind === IX_TRANSFER) {
			// accounts: [source, destination, owner]; data: [3, amount(u64 LE)].
			// No mint in the instruction — a destination match implies our mint
			// because the receiver ATA is mint-specific.
			if (ix.accountKeys.length < 2 || ix.data.length < 9) continue;
			sawTokenTransfer = true;
			const ixDest = ix.accountKeys[1].toBase58();
			if (ixDest === receiverAtaStr) {
				paidToPayTo += readU64LE(ix.data, 1);
			}
		}
	}

	return { ok: true, paidToPayTo, sawTokenTransfer };
}

// Public entry point used by verifyPayment. Returns:
//   { confirmed: true }                  — signed tx pays >= required to payTo.
//   { confirmed: false, reason }         — definitively underpaid / mis-routed.
//   { inconclusive: true, reason }       — couldn't decode; defer to facilitator.
export function confirmSolanaPayment({ paymentPayload, requirement }) {
	const transactionBase64 = paymentPayload?.payload?.transaction;
	if (typeof transactionBase64 !== 'string' || !transactionBase64) {
		return { inconclusive: true, reason: 'no_serialized_transaction' };
	}
	let required;
	try {
		required = BigInt(requirement.amount);
	} catch {
		return { inconclusive: true, reason: 'bad_requirement_amount' };
	}

	const decoded = decodeSolanaTransfer({
		transactionBase64,
		asset: requirement.asset,
		payTo: requirement.payTo,
	});
	if (decoded.inconclusive) return decoded;

	// We positively decoded the token transfers but none (or too little) reached
	// our payTo — only treat as a hard failure when we actually saw a transfer
	// to parse; an empty/odd instruction set stays inconclusive.
	if (decoded.paidToPayTo < required) {
		if (!decoded.sawTokenTransfer) {
			return { inconclusive: true, reason: 'no_token_transfer_found' };
		}
		return {
			confirmed: false,
			reason: `signed Solana transfer to payTo totals ${decoded.paidToPayTo.toString()} below required ${required.toString()}`,
		};
	}
	return { confirmed: true, paidToPayTo: decoded.paidToPayTo.toString() };
}
