// The escrowed knock, from the visitor's side of the glass.
//
// A door with the escrowed lane on takes payment the same way every other door
// does, and then does something none of them do: it cannot spend the money
// until it answers. This module is what makes that true in a browser. The
// sender's own wallet signs the escrow, and the same wallet (or anybody else's)
// signs the refund if the answer never comes. Nothing here asks a server for
// permission, because a server that could grant it could also refuse it.
//
// The chain is read for every number shown. The off-chain door row says what
// the owner intends to charge; the on-chain Door account says what the program
// will actually take, and only the second one can move a stranger's USDC. Where
// they disagree, this shows the on-chain number, because that is the one being
// agreed to.
//
// Instruction encoding lives in ./escrow-program.js and is pinned against the
// compiled program. This file is the flow around it: wallet, RPC, the checks
// worth making before a wallet ever opens, and errors a person can act on.

import {
	KNOCK_STATE_NAME,
	answerIx,
	ataFor,
	configPda,
	createAtaIfMissingIx,
	decodeConfig,
	decodeDoor,
	decodeKnock,
	doorPda,
	doorId,
	hex,
	knockIx,
	knockPda,
	openDoorIx,
	reclaimIx,
	refuseIx,
	setDoorIx,
	sha256,
	tokenProgramForOwner,
} from './escrow-program.js';

/** A refusal a person can act on, rather than a chain error nobody can read. */
export class EscrowError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'EscrowError';
		this.code = code;
	}
}

let _web3 = null;
async function web3() {
	if (!_web3) _web3 = await import('@solana/web3.js');
	return _web3;
}

function rpcEndpoint() {
	return (
		(typeof window !== 'undefined' && window.__solanaRpc) ||
		`${window.location.origin}/api/solana-rpc`
	);
}

export async function connection() {
	const { Connection } = await web3();
	return new Connection(rpcEndpoint(), 'confirmed');
}

/** The connected wallet, connecting it first if the visitor has not yet. */
export async function wallet() {
	const provider = typeof window !== 'undefined' ? window.solana : null;
	if (!provider) {
		throw new EscrowError('no_wallet', 'No Solana wallet in this browser. Install Phantom, or use an agent client.');
	}
	if (!provider.isConnected) {
		if (typeof provider.connect !== 'function') {
			throw new EscrowError('not_connected', 'Connect your wallet and try again.');
		}
		await provider.connect();
	}
	if (!provider.publicKey) throw new EscrowError('not_connected', 'Connect your wallet and try again.');
	return provider;
}

/**
 * Read a door's on-chain half.
 *
 * Returns null when the owner has turned the lane on but never opened the door
 * on-chain, which is a real and recoverable state: the page says so rather than
 * offering a lane that would fail in the wallet.
 */
export async function readDoor(conn, doorAddress) {
	const { PublicKey } = await web3();
	const info = await conn.getAccountInfo(new PublicKey(doorAddress));
	if (!info) return null;
	const door = decodeDoor(info.data);
	const mintInfo = await conn.getAccountInfo(new PublicKey(door.mint));
	if (!mintInfo) throw new EscrowError('bad_mint', 'This door is priced in a token that no longer exists.');
	return {
		...door,
		address: String(doorAddress),
		tokenProgram: tokenProgramForOwner(mintInfo.owner.toBase58()),
		// Mint layout puts decimals at byte 44 in both Token and Token-2022.
		decimals: mintInfo.data[44],
	};
}

