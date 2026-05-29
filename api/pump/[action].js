// Consolidated pump.fun API dispatcher.
//
// Routes via Vercel's [action] file param. Single bundle replaces 22 separate
// serverless functions, each of which used to import @solana/web3.js and the
// @pump-fun/* SDKs from scratch.
//
// Action map:
//   balances                 -> handleBalances
//   buy-prep                 -> handleBuyPrep
//   buy-confirm              -> handleBuyConfirm
//   sell-prep                -> handleSellPrep
//   sell-confirm             -> handleSellConfirm
//   launch-prep              -> handleLaunchPrep
//   launch-confirm           -> handleLaunchConfirm
//   launch-agent             -> handleLaunchAgent (server-side signing via agent wallet)
//   agent-wallet             -> handleAgentWallet (resolve agent + Solana wallet info)
//   accept-payment-prep      -> handleAcceptPaymentPrep
//   accept-payment-confirm   -> handleAcceptPaymentConfirm
//   payments-list            -> handlePaymentsList
//   portfolio                -> handlePortfolio
//   by-agent                 -> handleByAgent
//   quote                    -> handleQuote
//   governance-prep          -> handleGovernancePrep
//   withdraw-prep            -> handleWithdrawPrep
//   withdraw-confirm         -> handleWithdrawConfirm
//   strategy-backtest        -> handleStrategyBacktest
//   strategy-close-all       -> handleStrategyCloseAll
//   strategy-run             -> handleStrategyRun (SSE; bypasses wrap())
//   strategy-validate        -> handleStrategyValidate
//   live-stream              -> handleLiveStream  (SSE; bypasses wrap())
//   collect-creator-fee-prep      -> handleCollectCreatorFeePrep
//   distribute-creator-fees-prep  -> handleDistributeCreatorFeesPrep
//                                    (auto-prepends transfer_creator_fees_to_pump_v2
//                                     for graduated coins; ATA-init for non-native
//                                     quotes is handled internally by the SDK)
//   create-fee-sharing-prep       -> handleCreateFeeSharingPrep   (step 1)
//   update-fee-shares-prep        -> handleUpdateFeeSharesPrep    (step 2)

import { z } from 'zod';
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { putObject, publicUrl as r2PublicUrl } from '../_lib/r2.js';
import { env } from '../_lib/env.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { parse } from '../_lib/validate.js';
import { randomToken } from '../_lib/crypto.js';
import {
	getConnection,
	getPumpSdk,
	getPumpSdkV2,
	getPumpAgent,
	getPumpAgentOffline,
	getAmmPoolState,
	buildUnsignedTxBase64,
	verifySignature,
	solanaPubkey,
} from '../_lib/pump.js';

// Wrapped SOL mint — required as the quoteMint for SOL-paired V2 instructions
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
import { solanaConnection, loadAgentForSigning } from '../_lib/agent-pumpfun.js';
import { connectPumpFunFeed } from '../_lib/pumpfun-ws-feed.js';
import { makeRuntime } from '../_lib/skill-runtime.js';
import { loadWallet } from '../_lib/solana-wallet.js';
import { checkBuyAllowed } from '../_lib/agent-spend-policy.js';
import {
	SOLANA_USDC_MINT,
	SOLANA_USDC_MINT_DEVNET,
	toUsdcAtomics,
} from '../payments/_config.js';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

const RPC = {
	mainnet: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
	devnet: process.env.SOLANA_RPC_URL_DEVNET || 'https://api.devnet.solana.com',
};

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

const wrapped = wrap(async (req, res) => {
	const action = req.query?.action;
	switch (action) {
		case 'balances':                return handleBalances(req, res);
		case 'buy-prep':                return handleBuyPrep(req, res);
		case 'buy-confirm':             return handleBuyConfirm(req, res);
		case 'sell-prep':               return handleSellPrep(req, res);
		case 'sell-confirm':            return handleSellConfirm(req, res);
		case 'build-metadata':          return handleBuildMetadata(req, res);
		case 'launch-prep':             return handleLaunchPrep(req, res);
		case 'launch-confirm':          return handleLaunchConfirm(req, res);
		case 'launch-agent':            return handleLaunchAgent(req, res);
		case 'agent-wallet':            return handleAgentWallet(req, res);
		case 'accept-payment-prep':     return handleAcceptPaymentPrep(req, res);
		case 'accept-payment-confirm':  return handleAcceptPaymentConfirm(req, res);
		case 'payments-list':           return handlePaymentsList(req, res);
		case 'portfolio':               return handlePortfolio(req, res);
		case 'by-agent':                return handleByAgent(req, res);
		case 'quote':                   return handleQuote(req, res);
		case 'governance-prep':         return handleGovernancePrep(req, res);
		case 'withdraw-prep':           return handleWithdrawPrep(req, res);
		case 'withdraw-confirm':        return handleWithdrawConfirm(req, res);
		case 'strategy-backtest':       return handleStrategyBacktest(req, res);
		case 'strategy-close-all':      return handleStrategyCloseAll(req, res);
		case 'strategy-validate':       return handleStrategyValidate(req, res);
		case 'channel-feed':            return handleChannelFeed(req, res);
		case 'deliver-telegram':        return handleDeliverTelegram(req, res);
		case 'first-claims':            return handleFirstClaims(req, res);
		case 'recent-graduations':            return handleRecentGraduations(req, res);
		case 'trending':                      return handleTrending(req, res);
		case 'search':                        return handleSearch(req, res);
		case 'collect-creator-fee-prep':      return handleCollectCreatorFeePrep(req, res);
		case 'distribute-creator-fees-prep':  return handleDistributeCreatorFeesPrep(req, res);
		case 'create-fee-sharing-prep':       return handleCreateFeeSharingPrep(req, res);
		case 'update-fee-shares-prep':        return handleUpdateFeeSharesPrep(req, res);
		default:
			return error(res, 404, 'not_found', 'unknown pump action');
	}
});

// SSE actions bypass wrap()'s JSON-error fallback — they manage their own response writes.
export default async function dispatcher(req, res) {
	if (req.query?.action === 'strategy-run') return handleStrategyRun(req, res);
	if (req.query?.action === 'vanity-keygen') return handleVanityKeygen(req, res);
	if (req.query?.action === 'live-stream') return handleLiveStream(req, res);
	// `trades-stream` is served by the dedicated api/pump/trades-stream.js file
	// (static routes win over [action]); no dispatch needed here.
	return wrapped(req, res);
}

// ── balances ───────────────────────────────────────────────────────────────

async function handleBalances(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const url = new URL(req.url, `http://${req.headers.host}`);
	const mintStr = url.searchParams.get('mint');
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	const currencyArg = url.searchParams.get('currency');

	const mint = solanaPubkey(mintStr);
	if (!mint) return error(res, 400, 'validation_error', 'invalid mint');

	const currencyStr =
		currencyArg || (network === 'devnet' ? SOLANA_USDC_MINT_DEVNET : SOLANA_USDC_MINT);
	const currency = solanaPubkey(currencyStr);
	if (!currency) return error(res, 400, 'validation_error', 'invalid currency');

	try {
		const { agent, agentPda } = await getPumpAgent({ network, mint });
		const balances = await agent.getBalances(currency);
		const fmt = (v) =>
			v && {
				address: v.address?.toString?.() ?? String(v.address),
				balance: v.balance?.toString?.() ?? String(v.balance ?? 0),
			};
		return json(res, 200, {
			mint: mintStr,
			network,
			currency: currencyStr,
			agent_pda: agentPda?.toString?.() ?? null,
			balances: {
				payment: fmt(balances.paymentVault),
				buyback: fmt(balances.buybackVault),
				withdraw: fmt(balances.withdrawVault),
			},
		});
	} catch (err) {
		// Most common: agent not yet bound to mint → PDA missing.
		return error(res, 502, 'pump_agent_error', err.message || 'pump-agent SDK error');
	}
}

// ── buy-prep ───────────────────────────────────────────────────────────────

const buyPrepSchema = z.object({
	mint: z.string().min(32).max(44),
	network: z.enum(['mainnet', 'devnet']).default('mainnet'),
	// For SOL-paired coins pass `sol`; for USDC-paired coins pass `usdc_amount`.
	// Exactly one must be provided — validation enforced below.
	sol: z.number().positive().max(50).optional(),
	usdc_amount: z.number().positive().max(1_000_000).optional(),
	// Optional explicit quote mint. When omitted the server auto-detects from
	// the on-chain bonding curve (quote_mint field added in pump.fun V2).
	quote_mint: z.string().min(32).max(44).optional(),
	slippage_bps: z.number().int().min(0).max(5000).default(100),
	wallet_address: z.string().min(32).max(44),
}).refine((v) => v.sol != null || v.usdc_amount != null, {
	message: 'sol or usdc_amount required',
	path: ['sol'],
});

async function handleBuyPrep(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = parse(buyPrepSchema, await readJson(req));
	const userPk = solanaPubkey(body.wallet_address);
	const mintPk = solanaPubkey(body.mint);
	if (!userPk || !mintPk) return error(res, 400, 'validation_error', 'invalid pubkeys');

	try {
		const { sdk, BN, web3 } = await getPumpSdk({ network: body.network });
		const { isLegacyQuoteMint } = await import('@pump-fun/pump-sdk');
		const slippage = body.slippage_bps / 10_000;

		// Fetch bonding curve state — also gives us the on-chain quote_mint.
		let buyState = null;
		try {
			if (sdk.fetchBuyState) buyState = await sdk.fetchBuyState(mintPk, userPk);
		} catch {
			buyState = null;
		}

		// Resolve quoteMint: explicit override > on-chain curve > WSOL fallback.
		let quoteMintPk = body.quote_mint
			? solanaPubkey(body.quote_mint)
			: (buyState?.bondingCurve?.quoteMint ?? solanaPubkey(WSOL_MINT));
		if (!quoteMintPk) quoteMintPk = solanaPubkey(WSOL_MINT);

		const isUsdcQuote = !isLegacyQuoteMint(quoteMintPk);

		if (buyState && buyState.bondingCurve && !buyState.bondingCurve.complete) {
			const global = await sdk.fetchGlobal();
			let tx_base64;
			if (isUsdcQuote) {
				if (body.usdc_amount == null)
					return error(res, 400, 'validation_error', 'usdc_amount required for USDC-paired coin');
				const quoteAtomics = new BN(Math.round(body.usdc_amount * 1_000_000));
				const ixs = await sdk.buyV2Instructions({
					global,
					bondingCurveAccountInfo: buyState.bondingCurveAccountInfo,
					bondingCurve: buyState.bondingCurve,
					associatedUserAccountInfo: buyState.associatedUserAccountInfo,
					mint: mintPk,
					user: userPk,
					amount: new BN(0),
					quoteAmount: quoteAtomics,
					slippage,
					quoteMint: quoteMintPk,
				});
				tx_base64 = await buildUnsignedTxBase64({
					network: body.network, payer: userPk, instructions: ixs,
				});
				return json(res, 201, {
					route: 'bonding_curve',
					mint: body.mint,
					network: body.network,
					quote_mint: quoteMintPk.toString(),
					usdc_in: body.usdc_amount,
					slippage_bps: body.slippage_bps,
					tx_base64,
				});
			}

			// SOL-paired (legacy)
			if (body.sol == null)
				return error(res, 400, 'validation_error', 'sol required for SOL-paired coin');
			const lamports = new BN(Math.floor(body.sol * web3.LAMPORTS_PER_SOL));
			const ixs = await sdk.buyInstructions({
				global,
				bondingCurveAccountInfo: buyState.bondingCurveAccountInfo,
				bondingCurve: buyState.bondingCurve,
				associatedUserAccountInfo: buyState.associatedUserAccountInfo,
				mint: mintPk,
				user: userPk,
				amount: new BN(0),
				solAmount: lamports,
				slippage,
			});
			tx_base64 = await buildUnsignedTxBase64({
				network: body.network, payer: userPk, instructions: ixs,
			});
			return json(res, 201, {
				route: 'bonding_curve',
				mint: body.mint,
				network: body.network,
				quote_mint: quoteMintPk.toString(),
				sol_in: body.sol,
				slippage_bps: body.slippage_bps,
				tx_base64,
			});
		}

		// AMM (post-graduation)
		const amm = await getAmmPoolState({ network: body.network, mint: mintPk, quoteMint: isUsdcQuote ? quoteMintPk : null });
		const ammMod = await import('@pump-fun/pump-swap-sdk');
		const offline = new ammMod.PumpAmmSdk();
		const onlineAmm = new ammMod.OnlinePumpAmmSdk(getConnection({ network: body.network }));
		const swapState = await onlineAmm.swapSolanaState(amm.poolKey, userPk);

		const quoteIn = isUsdcQuote
			? new BN(Math.round(body.usdc_amount * 1_000_000))
			: new BN(Math.floor(body.sol * web3.LAMPORTS_PER_SOL));
		if (body.usdc_amount == null && isUsdcQuote)
			return error(res, 400, 'validation_error', 'usdc_amount required for USDC AMM pool');
		if (body.sol == null && !isUsdcQuote)
			return error(res, 400, 'validation_error', 'sol required for SOL AMM pool');

		const ixs = await offline.buyQuoteInput(swapState, quoteIn, slippage);
		const tx_base64 = await buildUnsignedTxBase64({
			network: body.network, payer: userPk, instructions: ixs,
		});
		return json(res, 201, {
			route: 'amm',
			pool: amm.poolKey.toString(),
			mint: body.mint,
			network: body.network,
			quote_mint: quoteMintPk.toString(),
			...(isUsdcQuote ? { usdc_in: body.usdc_amount } : { sol_in: body.sol }),
			slippage_bps: body.slippage_bps,
			tx_base64,
		});
	} catch (e) {
		return error(
			res,
			e.status || 502,
			e.code || 'pump_sdk_error',
			e.message || 'failed to build buy tx',
		);
	}
}

