// Cross-language conformance for the knock escrow client.
//
// The JS client derives the same PDAs the Rust program derives, or it reads the
// wrong account and every downstream check is meaningless: a wrong door seed
// makes `verifyEscrowedKnock` report "no escrowed knock exists" for a knock that
// was really paid, and a wrong discriminator would let it decode somebody else's
// account as a knock. Neither failure is visible in a unit test that only talks
// to itself, so the fixtures below are the values the PROGRAM produced, printed
// from contracts/program-tests against fixed inputs and pasted here.
//
// If a seed, an account name, or the program id changes on either side, this
// test fails. Regenerate the fixtures from the Rust side, never by running the
// JS and copying what it happens to produce.

import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
	KNOCK_ESCROW_PROGRAM_ID,
	KNOCK_STATE,
	configPda,
	decodeDoor,
	decodeKnock,
	doorId,
	doorPda,
	knockPda,
	sha256,
	vaultPda,
	verifyEscrowedKnock,
	EscrowRejected,
} from '../api/_lib/knock/escrow.js';

// Fixed inputs, identical to contracts/program-tests/tests/knock_escrow_pda.rs.
const OWNER = '11111111111111111111111111111111';
const SENDER = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const HANDLE = 'nirholas';
const NONCE = 7;

// Produced by the Rust program's own find_program_address calls.
const EXPECT = {
	doorIdHex: 'b3d92abfa95658f0d35e6b20752e8ca9ba4fad9e9bbc62352c999c75853fb53d',
	config: '7jAKSyTgRC8aGAjdYkMjQMPv7uh3uJX869GRXkBTUPkZ',
	door: 'DMDKj3mSoM5rjsftGAhSbLbrAWMwmFxEkHDLsx997vk8',
	knock: '8WvZ64SL6JNss232BC78aapB2M6MjE95f9LtWfYYRn5t',
	vault: '8LLgeTjcL4ZiU1MwoFWR4DkTkYnXruBsorMG7MKWbSwv',
	discDoor: '541e65686ab2068c',
	discKnock: 'f9c621b06c558191',
};

describe('knock escrow PDA derivation matches the program', () => {
	it('derives the door id the program hashes', () => {
		expect(doorId(HANDLE).toString('hex')).toBe(EXPECT.doorIdHex);
	});

	it('normalizes the handle so one door is not two doors on-chain', () => {
		expect(doorId('NirHolas').toString('hex')).toBe(EXPECT.doorIdHex);
		expect(doorId('  nirholas  ').toString('hex')).toBe(EXPECT.doorIdHex);
	});

	it('derives the config, door, knock and vault addresses', () => {
		const door = doorPda(OWNER, doorId(HANDLE));
		const knock = knockPda(door, SENDER, NONCE);
		expect(configPda().toBase58()).toBe(EXPECT.config);
		expect(door.toBase58()).toBe(EXPECT.door);
		expect(knock.toBase58()).toBe(EXPECT.knock);
		expect(vaultPda(knock).toBase58()).toBe(EXPECT.vault);
	});

	it('separates knocks by nonce, so one sender can knock twice', () => {
		const door = doorPda(OWNER, doorId(HANDLE));
		expect(knockPda(door, SENDER, 8).toBase58()).not.toBe(EXPECT.knock);
	});
});

// ── account decoding ────────────────────────────────────────────────────────

/** Build a byte-accurate `KnockRecord` the way the program lays one out. */
function encodeKnock({
	door = EXPECT.door,
	sender = SENDER,
	mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	amount = 50_000n,
	feeBps = 250,
	nonce = NONCE,
	messageHash = Buffer.alloc(32),
	replyHash = Buffer.alloc(32),
	createdAt = 1_767_225_600,
	expiresAt = 1_767_312_000,
	state = KNOCK_STATE.PENDING,
} = {}) {
	const buf = Buffer.alloc(205);
	Buffer.from(EXPECT.discKnock, 'hex').copy(buf, 0);
	new PublicKey(door).toBuffer().copy(buf, 8);
	new PublicKey(sender).toBuffer().copy(buf, 40);
	new PublicKey(mint).toBuffer().copy(buf, 72);
	buf.writeBigUInt64LE(amount, 104);
	buf.writeUInt16LE(feeBps, 112);
	buf.writeBigUInt64LE(BigInt(nonce), 114);
	Buffer.from(messageHash).copy(buf, 122);
	Buffer.from(replyHash).copy(buf, 154);
	buf.writeBigInt64LE(BigInt(createdAt), 186);
	buf.writeBigInt64LE(BigInt(expiresAt), 194);
	buf[202] = state;
	return buf;
}

