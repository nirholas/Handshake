// The escrowed knock lane: reading and verifying the on-chain half.
//
// The x402 lane (api/x402/knock.js) settles the sender's USDC straight to the
// recipient's own wallet the moment the payment clears, and the door row says
// so: nothing here holds funds. That is the right shape between people who
// already trust each other, and the wrong one for a stranger, because the
// recipient can bank every knock and answer none.
//
// The escrowed lane closes that. The sender signs a `knock` instruction on the
// knock_escrow program (contracts/knock-escrow), which parks the payment in a
// vault owned by the knock's own PDA. The recipient is paid only by answering
// inside the reply window; if they refuse, or the window lapses, every unit
// goes back to the sender and anyone at all can crank that refund.
//
// This module is the READ side, and deliberately nothing else. three.ws never
// holds the money, never signs for either party, and cannot release an escrow:
// it verifies against the chain that a knock was really made, for the right
// amount, carrying the hash of the exact message being delivered, and still
// live. Everything it returns is derived from account bytes the RPC gave us, so
// a caller lying about what they paid fails here rather than at the inbox.
//
// The account layouts below are the program's borsh encoding. They are asserted
// against the compiled program's own PDAs in tests/knock-escrow-pda.test.js,
// which shares fixtures with the Rust suite, so a layout or seed change on
// either side fails a test rather than silently reading the wrong bytes.

import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

/** knock_escrow's `declare_id!`. */
export const KNOCK_ESCROW_PROGRAM_ID = 'uVX46U6sGUs6PD3339ZXbTpMyhZwkQhBLPxnvRX9ps7';

/** PDA seeds, byte-identical to the constants in the program. */
const CONFIG_SEED = Buffer.from('config');
const DOOR_SEED = Buffer.from('door');
const KNOCK_SEED = Buffer.from('knock');
const VAULT_SEED = Buffer.from('vault');

/** `KnockRecord.state`, matching the program's `KnockState`. */
export const KNOCK_STATE = Object.freeze({
	PENDING: 0,
	ANSWERED: 1,
	REFUNDED: 2,
	REFUSED: 3,
});

/** Human-readable names for the states, for API responses and the inbox. */
export const KNOCK_STATE_NAME = Object.freeze({
	0: 'pending',
	1: 'answered',
	2: 'refunded',
	3: 'refused',
});

/** SHA-256, the digest the program hashes door ids and message bodies with. */
export function sha256(input) {
	return createHash('sha256').update(input).digest();
}

/**
 * A door's 32-byte on-chain id: the SHA-256 of the owner's handle.
 *
 * The handle is normalized to lower case first because the off-chain door is
 * keyed case-insensitively; deriving from the raw string would give `/knock/Ada`
 * and `/knock/ada` two different doors on-chain for one door in the product.
 */
export function doorId(handle) {
	return sha256(String(handle).trim().toLowerCase());
}

/**
 * Anchor's 8-byte account discriminator: `sha256("account:<Name>")[..8]`.
 *
 * Checked on every decode. Without it a caller could hand us any account of the
 * right size and we would read its bytes as a knock.
 */
function accountDiscriminator(name) {
	return sha256(`account:${name}`).subarray(0, 8);
}

const programKey = () => new PublicKey(KNOCK_ESCROW_PROGRAM_ID);

/** The singleton config PDA. */
export function configPda() {
	return PublicKey.findProgramAddressSync([CONFIG_SEED], programKey())[0];
}

/** A door PDA, from the owner's wallet and the door id. */
export function doorPda(ownerWallet, id) {
	return PublicKey.findProgramAddressSync(
		[DOOR_SEED, new PublicKey(ownerWallet).toBuffer(), Buffer.from(id)],
		programKey(),
	)[0];
}

/** A single knock's PDA. `nonce` is what lets one sender knock twice. */
export function knockPda(door, sender, nonce) {
	const n = Buffer.alloc(8);
	n.writeBigUInt64LE(BigInt(nonce));
	return PublicKey.findProgramAddressSync(
		[KNOCK_SEED, new PublicKey(door).toBuffer(), new PublicKey(sender).toBuffer(), n],
		programKey(),
	)[0];
}

/** The vault token account holding one knock's escrowed payment. */
export function vaultPda(knock) {
	return PublicKey.findProgramAddressSync(
		[VAULT_SEED, new PublicKey(knock).toBuffer()],
		programKey(),
	)[0];
}

/** Read a pubkey out of an account buffer. */
const pubkeyAt = (buf, offset) => new PublicKey(buf.subarray(offset, offset + 32)).toBase58();

/**
 * Decode a `Door` account.
 *
 * Offsets are the program's borsh layout after the 8-byte discriminator:
 * owner 32 | mint 32 | door_id 32 | price 8 | reply_window 8 | open 1 |
 * knocks 8 | answered 8 | refunded 8 | earned 8 | bump 1.
 */
export function decodeDoor(data) {
	const buf = Buffer.from(data);
	if (buf.length < 154) throw new Error('door account is too small to decode');
	if (!buf.subarray(0, 8).equals(accountDiscriminator('Door'))) {
		throw new Error('account is not a knock_escrow Door');
	}
	return {
		owner: pubkeyAt(buf, 8),
		mint: pubkeyAt(buf, 40),
		doorId: Buffer.from(buf.subarray(72, 104)).toString('hex'),
		price: buf.readBigUInt64LE(104),
		replyWindow: Number(buf.readBigInt64LE(112)),
		open: buf[120] === 1,
		knocks: buf.readBigUInt64LE(121),
		answered: buf.readBigUInt64LE(129),
		refunded: buf.readBigUInt64LE(137),
		earned: buf.readBigUInt64LE(145),
	};
}