/** Human amount from atomic units, without floating point in the middle. */
export function formatAmount(atomics, decimals) {
	const negative = BigInt(atomics) < 0n;
	const value = negative ? -BigInt(atomics) : BigInt(atomics);
	const base = 10n ** BigInt(decimals);
	const whole = value / base;
	const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
	return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Escrow a door's price and return the knock the API needs to see.
 *
 * `confirm` is handed the exact terms being signed (amount, token, door,
 * deadline) and must resolve truthy for the wallet to open. Nothing is signed
 * before it does, because this spends real money on a promise from a stranger.
 */
export async function escrowKnock({ doorAddress, message, onStatus = () => {}, confirm }) {
	const { Transaction } = await web3();
	const conn = await connection();

	onStatus('Reading this door on-chain');
	const door = await readDoor(conn, doorAddress);
	if (!door) {
		throw new EscrowError(
			'door_not_open',
			'This person has turned on the escrowed lane but has not opened their door on-chain yet. Use the normal lane, or come back shortly.',
		);
	}
	if (!door.open) throw new EscrowError('door_closed', 'This door is shut on-chain and is not taking knocks.');

	const provider = await wallet();
	const sender = provider.publicKey.toBase58();
	const senderTokens = ataFor(door.mint, sender, door.tokenProgram);

	onStatus('Checking your balance');
	const balance = await tokenBalance(conn, senderTokens);
	if (balance === null) {
		throw new EscrowError(
			'no_token_account',
			'This wallet holds none of the token this door is priced in. Fund it and try again.',
		);
	}
	if (balance < door.price) {
		throw new EscrowError(
			'insufficient_funds',
			`This door costs ${formatAmount(door.price, door.decimals)} and this wallet holds ${formatAmount(balance, door.decimals)}.`,
		);
	}

	const messageHash = sha256(String(message).trim());
	const nonce = await freeNonce(conn, door.address, sender);
	const knock = knockPda(door.address, sender, nonce);
	const expiresAt = Math.floor(Date.now() / 1000) + door.replyWindow;

	const agreed = await confirm({
		amount: formatAmount(door.price, door.decimals),
		amountAtomics: door.price.toString(),
		mint: door.mint,
		decimals: door.decimals,
		door: door.address,
		owner: door.owner,
		knock: knock.toBase58(),
		nonce,
		replyWindowSeconds: door.replyWindow,
		expiresAt,
	});
	if (!agreed) throw new EscrowError('cancelled', 'Nothing was signed and nothing was spent.');

	onStatus('Waiting for your wallet');
	const tx = new Transaction().add(
		knockIx({
			sender,
			door: door.address,
			mint: door.mint,
			senderTokens,
			nonce,
			messageHash,
			tokenProgram: door.tokenProgram,
		}),
	);
	const signature = await sendTx(conn, provider, tx, sender);

	onStatus('Escrow confirmed');
	return {
		signature,
		nonce,
		knock: knock.toBase58(),
		sender,
		amountAtomics: door.price.toString(),
		amount: formatAmount(door.price, door.decimals),
		mint: door.mint,
		decimals: door.decimals,
		expiresAt,
		messageHash: hex(messageHash),
	};
}

/**
 * Crank an expired knock's refund.
 *
 * Anyone can send this, including the sender themselves, and every token and
 * lamport in it goes to the sender's own accounts. It is offered on the page
 * because a guarantee nobody can act on is not a guarantee.
 */
export async function reclaimKnock({ knockAddress, onStatus = () => {} }) {
	const { PublicKey, Transaction } = await web3();
	const conn = await connection();

	onStatus('Reading the escrow');
	const info = await conn.getAccountInfo(new PublicKey(knockAddress));
	if (!info) throw new EscrowError('already_settled', 'This escrow is already closed. Nothing is being held.');
	const record = decodeKnock(info.data);
	if (record.state !== 0) {
		throw new EscrowError('already_settled', `This escrow was already ${KNOCK_STATE_NAME[record.state]}.`);
	}
	if (Math.floor(Date.now() / 1000) <= record.expiresAt) {
		throw new EscrowError(
			'not_expired',
			'The reply window is still open. The refund can be taken the moment it closes.',
		);
	}

	const provider = await wallet();
	const mintInfo = await conn.getAccountInfo(new PublicKey(record.mint));
	const tokenProgram = tokenProgramForOwner(mintInfo.owner.toBase58());

	onStatus('Waiting for your wallet');
	const tx = new Transaction().add(
		reclaimIx({
			cranker: provider.publicKey.toBase58(),
			door: record.door,
			knock: knockAddress,
			mint: record.mint,
			sender: record.sender,
			senderTokens: ataFor(record.mint, record.sender, tokenProgram),
			tokenProgram,
		}),
	);
	const signature = await sendTx(conn, provider, tx, provider.publicKey.toBase58());
	onStatus('Refunded');
	return { signature, amountAtomics: record.amount.toString(), sender: record.sender };
}

/**
 * Answer an escrowed knock and take the payment. Owner-signed.
 *
 * The reply text is hashed, not stored on-chain: the reply itself belongs to
 * the two people, and what the chain needs is only proof that an answer of
 * exactly this content was what released the money.
 */
export async function answerKnock({ knockAddress, reply, onStatus = () => {} }) {
	const { PublicKey, Transaction } = await web3();
	const conn = await connection();

	onStatus('Reading the escrow');
	const info = await conn.getAccountInfo(new PublicKey(knockAddress));
	if (!info) throw new EscrowError('already_settled', 'This escrow is already closed.');
	const record = decodeKnock(info.data);
	if (record.state !== 0) {
		throw new EscrowError('already_settled', `This escrow was already ${KNOCK_STATE_NAME[record.state]}.`);
	}
	if (Math.floor(Date.now() / 1000) > record.expiresAt) {
		throw new EscrowError(
			'window_closed',
			'The reply window closed, so this payment is owed back to the sender. Your reply still sends; the money does not.',
		);
	}

	const provider = await wallet();
	const owner = provider.publicKey.toBase58();
	const { tokenProgram, treasury } = await settlementContext(conn, record.mint);

	onStatus('Waiting for your wallet');
	const tx = new Transaction()
		.add(createAtaIfMissingIx({ payer: owner, owner, mint: record.mint, tokenProgram }))
		.add(createAtaIfMissingIx({ payer: owner, owner: treasury, mint: record.mint, tokenProgram }))
		.add(
			answerIx({
				owner,
				door: record.door,
				knock: knockAddress,
				mint: record.mint,
				sender: record.sender,
				ownerTokens: ataFor(record.mint, owner, tokenProgram),
				treasuryTokens: ataFor(record.mint, treasury, tokenProgram),
				replyHash: sha256(String(reply).trim()),
				tokenProgram,
			}),
		);
	const signature = await sendTx(conn, provider, tx, owner);
	onStatus('Paid out');
	return { signature, amountAtomics: record.amount.toString(), feeBps: record.feeBps };
}

/**
 * Decline an escrowed knock and hand it all back. Owner-signed, and no fee is
 * taken, because refusing to engage is not a service anybody should pay for.
 */
export async function refuseKnock({ knockAddress, onStatus = () => {} }) {
	const { PublicKey, Transaction } = await web3();
	const conn = await connection();

	const info = await conn.getAccountInfo(new PublicKey(knockAddress));
	if (!info) throw new EscrowError('already_settled', 'This escrow is already closed.');
	const record = decodeKnock(info.data);
	if (record.state !== 0) {
		throw new EscrowError('already_settled', `This escrow was already ${KNOCK_STATE_NAME[record.state]}.`);
	}

	const provider = await wallet();
	const mintInfo = await conn.getAccountInfo(new PublicKey(record.mint));
	const tokenProgram = tokenProgramForOwner(mintInfo.owner.toBase58());

	onStatus('Waiting for your wallet');
	const tx = new Transaction().add(
		refuseIx({
			owner: provider.publicKey.toBase58(),
			door: record.door,
			knock: knockAddress,
			mint: record.mint,
			sender: record.sender,
			senderTokens: ataFor(record.mint, record.sender, tokenProgram),
			tokenProgram,
		}),
	);
	const signature = await sendTx(conn, provider, tx, provider.publicKey.toBase58());
	onStatus('Refunded in full');
	return { signature, amountAtomics: record.amount.toString() };
}

/**
 * Open, reprice or shut the owner's own on-chain door.
 *
 * `handle` is hashed into the door id, so the address a stranger derives from
 * the same handle is the one this opens. There is no server step: the owner's
 * wallet is the only thing that can create this account.
 */
export async function openDoorOnChain({ handle, priceAtomics, replyWindowSeconds, mint, onStatus = () => {} }) {
	const { Transaction } = await web3();
	const conn = await connection();
	const provider = await wallet();
	const owner = provider.publicKey.toBase58();

	const address = doorPda(owner, doorId(handle));
	const existing = await readDoor(conn, address);

	onStatus('Waiting for your wallet');
	const tx = new Transaction().add(
		existing
			? setDoorIx({ owner, handle, priceAtomics, replyWindowSeconds, open: true })
			: openDoorIx({ owner, mint, priceAtomics, replyWindowSeconds, handle }),
	);
	const signature = await sendTx(conn, provider, tx, owner);
	onStatus(existing ? 'Door updated on-chain' : 'Door opened on-chain');
	return { signature, door: address.toBase58(), created: !existing };
}

// ── plumbing ────────────────────────────────────────────────────────────────

/** Sign, send and confirm one transaction through the connected wallet. */
async function sendTx(conn, provider, tx, feePayer) {
	const { PublicKey } = await web3();
	const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
	tx.feePayer = new PublicKey(feePayer);
	tx.recentBlockhash = blockhash;

	let signature;
	try {
		if (typeof provider.signAndSendTransaction === 'function') {
			({ signature } = await provider.signAndSendTransaction(tx));
		} else {
			const signed = await provider.signTransaction(tx);
			signature = await conn.sendRawTransaction(signed.serialize(), { maxRetries: 3 });
		}
	} catch (err) {
		// A wallet rejection is a decision, not a failure, and should not be
		// dressed up as one.
		if (/reject|denied|cancell?ed/i.test(err?.message || '')) {
			throw new EscrowError('cancelled', 'Nothing was signed and nothing was spent.');
		}
		throw err;
	}

	const result = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
	if (result?.value?.err) {
		throw new EscrowError('tx_failed', 'The transaction did not go through. Nothing was taken from your wallet.');
	}
	return signature;
}

/** A token account's balance, or null when the account does not exist. */
async function tokenBalance(conn, address) {
	const { PublicKey } = await web3();
	const info = await conn.getAccountInfo(new PublicKey(address));
	if (!info) return null;
	// SPL token accounts hold the amount as a u64 at byte 64 in both programs.
	return new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength).getBigUint64(64, true);
}

/**
 * A nonce with no knock account at it yet.
 *
 * Seconds since the epoch is unique per sender and door in every realistic
 * case; the loop covers the one that is not, two knocks inside one second,
 * because colliding would fail in the wallet with an error about an account
 * already in use.
 */
async function freeNonce(conn, door, sender) {
	const { PublicKey } = await web3();
	let nonce = Math.floor(Date.now() / 1000);
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const info = await conn.getAccountInfo(new PublicKey(knockPda(door, sender, nonce)));
		if (!info) return nonce;
		nonce += 1;
	}
	throw new EscrowError('nonce_exhausted', 'Too many knocks from this wallet at once. Try again in a moment.');
}

/** The token program and the protocol treasury an answer has to pay. */
async function settlementContext(conn, mint) {
	const { PublicKey } = await web3();
	const [mintInfo, configInfo] = await Promise.all([
		conn.getAccountInfo(new PublicKey(mint)),
		conn.getAccountInfo(configPda()),
	]);
	if (!configInfo) throw new EscrowError('not_initialized', 'The escrow program is not initialized on this cluster.');
	return {
		tokenProgram: tokenProgramForOwner(mintInfo.owner.toBase58()),
		treasury: decodeConfig(configInfo.data).treasury,
	};
}