// ── buy-confirm ────────────────────────────────────────────────────────────

const buyConfirmSchema = z.object({
	mint: z.string().min(32).max(44),
	network: z.enum(['mainnet', 'devnet']).default('mainnet'),
	tx_signature: z.string().min(80).max(100),
	wallet_address: z.string().min(32).max(44),
	sol: z.number().positive().max(50),
	route: z.enum(['bonding_curve', 'amm']),
	slippage_bps: z.number().int().min(0).max(5000).optional(),
});

async function handleBuyConfirm(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = parse(buyConfirmSchema, await readJson(req));

	const [mintRow] = await sql`
		select id from pump_agent_mints where mint=${body.mint} and network=${body.network} limit 1
	`;
	const mintId = mintRow?.id ?? null;

	let tx;
	try {
		tx = await verifySignature({ network: body.network, signature: body.tx_signature });
	} catch (e) {
		return error(res, e.status || 422, e.code || 'tx_failed', e.message);
	}
	const accountKeys = tx.transaction.message.accountKeys.map((k) => (k.pubkey || k).toString());
	if (!accountKeys.includes(body.mint))
		return error(res, 422, 'mint_not_in_tx', 'mint not in tx');
	if (!accountKeys.includes(body.wallet_address))
		return error(res, 422, 'wallet_not_in_tx', 'wallet not in tx');

	if (mintId) {
		const lamports = BigInt(Math.floor(body.sol * 1_000_000_000));
		await sql`
			insert into pump_agent_trades
				(mint_id, user_id, wallet, direction, route, sol_amount, slippage_bps, tx_signature, network)
			values
				(${mintId}, ${user.id}, ${body.wallet_address}, 'buy', ${body.route},
				 ${lamports.toString()}, ${body.slippage_bps ?? null}, ${body.tx_signature}, ${body.network})
			on conflict (tx_signature, network) do nothing
		`;
	}

	return json(res, 200, {
		ok: true,
		tracked: !!mintId,
		mint: body.mint,
		network: body.network,
		tx_signature: body.tx_signature,
	});
}

// ── sell-prep ──────────────────────────────────────────────────────────────

const sellPrepSchema = z.object({
	mint: z.string().min(32).max(44),
	network: z.enum(['mainnet', 'devnet']).default('mainnet'),
	tokens: z.string().regex(/^\d+$/, 'tokens must be a base-units integer string'),
	slippage_bps: z.number().int().min(0).max(5000).default(100),
	wallet_address: z.string().min(32).max(44),
	// Optional — auto-detected from on-chain bonding curve when omitted.
	quote_mint: z.string().min(32).max(44).optional(),
});

async function handleSellPrep(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = parse(sellPrepSchema, await readJson(req));
	const userPk = solanaPubkey(body.wallet_address);
	const mintPk = solanaPubkey(body.mint);
	if (!userPk || !mintPk) return error(res, 400, 'validation_error', 'invalid pubkeys');

	try {
		const { sdk, BN } = await getPumpSdk({ network: body.network });
		const { isLegacyQuoteMint } = await import('@pump-fun/pump-sdk');
		const tokens = new BN(body.tokens);
		const slippage = body.slippage_bps / 10_000;

		let sellState = null;
		try {
			if (sdk.fetchSellState) sellState = await sdk.fetchSellState(mintPk, userPk);
		} catch {
			sellState = null;
		}

		// Resolve quoteMint from explicit override > on-chain curve > WSOL fallback.
		let quoteMintPk = body.quote_mint
			? solanaPubkey(body.quote_mint)
			: (sellState?.bondingCurve?.quoteMint ?? solanaPubkey(WSOL_MINT));
		if (!quoteMintPk) quoteMintPk = solanaPubkey(WSOL_MINT);

		const isUsdcQuote = !isLegacyQuoteMint(quoteMintPk);

		if (sellState && sellState.bondingCurve && !sellState.bondingCurve.complete) {
			const global = await sdk.fetchGlobal();
			let ixs;
			if (isUsdcQuote) {
				ixs = await sdk.sellV2Instructions({
					global,
					bondingCurveAccountInfo: sellState.bondingCurveAccountInfo,
					bondingCurve: sellState.bondingCurve,
					mint: mintPk,
					user: userPk,
					amount: tokens,
					quoteAmount: new BN(0),
					slippage,
					quoteMint: quoteMintPk,
				});
			} else {
				ixs = await sdk.sellInstructions({
					global,
					bondingCurveAccountInfo: sellState.bondingCurveAccountInfo,
					bondingCurve: sellState.bondingCurve,
					mint: mintPk,
					user: userPk,
					amount: tokens,
					solAmount: new BN(0),
					slippage,
				});
			}
			const tx_base64 = await buildUnsignedTxBase64({
				network: body.network,
				payer: userPk,
				instructions: ixs,
			});
			return json(res, 201, {
				route: 'bonding_curve',
				mint: body.mint,
				network: body.network,
				quote_mint: quoteMintPk.toString(),
				tokens_in: body.tokens,
				slippage_bps: body.slippage_bps,
				tx_base64,
			});
		}

		const amm = await getAmmPoolState({ network: body.network, mint: mintPk, quoteMint: isUsdcQuote ? quoteMintPk : null });
		const ammMod = await import('@pump-fun/pump-swap-sdk');
		const offline = new ammMod.PumpAmmSdk();
		const onlineAmm = new ammMod.OnlinePumpAmmSdk(getConnection({ network: body.network }));
		const swapState = await onlineAmm.swapSolanaState(amm.poolKey, userPk);
		const ixs = await offline.sellBaseInput(swapState, tokens, slippage);
		const tx_base64 = await buildUnsignedTxBase64({
			network: body.network,
			payer: userPk,
			instructions: ixs,
		});
		return json(res, 201, {
			route: 'amm',
			pool: amm.poolKey.toString(),
			mint: body.mint,
			network: body.network,
			quote_mint: quoteMintPk.toString(),
			tokens_in: body.tokens,
			slippage_bps: body.slippage_bps,
			tx_base64,
		});
	} catch (e) {
		return error(
			res,
			e.status || 502,
			e.code || 'pump_sdk_error',
			e.message || 'failed to build sell tx',
		);
	}
}

// ── sell-confirm ───────────────────────────────────────────────────────────

const sellConfirmSchema = z.object({
	mint: z.string().min(32).max(44),
	network: z.enum(['mainnet', 'devnet']).default('mainnet'),
	tx_signature: z.string().min(80).max(100),
	wallet_address: z.string().min(32).max(44),
	tokens: z.string().regex(/^\d+$/),
	route: z.enum(['bonding_curve', 'amm']),
	slippage_bps: z.number().int().min(0).max(5000).optional(),
});

async function handleSellConfirm(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = parse(sellConfirmSchema, await readJson(req));

	const [mintRow] = await sql`
		select id from pump_agent_mints where mint=${body.mint} and network=${body.network} limit 1
	`;
	const mintId = mintRow?.id ?? null;

	let tx;
	try {
		tx = await verifySignature({ network: body.network, signature: body.tx_signature });
	} catch (e) {
		return error(res, e.status || 422, e.code || 'tx_failed', e.message);
	}
	const accountKeys = tx.transaction.message.accountKeys.map((k) => (k.pubkey || k).toString());
	if (!accountKeys.includes(body.mint))
		return error(res, 422, 'mint_not_in_tx', 'mint not in tx');
	if (!accountKeys.includes(body.wallet_address))
		return error(res, 422, 'wallet_not_in_tx', 'wallet not in tx');

	if (mintId) {
		await sql`
			insert into pump_agent_trades
				(mint_id, user_id, wallet, direction, route, token_amount, slippage_bps, tx_signature, network)
			values
				(${mintId}, ${user.id}, ${body.wallet_address}, 'sell', ${body.route},
				 ${body.tokens}, ${body.slippage_bps ?? null}, ${body.tx_signature}, ${body.network})
			on conflict (tx_signature, network) do nothing
		`;
	}

	return json(res, 200, {
		ok: true,
		tracked: !!mintId,
		mint: body.mint,
		network: body.network,
		tx_signature: body.tx_signature,
	});
}

// ── build-metadata ─────────────────────────────────────────────────────────
// Builds a pump.fun-compatible metadata JSON and uploads it (+ optional token
// image) to R2. Returns a stable public URL the wizard can use as the URI.

const buildMetadataSchema = z.object({
	name: z.string().trim().min(1).max(32),
	symbol: z.string().trim().min(1).max(10),
	description: z.string().trim().max(500).default(''),
	avatar_id: z.string().uuid().optional(),
	agent_id: z.string().uuid().optional(),
	// Base64 data URL: "data:image/png;base64,..." — max 4 MB raw.
	// Cap the string at 6 MB chars to safely cover 4 MB raw (base64 inflates ~4/3 → ~5.59 M)
	// plus the data URL header. Raw-byte ceiling is re-checked after decode.
	image_data_url: z.string().max(6_000_000).optional(),
});

async function handleBuildMetadata(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	let body;
	try {
		body = parse(buildMetadataSchema, await readJson(req));
	} catch (err) {
		if (err.code === 'validation_error') {
			console.warn('[pump/build-metadata] validation_error', {
				userId: user.id,
				issues: err.issues,
			});
		}
		throw err;
	}
	const uid = user.id;
	const ts = Date.now().toString(36);
	const prefix = `pump/meta/${uid}/${ts}`;

	// ── Resolve image URL ───────────────────────────────────────────────────
	let imageUrl = null;

	if (body.image_data_url) {
		const commaIdx = body.image_data_url.indexOf(',');
		if (commaIdx === -1) return error(res, 400, 'validation_error', 'invalid image_data_url');
		const meta = body.image_data_url.slice(0, commaIdx);
		const payload = body.image_data_url.slice(commaIdx + 1);
		const buf = meta.includes('base64')
			? Buffer.from(payload, 'base64')
			: Buffer.from(decodeURIComponent(payload));
		if (buf.byteLength > 4 * 1024 * 1024) {
			return error(res, 413, 'payload_too_large', 'image must be under 4 MB');
		}
		const contentType = meta.match(/data:([^;,]+)/)?.[1] || 'image/png';
		const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' : 'png';
		const imgKey = `${prefix}/image.${ext}`;
		await putObject({ key: imgKey, body: buf, contentType });
		imageUrl = r2PublicUrl(imgKey);
	} else if (body.avatar_id) {
		const [av] = await sql`
			select thumbnail_key from avatars
			where id=${body.avatar_id} and owner_id=${uid} and deleted_at is null limit 1
		`;
		if (av?.thumbnail_key) imageUrl = r2PublicUrl(av.thumbnail_key);
	}

	// ── Build metadata JSON ─────────────────────────────────────────────────
	const agentHomeUrl = body.agent_id
		? `${env.APP_ORIGIN}/agent/${body.agent_id}`
		: env.APP_ORIGIN;

	const metadata = {
		name: body.name,
		symbol: body.symbol,
		description: body.description,
		...(imageUrl ? { image: imageUrl } : {}),
		showName: true,
		createdOn: 'https://pump.fun',
		website: agentHomeUrl,
	};

	const jsonBuf = Buffer.from(JSON.stringify(metadata, null, 2));
	const jsonKey = `${prefix}/metadata.json`;
	await putObject({ key: jsonKey, body: jsonBuf, contentType: 'application/json' });

	return json(res, 200, { metadata_url: r2PublicUrl(jsonKey), image_url: imageUrl });
}

// ── shared launch helpers ──────────────────────────────────────────────────

// Build the pump.fun launch instructions for the requested coin variant.
// All variants now go through createV2* (token-2022). Pump.fun no longer
// accepts V1 (SPL Token) launches — calling the deprecated createInstruction /
// createAndBuyInstructions paths returned tokens the pump.fun program rejected.
// mayhemMode toggles the high-volatility curve; agent binding is appended by
// the caller when applicable.
//
// creator is the on-chain "creator" (recipient of creator rewards / royalties).
// signer is the wallet that signs the tx, pays fees, and (if solBuyIn>0) funds
// the initial buy. When the caller omits signer it defaults to creator —
// preserving the legacy single-wallet semantics — but split mode is supported
// so a treasury / DAO wallet can be the creator while a contributor wallet
// signs and pays.
async function buildLaunchInstructions({
	sdk, BN, mint, creator, signer, name, symbol, uri, solBuyIn, usdcBuyIn, quoteMint, isMayhem,
}) {
	const LAMPORTS = 1_000_000_000;
	const user     = signer || creator;
	const { isLegacyQuoteMint } = await import('@pump-fun/pump-sdk');
	const isUsdcQuote = quoteMint && !isLegacyQuoteMint(quoteMint);

	if (isUsdcQuote) {
		// USDC-paired: use V2 buy path regardless of whether there's an initial buy.
		const hasBuy   = usdcBuyIn > 0;
		const global   = await sdk.fetchGlobal();
		const pumpSdk  = await import('@pump-fun/pump-sdk');
		if (hasBuy) {
			const quoteAmount   = new BN(Math.round(usdcBuyIn * 1_000_000));
			const tokenAmount   = pumpSdk.getBuyTokenAmountFromSolAmount({
				global, feeConfig: null, mintSupply: null, bondingCurve: null, amount: quoteAmount,
			});
			const ixs = await sdk.createV2AndBuyV2Instructions({
				global, mint, name, symbol, uri,
				creator, user,
				quoteAmount, amount: tokenAmount,
				mayhemMode: !!isMayhem,
				quoteMint,
			});
			return Array.isArray(ixs) ? [...ixs] : [ixs];
		}
		const ix = await sdk.createV2Instruction({
			mint, name, symbol, uri, creator, user, mayhemMode: !!isMayhem, quoteMint,
		});
		return [ix];
	}

	// SOL-paired (original behaviour)
	const hasBuy = solBuyIn > 0;
	if (hasBuy) {
		const global    = await sdk.fetchGlobal();
		const solAmount = new BN(Math.floor(solBuyIn * LAMPORTS));
		const pumpSdk   = await import('@pump-fun/pump-sdk');
		const tokenAmount = pumpSdk.getBuyTokenAmountFromSolAmount({
			global,
			feeConfig: null,
			mintSupply: null,
			bondingCurve: null,
			amount: solAmount,
		});
		const ixs = await sdk.createV2AndBuyInstructions({
			global, mint, name, symbol, uri,
			creator, user,
			solAmount, amount: tokenAmount,
			mayhemMode: !!isMayhem,
		});
		return Array.isArray(ixs) ? [...ixs] : [ixs];
	}

	const ix = await sdk.createV2Instruction({
		mint, name, symbol, uri, creator, user, mayhemMode: !!isMayhem,
	});
	return [ix];
}

