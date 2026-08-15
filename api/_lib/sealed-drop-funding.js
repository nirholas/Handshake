/**
 * Real on-chain funding + reclaim rails for sealed wallet drops.
 *
 * Funding model: when a drop is created (and the x402 create fee is settled),
 * the platform moves REAL funds into the freshly-ground drop address from its
 * Solana funding wallet (`VANITY_DROP_FUNDING_KEY`, falling back to the bounty
 * payout key, then the club treasury secret — every custodial-money endpoint on
 * the platform shares this resolution). Three assets are supported:
 *   • SOL   — native System transfer (lamports).
 *   • USDC  — SPL transfer (the x402 rail asset; never marketed as a coin).
 *   • THREE — SPL transfer of the platform's only coin, $THREE.
 * Balances are read live via the Helius-backed connection. No fake balances:
 * funding is confirmed on-chain BEFORE a drop is shown as claimable.
 *
 * Reclaim model: an EXPIRED, unclaimed drop's funds are swept back to the
 * sender's reclaim address. The sweep is signed by the drop wallet's own key,
 * which the platform can reconstruct only because the SAME plaintext it sealed
 * to the recipient is also held encrypted at rest under secret-box (AES-256-GCM)
 * for the reclaim path — and ONLY for reclaim. (The recipient's E2E guarantee is
 * unaffected: that at-rest copy is the drop wallet's key, used solely to refund
 * the sender on expiry; the claim path always delivers the SEALED envelope the
 * recipient opens with their own key.) The sweep is exactly-once: the store's
 * funded→reclaimed compare-and-set runs first and records the resulting tx.
 *
 * Money-safety invariants:
 *   • Funding is confirmed (`confirmed` commitment) before createDrop persists a
 *     claimable record; a funding failure aborts the create with the fee unsettled.
 *   • A drop is EITHER claimed (recipient opens it) OR reclaimed (sender refunded),
 *     never both — the two store transitions are mutually-exclusive CAS.
 *   • Reclaim is idempotent: a reclaimed drop that already carries a reclaimTx
 *     short-circuits instead of sweeping again.
 */

import bs58 from 'bs58';
import {
	Keypair,
	PublicKey,
	SystemProgram,
	LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
	getAssociatedTokenAddress,
	createAssociatedTokenAccountInstruction,
	createTransferInstruction,
	getAccount,
} from '@solana/spl-token';

import { env } from './env.js';
import { solanaConnection } from './agent-pumpfun.js';
import { submitProtected } from './execution-engine.js';
import { SOLANA_USDC_MINT } from '../payments/_config.js';
import { recordReclaim } from './sealed-drop-store.js';

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// Network fee headroom left in a SOL drop so the wallet can pay rent/fees when
// the recipient sweeps it onward (a drop with exactly 0 lamports of headroom
// can't even create its own ATA). Kept small so the gift is mostly the gift.
const SOL_FEE_HEADROOM_LAMPORTS = 0; // SOL drops fund the exact amount; recipient sweeps natively.

/** Resolve the platform funding wallet as a Base58 64-byte secret, or null. */
function resolveFundingKeyBase58() {
	const candidates = [
		env.VANITY_DROP_FUNDING_KEY,
		env.VANITY_BOUNTY_PAYOUT_KEY,
	].filter(Boolean);
	for (const raw of candidates) {
		const s = String(raw).trim();
		try {
			if (bs58.decode(s).length === 64) return s;
		} catch {
			/* try base64 */
		}
		try {
			const buf = Buffer.from(s, 'base64');
			if (buf.byteLength === 64) return bs58.encode(buf);
		} catch {
			/* ignore */
		}
	}
	const clubB64 = process.env.CLUB_SOLANA_TREASURY_SECRET_KEY_B64;
	if (clubB64) {
		try {
			const buf = Buffer.from(clubB64, 'base64');
			if (buf.byteLength === 64) return bs58.encode(buf);
		} catch {
			/* ignore */
		}
	}
	return null;
}

/** True when the platform can actually fund drops (wallet configured + valid). */
export function fundingConfigured() {
	return !!resolveFundingKeyBase58();
}

/**
 * The platform funding wallet's public address, or null when unconfigured. This
 * is where a drop's funds go back to when a create is rolled back (the fee failed
 * to settle after the wallet was already funded): the money returns to exactly
 * the wallet it left.
 */
export function fundingWalletAddress() {
	const key = resolveFundingKeyBase58();
	if (!key) return null;
	return Keypair.fromSecretKey(bs58.decode(key)).publicKey.toBase58();
}

