// Game-token economy — the on-chain primitives the in-game marketplace (Task 20)
// and any future paid action (Task 19 spins) settle through. This is the Task 18
// layer: token config, a live USD→token quote with a short validity window, the
// split transaction the buyer signs, and on-chain verification of that payment
// before any in-game value is released.
//
// The token is $THREE (the platform token). A USD-priced sale quotes to a $THREE
// amount at the live market price; the buyer's wallet sends ONE transaction that
// splits the $THREE between the seller's wallet and the treasury per the
// configured ratio (95/5 for marketplace sales). The server NEVER trusts a
// client "paid" claim — it re-fetches the confirmed transaction from Solana RPC
// and checks both legs landed at the right destinations for the right amounts.
//
// Quotes are sealed into an HMAC-SHA256 token (identical construction to
// realm-transfer.js / holder-pass.js) so a client can't move the price, swap the
// recipient, or replay an old quote after the market moves.

import crypto from 'node:crypto';
import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferInstruction } from '@solana/spl-token';

// --- config ----------------------------------------------------------------

// $THREE mint (overridable so a test deployment can point at a devnet mint).
export const TOKEN_MINT = process.env.GAME_TOKEN_MINT || 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
export const TOKEN_DECIMALS = Number(process.env.GAME_TOKEN_DECIMALS || 6);
export const TOKEN_SYMBOL = '$THREE';

// The burn sink for paid-spin splits. Defaults to the canonical Solana
// incinerator (an unspendable address) — sending $THREE to its ATA removes the
// tokens from circulation. Matches api/_lib/token/config.js's burn address so
// both token layers burn to the same place.
export const BURN_ADDRESS =
	process.env.GAME_TOKEN_BURN || process.env.THREE_BURN_ADDRESS || '1nc1nerator11111111111111111111111111111111';

const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const BIRDEYE_BASE = 'https://public-api.birdeye.so';
// SPL memo program — a memo carrying the quote nonce binds the on-chain tx to
// one specific quote so an unrelated transfer of the right size can't settle it.
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const QUOTE_TTL_SECONDS = 90; // long enough to approve in a wallet, short enough that a price can't be exploited
const PRICE_CACHE_MS = 30_000;
const DEV_SECRET = 'three-ws-game-token-dev-secret';

let _treasuryWarned = false;
// The treasury wallet that receives the platform's cut. Fail loud in production
// if it isn't configured (mirrors the HOLDER_PASS_SECRET boot guard) — without it
// the split has nowhere to send the 5% and the sale can't settle.
export function treasuryWallet() {
	const w = process.env.GAME_TOKEN_TREASURY || process.env.PAYMENT_RECIPIENT_SOLANA || '';
	if (w) return w;
	if (process.env.NODE_ENV === 'production') {
		throw new Error('[game-token] GAME_TOKEN_TREASURY is required in production — refusing to settle token sales without a treasury wallet.');
	}
	if (!_treasuryWarned) {
		_treasuryWarned = true;
		console.warn('[game-token] no GAME_TOKEN_TREASURY/PAYMENT_RECIPIENT_SOLANA set — token-priced listings are disabled until one is configured.');
	}
	return '';
}

export function tokenConfigured() {
	return !!treasuryWallet();
}

// Is this account id a real Solana wallet address (vs. a guest id like `g_…`)?
// Token listings require a wallet on both sides — the seller to receive the
// on-chain proceeds, the buyer to pay — so we gate on a valid base58 pubkey.
export function isWalletAddress(id) {
	if (typeof id !== 'string' || id.length < 32 || id.length > 44) return false;
	try { new PublicKey(id); return true; } catch { return false; }
}

let _secretWarned = false;
function secret() {
	const s = process.env.GAME_TOKEN_SECRET || process.env.HOLDER_PASS_SECRET || process.env.REALM_TRANSFER_SECRET;
	if (s) return s;
	if (process.env.NODE_ENV === 'production') {
		throw new Error('[game-token] GAME_TOKEN_SECRET (or HOLDER_PASS_SECRET) is required in production — refusing to sign quotes with the dev secret.');
	}
	if (!_secretWarned) {
		_secretWarned = true;
		console.warn('[game-token] no GAME_TOKEN_SECRET/HOLDER_PASS_SECRET set — using the insecure dev secret. Set one in production or token quotes can be forged.');
	}
	return DEV_SECRET;
}

