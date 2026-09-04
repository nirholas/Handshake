// The browser's knock_escrow client, pinned against the program it talks to.
//
// src/knock/escrow-program.js builds transactions the sender and the door owner
// sign with their own wallets, because three.ws holds no key that can move an
// escrowed payment. That design means a wrong byte here is not caught by any
// server: the wallet signs whatever it is handed, and the program either
// dispatches to a different instruction or rejects the transaction at the
// account layer with an error nobody can read.
//
// So everything that has to agree with the program is asserted here against the
// same fixtures the Rust suite pins in contracts/program-tests/tests/
// knock_escrow_pda.rs, and the account orders below are the ones the compiled
// program accepts in contracts/program-tests/tests/knock_escrow.rs, which runs
// them against real bytecode.

import { describe, it, expect } from 'vitest';
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import {
	KNOCK_ESCROW_PROGRAM_ID,
	USDC_MINT,
	ataFor,
	answerIx,
	configPda,
	createAtaIfMissingIx,
	decodeConfig,
	decodeDoor,
	decodeKnock,
	discriminator,
	doorId,
	doorPda,
	hex,
	knockIx,
	knockPda,
	openDoorIx,
	reclaimIx,
	refuseIx,
	setDoorIx,
	sha256,
	tokenProgramForOwner,
	vaultPda,
} from '../src/knock/escrow-program.js';

const OWNER = '11111111111111111111111111111111';
const SENDER = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const HANDLE = 'nirholas';
const NONCE = 7;

// Produced by the program's own find_program_address calls.
const EXPECT = {
	doorIdHex: 'b3d92abfa95658f0d35e6b20752e8ca9ba4fad9e9bbc62352c999c75853fb53d',
	config: '7jAKSyTgRC8aGAjdYkMjQMPv7uh3uJX869GRXkBTUPkZ',
	door: 'DMDKj3mSoM5rjsftGAhSbLbrAWMwmFxEkHDLsx997vk8',
	knock: '8WvZ64SL6JNss232BC78aapB2M6MjE95f9LtWfYYRn5t',
	vault: '8LLgeTjcL4ZiU1MwoFWR4DkTkYnXruBsorMG7MKWbSwv',
};

const doorKey = () => doorPda(OWNER, doorId(HANDLE));
const knockKey = () => knockPda(doorKey(), SENDER, NONCE);

/** [address, isSigner, isWritable] for every account, in order. */
const shape = (ix) => ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]);

describe('addresses', () => {
	it('derives the same PDAs the program does', () => {
		expect(hex(doorId(HANDLE))).toBe(EXPECT.doorIdHex);
		expect(configPda().toBase58()).toBe(EXPECT.config);
		expect(doorKey().toBase58()).toBe(EXPECT.door);
		expect(knockKey().toBase58()).toBe(EXPECT.knock);
		expect(vaultPda(knockKey()).toBase58()).toBe(EXPECT.vault);
	});

	it('normalizes the handle, so one door is never two doors on-chain', () => {
		expect(hex(doorId('NirHolas'))).toBe(EXPECT.doorIdHex);
		expect(hex(doorId('  nirholas  '))).toBe(EXPECT.doorIdHex);
	});

	it('agrees with the server-side read client', async () => {
		const server = await import('../api/_lib/knock/escrow.js');
		expect(server.KNOCK_ESCROW_PROGRAM_ID).toBe(KNOCK_ESCROW_PROGRAM_ID);
		expect(server.doorId(HANDLE).toString('hex')).toBe(hex(doorId(HANDLE)));
		expect(server.doorPda(OWNER, server.doorId(HANDLE)).toBase58()).toBe(doorKey().toBase58());
		expect(server.knockPda(doorKey(), SENDER, NONCE).toBase58()).toBe(knockKey().toBase58());
		expect(server.vaultPda(knockKey()).toBase58()).toBe(vaultPda(knockKey()).toBase58());
	});
});

describe('instruction discriminators', () => {
	// Same eight bytes the Rust suite pins. A wrong one dispatches somewhere else.
	it.each([
		['open_door', '0b8c29ba454e37f7'],
		['set_door', 'e3022b8b592a417a'],
		['knock', 'fbd9cc537e9b5da3'],
		['answer', '48d62c2035de09f4'],
		['refuse', 'c449f3c611fac816'],
		['reclaim', '2cb1ecf9916da3ba'],
	])('%s', (name, expected) => {
		expect(hex(discriminator(name))).toBe(expected);
	});
});