function fundingKeypair() {
	const key = resolveFundingKeyBase58();
	if (!key) {
		throw Object.assign(
			new Error('drop funding wallet is not configured — set VANITY_DROP_FUNDING_KEY (Base58 64-byte secret)'),
			{ status: 503, code: 'funding_unconfigured' },
		);
	}
	return Keypair.fromSecretKey(bs58.decode(key));
}

/** The $THREE mint — the only coin a drop may be funded with as a *coin*. */
function threeMint() {
	return env.THREE_TOKEN_MINT;
}

/** SPL mint for a drop asset (USDC rail or $THREE coin). SOL has no mint. */
function mintForAsset(asset) {
	if (asset === 'USDC') return SOLANA_USDC_MINT;
	if (asset === 'THREE') return threeMint();
	return null;
}

/** Decimals for an asset → atomics conversion. */
export function decimalsForAsset(asset) {
	if (asset === 'SOL') return 9;
	if (asset === 'USDC') return 6;
	if (asset === 'THREE') return Number(env.THREE_TOKEN_DECIMALS) || 6;
	throw Object.assign(new Error(`unknown asset ${asset}`), { status: 400, code: 'invalid_asset' });
}

/** Convert a human amount (string/number) to atomics (BigInt) for an asset. */
export function amountToAtomics(amount, asset) {
	const decimals = decimalsForAsset(asset);
	const s = String(amount).trim();
	if (!/^\d+(\.\d+)?$/.test(s)) {
		throw Object.assign(new Error('amount must be a positive decimal number'), { status: 400, code: 'invalid_amount' });
	}
	const [whole, frac = ''] = s.split('.');
	if (frac.length > decimals) {
		throw Object.assign(new Error(`amount has more than ${decimals} decimal places for ${asset}`), { status: 400, code: 'invalid_amount' });
	}
	const padded = (whole + frac.padEnd(decimals, '0')).replace(/^0+(?=\d)/, '');
	const atomics = BigInt(padded || '0');
	if (atomics <= 0n) {
		throw Object.assign(new Error('amount must be greater than zero'), { status: 400, code: 'invalid_amount' });
	}
	return atomics;
}

/** Format atomics back to a human string for display. */
export function atomicsToAmount(atomics, asset) {
	const decimals = decimalsForAsset(asset);
	const a = BigInt(atomics);
	const s = a.toString().padStart(decimals + 1, '0');
	const whole = s.slice(0, -decimals) || '0';
	const frac = s.slice(-decimals).replace(/0+$/, '');
	return frac ? `${whole}.${frac}` : whole;
}

/**
 * Fund a freshly-ground drop address on-chain from the platform funding wallet.
 * Confirms the transfer before returning. Throws (with the create aborted) on
 * any failure so a drop is never shown as claimable without real funds behind it.
 *
 * @param {object} p
 * @param {string} p.toAddress  - the drop wallet's Base58 address.
 * @param {string} p.asset      - 'SOL' | 'USDC' | 'THREE'.
 * @param {bigint} p.atomics    - amount in smallest units.
 * @returns {Promise<{ fundingTx:string, atomics:string, asset:string }>}
 */
export async function fundDropAddress({ toAddress, asset, atomics }) {
	if (!BASE58_RE.test(String(toAddress || ''))) {
		throw Object.assign(new Error('drop address must be a Base58 Solana address'), { status: 400, code: 'invalid_address' });
	}
	const amount = BigInt(atomics);
	if (amount <= 0n) {
		throw Object.assign(new Error('funding amount must be positive'), { status: 400, code: 'invalid_amount' });
	}
	const payer = fundingKeypair();
	const recipient = new PublicKey(toAddress);
	const conn = solanaConnection('mainnet');

	const instructions = [];
	if (asset === 'SOL') {
		instructions.push(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient, lamports: amount }));
	} else {
		const mint = new PublicKey(mintForAsset(asset));
		const fromATA = await getAssociatedTokenAddress(mint, payer.publicKey);
		const toATA = await getAssociatedTokenAddress(mint, recipient);
		const toInfo = await conn.getAccountInfo(toATA);
		if (!toInfo) {
			instructions.push(createAssociatedTokenAccountInstruction(payer.publicKey, toATA, recipient, mint));
		}
		instructions.push(createTransferInstruction(fromATA, toATA, payer.publicKey, amount));
	}

	// Protected send: priority fee + CU estimate, rebroadcast with blockhash
	// refresh, hard throw on revert.
	const { signature: sig } = await submitProtected({ network: 'mainnet', connection: conn, payer, instructions });
	return { fundingTx: sig, atomics: amount.toString(), asset };
}

/**
 * Read the live on-chain balance of a drop address for its funded asset.
 * Never throws — an RPC blip returns null so the claim UI degrades to "checking".
 * @returns {Promise<{ atomics:string|null }>}
 */
