// @three-ws/x402-payment-modal/server — Solana checkout helpers.
//
// The modal's EVM path signs EIP-3009 typed-data entirely in the browser and
// never calls your server. The Solana path is different: Phantom only *signs*
// serialized transactions — it does not build instructions. So the modal needs a
// tiny server endpoint that (a) builds the SPL transfer the buyer should sign,
// and (b) wraps the signed transaction into the base64 `X-PAYMENT` envelope the
// x402 facilitator expects.
//
// This module is framework-agnostic. `prepareSolanaCheckout` and
// `encodeX402Payment` are pure functions; `handleCheckout` routes the two
// actions and returns `{ status, body }`. Thin adapters for Express and Vercel
// live in ./express.js and ./vercel.js.
//
// Runtime deps: @solana/web3.js and @solana/spl-token (declared as optional peer
// dependencies — install them in the app that mounts this handler). Nothing here
// imports anything three.ws-specific.

import {
	Connection,
	PublicKey,
	TransactionMessage,
	VersionedTransaction,
	ComputeBudgetProgram,
} from '@solana/web3.js';
import {
	TOKEN_PROGRAM_ID,
	TOKEN_2022_PROGRAM_ID,
	ASSOCIATED_TOKEN_PROGRAM_ID,
	getAssociatedTokenAddressSync,
	createAssociatedTokenAccountIdempotentInstruction,
	createTransferCheckedInstruction,
	getMint,
} from '@solana/spl-token';

export const X402_VERSION = 2;

// CAIP-2 network identifiers for Solana (genesis-hash prefixes).
export const NETWORK_SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const NETWORK_SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

const DEFAULT_MAINNET_RPC = 'https://api.mainnet-beta.solana.com';
const DEFAULT_DEVNET_RPC = 'https://api.devnet.solana.com';

// ─────────────────────────────────────────────── Well-known Solana tokens ────
// The two settlement assets the modal treats as first-class on Solana. USDC is
// the universal dollar-stable rail; THREE is the three.ws utility token, so any
// endpoint can let holders pay in THREE alongside USDC. `solanaAccept()` builds
// the x402 `accept` entry for either (or any other SPL mint) — the prepare path
// already transfers any mint, so offering THREE needs no further wiring.
export const USDC_MINT_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

export const WELL_KNOWN_SOLANA_TOKENS = Object.freeze({
	usdc: { mint: USDC_MINT_SOLANA, symbol: 'USDC', name: 'USD Coin', decimals: 6 },
	three: { mint: THREE_MINT, symbol: 'THREE', name: 'THREE', decimals: 6 },
});

/**
 * Build one x402 Solana `accept` entry for a merchant's 402 challenge.
 *
 * Pass `token: 'usdc' | 'three'` for a well-known asset, or an explicit `mint`
 * (+ optional `decimals`/`name`) for any other SPL token. Supply the price as
 * either `amount` (atomic integer string) or `uiAmount` (human units, converted
 * with the token's decimals). `feePayer` is the facilitator sponsor that pays
 * the SOL network fee so buyers need only the token itself.
 *
 * @param {object} args
 * @param {'usdc'|'three'} [args.token]   well-known token shortcut
 * @param {string} [args.mint]            explicit SPL mint (base58); overrides token
 * @param {string} args.payTo             recipient address (base58)
 * @param {string} args.feePayer          facilitator sponsor address (base58)
 * @param {string|number|bigint} [args.amount]    atomic integer amount
 * @param {string|number} [args.uiAmount] human amount (e.g. 0.25) — converted via decimals
 * @param {number} [args.decimals]        token decimals (default: well-known or 6)
 * @param {string} [args.name]            display name for the modal (default: well-known symbol)
 * @param {string} [args.network]         CAIP-2 network (default: Solana mainnet)
 * @param {number} [args.maxTimeoutSeconds]
 * @returns {SolanaAccept}
 */
