// The knock_escrow program, from the browser.
//
// api/_lib/knock/escrow.js is the READ side: the server derives a knock's
// address and checks what the chain says about it. This is the WRITE side, and
// it lives in the browser on purpose, because three.ws must never be able to
// move an escrowed payment. Every instruction below is signed by the person it
// belongs to: the sender escrows, the owner answers or refuses, and anybody at
// all can crank an expired refund.
//
// The account orders, argument encodings and discriminators here are the ones
// the compiled program accepts. They are pinned against it in
// tests/knock-escrow-program.test.js, which shares fixtures with the Rust suite
// in contracts/program-tests, so a change on either side fails a test instead of
// producing a transaction the program silently rejects at the account layer.
//
// Loaded dynamically (see src/knock/door.js), so the Solana SDKs stay out of the
// bundle for the visitors who only ever read a door.

import { PublicKey, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha256';
import {
	getAssociatedTokenAddressSync,
	createAssociatedTokenAccountIdempotentInstruction,
	ASSOCIATED_TOKEN_PROGRAM_ID,
	TOKEN_PROGRAM_ID,
	TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';

/** knock_escrow's `declare_id!`. */
export const KNOCK_ESCROW_PROGRAM_ID = 'uVX46U6sGUs6PD3339ZXbTpMyhZwkQhBLPxnvRX9ps7';

/** The mint a door opened from this UI prices itself in. */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** The program's own reply-window band. A door outside it is refused on-chain. */
export const MIN_REPLY_WINDOW_SECONDS = 60 * 60;
export const MAX_REPLY_WINDOW_SECONDS = 60 * 60 * 24 * 30;

/** The program's price ceiling, in atomic units of the door's mint. */
export const MAX_PRICE_ATOMICS = 1_000_000_000n;

export const KNOCK_STATE_NAME = Object.freeze({ 0: 'pending', 1: 'answered', 2: 'refunded', 3: 'refused' });

const enc = new TextEncoder();
const CONFIG_SEED = enc.encode('config');
const DOOR_SEED = enc.encode('door');
const KNOCK_SEED = enc.encode('knock');
const VAULT_SEED = enc.encode('vault');

const programKey = () => new PublicKey(KNOCK_ESCROW_PROGRAM_ID);
const key = (v) => (v instanceof PublicKey ? v : new PublicKey(v));

/** SHA-256, the digest the program hashes door ids, messages and replies with. */
export function sha256(input) {
	return nobleSha256(typeof input === 'string' ? enc.encode(input) : input);
}

/**
 * A door's 32-byte on-chain id: the SHA-256 of the owner's handle, lowercased.
 *
 * Normalized because the off-chain door is keyed case-insensitively, and
 * hashing the raw string would give `/knock/Ada` and `/knock/ada` two different
 * doors on-chain for one door in the product.
 */
export function doorId(handle) {
	return sha256(String(handle).trim().toLowerCase());
}

export function configPda() {
	return PublicKey.findProgramAddressSync([CONFIG_SEED], programKey())[0];
}

export function doorPda(owner, id) {
	return PublicKey.findProgramAddressSync([DOOR_SEED, key(owner).toBytes(), id], programKey())[0];
}

export function knockPda(door, sender, nonce) {
	return PublicKey.findProgramAddressSync(
		[KNOCK_SEED, key(door).toBytes(), key(sender).toBytes(), u64(nonce)],
		programKey(),
	)[0];
}

export function vaultPda(knock) {
	return PublicKey.findProgramAddressSync([VAULT_SEED, key(knock).toBytes()], programKey())[0];
}

// ── encoding ────────────────────────────────────────────────────────────────

function u64(value) {
	const out = new Uint8Array(8);
	new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
	return out;
}

function i64(value) {
	const out = new Uint8Array(8);
	new DataView(out.buffer).setBigInt64(0, BigInt(value), true);
	return out;
}

function concat(parts) {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/** Anchor's instruction discriminator: `sha256("global:<name>")[..8]`. */
export function discriminator(name) {
	return sha256(`global:${name}`).slice(0, 8);
}

function data(name, ...args) {
	return Buffer.from(concat([discriminator(name), ...args]));
}

const meta = (pubkey, { signer = false, writable = false } = {}) => ({
	pubkey: key(pubkey),
	isSigner: signer,
	isWritable: writable,
});

// ── instructions ────────────────────────────────────────────────────────────

/**
 * Open a priced door on-chain. The owner signs, and it is their wallet plus the
 * door id that make the door's address, so nobody can open a door in their name.
 */
export function openDoorIx({ owner, mint, priceAtomics, replyWindowSeconds, handle }) {
	const id = doorId(handle);
	return new TransactionInstruction({
		programId: programKey(),
		keys: [
			meta(owner, { signer: true, writable: true }),
			meta(mint),
			meta(doorPda(owner, id), { writable: true }),
			meta(SystemProgram.programId),
		],
		data: data('open_door', id, u64(priceAtomics), i64(replyWindowSeconds)),
	});
}

/**
 * Reprice a door, change its window, or shut it. Every field is optional, and
 * borsh encodes an `Option<T>` as a 1-byte tag followed by the value.
 *
 * Shutting a door stops new knocks and deliberately leaves the ones already in
 * flight alone: those are owed an answer or a refund either way.
 */
export function setDoorIx({ owner, handle, priceAtomics = null, replyWindowSeconds = null, open = null }) {
	const parts = [];
	parts.push(priceAtomics === null ? Uint8Array.of(0) : concat([Uint8Array.of(1), u64(priceAtomics)]));
	parts.push(replyWindowSeconds === null ? Uint8Array.of(0) : concat([Uint8Array.of(1), i64(replyWindowSeconds)]));
	parts.push(open === null ? Uint8Array.of(0) : Uint8Array.of(1, open ? 1 : 0));
	return new TransactionInstruction({
		programId: programKey(),
		keys: [
			meta(owner, { signer: true }),
			meta(doorPda(owner, doorId(handle)), { writable: true }),
		],
		data: data('set_door', ...parts),
	});
}

/**
 * Pay a door's price into escrow.
 *
 * `messageHash` is the SHA-256 of the exact message the sender is about to
 * deliver. That hash is what stops a payment being reused for something else:
 * the API refuses to deliver any message whose hash is not the one on-chain.
 */
export function knockIx({ sender, door, mint, senderTokens, nonce, messageHash, tokenProgram = TOKEN_PROGRAM_ID }) {
	const knock = knockPda(door, sender, nonce);
	return new TransactionInstruction({
		programId: programKey(),
		keys: [
			meta(sender, { signer: true, writable: true }),
			meta(configPda()),
			meta(door, { writable: true }),
			meta(mint),
			meta(senderTokens, { writable: true }),
			meta(knock, { writable: true }),
			meta(vaultPda(knock), { writable: true }),
			meta(tokenProgram),
			meta(SystemProgram.programId),
			meta(SYSVAR_RENT_PUBKEY),
		],
		data: data('knock', u64(nonce), messageHash),
	});
}

/**
 * Answer a knock and take the payment, minus the fee snapshotted when it was
 * made. Only the door's owner can sign this, and only inside the window.
 */
export function answerIx({
	owner,
	door,
	knock,
	mint,
	sender,
	ownerTokens,
	treasuryTokens,
	replyHash,
	tokenProgram = TOKEN_PROGRAM_ID,
}) {
	return new TransactionInstruction({
		programId: programKey(),
		keys: [
			meta(owner, { signer: true }),
			meta(configPda()),
			meta(door, { writable: true }),
			meta(knock, { writable: true }),
			meta(mint),
			meta(vaultPda(knock), { writable: true }),
			meta(ownerTokens, { writable: true }),
			meta(treasuryTokens, { writable: true }),
			meta(sender, { writable: true }),
			meta(tokenProgram),
		],
		data: data('answer', replyHash),
	});
}

/**
 * Decline a knock outright and hand every unit back. No fee is taken: refusing
 * to engage is not a service anybody should be charged for.
 */
export function refuseIx({ owner, door, knock, mint, sender, senderTokens, tokenProgram = TOKEN_PROGRAM_ID }) {
	return new TransactionInstruction({
		programId: programKey(),
		keys: [
			meta(owner, { signer: true }),
			meta(door, { writable: true }),
			meta(knock, { writable: true }),
			meta(mint),
			meta(vaultPda(knock), { writable: true }),
			meta(senderTokens, { writable: true }),
			meta(sender, { writable: true }),
			meta(tokenProgram),
		],
		data: data('refuse'),
	});
}

/**
 * Crank an expired knock's refund.
 *
 * The signer is whoever bothers to send it and gets nothing for it: every token
 * goes to the sender's own account and every lamport of rent goes to the
 * sender's own wallet, both address-checked by the program. That is what makes
 * the guarantee real rather than conditional on the sender still being around.
 */
export function reclaimIx({ cranker, door, knock, mint, sender, senderTokens, tokenProgram = TOKEN_PROGRAM_ID }) {
	return new TransactionInstruction({
		programId: programKey(),
		keys: [
			meta(cranker, { signer: true }),
			meta(door, { writable: true }),
			meta(knock, { writable: true }),
			meta(mint),
			meta(vaultPda(knock), { writable: true }),
			meta(senderTokens, { writable: true }),
			meta(sender, { writable: true }),
			meta(tokenProgram),
		],
		data: data('reclaim'),
	});
}

// ── token accounts ──────────────────────────────────────────────────────────

/** The associated token account, for the token program the mint belongs to. */
export function ataFor(mint, owner, tokenProgram = TOKEN_PROGRAM_ID) {
	return getAssociatedTokenAddressSync(key(mint), key(owner), true, key(tokenProgram), ASSOCIATED_TOKEN_PROGRAM_ID);
}

/**
 * An idempotent create for a token account that must exist before the program
 * can pay into it. Safe to include when it already does, which is why the payout
 * side sends it unconditionally rather than reading the account first.
 */
export function createAtaIfMissingIx({ payer, owner, mint, tokenProgram = TOKEN_PROGRAM_ID }) {
	return createAssociatedTokenAccountIdempotentInstruction(
		key(payer),
		ataFor(mint, owner, tokenProgram),
		key(owner),
		key(mint),
		key(tokenProgram),
		ASSOCIATED_TOKEN_PROGRAM_ID,
	);
}

/** Which token program a mint belongs to, read from the mint account's owner. */
export function tokenProgramForOwner(accountOwner) {
	const owner = String(accountOwner);
	return owner === TOKEN_2022_PROGRAM_ID.toBase58() ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

// ── account decoding ────────────────────────────────────────────────────────

function accountDiscriminator(name) {
	return sha256(`account:${name}`).slice(0, 8);
}

function sameBytes(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
	return true;
}

function view(data) {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	return { bytes, dv: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
}

const pubkeyAt = (bytes, at) => new PublicKey(bytes.subarray(at, at + 32)).toBase58();
const hexAt = (bytes, at, len) =>
	Array.from(bytes.subarray(at, at + len), (b) => b.toString(16).padStart(2, '0')).join('');

/** Decode a `Config` account: authority 32 | treasury 32 | fee_bps 2 | bump 1. */
export function decodeConfig(data) {
	const { bytes, dv } = view(data);
	if (bytes.length < 75) throw new Error('config account is too small to decode');
	if (!sameBytes(bytes.subarray(0, 8), accountDiscriminator('Config'))) {
		throw new Error('account is not a knock_escrow Config');
	}
	return {
		authority: pubkeyAt(bytes, 8),
		treasury: pubkeyAt(bytes, 40),
		feeBps: dv.getUint16(72, true),
	};
}

/** Decode a `Door` account. Layout mirrors api/_lib/knock/escrow.js. */
export function decodeDoor(data) {
	const { bytes, dv } = view(data);
	if (bytes.length < 154) throw new Error('door account is too small to decode');
	if (!sameBytes(bytes.subarray(0, 8), accountDiscriminator('Door'))) {
		throw new Error('account is not a knock_escrow Door');
	}
	return {
		owner: pubkeyAt(bytes, 8),
		mint: pubkeyAt(bytes, 40),
		doorId: hexAt(bytes, 72, 32),
		price: dv.getBigUint64(104, true),
		replyWindow: Number(dv.getBigInt64(112, true)),
		open: bytes[120] === 1,
		knocks: dv.getBigUint64(121, true),
		answered: dv.getBigUint64(129, true),
		refunded: dv.getBigUint64(137, true),
		earned: dv.getBigUint64(145, true),
	};
}

/** Decode a `KnockRecord` account. Layout mirrors api/_lib/knock/escrow.js. */
export function decodeKnock(data) {
	const { bytes, dv } = view(data);
	if (bytes.length < 205) throw new Error('knock account is too small to decode');
	if (!sameBytes(bytes.subarray(0, 8), accountDiscriminator('KnockRecord'))) {
		throw new Error('account is not a knock_escrow KnockRecord');
	}
	const state = bytes[202];
	return {
		door: pubkeyAt(bytes, 8),
		sender: pubkeyAt(bytes, 40),
		mint: pubkeyAt(bytes, 72),
		amount: dv.getBigUint64(104, true),
		feeBps: dv.getUint16(112, true),
		nonce: dv.getBigUint64(114, true),
		messageHash: hexAt(bytes, 122, 32),
		replyHash: hexAt(bytes, 154, 32),
		createdAt: Number(dv.getBigInt64(186, true)),
		expiresAt: Number(dv.getBigInt64(194, true)),
		state,
		stateName: KNOCK_STATE_NAME[state] || 'unknown',
	};
}

/** Hex, for comparing a message against the hash a knock was paid against. */
export function hex(bytes) {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