/**
 * Decode a `KnockRecord` account.
 *
 * door 32 | sender 32 | mint 32 | amount 8 | fee_bps 2 | nonce 8 |
 * message_hash 32 | reply_hash 32 | created_at 8 | expires_at 8 | state 1 |
 * bump 1 | vault_bump 1.
 */
export function decodeKnock(data) {
	const buf = Buffer.from(data);
	if (buf.length < 205) throw new Error('knock account is too small to decode');
	if (!buf.subarray(0, 8).equals(accountDiscriminator('KnockRecord'))) {
		throw new Error('account is not a knock_escrow KnockRecord');
	}
	const state = buf[202];
	return {
		door: pubkeyAt(buf, 8),
		sender: pubkeyAt(buf, 40),
		mint: pubkeyAt(buf, 72),
		amount: buf.readBigUInt64LE(104),
		feeBps: buf.readUInt16LE(112),
		nonce: buf.readBigUInt64LE(114),
		messageHash: Buffer.from(buf.subarray(122, 154)).toString('hex'),
		replyHash: Buffer.from(buf.subarray(154, 186)).toString('hex'),
		createdAt: Number(buf.readBigInt64LE(186)),
		expiresAt: Number(buf.readBigInt64LE(194)),
		state,
		stateName: KNOCK_STATE_NAME[state] || 'unknown',
	};
}

/**
 * Why a knock could not be accepted, in the sender's words rather than the
 * chain's. Each of these is a real thing a caller can do wrong, and each needs
 * to say what to do instead, because the money is already committed on-chain by
 * the time we are looking.
 */
export class EscrowRejected extends Error {
	constructor(code, message, detail = {}) {
		super(message);
		this.name = 'EscrowRejected';
		this.code = code;
		this.detail = detail;
	}
}

/**
 * Verify that an escrowed knock really exists on-chain and matches the message
 * about to be delivered.
 *
 * `connection` is a web3.js Connection (callers get one through
 * `rpcFallbackFromEnv().withFallback`, so this inherits the provider failover
 * rather than pinning one RPC).
 *
 * Returns the decoded knock plus the derived addresses. Throws `EscrowRejected`
 * when the chain disagrees with the request in any way that matters:
 *
 *  - the knock account does not exist (nothing was paid);
 *  - it is not for this door (paid at somebody else's door);
 *  - the message hash differs (paid for a different message than the one being
 *    delivered, which is the substitution this hash exists to prevent);
 *  - it already settled (replay of a knock that was answered or refunded);
 *  - it is already past its window (the sender is owed a refund, so accepting
 *    the message would take attention the recipient can no longer be paid for);
 *  - it is under the door's asking price.
 */
export async function verifyEscrowedKnock(
	connection,
	{ ownerWallet, handle, sender, nonce, message, minPriceAtomics = 0n, now = null },
) {
	const id = doorId(handle);
	const door = doorPda(ownerWallet, id);
	const knock = knockPda(door, sender, nonce);

	const info = await connection.getAccountInfo(new PublicKey(knock));
	if (!info) {
		throw new EscrowRejected(
			'knock_not_found',
			'no escrowed knock exists on-chain for that door, sender and nonce',
			{ knock: knock.toBase58(), door: door.toBase58() },
		);
	}
	if (info.owner?.toBase58?.() !== KNOCK_ESCROW_PROGRAM_ID) {
		throw new EscrowRejected('wrong_program', 'that account is not owned by the knock escrow program', {
			knock: knock.toBase58(),
		});
	}

	const record = decodeKnock(info.data);
	if (record.door !== door.toBase58()) {
		throw new EscrowRejected('wrong_door', 'that knock was paid at a different door', {
			expected: door.toBase58(),
			actual: record.door,
		});
	}
	if (record.state !== KNOCK_STATE.PENDING) {
		throw new EscrowRejected('already_settled', `that knock was already ${record.stateName}`, {
			state: record.stateName,
		});
	}

	const expected = sha256(message).toString('hex');
	if (record.messageHash !== expected) {
		throw new EscrowRejected(
			'message_mismatch',
			'the escrowed knock was paid for a different message than the one being delivered',
			{ expected, actual: record.messageHash },
		);
	}

	const nowSeconds = now ?? Math.floor(Date.now() / 1000);
	if (nowSeconds > record.expiresAt) {
		throw new EscrowRejected(
			'window_closed',
			'that knock has expired and the sender is owed a refund; knock again to reach this door',
			{ expires_at: record.expiresAt },
		);
	}
	if (minPriceAtomics && record.amount < BigInt(minPriceAtomics)) {
		throw new EscrowRejected('underpaid', 'the escrowed amount is below this door\'s price', {
			escrowed: String(record.amount),
			price: String(minPriceAtomics),
		});
	}

	return {
		...record,
		knock: knock.toBase58(),
		doorPda: door.toBase58(),
		vault: vaultPda(knock).toBase58(),
		expiresInSeconds: record.expiresAt - nowSeconds,
	};
}