describe('account decoding', () => {
	it('reads back every field of a knock record', () => {
		const messageHash = sha256('hello there');
		const got = decodeKnock(encodeKnock({ messageHash }));
		expect(got.sender).toBe(SENDER);
		expect(got.amount).toBe(50_000n);
		expect(got.feeBps).toBe(250);
		expect(got.nonce).toBe(7n);
		expect(got.messageHash).toBe(messageHash.toString('hex'));
		expect(got.expiresAt).toBe(1_767_312_000);
		expect(got.stateName).toBe('pending');
	});

	it('refuses an account that is not a knock record', () => {
		const wrong = encodeKnock();
		wrong.writeUInt8(0, 0); // corrupt the discriminator
		expect(() => decodeKnock(wrong)).toThrow(/not a knock_escrow KnockRecord/);
	});

	it('refuses a truncated account rather than reading past its end', () => {
		expect(() => decodeKnock(encodeKnock().subarray(0, 100))).toThrow(/too small/);
		expect(() => decodeDoor(Buffer.alloc(20))).toThrow(/too small/);
	});
});

// ── verification ────────────────────────────────────────────────────────────

/** A stub connection returning one account, standing in for the RPC. */
function connectionServing(data) {
	return {
		async getAccountInfo() {
			if (!data) return null;
			return { data, owner: { toBase58: () => KNOCK_ESCROW_PROGRAM_ID } };
		},
	};
}

const NOW = 1_767_225_600;
const base = { ownerWallet: OWNER, handle: HANDLE, sender: SENDER, nonce: NONCE, now: NOW };

describe('verifyEscrowedKnock', () => {
	const message = 'two questions about the facilitator';

	it('accepts a live knock whose hash matches the message', async () => {
		const conn = connectionServing(encodeKnock({ messageHash: sha256(message) }));
		const got = await verifyEscrowedKnock(conn, { ...base, message, minPriceAtomics: 50_000n });
		expect(got.knock).toBe(EXPECT.knock);
		expect(got.vault).toBe(EXPECT.vault);
		expect(got.stateName).toBe('pending');
		expect(got.expiresInSeconds).toBe(86_400);
	});

	it('rejects a knock that was never made', async () => {
		await expect(
			verifyEscrowedKnock(connectionServing(null), { ...base, message }),
		).rejects.toMatchObject({ code: 'knock_not_found' });
	});

	it('rejects a message the sender did not pay for', async () => {
		const conn = connectionServing(encodeKnock({ messageHash: sha256('a different message') }));
		await expect(verifyEscrowedKnock(conn, { ...base, message })).rejects.toMatchObject({
			code: 'message_mismatch',
		});
	});

	it('rejects a knock that already settled, so an answer cannot be replayed', async () => {
		for (const state of [KNOCK_STATE.ANSWERED, KNOCK_STATE.REFUNDED, KNOCK_STATE.REFUSED]) {
			const conn = connectionServing(encodeKnock({ messageHash: sha256(message), state }));
			await expect(verifyEscrowedKnock(conn, { ...base, message })).rejects.toMatchObject({
				code: 'already_settled',
			});
		}
	});

	it('rejects a knock past its window, because that money is owed back', async () => {
		const conn = connectionServing(encodeKnock({ messageHash: sha256(message) }));
		await expect(
			verifyEscrowedKnock(conn, { ...base, message, now: 1_767_312_001 }),
		).rejects.toMatchObject({ code: 'window_closed' });
	});

	it('rejects an escrow below the door price', async () => {
		const conn = connectionServing(encodeKnock({ messageHash: sha256(message), amount: 10_000n }));
		await expect(
			verifyEscrowedKnock(conn, { ...base, message, minPriceAtomics: 50_000n }),
		).rejects.toMatchObject({ code: 'underpaid' });
	});

	it('rejects an account owned by some other program', async () => {
		const conn = {
			async getAccountInfo() {
				return {
					data: encodeKnock({ messageHash: sha256(message) }),
					owner: { toBase58: () => '11111111111111111111111111111111' },
				};
			},
		};
		await expect(verifyEscrowedKnock(conn, { ...base, message })).rejects.toMatchObject({
			code: 'wrong_program',
		});
	});

	it('reports rejections as EscrowRejected with a code a caller can branch on', async () => {
		const err = await verifyEscrowedKnock(connectionServing(null), { ...base, message }).catch((e) => e);
		expect(err).toBeInstanceOf(EscrowRejected);
		expect(err.detail.knock).toBe(EXPECT.knock);
	});
});