export function solanaAccept({
	token,
	mint,
	payTo,
	feePayer,
	amount,
	uiAmount,
	decimals,
	name,
	network = NETWORK_SOLANA_MAINNET,
	maxTimeoutSeconds,
} = {}) {
	const known = token ? WELL_KNOWN_SOLANA_TOKENS[String(token).toLowerCase()] : null;
	if (token && !known) {
		throw new CheckoutError(400, 'invalid_request', `unknown token '${token}'. Use 'usdc', 'three', or pass an explicit mint.`);
	}
	const asset = mint || known?.mint;
	if (!asset) {
		throw new CheckoutError(400, 'invalid_request', "solanaAccept needs a token ('usdc'|'three') or an explicit mint");
	}
	assertPubkey(asset, 'mint');
	assertPubkey(payTo, 'payTo');
	assertPubkey(feePayer, 'feePayer');

	const dec = Number.isFinite(decimals) ? decimals : (known?.decimals ?? 6);
	let atomic;
	if (amount != null) {
		atomic = BigInt(amount).toString();
	} else if (uiAmount != null) {
		atomic = uiToAtomic(uiAmount, dec);
	} else {
		throw new CheckoutError(400, 'invalid_request', 'solanaAccept needs amount (atomic) or uiAmount (human)');
	}

	const accept = {
		scheme: 'exact',
		network,
		amount: atomic,
		asset,
		payTo,
		extra: {
			name: name || known?.name || 'USDC',
			decimals: dec,
			feePayer,
		},
	};
	if (maxTimeoutSeconds != null) accept.maxTimeoutSeconds = maxTimeoutSeconds;
	return accept;
}

// Convert a human token amount (e.g. "0.25", 1.5) to an atomic integer string
// without floating-point drift: split on the decimal point and pad/truncate.
function uiToAtomic(uiAmount, decimals) {
	const s = String(uiAmount).trim();
	if (!/^\d+(\.\d+)?$/.test(s)) {
		throw new CheckoutError(400, 'invalid_request', `uiAmount must be a non-negative number, got '${uiAmount}'`);
	}
	const [whole, frac = ''] = s.split('.');
	const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
	const atomic = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
	return atomic.toString();
}

// Short-lived caches so repeated prepare calls don't re-issue identical RPC
// round-trips. Mint decimals and the owning token program are immutable, so they
// key by mint alone (shared across RPC providers on the same cluster). A Solana
// blockhash stays valid ~60-90s; we amortize the fetch for a window but the
// settle path tolerates a slightly older one. ATA existence only ever flips
// false→true (an account, once created, persists), so we cache the positive.
//
// Keys are cluster-scoped ('mainnet'/'devnet'), never per-RPC-URL, so failover
// between providers preserves cache hits. All caches are LRU-bounded so a stream
// of distinct arbitrary mints can't grow them without limit on a warm instance.
const MINT_META_TTL_MS = 30 * 60 * 1000;
const BLOCKHASH_TTL_MS = 20 * 1000;
const ATA_EXISTS_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 2000;
const mintDecimalsCache = new Map(); // `${cluster}:${mint}` -> { decimals, at }
const blockhashCache = new Map(); // cluster -> { blockhash, at }
const tokenProgramCache = new Map(); // `${cluster}:${mint}` -> { programId, at }
const ataExistsCache = new Map(); // `${cluster}:${ata}` -> { at }
const connectionCache = new Map(); // rpcUrl -> Connection

// Bounded insert: evict the oldest entry (Map preserves insertion order) once
// the cap is hit, keeping memory flat under arbitrary-mint traffic.
function cacheSet(map, key, value, max = CACHE_MAX) {
	if (map.size >= max && !map.has(key)) {
		const oldest = map.keys().next().value;
		if (oldest !== undefined) map.delete(oldest);
	}
	map.set(key, value);
}

