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

import {
	THREE_WS_BASE,
	MEMO_PROGRAM_ID,
	THREE_MINT,
	EXPECTED_BURN_ADDRESS,
	MAX_BURN_USD,
} from '../config.js';
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
 * Assert the HTTP-resolved token config actually describes canonical $THREE and
 * routes the burn to the expected incinerator. The config endpoint is UNTRUSTED:
 * a compromised or misconfigured server must not be able to redirect a burn to a
 * different token or sink. This is the H1 invariant — call it before signing.
 * @param {object} config — output of fetchTokenConfig()
 */
export function assertCanonicalThree(config) {
	if (!config || config.mint !== THREE_MINT) {
		throw Object.assign(
			new Error(
				`refusing to burn: resolved mint does not match canonical $THREE. ` +
					`expected ${THREE_MINT}, got ${config?.mint ?? '(none)'}.`,
			),
			{ code: 'mint_mismatch' },
		);
	}
	if (!config.burn_address || config.burn_address !== EXPECTED_BURN_ADDRESS) {
		throw Object.assign(
			new Error(
				`refusing to burn: burn_address does not match the expected incinerator. ` +
					`expected ${EXPECTED_BURN_ADDRESS}, got ${config?.burn_address ?? '(none)'}. ` +
					'Set THREE_BURN_ADDRESS only if you intentionally run a non-default burn sink.',
			),
			{ code: 'burn_address_mismatch' },
		);
	}
}

/**
 * Resolve just the $THREE mint (+ symbol/decimals if available). Prefers the
 * full config, but falls back to the price endpoint's `mint` so read-only tools
 * keep working even when /api/token/config is unavailable (e.g. the treasury
 * env isn't set yet) — burns still require the full config.
 */
export async function resolveMint() {
	try {
		const c = await fetchTokenConfig();
		if (c?.mint) return { mint: c.mint, symbol: c.symbol || '$THREE', decimals: c.decimals };
	} catch {
		/* fall through to price */
	}
	const p = await fetchTokenPrice();
	return { mint: p.mint, symbol: '$THREE', decimals: undefined };
}

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
	// Floor the TREASURY share, then give the burn leg the remainder: integer
	// division always drops a fraction of an atomic unit somewhere, and the leg
	// that must never come up short is the burn.
	const treasuryAtomics = (total * BigInt(10_000 - bps)) / 10_000n;
	let burnAtomics = total - treasuryAtomics;
	const legs = [];
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
	if (Number(usd) > MAX_BURN_USD) {
		throw Object.assign(
			new Error(
				`burn of $${usd} exceeds the per-burn cap of $${MAX_BURN_USD}. ` +
					'Raise MAX_BURN_USD in the MCP server environment to allow larger burns.',
			),
			{ code: 'over_burn_cap' },
		);
	}

	const signer = loadSigner(secret);
	const payer = signer.publicKey;

	const [config, price] = await Promise.all([fetchTokenConfig(), fetchTokenPrice(usd)]);
	if (!config.mint || !config.burn_address) {
		throw Object.assign(new Error('token config missing mint/burn_address'), { code: 'config_incomplete' });
	}
	// H1 invariant: never trust the HTTP config blindly for the mint or sink.
	assertCanonicalThree(config);
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

	// Confirmation can throw on timeout even though the burn may still land.
	// Surface 'pending' so the caller does NOT blindly re-burn (double-burn).
	let conf;
	try {
		conf = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
	} catch (waitErr) {
		throw Object.assign(
			new Error(
				`burn ${signature} was submitted but confirmation timed out (${waitErr?.message || waitErr}). ` +
					'It MAY still land — do NOT re-burn; check the signature on Solscan first to avoid a double-burn.',
			),
			{ code: 'tx_unconfirmed', status: 'pending', signature },
		);
	}
	if (conf.value?.err) {
		throw Object.assign(new Error(`transaction failed to confirm: ${JSON.stringify(conf.value.err)}`), {
			code: 'tx_failed',
			status: 'failed',
			signature,
		});
	}

	return {
		ok: true,
		status: 'confirmed',
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