export async function readDropBalance({ address, asset }) {
	try {
		const conn = solanaConnection('mainnet');
		const owner = new PublicKey(address);
		if (asset === 'SOL') {
			const lamports = await conn.getBalance(owner, 'confirmed');
			return { atomics: String(lamports) };
		}
		const mint = new PublicKey(mintForAsset(asset));
		const ata = await getAssociatedTokenAddress(mint, owner);
		try {
			const acct = await getAccount(conn, ata);
			return { atomics: acct.amount.toString() };
		} catch {
			return { atomics: '0' }; // no ATA yet → zero
		}
	} catch {
		return { atomics: null };
	}
}

/**
 * Sweep an EXPIRED, reclaimed drop's funds back to the sender's reclaim address.
 * Signs with the drop wallet's OWN key (reconstructed from the at-rest encrypted
 * copy by the caller and passed in as `dropSecretKey`). For SOL it sweeps the
 * full balance minus the network fee; for SPL it sweeps the full token balance
 * (the drop wallet must hold a little SOL for the fee — funded drops always do
 * because USDC/THREE funding created the recipient ATA with the platform paying,
 * so the sweep fee is paid by the platform funding wallet as fee-payer).
 *
 * Idempotent: a drop that already carries a reclaimTx returns it without sweeping.
 *
 * @param {object} p
 * @param {object} p.record       - the drop record (must be status 'reclaimed').
 * @param {Uint8Array} p.dropSecretKey - the 64-byte secret of the drop wallet.
 * @param {string} p.toAddress    - the sender's reclaim Base58 address.
 * @returns {Promise<{ reclaimTx:string, alreadyReclaimed:boolean }>}
 */
export async function sweepReclaim({ record, dropSecretKey, toAddress }) {
	if (!record) throw Object.assign(new Error('drop not found'), { status: 404, code: 'not_found' });
	if (record.status !== 'reclaimed') {
		throw Object.assign(new Error(`drop is ${record.status}, not reclaimed — cannot sweep`), { status: 409, code: 'not_reclaimable' });
	}
	if (record.reclaimTx) {
		return { reclaimTx: record.reclaimTx, alreadyReclaimed: true };
	}
	if (!BASE58_RE.test(String(toAddress || ''))) {
		throw Object.assign(new Error('reclaim address must be a Base58 Solana address'), { status: 400, code: 'invalid_reclaim_address' });
	}

	const dropKp = Keypair.fromSecretKey(dropSecretKey);
	const feePayer = fundingKeypair(); // platform pays the sweep network fee
	const recipient = new PublicKey(toAddress);
	const conn = solanaConnection('mainnet');
	const asset = record.asset;

	const instructions = [];
	if (asset === 'SOL') {
		const lamports = await conn.getBalance(dropKp.publicKey, 'confirmed');
		if (lamports <= 0) {
			// Nothing to sweep (already empty) — treat as a completed reclaim.
			await recordReclaim({ id: record.id, reclaimTx: 'empty' });
			return { reclaimTx: 'empty', alreadyReclaimed: false };
		}
		// Fee is paid by the platform fee-payer, so the full drop balance moves.
		instructions.push(SystemProgram.transfer({ fromPubkey: dropKp.publicKey, toPubkey: recipient, lamports }));
	} else {
		const mint = new PublicKey(mintForAsset(asset));
		const fromATA = await getAssociatedTokenAddress(mint, dropKp.publicKey);
		let amount = 0n;
		try {
			amount = (await getAccount(conn, fromATA)).amount;
		} catch {
			amount = 0n;
		}
		if (amount <= 0n) {
			await recordReclaim({ id: record.id, reclaimTx: 'empty' });
			return { reclaimTx: 'empty', alreadyReclaimed: false };
		}
		const toATA = await getAssociatedTokenAddress(mint, recipient);
		const toInfo = await conn.getAccountInfo(toATA);
		if (!toInfo) {
			instructions.push(createAssociatedTokenAccountInstruction(feePayer.publicKey, toATA, recipient, mint));
		}
		instructions.push(createTransferInstruction(fromATA, toATA, dropKp.publicKey, amount));
	}

	// Protected send: platform fee-payer pays + signs, the drop wallet co-signs the
	// transfer of its own balance. Priority fee + CU estimate, rebroadcast with
	// blockhash refresh, hard throw on an on-chain revert.
	const { signature: sig } = await submitProtected({
		network: 'mainnet',
		connection: conn,
		payer: feePayer,
		instructions,
		opts: { extraSigners: [dropKp] },
	});
	await recordReclaim({ id: record.id, reclaimTx: sig });
	return { reclaimTx: sig, alreadyReclaimed: false };
}

export { BASE58_RE, LAMPORTS_PER_SOL, SOL_FEE_HEADROOM_LAMPORTS };
