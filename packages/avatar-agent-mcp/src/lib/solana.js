// Solana primitives: keypair load, balances, transfers.
//
// Every signer-required tool accepts an optional base58 `secret` in the
// tool arguments. If not provided, it falls back to SOLANA_SECRET_KEY /
// FUNDER_SECRET from the environment. We never embed default keys.

import {
	Connection,
	Keypair,
	PublicKey,
	SystemProgram,
	TransactionMessage,
	VersionedTransaction,
	ComputeBudgetProgram,
	LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import bs58 from 'bs58';

import { SOLANA_RPC_URL, SOLANA_DEFAULT_SECRET } from '../config.js';

const bs58encode = bs58.default ? bs58.default.encode : bs58.encode;
const bs58decode = bs58.default ? bs58.default.decode : bs58.decode;

export { bs58encode, bs58decode, LAMPORTS_PER_SOL };

let _conn = null;
export function getConnection() {
	if (!_conn) _conn = new Connection(SOLANA_RPC_URL, 'confirmed');
	return _conn;
}

export function isValidPubkey(s) {
	try {
		new PublicKey(s);
		return true;
	} catch {
		return false;
	}
}

export function keypairFromSecret(secret) {
	const trimmed = String(secret || '').trim();
	if (!trimmed) {
		const err = new Error(
			'Solana secret required. Pass `secret` (base58) in the tool call, ' +
				'or set SOLANA_SECRET_KEY in the MCP server environment.',
		);
		err.code = 'no_signer';
		throw err;
	}
	const bytes = bs58decode(trimmed);
	if (bytes.length !== 64) {
		const err = new Error(`Solana secret must decode to 64 bytes (got ${bytes.length})`);
		err.code = 'invalid_secret';
		throw err;
	}
	return Keypair.fromSecretKey(bytes);
}

export function loadSigner(secret) {
	return keypairFromSecret(secret || SOLANA_DEFAULT_SECRET);
}

export async function getBalanceSol(pubkeyStr) {
	const conn = getConnection();
	const lamports = await conn.getBalance(new PublicKey(pubkeyStr), 'confirmed');
	return { lamports, sol: lamports / LAMPORTS_PER_SOL };
}

export async function getTokenBalances(pubkeyStr) {
	const conn = getConnection();
	const owner = new PublicKey(pubkeyStr);
	// SPL Token program — fetch parsed accounts so we get mint + amount cleanly.
	const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
	const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
	const [legacy, t22] = await Promise.all([
		conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM }),
		conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM }),
	]);
	const all = [...legacy.value, ...t22.value];
	return all
		.map((r) => {
			const info = r.account.data?.parsed?.info;
			if (!info) return null;
			const amount = info.tokenAmount;
			return {
				mint: info.mint,
				owner: info.owner,
				account: r.pubkey.toBase58(),
				amount: amount?.amount,
				uiAmount: amount?.uiAmount,
				uiAmountString: amount?.uiAmountString,
				decimals: amount?.decimals,
			};
		})
		.filter(Boolean)
		.filter((t) => Number(t.uiAmount) > 0);
}

export async function sendSol({ secret, to, sol, priorityMicroLamports = 100000 }) {
	if (!isValidPubkey(to)) {
		const err = new Error(`Destination is not a valid Solana pubkey: ${to}`);
		err.code = 'invalid_destination';
		throw err;
	}
	const signer = loadSigner(secret);
	const conn = getConnection();
	const lamports = Math.floor(Number(sol) * LAMPORTS_PER_SOL);
	if (!Number.isFinite(lamports) || lamports <= 0) {
		const err = new Error(`sol must be a positive number (got ${sol})`);
		err.code = 'invalid_amount';
		throw err;
	}
	const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
	const msg = new TransactionMessage({
		payerKey: signer.publicKey,
		recentBlockhash: blockhash,
		instructions: [
			ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }),
			ComputeBudgetProgram.setComputeUnitLimit({ units: 1000 }),
			SystemProgram.transfer({
				fromPubkey: signer.publicKey,
				toPubkey: new PublicKey(to),
				lamports,
			}),
		],
	}).compileToV0Message();
	const tx = new VersionedTransaction(msg);
	tx.sign([signer]);
	const sig = await conn.sendTransaction(tx, { maxRetries: 5 });
	const conf = await conn.confirmTransaction(
		{ signature: sig, blockhash, lastValidBlockHeight },
		'confirmed',
	);
	if (conf?.value?.err) {
		const err = new Error(`Transaction failed: ${JSON.stringify(conf.value.err)}`);
		err.code = 'tx_failed';
		err.signature = sig;
		throw err;
	}
	return {
		signature: sig,
		from: signer.publicKey.toBase58(),
		to,
		sol: Number(sol),
		lamports,
		explorer: `https://solscan.io/tx/${sig}`,
	};
}

// Vanity grinder. Returns the first keypair whose base58 pubkey matches the
// given prefix and/or suffix (case-sensitive by default). The user can cap
// max attempts to keep the call bounded.
export function grindVanity({ prefix = '', suffix = '', caseSensitive = true, maxAttempts = 500_000 }) {
	const pre = String(prefix || '');
	const suf = String(suffix || '');
	if (!pre && !suf) {
		const err = new Error('Provide at least a prefix or suffix to grind for.');
		err.code = 'invalid_input';
		throw err;
	}
	const matches = (b58) => {
		const candidate = caseSensitive ? b58 : b58.toLowerCase();
		const p = caseSensitive ? pre : pre.toLowerCase();
		const s = caseSensitive ? suf : suf.toLowerCase();
		if (p && !candidate.startsWith(p)) return false;
		if (s && !candidate.endsWith(s)) return false;
		return true;
	};
	const startedAt = Date.now();
	for (let i = 0; i < maxAttempts; i++) {
		const kp = Keypair.generate();
		const b58 = kp.publicKey.toBase58();
		if (matches(b58)) {
			return {
				found: true,
				attempts: i + 1,
				durationMs: Date.now() - startedAt,
				pubkey: b58,
				secret: bs58encode(kp.secretKey),
			};
		}
	}
	return {
		found: false,
		attempts: maxAttempts,
		durationMs: Date.now() - startedAt,
		message: `No match for prefix="${pre}" suffix="${suf}" in ${maxAttempts} attempts. Try a shorter pattern or a higher maxAttempts.`,
	};
}