// ── launch-prep ────────────────────────────────────────────────────────────

const launchPrepSchema = z
	.object({
		agent_id: z.string().uuid().optional(),
		avatar_id: z.string().uuid().optional(),
		wallet_address: z.string().min(32).max(44), // the SIGNER — signs the tx, pays fees, funds initial buy
		// Optional on-chain creator address (the recipient of pump.fun creator
		// rewards / royalties). When omitted, defaults to wallet_address —
		// preserving the legacy single-wallet flow. When provided and different,
		// it must be another Solana wallet linked to the same user account
		// (validated at /api/pump/launch-prep). Enables team/DAO launches where
		// a treasury wallet is the creator and a contributor wallet pays gas.
		creator_address: z.string().min(32).max(44).optional(),
		name: z.string().trim().min(1).max(32),
		symbol: z.string().trim().min(1).max(10),
		uri: z.string().url(),
		network: z.enum(['mainnet', 'devnet']).default('mainnet'),
		buyback_bps: z.number().int().min(0).max(10_000).default(0),
		sol_buy_in: z.number().nonnegative().max(50).default(0), // SOL-paired initial buy, capped 50 SOL
		usdc_buy_in: z.number().nonnegative().max(1_000_000).default(0), // USDC-paired initial buy
		// Optional quote mint — when provided and non-WSOL (e.g. USDC), the coin
		// is created as a USDC-paired V2 coin using createV2AndBuyV2Instructions.
		// When omitted, the coin is SOL-paired (existing behaviour).
		quote_mint: z.string().min(32).max(44).optional(),
		// Optional client-ground vanity mint address. When provided, the client
		// already holds the secret key locally and will co-sign in the wallet —
		// the server never sees the secret. When omitted, the server falls back
		// to a fresh Keypair.generate() and returns the secret key for co-sign.
		mint_address: z.string().min(32).max(44).optional(),
		// Coin variant:
		//   'agent'   — pump.fun coin + on-chain agent (buyback-bound)
		//   'regular' — plain pump.fun coin, no agent binding
		//   'mayhem'  — pump.fun mayhem-mode coin (V2 instruction set, token-2022)
		coin_type: z.enum(['regular', 'mayhem', 'agent']).default('agent'),
	})
	.refine((v) => v.agent_id || v.avatar_id, {
		message: 'agent_id or avatar_id required',
		path: ['agent_id'],
	});

// Resolve a usable agent_identities.id for the launch. If the caller passed
// avatar_id (e.g. from /studio, where users pick an avatar and not a separate
// agent), find the agent_identity already linked to that avatar — or create
// one inline so the launch can proceed without a detour through the agent
// registration wizard.
async function resolveLaunchAgentId({ userId, agentId, avatarId }) {
	if (agentId) {
		const [row] = await sql`
			select id, name from agent_identities
			where id=${agentId} and user_id=${userId} and deleted_at is null
			limit 1
		`;
		return row || null;
	}
	const [linked] = await sql`
		select id, name from agent_identities
		where user_id=${userId} and avatar_id=${avatarId} and deleted_at is null
		order by created_at asc limit 1
	`;
	if (linked) return linked;

	const [avatar] = await sql`
		select id, name, description from avatars
		where id=${avatarId} and owner_id=${userId} and deleted_at is null
		limit 1
	`;
	if (!avatar) return null;

	const agentName = (avatar.name || 'Agent').slice(0, 100);
	const agentDesc = avatar.description ? String(avatar.description).slice(0, 1000) : null;
	try {
		const [created] = await sql`
			insert into agent_identities (user_id, name, description, avatar_id)
			values (${userId}, ${agentName}, ${agentDesc}, ${avatar.id})
			returning id, name
		`;
		return created;
	} catch (err) {
		if (err?.code !== '23505') throw err;
		// Unique-per-user constraint: reuse the user's existing identity and
		// link it to this avatar if it has none yet.
		const [unlinked] = await sql`
			select id, name from agent_identities
			where user_id=${userId} and avatar_id is null and deleted_at is null
			order by created_at asc limit 1
		`;
		if (unlinked) {
			await sql`
				update agent_identities set avatar_id=${avatar.id}, updated_at=now()
				where id=${unlinked.id}
			`;
			return unlinked;
		}
		const [any] = await sql`
			select id, name from agent_identities
			where user_id=${userId} and deleted_at is null
			order by created_at asc limit 1
		`;
		return any || null;
	}
}

async function handleLaunchPrep(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = parse(launchPrepSchema, await readJson(req));
	const signer = solanaPubkey(body.wallet_address);
	if (!signer) return error(res, 400, 'validation_error', 'invalid wallet_address');

	// Verify signer wallet linked to user.
	const [walletRow] = await sql`
		select id from user_wallets
		where user_id=${user.id} and address=${body.wallet_address} and chain_type='solana'
		limit 1
	`;
	if (!walletRow) return error(res, 403, 'forbidden', 'wallet not linked to your account');

	// Resolve the on-chain creator (creator-reward recipient). When omitted,
	// the signer IS the creator (legacy single-wallet flow). When provided,
	// validate it's a valid Solana pubkey AND linked to the same user
	// account so callers can't launch tokens "as" arbitrary wallets.
	let creator = signer;
	if (body.creator_address && body.creator_address !== body.wallet_address) {
		const creatorPk = solanaPubkey(body.creator_address);
		if (!creatorPk) return error(res, 400, 'validation_error', 'invalid creator_address');
		const [creatorWallet] = await sql`
			select id from user_wallets
			where user_id=${user.id} and address=${body.creator_address} and chain_type='solana'
			limit 1
		`;
		if (!creatorWallet) {
			return error(res, 403, 'forbidden', 'creator_address must be a solana wallet linked to your account');
		}
		creator = creatorPk;
	}

	// Resolve agent_identities.id from either agent_id or avatar_id.
	// /studio sends avatar_id; the dashboard/vanity flows send agent_id.
	const agent = await resolveLaunchAgentId({
		userId: user.id,
		agentId: body.agent_id,
		avatarId: body.avatar_id,
	});
	if (!agent) return error(res, 404, 'not_found', 'agent not found');
	const resolvedAgentId = agent.id;

	// Mint pubkey: client-supplied (vanity-ground) or freshly generated.
	let mintKeypair = null;
	let mint;
	if (body.mint_address) {
		const supplied = solanaPubkey(body.mint_address);
		if (!supplied) return error(res, 400, 'validation_error', 'invalid mint_address');
		mint = supplied;
	} else {
		mintKeypair = Keypair.generate();
		mint = mintKeypair.publicKey;
	}

	const { sdk, BN } = await getPumpSdk({ network: body.network });
	const LAMPORTS_PER_SOL_LAUNCH = 1_000_000_000;

	// Coin-variant flags:
	//   mayhem → use createV2* (token-2022, mayhemMode=true), drop buyback binding
	//   agent  → V1 path + on-chain agent (PumpAgent.create with buyback_bps)
	//   regular→ V1 path, no agent binding
	const isMayhem = body.coin_type === 'mayhem';
	const isAgent  = body.coin_type === 'agent';
	const effBuyback = isAgent ? body.buyback_bps : 0;

	const launchQuoteMint = body.quote_mint ? solanaPubkey(body.quote_mint) : null;
	const instructions = await buildLaunchInstructions({
		sdk, BN, mint, creator, signer,
		name: body.name, symbol: body.symbol, uri: body.uri,
		solBuyIn: body.sol_buy_in,
		usdcBuyIn: body.usdc_buy_in,
		quoteMint: launchQuoteMint,
		isMayhem,
	});

	if (isAgent && effBuyback > 0) {
		const { offline } = await getPumpAgentOffline({ network: body.network, mint });
		const createIx = await offline.create({
			authority: creator,
			mint,
			agentAuthority: creator,
			buybackBps: effBuyback,
		});
		instructions.push(createIx);
	}

	// Signer pays gas + funds the initial buy. Creator stays on-chain as the
	// reward recipient regardless of who paid.
	const txBase64 = await buildUnsignedTxBase64({
		network: body.network,
		payer: signer,
		instructions,
	});

	const prepId = await randomToken(24);
	const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

	await sql`
		insert into agent_registrations_pending (user_id, cid, metadata_uri, payload, expires_at)
		values (
			${user.id},
			${mint.toBase58()},
			${body.uri},
			${JSON.stringify({
				kind: 'pump_launch',
				agent_id: resolvedAgentId,
				wallet_address: body.wallet_address,    // signer (pays gas, funds initial buy)
				creator_address: creator.toBase58(),    // on-chain creator (royalty recipient)
				mint: mint.toBase58(),
				name: body.name,
				symbol: body.symbol,
				network: body.network,
				buyback_bps: effBuyback,
				coin_type: body.coin_type,
				prep_id: prepId,
			})}::jsonb,
			${expiresAt}
		)
	`;

	return json(res, 201, {
		prep_id: prepId,
		agent_id: resolvedAgentId,
		mint: mint.toBase58(),
		// Mint keypair must co-sign the tx. When server-generated, we hand
		// the secret to the frontend; when client-supplied (vanity), the
		// client already holds it and the server never sees it.
		mint_secret_key_b64: mintKeypair ? Buffer.from(mintKeypair.secretKey).toString('base64') : null,
		client_supplied_mint: !mintKeypair,
		tx_base64: txBase64,
		network: body.network,
		buyback_bps: effBuyback,
		coin_type: body.coin_type,
		expires_at: expiresAt.toISOString(),
		instructions: mintKeypair
			? 'Decode tx_base64 as VersionedTransaction. Sign with the mint keypair (mint_secret_key_b64) AND the user wallet, submit, then POST /api/pump/launch-confirm with the tx_signature.'
			: 'Decode tx_base64 as VersionedTransaction. Sign with your locally-held vanity mint keypair AND the user wallet, submit, then POST /api/pump/launch-confirm with the tx_signature.',
	});
}

// ── launch-confirm ─────────────────────────────────────────────────────────

const launchConfirmSchema = z.object({
	prep_id: z.string().min(8),
	tx_signature: z.string().min(80).max(100),
});

async function handleLaunchConfirm(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = parse(launchConfirmSchema, await readJson(req));

	const [pending] = await sql`
		select id, payload from agent_registrations_pending
		where user_id=${user.id} and payload->>'prep_id'=${body.prep_id}
		  and expires_at > now()
		order by created_at desc limit 1
	`;
	if (!pending) return error(res, 404, 'not_found', 'prep not found or expired');
	const p = pending.payload;
	if (p.kind !== 'pump_launch') return error(res, 400, 'wrong_kind', 'prep is not a pump launch');

	let tx;
	try {
		tx = await verifySignature({ network: p.network, signature: body.tx_signature });
	} catch (e) {
		return error(res, e.status || 422, e.code || 'tx_failed', e.message);
	}
	const accountKeys = tx.transaction.message.accountKeys.map((k) =>
		(k.pubkey || k).toString(),
	);
	if (!accountKeys.includes(p.mint)) {
		return error(res, 422, 'mint_not_in_tx', 'mint pubkey not present in tx');
	}

	const [existing] = await sql`
		select id from pump_agent_mints where mint=${p.mint} and network=${p.network} limit 1
	`;
	if (existing) return error(res, 409, 'conflict', 'mint already registered');

	// agent_authority is the on-chain creator (royalty recipient + governance
	// authority), not the signer. p.creator_address is set by launch-prep;
	// fall back to wallet_address for prep rows written before the split landed.
	const agentAuthority = p.creator_address || p.wallet_address;
	const [row] = await sql`
		insert into pump_agent_mints
			(agent_id, user_id, network, mint, name, symbol, agent_authority, buyback_bps)
		values
			(${p.agent_id}, ${user.id}, ${p.network}, ${p.mint},
			 ${p.name}, ${p.symbol}, ${agentAuthority}, ${p.buyback_bps})
		returning id, mint, network, buyback_bps, created_at
	`;

	await sql`delete from agent_registrations_pending where id=${pending.id}`;

	return json(res, 201, {
		ok: true,
		pump_agent_mint: row,
		tx_signature: body.tx_signature,
	});
}

