// @three-ws/pumpfun-skills: pump.fun launch + trade as composable agent tools.
// The SDK twin of the pumpfun_create_coin / pumpfun_swap / pumpfun_collect_fees
// skills: every build call posts your inputs to pump.fun's agent transaction API
// and hands back a base64 transaction you co-sign and broadcast; coinFees reads
// the public coins-v2 API. The mint, amounts, and wallet are supplied at call
// time, nothing is hardcoded. See README.md for the full reference.

import { createHttp, ThreeWsError } from './http.js';

export { ThreeWsError, PaymentRequiredError, DEFAULT_BASE_URL } from './http.js';

/** pump.fun's agent transaction API: builds the unsigned/mint-signed tx. */
export const AGENT_API_BASE = 'https://fun-block.pump.fun/agents';
/** pump.fun's public coins read API. Override with PUMP_COINS_V2_BASE. */
export const COINS_V2_BASE = 'https://frontend-api-v3.pump.fun/coins-v2';
/** Wrapped-SOL mint. Use as inputMint for buys, outputMint for sells. */
export const NATIVE_MINT = 'So11111111111111111111111111111111111111112';

const FEE_DESTINATIONS = ['creator', 'cashback', 'sharing_config'];

/**
 * Create a pump.fun skills client bound to a transport, agent API base, and
 * coins read base. For most callers the default exports
 * (`createCoin` / `swap` / `coinFees` / `collectFees` / `sharingConfig`) are
 * enough; use this to reuse configuration (a payment-aware `fetch`, a devnet
 * read backend, or a custom agent origin) across many calls.
 *
 * @param {object} [options]
 * @param {string} [options.agentBaseUrl]  Agent build API origin (default fun-block.pump.fun/agents).
 * @param {string} [options.coinsV2Base]   coins-v2 read origin (default frontend-api-v3, or PUMP_COINS_V2_BASE).
 * @param {typeof fetch} [options.fetch]   fetch implementation (default globalThis.fetch).
 * @param {string} [options.apiKey]        Bearer token attached to build calls.
 * @param {Record<string,string>} [options.headers]  Extra headers on every call.
 */
