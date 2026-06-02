// The $THREE burn engine.
//
// Reads the PUBLIC three.ws token surface — /api/token/config (mint, decimals,
// burn + treasury addresses) and /api/token/price (live Jupiter USD pricing) —
// then builds, signs, sends, and confirms a single Solana transaction that
// splits a USD-denominated amount of $THREE between the incinerator and the
// treasury. Nothing about the destinations or the split is hardcoded here: it
// always tracks the canonical on-chain config the rest of three.ws uses.
//
// The transaction shape mirrors the proven browser flow in src/token-pay.js:
// one idempotent ATA-create + SPL transfer per leg, plus a memo carrying a tag
// so the burn is attributable on-chain.

import { Transaction, TransactionInstruction } from '@solana/web3.js';
import {
	createAssociatedTokenAccountIdempotentInstruction,
	createTransferInstruction,
	getAssociatedTokenAddressSync,
} from '@solana/spl-token';

import { THREE_WS_BASE, MEMO_PROGRAM_ID } from '../config.js';
import {
	PublicKey,
	getConnection,
	getSplBalance,
	loadSigner,
} from './solana.js';

async function getJson(path) {
	const url = `${THREE_WS_BASE}${path}`;
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	const body = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw Object.assign(new Error(body.error_description || body.error || `GET ${path} ${res.status}`), {
			code: body.error || `http_${res.status}`,
		});
	}
	return body;
}

/** Public token config: { mint, symbol, decimals, treasury, burn_address, ... }. */
export function fetchTokenConfig() {
	return getJson('/api/token/config');
}

/**
 * Live $THREE price. Pass `usd` to also receive a token-amount quote
 * ({ usd, token_amount, atomics }).
 */
export function fetchTokenPrice(usd) {
	const q = usd != null ? `?usd=${encodeURIComponent(usd)}` : '';
	return getJson(`/api/token/price${q}`);
}

const fmt = (atomics, decimals) => Number(BigInt(atomics)) / 10 ** decimals;

/**
 * Split `totalAtomics` of $THREE into burn + treasury legs.
 * @param {bigint} totalAtomics
 * @param {number} burnBps    — share to the incinerator in basis points (0–10000)
 * @param {object} config     — output of fetchTokenConfig()
 * @returns {{ role: string, address: string, atomics: bigint }[]}
 */
export function computeSplit(totalAtomics, burnBps, config) {
	const total = BigInt(totalAtomics);
	const bps = Math.max(0, Math.min(10_000, Math.round(burnBps)));
	let burnAtomics = (total * BigInt(bps)) / 10_000n;
	let treasuryAtomics = total - burnAtomics;
	const legs = [];
	// Assign any rounding dust to the burn leg so we never under-burn.
	if (treasuryAtomics > 0n && config.treasury) {
		legs.push({ role: 'treasury', address: config.treasury, atomics: treasuryAtomics });
	} else {
		burnAtomics = total;
	}
	if (burnAtomics > 0n) {
		legs.unshift({ role: 'burn', address: config.burn_address, atomics: burnAtomics });
	}
	return legs;
}

/**
 * Buy is out of scope — this burns $THREE the wallet already holds. Quote a USD
 * amount to atomics via Jupiter, split it burn/treasury, sign, send, confirm.
 *
 * @param {object} p
 * @param {number} p.usd        — USD value of $THREE to burn (> 0)
 * @param {number} [p.burnBps]  — incinerator share in bps (default 5000 = 50%)
 * @param {string} [p.secret]   — base58 signer override (else SOLANA_SECRET_KEY)
 * @param {string} [p.memo]     — extra memo text appended to the on-chain tag
 * @returns {Promise<object>} receipt
 */
export async function burnThree({ usd, burnBps = 5000, secret, memo }) {
	if (!(Number(usd) > 0)) {
		throw Object.assign(new Error('usd must be a positive number'), { code: 'bad_amount' });
	}

	const signer = loadSigner(secret);
	const payer = signer.publicKey;

	const [config, price] = await Promise.all([fetchTokenConfig(), fetchTokenPrice(usd)]);
	if (!config.mint || !config.burn_address) {
		throw Object.assign(new Error('token config missing mint/burn_address'), { code: 'config_incomplete' });
	}
	if (!price.quote?.atomics) {
		throw Object.assign(new Error('price endpoint returned no quote for the requested usd'), { code: 'no_quote' });
	}

	const decimals = config.decimals;
	const total = BigInt(price.quote.atomics);
	const legs = computeSplit(total, burnBps, config);

	// Fail fast with a clear error if the wallet can't cover the burn, rather
	// than letting the transfer fail opaquely on-chain.
	const held = await getSplBalance(payer.toBase58(), config.mint);
	if (BigInt(held.atomics) < total) {
		throw Object.assign(
			new Error(
				`insufficient $THREE: need ${fmt(total, decimals)} ${config.symbol} (~$${usd}), wallet holds ${held.uiAmount}`,
			),
			{ code: 'insufficient_balance' },
		);
	}

	const conn = getConnection();
	const mintPk = new PublicKey(config.mint);
	const fromAta = getAssociatedTokenAddressSync(mintPk, payer);

	const tx = new Transaction();
	for (const leg of legs) {
		const ownerPk = new PublicKey(leg.address);
		// allowOwnerOffCurve: the burn incinerator address is off-curve.
		const destAta = getAssociatedTokenAddressSync(mintPk, ownerPk, true);
		tx.add(createAssociatedTokenAccountIdempotentInstruction(payer, destAta, ownerPk, mintPk));
		tx.add(createTransferInstruction(fromAta, destAta, payer, leg.atomics));
	}
	const tag = `three.ws mcp burn $${usd}${memo ? ` ${memo}` : ''}`.slice(0, 180);
	tx.add(
		new TransactionInstruction({
			keys: [],
			programId: new PublicKey(MEMO_PROGRAM_ID),
			data: Buffer.from(tag, 'utf8'),
		}),
	);

	const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
	tx.feePayer = payer;
	tx.recentBlockhash = blockhash;
	tx.sign(signer);

	const signature = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
	const conf = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
	if (conf.value?.err) {
		throw Object.assign(new Error(`transaction failed to confirm: ${JSON.stringify(conf.value.err)}`), {
			code: 'tx_failed',
			signature,
		});
	}

	return {
		ok: true,
		signature,
		explorer: `https://solscan.io/tx/${signature}`,
		mint: config.mint,
		symbol: config.symbol,
		decimals,
		usd: Number(usd),
		price_usd: price.price_usd,
		price_source: price.source,
		payer: payer.toBase58(),
		total: { atomics: total.toString(), amount: fmt(total, decimals) },
		legs: legs.map((l) => ({
			role: l.role,
			address: l.address,
			atomics: l.atomics.toString(),
			amount: fmt(l.atomics, decimals),
		})),
		burned: fmt(legs.find((l) => l.role === 'burn')?.atomics ?? 0n, decimals),
		burnedAt: new Date().toISOString(),
	};
}