// ── agent-wallet ───────────────────────────────────────────────────────────
//
// Resolves the agent_identity backing the avatar (creating it if needed) and
// the agent's custodial Solana wallet (provisioning if needed). Returns the
// wallet's address and live SOL balance so the /studio UI can display it,
// fund it, and check whether it can cover a launch.

const agentWalletSchema = z
	.object({
		agent_id: z.string().uuid().optional(),
		avatar_id: z.string().uuid().optional(),
		network: z.enum(['mainnet', 'devnet']).default('mainnet'),
	})
	.refine((v) => v.agent_id || v.avatar_id, {
		message: 'agent_id or avatar_id required',
		path: ['agent_id'],
	});

async function handleAgentWallet(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = parse(agentWalletSchema, await readJson(req));

	const agent = await resolveLaunchAgentId({
		userId: user.id,
		agentId: body.agent_id,
		avatarId: body.avatar_id,
	});
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	const loaded = await loadAgentForSigning(agent.id, user.id, { reason: 'studio_launch_prepare' });
	if (loaded.error) return error(res, loaded.error.status, loaded.error.code, loaded.error.msg);

	const address = loaded.keypair.publicKey.toBase58();
	let lamports = null;
	try {
		const conn = solanaConnection(body.network);
		lamports = await conn.getBalance(loaded.keypair.publicKey);
	} catch (err) {
		console.error('[pump/agent-wallet] balance fetch failed', err?.message);
	}

	return json(res, 200, {
		agent_id: agent.id,
		address,
		network: body.network,
		lamports,
		sol: lamports == null ? null : lamports / 1e9,
	});
}

// ── launch-agent ───────────────────────────────────────────────────────────
//
// Server-side mirror of launch-prep + launch-confirm: builds, signs, and
// submits a pump.fun launch transaction using the agent's custodial Solana
// keypair. The user's connected wallet is not involved — the agent wallet
// pays for rent, fees, and any initial buy. PumpAgent.create is bound when
// buyback_bps > 0.

const launchAgentSchema = z
	.object({
		agent_id: z.string().uuid().optional(),
		avatar_id: z.string().uuid().optional(),
		name: z.string().trim().min(1).max(32),
		symbol: z.string().trim().min(1).max(10),
		uri: z.string().url(),
		network: z.enum(['mainnet', 'devnet']).default('mainnet'),
		buyback_bps: z.number().int().min(0).max(10_000).default(0),
		sol_buy_in: z.number().nonnegative().max(50).default(0),
		mint_address: z.string().min(32).max(44).optional(),
		mint_secret_key_b64: z.string().min(20).optional(),
		coin_type: z.enum(['regular', 'mayhem', 'agent']).default('agent'),
	})
	.refine((v) => v.agent_id || v.avatar_id, {
		message: 'agent_id or avatar_id required',
		path: ['agent_id'],
	})
	.refine((v) => !v.mint_address || v.mint_secret_key_b64, {
		message: 'mint_secret_key_b64 required when mint_address is supplied',
		path: ['mint_secret_key_b64'],
	});

async function handleLaunchAgent(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = parse(launchAgentSchema, await readJson(req));

	const agent = await resolveLaunchAgentId({
		userId: user.id,
		agentId: body.agent_id,
		avatarId: body.avatar_id,
	});
	if (!agent) return error(res, 404, 'not_found', 'agent not found');
	const resolvedAgentId = agent.id;

	const loaded = await loadAgentForSigning(resolvedAgentId, user.id, {
		reason: 'studio_pump_launch',
		meta: { network: body.network, buyback_bps: body.buyback_bps, coin_type: body.coin_type },
	});
	if (loaded.error) return error(res, loaded.error.status, loaded.error.code, loaded.error.msg);
	const agentKeypair = loaded.keypair;
	const creator = agentKeypair.publicKey;

	// Mint keypair: client-supplied (vanity) or server-generated.
	let mintKeypair;
	if (body.mint_address && body.mint_secret_key_b64) {
		try {
			mintKeypair = Keypair.fromSecretKey(
				Uint8Array.from(Buffer.from(body.mint_secret_key_b64, 'base64')),
			);
		} catch {
			return error(res, 400, 'validation_error', 'mint_secret_key_b64 did not parse');
		}
		if (mintKeypair.publicKey.toBase58() !== body.mint_address) {
			return error(res, 400, 'validation_error', 'mint_address does not match secret key');
		}
	} else {
		mintKeypair = Keypair.generate();
	}
	const mint = mintKeypair.publicKey;

	// Conflict check before doing on-chain work.
	const [existing] = await sql`
		select id from pump_agent_mints where mint=${mint.toBase58()} and network=${body.network} limit 1
	`;
	if (existing) return error(res, 409, 'conflict', 'mint already registered');

	// Pre-flight: make sure the agent wallet can afford the launch.
	const conn = solanaConnection(body.network);
	const PUMP_BASE_LAMPORTS = Math.floor(0.022 * LAMPORTS_PER_SOL);
	const initialBuyLamports = Math.floor((body.sol_buy_in || 0) * LAMPORTS_PER_SOL);
	const requiredLamports = PUMP_BASE_LAMPORTS + initialBuyLamports;
	let balanceLamports = 0;
	try {
		balanceLamports = await conn.getBalance(creator);
	} catch (err) {
		console.error('[pump/launch-agent] balance check failed', err?.message);
	}
	if (balanceLamports < requiredLamports) {
		return error(
			res,
			402,
			'insufficient_funds',
			`agent wallet has ${(balanceLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL, needs ~${(requiredLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL — deposit to ${creator.toBase58()}`,
		);
	}

	const { sdk, BN } = await getPumpSdk({ network: body.network });

	const isMayhem = body.coin_type === 'mayhem';
	const isAgent  = body.coin_type === 'agent';
	const effBuyback = isAgent ? body.buyback_bps : 0;

	const instructions = await buildLaunchInstructions({
		sdk, BN, mint, creator,
		name: body.name, symbol: body.symbol, uri: body.uri,
		solBuyIn: body.sol_buy_in,
		isMayhem,
	});

	if (isAgent && effBuyback > 0) {
		const { offline } = await getPumpAgentOffline({ network: body.network, mint });
		const createIx = await offline.create({
			authority: creator,
			mint,
			agentAuthority: creator,
			buybackBps: effBuyback,
		});
		instructions.push(createIx);
	}

	// Build a v0 transaction so we use the same SDK call path as launch-prep.
	const { TransactionMessage, VersionedTransaction } = await import('@solana/web3.js');
	const { blockhash } = await conn.getLatestBlockhash('confirmed');
	const msg = new TransactionMessage({
		payerKey: creator,
		recentBlockhash: blockhash,
		instructions,
	}).compileToV0Message();
	const vtx = new VersionedTransaction(msg);
	vtx.sign([agentKeypair, mintKeypair]);

	let signature;
	try {
		signature = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false });
		await conn.confirmTransaction(signature, 'confirmed');
	} catch (err) {
		console.error('[pump/launch-agent] send failed', err);
		return error(res, 502, 'rpc_error', err?.message || 'transaction failed');
	}

	const mintAddr = mint.toBase58();
	const [row] = await sql`
		insert into pump_agent_mints
			(agent_id, user_id, network, mint, name, symbol, metadata_uri, agent_authority, buyback_bps)
		values
			(${resolvedAgentId}, ${user.id}, ${body.network}, ${mintAddr},
			 ${body.name}, ${body.symbol}, ${body.uri}, ${creator.toBase58()}, ${effBuyback})
		on conflict (mint, network) do nothing
		returning id, mint, network, buyback_bps, created_at
	`;

	await sql`
		insert into agent_actions (agent_id, type, payload, source_skill)
		values (
			${resolvedAgentId},
			${'pumpfun.launch'},
			${JSON.stringify({
				mint: mintAddr,
				name: body.name,
				symbol: body.symbol,
				uri: body.uri,
				signature,
				network: body.network,
				sol_buy_in: body.sol_buy_in || 0,
				buyback_bps: effBuyback,
				coin_type: body.coin_type,
				source: 'studio_agent_wallet',
			})}::jsonb,
			${'pumpfun'}
		)
	`.catch((e) => console.error('[pump/launch-agent] log failed', e?.message));

	return json(res, 201, {
		ok: true,
		agent_id: resolvedAgentId,
		mint: mintAddr,
		signature,
		network: body.network,
		buyback_bps: effBuyback,
		coin_type: body.coin_type,
		pump_agent_mint: row || null,
		explorer: `https://solscan.io/tx/${signature}${body.network === 'devnet' ? '?cluster=devnet' : ''}`,
		pumpfun_url: `https://pump.fun/coin/${mintAddr}`,
	});
}

// ── accept-payment-prep ────────────────────────────────────────────────────

const acceptPaymentPrepSchema = z.object({
	mint: z.string().min(32).max(44), // pump.fun token mint = agent token
	payer_wallet: z.string().min(32).max(44),
	amount_usdc: z.number().positive().max(100_000),
	currency_mint: z.string().min(32).max(44).optional(), // defaults to USDC
	currency_token_program: z.string().min(32).max(44).optional(),
	user_token_account: z.string().min(32).max(44),         // payer ATA
	skill_id: z.string().max(100).optional(),
	tool_name: z.string().max(100).optional(),
	duration_seconds: z.number().int().positive().max(60 * 60 * 24 * 365).default(60),
	network: z.enum(['mainnet', 'devnet']).default('mainnet'),
});

function bnFromBigint(BN, v) {
	return new BN(v.toString());
}