// Decimals + owning program for the assets the modal treats as first-class.
// Short-circuiting these skips two RPC reads on the hot path (USDC is the bulk
// of real traffic). THREE is Token-2022; the rest are legacy SPL Token.
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const WELL_KNOWN_MINT_META = Object.freeze({
	[USDC_MINT_SOLANA]: { decimals: 6, legacy: true },
	[THREE_MINT]: { decimals: 6, legacy: false },
	[WSOL_MINT]: { decimals: 9, legacy: true },
});

/** Thrown for any client-correctable problem; carries an HTTP `status` + `code`. */
export class CheckoutError extends Error {
	constructor(status, code, message) {
		super(message);
		this.name = 'CheckoutError';
		this.status = status;
		this.code = code;
	}
}

export function isSolanaNetwork(network) {
	return (
		network === NETWORK_SOLANA_MAINNET ||
		network === NETWORK_SOLANA_DEVNET ||
		network === 'solana'
	);
}

function clusterFor(network) {
	return network === NETWORK_SOLANA_DEVNET ? 'devnet' : 'mainnet';
}

let warnedDefaultRpc = false;

// Resolve the ordered list of RPC endpoints to try. Accepts a single `rpcUrl`
// or an `rpcUrls` array (for real failover); same for devnet. Falling back to
// the rate-limited public RPC is a production footgun under load, so warn once.
function rpcListFor(network, opts = {}) {
	const devnet = network === NETWORK_SOLANA_DEVNET;
	const single = devnet ? opts.devnetRpcUrl : opts.rpcUrl;
	const many = devnet ? opts.devnetRpcUrls : opts.rpcUrls;
	const list = []
		.concat(Array.isArray(many) ? many : [])
		.concat(single ? [single] : [])
		.filter((u) => typeof u === 'string' && u.length);
	if (list.length) return [...new Set(list)];
	if (!warnedDefaultRpc) {
		warnedDefaultRpc = true;
		console.warn(
			'[x402-payment-modal] No rpcUrl/rpcUrls configured — falling back to the public ' +
				'Solana RPC, which is heavily rate-limited and will fail under load. Pass a ' +
				'dedicated RPC (Helius/Triton/Quicknode) via { rpcUrls: [...] }.',
		);
	}
	return [devnet ? DEFAULT_DEVNET_RPC : DEFAULT_MAINNET_RPC];
}

// Reuse one Connection per RPC URL so socket keep-alive survives across
// requests on a warm instance instead of paying TCP/TLS setup every prepare.
function getConnection(url) {
	let conn = connectionCache.get(url);
	if (!conn) {
		conn = new Connection(url, 'confirmed');
		cacheSet(connectionCache, url, conn, 50);
	}
	return conn;
}