// --- live price ------------------------------------------------------------

let _priceCache = { value: 0, at: 0 };

// Jupiter Lite is the primary feed — no API key, knows pump.fun bonding curves,
// and is the same source api/_lib/token/price.js + balances.js use. Returns null
// if unavailable so the caller can fall back.
async function jupiterPriceUsd() {
	const resp = await fetch(`https://lite-api.jup.ag/price/v3?ids=${TOKEN_MINT}`);
	if (!resp.ok) throw new Error(`jupiter ${resp.status}`);
	const body = await resp.json();
	const price = Number(body?.[TOKEN_MINT]?.usdPrice ?? body?.[TOKEN_MINT]?.price);
	return Number.isFinite(price) && price > 0 ? price : null;
}

// Birdeye is the keyed fallback (the source api/three-token uses).
async function birdeyePriceUsd() {
	const apiKey = process.env.BIRDEYE_API_KEY;
	if (!apiKey) return null;
	const resp = await fetch(`${BIRDEYE_BASE}/defi/price?address=${TOKEN_MINT}`, {
		headers: { 'X-API-KEY': apiKey, accept: 'application/json' },
	});
	if (!resp.ok) throw new Error(`birdeye ${resp.status}`);
	const body = await resp.json();
	const price = Number(body?.data?.value);
	return Number.isFinite(price) && price > 0 ? price : null;
}

// Live $THREE price in USD. Tries Jupiter first, then Birdeye. Cached briefly so
// a burst of quote requests is one upstream call. Returns 0 when no feed yields
// a usable number — callers treat 0 as "can't quote" and refuse the paid action
// rather than guessing a price.
export async function fetchTokenPriceUsd() {
	const now = Date.now();
	if (_priceCache.value > 0 && now - _priceCache.at < PRICE_CACHE_MS) return _priceCache.value;
	for (const [name, fn] of [['jupiter', jupiterPriceUsd], ['birdeye', birdeyePriceUsd]]) {
		try {
			const price = await fn();
			if (price > 0) {
				_priceCache = { value: price, at: now };
				return price;
			}
		} catch (err) {
			console.warn(`[game-token] ${name} price fetch failed:`, err?.message);
		}
	}
	return _priceCache.value || 0;
}

// Raw token base units for a USD amount at the live price. Returns null if the
// price feed is unavailable (so the caller can refuse the quote rather than guess).
export async function quoteTokenForUsd(usd) {
	const price = await fetchTokenPriceUsd();
	if (!(price > 0)) return null;
	const tokens = usd / price;
	const raw = BigInt(Math.round(tokens * 10 ** TOKEN_DECIMALS));
	return { price, tokens, raw };
}

// --- signed quote ----------------------------------------------------------

function b64url(buf) {
	return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(str) {
	return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}
function hmac(body) {
	return b64url(crypto.createHmac('sha256', secret()).update(body).digest());
}
function safeEqual(a, b) {
	const ba = Buffer.from(a), bb = Buffer.from(b);
	if (ba.length !== bb.length) return false;
	return crypto.timingSafeEqual(ba, bb);
}

// Seal a settlement quote. `raw` amounts are strings (BigInt isn't JSON-safe).
export function signQuote(payload) {
	const now = Math.floor(Date.now() / 1000);
	const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + QUOTE_TTL_SECONDS }));
	return `${body}.${hmac(body)}`;
}

export function verifyQuote(token) {
	if (typeof token !== 'string' || token.length < 16 || token.length > 8192) return null;
	const dot = token.indexOf('.');
	if (dot <= 0) return null;
	const body = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	if (!safeEqual(sig, hmac(body))) return null;
	let p;
	try { p = JSON.parse(b64urlDecode(body)); } catch { return null; }
	if (!p || typeof p !== 'object') return null;
	const now = Date.now() / 1000;
	if (typeof p.exp !== 'number' || p.exp < now) return null;
	if (typeof p.iat !== 'number' || p.iat > now + 60) return null;
	if (p.exp - p.iat > QUOTE_TTL_SECONDS + 5) return null;
	return p;
}