async function handleAcceptPaymentPrep(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	// Allow both session users (browser) and bearer (MCP / agent) callers.
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer)
		return error(res, 401, 'unauthorized', 'sign in or supply a bearer token');
	const userId = session?.id ?? bearer?.userId ?? null;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = parse(acceptPaymentPrepSchema, await readJson(req));
	const payer = solanaPubkey(body.payer_wallet);
	const userAta = solanaPubkey(body.user_token_account);
	if (!payer) return error(res, 400, 'validation_error', 'invalid payer_wallet');
	if (!userAta) return error(res, 400, 'validation_error', 'invalid user_token_account');

	const [agent] = await sql`
		select id, mint, network, buyback_bps from pump_agent_mints
		where mint=${body.mint} and network=${body.network} limit 1
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent mint not registered');

	const currencyStr =
		body.currency_mint ||
		(body.network === 'devnet' ? SOLANA_USDC_MINT_DEVNET : SOLANA_USDC_MINT);
	const currency = solanaPubkey(currencyStr);
	if (!currency) return error(res, 400, 'validation_error', 'invalid currency_mint');

	const { offline, BN } = await getPumpAgentOffline({
		network: body.network,
		mint: body.mint,
	});

	// Invoice ID = random 64-bit unsigned (memo BN). Used as the PDA seed and
	// as the X402 receipt identifier downstream.
	const invoiceIdHex = (await randomToken(8)).slice(0, 16);
	const invoiceId = new BN(invoiceIdHex, 16);

	const startTime = Math.floor(Date.now() / 1000);
	const endTime = startTime + body.duration_seconds;

	const amountAtomics = toUsdcAtomics(body.amount_usdc); // bigint, USDC = 6 dp

	const tokenProgram = body.currency_token_program
		? solanaPubkey(body.currency_token_program)
		: undefined;

	const ix = await offline.acceptPayment({
		user: payer,
		userTokenAccount: userAta,
		currencyMint: currency,
		amount: bnFromBigint(BN, amountAtomics),
		memo: invoiceId,
		startTime: new BN(startTime),
		endTime: new BN(endTime),
		...(tokenProgram ? { tokenProgram } : {}),
	});

	const txBase64 = await buildUnsignedTxBase64({
		network: body.network,
		payer,
		instructions: [ix],
	});

	const [row] = await sql`
		insert into pump_agent_payments
			(mint_id, user_id, payer_wallet, currency_mint, amount_atomics,
			 invoice_id, start_time, end_time, status, skill_id, tool_name)
		values
			(${agent.id}, ${userId}, ${body.payer_wallet}, ${currencyStr},
			 ${amountAtomics.toString()}, ${invoiceId.toString()},
			 to_timestamp(${startTime}), to_timestamp(${endTime}),
			 'pending', ${body.skill_id || null}, ${body.tool_name || null})
		returning id, invoice_id, start_time, end_time, status
	`;

	return json(res, 201, {
		payment_id: row.id,
		mint: body.mint,
		invoice_id: invoiceId.toString(),
		amount_usdc: body.amount_usdc,
		amount_atomics: amountAtomics.toString(),
		currency_mint: currencyStr,
		start_time: row.start_time,
		end_time: row.end_time,
		network: body.network,
		tx_base64: txBase64,
		instructions:
			'Decode tx_base64, sign with payer wallet, submit, then call /api/pump/accept-payment-confirm with the tx_signature and payment_id.',
	});
}

// ── accept-payment-confirm ─────────────────────────────────────────────────

const acceptPaymentConfirmSchema = z.object({
	payment_id: z.string().uuid(),
	tx_signature: z.string().min(80).max(100),
});

async function handleAcceptPaymentConfirm(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'auth required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = parse(acceptPaymentConfirmSchema, await readJson(req));
	const [payment] = await sql`
		select p.*, m.mint, m.network from pump_agent_payments p
		join pump_agent_mints m on m.id = p.mint_id
		where p.id=${body.payment_id} limit 1
	`;
	if (!payment) return error(res, 404, 'not_found', 'payment not found');
	if (payment.status === 'confirmed')
		return error(res, 409, 'already_confirmed', 'payment already confirmed');

	let tx;
	try {
		tx = await verifySignature({ network: payment.network, signature: body.tx_signature });
	} catch (e) {
		await sql`update pump_agent_payments set status='failed' where id=${payment.id}`;
		return error(res, e.status || 422, e.code || 'tx_failed', e.message);
	}

	const accountKeys = tx.transaction.message.accountKeys.map((k) =>
		(k.pubkey || k).toString(),
	);
	if (!accountKeys.includes(payment.mint)) {
		return error(res, 422, 'mint_not_in_tx', 'agent mint not in tx accounts');
	}

	await sql`
		update pump_agent_payments
		set status='confirmed', tx_signature=${body.tx_signature}, confirmed_at=now()
		where id=${payment.id}
	`;

	return json(res, 200, {
		ok: true,
		payment_id: payment.id,
		invoice_id: payment.invoice_id,
		tx_signature: body.tx_signature,
	});
}

// ── payments-list ──────────────────────────────────────────────────────────

async function handlePaymentsList(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const url = new URL(req.url, `http://${req.headers.host}`);
	const mint = url.searchParams.get('mint');
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	const limit = Math.min(Number(url.searchParams.get('limit') || 50), 500);
	const includePending = url.searchParams.get('include_pending') === '1';

	if (!mint) return error(res, 400, 'validation_error', 'mint required');

	const [agent] = await sql`
		select id, mint, network, buyback_bps from pump_agent_mints
		where mint=${mint} and network=${network} limit 1
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent mint not registered');

	const rows = includePending
		? await sql`
			select id, payer_wallet, currency_mint, amount_atomics, invoice_id,
			       start_time, end_time, status, skill_id, tool_name,
			       invoice_pda, tx_signature, created_at, confirmed_at
			from pump_agent_payments
			where mint_id=${agent.id}
			order by created_at desc limit ${limit}
		`
		: await sql`
			select id, payer_wallet, currency_mint, amount_atomics, invoice_id,
			       start_time, end_time, status, skill_id, tool_name,
			       invoice_pda, tx_signature, created_at, confirmed_at
			from pump_agent_payments
			where mint_id=${agent.id} and status='confirmed'
			order by confirmed_at desc nulls last limit ${limit}
		`;

	// Derive invoice PDAs for any rows that lack one (older rows pre-PDA backfill).
	// We do it lazily here so the widget can deep-link without a backfill cron.
	let pdaErrored = false;
	const needsPda = rows.filter((r) => !r.invoice_pda && r.invoice_id);
	if (needsPda.length > 0) {
		try {
			const [{ getInvoiceIdPDA }, { PublicKey }] = await Promise.all([
				import('@pump-fun/agent-payments-sdk'),
				import('@solana/web3.js'),
			]);
			const BN = (await import('bn.js')).default || (await import('bn.js'));
			const mintPk = new PublicKey(mint);
			for (const r of needsPda) {
				try {
					const [pda] = getInvoiceIdPDA(mintPk, new BN(r.invoice_id));
					r.invoice_pda = pda.toBase58();
				} catch {
					/* skip individual failures */
				}
			}
		} catch {
			pdaErrored = true;
		}
	}

	const [agg] = await sql`
		select
			count(*)::int                                                      as total,
			count(*) filter (where status='confirmed')::int                    as confirmed,
			count(distinct payer_wallet) filter (where status='confirmed')::int as unique_payers,
			coalesce(sum(amount_atomics) filter (where status='confirmed'), 0)::text as total_atomics
		from pump_agent_payments where mint_id=${agent.id}
	`;

	return json(res, 200, {
		mint,
		network,
		buyback_bps: agent.buyback_bps,
		summary: agg,
		data: rows,
	});
}

// ── portfolio ──────────────────────────────────────────────────────────────

async function handlePortfolio(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const url = new URL(req.url, `http://${req.headers.host}`);
	const agentId = url.searchParams.get('agentId');
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	if (!agentId) return error(res, 400, 'validation_error', 'agentId required');

	const [agent] = await sql`
		SELECT user_id, meta FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');
	if (agent.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');
	const address = agent.meta?.solana_address;
	if (!address) return error(res, 409, 'conflict', 'agent has no solana wallet');

	const conn = solanaConnection(network);
	const owner = new PublicKey(address);

	const [lamports, tokenResp, recentBuys] = await Promise.all([
		conn.getBalance(owner),
		conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
		sql`
			SELECT payload, created_at FROM agent_actions
			WHERE agent_id = ${agentId}
			  AND type IN ('pumpfun.buy', 'buy')
			ORDER BY created_at DESC
			LIMIT 500
		`.catch(() => []),
	]);

	const holdings = tokenResp.value
		.map((acc) => {
			const info = acc.account.data.parsed.info;
			return {
				mint: info.mint,
				amount: info.tokenAmount.uiAmount ?? 0,
				decimals: info.tokenAmount.decimals,
			};
		})
		.filter((h) => h.amount > 0);

	// Cost basis from recorded buys.
	const basisByMint = new Map();
	for (const row of recentBuys) {
		const p = row.payload || {};
		if (!p.mint) continue;
		const prev = basisByMint.get(p.mint) ?? { sol: 0, tokens: 0 };
		prev.sol += Number(p.amountSol) || 0;
		prev.tokens += Number(p.amountTokens) || 0;
		basisByMint.set(p.mint, prev);
	}

	// Live price per holding via the read-only pump-fun MCP (parallelized).
	const rt = makeRuntime();
	const priced = await Promise.all(holdings.map(async (h) => {
		const [curve, basis] = [
			await rt.invoke('pump-fun.getBondingCurve', { mint: h.mint }).catch(() => ({ ok: false })),
			basisByMint.get(h.mint),
		];
		const priceSol = curve?.ok ? (curve.data?.priceSol ?? curve.data?.price ?? null) : null;
		const valueSol = priceSol != null ? priceSol * h.amount : null;
		const costBasisSol = basis ? basis.sol : null;
		const unrealizedSol = valueSol != null && costBasisSol != null ? valueSol - costBasisSol : null;
		return {
			...h,
			priceSol,
			valueSol,
			costBasisSol,
			unrealizedPnlSol: unrealizedSol,
			unrealizedPnlPct: unrealizedSol != null && costBasisSol > 0 ? (unrealizedSol / costBasisSol) * 100 : null,
		};
	}));

	const totalValueSol = priced.reduce((s, p) => s + (p.valueSol ?? 0), 0);
	const totalCostBasisSol = priced.reduce((s, p) => s + (p.costBasisSol ?? 0), 0);
	const unrealizedPnlSol = totalValueSol - totalCostBasisSol;

	return json(res, 200, {
		data: {
			address,
			network,
			lamports,
			sol: lamports / LAMPORTS_PER_SOL,
			holdings: priced,
			totalValueSol,
			totalCostBasisSol,
			unrealizedPnlSol,
			unrealizedPnlPct: totalCostBasisSol > 0 ? (unrealizedPnlSol / totalCostBasisSol) * 100 : null,
		},
	});
}

// ── by-agent ───────────────────────────────────────────────────────────────

async function handleByAgent(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const url = new URL(req.url, `http://${req.headers.host}`);
	const agentId  = url.searchParams.get('agent_id');
	const avatarId = url.searchParams.get('avatar_id');
	if (!agentId && !avatarId)
		return error(res, 400, 'validation_error', 'agent_id or avatar_id required');

	let row;
	if (agentId) {
		[row] = await sql`
			select pam.id, pam.mint, pam.network, pam.name, pam.symbol,
			       pam.buyback_bps, pam.agent_authority, pam.metadata_uri,
			       pam.sharing_config, pam.created_at
			from pump_agent_mints pam
			where pam.agent_id=${agentId}
			order by pam.created_at desc limit 1
		`;
	} else {
		[row] = await sql`
			select pam.id, pam.mint, pam.network, pam.name, pam.symbol,
			       pam.buyback_bps, pam.agent_authority, pam.metadata_uri,
			       pam.sharing_config, pam.created_at
			from pump_agent_mints pam
			join agent_identities ai
			  on ai.id = pam.agent_id and ai.deleted_at is null
			where ai.avatar_id=${avatarId}
			order by pam.created_at desc limit 1
		`;
	}
	if (!row) return json(res, 200, { data: null });

	const [stats] = await sql`
		select
			count(*) filter (where status='confirmed')::int                      as confirmed_payments,
			count(distinct payer_wallet) filter (where status='confirmed')::int  as unique_payers,
			coalesce(sum(amount_atomics) filter (where status='confirmed'),0)::text as total_atomics,
			max(confirmed_at) filter (where status='confirmed')                  as last_payment_at
		from pump_agent_payments where mint_id=${row.id}
	`;

	const [burnRow] = await sql`
		select
			count(*) filter (where status='confirmed')::int                       as runs,
			coalesce(sum(burn_amount) filter (where status='confirmed'),0)::text  as total_burned,
			max(created_at)                                                       as last_burn_at
		from pump_buyback_runs where mint_id=${row.id}
	`;

	// Burns feed (separate from payments feed) — recent confirmed buyback runs
	// for the dashboard / passport "🔥 burns" stream.
	const burnsFeed = await sql`
		select id, currency_mint, tx_signature, burn_amount, created_at
		from pump_buyback_runs
		where mint_id=${row.id} and status='confirmed'
		order by created_at desc
		limit 10
	`;

	return json(res, 200, {
		data: {
			...row,
			stats: stats || { confirmed_payments: 0, unique_payers: 0, total_atomics: '0' },
			burns:  burnRow || { runs: 0, total_burned: '0' },
			burns_feed: burnsFeed,
		},
	});
}

// ── quote ──────────────────────────────────────────────────────────────────

async function handleQuote(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const url = new URL(req.url, `http://${req.headers.host}`);
	const mintStr = url.searchParams.get('mint');
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	const direction = url.searchParams.get('direction') === 'sell' ? 'sell' : 'buy';
	const solRaw = url.searchParams.get('sol');
	const usdcRaw = url.searchParams.get('usdc');
	const tokenRaw = url.searchParams.get('token');
	const quoteMintRaw = url.searchParams.get('quote_mint');
	const slippageRaw = url.searchParams.get('slippage_bps');
	const slippageBps = Number.isFinite(Number(slippageRaw))
		? Math.max(0, Math.min(5000, Number(slippageRaw)))
		: 100;
	const slippage = slippageBps / 10_000;

	const mint = solanaPubkey(mintStr);
	if (!mint) return error(res, 400, 'validation_error', 'invalid mint');

	try {
		const { sdk, BN, web3 } = await getPumpSdk({ network });
		const { isLegacyQuoteMint, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount } =
			await import('@pump-fun/pump-sdk');
		const LAMPORTS_PER_SOL_Q = web3.LAMPORTS_PER_SOL || 1_000_000_000;

		// Fetch bonding curve — exposes on-chain quote_mint for V2 coins.
		let curve = null;
		try {
			if (sdk.fetchBuyState) {
				const state = await sdk.fetchBuyState(mint, mint);
				curve = state.bondingCurve;
			} else if (sdk.fetchBondingCurve) {
				curve = await sdk.fetchBondingCurve(mint);
			}
		} catch {
			curve = null;
		}

		// Resolve quoteMint: explicit param > on-chain curve field > WSOL fallback.
		let quoteMintPk = quoteMintRaw
			? solanaPubkey(quoteMintRaw)
			: (curve?.quoteMint ?? solanaPubkey(WSOL_MINT));
		if (!quoteMintPk) quoteMintPk = solanaPubkey(WSOL_MINT);
		const isUsdcQuote = !isLegacyQuoteMint(quoteMintPk);
		const USDC_DECIMALS = 1_000_000;

		if (curve && !curve.complete) {
			const global = typeof sdk.fetchGlobal === 'function' ? await sdk.fetchGlobal() : null;
			let quote = null;

			if (direction === 'buy') {
				const quoteAmountRaw = isUsdcQuote ? usdcRaw : solRaw;
				if (quoteAmountRaw) {
					const quoteNum = Number(quoteAmountRaw);
					if (!(quoteNum > 0)) return error(res, 400, 'validation_error', `${isUsdcQuote ? 'usdc' : 'sol'} must be > 0`);
					const atomics = new BN(isUsdcQuote
						? Math.round(quoteNum * USDC_DECIMALS)
						: Math.floor(quoteNum * LAMPORTS_PER_SOL_Q));
					const tokens = getBuyTokenAmountFromSolAmount({
						global, feeConfig: null, mintSupply: null, bondingCurve: curve, amount: atomics,
					});
					quote = isUsdcQuote
						? { usdc_in: quoteNum, tokens_out: tokens.toString(), source: 'bonding_curve' }
						: { sol_in: quoteNum, tokens_out: tokens.toString(), source: 'bonding_curve' };
				}
			} else if (direction === 'sell' && tokenRaw) {
				const tokens = new BN(tokenRaw);
				const atomicsOut = getSellSolAmountFromTokenAmount({
					global, feeConfig: null, mintSupply: null, bondingCurve: curve, amount: tokens,
				});
				quote = isUsdcQuote
					? { tokens_in: tokenRaw, usdc_out: Number(atomicsOut.toString()) / USDC_DECIMALS, source: 'bonding_curve' }
					: { tokens_in: tokenRaw, sol_out: Number(atomicsOut.toString()) / LAMPORTS_PER_SOL_Q, source: 'bonding_curve' };
			}

			return json(res, 200, {
				mint: mintStr,
				network,
				graduated: false,
				quote_mint: quoteMintPk.toString(),
				bonding_curve: {
					real_quote_reserves: curve.realQuoteReserves?.toString?.() ?? curve.realSolReserves?.toString?.() ?? null,
					real_token_reserves: curve.realTokenReserves?.toString?.() ?? null,
					virtual_quote_reserves: curve.virtualQuoteReserves?.toString?.() ?? curve.virtualSolReserves?.toString?.() ?? null,
					virtual_token_reserves: curve.virtualTokenReserves?.toString?.() ?? null,
					complete: curve.complete ?? false,
				},
				quote,
			});
		}

		// Post-graduation: canonical AMM pool. For USDC pairs use the quote-keyed PDA.
		let amm;
		try {
			amm = await getAmmPoolState({ network, mint, quoteMint: isUsdcQuote ? quoteMintPk : null });
		} catch (e) {
			if (e.code === 'pool_not_found') {
				return json(res, 200, {
					mint: mintStr,
					network,
					graduated: true,
					pool: null,
					quote: null,
					note: 'No bonding curve and no canonical AMM pool — token may not be a pump.fun mint or has not graduated yet',
				});
			}
			throw e;
		}

		const { pool, poolKey, baseReserve, quoteReserve, baseMintAccount, globalConfig, feeConfig } = amm;
		const ammSdk = await import('@pump-fun/pump-swap-sdk');
		// Resolved pool quoteMint tells us the definitive quote currency.
		const resolvedQuoteMintStr = pool.quoteMint?.toString?.() ?? quoteMintPk.toString();
		const resolvedIsUsdc = resolvedQuoteMintStr !== WSOL_MINT;
		const QUOTE_UNIT = resolvedIsUsdc ? USDC_DECIMALS : 1_000_000_000;
		let quote = null;

		if (direction === 'buy') {
			const quoteRaw = resolvedIsUsdc ? usdcRaw : solRaw;
			if (quoteRaw) {
				const quoteNum = Number(quoteRaw);
				if (!(quoteNum > 0)) return error(res, 400, 'validation_error', `${resolvedIsUsdc ? 'usdc' : 'sol'} must be > 0`);
				const atomics = new BN(Math.round(quoteNum * QUOTE_UNIT));
				const r = ammSdk.buyQuoteInput({
					quote: atomics, slippage, baseReserve, quoteReserve,
					globalConfig, baseMintAccount,
					baseMint: pool.baseMint,
					coinCreator: pool.coinCreator,
					creator: pool.creator,
					feeConfig,
				});
				quote = {
					...(resolvedIsUsdc ? { usdc_in: quoteNum } : { sol_in: quoteNum }),
					tokens_out: r.base?.toString?.() ?? null,
					min_tokens_out: r.uiBase?.toString?.() ?? r.minBase?.toString?.() ?? null,
					slippage_bps: slippageBps,
					source: 'amm',
				};
			}
		} else if (direction === 'sell' && tokenRaw) {
			const tokens = new BN(tokenRaw);
			const r = ammSdk.sellBaseInput({
				base: tokens, slippage, baseReserve, quoteReserve,
				globalConfig, baseMintAccount,
				baseMint: pool.baseMint,
				coinCreator: pool.coinCreator,
				creator: pool.creator,
				feeConfig,
			});
			const atomicsOut = r.quote ?? r.uiQuote ?? r.minQuote;
			const minAtomicsOut = r.minQuote ?? r.uiQuote;
			const toUnit = (v) => v != null ? Number(v.toString()) / QUOTE_UNIT : null;
			quote = {
				tokens_in: tokenRaw,
				...(resolvedIsUsdc
					? { usdc_out: toUnit(atomicsOut), min_usdc_out: toUnit(minAtomicsOut) }
					: { sol_out: toUnit(atomicsOut), min_sol_out: toUnit(minAtomicsOut) }),
				slippage_bps: slippageBps,
				source: 'amm',
			};
		}

		return json(res, 200, {
			mint: mintStr,
			network,
			graduated: true,
			quote_mint: resolvedQuoteMintStr,
			pool: {
				address: poolKey.toString(),
				base: pool.baseMint.toString(),
				quote: resolvedQuoteMintStr,
				base_reserve: baseReserve.toString(),
				quote_reserve: quoteReserve.toString(),
				lp_supply: pool.lpSupply?.toString?.() ?? null,
			},
			quote,
		});
	} catch (err) {
		return error(
			res,
			err.status || 502,
			err.code || 'pump_sdk_error',
			err.message || 'pump.fun SDK error',
		);
	}
}