// Run `fn(conn)` against each RPC in order, rotating to the next on a transient
// RPC/network error. A CheckoutError is a deterministic client problem (bad
// input, mint isn't an SPL token) — surface it immediately, don't retry.
async function withFailover(urls, fn) {
	let lastErr;
	for (const url of urls) {
		try {
			return await fn(getConnection(url));
		} catch (err) {
			if (err instanceof CheckoutError) throw err;
			lastErr = err;
		}
	}
	throw lastErr || new Error('all RPC endpoints failed');
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function assertPubkey(value, field) {
	if (typeof value !== 'string' || !BASE58.test(value)) {
		throw new CheckoutError(400, 'invalid_request', `${field} must be a base58 Solana address`);
	}
	return value;
}

// Validate the subset of the x402 `accept` entry the Solana path relies on.
// `extra.feePayer` is required — it is the facilitator's sponsor account that
// pays the SOL network fee so the buyer needs no SOL, only USDC.
function validateAccept(accept) {
	if (!accept || typeof accept !== 'object') {
		throw new CheckoutError(400, 'invalid_request', 'accept object is required');
	}
	if (accept.scheme !== 'exact') {
		throw new CheckoutError(400, 'invalid_request', `unsupported scheme: ${accept.scheme}`);
	}
	if (!isSolanaNetwork(accept.network)) {
		throw new CheckoutError(
			400,
			'unsupported_network',
			`prepare only builds Solana transactions; got network=${accept.network}. EVM clients sign EIP-712 typed data locally and don't need this endpoint.`,
		);
	}
	if (typeof accept.amount !== 'string' || !/^\d+$/.test(accept.amount)) {
		throw new CheckoutError(400, 'invalid_request', 'accept.amount must be an atomic integer string');
	}
	assertPubkey(accept.asset, 'accept.asset');
	assertPubkey(accept.payTo, 'accept.payTo');
	const feePayer = accept.extra?.feePayer;
	assertPubkey(feePayer, 'accept.extra.feePayer');
	return accept;
}

// Resolve which token program owns a mint — legacy SPL Token or Token-2022.
// Pump.fun mints (including THREE) and many newer assets are Token-2022, whose
// program id differs; deriving ATAs or building transferChecked with the wrong
// program yields the wrong accounts and an unprocessable transaction. The owner
// is immutable, so cache it (and short-circuit the first-class assets entirely).
async function getTokenProgramId(conn, cluster, mint) {
	const base58 = mint.toBase58();
	const known = WELL_KNOWN_MINT_META[base58];
	if (known) return known.legacy ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
	const key = `${cluster}:${base58}`;
	const hit = tokenProgramCache.get(key);
	if (hit && Date.now() - hit.at < MINT_META_TTL_MS) return hit.programId;
	const info = await conn.getAccountInfo(mint, 'confirmed');
	// A null here is usually a flaky RPC, not a missing mint — throw a plain Error
	// so withFailover retries the next endpoint before giving up.
	if (!info) throw new Error(`getAccountInfo returned null for mint ${base58}`);
	const owner = info.owner;
	let programId;
	if (owner.equals(TOKEN_2022_PROGRAM_ID)) programId = TOKEN_2022_PROGRAM_ID;
	else if (owner.equals(TOKEN_PROGRAM_ID)) programId = TOKEN_PROGRAM_ID;
	else throw new CheckoutError(400, 'invalid_request', `mint ${base58} is not an SPL token (owner ${owner.toBase58()})`);
	cacheSet(tokenProgramCache, key, { programId, at: Date.now() });
	return programId;
}

async function getMintDecimals(conn, cluster, mint, programId) {
	const base58 = mint.toBase58();
	const known = WELL_KNOWN_MINT_META[base58];
	if (known) return known.decimals;
	const key = `${cluster}:${base58}`;
	const hit = mintDecimalsCache.get(key);
	if (hit && Date.now() - hit.at < MINT_META_TTL_MS) return hit.decimals;
	const info = await getMint(conn, mint, 'confirmed', programId);
	cacheSet(mintDecimalsCache, key, { decimals: info.decimals, at: Date.now() });
	return info.decimals;
}

// Whether the recipient's token account already exists. Once created it persists,
// so a positive result is cached; a negative is not (we keep emitting the
// idempotent-create instruction until the account shows up).
async function receiverAtaExists(conn, cluster, ata) {
	const key = `${cluster}:${ata.toBase58()}`;
	if (ataExistsCache.has(key) && Date.now() - ataExistsCache.get(key).at < ATA_EXISTS_TTL_MS) return true;
	const info = await conn.getAccountInfo(ata, 'confirmed');
	if (info) cacheSet(ataExistsCache, key, { at: Date.now() });
	return Boolean(info);
}

async function getRecentBlockhash(conn, cluster) {
	const hit = blockhashCache.get(cluster);
	if (hit && Date.now() - hit.at < BLOCKHASH_TTL_MS) return hit.blockhash;
	const { blockhash } = await conn.getLatestBlockhash('confirmed');
	cacheSet(blockhashCache, cluster, { blockhash, at: Date.now() }, 8);
	return blockhash;
}

/**
 * Build the partially-signed v0 SPL `transferChecked` the buyer's Phantom wallet
 * should add its signature to. The fee payer is `accept.extra.feePayer` (the
 * facilitator's sponsor), so the buyer pays only USDC.
 *
 * @param {object} args
 * @param {object} args.accept   one x402 `accept` entry (scheme=exact, Solana)
 * @param {string} args.buyer    buyer's base58 Solana address
 * @param {string} [args.rpcUrl] mainnet RPC URL override
 * @param {string[]} [args.rpcUrls] mainnet RPC URLs for failover (preferred)
 * @param {string} [args.devnetRpcUrl] devnet RPC URL override
 * @param {string[]} [args.devnetRpcUrls] devnet RPC URLs for failover
 * @returns {Promise<{ network: string, tx_base64: string, recent_blockhash: string }>}
 */
export async function prepareSolanaCheckout({ accept, buyer, rpcUrl, rpcUrls, devnetRpcUrl, devnetRpcUrls }) {
	validateAccept(accept);
	assertPubkey(buyer, 'buyer');

	const urls = rpcListFor(accept.network, { rpcUrl, rpcUrls, devnetRpcUrl, devnetRpcUrls });
	const cluster = clusterFor(accept.network);

	const mint = new PublicKey(accept.asset);
	const payTo = new PublicKey(accept.payTo);
	const feePayer = new PublicKey(accept.extra.feePayer);
	const buyerPubkey = new PublicKey(buyer);
	const amount = BigInt(accept.amount);

	return withFailover(urls, async (conn) => {
		// Pick the owning token program (legacy SPL Token vs Token-2022) so ATAs,
		// the idempotent create, and transferChecked all target the right program —
		// THREE and other pump.fun mints are Token-2022. This must resolve first
		// because the ATA derivations depend on it.
		const tokenProgramId = await getTokenProgramId(conn, cluster, mint);

		const senderAta = getAssociatedTokenAddressSync(
			mint, buyerPubkey, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID,
		);
		const receiverAta = getAssociatedTokenAddressSync(
			mint, payTo, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID,
		);

		// The three remaining reads are independent — fan them out in parallel
		// instead of serially (cuts prepare latency ~40% on a cold cache, near
		// zero when decimals/program/ATA are all cached).
		const [mintDecimals, receiverPresent, blockhash] = await Promise.all([
			getMintDecimals(conn, cluster, mint, tokenProgramId),
			receiverAtaExists(conn, cluster, receiverAta),
			getRecentBlockhash(conn, cluster),
		]);

		const ixs = [
			ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
			ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
		];
		// Create the recipient's token account if it doesn't exist yet — idempotent,
		// paid for by the fee payer so the buyer is never charged extra SOL.
		if (!receiverPresent) {
			ixs.push(
				createAssociatedTokenAccountIdempotentInstruction(
					feePayer, receiverAta, payTo, mint, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID,
				),
			);
		}
		ixs.push(
			createTransferCheckedInstruction(
				senderAta, mint, receiverAta, buyerPubkey, amount, mintDecimals, [], tokenProgramId,
			),
		);

		const message = new TransactionMessage({
			payerKey: feePayer,
			recentBlockhash: blockhash,
			instructions: ixs,
		}).compileToV0Message();
		const vtx = new VersionedTransaction(message);

		return {
			network: accept.network,
			tx_base64: Buffer.from(vtx.serialize()).toString('base64'),
			recent_blockhash: blockhash,
		};
	});
}

const BUILDER_CODE_PATTERN = /^[a-z0-9_]{1,32}$/;
function sanitizeBuilderCode(builderCode) {
	if (!builderCode || typeof builderCode !== 'object') return null;
	const a = builderCode.a;
	if (typeof a !== 'string' || !BUILDER_CODE_PATTERN.test(a)) return null;
	const out = { a };
	if (typeof builderCode.w === 'string' && BUILDER_CODE_PATTERN.test(builderCode.w)) out.w = builderCode.w;
	if (Array.isArray(builderCode.s)) {
		const s = builderCode.s.filter((x) => typeof x === 'string' && BUILDER_CODE_PATTERN.test(x)).slice(0, 32);
		if (s.length) out.s = s;
	}
	return out;
}

/**
 * Wrap a buyer-signed Solana transaction into the base64 `X-PAYMENT` envelope.
 *
 * @param {object} args
 * @param {object} args.accept            the same accept entry used in prepare
 * @param {string} args.signedTxBase64    base64 of the fully buyer-signed v0 tx
 * @param {string} args.resourceUrl       absolute URL of the paid resource
 * @param {object} [args.builderCode]     optional ERC-8021 builder-code echo
 * @returns {{ x_payment: string }}
 */
export function encodeX402Payment({ accept, signedTxBase64, resourceUrl, builderCode }) {
	validateAccept(accept);
	if (typeof signedTxBase64 !== 'string' || signedTxBase64.length < 40) {
		throw new CheckoutError(400, 'invalid_request', 'signedTxBase64 is required');
	}
	let url;
	try {
		url = new URL(resourceUrl).href;
	} catch {
		throw new CheckoutError(400, 'invalid_request', 'resourceUrl must be an absolute URL');
	}

	const payload = {
		x402Version: X402_VERSION,
		scheme: 'exact',
		network: accept.network,
		resource: { url, mimeType: 'application/json' },
		accepted: accept,
		payload: { transaction: signedTxBase64 },
	};
	const echo = sanitizeBuilderCode(builderCode);
	if (echo) payload.extensions = { 'builder-code': echo };

	return { x_payment: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64') };
}

/**
 * Route an action ('prepare' | 'encode') to its handler and return a plain
 * `{ status, body }` pair the framework adapters serialize as JSON. Accepts the
 * camelCase fields the helpers use *and* the snake_case fields the browser modal
 * POSTs (`signed_tx_base64`, `resource_url`, `builder_code`).
 *
 * @param {object} args
 * @param {'prepare'|'encode'} args.action
 * @param {object} args.body   parsed JSON request body
 * @param {object} [args.options] { rpcUrl, rpcUrls, devnetRpcUrl, devnetRpcUrls, logger }
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handleCheckout({ action, body = {}, options = {} }) {
	const log = typeof options.logger === 'function' ? options.logger : console.error;
	try {
		if (action === 'prepare') {
			const data = await prepareSolanaCheckout({
				accept: body.accept,
				buyer: body.buyer,
				rpcUrl: options.rpcUrl,
				rpcUrls: options.rpcUrls,
				devnetRpcUrl: options.devnetRpcUrl,
				devnetRpcUrls: options.devnetRpcUrls,
			});
			return { status: 200, body: data };
		}
		if (action === 'encode') {
			const data = encodeX402Payment({
				accept: body.accept,
				signedTxBase64: body.signedTxBase64 ?? body.signed_tx_base64,
				resourceUrl: body.resourceUrl ?? body.resource_url,
				builderCode: body.builderCode ?? body.builder_code,
			});
			return { status: 200, body: data };
		}
		return {
			status: 404,
			body: { error: 'not_found', error_description: `unknown action: ${action ?? '(none)'}` },
		};
	} catch (err) {
		if (err instanceof CheckoutError) {
			return { status: err.status, body: { error: err.code, error_description: err.message } };
		}
		// Unexpected (RPC down, malformed tx). The caller sees a generic 502, but
		// ops needs the root cause — log it instead of swallowing it silently.
		log(`[x402-payment-modal] checkout ${action} failed:`, err?.stack || err?.message || err);
		return {
			status: 502,
			body: { error: 'checkout_failed', error_description: 'Could not build the Solana payment. Try again.' },
		};
	}
}