describe('knock', () => {
	const senderTokens = ataFor(USDC_MINT, SENDER);
	const messageHash = sha256('two questions about the facilitator');

	it('lists the accounts the program expects, in order', () => {
		const ix = knockIx({
			sender: SENDER,
			door: doorKey(),
			mint: USDC_MINT,
			senderTokens,
			nonce: NONCE,
			messageHash,
		});
		expect(ix.programId.toBase58()).toBe(KNOCK_ESCROW_PROGRAM_ID);
		expect(shape(ix)).toEqual([
			[SENDER, true, true],
			[EXPECT.config, false, false],
			[EXPECT.door, false, true],
			[USDC_MINT, false, false],
			[senderTokens.toBase58(), false, true],
			[EXPECT.knock, false, true],
			[EXPECT.vault, false, true],
			[TOKEN_PROGRAM_ID.toBase58(), false, false],
			[SystemProgram.programId.toBase58(), false, false],
			[SYSVAR_RENT_PUBKEY.toBase58(), false, false],
		]);
	});

	it('carries the nonce and the message hash, and nothing else', () => {
		const ix = knockIx({
			sender: SENDER,
			door: doorKey(),
			mint: USDC_MINT,
			senderTokens,
			nonce: NONCE,
			messageHash,
		});
		expect(ix.data).toHaveLength(8 + 8 + 32);
		expect(hex(ix.data.subarray(0, 8))).toBe('fbd9cc537e9b5da3');
		expect(ix.data.readBigUInt64LE(8)).toBe(7n);
		expect(hex(ix.data.subarray(16))).toBe(hex(messageHash));
	});

	it('is a different knock for a different nonce, so one sender can knock twice', () => {
		const first = knockIx({ sender: SENDER, door: doorKey(), mint: USDC_MINT, senderTokens, nonce: 7, messageHash });
		const second = knockIx({ sender: SENDER, door: doorKey(), mint: USDC_MINT, senderTokens, nonce: 8, messageHash });
		expect(shape(first)[5][0]).not.toBe(shape(second)[5][0]);
	});

	it('signs with the token program the door mint belongs to, for Token-2022', () => {
		const ix = knockIx({
			sender: SENDER,
			door: doorKey(),
			mint: USDC_MINT,
			senderTokens,
			nonce: NONCE,
			messageHash,
			tokenProgram: TOKEN_2022_PROGRAM_ID,
		});
		expect(shape(ix)[7][0]).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
	});
});

describe('open_door', () => {
	it('lists the accounts the program expects, in order', () => {
		const ix = openDoorIx({
			owner: OWNER,
			mint: USDC_MINT,
			priceAtomics: 50_000n,
			replyWindowSeconds: 86_400,
			handle: HANDLE,
		});
		expect(shape(ix)).toEqual([
			[OWNER, true, true],
			[USDC_MINT, false, false],
			[EXPECT.door, false, true],
			[SystemProgram.programId.toBase58(), false, false],
		]);
	});

	it('encodes the door id, then the price, then the window', () => {
		const ix = openDoorIx({
			owner: OWNER,
			mint: USDC_MINT,
			priceAtomics: 50_000n,
			replyWindowSeconds: 86_400,
			handle: HANDLE,
		});
		expect(ix.data).toHaveLength(8 + 32 + 8 + 8);
		expect(hex(ix.data.subarray(8, 40))).toBe(EXPECT.doorIdHex);
		expect(ix.data.readBigUInt64LE(40)).toBe(50_000n);
		expect(ix.data.readBigInt64LE(48)).toBe(86_400n);
	});
});

describe('set_door', () => {
	// borsh encodes Option<T> as a 1-byte tag then the value, so a patch that
	// only shuts the door must not smuggle a price change in beside it.
	it('shuts a door without touching its price or window', () => {
		const ix = setDoorIx({ owner: OWNER, handle: HANDLE, open: false });
		expect(Array.from(ix.data.subarray(8))).toEqual([0, 0, 1, 0]);
	});

	it('reprices without shutting', () => {
		const ix = setDoorIx({ owner: OWNER, handle: HANDLE, priceAtomics: 250_000n });
		expect(ix.data[8]).toBe(1);
		expect(ix.data.readBigUInt64LE(9)).toBe(250_000n);
		expect(ix.data[17]).toBe(0); // window: None
		expect(ix.data[18]).toBe(0); // open: None
	});
});

describe('answer', () => {
	it('lists the accounts the program expects, in order', () => {
		const ownerTokens = ataFor(USDC_MINT, OWNER);
		const treasuryTokens = ataFor(USDC_MINT, SENDER);
		const ix = answerIx({
			owner: OWNER,
			door: doorKey(),
			knock: knockKey(),
			mint: USDC_MINT,
			sender: SENDER,
			ownerTokens,
			treasuryTokens,
			replyHash: sha256('here is my reply'),
		});
		expect(shape(ix)).toEqual([
			[OWNER, true, false],
			[EXPECT.config, false, false],
			[EXPECT.door, false, true],
			[EXPECT.knock, false, true],
			[USDC_MINT, false, false],
			[EXPECT.vault, false, true],
			[ownerTokens.toBase58(), false, true],
			[treasuryTokens.toBase58(), false, true],
			// The rent destination is the sender, and the program address-checks
			// it, so a mis-ordered account here fails rather than paying a stranger.
			[SENDER, false, true],
			[TOKEN_PROGRAM_ID.toBase58(), false, false],
		]);
		expect(ix.data).toHaveLength(8 + 32);
	});
});