// --- split transaction -----------------------------------------------------

// Split `rawTotal` base units into seller / treasury legs by basis points.
// Treasury gets the remainder so the two legs always sum to exactly the total.
export function splitAmount(rawTotal, treasuryBps) {
	const total = BigInt(rawTotal);
	const treasury = (total * BigInt(treasuryBps)) / 10000n;
	const seller = total - treasury;
	return { seller, treasury };
}

// Build the unsigned transaction the buyer signs: two $THREE transfers from the
// buyer's token account — sellerRaw to the seller, treasuryRaw to the treasury —
// creating either destination's associated token account first if it's missing
// (the buyer pays that rent). Buyer is the sole signer and fee payer. Returned
// base64 is handed to the client to deserialize, sign, and broadcast.
export async function buildSplitTransaction({ buyerWallet, sellerWallet, sellerRaw, treasuryRaw }) {
	const conn = new Connection(SOLANA_RPC, 'confirmed');
	const mint = new PublicKey(TOKEN_MINT);
	const buyer = new PublicKey(buyerWallet);
	const seller = new PublicKey(sellerWallet);
	const treasury = new PublicKey(treasuryWallet());

	const buyerATA = await getAssociatedTokenAddress(mint, buyer);
	const sellerATA = await getAssociatedTokenAddress(mint, seller);
	const treasuryATA = await getAssociatedTokenAddress(mint, treasury);

	const tx = new Transaction();
	const [sellerAcct, treasuryAcct] = await Promise.all([
		conn.getAccountInfo(sellerATA),
		conn.getAccountInfo(treasuryATA),
	]);
	if (!sellerAcct) tx.add(createAssociatedTokenAccountInstruction(buyer, sellerATA, seller, mint));
	if (!treasuryAcct) tx.add(createAssociatedTokenAccountInstruction(buyer, treasuryATA, treasury, mint));
	tx.add(createTransferInstruction(buyerATA, sellerATA, buyer, BigInt(sellerRaw)));
	tx.add(createTransferInstruction(buyerATA, treasuryATA, buyer, BigInt(treasuryRaw)));

	const { blockhash } = await conn.getLatestBlockhash('confirmed');
	tx.feePayer = buyer;
	tx.recentBlockhash = blockhash;
	return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

// Verify a settled split payment on-chain. Confirms the signature is finalized
// and that the transaction moved at least sellerRaw $THREE to the seller's token
// account AND at least treasuryRaw to the treasury's, by comparing pre/post token
// balances. Pre/post deltas (rather than instruction parsing) make this robust to
// however the wallet assembled the transfer. Returns { ok, reason }.
export async function verifySplitPayment({ txSig, sellerWallet, sellerRaw, treasuryRaw }) {
	if (typeof txSig !== 'string' || txSig.length < 32 || txSig.length > 128) return { ok: false, reason: 'bad_signature' };
	const conn = new Connection(SOLANA_RPC, 'confirmed');
	let tx;
	try {
		tx = await conn.getParsedTransaction(txSig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
	} catch (err) {
		return { ok: false, reason: 'rpc_error' };
	}
	if (!tx) return { ok: false, reason: 'not_found' };
	if (tx.meta?.err) return { ok: false, reason: 'tx_failed' };

	const mint = TOKEN_MINT;
	const seller = new PublicKey(sellerWallet);
	const treasury = new PublicKey(treasuryWallet());
	const sellerATA = (await getAssociatedTokenAddress(new PublicKey(mint), seller)).toBase58();
	const treasuryATA = (await getAssociatedTokenAddress(new PublicKey(mint), treasury)).toBase58();

	// Net change for an owner's $THREE token account across this transaction.
	const delta = (ownerATA) => {
		const pre = (tx.meta?.preTokenBalances || []).find((b) => b.mint === mint && accountKeyAt(tx, b.accountIndex) === ownerATA);
		const post = (tx.meta?.postTokenBalances || []).find((b) => b.mint === mint && accountKeyAt(tx, b.accountIndex) === ownerATA);
		const preAmt = BigInt(pre?.uiTokenAmount?.amount || '0');
		const postAmt = BigInt(post?.uiTokenAmount?.amount || '0');
		return postAmt - preAmt;
	};

	const sellerGain = delta(sellerATA);
	const treasuryGain = delta(treasuryATA);
	if (sellerGain < BigInt(sellerRaw)) return { ok: false, reason: 'seller_underpaid' };
	if (treasuryGain < BigInt(treasuryRaw)) return { ok: false, reason: 'treasury_underpaid' };
	return { ok: true, sellerGain: sellerGain.toString(), treasuryGain: treasuryGain.toString() };
}

// Resolve the account address for a token-balance entry's index across the
// transaction's account-key list (parsed transactions expose keys as objects).
function accountKeyAt(tx, index) {
	const keys = tx.transaction?.message?.accountKeys || [];
	const k = keys[index];
	if (!k) return '';
	return typeof k === 'string' ? k : k.pubkey?.toBase58?.() || String(k.pubkey || '');
}

// --- paid wheel spins (Task 19) ---------------------------------------------
//
// A spin costs $3 in $THREE, split 50% burned / 50% to treasury. The flow
// mirrors marketplace settlement but with two fixed destinations (burn +
// treasury) and a memo binding the on-chain tx to the exact quote it settles:
//   buildSpinPayment() → client signs+broadcasts → verifySpinPayment().
// Replay protection (a settled signature/nonce can't roll a second prize) is the
// caller's responsibility — the GameRoom tracks consumed nonces per process and
// the short quote TTL bounds the window.

// Split a total into burn + treasury legs by basis points. Treasury absorbs the
// rounding remainder so the two legs always sum to exactly the total.
export function splitBurnTreasury(rawTotal, burnBps = 5000) {
	const total = BigInt(rawTotal);
	const burn = (total * BigInt(burnBps)) / 10000n;
	const treasury = total - burn;
	return { burn, treasury };
}

function memoInstruction(nonce) {
	return new TransactionInstruction({ keys: [], programId: MEMO_PROGRAM_ID, data: Buffer.from(nonce, 'utf8') });
}

/**
 * Price a paid spin and build the unsigned split transaction the player signs.
 * Returns null when the live price feed is unavailable (the caller must refuse
 * the spin rather than charge a guessed amount) or when no treasury is set.
 * @param {{ buyerWallet: string, usd: number }} params
 * @returns {Promise<null | { quoteToken: string, txBase64: string, quote: object }>}
 */
export async function buildSpinPayment({ buyerWallet, usd }) {
	if (!tokenConfigured()) return null;
	const priced = await quoteTokenForUsd(usd);
	if (!priced || !(priced.raw > 0n)) return null;
	const { burn: burnRaw, treasury: treasuryRaw } = splitBurnTreasury(priced.raw, 5000);
	const treasuryAddr = treasuryWallet();
	const nonce = crypto.randomBytes(16).toString('hex');

	const conn = new Connection(SOLANA_RPC, 'confirmed');
	const mint = new PublicKey(TOKEN_MINT);
	const buyer = new PublicKey(buyerWallet);
	const burn = new PublicKey(BURN_ADDRESS);
	const treasury = new PublicKey(treasuryAddr);

	const buyerATA = await getAssociatedTokenAddress(mint, buyer);
	const burnATA = await getAssociatedTokenAddress(mint, burn);
	const treasuryATA = await getAssociatedTokenAddress(mint, treasury);

	const tx = new Transaction();
	const [burnAcct, treasuryAcct] = await Promise.all([
		conn.getAccountInfo(burnATA),
		conn.getAccountInfo(treasuryATA),
	]);
	if (!burnAcct) tx.add(createAssociatedTokenAccountInstruction(buyer, burnATA, burn, mint));
	if (!treasuryAcct) tx.add(createAssociatedTokenAccountInstruction(buyer, treasuryATA, treasury, mint));
	tx.add(createTransferInstruction(buyerATA, burnATA, buyer, burnRaw));
	tx.add(createTransferInstruction(buyerATA, treasuryATA, buyer, treasuryRaw));
	tx.add(memoInstruction(nonce));

	const { blockhash } = await conn.getLatestBlockhash('confirmed');
	tx.feePayer = buyer;
	tx.recentBlockhash = blockhash;
	const txBase64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');

	const quotePayload = {
		purpose: 'spin',
		mint: TOKEN_MINT,
		decimals: TOKEN_DECIMALS,
		symbol: TOKEN_SYMBOL,
		buyer: buyerWallet,
		usd,
		priceUsd: priced.price,
		total: priced.raw.toString(),
		tokens: priced.tokens,
		burnAddr: BURN_ADDRESS,
		burnRaw: burnRaw.toString(),
		treasuryAddr,
		treasuryRaw: treasuryRaw.toString(),
		nonce,
	};
	const quoteToken = signQuote(quotePayload);
	return { quoteToken, txBase64, quote: { ...quotePayload, ttlSeconds: QUOTE_TTL_SECONDS } };
}

/**
 * Verify a settled paid spin on-chain: the quote is untampered + unexpired, the
 * tx carries the quote's memo nonce, the buyer matches, and both the burn and
 * treasury legs received at least their share. Pre/post token-balance deltas
 * make this robust to how the wallet assembled the transfers.
 * @param {{ quoteToken: string, txSig: string, buyerWallet?: string }} params
 * @returns {Promise<{ ok: boolean, reason?: string, nonce?: string, quote?: object }>}
 */
export async function verifySpinPayment({ quoteToken, txSig, buyerWallet }) {
	const q = verifyQuote(quoteToken);
	if (!q || q.purpose !== 'spin') return { ok: false, reason: 'bad_quote' };
	if (buyerWallet && q.buyer && q.buyer !== buyerWallet) return { ok: false, reason: 'buyer_mismatch' };
	if (typeof txSig !== 'string' || txSig.length < 32 || txSig.length > 128) return { ok: false, reason: 'bad_signature' };

	const conn = new Connection(SOLANA_RPC, 'confirmed');
	let tx;
	try {
		tx = await conn.getParsedTransaction(txSig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
	} catch {
		return { ok: false, reason: 'rpc_error' };
	}
	if (!tx) return { ok: false, reason: 'not_found' };
	if (tx.meta?.err) return { ok: false, reason: 'tx_failed' };

	// Memo must equal the quote nonce — binds this tx to this exact quote.
	const memoIx = (tx.transaction?.message?.instructions || []).find(
		(ix) => ix.programId?.toString() === MEMO_PROGRAM_ID.toBase58(),
	);
	const memo = typeof memoIx?.parsed === 'string' ? memoIx.parsed : null;
	if (!memo || memo !== q.nonce) return { ok: false, reason: 'memo_mismatch' };

	const mint = TOKEN_MINT;
	const burnATA = (await getAssociatedTokenAddress(new PublicKey(mint), new PublicKey(q.burnAddr))).toBase58();
	const treasuryATA = (await getAssociatedTokenAddress(new PublicKey(mint), new PublicKey(q.treasuryAddr))).toBase58();
	const delta = (ownerATA) => {
		const pre = (tx.meta?.preTokenBalances || []).find((b) => b.mint === mint && accountKeyAt(tx, b.accountIndex) === ownerATA);
		const post = (tx.meta?.postTokenBalances || []).find((b) => b.mint === mint && accountKeyAt(tx, b.accountIndex) === ownerATA);
		return BigInt(post?.uiTokenAmount?.amount || '0') - BigInt(pre?.uiTokenAmount?.amount || '0');
	};
	if (delta(burnATA) < BigInt(q.burnRaw)) return { ok: false, reason: 'burn_underpaid' };
	if (delta(treasuryATA) < BigInt(q.treasuryRaw)) return { ok: false, reason: 'treasury_underpaid' };
	return { ok: true, nonce: q.nonce, quote: q };
}