// ── governance-prep ────────────────────────────────────────────────────────

const governancePrepSchema = z.object({
	mint: z.string().min(32).max(44),
	authority_wallet: z.string().min(32).max(44),
	new_buyback_bps: z.number().int().min(0).max(10_000),
	network: z.enum(['mainnet', 'devnet']).default('mainnet'),
});

async function handleGovernancePrep(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = parse(governancePrepSchema, await readJson(req));
	const authority = solanaPubkey(body.authority_wallet);
	if (!authority) return error(res, 400, 'validation_error', 'invalid authority_wallet');

	const [row] = await sql`
		select id, user_id, agent_authority from pump_agent_mints
		where mint=${body.mint} and network=${body.network} limit 1
	`;
	if (!row) return error(res, 404, 'not_found', 'agent mint not registered');
	if (row.user_id !== user.id) return error(res, 403, 'forbidden', 'not your agent');
	if (row.agent_authority && row.agent_authority !== body.authority_wallet) {
		return error(res, 403, 'forbidden', 'authority does not match');
	}

	const { offline } = await getPumpAgentOffline({ network: body.network, mint: body.mint });
	const ix = await offline.updateBuybackBps(
		{ authority, buybackBps: body.new_buyback_bps },
		{}, // UpdateBuybackBpsOptions — empty default
	);

	const txBase64 = await buildUnsignedTxBase64({
		network: body.network,
		payer: authority,
		instructions: [ix],
	});

	return json(res, 201, {
		mint: body.mint,
		network: body.network,
		new_buyback_bps: body.new_buyback_bps,
		tx_base64: txBase64,
		instructions:
			'Sign with the agent authority wallet, submit, then optionally PATCH the local row via /api/agents/:id to refresh display.',
	});
}

// ── withdraw-prep ──────────────────────────────────────────────────────────

const withdrawPrepSchema = z.object({
	mint: z.string().min(32).max(44),
	authority_wallet: z.string().min(32).max(44),
	receiver_ata: z.string().min(32).max(44),
	currency_mint: z.string().min(32).max(44).optional(),
	currency_token_program: z.string().min(32).max(44).optional(),
	network: z.enum(['mainnet', 'devnet']).default('mainnet'),
});

async function handleWithdrawPrep(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = parse(withdrawPrepSchema, await readJson(req));
	const authority = solanaPubkey(body.authority_wallet);
	const receiverAta = solanaPubkey(body.receiver_ata);
	if (!authority || !receiverAta)
		return error(res, 400, 'validation_error', 'invalid pubkeys');

	const [row] = await sql`
		select m.id, m.mint, m.user_id, m.agent_authority, m.network from pump_agent_mints m
		where m.mint=${body.mint} and m.network=${body.network} limit 1
	`;
	if (!row) return error(res, 404, 'not_found', 'agent mint not registered');
	if (row.user_id !== user.id) return error(res, 403, 'forbidden', 'not your agent');
	if (row.agent_authority && row.agent_authority !== body.authority_wallet) {
		return error(res, 403, 'forbidden', 'authority does not match');
	}

	const currencyStr =
		body.currency_mint ||
		(body.network === 'devnet' ? SOLANA_USDC_MINT_DEVNET : SOLANA_USDC_MINT);
	const currency = solanaPubkey(currencyStr);
	if (!currency) return error(res, 400, 'validation_error', 'invalid currency_mint');

	const { offline } = await getPumpAgentOffline({
		network: body.network,
		mint: body.mint,
	});

	const tokenProgram = body.currency_token_program
		? solanaPubkey(body.currency_token_program)
		: undefined;

	const ix = await offline.withdraw({
		authority,
		currencyMint: currency,
		receiverAta,
		...(tokenProgram ? { tokenProgram } : {}),
	});

	const txBase64 = await buildUnsignedTxBase64({
		network: body.network,
		payer: authority,
		instructions: [ix],
	});

	return json(res, 201, {
		mint: body.mint,
		network: body.network,
		currency_mint: currencyStr,
		tx_base64: txBase64,
	});
}

// ── withdraw-confirm ───────────────────────────────────────────────────────

const withdrawConfirmSchema = z.object({
	mint: z.string().min(32).max(44),
	network: z.enum(['mainnet', 'devnet']).default('mainnet'),
	tx_signature: z.string().min(80).max(100),
});

async function handleWithdrawConfirm(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = parse(withdrawConfirmSchema, await readJson(req));

	const [row] = await sql`
		select id, mint, user_id, agent_authority, network from pump_agent_mints
		where mint=${body.mint} and network=${body.network} limit 1
	`;
	if (!row) return error(res, 404, 'not_found', 'agent mint not registered');
	if (row.user_id !== user.id) return error(res, 403, 'forbidden', 'not your agent');

	let tx;
	try {
		tx = await verifySignature({ network: body.network, signature: body.tx_signature });
	} catch (e) {
		return error(res, e.status || 422, e.code || 'tx_failed', e.message);
	}

	const accountKeys = tx.transaction.message.accountKeys.map((k) => (k.pubkey || k).toString());
	if (!accountKeys.includes(body.mint)) {
		return error(res, 422, 'mint_not_in_tx', 'mint not present in tx accounts');
	}
	if (row.agent_authority && !accountKeys.includes(row.agent_authority)) {
		return error(res, 422, 'authority_not_in_tx', 'agent authority not present in tx');
	}

	return json(res, 200, {
		ok: true,
		mint: body.mint,
		network: body.network,
		tx_signature: body.tx_signature,
		slot: tx.slot ?? null,
		block_time: tx.blockTime ?? null,
	});
}

// ── strategy-backtest ──────────────────────────────────────────────────────

async function resolveStrategyMints(invoke, strategy, explicit, limit) {
	if (Array.isArray(explicit) && explicit.length) return explicit;
	const scan = strategy?.scan ?? {};
	if (scan.kind === 'mintList' && Array.isArray(scan.mints)) return scan.mints;
	const tool = scan.kind === 'trending' ? 'pump-fun.getTrendingTokens' : 'pump-fun.getNewTokens';
	const r = await invoke(tool, { limit: limit ?? scan.limit ?? 20 });
	if (!r.ok) throw new Error(`scan failed: ${r.error}`);
	const items = r.data?.tokens ?? r.data ?? [];
	return items.map((t) => t.mint ?? t.address).filter(Boolean);
}

async function handleStrategyBacktest(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = await readJson(req);
	if (!body?.strategy) return error(res, 400, 'validation_error', 'strategy required');

	const rt = makeRuntime();
	let mints;
	try {
		mints = await resolveStrategyMints(rt.invoke, body.strategy, body.mints, body.limit);
	} catch (e) {
		return error(res, 502, 'upstream_error', e.message);
	}
	if (!mints.length) return error(res, 422, 'no_candidates', 'no mints to backtest');

	const { backtestStrategy } = await import('../../examples/skills/pump-fun-strategy/handlers.js');
	const result = await backtestStrategy(
		{ strategy: body.strategy, mints, sinceMs: body.sinceMs ?? 0 },
		{ skills: { invoke: rt.invoke }, memory: { note: () => {} } },
	);
	if (!result.ok) return error(res, 400, 'validation_error', result.error);
	return json(res, 200, { data: { ...result.data, mintsUsed: mints } });
}

// ── strategy-close-all ─────────────────────────────────────────────────────

