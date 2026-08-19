// Connection, key handling, balances, token metadata, and explorer links.

import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
	getMint,
	getAccount,
	getAssociatedTokenAddressSync,
	TokenAccountNotFoundError,
	TokenInvalidAccountOwnerError,
	TokenInvalidAccountSizeError,
	TOKEN_PROGRAM_ID,
	TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';

import { NETWORK, rpcFor } from '../config.js';

export { LAMPORTS_PER_SOL, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };

// Circle's canonical USDC mints. The default asset for agent spending because
// x402 prices in it and it is the deepest stable on Solana.
export const USDC_MINT = {
	mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};

// A signature costs 5000 lamports. An agent pays its own fees, so it needs a
// little SOL of its own; this is the floor below which it cannot transact.
export const MIN_AGENT_FEE_LAMPORTS = 5_000 * 20;

const connections = new Map();

/** Cached Connection per network. Confirmed commitment: fast, and final enough to gate a spend. */
export function connectionFor(network = NETWORK) {
	const net = network === 'devnet' ? 'devnet' : 'mainnet';
	if (!connections.has(net)) {
		connections.set(net, new Connection(rpcFor(net), { commitment: 'confirmed' }));
	}
	return connections.get(net);
}

/** Parse a base58 secret key or a JSON byte array into a Keypair. */
export function keypairFrom(secret, label = 'secret') {
	const raw = String(secret || '').trim();
	if (!raw) {
		throw Object.assign(new Error(`No ${label} available. Pass one, or set OWNER_SECRET_KEY.`), { code: 'no_signer' });
	}
	let bytes;
	if (raw.startsWith('[')) {
		try {
			bytes = Uint8Array.from(JSON.parse(raw));
		} catch {
			throw Object.assign(new Error(`${label} looks like a JSON array but does not parse`), { code: 'bad_secret' });
		}
	} else {
		try {
			bytes = bs58.decode(raw);
		} catch {
			throw Object.assign(new Error(`${label} is not valid base58`), { code: 'bad_secret' });
		}
	}
	if (bytes.length !== 64) {
		throw Object.assign(new Error(`${label} must be a 64-byte keypair (got ${bytes.length} bytes)`), {
			code: 'bad_secret',
		});
	}
	return Keypair.fromSecretKey(bytes);
}

/** Validate and normalize an address, with a field name that survives into the error. */
export function toPublicKey(value, field = 'address') {
	try {
		return new PublicKey(String(value).trim());
	} catch {
		throw Object.assign(new Error(`${field} is not a valid Solana address: "${value}"`), { code: 'bad_address' });
	}
}

/** SOL balance of an address, in SOL. */
export async function solBalance(connection, address) {
	const lamports = await connection.getBalance(toPublicKey(address, 'address'));
	return lamports / LAMPORTS_PER_SOL;
}

/**
 * Which token program owns this mint: classic SPL Token or Token-2022. Every
 * instruction we build is threaded with it, so a Token-2022 mint works without
 * a special case anywhere else.
 */
const programCache = new Map();
export async function tokenProgramFor(connection, mint) {
	const key = `${connection.rpcEndpoint}:${mint}`;
	if (programCache.has(key)) return programCache.get(key);
	const info = await connection.getAccountInfo(toPublicKey(mint, 'mint'));
	if (!info) {
		throw Object.assign(new Error(`mint ${mint} does not exist on this cluster`), { code: 'unknown_mint' });
	}
	const owner = info.owner;
	if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) {
		throw Object.assign(new Error(`${mint} is not an SPL token mint (owned by ${owner.toBase58()})`), {
			code: 'unknown_mint',
		});
	}
	programCache.set(key, owner);
	return owner;
}

/** Decimals for a mint, read from the chain. Cached: a mint's decimals never change. */
const decimalsCache = new Map();
export async function mintDecimals(connection, mint, programId) {
	const key = `${connection.rpcEndpoint}:${mint}`;
	if (decimalsCache.has(key)) return decimalsCache.get(key);
	const program = programId || (await tokenProgramFor(connection, mint));
	const info = await getMint(connection, toPublicKey(mint, 'mint'), undefined, program);
	decimalsCache.set(key, info.decimals);
	return info.decimals;
}

/** Human amount to base units, without float drift. */
export function toBaseUnits(amount, decimals) {
	const s = String(amount).trim();
	if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') {
		throw Object.assign(new Error(`amount must be a positive decimal number (got "${amount}")`), {
			code: 'bad_amount',
		});
	}
	const [whole, frac = ''] = s.split('.');
	if (frac.length > decimals) {
		throw Object.assign(
			new Error(`amount has ${frac.length} decimal places but the mint only has ${decimals}`),
			{ code: 'bad_amount' },
		);
	}
	return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** Base units back to a human decimal string, exact. */
export function fromBaseUnits(units, decimals) {
	const n = BigInt(units);
	const d = 10n ** BigInt(decimals);
	const whole = n / d;
	const frac = (n % d).toString().padStart(decimals, '0').replace(/0+$/, '');
	return frac ? `${whole}.${frac}` : String(whole);
}

/**
 * Token account state, or null when the account does not exist yet.
 *
 * spl-token signals a missing account by throwing a typed error whose message
 * is empty, so this matches on the error class rather than its text.
 */
export async function tokenAccount(connection, address, programId = TOKEN_PROGRAM_ID) {
	try {
		return await getAccount(connection, toPublicKey(address, 'token account'), undefined, programId);
	} catch (err) {
		const missing =
			err instanceof TokenAccountNotFoundError ||
			err instanceof TokenInvalidAccountOwnerError ||
			err instanceof TokenInvalidAccountSizeError ||
			/could not find account|TokenAccountNotFound|TokenInvalidAccountOwner/i.test(err?.name || err?.message || '');
		if (missing) return null;
		throw err;
	}
}

/** The owner's associated token account for a mint. allowOwnerOffCurve: PDAs can hold tokens too. */
export function ataFor(mint, owner, programId = TOKEN_PROGRAM_ID) {
	return getAssociatedTokenAddressSync(toPublicKey(mint, 'mint'), toPublicKey(owner, 'owner'), true, programId);
}

const cluster = (network) => (network === 'devnet' ? '?cluster=devnet' : '');

export function txLink(signature, network = NETWORK) {
	return `https://solscan.io/tx/${signature}${cluster(network)}`;
}

export function accountLink(address, network = NETWORK) {
	return `https://solscan.io/account/${address}${cluster(network)}`;
}