export function createPumpfunSkills(options = {}) {
	// Build calls hit pump.fun's agent API; reads hit coins-v2. Both are off the
	// three.ws origin, so each gets its own createHttp bound to the right base.
	const agentBaseUrl = String(options.agentBaseUrl || AGENT_API_BASE).replace(/\/+$/, '');
	const coinsV2Base = resolveCoinsV2Base(options.coinsV2Base);
	const build = createHttp({ ...options, baseUrl: agentBaseUrl });
	const read = createHttp({ baseUrl: coinsV2Base, fetch: options.fetch, headers: options.headers });

	// Post the inputs (camelCase, as the agent API expects) plus encoding:base64,
	// and return the built transaction. Every build endpoint shares this shape.
	// `path` is relative so it resolves under the base's /agents segment.
	function postBuild(path, body, opts = {}) {
		return build(path, {
			method: 'POST',
			body: { ...prune(body), encoding: 'base64' },
			headers: opts.headers,
			signal: opts.signal,
		});
	}

	/** Build a new-coin transaction (mint keypair already signed). */
	async function createCoin(input = {}, opts = {}) {
		requireString(input.user, 'user', 'createCoin');
		requireString(input.name, 'name', 'createCoin');
		requireString(input.symbol, 'symbol', 'createCoin');
		requireString(input.uri, 'uri', 'createCoin');
		requireString(input.solLamports, 'solLamports', 'createCoin');
		assertJitoTip(input, 'createCoin');

		const res = await postBuild('create-coin', {
			user: input.user,
			name: input.name,
			symbol: input.symbol,
			uri: input.uri,
			solLamports: input.solLamports,
			mayhemMode: input.mayhemMode,
			cashback: input.cashback,
			tokenizedAgent: input.tokenizedAgent,
			buybackBps: input.buybackBps,
			frontRunningProtection: input.frontRunningProtection,
			tipAmount: input.tipAmount,
			feePayer: input.feePayer,
			creator: input.creator,
		}, opts);

		const tx = shapeTx(res, 'create-coin');
		// The agent API names the new mint `mintPublicKey`; the README headlines `mint`.
		tx.mint = res.mintPublicKey ?? res.mint ?? null;
		if (res.brandMark != null) tx.brandMark = res.brandMark;
		return tx;
	}

	/** Build a buy or sell (auto-routes bonding curve vs graduated AMM). */
	async function swap(input = {}, opts = {}) {
		requireString(input.inputMint, 'inputMint', 'swap');
		requireString(input.outputMint, 'outputMint', 'swap');
		requireString(input.amount, 'amount', 'swap');
		requireString(input.user, 'user', 'swap');
		assertJitoTip(input, 'swap');

		const res = await postBuild('swap', {
			inputMint: input.inputMint,
			outputMint: input.outputMint,
			amount: input.amount,
			user: input.user,
			slippagePct: input.slippagePct,
			feePayer: input.feePayer,
			frontRunningProtection: input.frontRunningProtection,
			tipAmount: input.tipAmount,
		}, opts);

		return shapeTx(res, 'swap');
	}

	/** Build a collect-creator-fees / distribute-via-sharing transaction. */
	async function collectFees(input = {}, opts = {}) {
		requireString(input.mint, 'mint', 'collectFees');
		requireString(input.user, 'user', 'collectFees');
		assertJitoTip(input, 'collectFees');

		const res = await postBuild('collect-fees', {
			mint: input.mint,
			user: input.user,
			frontRunningProtection: input.frontRunningProtection,
			tipAmount: input.tipAmount,
		}, opts);

		return shapeTx(res, 'collect-fees');
	}

	/** Build a create-or-update fee-sharing-config transaction. */
	async function sharingConfig(input = {}, opts = {}) {
		requireString(input.mint, 'mint', 'sharingConfig');
		requireString(input.user, 'user', 'sharingConfig');
		validateShareholders(input.shareholders);
		if (input.mode !== undefined && input.mode !== 'create' && input.mode !== 'update') {
			throw new ThreeWsError(`Invalid mode "${input.mode}". Expected 'create' or 'update'.`, { code: 'invalid_input' });
		}
		assertJitoTip(input, 'sharingConfig');

		const res = await postBuild('sharing-config', {
			mint: input.mint,
			user: input.user,
			shareholders: input.shareholders,
			mode: input.mode,
			frontRunningProtection: input.frontRunningProtection,
			tipAmount: input.tipAmount,
		}, opts);

		return shapeTx(res, 'sharing-config');
	}

	/** Read the fee destination, vault balances, and graduation state for a mint. */
	async function coinFees(mint, opts = {}) {
		requireString(mint, 'mint', 'coinFees');
		const coin = await read(`${encodeURIComponent(mint)}`, { signal: opts.signal });
		if (!coin || typeof coin !== 'object') {
			throw new ThreeWsError(
				`coins-v2 returned an empty body for mint ${mint}. If using devnet, set PUMP_COINS_V2_BASE to the devnet coins API.`,
				{ code: 'empty_coin' },
			);
		}
		return shapeFeeInfo(coin, mint);
	}

	return { createCoin, swap, collectFees, sharingConfig, coinFees };
}

// A module-level default client for the zero-config path: `import { swap }`.
let shared = null;
function defaultClient() {
	return (shared ||= createPumpfunSkills());
}

/** Build a new-coin transaction with an optional initial buy. */
export function createCoin(input, opts) {
	return defaultClient().createCoin(input, opts);
}
/** Build a buy or sell on the bonding curve or graduated AMM. */
export function swap(input, opts) {
	return defaultClient().swap(input, opts);
}
/** Build a collect-creator-fees / distribute transaction. */
export function collectFees(input, opts) {
	return defaultClient().collectFees(input, opts);
}
/** Create or update a fee-sharing config (shareholder bps must total 10000). */
export function sharingConfig(input, opts) {
	return defaultClient().sharingConfig(input, opts);
}
/** Read the fee destination, vault balances, and graduation state for a mint. */
export function coinFees(mint, opts) {
	return defaultClient().coinFees(mint, opts);
}

// --- shaping ---------------------------------------------------------------

// Every build endpoint replies with a base64 `transaction`; create-coin also
// carries the new mint. Convert the agent API's snake/camel fields to a stable
// camelCase object, keeping `.raw` as an escape hatch.
function shapeTx(res, path) {
	if (!res || typeof res !== 'object') {
		throw new ThreeWsError(`Unexpected empty response from ${path}.`, { code: 'bad_response' });
	}
	const transaction = res.transaction ?? res.tx ?? null;
	if (!transaction) {
		throw new ThreeWsError(`${path} did not return a transaction.`, { code: 'bad_response', body: res });
	}
	return {
		transaction,
		encoding: res.encoding ?? 'base64',
		frontRunningProtection: Boolean(res.frontRunningProtection ?? res.front_running_protection),
		raw: res,
	};
}