async function handleStrategyCloseAll(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = await readJson(req);
	if (!body?.agentId) return error(res, 400, 'validation_error', 'agentId required');
	const network = body.network === 'devnet' ? 'devnet' : 'mainnet';

	const [row] = await sql`
		SELECT user_id, meta FROM agent_identities
		WHERE id = ${body.agentId} AND deleted_at IS NULL
	`;
	if (!row) return error(res, 404, 'not_found', 'agent not found');
	if (row.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');
	const enc = row.meta?.encrypted_solana_secret;
	if (!enc) return error(res, 409, 'conflict', 'agent has no solana wallet');

	const wallet = await loadWallet(enc);
	const rt = makeRuntime({
		wallet,
		agentId: body.agentId,
		signerAddress: wallet.publicKey.toBase58(),
		configOverrides: {
			'pump-fun-trade': { rpc: RPC[network] },
			'solana-wallet': { rpc: RPC[network] },
		},
	});

	const { closeAllPositions } = await import('../../examples/skills/pump-fun-strategy/handlers.js');
	const result = await closeAllPositions(
		{ mints: body.mints, simulate: !!body.simulate },
		{ skills: { invoke: rt.invoke }, wallet, memory: { note: () => {} } },
	);
	if (!result.ok) return error(res, 400, 'sell_failed', result.error);
	return json(res, 200, { data: result.data });
}

// ── strategy-run ───────────────────────────────────────────────────────────
// SSE — manages its own response writes; routed before wrap() above.

async function loadAgentWalletForStrategy(agentId, userId) {
	const [row] = await sql`
		SELECT user_id, meta FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!row) throw Object.assign(new Error('agent not found'), { status: 404 });
	if (row.user_id !== userId) throw Object.assign(new Error('not your agent'), { status: 403 });
	const enc = row.meta?.encrypted_solana_secret;
	if (!enc) throw Object.assign(new Error('agent has no solana wallet — provision via /api/agents/:id/solana'), { status: 409 });
	const wallet = await loadWallet(enc);
	return { wallet, address: wallet.publicKey.toBase58(), meta: row.meta };
}

async function handleStrategyRun(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	let body;
	try { body = await readJson(req); }
	catch (e) { return error(res, 400, 'validation_error', e.message); }

	if (!body?.strategy) return error(res, 400, 'validation_error', 'strategy required');
	const durationSec = Math.max(5, Math.min(600, Number(body.durationSec) || 30));
	const mode = body.mode === 'live' ? 'live' : 'simulate';
	const network = body.network === 'devnet' ? 'devnet' : 'mainnet';

	let wallet = null, walletAddress = null, agentMeta = null;
	if (mode === 'live') {
		const auth = await resolveAuth(req);
		if (!auth) return error(res, 401, 'unauthorized', 'sign in required for live mode');
		if (!body.agentId) return error(res, 400, 'validation_error', 'agentId required for live mode');
		try {
			const r = await loadAgentWalletForStrategy(body.agentId, auth.userId);
			wallet = r.wallet;
			walletAddress = r.address;
			agentMeta = r.meta;
		} catch (e) {
			return error(res, e.status ?? 500, e.status === 409 ? 'conflict' : 'unauthorized', e.message);
		}
	}

	res.statusCode = 200;
	res.setHeader('content-type', 'text/event-stream');
	res.setHeader('cache-control', 'no-cache, no-transform');
	res.setHeader('connection', 'keep-alive');
	res.setHeader('access-control-allow-origin', '*');
	const send = (event, data) => {
		res.write(`event: ${event}\n`);
		res.write(`data: ${JSON.stringify(data)}\n\n`);
	};

	let aborted = false;
	req.on('close', () => { aborted = true; });

	const rt = makeRuntime({
		wallet,
		agentId: mode === 'live' ? body.agentId : undefined,
		signerAddress: walletAddress,
		configOverrides: {
			'pump-fun-trade': { rpc: RPC[network] },
			'solana-wallet': { rpc: RPC[network] },
		},
		onEvent: (e) => send('memory', e),
	});

	send('start', { durationSec, mode, network, walletAddress });

	const { runStrategy } = await import('../../examples/skills/pump-fun-strategy/handlers.js');
	const ctx = {
		skills: { invoke: rt.invoke },
		skillConfig: { defaultPollMs: Math.max(1500, Number(body.pollMs) || 3000) },
		memory: { note: (tag, value) => send('memory', { tag, value }) },
		wallet,
	};

	const policyGuard = mode === 'live'
		? async ({ mint, amountSol }) => {
			const block = await checkBuyAllowed({ agentId: body.agentId, meta: agentMeta, mint, solAmount: amountSol });
			return block ? { code: block.code, msg: block.msg } : null;
		}
		: null;

	const abortController = new AbortController();
	req.on('close', () => abortController.abort());

	try {
		const result = await runStrategy(
			{
				strategy: body.strategy,
				durationSec,
				simulate: mode === 'simulate',
				onLog: (entry) => { if (!aborted) send('log', entry); },
				policyGuard,
				abortSignal: abortController.signal,
			},
			ctx,
		);
		send('done', result.data);
	} catch (e) {
		send('error', { message: e.message });
	}
	res.end();
}

// ── live-stream ────────────────────────────────────────────────────────────
// SSE — fans out the PumpPortal WebSocket feed to browser clients.
// Routed before wrap() above. No auth; rate-limited by IP.

const liveStreamKindSchema = z.enum(['all', 'mint', 'graduation']).default('all');

async function handleLiveStream(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const url = new URL(req.url, `http://${req.headers.host}`);
	let kind;
	try {
		kind = liveStreamKindSchema.parse(url.searchParams.get('kind') ?? undefined);
	} catch {
		return error(res, 400, 'validation_error', 'kind must be all, mint, or graduation');
	}

	res.statusCode = 200;
	res.setHeader('content-type', 'text/event-stream; charset=utf-8');
	res.setHeader('cache-control', 'no-cache, no-transform');
	res.setHeader('connection', 'keep-alive');
	res.setHeader('x-accel-buffering', 'no');

	const ping = setInterval(() => {
		if (!res.writableEnded) res.write(': ping\n\n');
	}, 15_000);

	const maxDuration = setTimeout(() => {
		clearInterval(ping);
		if (!res.writableEnded) {
			res.write(`event: end\ndata: ${JSON.stringify({ reason: 'max-duration' })}\n\n`);
			res.end();
		}
	}, 60 * 60 * 1_000);

	const stop = connectPumpFunFeed({
		kind,
		onEvent({ kind: evtKind, data }) {
			if (!res.writableEnded) {
				res.write(`event: ${evtKind}\ndata: ${JSON.stringify(data)}\n\n`);
			}
		},
	});

	req.on('close', () => {
		clearInterval(ping);
		clearTimeout(maxDuration);
		stop();
		if (!res.writableEnded) res.end();
	});
}

// ── strategy-validate ──────────────────────────────────────────────────────

async function handleStrategyValidate(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = await readJson(req);
	if (!body?.strategy || typeof body.strategy !== 'object') {
		return error(res, 400, 'validation_error', 'strategy required');
	}

	const rt = makeRuntime();
	const r = await rt.invoke('pump-fun-strategy.validateStrategy', { strategy: body.strategy });
	if (!r.ok) return error(res, 400, 'validation_error', r.error);
	return json(res, 200, { data: r.data });
}

// ── channel-feed ──────────────────────────────────────────────────────────────

async function handleChannelFeed(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');
	const url = new URL(req.url, `http://${req.headers.host}`);
	const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') || 50)), 200);
	const kinds = url.searchParams.get('kinds') || null;
	const { getMints, getWhales, getClaims } = await import('../_lib/channel-feed-sources.js');
	const { buildFeed } = await import('../../src/pump/channel-feed.js');
	const [mints, whales, claims] = await Promise.all([getMints(limit), getWhales(limit), getClaims(limit)]);
	const items = buildFeed([{ kind: 'mint', items: mints }, { kind: 'whale', items: whales }, { kind: 'claim', items: claims }], { limit, kinds });
	return json(res, 200, { items });
}

// ── trending / search (proxies for the CORS-protected pump.fun frontend API) ──

const PUMP_FRONTEND_BASE = 'https://frontend-api-v3.pump.fun';
const TRENDING_CACHE = { at: 0, body: null };
const TRENDING_TTL_MS = 15_000;

async function handleTrending(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');
	const now = Date.now();
	if (TRENDING_CACHE.body && now - TRENDING_CACHE.at < TRENDING_TTL_MS) {
		res.setHeader('cache-control', 'public, max-age=15');
		return json(res, 200, TRENDING_CACHE.body);
	}
	const url = new URL(req.url, `http://${req.headers.host}`);
	const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') || 50)), 100);
	const upstream = new URL('/coins', PUMP_FRONTEND_BASE);
	upstream.searchParams.set('offset', '0');
	upstream.searchParams.set('limit', String(limit));
	upstream.searchParams.set('sort', 'market_cap');
	upstream.searchParams.set('order', 'DESC');
	upstream.searchParams.set('includeNsfw', 'false');
	const resp = await fetch(upstream, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
	if (!resp.ok) return error(res, 502, 'upstream_failed', `pump.fun returned ${resp.status}`);
	const body = await resp.json();
	const arr = Array.isArray(body) ? body : Array.isArray(body?.coins) ? body.coins : [];
	TRENDING_CACHE.at = now;
	TRENDING_CACHE.body = arr;
	res.setHeader('cache-control', 'public, max-age=15');
	return json(res, 200, arr);
}

async function handleSearch(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');
	const url = new URL(req.url, `http://${req.headers.host}`);
	const q = (url.searchParams.get('q') || '').trim();
	if (!q) return json(res, 200, []);
	const upstream = new URL('/coins', PUMP_FRONTEND_BASE);
	upstream.searchParams.set('searchTerm', q);
	upstream.searchParams.set('offset', '0');
	upstream.searchParams.set('limit', '30');
	upstream.searchParams.set('sort', 'market_cap');
	upstream.searchParams.set('order', 'DESC');
	upstream.searchParams.set('includeNsfw', 'false');
	const resp = await fetch(upstream, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
	if (!resp.ok) return error(res, 502, 'upstream_failed', `pump.fun returned ${resp.status}`);
	const body = await resp.json();
	const arr = Array.isArray(body) ? body : Array.isArray(body?.coins) ? body.coins : [];
	return json(res, 200, arr);
}

// ── deliver-telegram ──────────────────────────────────────────────────────────

import { z as _z } from 'zod';
const _deliverSchema = _z.object({
	chatId: _z.union([_z.string(), _z.number()]),
	signal: _z.object({ kind: _z.enum(['mint', 'whale', 'claim', 'graduation']), mint: _z.string(), summary: _z.string(), refs: _z.array(_z.string()).optional(), ts: _z.number().optional() }),
});

async function handleDeliverTelegram(req, res) {
	if (!method(req, res, ['POST'])) return;
	const botToken = process.env.TELEGRAM_BOT_TOKEN;
	if (!botToken) return error(res, 500, 'misconfigured', 'TELEGRAM_BOT_TOKEN is not set');
	const raw = await readJson(req);
	const { chatId, signal } = parse(_deliverSchema, raw);
	const { sendTelegramSignal } = await import('../../src/pump/telegram-delivery.js');
	const result = await sendTelegramSignal({ botToken, chatId, signal });
	return json(res, 200, result);
}

// ── first-claims ──────────────────────────────────────────────────────────────

import bs58 from 'bs58';
import { filterFirstClaims } from '../../src/pump/first-claims.js';

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const CLAIM_DISCS = new Set(['e8f5c2eeeada3a59', '7a027f010ebf0caf', 'a537817004b3ca28']);
const LOOKBACK_MULT = 8;

export async function scanFirstClaims({ sinceTs, limit }) {
	const lim = Math.max(1, Math.min(50, limit));
	const lookbackTs = sinceTs - Math.max(3600, (Math.floor(Date.now() / 1000) - sinceTs) * LOOKBACK_MULT);
	const allClaims = process.env.PUMPFUN_BOT_URL ? await _fetchFromBot(lookbackTs, lim * LOOKBACK_MULT) : await _fetchFromRpc(lookbackTs, lim * LOOKBACK_MULT);
	return filterFirstClaims(allClaims, sinceTs, lim);
}

// ── recent-graduations ───────────────────────────────────────────────────────
//
// Returns the most-recent enriched graduation events as a single JSON payload.
// The page calls this once on load to backfill the feed before it opens an
// SSE connection. Reads from Postgres if available, falls back to the WS
// feed's in-process ring buffer (covers cold starts before the first migration
// arrives, plus dev environments without a DB).

async function handleRecentGraduations(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');
	const url = new URL(req.url, 'http://x');
	const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 20));
	try {
		const { recentGraduations } = await import('../_lib/pumpfun-ws-feed.js');
		const items = await recentGraduations({ limit });
		return json(res, 200, { items }, { 'cache-control': 'public, max-age=5' });
	} catch (err) {
		console.warn('[recent-graduations] failed:', err?.message);
		return json(res, 200, { items: [] });
	}
}

async function handleFirstClaims(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');
	const url = new URL(req.url, 'http://x');
	const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 50));
	let sinceTs;
	if (url.searchParams.has('sinceTs')) { sinceTs = Number(url.searchParams.get('sinceTs')); }
	else { const sinceMinutes = Math.max(1, Math.min(1440, Number(url.searchParams.get('sinceMinutes')) || 60)); sinceTs = Math.floor(Date.now() / 1000) - sinceMinutes * 60; }
	if (!Number.isFinite(sinceTs) || sinceTs <= 0) return error(res, 400, 'validation_error', 'invalid sinceTs');
	const items = await scanFirstClaims({ sinceTs, limit });
	return json(res, 200, { items });
}