describe('refuse and reclaim', () => {
	const common = {
		door: doorKey(),
		knock: knockKey(),
		mint: USDC_MINT,
		sender: SENDER,
		senderTokens: ataFor(USDC_MINT, SENDER),
	};

	it('refuse is owner-signed and carries no arguments', () => {
		const ix = refuseIx({ owner: OWNER, ...common });
		expect(shape(ix)).toEqual([
			[OWNER, true, false],
			[EXPECT.door, false, true],
			[EXPECT.knock, false, true],
			[USDC_MINT, false, false],
			[EXPECT.vault, false, true],
			[common.senderTokens.toBase58(), false, true],
			[SENDER, false, true],
			[TOKEN_PROGRAM_ID.toBase58(), false, false],
		]);
		expect(ix.data).toHaveLength(8);
	});

	it('reclaim takes the same accounts but any signer at all', () => {
		const cranker = 'SysvarRent111111111111111111111111111111111';
		const ix = reclaimIx({ cranker, ...common });
		expect(shape(ix)[0]).toEqual([cranker, true, false]);
		// Everything after the signer is identical to refuse: the crank is not a
		// different settlement, it is the same refund with a different signer.
		expect(shape(ix).slice(1)).toEqual(shape(refuseIx({ owner: OWNER, ...common })).slice(1));
		expect(ix.data).toHaveLength(8);
	});
});

describe('token accounts', () => {
	it('creates a payout account idempotently, so answering never fails on a missing ATA', () => {
		const ix = createAtaIfMissingIx({ payer: OWNER, owner: OWNER, mint: USDC_MINT });
		expect(ix.keys[1].pubkey.toBase58()).toBe(ataFor(USDC_MINT, OWNER).toBase58());
		// Tag 1 is CreateIdempotent; tag 0 would throw when the account exists.
		expect(ix.data[0]).toBe(1);
	});

	it('picks the token program from the mint account owner', () => {
		expect(tokenProgramForOwner(TOKEN_2022_PROGRAM_ID.toBase58()).toBase58()).toBe(
			TOKEN_2022_PROGRAM_ID.toBase58(),
		);
		expect(tokenProgramForOwner(TOKEN_PROGRAM_ID.toBase58()).toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
	});
});

describe('account decoding', () => {
	function encodeConfig({ treasury = SENDER, feeBps = 250 } = {}) {
		const buf = Buffer.alloc(75);
		Buffer.from('9b0caae01efacc82', 'hex').copy(buf, 0); // sha256("account:Config")[..8]
		new PublicKey(OWNER).toBuffer().copy(buf, 8);
		new PublicKey(treasury).toBuffer().copy(buf, 40);
		buf.writeUInt16LE(feeBps, 72);
		return buf;
	}

	it('reads the treasury an answer has to pay the fee to', () => {
		// The discriminator is recomputed here rather than trusted, because the
		// fixture above is only correct if it matches sha256("account:Config").
		const expected = hex(sha256('account:Config').slice(0, 8));
		expect(hex(encodeConfig().subarray(0, 8))).toBe(expected);
		const config = decodeConfig(encodeConfig());
		expect(config.treasury).toBe(SENDER);
		expect(config.feeBps).toBe(250);
	});

	it('refuses an account of the wrong type rather than reading its bytes', () => {
		const wrong = encodeConfig();
		wrong.writeUInt8(0, 0);
		expect(() => decodeConfig(wrong)).toThrow(/not a knock_escrow Config/);
		expect(() => decodeDoor(Buffer.alloc(20))).toThrow(/too small/);
		expect(() => decodeKnock(Buffer.alloc(20))).toThrow(/too small/);
	});

	it('decodes a knock the same way the server does', async () => {
		const server = await import('../api/_lib/knock/escrow.js');
		const buf = Buffer.alloc(205);
		Buffer.from('f9c621b06c558191', 'hex').copy(buf, 0);
		new PublicKey(EXPECT.door).toBuffer().copy(buf, 8);
		new PublicKey(SENDER).toBuffer().copy(buf, 40);
		new PublicKey(USDC_MINT).toBuffer().copy(buf, 72);
		buf.writeBigUInt64LE(50_000n, 104);
		buf.writeUInt16LE(250, 112);
		buf.writeBigUInt64LE(7n, 114);
		Buffer.from(server.sha256('hello')).copy(buf, 122);
		buf.writeBigInt64LE(1_767_225_600n, 186);
		buf.writeBigInt64LE(1_767_312_000n, 194);
		buf[202] = 0;

		const mine = decodeKnock(buf);
		const theirs = server.decodeKnock(buf);
		expect(mine.sender).toBe(theirs.sender);
		expect(mine.amount).toBe(theirs.amount);
		expect(mine.messageHash).toBe(theirs.messageHash);
		expect(mine.expiresAt).toBe(theirs.expiresAt);
		expect(mine.stateName).toBe('pending');
	});
});