// coins-v2 carries the on-chain state we can read without an RPC: creator,
// bonding-curve PDA, AMM pool (when graduated), and cashback routing. Derive the
// FeeInfo shape the README documents; balances that need a creator-vault account
// read default to '0' (the on-chain script path resolves them in full).
function shapeFeeInfo(coin, mint) {
	const isGraduated = Boolean(coin.complete);
	const pool = coin.pump_swap_pool ?? coin.pool ?? null;
	const isCashbackCoin = readCashback(coin);

	const sharingConfig = shapeSharingConfig(coin.sharing_config ?? coin.sharingConfig);
	const hasSharingConfig = sharingConfig != null;

	let feeDestination;
	if (isCashbackCoin) feeDestination = 'cashback';
	else if (hasSharingConfig) feeDestination = 'sharing_config';
	else feeDestination = 'creator';

	return {
		mint: coin.mint ?? mint,
		bondingCurve: coin.bonding_curve ?? coin.bondingCurve ?? null,
		pool: pool || null,
		isGraduated,
		isCashbackCoin,
		hasSharingConfig,
		creator: coin.creator ?? null,
		creatorVaultLamports: String(coin.creator_vault_lamports ?? coin.creatorVaultLamports ?? '0'),
		sharingConfig,
		feeDestination,
		raw: coin,
	};
}

function shapeSharingConfig(cfg) {
	if (!cfg || typeof cfg !== 'object') return null;
	const shareholders = Array.isArray(cfg.shareholders)
		? cfg.shareholders.map((s) => ({ address: s.address, bps: Number(s.bps ?? s.share) }))
		: [];
	return {
		address: cfg.address ?? null,
		admin: cfg.admin ?? null,
		adminRevoked: Boolean(cfg.admin_revoked ?? cfg.adminRevoked),
		shareholders,
	};
}

// pump.fun encodes cashback either as a plain boolean or an Anchor option tuple.
function readCashback(coin) {
	const raw = coin.is_cashback_coin ?? coin.isCashbackCoin;
	if (raw === true) return true;
	if (Array.isArray(raw)) return raw[0] === true;
	return false;
}

// --- validation ------------------------------------------------------------

function requireString(value, field, fn) {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new ThreeWsError(`${fn}() needs a non-empty \`${field}\`.`, { code: 'invalid_input' });
	}
}

// Shareholder bps must total exactly 10000, capped at 10 entries (program limit).
function validateShareholders(shareholders) {
	if (!Array.isArray(shareholders) || shareholders.length === 0) {
		throw new ThreeWsError('sharingConfig() needs a non-empty `shareholders` array.', { code: 'invalid_input' });
	}
	if (shareholders.length > 10) {
		throw new ThreeWsError('sharingConfig() allows at most 10 shareholders.', { code: 'invalid_input' });
	}
	let total = 0;
	for (const s of shareholders) {
		if (!s || typeof s.address !== 'string' || s.address.trim() === '' || !Number.isFinite(Number(s.bps))) {
			throw new ThreeWsError('Each shareholder needs an `address` string and numeric `bps`.', { code: 'invalid_input' });
		}
		total += Number(s.bps);
	}
	if (total !== 10000) {
		throw new ThreeWsError(`Shareholder bps must sum to 10000, got ${total}.`, { code: 'invalid_input' });
	}
}

// Jito routing needs a tip: fail fast before the build call rather than letting
// pump.fun reject it (mirrors the README's edge-case table).
function assertJitoTip(input, fn) {
	if (input.frontRunningProtection && (input.tipAmount === undefined || input.tipAmount === null)) {
		throw new ThreeWsError(`${fn}() with frontRunningProtection needs a \`tipAmount\` (Jito tip in SOL).`, { code: 'invalid_input' });
	}
}

// --- helpers ---------------------------------------------------------------

function resolveCoinsV2Base(explicit) {
	const env = typeof process !== 'undefined' && process.env ? process.env.PUMP_COINS_V2_BASE : null;
	return String(explicit || env || COINS_V2_BASE).replace(/\/+$/, '');
}

function prune(obj) {
	const out = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null) continue;
		out[k] = v;
	}
	return out;
}

// Re-export the canonical fee-destination set for callers that switch on it.
export { FEE_DESTINATIONS };