async function _fetchFromBot(lookbackTs, maxItems) {
	const r = await _botCall('getFirstClaims', { sinceTs: lookbackTs, limit: maxItems });
	if (r.ok) return _normalise(r.data);
	const r2 = await _botCall('getRecentClaims', { limit: maxItems });
	if (r2.ok) return _normalise(r2.data);
	return [];
}
async function _botCall(tool, args) {
	const url = process.env.PUMPFUN_BOT_URL;
	if (!url) return { ok: false };
	const headers = { 'content-type': 'application/json', accept: 'application/json' };
	if (process.env.PUMPFUN_BOT_TOKEN) headers.authorization = `Bearer ${process.env.PUMPFUN_BOT_TOKEN}`;
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), 8000);
	try {
		const resp = await fetch(url.replace(/\/$/, ''), { method: 'POST', headers, signal: ctrl.signal, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args || {} } }) });
		if (!resp.ok) return { ok: false, error: `bot ${resp.status}` };
		const j = await resp.json();
		if (j.error) return { ok: false, error: j.error.message || 'rpc error' };
		const data = j.result?.structuredContent ?? j.result?.content ?? j.result;
		return { ok: true, data: Array.isArray(data) ? data : (data?.items ?? []) };
	} catch (err) { return { ok: false, error: err?.message || 'fetch failed' }; }
	finally { clearTimeout(t); }
}
function _normalise(items) {
	return (items || []).map((x) => ({ creator: String(x.claimerWallet || x.creator || x.wallet || ''), mint: String(x.tokenMint || x.mint || ''), signature: String(x.txSignature || x.tx_signature || x.signature || ''), lamports: Number(x.amountLamports || x.lamports || 0), ts: Number(x.timestamp || x.ts || 0) })).filter((x) => x.creator && x.signature && x.ts > 0);
}
async function _fetchFromRpc(lookbackTs, maxItems) {
	try {
		const connection = getConnection({ network: 'mainnet' });
		const { PublicKey } = await import('@solana/web3.js');
		const sigs = await connection.getSignaturesForAddress(new PublicKey(PUMP_PROGRAM), { limit: 200 });
		const inWindow = sigs.filter((s) => s.blockTime != null && s.blockTime >= lookbackTs && !s.err);
		if (!inWindow.length) return [];
		const toFetch = inWindow.slice(0, Math.min(30, maxItems * 2));
		const settled = await Promise.allSettled(toFetch.map((s) => connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })));
		const claims = [];
		for (let i = 0; i < settled.length; i++) {
			if (settled[i].status !== 'fulfilled' || !settled[i].value) continue;
			const claim = _parseClaim(settled[i].value, toFetch[i].signature, toFetch[i].blockTime ?? 0);
			if (claim) claims.push(claim);
		}
		return claims;
	} catch { return []; }
}
function _parseClaim(tx, signature, ts) {
	if (tx?.meta?.err) return null;
	const ixs = tx?.transaction?.message?.instructions ?? [];
	const accountKeys = tx?.transaction?.message?.accountKeys ?? [];
	const pre = tx?.meta?.preBalances ?? [], post = tx?.meta?.postBalances ?? [];
	for (const ix of ixs) {
		if (!ix.data || typeof ix.data !== 'string') continue;
		const progKey = accountKeys[ix.programIdIndex];
		const progId = progKey?.pubkey?.toString?.() ?? String(progKey ?? '');
		if (progId !== PUMP_PROGRAM) continue;
		let bytes;
		try { bytes = bs58.decode(ix.data); } catch { continue; }
		if (bytes.length < 8) continue;
		const disc = Buffer.from(bytes.subarray(0, 8)).toString('hex');
		if (!CLAIM_DISCS.has(disc)) continue;
		const creator = (accountKeys[0]?.pubkey?.toString?.() ?? String(accountKeys[0] ?? ''));
		if (!creator) continue;
		let lamports = 0;
		for (let i = 0; i < accountKeys.length; i++) { const delta = (post[i] ?? 0) - (pre[i] ?? 0); if (delta > lamports) lamports = delta; }
		let mint = '';
		if (disc === 'a537817004b3ca28' && bytes.length >= 48) { try { mint = bs58.encode(bytes.slice(16, 48)); } catch {} }
		return { creator, mint, signature, lamports, ts };
	}
	return null;
}

// ── vanity-keygen (SSE) ───────────────────────────────────────────────────────

async function handleVanityKeygen(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*' })) return;
	if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return error(res, 405, 'method_not_allowed', 'method POST required'); }
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');
	let body;
	try { body = await readJson(req); } catch (e) { return error(res, e.status || 400, 'bad_request', e.message); }
	const { suffix = '', prefix = '', caseSensitive = false, maxAttempts = 5_000_000 } = body || {};
	if (!suffix && !prefix) return error(res, 400, 'validation_error', 'at least one of suffix or prefix is required');
	res.statusCode = 200;
	res.setHeader('content-type', 'text/event-stream; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	res.setHeader('connection', 'keep-alive');
	res.setHeader('x-accel-buffering', 'no');
	const ac = new AbortController();
	const timeout = setTimeout(() => { ac.abort(); _sse(res, 'error', { error: 'request_timeout', error_description: 'vanity search exceeded 60 s limit' }); res.statusCode = 408; res.end(); }, 60_000);
	req.on('close', () => ac.abort());
	const progressInterval = setInterval(() => { if (ac.signal.aborted) return clearInterval(progressInterval); _sse(res, 'progress', { elapsed: Date.now() }); }, 2_000);
	try {
		const { generateVanityKey } = await import('../../src/pump/vanity-keygen.js');
		const _bs58 = (await import('bs58')).default;
		const result = await generateVanityKey({ suffix, prefix, caseSensitive, maxAttempts, signal: ac.signal });
		clearTimeout(timeout); clearInterval(progressInterval);
		if (!result) _sse(res, 'error', { error: 'max_attempts_reached', error_description: `no match found in ${maxAttempts} attempts` });
		else _sse(res, 'result', { publicKey: result.publicKey, secretKey: _bs58.encode(result.secretKey), attempts: result.attempts, ms: result.ms });
	} catch (err) {
		clearTimeout(timeout); clearInterval(progressInterval);
		if (!res.writableEnded) _sse(res, 'error', { error: 'internal_error', error_description: err.message || 'unexpected error' });
	} finally { if (!res.writableEnded) res.end(); }
}

// ── collect-creator-fee-prep ───────────────────────────────────────────────
// Builds the tx for the coin creator to collect accrued creator fees from the
// pump.fun fee vault into their own wallet.
// Docs: https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COLLECT_CREATOR_FEE.md

const collectCreatorFeePrepSchema = z.object({
	// The on-chain creator address registered for the coin.
	creator_address: z.string().min(32).max(44),
	// The wallet that will sign (and receive fees). Must match creator_address.
	wallet_address: z.string().min(32).max(44),
	network: z.enum(['mainnet', 'devnet']).default('mainnet'),
});

async function handleCollectCreatorFeePrep(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = parse(collectCreatorFeePrepSchema, await readJson(req));
	const creatorPk = solanaPubkey(body.creator_address);
	const feePayer  = solanaPubkey(body.wallet_address);
	if (!creatorPk || !feePayer) return error(res, 400, 'validation_error', 'invalid pubkeys');

	try {
		const { sdk, connection } = await getPumpSdk({ network: body.network });
		const { OnlinePumpSdk } = await import('@pump-fun/pump-sdk');
		const onlineSdk = new OnlinePumpSdk(connection);
		const ixs = await onlineSdk.collectCoinCreatorFeeInstructions(creatorPk, feePayer);
		const tx_base64 = await buildUnsignedTxBase64({
			network: body.network,
			payer: feePayer,
			instructions: Array.isArray(ixs) ? ixs : [ixs],
		});
		return json(res, 201, {
			creator: body.creator_address,
			network: body.network,
			tx_base64,
		});
	} catch (e) {
		return error(res, e.status || 502, e.code || 'pump_sdk_error', e.message || 'failed to build collect-creator-fee tx');
	}
}

// ── distribute-creator-fees-prep ──────────────────────────────────────────
// Builds the tx that distributes accumulated creator fees to shareholders
// defined in the coin's fee-sharing config. For graduated coins the SDK
// automatically prepends a `transfer_creator_fees_to_pump_v2` instruction so
// AMM-side fees are consolidated into the bonding-curve vault first — no
// separate transfer call is needed at this layer.
//
// ATA initialization for non-native quotes (e.g. USDC) is handled internally
// by `buildDistributeCreatorFeesInstructions`: the SDK reads the coin's
// quote_mint and emits `initialize_ata: true` for the underlying
// `distribute_creator_fees_v2` instruction so each shareholder's USDC ATA is
// idempotently created before the program transfers their share.
//
// Docs: https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/CREATOR_FEE_SHARING.md

const distributeCreatorFeesPrepSchema = z.object({
	mint: z.string().min(32).max(44),
	wallet_address: z.string().min(32).max(44), // fee payer / signer (permissionless)
	network: z.enum(['mainnet', 'devnet']).default('mainnet'),
});

async function handleDistributeCreatorFeesPrep(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = parse(distributeCreatorFeesPrepSchema, await readJson(req));
	const mintPk  = solanaPubkey(body.mint);
	const payerPk = solanaPubkey(body.wallet_address);
	if (!mintPk || !payerPk) return error(res, 400, 'validation_error', 'invalid pubkeys');

	try {
		const { connection } = await getPumpSdk({ network: body.network });
		const { OnlinePumpSdk } = await import('@pump-fun/pump-sdk');
		const onlineSdk = new OnlinePumpSdk(connection);
		const { instructions, isGraduated } = await onlineSdk.buildDistributeCreatorFeesInstructions(mintPk);
		const tx_base64 = await buildUnsignedTxBase64({
			network: body.network,
			payer: payerPk,
			instructions,
		});
		return json(res, 201, {
			mint: body.mint,
			network: body.network,
			is_graduated: !!isGraduated,
			tx_base64,
		});
	} catch (e) {
		return error(res, e.status || 502, e.code || 'pump_sdk_error', e.message || 'failed to build distribute-creator-fees tx');
	}
}

// ── update-fee-shares-prep ────────────────────────────────────────────────
// Step 2 of the fee-sharing lifecycle. The current sharing_config admin
// finalises the shareholder list (1–10 entries, share_bps must sum to 10_000).
// This sweeps any pending AMM + bonding-curve fees, applies the new
// distribution, and (in version-1 configs) permanently revokes further
// updates — so for v1 callers should call it exactly once after
// create-fee-sharing-prep.
// Docs: https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/CREATOR_FEE_SHARING.md

const updateFeeSharesSchema = z.object({
	mint: z.string().min(32).max(44),
	wallet_address: z.string().min(32).max(44), // sharing_config admin (signer + fee payer)
	network: z.enum(['mainnet', 'devnet']).default('mainnet'),
	// The set of shareholder addresses currently encoded in the on-chain
	// sharing_config. Right after create-fee-sharing-prep this is `[creator]`
	// at 10_000 bps; after a prior update it's whatever was last set. The SDK
	// uses these to derive the existing PDA accounts that must be passed in.
	current_shareholders: z.array(z.string().min(32).max(44)).min(1).max(10),
	new_shareholders: z
		.array(
			z.object({
				address: z.string().min(32).max(44),
				share_bps: z.number().int().min(1).max(10_000),
			}),
		)
		.min(1)
		.max(10)
		.refine(
			(arr) => arr.reduce((s, x) => s + x.share_bps, 0) === 10_000,
			{ message: 'share_bps must sum to 10000' },
		)
		.refine(
			(arr) => new Set(arr.map((x) => x.address)).size === arr.length,
			{ message: 'duplicate shareholder addresses' },
		),
});

async function handleUpdateFeeSharesPrep(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = parse(updateFeeSharesSchema, await readJson(req));
	const mintPk    = solanaPubkey(body.mint);
	const payerPk   = solanaPubkey(body.wallet_address);
	if (!mintPk || !payerPk) return error(res, 400, 'validation_error', 'invalid pubkeys');

	const currentShareholders = body.current_shareholders.map((s) => {
		const pk = solanaPubkey(s);
		if (!pk) throw Object.assign(new Error(`invalid current shareholder ${s}`), { status: 400, code: 'validation_error' });
		return pk;
	});
	const newShareholders = body.new_shareholders.map((s) => {
		const addr = solanaPubkey(s.address);
		if (!addr) throw Object.assign(new Error(`invalid shareholder ${s.address}`), { status: 400, code: 'validation_error' });
		return { address: addr, shareBps: s.share_bps };
	});

	try {
		const { sdk } = await getPumpSdk({ network: body.network });
		const ix = await sdk.updateFeeShares({
			authority: payerPk,
			mint: mintPk,
			currentShareholders,
			newShareholders,
		});
		const tx_base64 = await buildUnsignedTxBase64({
			network: body.network,
			payer: payerPk,
			instructions: [ix],
		});
		return json(res, 201, {
			mint: body.mint,
			network: body.network,
			shareholder_count: newShareholders.length,
			tx_base64,
		});
	} catch (e) {
		return error(res, e.status || 502, e.code || 'pump_sdk_error', e.message || 'failed to build update-fee-shares tx');
	}
}

// ── create-fee-sharing-prep ────────────────────────────────────────────────
// Builds the tx to create a fee-sharing config for a graduated coin, enabling
// the coin creator to split AMM creator fees among multiple shareholders.
// Docs: https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/CREATOR_FEE_SHARING.md

const createFeeSharingPrepSchema = z.object({
	mint: z.string().min(32).max(44),
	creator_address: z.string().min(32).max(44),
	wallet_address: z.string().min(32).max(44), // signer / fee payer
	network: z.enum(['mainnet', 'devnet']).default('mainnet'),
});

async function handleCreateFeeSharingPrep(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = parse(createFeeSharingPrepSchema, await readJson(req));
	const mintPk    = solanaPubkey(body.mint);
	const creatorPk = solanaPubkey(body.creator_address);
	const payerPk   = solanaPubkey(body.wallet_address);
	if (!mintPk || !creatorPk || !payerPk) return error(res, 400, 'validation_error', 'invalid pubkeys');

	try {
		const { canonicalPumpPoolPda } = await import('@pump-fun/pump-swap-sdk');
		const { bondingCurvePda } = await import('@pump-fun/pump-sdk');
		const { isLegacyQuoteMint } = await getPumpSdkV2({ network: body.network });
		const { sdk, connection } = await getPumpSdk({ network: body.network });
		
		const bcPda = bondingCurvePda(mintPk);
		const bcInfo = await connection.getAccountInfo(bcPda);
		const bc = bcInfo ? sdk.decodeBondingCurve(bcInfo) : null;
		
		let poolPk;
		if (bc && bc.quoteMint && !isLegacyQuoteMint(bc.quoteMint)) {
			poolPk = canonicalPumpPoolPda(mintPk, bc.quoteMint);
		} else {
			poolPk = canonicalPumpPoolPda(mintPk);
		}
		
		const ix = await sdk.createFeeSharingConfig({ creator: creatorPk, mint: mintPk, pool: poolPk });
		const tx_base64 = await buildUnsignedTxBase64({
			network: body.network,
			payer: payerPk,
			instructions: [ix],
		});
		return json(res, 201, {
			mint: body.mint,
			creator: body.creator_address,
			pool: poolPk.toString(),
			network: body.network,
			tx_base64,
		});
	} catch (e) {
		return error(res, e.status || 502, e.code || 'pump_sdk_error', e.message || 'failed to build create-fee-sharing tx');
	}
}
function _sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
