// agora-citizens — devnet keypair cache + faucet top-up. Each citizen (and the
// internal work dispatcher) keeps a stable signing keypair under .cache/ so it
// holds the same on-chain identity across restarts. Mirrors the proven approach
// in examples/agenc-task-roundtrip/run.mjs. NEVER commit .cache/ (see .gitignore).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { log } from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '.cache');

function safeName(key) {
	return String(key).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'kp';
}

/** Load a cached keypair for `key`, or generate + persist a fresh one. */
export async function loadOrCreateKeypair(key) {
	const file = path.join(CACHE_DIR, `${safeName(key)}.json`);
	try {
		const raw = await fs.readFile(file, 'utf8');
		return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
	} catch (err) {
		if (err.code !== 'ENOENT') throw err;
		await fs.mkdir(CACHE_DIR, { recursive: true });
		const kp = Keypair.generate();
		await fs.writeFile(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
		log.info('keypair generated', { key, pubkey: kp.publicKey.toBase58() });
		return kp;
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parse a devnet funder secret: base58 (Phantom export) or a JSON byte array. */
export function keypairFromSecret(secret) {
	const raw = String(secret).trim();
	if (raw.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
	return Keypair.fromSecretKey(bs58.decode(raw));
}

let funderCache;
function loadFunder(cfg) {
	if (!cfg.funderSecret) return null;
	if (funderCache === undefined) {
		try {
			funderCache = keypairFromSecret(cfg.funderSecret);
			log.info('devnet funder loaded', { pubkey: funderCache.publicKey.toBase58() });
		} catch (err) {
			funderCache = null;
			log.error('AGORA_DEVNET_FUNDER_SECRET is not a valid keypair', { err: err?.message });
		}
	}
	return funderCache;
}

/**
 * Top a signer up from the configured devnet funder wallet. The public faucet is
 * routinely dry (it answers 429 for every IP we reach it from, workstation and
 * GCP alike), so an operator-supplied devnet wallet is the reliable rail: a real
 * SystemProgram transfer of worthless test SOL, confirmed on-chain. Returns the
 * transfer signature, or null when no funder is configured / it is too poor.
 */
async function topUpFromFunder(connection, kp, cfg, label) {
	const funder = loadFunder(cfg);
	if (!funder) return null;
	if (funder.publicKey.equals(kp.publicKey)) return null;

	const target = cfg.topupThresholdLamports + cfg.funderTopupLamports;
	const bal = await connection.getBalance(kp.publicKey);
	const need = target - bal;
	if (need <= 0) return null;

	const funderBal = await connection.getBalance(funder.publicKey);
	// Leave the funder enough to pay the fee on this transfer and the next one.
	if (funderBal < need + FUNDER_RESERVE_LAMPORTS) {
		log.warn('devnet funder too poor to top up', {
			label,
			funder: funder.publicKey.toBase58(),
			funderSol: funderBal / LAMPORTS_PER_SOL,
			needSol: need / LAMPORTS_PER_SOL,
		});
		return null;
	}

	const tx = new Transaction().add(
		SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: kp.publicKey, lamports: need }),
	);
	const sig = await sendAndConfirmTransaction(connection, tx, [funder], { commitment: 'confirmed' });
	log.info('funder top-up confirmed', {
		label,
		sol: need / LAMPORTS_PER_SOL,
		sig,
		balance: (await connection.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL,
	});
	return sig;
}

// Fee headroom the funder always keeps for itself (0.01 SOL covers thousands of
// devnet transfers, so a top-up never strands the funder mid-fleet).
const FUNDER_RESERVE_LAMPORTS = 10_000_000;

/**
 * Keep a signer funded above cfg.topupThresholdLamports. When a devnet funder
 * wallet is configured it is tried first (deterministic, and the public faucet
 * is dry far more often than not); otherwise, and as a fallback, we request the
 * faucet in shrinking chunks with backoff (the @solana/web3.js example-script
 * pattern) before surfacing a manual-funding error. Returns the funding tx
 * signature when one was performed, else null.
 */
export async function ensureBalance(connection, kp, cfg, label) {
	// Nothing to keep it above: the caller funds this signer some other way.
	if (!(cfg.topupThresholdLamports > 0)) return null;
	// A transient RPC failure on this read is NOT a reason to drop the signer. The
	// read only decides whether to top up; if we cannot tell, proceed and let the
	// real transaction be the judge. Throwing here used to lose a citizen from the
	// fleet for the whole process, and a rate-limited RPC lost all of them at once.
	let bal = null;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			bal = await connection.getBalance(kp.publicKey);
			break;
		} catch (err) {
			log.warn('balance read failed', { label, attempt: attempt + 1, err: err?.message });
			await sleep(cfg.retryBaseMs * (attempt + 1));
		}
	}
	if (bal === null) return null;
	if (bal >= cfg.topupThresholdLamports) return null;

	try {
		const funded = await topUpFromFunder(connection, kp, cfg, label);
		if (funded) return funded;
	} catch (err) {
		log.warn('funder top-up failed, falling back to the faucet', { label, err: err?.message });
	}

	const full = cfg.airdropLamports || LAMPORTS_PER_SOL;
	const chunks = [full, full / 2, full / 4, full / 10];
	let lastErr = null;
	for (let attempt = 0; attempt < chunks.length; attempt++) {
		const lamports = Math.max(Math.floor(chunks[attempt]), Math.floor(LAMPORTS_PER_SOL / 100));
		try {
			const sig = await connection.requestAirdrop(kp.publicKey, lamports);
			await connection.confirmTransaction(sig, 'confirmed');
			const newBal = await connection.getBalance(kp.publicKey);
			log.info('airdrop confirmed', { label, sol: lamports / LAMPORTS_PER_SOL, sig, balance: newBal / LAMPORTS_PER_SOL });
			if (newBal >= cfg.topupThresholdLamports) return sig;
		} catch (err) {
			lastErr = err;
			const waitMs = cfg.retryBaseMs * (attempt + 1);
			log.warn('airdrop attempt failed', { label, attempt: attempt + 1, err: err?.message, retryMs: waitMs });
			await sleep(waitMs);
		}
	}
	throw new Error(
		`[agora-citizens] ${label}: devnet faucet exhausted retries. Fund ${kp.publicKey.toBase58()} at https://faucet.solana.com, or set AGORA_DEVNET_FUNDER_SECRET to a funded devnet wallet. Underlying: ${lastErr?.message || lastErr}`,
	);
}
