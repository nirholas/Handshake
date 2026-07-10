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
//   launches                 -> handleLaunches (public cross-agent launch feed)
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
//   fee-info                      -> handleFeeInfo (read-only: claimable creator
//                                    fees, graduation, sharing-config shareholders)
//   resolve-github-shareholder    -> handleResolveGithubShareholder (read-only:
//                                    GitHub @login/id -> the recipient's linked
//                                    Solana payout wallet, or a pump.fun social-fee
//                                    escrow PDA when they haven't joined yet)
//   create-social-fee-pda-prep    -> handleCreateSocialFeePdaPrep (user-signed:
//                                    initialise the pump.fun social-fee escrow that
//                                    a fee-share update then routes a slice into)
//   collect-creator-fee-agent     -> handleCollectCreatorFeeAgent (server-signs
//                                    with the agent custodial wallet)
//   distribute-creator-fees-agent -> handleDistributeCreatorFeesAgent (server-signs)
//   fee-sharing-agent             -> handleFeeSharingAgent (server-signs create +
//                                    update sharing config; delegated fee rewards)

import { z } from 'zod';
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { sql } from '../_lib/db.js';
import { resolveSocialReward } from '../_lib/github-reward.js';
import { submitProtected } from '../_lib/execution-engine.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, method, readJson, wrap, error, rateLimited, respondError } from '../_lib/http.js';
import { putObject, publicUrl as r2PublicUrl } from '../_lib/r2.js';
import { env } from '../_lib/env.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { resolveOrCreateAgentForAvatar as resolveLaunchAgentId } from '../_lib/agent-identity.js';
import { parse, isUuid } from '../_lib/validate.js';
import { queryAgentLaunches } from '../_lib/pump-agent-launches.js';
import { randomToken } from '../_lib/crypto.js';
import { publishFeedEvent } from '../_lib/feed.js';
import { normalizeGatewayURL } from '../../src/ipfs.js';
import { buildTokenMetadata } from '../_lib/three-brand.js';
import { buildPlatformFeeInstructions, effectivePumpFeeBps } from '../_lib/pump-platform-fee.js';
import { pinToIPFS, ipfsPinningConfigured } from '../_lib/ipfs-pin.js';
import { THREE_WS_VANITY, hasThreeWsMark } from '../../src/solana/vanity/brand.js';
import { grindVanityNode, GrindExhaustedError } from '../../src/solana/vanity/grinder-node.js';
import { logger } from '../_lib/usage.js';

const log = logger('pump.launch');
import {
	getConnection,
	getPumpSdk,
	getPumpSdkV2,
	getPumpAgent,
	getPumpAgentOffline,
	getAmmPoolState,
	buildUnsignedTxBase64,
	verifySignature,
	txInvokesPumpProgram,
	solanaPubkey,
} from '../_lib/pump.js';

// Wrapped SOL mint — required as the quoteMint for SOL-paired V2 instructions
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
import { solanaConnection, loadAgentForSigning } from '../_lib/agent-pumpfun.js';
import { connectPumpFunFeed } from '../_lib/pumpfun-ws-feed.js';
import { makeRuntime } from '../_lib/skill-runtime.js';
import { loadWallet } from '../_lib/solana-wallet.js';
import {
	checkBuyAllowed,
	reserveSpend,
	finalizeSpend,
	releaseSpend,
} from '../_lib/agent-spend-policy.js';
import { SOLANA_USDC_MINT, SOLANA_USDC_MINT_DEVNET, toUsdcAtomics } from '../payments/_config.js';
import {
	classifyLaunchQuote,
	usdcMintFor,
	tradeQuoteColumns,
	walletQuoteDeltaAtomics,
} from '../_lib/pump-quote.js';
import {
	slippagePercentFromBps,
	resolveTokenProgramForMintOwner,
} from '../_lib/pump-trade-args.js';

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
		case 'balances':
			return handleBalances(req, res);
		case 'buy-prep':
			return handleBuyPrep(req, res);
		case 'buy-confirm':
			return handleBuyConfirm(req, res);
		case 'sell-prep':
			return handleSellPrep(req, res);
		case 'sell-confirm':
			return handleSellConfirm(req, res);
		case 'build-metadata':
			return handleBuildMetadata(req, res);
		case 'launch-prep':
			return handleLaunchPrep(req, res);
		case 'launch-confirm':
			return handleLaunchConfirm(req, res);
		case 'launch-agent':
			return handleLaunchAgent(req, res);
		case 'agent-wallet':
			return handleAgentWallet(req, res);
		case 'accept-payment-prep':
			return handleAcceptPaymentPrep(req, res);
		case 'accept-payment-confirm':
			return handleAcceptPaymentConfirm(req, res);
		case 'payments-list':
			return handlePaymentsList(req, res);
		case 'portfolio':
			return handlePortfolio(req, res);
		case 'by-agent':
			return handleByAgent(req, res);
		case 'launches':
			return handleLaunches(req, res);
		case 'quote':
			return handleQuote(req, res);
		case 'governance-prep':
			return handleGovernancePrep(req, res);
		case 'withdraw-prep':
			return handleWithdrawPrep(req, res);
		case 'withdraw-confirm':
			return handleWithdrawConfirm(req, res);
		case 'strategy-backtest':
			return handleStrategyBacktest(req, res);
		case 'strategy-close-all':
			return handleStrategyCloseAll(req, res);
		case 'strategy-validate':
			return handleStrategyValidate(req, res);
		case 'channel-feed':
			return handleChannelFeed(req, res);
		case 'deliver-telegram':
			return handleDeliverTelegram(req, res);
		case 'first-claims':
			return handleFirstClaims(req, res);
		case 'recent-graduations':
			return handleRecentGraduations(req, res);
		case 'trending':
			return handleTrending(req, res);
		case 'coin':
			return handleCoin(req, res);
		case 'coin-trades':
			return handleCoinTrades(req, res);
		case 'search':
			return handleSearch(req, res);
		case 'collect-creator-fee-prep':
			return handleCollectCreatorFeePrep(req, res);
		case 'distribute-creator-fees-prep':
			return handleDistributeCreatorFeesPrep(req, res);
		case 'create-fee-sharing-prep':
			return handleCreateFeeSharingPrep(req, res);
		case 'update-fee-shares-prep':
			return handleUpdateFeeSharesPrep(req, res);
		case 'fee-info':
			return handleFeeInfo(req, res);
		case 'resolve-github-shareholder':
			return handleResolveGithubShareholder(req, res);
		case 'create-social-fee-pda-prep':
			return handleCreateSocialFeePdaPrep(req, res);
		case 'github-resolve':
			return handleGithubResolve(req, res);
		case 'social-fee-claim-status':
			return handleSocialFeeClaimStatus(req, res);
		case 'collect-creator-fee-agent':
			return handleCollectCreatorFeeAgent(req, res);
		case 'distribute-creator-fees-agent':
			return handleDistributeCreatorFeesAgent(req, res);
		case 'fee-sharing-agent':
			return handleFeeSharingAgent(req, res);
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

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

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
		// Most common: agent not yet bound to mint → PDA missing. Sanitize the 5xx —
		// web3.js network errors embed the keyed Helius RPC URL in err.message.
		return respondError(res, 502, 'pump_agent_error', err);
	}
}

// ── buy-prep ───────────────────────────────────────────────────────────────

const buyPrepSchema = z
	.object({
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
	})
	.refine((v) => v.sol != null || v.usdc_amount != null, {
		message: 'sol or usdc_amount required',
		path: ['sol'],
	});

async function handleBuyPrep(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(buyPrepSchema, await readJson(req));
	const userPk = solanaPubkey(body.wallet_address);
	const mintPk = solanaPubkey(body.mint);
	if (!userPk || !mintPk) return error(res, 400, 'validation_error', 'invalid pubkeys');

	try {
		const { sdk, BN, web3, connection } = await getPumpSdk({ network: body.network });
		const { isLegacyQuoteMint, getBuyTokenAmountFromSolAmount } =
			await import('@pump-fun/pump-sdk');
		// @pump-fun SDK builders take slippage as a PERCENT (1 = 1%), not a
		// fraction — see api/_lib/pump-trade-args.js for the unit derivation.
		const slippagePct = slippagePercentFromBps(body.slippage_bps);

		// The base mint's owner decides base_token_program: create_v2 coins are
		// Token-2022, legacy coins are SPL Token (docs/instructions/BUY.md #4).
		const mintInfo = await connection.getAccountInfo(mintPk);
		if (!mintInfo)
			return error(
				res,
				404,
				'mint_not_found',
				`mint ${body.mint} not found on ${body.network}`,
			);
		const baseTokenProgram = resolveTokenProgramForMintOwner(mintInfo.owner);

		// Fetch bonding curve state — also gives us the on-chain quote_mint.
		// Pass the real token program so the user-ATA existence check resolves
		// the correct (possibly Token-2022) associated account.
		let buyState = null;
		try {
			if (sdk.fetchBuyState)
				buyState = await sdk.fetchBuyState(mintPk, userPk, baseTokenProgram);
		} catch {
			buyState = null;
		}

		// Resolve quoteMint: explicit override > on-chain curve > WSOL fallback.
		let quoteMintPk = body.quote_mint
			? solanaPubkey(body.quote_mint)
			: (buyState?.bondingCurve?.quoteMint ?? solanaPubkey(WSOL_MINT));
		if (!quoteMintPk) quoteMintPk = solanaPubkey(WSOL_MINT);

		const isUsdcQuote = !isLegacyQuoteMint(quoteMintPk);
		// On-chain SOL curves store quoteMint as PublicKey.default (all-zeros).
		// Surface wrapped SOL in the API response instead of the zero pubkey so
		// clients see a real, usable mint for every coin type.
		const quoteMintDisplay = isUsdcQuote ? quoteMintPk.toString() : WSOL_MINT;

		// quote_token_program must match the quote mint's owner (wSOL/USDC are
		// SPL Token today; read it from chain so a future quote can't break us).
		let quoteTokenProgram = TOKEN_PROGRAM_ID;
		if (isUsdcQuote) {
			const quoteInfo = await connection.getAccountInfo(quoteMintPk);
			if (!quoteInfo)
				return error(
					res,
					404,
					'quote_mint_not_found',
					`quote mint ${quoteMintPk.toBase58()} not found`,
				);
			quoteTokenProgram = resolveTokenProgramForMintOwner(quoteInfo.owner);
		}

		// Validate the quote-asset amount up front for both routes.
		if (isUsdcQuote && body.usdc_amount == null)
			return error(res, 400, 'validation_error', 'usdc_amount required for USDC-paired coin');
		if (!isUsdcQuote && body.sol == null)
			return error(res, 400, 'validation_error', 'sol required for SOL-paired coin');
		const quoteAtomics = isUsdcQuote
			? new BN(Math.round(body.usdc_amount * 1_000_000))
			: new BN(Math.floor(body.sol * web3.LAMPORTS_PER_SOL));

		if (buyState && buyState.bondingCurve && !buyState.bondingCurve.complete) {
			// Unified v2 interface for every coin type (SOL- and USDC-paired,
			// SPL and Token-2022 base mints) per the upstream migration guidance —
			// docs/pumpfun-program/UPSTREAM-buy-sell-v2-announcement.md.
			const [global, feeConfig] = await Promise.all([
				sdk.fetchGlobal(),
				sdk.fetchFeeConfig().catch(() => null),
			]);
			// buy_v2's `amount` arg is the base-token quantity to buy and must be
			// > 0 (docs/instructions/BUY.md) — derive it from the quote input.
			const tokenAmount = getBuyTokenAmountFromSolAmount({
				global,
				feeConfig,
				mintSupply: buyState.bondingCurve.tokenTotalSupply,
				bondingCurve: buyState.bondingCurve,
				amount: quoteAtomics,
				quoteMint: quoteMintPk,
			});
			if (!tokenAmount.gt(new BN(0)))
				return error(
					res,
					400,
					'amount_too_small',
					'quote amount too small to buy any tokens',
				);
			const ixs = await sdk.buyV2Instructions({
				global,
				bondingCurveAccountInfo: buyState.bondingCurveAccountInfo,
				bondingCurve: buyState.bondingCurve,
				associatedUserAccountInfo: buyState.associatedUserAccountInfo,
				mint: mintPk,
				user: userPk,
				amount: tokenAmount,
				quoteAmount: quoteAtomics,
				slippage: slippagePct,
				tokenProgram: baseTokenProgram,
				quoteTokenProgram,
			});
			const __platformFee = await buildPlatformFeeInstructions({
				network: body.network, payer: userPk, isUsdc: isUsdcQuote,
				quoteMintPk, quoteTokenProgram, grossAtomics: BigInt(quoteAtomics.toString()), basis: 'buy',
			});
			if (__platformFee) ixs.push(...__platformFee.instructions);
			const tx_base64 = await buildUnsignedTxBase64({
				network: body.network,
				payer: userPk,
				instructions: ixs,
			});
			return json(res, 201, {
				route: 'bonding_curve',
				mint: body.mint,
				network: body.network,
				quote_mint: quoteMintDisplay,
				...(isUsdcQuote ? { usdc_in: body.usdc_amount } : { sol_in: body.sol }),
				expected_tokens_out: tokenAmount.toString(),
				slippage_bps: body.slippage_bps,
				platform_fee: __platformFee ? __platformFee.disclosure : null,
				tx_base64,
			});
		}

		// AMM (post-graduation)
		const amm = await getAmmPoolState({
			network: body.network,
			mint: mintPk,
			quoteMint: isUsdcQuote ? quoteMintPk : null,
		});
		const ammMod = await import('@pump-fun/pump-swap-sdk');
		const offline = new ammMod.PumpAmmSdk();
		const onlineAmm = new ammMod.OnlinePumpAmmSdk(getConnection({ network: body.network }));
		const swapState = await onlineAmm.swapSolanaState(amm.poolKey, userPk);

		const ixs = await offline.buyQuoteInput(swapState, quoteAtomics, slippagePct);
		const __platformFee = await buildPlatformFeeInstructions({
			network: body.network, payer: userPk, isUsdc: isUsdcQuote,
			quoteMintPk, quoteTokenProgram, grossAtomics: BigInt(quoteAtomics.toString()), basis: 'buy',
		});
		if (__platformFee) ixs.push(...__platformFee.instructions);
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
			quote_mint: quoteMintDisplay,
			...(isUsdcQuote ? { usdc_in: body.usdc_amount } : { sol_in: body.sol }),
			slippage_bps: body.slippage_bps,
			platform_fee: __platformFee ? __platformFee.disclosure : null,
			tx_base64,
		});
	} catch (e) {
		return respondError(res, e.status || 502, e.code || 'pump_sdk_error', e);
	}
}

// ── buy-confirm ────────────────────────────────────────────────────────────

const buyConfirmSchema = z
	.object({
		mint: z.string().min(32).max(44),
		network: z.enum(['mainnet', 'devnet']).default('mainnet'),
		tx_signature: z.string().min(80).max(100),
		wallet_address: z.string().min(32).max(44),
		// SOL-paired coins record `sol`; USDC-paired (v2) coins record `usdc_amount`.
		// Both optional so either quote asset can confirm; the tx itself is the
		// source of truth (verified on-chain below), these only label the trade row.
		sol: z.number().nonnegative().max(50).optional(),
		usdc_amount: z.number().nonnegative().max(1_000_000).optional(),
		route: z.enum(['bonding_curve', 'amm']),
		slippage_bps: z.number().int().min(0).max(5000).optional(),
	})
	.refine((v) => (v.sol ?? 0) > 0 || (v.usdc_amount ?? 0) > 0, {
		message: 'sol or usdc_amount required',
		path: ['sol'],
	});

async function handleBuyConfirm(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(buyConfirmSchema, await readJson(req));

	const [mintRow] = await sql`
		select id, quote_mint from pump_agent_mints where mint=${body.mint} and network=${body.network} limit 1
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
		// Resolve the quote asset authoritatively from the coin's recorded pairing
		// mint (NULL = SOL-paired), so a USDC buy never lands in the lamports
		// column. `sol_amount` stays a SOL-only lamports field for legacy readers;
		// `quote_amount` carries the spend in whichever quote's atomic units.
		const { quote_mint, quote_symbol } = tradeQuoteColumns({
			quoteMint: mintRow?.quote_mint,
			network: body.network,
		});
		const lamports =
			quote_symbol === 'SOL' && body.sol > 0
				? BigInt(Math.floor(body.sol * 1_000_000_000)).toString()
				: null;
		const quoteAmount =
			quote_symbol === 'SOL'
				? lamports
				: body.usdc_amount > 0
					? String(Math.round(body.usdc_amount * 1_000_000))
					: walletQuoteDeltaAtomics({
							tx,
							wallet: body.wallet_address,
							quoteSymbol: quote_symbol,
							quoteMint: quote_mint,
						});
		await sql`
			insert into pump_agent_trades
				(mint_id, user_id, wallet, direction, route, sol_amount,
				 quote_mint, quote_symbol, quote_amount, slippage_bps, tx_signature, network)
			values
				(${mintId}, ${user.id}, ${body.wallet_address}, 'buy', ${body.route},
				 ${lamports}, ${quote_mint}, ${quote_symbol}, ${quoteAmount},
				 ${body.slippage_bps ?? null}, ${body.tx_signature}, ${body.network})
			on conflict (tx_signature, network) do nothing
		`;
	}

	// Surface the buy on the site-wide live activity ticker. The tx is already
	// verified on-chain above, so this is a real, confirmed purchase. Fire-and-
	// forget: never let the delight layer delay or fail the buy response.
	publishFeedEvent({
		type: 'coin-buy',
		ts: Date.now(),
		actor: shortAddr(body.wallet_address),
		mint: body.mint,
		...(body.sol && body.sol > 0 ? { sol: body.sol } : {}),
		...(body.usdc_amount && body.usdc_amount > 0 ? { usdc: body.usdc_amount } : {}),
		network: body.network,
	}).catch(() => {});

	return json(res, 200, {
		ok: true,
		tracked: !!mintId,
		mint: body.mint,
		network: body.network,
		tx_signature: body.tx_signature,
	});
}

// Truncate a base58 address for public display: "AbCd…WxYz". The feed is world-
// readable, so we only ever surface the head/tail, never the full key.
function shortAddr(addr) {
	const s = String(addr || '');
	return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
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
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(sellPrepSchema, await readJson(req));
	const userPk = solanaPubkey(body.wallet_address);
	const mintPk = solanaPubkey(body.mint);
	if (!userPk || !mintPk) return error(res, 400, 'validation_error', 'invalid pubkeys');

	try {
		const { sdk, BN, connection } = await getPumpSdk({ network: body.network });
		const { isLegacyQuoteMint, getSellSolAmountFromTokenAmount } =
			await import('@pump-fun/pump-sdk');
		const tokens = new BN(body.tokens);
		// SDK builders take slippage as a PERCENT — see api/_lib/pump-trade-args.js.
		const slippagePct = slippagePercentFromBps(body.slippage_bps);

		// base_token_program must match the mint owner (Token-2022 for create_v2
		// coins, SPL for legacy) — docs/instructions/SELL.md #4.
		const mintInfo = await connection.getAccountInfo(mintPk);
		if (!mintInfo)
			return error(
				res,
				404,
				'mint_not_found',
				`mint ${body.mint} not found on ${body.network}`,
			);
		const baseTokenProgram = resolveTokenProgramForMintOwner(mintInfo.owner);

		let sellState = null;
		try {
			if (sdk.fetchSellState)
				sellState = await sdk.fetchSellState(mintPk, userPk, baseTokenProgram);
		} catch {
			sellState = null;
		}

		// Resolve quoteMint from explicit override > on-chain curve > WSOL fallback.
		let quoteMintPk = body.quote_mint
			? solanaPubkey(body.quote_mint)
			: (sellState?.bondingCurve?.quoteMint ?? solanaPubkey(WSOL_MINT));
		if (!quoteMintPk) quoteMintPk = solanaPubkey(WSOL_MINT);

		const isUsdcQuote = !isLegacyQuoteMint(quoteMintPk);
		// SOL curves store quoteMint as PublicKey.default — surface wrapped SOL.
		const quoteMintDisplay = isUsdcQuote ? quoteMintPk.toString() : WSOL_MINT;

		// quote_token_program must match the quote mint's owner.
		let quoteTokenProgram = TOKEN_PROGRAM_ID;
		if (isUsdcQuote) {
			const quoteInfo = await connection.getAccountInfo(quoteMintPk);
			if (!quoteInfo)
				return error(
					res,
					404,
					'quote_mint_not_found',
					`quote mint ${quoteMintPk.toBase58()} not found`,
				);
			quoteTokenProgram = resolveTokenProgramForMintOwner(quoteInfo.owner);
		}

		if (sellState && sellState.bondingCurve && !sellState.bondingCurve.complete) {
			// Unified v2 sell for every coin type. sell_v2 reads the fee-recipient
			// pool from the curve's mayhem flag inside the SDK builder, and the
			// expected quote output below gives the program a real min_sol_output
			// floor (expected minus slippage) instead of 0.
			const [global, feeConfig] = await Promise.all([
				sdk.fetchGlobal(),
				sdk.fetchFeeConfig().catch(() => null),
			]);
			const expectedQuoteOut = getSellSolAmountFromTokenAmount({
				global,
				feeConfig,
				mintSupply: sellState.bondingCurve.tokenTotalSupply,
				bondingCurve: sellState.bondingCurve,
				amount: tokens,
			});
			const ixs = [];
			if (isUsdcQuote) {
				// sell_v2 pays proceeds into the seller's quote ATA, which the
				// program does NOT init (SELL.md #16) — create it idempotently.
				const spl = await import('@solana/spl-token');
				const userQuoteAta = spl.getAssociatedTokenAddressSync(
					quoteMintPk,
					userPk,
					true,
					quoteTokenProgram,
				);
				ixs.push(
					spl.createAssociatedTokenAccountIdempotentInstruction(
						userPk,
						userQuoteAta,
						userPk,
						quoteMintPk,
						quoteTokenProgram,
					),
				);
			}
			ixs.push(
				...(await sdk.sellV2Instructions({
					global,
					bondingCurveAccountInfo: sellState.bondingCurveAccountInfo,
					bondingCurve: sellState.bondingCurve,
					mint: mintPk,
					user: userPk,
					amount: tokens,
					quoteAmount: expectedQuoteOut,
					slippage: slippagePct,
					tokenProgram: baseTokenProgram,
					quoteTokenProgram,
				})),
			);
			const __platformFee = await buildPlatformFeeInstructions({
				network: body.network, payer: userPk, isUsdc: isUsdcQuote,
				quoteMintPk, quoteTokenProgram, grossAtomics: BigInt(expectedQuoteOut.toString()), basis: 'sell',
			});
			if (__platformFee) ixs.push(...__platformFee.instructions);
			const tx_base64 = await buildUnsignedTxBase64({
				network: body.network,
				payer: userPk,
				instructions: ixs,
			});
			return json(res, 201, {
				route: 'bonding_curve',
				mint: body.mint,
				network: body.network,
				quote_mint: quoteMintDisplay,
				tokens_in: body.tokens,
				...(isUsdcQuote
					? { expected_usdc_out: Number(expectedQuoteOut.toString()) / 1_000_000 }
					: { expected_sol_out: Number(expectedQuoteOut.toString()) / 1_000_000_000 }),
				slippage_bps: body.slippage_bps,
				platform_fee: __platformFee ? __platformFee.disclosure : null,
				tx_base64,
			});
		}

		const amm = await getAmmPoolState({
			network: body.network,
			mint: mintPk,
			quoteMint: isUsdcQuote ? quoteMintPk : null,
		});
		const ammMod = await import('@pump-fun/pump-swap-sdk');
		const offline = new ammMod.PumpAmmSdk();
		const onlineAmm = new ammMod.OnlinePumpAmmSdk(getConnection({ network: body.network }));
		const swapState = await onlineAmm.swapSolanaState(amm.poolKey, userPk);
		const ixs = await offline.sellBaseInput(swapState, tokens, slippagePct);
		// Expected proceeds (uiQuote) is the fee basis for an AMM sell. Best-effort:
		// if the low-level quote can't be derived we skip the fee, never the sell.
		let __ammSellGross = 0n;
		try {
			const { uiQuote } = ammMod.sellBaseInput({
				base: tokens, slippage: slippagePct,
				baseReserve: swapState.poolBaseAmount, quoteReserve: swapState.poolQuoteAmount,
				baseMintAccount: swapState.baseMintAccount, baseMint: swapState.baseMint,
				coinCreator: swapState.pool.coinCreator, creator: swapState.pool.creator,
				feeConfig: swapState.feeConfig, globalConfig: swapState.globalConfig,
			});
			__ammSellGross = BigInt(uiQuote.toString());
		} catch { /* fee basis unavailable */ }
		const __platformFee = await buildPlatformFeeInstructions({
			network: body.network, payer: userPk, isUsdc: isUsdcQuote,
			quoteMintPk, quoteTokenProgram, grossAtomics: __ammSellGross, basis: 'sell',
		});
		if (__platformFee) ixs.push(...__platformFee.instructions);
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
			quote_mint: quoteMintDisplay,
			tokens_in: body.tokens,
			slippage_bps: body.slippage_bps,
			platform_fee: __platformFee ? __platformFee.disclosure : null,
			tx_base64,
		});
	} catch (e) {
		return respondError(res, e.status || 502, e.code || 'pump_sdk_error', e);
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
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(sellConfirmSchema, await readJson(req));

	const [mintRow] = await sql`
		select id, quote_mint from pump_agent_mints where mint=${body.mint} and network=${body.network} limit 1
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
		// The sell-confirm payload only carries the token quantity, so derive the
		// proceeds (quote received) from the verified tx's on-chain balance delta
		// rather than trusting client input — real settled amount, not an estimate.
		const { quote_mint, quote_symbol } = tradeQuoteColumns({
			quoteMint: mintRow?.quote_mint,
			network: body.network,
		});
		const quoteAmount = walletQuoteDeltaAtomics({
			tx,
			wallet: body.wallet_address,
			quoteSymbol: quote_symbol,
			quoteMint: quote_mint,
		});
		// Keep sol_amount in sync for SOL sells so legacy readers see proceeds too.
		const lamports = quote_symbol === 'SOL' ? quoteAmount : null;
		await sql`
			insert into pump_agent_trades
				(mint_id, user_id, wallet, direction, route, sol_amount, token_amount,
				 quote_mint, quote_symbol, quote_amount, slippage_bps, tx_signature, network)
			values
				(${mintId}, ${user.id}, ${body.wallet_address}, 'sell', ${body.route},
				 ${lamports}, ${body.tokens}, ${quote_mint}, ${quote_symbol}, ${quoteAmount},
				 ${body.slippage_bps ?? null}, ${body.tx_signature}, ${body.network})
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
	// Social links surfaced on the coin page (pump.fun reads twitter/telegram/
	// website; explorers read external_url). Omit any to fall back to the agent
	// profile page (website) and the three.ws X/Telegram.
	twitter: z.string().trim().max(200).optional(),
	website: z.string().trim().max(200).optional(),
	telegram: z.string().trim().max(200).optional(),
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

	const rl = await limits.pumpMetaIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

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

	// ── Resolve image bytes ─────────────────────────────────────────────────
	// We want raw bytes (not just an HTTPS URL) so the image can be pinned to
	// IPFS alongside the metadata — matching pump.fun's native upload flow.
	let imageBuf = null;
	let imageContentType = 'image/png';
	let imageExt = 'png';
	let imageUrl = null; // set directly only when we can't get bytes to pin

	if (body.image_data_url) {
		const commaIdx = body.image_data_url.indexOf(',');
		if (commaIdx === -1) return error(res, 400, 'validation_error', 'invalid image_data_url');
		const meta = body.image_data_url.slice(0, commaIdx);
		const payload = body.image_data_url.slice(commaIdx + 1);
		imageBuf = meta.includes('base64')
			? Buffer.from(payload, 'base64')
			: Buffer.from(decodeURIComponent(payload));
		if (imageBuf.byteLength > 4 * 1024 * 1024) {
			return error(res, 413, 'payload_too_large', 'image must be under 4 MB');
		}
		imageContentType = meta.match(/data:([^;,]+)/)?.[1] || 'image/png';
		imageExt =
			imageContentType.includes('jpeg') || imageContentType.includes('jpg') ? 'jpg' : 'png';
	} else if (body.avatar_id) {
		const [av] = await sql`
			select thumbnail_key from avatars
			where id=${body.avatar_id} and owner_id=${uid} and deleted_at is null limit 1
		`;
		if (av?.thumbnail_key) {
			const thumbUrl = r2PublicUrl(av.thumbnail_key);
			// Fetch the stored thumbnail so it too lands on IPFS; if that fails,
			// fall back to referencing the R2 URL directly (still a valid image).
			try {
				const resp = await fetch(thumbUrl);
				if (resp.ok) {
					imageBuf = Buffer.from(await resp.arrayBuffer());
					imageContentType = resp.headers.get('content-type') || 'image/png';
					imageExt =
						imageContentType.includes('jpeg') || imageContentType.includes('jpg')
							? 'jpg'
							: 'png';
				}
			} catch {
				/* fall through to direct URL */
			}
			if (!imageBuf) imageUrl = thumbUrl;
		}
	}

	// Pin the image (IPFS preferred, R2 fallback) so the metadata references a
	// stable, gateway-resolvable URL.
	if (imageBuf && !imageUrl) {
		const pinnedImage = await pinToIPFS(imageBuf, `image.${imageExt}`).catch(() => null);
		if (pinnedImage) {
			imageUrl = pinnedImage.uri;
		} else {
			const imgKey = `${prefix}/image.${imageExt}`;
			await putObject({ key: imgKey, body: imageBuf, contentType: imageContentType });
			imageUrl = r2PublicUrl(imgKey);
		}
	}

	// ── Build metadata JSON via the canonical three.ws brand builder ─────────
	// This stamps createdOn=https://three.ws plus the Platform/Launchpad
	// attributes that explorers and launchpad aggregators read for attribution.
	const agentHomeUrl = body.agent_id ? `${env.APP_ORIGIN}/agent/${body.agent_id}` : undefined;
	const metadata = buildTokenMetadata({
		name: body.name,
		symbol: body.symbol,
		description: body.description,
		image: imageUrl || '',
		...(agentHomeUrl ? { agentUrl: agentHomeUrl } : {}),
		...(body.twitter ? { twitter: body.twitter } : {}),
		...(body.website ? { website: body.website } : {}),
		...(body.telegram ? { telegram: body.telegram } : {}),
		createdAt: new Date().toISOString(),
	});

	// Pin the metadata JSON (IPFS preferred, R2 fallback).
	const jsonBuf = Buffer.from(JSON.stringify(metadata, null, 2));
	const pinnedJson = await pinToIPFS(jsonBuf, 'metadata.json').catch(() => null);
	let metadataUrl;
	if (pinnedJson) {
		metadataUrl = pinnedJson.uri;
	} else {
		const jsonKey = `${prefix}/metadata.json`;
		await putObject({ key: jsonKey, body: jsonBuf, contentType: 'application/json' });
		metadataUrl = r2PublicUrl(jsonKey);
	}

	return json(res, 200, {
		metadata_url: metadataUrl,
		image_url: imageUrl,
		on_ipfs: Boolean(pinnedJson),
		provider: pinnedJson?.provider ?? (ipfsPinningConfigured() ? 'r2-fallback' : 'r2'),
	});
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
	sdk,
	BN,
	mint,
	creator,
	signer,
	name,
	symbol,
	uri,
	solBuyIn,
	usdcBuyIn,
	quoteMint,
	isMayhem,
}) {
	const LAMPORTS = 1_000_000_000;
	const user = signer || creator;
	const { isLegacyQuoteMint } = await import('@pump-fun/pump-sdk');
	const isUsdcQuote = quoteMint && !isLegacyQuoteMint(quoteMint);

	if (isUsdcQuote) {
		// USDC-paired: use V2 buy path regardless of whether there's an initial buy.
		const hasBuy = usdcBuyIn > 0;
		const global = await sdk.fetchGlobal();
		const pumpSdk = await import('@pump-fun/pump-sdk');
		if (hasBuy) {
			const quoteAmount = new BN(Math.round(usdcBuyIn * 1_000_000));
			// Pass `quoteMint` so the SDK seeds a fresh curve from
			// `initial_virtual_quote_reserves` (USDC) rather than the SOL reserves —
			// otherwise the base-token estimate is priced against the wrong pool and
			// the create+buy can over/under-spend or revert on max_quote_cost.
			const tokenAmount = pumpSdk.getBuyTokenAmountFromSolAmount({
				global,
				feeConfig: null,
				mintSupply: null,
				bondingCurve: null,
				amount: quoteAmount,
				quoteMint,
			});
			const ixs = await sdk.createV2AndBuyV2Instructions({
				global,
				mint,
				name,
				symbol,
				uri,
				creator,
				user,
				quoteAmount,
				amount: tokenAmount,
				mayhemMode: !!isMayhem,
				quoteMint,
			});
			return Array.isArray(ixs) ? [...ixs] : [ixs];
		}
		const ix = await sdk.createV2Instruction({
			mint,
			name,
			symbol,
			uri,
			creator,
			user,
			mayhemMode: !!isMayhem,
			quoteMint,
		});
		return [ix];
	}

	// SOL-paired (original behaviour)
	const hasBuy = solBuyIn > 0;
	if (hasBuy) {
		const global = await sdk.fetchGlobal();
		const solAmount = new BN(Math.floor(solBuyIn * LAMPORTS));
		const pumpSdk = await import('@pump-fun/pump-sdk');
		const tokenAmount = pumpSdk.getBuyTokenAmountFromSolAmount({
			global,
			feeConfig: null,
			mintSupply: null,
			bondingCurve: null,
			amount: solAmount,
		});
		const ixs = await sdk.createV2AndBuyInstructions({
			global,
			mint,
			name,
			symbol,
			uri,
			creator,
			user,
			solAmount,
			amount: tokenAmount,
			mayhemMode: !!isMayhem,
		});
		return Array.isArray(ixs) ? [...ixs] : [ixs];
	}

	const ix = await sdk.createV2Instruction({
		mint,
		name,
		symbol,
		uri,
		creator,
		user,
		mayhemMode: !!isMayhem,
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
		// Bound the metadata URI so name(32)+symbol(10)+uri always fit inside
		// Solana's 1232-byte transaction packet — an unbounded URI is what pushed
		// the create message past the limit and threw "encoding overruns
		// Uint8Array" at sign time. 200 matches pump.fun's own URI ceiling; the
		// 413 guard at sign time remains as a defence-in-depth backstop.
		uri: z.string().url().max(200),
		network: z.enum(['mainnet', 'devnet']).default('mainnet'),
		buyback_bps: z.number().int().min(0).max(10_000).default(0),
		sol_buy_in: z.number().nonnegative().max(50).default(0), // SOL-paired initial buy, capped 50 SOL
		usdc_buy_in: z.number().nonnegative().max(1_000_000).default(0), // USDC-paired initial buy
		// Quote currency for the coin. `quote_currency: 'usdc'` is the friendly
		// form — the server resolves the network-correct USDC mint. `quote_mint`
		// is the explicit form (any non-WSOL mint → stable-paired v2 coin via
		// createV2AndBuyV2Instructions). When neither is set, the coin is
		// SOL-paired (existing behaviour). quote_currency wins when both appear.
		quote_currency: z.enum(['sol', 'usdc']).optional(),
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
		// Optional Launch Copilot attach: a market-maker policy to arm on this coin
		// the moment it's confirmed (the success screen can also attach one after).
		// Validated + safety-gated by api/_lib/market-maker.js at confirm time.
		mm: z
			.object({
				preset: z.enum(['gentle', 'balanced', 'aggressive', 'custom']).optional(),
				mode: z.enum(['simulate', 'live']).optional(),
				enabled: z.boolean().optional(),
				floor_price_sol: z.number().nonnegative().optional(),
				floor_band_pct: z.number().optional(),
				take_profit_band_pct: z.number().optional(),
				recycle_pct: z.number().optional(),
				max_inventory_tokens: z.number().optional(),
				dip_buy_budget_sol: z.number().optional(),
				daily_budget_sol: z.number().optional(),
				seed_sol: z.number().optional(),
				graduation_action: z.enum(['provide_lp', 'hold', 'distribute']).optional(),
				slippage_bps: z.number().optional(),
				max_price_impact_pct: z.number().optional(),
				min_action_interval_seconds: z.number().optional(),
				max_volume_pct: z.number().optional(),
			})
			.optional(),
	})
	.refine((v) => v.agent_id || v.avatar_id, {
		message: 'agent_id or avatar_id required',
		path: ['agent_id'],
	});


async function handleLaunchPrep(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

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
			return error(
				res,
				403,
				'forbidden',
				'creator_address must be a solana wallet linked to your account',
			);
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

	// Mint pubkey: client-supplied (vanity-ground) or server-ground with the three.ws mark.
	const enforceMark = env.THREE_WS_MARK_ENFORCE !== '0' && env.THREE_WS_MARK_ENFORCE !== 'false';
	let mintKeypair = null;
	let mint;

	if (body.mint_address) {
		const supplied = solanaPubkey(body.mint_address);
		if (!supplied) return error(res, 400, 'validation_error', 'invalid mint_address');
		if (enforceMark && !hasThreeWsMark(supplied.toBase58())) {
			return error(
				res,
				400,
				'unbranded_mint',
				'three.ws launches must use a mint address carrying the "3ws" mark — grind one client-side or omit mint_address to let the server stamp it',
			);
		}
		mint = supplied;
	} else if (enforceMark) {
		try {
			const ground = await grindVanityNode({ ...THREE_WS_VANITY }); // ~49k attempts, sub-second
			mintKeypair = Keypair.fromSecretKey(ground.secretKey);
			mint = mintKeypair.publicKey;
			log.info('mint_mark_stamped', {
				publicKey: ground.publicKey,
				attempts: ground.attempts,
				durationMs: Math.round(ground.durationMs),
			});
		} catch (err) {
			if (err instanceof GrindExhaustedError) {
				return error(
					res,
					503,
					'mark_grind_failed',
					'could not stamp the three.ws mark — retry',
				);
			}
			throw err;
		}
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
	const isAgent = body.coin_type === 'agent';
	const effBuyback = isAgent ? body.buyback_bps : 0;

	// Resolve the quote pairing: null → SOL-paired; an explicit mint (e.g. USDC)
	// → stable-paired so the agent's USDC buyback can swap+burn natively. The
	// friendly `quote_currency` ('sol'|'usdc') wins and resolves the
	// network-correct USDC mint; otherwise an explicit `quote_mint` is used.
	const requestedQuoteMint =
		body.quote_currency === 'usdc'
			? usdcMintFor(body.network)
			: body.quote_currency === 'sol'
				? null
				: body.quote_mint;
	const quote = classifyLaunchQuote({ quoteMint: requestedQuoteMint, network: body.network });
	const launchQuoteMint = quote.quoteMint ? solanaPubkey(quote.quoteMint) : null;
	const instructions = await buildLaunchInstructions({
		sdk,
		BN,
		mint,
		creator,
		signer,
		name: body.name,
		symbol: body.symbol,
		uri: body.uri,
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
				wallet_address: body.wallet_address, // signer (pays gas, funds initial buy)
				creator_address: creator.toBase58(), // on-chain creator (royalty recipient)
				mint: mint.toBase58(),
				name: body.name,
				symbol: body.symbol,
				network: body.network,
				buyback_bps: effBuyback,
				coin_type: body.coin_type,
				quote_mint: quote.quoteMint, // null = SOL-paired; else the stable quote mint
				prep_id: prepId,
				mm: body.mm || null, // optional Launch Copilot policy to arm on confirm
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
		mint_secret_key_b64: mintKeypair
			? Buffer.from(mintKeypair.secretKey).toString('base64')
			: null,
		client_supplied_mint: !mintKeypair,
		tx_base64: txBase64,
		network: body.network,
		buyback_bps: effBuyback,
		coin_type: body.coin_type,
		quote_mint: quote.quoteMint,
		quote_currency: quote.label,
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
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(launchConfirmSchema, await readJson(req));

	const [pending] = await sql`
		select id, payload, metadata_uri from agent_registrations_pending
		where user_id=${user.id} and payload->>'prep_id'=${body.prep_id}
		  and expires_at > now()
		order by created_at desc limit 1
	`;
	if (!pending) return error(res, 404, 'not_found', 'prep not found or expired');
	const p = pending.payload;
	if (p.kind !== 'pump_launch') return error(res, 400, 'wrong_kind', 'prep is not a pump launch');
	// metadata_uri lives as a top-level column on the pending row (= launch-prep
	// `uri`), not inside the payload JSON. Thread it through so client-signed
	// launches persist their metadata like the launch-agent path does.
	const metadataUri = pending.metadata_uri || p.metadata_uri || null;

	let tx;
	try {
		tx = await verifySignature({ network: p.network, signature: body.tx_signature });
	} catch (e) {
		return error(res, e.status || 422, e.code || 'tx_failed', e.message);
	}
	const accountKeys = tx.transaction.message.accountKeys.map((k) => (k.pubkey || k).toString());
	if (!accountKeys.includes(p.mint)) {
		return error(res, 422, 'mint_not_in_tx', 'mint pubkey not present in tx');
	}
	// Prove the confirmed tx actually ran the pump.fun program — not just a tx
	// that happens to reference the mint pubkey. Without this, a confirmed memo
	// or transfer touching the new mint account could be recorded as a launch.
	if (!txInvokesPumpProgram(tx)) {
		return error(res, 422, 'not_a_pump_launch', 'transaction did not invoke the pump.fun program');
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
			(agent_id, user_id, network, mint, name, symbol, metadata_uri, agent_authority, buyback_bps, quote_mint)
		values
			(${p.agent_id}, ${user.id}, ${p.network}, ${p.mint},
			 ${p.name}, ${p.symbol}, ${metadataUri}, ${agentAuthority}, ${p.buyback_bps}, ${p.quote_mint ?? null})
		returning id, mint, network, buyback_bps, quote_mint, created_at
	`;

	await sql`delete from agent_registrations_pending where id=${pending.id}`;

	// Launch Copilot: if the launcher armed a market-maker policy at prep time,
	// attach it now from the launch's own agent wallet. Best-effort — a bad policy
	// (e.g. an anti-manipulation cap breach) must never fail the confirmed launch;
	// the owner can fix + arm it from the success screen. The MM trades only
	// through the shared firewall/spend-guard/custody path.
	if (p.mm && p.agent_id) {
		try {
			const { normalizePolicyPatch, upsertPolicy } = await import('../_lib/market-maker.js');
			const patch = normalizePolicyPatch(p.mm, { isCreate: true });
			await upsertPolicy({ mint: p.mint, network: p.network, agentId: p.agent_id, userId: user.id, patch });
		} catch (e) {
			console.warn('[pump/launch-confirm] market-maker attach skipped:', e?.code || e?.message);
		}
	}

	// Surface the confirmed launch on the site-wide live activity ticker.
	publishFeedEvent({
		type: 'coin-buy',
		ts: Date.now(),
		actor: shortAddr(p.wallet_address),
		mint: p.mint,
		sol: 0,
		network: p.network,
		branded: hasThreeWsMark(p.mint),
	}).catch(() => {});

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
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(agentWalletSchema, await readJson(req));

	const agent = await resolveLaunchAgentId({
		userId: user.id,
		agentId: body.agent_id,
		avatarId: body.avatar_id,
	});
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	const loaded = await loadAgentForSigning(agent.id, user.id, {
		reason: 'studio_launch_prepare',
	});
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
		// Bound the metadata URI so name(32)+symbol(10)+uri always fit inside
		// Solana's 1232-byte transaction packet — an unbounded URI is what pushed
		// the create message past the limit and threw "encoding overruns
		// Uint8Array" at sign time. 200 matches pump.fun's own URI ceiling; the
		// 413 guard at sign time remains as a defence-in-depth backstop.
		uri: z.string().url().max(200),
		network: z.enum(['mainnet', 'devnet']).default('mainnet'),
		buyback_bps: z.number().int().min(0).max(10_000).default(0),
		sol_buy_in: z.number().nonnegative().max(50).default(0),
		// USDC-paired agent coins: pass `quote_mint` (the USDC mint) to create a
		// stable-paired curve, and `usdc_buy_in` for an optional USDC dev buy. The
		// agent custodial wallet must hold that USDC (checked in the preflight).
		usdc_buy_in: z.number().nonnegative().max(1_000_000).default(0),
		quote_currency: z.enum(['sol', 'usdc']).optional(),
		quote_mint: z.string().min(32).max(44).optional(),
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
	if (!rl.success) return rateLimited(res, rl);

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

	// Mint keypair: client-supplied (vanity) or server-ground with the three.ws mark.
	// This path signs server-side with the agent custodial wallet, so the server
	// always holds the mint secret — supplied or ground.
	const enforceMark = env.THREE_WS_MARK_ENFORCE !== '0' && env.THREE_WS_MARK_ENFORCE !== 'false';
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
		if (enforceMark && !hasThreeWsMark(mintKeypair.publicKey.toBase58())) {
			return error(
				res,
				400,
				'unbranded_mint',
				'three.ws launches must use a mint carrying the "3ws" mark — omit mint_address to let the server stamp it',
			);
		}
	} else if (enforceMark) {
		try {
			const ground = await grindVanityNode({ ...THREE_WS_VANITY }); // ~49k attempts, sub-second
			mintKeypair = Keypair.fromSecretKey(ground.secretKey);
			log.info('mint_mark_stamped', {
				publicKey: ground.publicKey,
				attempts: ground.attempts,
				durationMs: Math.round(ground.durationMs),
			});
		} catch (err) {
			if (err instanceof GrindExhaustedError) {
				return error(
					res,
					503,
					'mark_grind_failed',
					'could not stamp the three.ws mark — retry',
				);
			}
			throw err;
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

	// Resolve the quote pairing. Agent coins are SOL-paired by default; pass
	// `quote_currency: 'usdc'` (or an explicit `quote_mint`) to launch a
	// stable-paired coin whose USDC buyback swaps natively.
	const requestedQuoteMint =
		body.quote_currency === 'usdc'
			? usdcMintFor(body.network)
			: body.quote_currency === 'sol'
				? null
				: body.quote_mint;
	const quote = classifyLaunchQuote({ quoteMint: requestedQuoteMint, network: body.network });
	const launchQuoteMint = quote.quoteMint ? solanaPubkey(quote.quoteMint) : null;

	// Pre-flight: make sure the agent wallet can afford the launch.
	const conn = solanaConnection(body.network);
	const PUMP_BASE_LAMPORTS = Math.floor(0.022 * LAMPORTS_PER_SOL);
	// SOL always covers rent + fees. A SOL dev buy adds to the requirement; a USDC
	// dev buy is funded from the wallet's USDC balance (checked separately), so it
	// does not add to the SOL requirement.
	const initialBuyLamports = quote.isUsdc
		? 0
		: Math.floor((body.sol_buy_in || 0) * LAMPORTS_PER_SOL);
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

	// USDC dev buy: the custodial wallet must hold the USDC it will spend, or the
	// create+buy reverts on-chain. Verify up front so it fails cleanly here.
	if (quote.isUsdc && body.usdc_buy_in > 0) {
		const needAtomics = BigInt(Math.round(body.usdc_buy_in * 1_000_000));
		let haveAtomics = 0n;
		try {
			const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
			const usdcAta = getAssociatedTokenAddressSync(launchQuoteMint, creator, true);
			const bal = await conn.getTokenAccountBalance(usdcAta);
			haveAtomics = BigInt(bal?.value?.amount ?? 0);
		} catch {
			haveAtomics = 0n; // missing/closed ATA → treat as zero balance
		}
		if (haveAtomics < needAtomics) {
			return error(
				res,
				402,
				'insufficient_usdc',
				`agent wallet holds ${(Number(haveAtomics) / 1e6).toFixed(2)} USDC, needs ${body.usdc_buy_in.toFixed(2)} USDC for the dev buy — deposit USDC to ${creator.toBase58()} or set usdc_buy_in to 0`,
			);
		}
	}

	const { sdk, BN } = await getPumpSdk({ network: body.network });

	const isMayhem = body.coin_type === 'mayhem';
	const isAgent = body.coin_type === 'agent';
	const effBuyback = isAgent ? body.buyback_bps : 0;

	const instructions = await buildLaunchInstructions({
		sdk,
		BN,
		mint,
		creator,
		name: body.name,
		symbol: body.symbol,
		uri: body.uri,
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

	// Spend-policy gate: this path signs server-side with the agent's custodial
	// wallet, so a stolen session could otherwise drive an arbitrarily large SOL
	// dev-buy (up to the schema max) to drain the wallet. Reserve the SOL outflow
	// against the agent's per-tx + rolling-24h caps BEFORE broadcasting — atomic,
	// so concurrent launches can't both pass, and the launch is recorded toward
	// the daily cap. A USDC-paired dev buy moves no SOL (amount 0). Released on
	// send failure, finalized with the signature on success.
	const launchSolOutflow = quote.isUsdc ? 0 : body.sol_buy_in || 0;
	const reservation = await reserveSpend({
		agentId: resolvedAgentId,
		meta: loaded.meta,
		mint: mint.toBase58(),
		solAmount: launchSolOutflow,
		type: 'pumpfun.launch',
		payload: {
			name: body.name,
			symbol: body.symbol,
			network: body.network,
			source: 'studio_agent_wallet',
		},
	});
	if (!reservation.ok) return error(res, reservation.status, reservation.code, reservation.msg);

	let signature;
	try {
		// Protected send: the agent custodial wallet pays + signs, the new mint
		// co-signs. Priority fee + CU estimate, rebroadcast with blockhash refresh,
		// hard throw on an on-chain revert.
		({ signature } = await submitProtected({
			network: body.network,
			connection: conn,
			payer: agentKeypair,
			instructions,
			opts: { extraSigners: [mintKeypair] },
		}));
	} catch (err) {
		await releaseSpend(reservation.reservationId);
		// A message too large for Solana's packet limit now surfaces here (compile
		// happens inside submitProtected) — keep the actionable 413 rather than 502.
		if (/too large|overruns/i.test(err?.message || '')) {
			return error(res, 413, 'launch_payload_too_large', 'token launch transaction exceeds Solana size limits — shorten the token name or metadata URI');
		}
		console.error('[pump/launch-agent] send failed', err);
		return respondError(res, 502, 'rpc_error', err);
	}

	const mintAddr = mint.toBase58();
	const [row] = await sql`
		insert into pump_agent_mints
			(agent_id, user_id, network, mint, name, symbol, metadata_uri, agent_authority, buyback_bps, quote_mint)
		values
			(${resolvedAgentId}, ${user.id}, ${body.network}, ${mintAddr},
			 ${body.name}, ${body.symbol}, ${body.uri}, ${creator.toBase58()}, ${effBuyback}, ${quote.quoteMint ?? null})
		on conflict (mint, network) do nothing
		returning id, mint, network, buyback_bps, quote_mint, created_at
	`;

	// Finalize the spend reservation in place: merge the launch metadata + tx
	// signature into the reserved row and mark it confirmed. This replaces the
	// previous standalone insert — the reserved row already carries `solAmount`
	// (so the launch counts toward the daily cap, which the old `sol_buy_in`-keyed
	// row never did), and reusing it avoids double-recording the launch.
	await finalizeSpend(reservation.reservationId, {
		mint: mintAddr,
		name: body.name,
		symbol: body.symbol,
		uri: body.uri,
		signature,
		network: body.network,
		sol_buy_in: body.sol_buy_in || 0,
		usdc_buy_in: body.usdc_buy_in || 0,
		quote_mint: quote.quoteMint,
		quote_currency: quote.label,
		buyback_bps: effBuyback,
		coin_type: body.coin_type,
		source: 'studio_agent_wallet',
	});

	// Surface the confirmed agent-wallet launch on the site-wide live activity ticker.
	publishFeedEvent({
		type: 'coin-buy',
		ts: Date.now(),
		actor: shortAddr(creator.toBase58()),
		mint: mintAddr,
		sol: body.sol_buy_in || 0,
		network: body.network,
		branded: hasThreeWsMark(mintAddr),
	}).catch(() => {});

	return json(res, 201, {
		ok: true,
		agent_id: resolvedAgentId,
		mint: mintAddr,
		signature,
		network: body.network,
		buyback_bps: effBuyback,
		coin_type: body.coin_type,
		quote_mint: quote.quoteMint,
		quote_currency: quote.label,
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
	user_token_account: z.string().min(32).max(44), // payer ATA
	skill_id: z.string().max(100).optional(),
	tool_name: z.string().max(100).optional(),
	duration_seconds: z
		.number()
		.int()
		.positive()
		.max(60 * 60 * 24 * 365)
		.default(60),
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
	if (!rl.success) return rateLimited(res, rl);

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
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(acceptPaymentConfirmSchema, await readJson(req));
	const [payment] = await sql`
		select p.*, m.mint, m.network from pump_agent_payments p
		join pump_agent_mints m on m.id = p.mint_id
		where p.id=${body.payment_id} limit 1
	`;
	if (!payment) return error(res, 404, 'not_found', 'payment not found');
	if (payment.status === 'confirmed')
		return error(res, 409, 'already_confirmed', 'payment already confirmed');

	// One signature confirms one invoice. Reject a signature already consumed by
	// another payment before doing any on-chain work (the partial unique index
	// pump_agent_payments_tx_signature_unique is the hard backstop).
	const [sigDupe] = await sql`
		select id from pump_agent_payments
		where tx_signature=${body.tx_signature} and status='confirmed' and id != ${payment.id} limit 1
	`;
	if (sigDupe)
		return error(
			res,
			409,
			'tx_already_used',
			'this transaction already confirmed another payment',
		);

	let tx;
	try {
		tx = await verifySignature({ network: payment.network, signature: body.tx_signature });
	} catch (e) {
		await sql`update pump_agent_payments set status='failed' where id=${payment.id}`;
		return error(res, e.status || 422, e.code || 'tx_failed', e.message);
	}

	const accountKeys = tx.transaction.message.accountKeys.map((k) => (k.pubkey || k).toString());
	if (!accountKeys.includes(payment.mint)) {
		return error(res, 422, 'mint_not_in_tx', 'agent mint not in tx accounts');
	}

	// The declared payer must have signed the tx — a signature that didn't
	// involve this payer can't satisfy this invoice.
	const signed = tx.transaction.message.accountKeys.some(
		(k) => (k.pubkey || k).toString() === payment.payer_wallet && k.signer === true,
	);
	if (!signed)
		return error(res, 422, 'payer_not_signer', 'declared payer did not sign the transaction');

	// Verify the agent's payment vault was actually credited the invoiced amount
	// of the invoiced currency. Without this, "the mint pubkey appears in the tx"
	// is not proof of payment — any cheap unrelated tx referencing the mint would
	// pass. The vault is the ATA owned by the TokenAgentPayments PDA for this mint.
	const { agentPda } = await getPumpAgentOffline({
		network: payment.network,
		mint: payment.mint,
	});
	if (!agentPda) {
		return error(
			res,
			503,
			'verification_unavailable',
			'unable to derive agent payment vault for verification',
		);
	}
	const vaultOwner = agentPda.toString();
	const expectedAtomics = BigInt(payment.amount_atomics);
	const post = tx.meta?.postTokenBalances || [];
	const pre = tx.meta?.preTokenBalances || [];
	let credited = 0n;
	for (const p of post) {
		if (p.mint !== payment.currency_mint) continue;
		if (p.owner !== vaultOwner) continue;
		const before = pre.find((b) => b.accountIndex === p.accountIndex);
		const delta =
			BigInt(p.uiTokenAmount?.amount ?? '0') - BigInt(before?.uiTokenAmount?.amount ?? '0');
		if (delta > credited) credited = delta;
	}
	if (credited < expectedAtomics) {
		await sql`update pump_agent_payments set status='failed' where id=${payment.id}`;
		return error(
			res,
			422,
			'amount_not_credited',
			'transaction did not credit the invoiced amount to the agent payment vault',
		);
	}

	try {
		await sql`
			update pump_agent_payments
			set status='confirmed', tx_signature=${body.tx_signature}, confirmed_at=now()
			where id=${payment.id} and status != 'confirmed'
		`;
	} catch (e) {
		if (e?.code === '23505')
			return error(
				res,
				409,
				'tx_already_used',
				'this transaction already confirmed another payment',
			);
		throw e;
	}

	return json(res, 200, {
		ok: true,
		payment_id: payment.id,
		invoice_id: payment.invoice_id,
		tx_signature: body.tx_signature,
	});
}

// ── payments-list ──────────────────────────────────────────────────────────

async function handlePaymentsList(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host}`);
	const mint = url.searchParams.get('mint');
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	const limit = Math.min(Number(url.searchParams.get('limit') || 50), 500);
	const wantsPending = url.searchParams.get('include_pending') === '1';

	// Pending payments expose unconfirmed invoices — require auth.
	if (wantsPending) {
		const auth = await resolveAuth(req);
		if (!auth) return error(res, 401, 'unauthorized', 'sign in required to view pending payments');
	}
	const includePending = wantsPending;

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
				import('@three-ws/agent-payments'),
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

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host}`);
	const agentId = url.searchParams.get('agentId');
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	if (!agentId) return error(res, 400, 'validation_error', 'agentId required');
	if (!isUuid(agentId)) return error(res, 404, 'not_found', 'agent not found');

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

	const [lamports, tokenResp, tradeRows, recentBuys] = await Promise.all([
		conn.getBalance(owner),
		conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
		// Quote-aware cost basis from the trade ledger: net quote spent (buys −
		// sells) per mint, in the quote asset's own atomic units, grouped by quote
		// so SOL and USDC are never summed together.
		sql`
			SELECT pam.mint, t.quote_symbol,
			       COALESCE(SUM(CASE WHEN t.direction='buy'  THEN t.quote_amount ELSE 0 END), 0)::text AS buy_quote,
			       COALESCE(SUM(CASE WHEN t.direction='sell' THEN t.quote_amount ELSE 0 END), 0)::text AS sell_quote
			FROM pump_agent_trades t
			JOIN pump_agent_mints pam ON pam.id = t.mint_id
			WHERE t.wallet = ${address} AND t.network = ${network}
			GROUP BY pam.mint, t.quote_symbol
		`.catch(() => []),
		// Legacy fallback for SOL coins whose buys predate the trade ledger.
		sql`
			SELECT payload FROM agent_actions
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

	// Atomic→UI divisor per quote asset (lamports for SOL, 6-dec for USDC).
	const QUOTE_ATOMS = { SOL: 1e9, USDC: 1e6 };

	// Cost basis + quote asset per mint from the quote-aware trade ledger.
	const basisByMint = new Map(); // mint -> { quoteSymbol, costBasis }
	for (const r of tradeRows) {
		const quoteSymbol = r.quote_symbol || 'SOL';
		const net = BigInt(r.buy_quote || '0') - BigInt(r.sell_quote || '0');
		const div = QUOTE_ATOMS[quoteSymbol] ?? null;
		basisByMint.set(r.mint, {
			quoteSymbol,
			costBasis: div != null ? Number(net) / div : null,
		});
	}
	// Supplement SOL basis from legacy agent_actions only for mints with no ledger
	// rows — keeps historical portfolios intact without double-counting.
	for (const row of recentBuys) {
		const p = row.payload || {};
		if (!p.mint || basisByMint.has(p.mint)) continue;
		const prev = basisByMint.get(p.mint) ?? { quoteSymbol: 'SOL', costBasis: 0 };
		prev.costBasis = (prev.costBasis ?? 0) + (Number(p.amountSol) || 0);
		basisByMint.set(p.mint, prev);
	}

	// Authoritative quote asset for held agent coins not seen in the ledger.
	const unknownMints = holdings.map((h) => h.mint).filter((m) => !basisByMint.has(m));
	const quoteByMint = new Map();
	if (unknownMints.length) {
		const mintRows = await sql`
			SELECT mint, quote_mint FROM pump_agent_mints
			WHERE network = ${network} AND mint = ANY(${unknownMints})
		`.catch(() => []);
		for (const r of mintRows) {
			quoteByMint.set(r.mint, tradeQuoteColumns({ quoteMint: r.quote_mint, network }).quote_symbol);
		}
	}

	// Live price per holding via the read-only pump-fun MCP (parallelized).
	const rt = makeRuntime();
	const priced = await Promise.all(
		holdings.map(async (h) => {
			const curve = await rt
				.invoke('pump-fun.getBondingCurve', { mint: h.mint })
				.catch(() => ({ ok: false }));
			const basis = basisByMint.get(h.mint);
			const quoteSymbol = basis?.quoteSymbol ?? quoteByMint.get(h.mint) ?? 'SOL';
			// A bonding-curve price is quote-per-token in the coin's OWN quote unit
			// (SOL/token for SOL-paired, USDC/token for USDC-paired), so value and
			// cost basis are always expressed in the same currency.
			const priceQuote = curve?.ok ? (curve.data?.priceSol ?? curve.data?.price ?? null) : null;
			const valueQuote = priceQuote != null ? priceQuote * h.amount : null;
			const costBasis = basis?.costBasis ?? null;
			const unrealized =
				valueQuote != null && costBasis != null ? valueQuote - costBasis : null;
			const isSol = quoteSymbol === 'SOL';
			return {
				...h,
				quoteSymbol,
				priceQuote,
				valueQuote,
				costBasis,
				unrealizedPnl: unrealized,
				unrealizedPnlPct:
					unrealized != null && costBasis > 0 ? (unrealized / costBasis) * 100 : null,
				// Backward-compat SOL-named fields, populated only for SOL-paired
				// coins so existing consumers never read a USDC figure as SOL.
				priceSol: isSol ? priceQuote : null,
				valueSol: isSol ? valueQuote : null,
				costBasisSol: isSol ? costBasis : null,
				unrealizedPnlSol: isSol ? unrealized : null,
			};
		}),
	);

	// Per-quote subtotals — the fix for summing mismatched units. Each quote
	// asset (SOL, USDC, …) gets its own value / cost-basis / PnL totals.
	const subtotals = {};
	for (const p of priced) {
		const s = (subtotals[p.quoteSymbol] ??= {
			quoteSymbol: p.quoteSymbol,
			positions: 0,
			value: 0,
			costBasis: 0,
			unrealizedPnl: 0,
			unrealizedPnlPct: null,
		});
		s.positions += 1;
		s.value += p.valueQuote ?? 0;
		s.costBasis += p.costBasis ?? 0;
	}
	for (const s of Object.values(subtotals)) {
		s.unrealizedPnl = s.value - s.costBasis;
		s.unrealizedPnlPct = s.costBasis > 0 ? (s.unrealizedPnl / s.costBasis) * 100 : null;
	}

	// Top-level SOL totals stay backward-compatible — now scoped to SOL-paired
	// holdings only (no cross-unit summing).
	const solSub = subtotals.SOL ?? { value: 0, costBasis: 0 };
	const totalValueSol = solSub.value;
	const totalCostBasisSol = solSub.costBasis;
	const unrealizedPnlSol = totalValueSol - totalCostBasisSol;

	return json(res, 200, {
		data: {
			address,
			network,
			lamports,
			sol: lamports / LAMPORTS_PER_SOL,
			holdings: priced,
			subtotals,
			totalValueSol,
			totalCostBasisSol,
			unrealizedPnlSol,
			unrealizedPnlPct:
				totalCostBasisSol > 0 ? (unrealizedPnlSol / totalCostBasisSol) * 100 : null,
		},
	});
}

// ── launches ─────────────────────────────────────────────────────────────────
// Public, paginated feed of every coin launched through three.ws, joined with
// the agent that launched it. Powers the /launches page and the agent-detail
// "launched coins" card. Anonymous-readable; avatar thumbnails respect the
// same public/unlisted visibility gate as api/agents.js.

const LAUNCHES_CACHE = new Map(); // cacheKey → { at, body }
const LAUNCHES_TTL_MS = 15_000;

async function handleLaunches(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host}`);
	const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit')) || 24), 100);
	const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	const agentId = url.searchParams.get('agent_id');
	if (agentId && !isUuid(agentId))
		return error(res, 400, 'validation_error', 'agent_id must be a uuid');

	const minTierParam = url.searchParams.get('min_tier') || '';

	const cacheKey = `${network}:${agentId || ''}:${minTierParam}:${offset}:${limit}`;
	const now = Date.now();
	const hit = LAUNCHES_CACHE.get(cacheKey);
	if (hit && now - hit.at < LAUNCHES_TTL_MS) {
		res.setHeader('cache-control', 'public, max-age=15');
		return json(res, 200, hit.body);
	}

	// Query + row-shaping lives in api/_lib/pump-agent-launches.js, shared with
	// the free GET /api/v1/pump/launches endpoint — one query, two doors.
	const { launches, has_more: hasMore } = await queryAgentLaunches({
		network,
		agentId,
		minTierParam,
		offset,
		limit,
	});

	const body = { data: { launches, has_more: hasMore, offset, limit, network, min_tier: minTierParam || null } };
	LAUNCHES_CACHE.set(cacheKey, { at: now, body });
	// Keep the per-instance cache bounded — feed pages only ever walk forward.
	if (LAUNCHES_CACHE.size > 200) {
		const oldest = LAUNCHES_CACHE.keys().next().value;
		LAUNCHES_CACHE.delete(oldest);
	}
	res.setHeader('cache-control', 'public, max-age=15');
	return json(res, 200, body);
}

// ── by-agent ───────────────────────────────────────────────────────────────

async function handleByAgent(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host}`);
	const agentId = url.searchParams.get('agent_id');
	const avatarId = url.searchParams.get('avatar_id');
	if (!agentId && !avatarId)
		return error(res, 400, 'validation_error', 'agent_id or avatar_id required');
	if (agentId && !isUuid(agentId)) return error(res, 404, 'not_found', 'agent not found');
	if (avatarId && !isUuid(avatarId)) return error(res, 404, 'not_found', 'agent not found');

	// All coins this agent has launched, newest first. The newest one stays the
	// canonical `data` payload (stats, burns) for existing consumers; the full
	// list ships alongside as `coins` for the agent-page launch history.
	let rows;
	if (agentId) {
		rows = await sql`
			select pam.id, pam.mint, pam.network, pam.name, pam.symbol,
			       pam.buyback_bps, pam.agent_authority, pam.metadata_uri,
			       pam.sharing_config, pam.created_at
			from pump_agent_mints pam
			where pam.agent_id=${agentId}
			order by pam.created_at desc limit 50
		`;
	} else {
		rows = await sql`
			select pam.id, pam.mint, pam.network, pam.name, pam.symbol,
			       pam.buyback_bps, pam.agent_authority, pam.metadata_uri,
			       pam.sharing_config, pam.created_at
			from pump_agent_mints pam
			join agent_identities ai
			  on ai.id = pam.agent_id and ai.deleted_at is null
			where ai.avatar_id=${avatarId}
			order by pam.created_at desc limit 50
		`;
	}
	const [row] = rows;
	if (!row) return json(res, 200, { data: null, coins: [] });
	const coins = rows.map((r) => ({
		mint: r.mint,
		network: r.network,
		name: r.name,
		symbol: r.symbol,
		buyback_bps: r.buyback_bps,
		created_at: r.created_at,
	}));

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
			burns: burnRow || { runs: 0, total_burned: '0' },
			burns_feed: burnsFeed,
		},
		coins,
	});
}

// ── quote ──────────────────────────────────────────────────────────────────

async function handleQuote(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

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
	// AMM SDK pricing takes slippage as a PERCENT (1 = 1%) — pump-trade-args.js.
	const slippagePct = slippagePercentFromBps(slippageBps);

	const mint = solanaPubkey(mintStr);
	if (!mint) return error(res, 400, 'validation_error', 'invalid mint');

	try {
		const { sdk, BN, web3 } = await getPumpSdk({ network });
		const {
			isLegacyQuoteMint,
			getBuyTokenAmountFromSolAmount,
			getSellSolAmountFromTokenAmount,
		} = await import('@pump-fun/pump-sdk');
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
			const feeConfig =
				typeof sdk.fetchFeeConfig === 'function'
					? await sdk.fetchFeeConfig().catch(() => null)
					: null;
			let quote = null;

			if (direction === 'buy') {
				const quoteAmountRaw = isUsdcQuote ? usdcRaw : solRaw;
				if (quoteAmountRaw) {
					const quoteNum = Number(quoteAmountRaw);
					if (!(quoteNum > 0))
						return error(
							res,
							400,
							'validation_error',
							`${isUsdcQuote ? 'usdc' : 'sol'} must be > 0`,
						);
					const atomics = new BN(
						isUsdcQuote
							? Math.round(quoteNum * USDC_DECIMALS)
							: Math.floor(quoteNum * LAMPORTS_PER_SOL_Q),
					);
					const tokens = getBuyTokenAmountFromSolAmount({
						global,
						feeConfig,
						mintSupply: curve.tokenTotalSupply,
						bondingCurve: curve,
						amount: atomics,
					});
					quote = isUsdcQuote
						? {
								usdc_in: quoteNum,
								tokens_out: tokens.toString(),
								source: 'bonding_curve',
							}
						: {
								sol_in: quoteNum,
								tokens_out: tokens.toString(),
								source: 'bonding_curve',
							};
				}
			} else if (direction === 'sell' && tokenRaw) {
				const tokens = new BN(tokenRaw);
				const atomicsOut = getSellSolAmountFromTokenAmount({
					global,
					feeConfig,
					mintSupply: curve.tokenTotalSupply,
					bondingCurve: curve,
					amount: tokens,
				});
				quote = isUsdcQuote
					? {
							tokens_in: tokenRaw,
							usdc_out: Number(atomicsOut.toString()) / USDC_DECIMALS,
							source: 'bonding_curve',
						}
					: {
							tokens_in: tokenRaw,
							sol_out: Number(atomicsOut.toString()) / LAMPORTS_PER_SOL_Q,
							source: 'bonding_curve',
						};
			}

			return json(res, 200, {
				mint: mintStr,
				network,
				graduated: false,
				// SOL curves store quoteMint as PublicKey.default — surface wSOL.
				quote_mint: isUsdcQuote ? quoteMintPk.toString() : WSOL_MINT,
				bonding_curve: {
					real_quote_reserves:
						curve.realQuoteReserves?.toString?.() ??
						curve.realSolReserves?.toString?.() ??
						null,
					real_token_reserves: curve.realTokenReserves?.toString?.() ?? null,
					virtual_quote_reserves:
						curve.virtualQuoteReserves?.toString?.() ??
						curve.virtualSolReserves?.toString?.() ??
						null,
					virtual_token_reserves: curve.virtualTokenReserves?.toString?.() ?? null,
					complete: curve.complete ?? false,
				},
				platform_fee_bps: await effectivePumpFeeBps(),
				quote,
			});
		}

		// Post-graduation: canonical AMM pool. For USDC pairs use the quote-keyed PDA.
		let amm;
		try {
			amm = await getAmmPoolState({
				network,
				mint,
				quoteMint: isUsdcQuote ? quoteMintPk : null,
			});
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

		const {
			pool,
			poolKey,
			baseReserve,
			quoteReserve,
			baseMintAccount,
			globalConfig,
			feeConfig,
		} = amm;
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
				if (!(quoteNum > 0))
					return error(
						res,
						400,
						'validation_error',
						`${resolvedIsUsdc ? 'usdc' : 'sol'} must be > 0`,
					);
				const atomics = new BN(Math.round(quoteNum * QUOTE_UNIT));
				const r = ammSdk.buyQuoteInput({
					quote: atomics,
					slippage: slippagePct,
					baseReserve,
					quoteReserve,
					globalConfig,
					baseMintAccount,
					baseMint: pool.baseMint,
					coinCreator: pool.coinCreator,
					creator: pool.creator,
					feeConfig,
				});
				// buyQuoteInput is a quote-input swap: slippage widens the max quote
				// spend (maxQuote), not a token floor — surface that real bound.
				const maxQuoteIn =
					r.maxQuote != null ? Number(r.maxQuote.toString()) / QUOTE_UNIT : null;
				quote = {
					...(resolvedIsUsdc ? { usdc_in: quoteNum } : { sol_in: quoteNum }),
					tokens_out: r.base?.toString?.() ?? null,
					...(resolvedIsUsdc ? { max_usdc_in: maxQuoteIn } : { max_sol_in: maxQuoteIn }),
					slippage_bps: slippageBps,
					source: 'amm',
				};
			}
		} else if (direction === 'sell' && tokenRaw) {
			const tokens = new BN(tokenRaw);
			const r = ammSdk.sellBaseInput({
				base: tokens,
				slippage: slippagePct,
				baseReserve,
				quoteReserve,
				globalConfig,
				baseMintAccount,
				baseMint: pool.baseMint,
				coinCreator: pool.coinCreator,
				creator: pool.creator,
				feeConfig,
			});
			const atomicsOut = r.uiQuote ?? r.minQuote;
			const minAtomicsOut = r.minQuote ?? r.uiQuote;
			const toUnit = (v) => (v != null ? Number(v.toString()) / QUOTE_UNIT : null);
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
			platform_fee_bps: await effectivePumpFeeBps(),
			quote,
		});
	} catch (err) {
		return respondError(res, err.status || 502, err.code || 'pump_sdk_error', err);
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
	if (!rl.success) return rateLimited(res, rl);

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
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(withdrawPrepSchema, await readJson(req));
	const authority = solanaPubkey(body.authority_wallet);
	const receiverAta = solanaPubkey(body.receiver_ata);
	if (!authority || !receiverAta) return error(res, 400, 'validation_error', 'invalid pubkeys');

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
	if (!rl.success) return rateLimited(res, rl);

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
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req);
	if (!body?.strategy) return error(res, 400, 'validation_error', 'strategy required');
	const network = body.network === 'devnet' ? 'devnet' : 'mainnet';

	const rt = makeRuntime();

	// Reject a semantically-broken spec up front with field-level issues, before
	// sourcing mints or replaying — same validator the validate endpoint uses.
	const vr = await rt.invoke('pump-fun-strategy.validateStrategy', {
		strategy: body.strategy,
		network,
		mintInfo: await resolveStrategyMintInfo(body.strategy?.scan?.mints, network),
	});
	if (vr.data && !vr.data.valid) {
		return error(res, 400, 'validation_error', vr.error || 'strategy is invalid', {
			issues: vr.data.issues,
			report: vr.data,
		});
	}

	let mints;
	try {
		mints = await resolveStrategyMints(rt.invoke, body.strategy, body.mints, body.limit);
	} catch (e) {
		return respondError(res, 502, 'upstream_error', e);
	}
	if (!mints.length) return error(res, 422, 'no_candidates', 'no mints to backtest');

	const { backtestStrategy } =
		await import('../../examples/skills/pump-fun-strategy/handlers.js');
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
	if (!rl.success) return rateLimited(res, rl);

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

	const { closeAllPositions } =
		await import('../../examples/skills/pump-fun-strategy/handlers.js');
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
	if (!enc)
		throw Object.assign(
			new Error('agent has no solana wallet — provision via /api/agents/:id/solana'),
			{ status: 409 },
		);
	const wallet = await loadWallet(enc);
	return { wallet, address: wallet.publicKey.toBase58(), meta: row.meta };
}

async function handleStrategyRun(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try {
		body = await readJson(req);
	} catch (e) {
		return error(res, 400, 'validation_error', e.message);
	}

	if (!body?.strategy) return error(res, 400, 'validation_error', 'strategy required');
	const durationSec = Math.max(5, Math.min(600, Number(body.durationSec) || 30));
	const mode = body.mode === 'live' ? 'live' : 'simulate';
	const network = body.network === 'devnet' ? 'devnet' : 'mainnet';

	// Pre-flight semantic validation BEFORE switching to SSE, so a broken spec
	// (or a quote-asset mismatch on a listed coin) is rejected with a clean JSON
	// error rather than streaming a doomed run. Same validator the validate
	// endpoint and the runner use — they cannot disagree.
	{
		const mintInfo = await resolveStrategyMintInfo(body.strategy?.scan?.mints, network);
		const vr = await makeRuntime().invoke('pump-fun-strategy.validateStrategy', {
			strategy: body.strategy,
			network,
			mintInfo,
		});
		if (vr.data && !vr.data.valid) {
			return error(res, 400, 'validation_error', vr.error || 'strategy is invalid', {
				issues: vr.data.issues,
				report: vr.data,
			});
		}
	}

	let wallet = null,
		walletAddress = null,
		agentMeta = null;
	if (mode === 'live') {
		const auth = await resolveAuth(req);
		if (!auth) return error(res, 401, 'unauthorized', 'sign in required for live mode');
		if (!body.agentId)
			return error(res, 400, 'validation_error', 'agentId required for live mode');
		try {
			const r = await loadAgentWalletForStrategy(body.agentId, auth.userId);
			wallet = r.wallet;
			walletAddress = r.address;
			agentMeta = r.meta;
		} catch (e) {
			return error(
				res,
				e.status ?? 500,
				e.status === 409 ? 'conflict' : 'unauthorized',
				e.message,
			);
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
	req.on('close', () => {
		aborted = true;
	});

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

	const policyGuard =
		mode === 'live'
			? async ({ mint, amountSol }) => {
					const block = await checkBuyAllowed({
						agentId: body.agentId,
						meta: agentMeta,
						mint,
						solAmount: amountSol,
					});
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
				onLog: (entry) => {
					if (!aborted) send('log', entry);
				},
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
	if (!rl.success) return rateLimited(res, rl);

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

	// EventSource auto-reconnects when the stream ends; hint a 1s backoff so the
	// rotation below is near-seamless rather than the browser's ~3s default.
	res.write('retry: 1000\n\n');

	const ping = setInterval(() => {
		if (!res.writableEnded) res.write(': ping\n\n');
	}, 15_000);

	// Rotate the stream a few seconds BEFORE the Vercel function maxDuration
	// (60s — see vercel.json → functions["api/pump/[action].js"]). Ending the
	// response ourselves emits a clean `end` event and lets EventSource
	// reconnect; letting Vercel hit the hard limit instead kills the function
	// and logs a "Task timed out" error on every long-lived client connection.
	const STREAM_BUDGET_MS = 55_000;
	const maxDuration = setTimeout(() => {
		clearInterval(ping);
		stop?.();
		if (!res.writableEnded) {
			res.write(`event: end\ndata: ${JSON.stringify({ reason: 'rotate' })}\n\n`);
			res.end();
		}
	}, STREAM_BUDGET_MS);

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

// Resolve authoritative agent-coin facts (existence + quote pairing) for the
// mints a strategy explicitly lists. pump_agent_mints is the only place a
// three.ws coin's quote asset is reliably known (the on-chain bonding curve
// read does not surface it). Returns a map keyed by mint, or null on DB error
// (the handler then falls back to an on-chain existence probe).
async function resolveStrategyMintInfo(mints, network) {
	const listed = Array.isArray(mints)
		? [...new Set(mints.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim()))]
		: [];
	if (!listed.length) return null;
	try {
		const rows = await sql`
			SELECT mint, quote_mint FROM pump_agent_mints
			WHERE mint = ANY(${listed}) AND network = ${network}
		`;
		const info = {};
		for (const row of rows) {
			const q = classifyLaunchQuote({ quoteMint: row.quote_mint, network });
			info[row.mint] = { isAgentCoin: true, quoteIsUsdc: q.isUsdc, quoteSymbol: q.label };
		}
		return info;
	} catch (e) {
		console.error('[strategy-validate] mint info lookup failed', e?.message);
		return null;
	}
}

async function handleStrategyValidate(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req);
	if (!body?.strategy || typeof body.strategy !== 'object') {
		return error(res, 400, 'validation_error', 'strategy required');
	}
	const network = body.network === 'devnet' ? 'devnet' : 'mainnet';

	const mintInfo = await resolveStrategyMintInfo(body.strategy?.scan?.mints, network);

	const rt = makeRuntime();
	const r = await rt.invoke('pump-fun-strategy.validateStrategy', {
		strategy: body.strategy,
		network,
		mintInfo,
	});
	const report = r.data ?? {
		valid: false,
		issues: [{ level: 'error', field: 'strategy', code: 'validate_failed', message: r.error || 'validation failed' }],
		errorCount: 1,
		warningCount: 0,
	};
	if (!report.valid) {
		return error(res, 400, 'validation_error', r.error || 'strategy is invalid', {
			issues: report.issues,
			report,
		});
	}
	return json(res, 200, { data: report });
}

// ── channel-feed ──────────────────────────────────────────────────────────────

async function handleChannelFeed(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	const url = new URL(req.url, `http://${req.headers.host}`);
	const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') || 50)), 200);
	const kinds = url.searchParams.get('kinds') || null;
	const { getMints, getWhales, getClaims } = await import('../_lib/channel-feed-sources.js');
	const { buildFeed } = await import('../../src/pump/channel-feed.js');
	const [mints, whales, claims] = await Promise.all([
		getMints(limit),
		getWhales(limit),
		getClaims(limit),
	]);
	const items = buildFeed(
		[
			{ kind: 'mint', items: mints },
			{ kind: 'whale', items: whales },
			{ kind: 'claim', items: claims },
		],
		{ limit, kinds },
	);
	return json(res, 200, { items });
}

// ── trending / search (proxies for the CORS-protected pump.fun frontend API) ──

const PUMP_FRONTEND_BASE = 'https://frontend-api-v3.pump.fun';
const TRENDING_CACHE = { at: 0, body: null };
const TRENDING_TTL_MS = 15_000;

// pump.fun hands back image URLs on the retired cf-ipfs.com gateway, which no
// longer resolves in the browser. Repair the image fields onto a working
// gateway before the feed reaches any client (play lobby, home card, etc.).
function repairCoinImages(coins) {
	if (!Array.isArray(coins)) return coins;
	for (const c of coins) {
		if (!c || typeof c !== 'object') continue;
		if (c.image_uri) c.image_uri = normalizeGatewayURL(c.image_uri);
		if (c.image) c.image = normalizeGatewayURL(c.image);
		if (c.metadata_uri) c.metadata_uri = normalizeGatewayURL(c.metadata_uri);
	}
	return coins;
}

async function handleTrending(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
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
	let resp;
	try {
		resp = await fetch(upstream, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(8000),
		});
	} catch {
		// Upstream timeout/network blip: serve the last good list if we have one
		// rather than 500-ing the trending feed.
		if (TRENDING_CACHE.body) {
			res.setHeader('cache-control', 'public, max-age=15');
			return json(res, 200, TRENDING_CACHE.body);
		}
		return error(res, 504, 'upstream_timeout', 'pump.fun did not respond');
	}
	if (!resp.ok) return error(res, 502, 'upstream_failed', `pump.fun returned ${resp.status}`);
	// pump.fun can answer 200 with an empty/truncated body; resp.json() then throws
	// "Unexpected end of JSON input" → an unhandled 500. Fall back to the last good
	// list (or an empty feed) instead of crashing.
	let body;
	try {
		body = await resp.json();
	} catch {
		if (TRENDING_CACHE.body) {
			res.setHeader('cache-control', 'public, max-age=15');
			return json(res, 200, TRENDING_CACHE.body);
		}
		body = [];
	}
	const arr = repairCoinImages(
		Array.isArray(body) ? body : Array.isArray(body?.coins) ? body.coins : [],
	);
	TRENDING_CACHE.at = now;
	TRENDING_CACHE.body = arr;
	res.setHeader('cache-control', 'public, max-age=15');
	return json(res, 200, arr);
}

// ── coin ─────────────────────────────────────────────────────────────────────
// Live metadata for a single mint, proxied from pump.fun's frontend API
// (CORS-protected from the browser). Powers the /play lobby's pinned flagship
// town so its name/symbol/art/market-cap are always real and current, even when
// the coin isn't in the trending 30. Short-cached per mint to spare the upstream.

const COIN_CACHE = new Map(); // mint → { at, body }
const COIN_TTL_MS = 30_000;

async function handleCoin(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	const url = new URL(req.url, `http://${req.headers.host}`);
	const mint = (url.searchParams.get('mint') || '').trim();
	if (!MINT_RE.test(mint))
		return error(res, 400, 'invalid_mint', 'mint must be a base58 address');

	const now = Date.now();
	const hit = COIN_CACHE.get(mint);
	if (hit && now - hit.at < COIN_TTL_MS) {
		res.setHeader('cache-control', 'public, max-age=15');
		return json(res, 200, hit.body);
	}

	let resp;
	try {
		resp = await fetch(new URL(`/coins/${mint}`, PUMP_FRONTEND_BASE), {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(8000),
		});
	} catch {
		return error(res, 504, 'upstream_timeout', 'pump.fun did not respond');
	}
	if (!resp.ok) return error(res, 502, 'upstream_failed', `pump.fun returned ${resp.status}`);
	// pump.fun returns 200 with an empty body for an unknown/unmigrated mint;
	// resp.json() then throws "Unexpected end of JSON input" → an unhandled 500.
	// Treat an empty/invalid body as "coin not found" (404) instead.
	let parsed;
	try {
		parsed = await resp.json();
	} catch {
		return error(res, 404, 'coin_not_found', 'no pump.fun coin for that mint');
	}
	if (!parsed || typeof parsed !== 'object') {
		return error(res, 404, 'coin_not_found', 'no pump.fun coin for that mint');
	}
	const [body] = repairCoinImages([parsed]);
	COIN_CACHE.set(mint, { at: now, body });
	res.setHeader('cache-control', 'public, max-age=15');
	return json(res, 200, body);
}

// ── coin-trades ────────────────────────────────────────────────────────────
// Recent buy/sell trades for a single mint, proxied from pump.fun's swap API
// (CORS-protected from the browser). Powers the homepage live token card's
// green/red flow. Covers both bonding-curve and migrated (AMM) trades.

const PUMP_SWAP_BASE = 'https://swap-api.pump.fun';
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function handleCoinTrades(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	const url = new URL(req.url, `http://${req.headers.host}`);
	const mint = (url.searchParams.get('mint') || '').trim();
	if (!MINT_RE.test(mint))
		return error(res, 400, 'invalid_mint', 'mint must be a base58 address');
	const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') || 30)), 100);
	const upstream = `${PUMP_SWAP_BASE}/v2/coins/${mint}/trades?limit=${limit}`;
	// "Recent trades" is a soft, continuously-polled feed (the homepage live card
	// re-fetches every ~4s). A transient pump.fun swap-API blip means "no new data
	// right now", not a hard error — so degrade to an empty 200 with `no-store`
	// rather than a 5xx the browser console logs on every poll. The next poll
	// retries immediately and the card recovers the moment upstream is back.
	const stale = (extra = {}) => {
		res.setHeader('cache-control', 'no-store');
		return json(res, 200, { mint, trades: [], stale: true, ...extra });
	};
	let resp;
	try {
		resp = await fetch(upstream, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(8000),
		});
	} catch {
		return stale({ reason: 'upstream_timeout' });
	}
	if (!resp.ok) return stale({ reason: `upstream_${resp.status}` });
	let body;
	try {
		body = await resp.json();
	} catch {
		return stale({ reason: 'upstream_unparseable' });
	}
	const raw = Array.isArray(body) ? body : Array.isArray(body?.trades) ? body.trades : [];
	const trades = raw
		.map((t) => {
			const solAmount = Number(t.amountSol);
			const usdAmount = t.amountUsd != null ? Number(t.amountUsd) : null;
			// pump.fun v2 USDC-paired coins report the quote spend on amountQuote/
			// amountUsdc rather than amountSol. Surface whichever quote the upstream
			// used (with a stable symbol) so USDC trades are no longer silently
			// dropped by a SOL-only filter or shown as a misleading 0 SOL.
			const usdcRaw = t.amountQuote ?? t.amountUsdc ?? null;
			const isUsdcQuote = usdcRaw != null && (!isFinite(solAmount) || solAmount === 0);
			const quoteSymbol = isUsdcQuote ? 'USDC' : 'SOL';
			const quoteAmount = isUsdcQuote
				? Number(usdcRaw)
				: isFinite(solAmount)
					? solAmount
					: null;
			return {
				tx: t.tx,
				timestamp: t.timestamp,
				user: t.userAddress || t.user || null,
				is_buy: String(t.type).toLowerCase() === 'buy',
				sol_amount: isFinite(solAmount) ? solAmount : null,
				quote_symbol: quoteSymbol,
				quote_amount: quoteAmount,
				usd_amount: usdAmount,
				price_usd: t.priceUsd != null ? Number(t.priceUsd) : null,
			};
		})
		.filter(
			(t) =>
				t.tx &&
				((t.quote_amount != null && t.quote_amount > 0) ||
					(t.usd_amount != null && t.usd_amount > 0)),
		);
	res.setHeader('cache-control', 'public, max-age=3');
	return json(res, 200, { mint, trades });
}

async function handleSearch(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
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
	let resp;
	try {
		resp = await fetch(upstream, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(8000),
		});
	} catch {
		// Upstream timeout/network blip — an empty result set beats a 500 on search.
		return json(res, 200, []);
	}
	if (!resp.ok) return error(res, 502, 'upstream_failed', `pump.fun returned ${resp.status}`);
	// A 200 with an empty/truncated body makes resp.json() throw; degrade to "no
	// results" rather than an unhandled 500.
	let body;
	try {
		body = await resp.json();
	} catch {
		body = [];
	}
	const arr = repairCoinImages(
		Array.isArray(body) ? body : Array.isArray(body?.coins) ? body.coins : [],
	);
	return json(res, 200, arr);
}

// ── deliver-telegram ──────────────────────────────────────────────────────────

import { z as _z } from 'zod';
const _deliverSchema = _z.object({
	chatId: _z.union([_z.string(), _z.number()]),
	signal: _z.object({
		kind: _z.enum(['mint', 'whale', 'claim', 'graduation']),
		mint: _z.string(),
		summary: _z.string(),
		refs: _z.array(_z.string()).optional(),
		ts: _z.number().optional(),
	}),
});

async function handleDeliverTelegram(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
	const botToken = process.env.TELEGRAM_BOT_TOKEN;
	if (!botToken) return error(res, 500, 'misconfigured', 'TELEGRAM_BOT_TOKEN is not set');
	const raw = await readJson(req);
	const { chatId, signal } = parse(_deliverSchema, raw);
	const { sendTelegramSignal } = await import('../../src/pump/telegram-delivery.js');
	const result = await sendTelegramSignal({ botToken, chatId, signal });
	return json(res, 200, result);
}

// ── first-claims ──────────────────────────────────────────────────────────────

import { scanFirstClaims } from '../_lib/pump-claims.js';

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
	if (!rl.success) return rateLimited(res, rl);
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
	if (!rl.success) return rateLimited(res, rl);
	const url = new URL(req.url, 'http://x');
	const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 50));
	let sinceTs;
	if (url.searchParams.has('sinceTs')) {
		sinceTs = Number(url.searchParams.get('sinceTs'));
	} else {
		const sinceMinutes = Math.max(
			1,
			Math.min(1440, Number(url.searchParams.get('sinceMinutes')) || 60),
		);
		sinceTs = Math.floor(Date.now() / 1000) - sinceMinutes * 60;
	}
	if (!Number.isFinite(sinceTs) || sinceTs <= 0)
		return error(res, 400, 'validation_error', 'invalid sinceTs');
	const items = await scanFirstClaims({ sinceTs, limit });
	return json(res, 200, { items });
}


// ── vanity-keygen (SSE) ───────────────────────────────────────────────────────

async function handleVanityKeygen(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (req.method !== 'POST') {
		res.setHeader('allow', 'POST');
		return error(res, 405, 'method_not_allowed', 'method POST required');
	}
	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	let body;
	try {
		body = await readJson(req);
	} catch (e) {
		return error(res, e.status || 400, 'bad_request', e.message);
	}
	const { suffix = '', prefix = '', caseSensitive = false, maxAttempts = 5_000_000 } = body || {};
	if (!suffix && !prefix)
		return error(res, 400, 'validation_error', 'at least one of suffix or prefix is required');
	res.statusCode = 200;
	res.setHeader('content-type', 'text/event-stream; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	res.setHeader('connection', 'keep-alive');
	res.setHeader('x-accel-buffering', 'no');
	const ac = new AbortController();
	const timeout = setTimeout(() => {
		ac.abort();
		_sse(res, 'error', {
			error: 'request_timeout',
			error_description: 'vanity search exceeded 60 s limit',
		});
		res.statusCode = 408;
		res.end();
	}, 60_000);
	req.on('close', () => ac.abort());
	const progressInterval = setInterval(() => {
		if (ac.signal.aborted) return clearInterval(progressInterval);
		_sse(res, 'progress', { elapsed: Date.now() });
	}, 2_000);
	try {
		const { generateVanityKey } = await import('../../src/pump/vanity-keygen.js');
		const _bs58 = (await import('bs58')).default;
		const result = await generateVanityKey({
			suffix,
			prefix,
			caseSensitive,
			maxAttempts,
			signal: ac.signal,
		});
		clearTimeout(timeout);
		clearInterval(progressInterval);
		if (!result)
			_sse(res, 'error', {
				error: 'max_attempts_reached',
				error_description: `no match found in ${maxAttempts} attempts`,
			});
		else
			_sse(res, 'result', {
				publicKey: result.publicKey,
				secretKey: _bs58.encode(result.secretKey),
				attempts: result.attempts,
				ms: result.ms,
			});
	} catch (err) {
		clearTimeout(timeout);
		clearInterval(progressInterval);
		if (!res.writableEnded)
			_sse(res, 'error', {
				error: 'internal_error',
				error_description: err.message || 'unexpected error',
			});
	} finally {
		if (!res.writableEnded) res.end();
	}
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
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(collectCreatorFeePrepSchema, await readJson(req));
	const creatorPk = solanaPubkey(body.creator_address);
	const feePayer = solanaPubkey(body.wallet_address);
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
		return error(
			res,
			e.status || 502,
			e.code || 'pump_sdk_error',
			e.message || 'failed to build collect-creator-fee tx',
		);
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
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(distributeCreatorFeesPrepSchema, await readJson(req));
	const mintPk = solanaPubkey(body.mint);
	const payerPk = solanaPubkey(body.wallet_address);
	if (!mintPk || !payerPk) return error(res, 400, 'validation_error', 'invalid pubkeys');

	try {
		const { connection } = await getPumpSdk({ network: body.network });
		const { OnlinePumpSdk } = await import('@pump-fun/pump-sdk');
		const onlineSdk = new OnlinePumpSdk(connection);
		const { instructions, isGraduated } =
			await onlineSdk.buildDistributeCreatorFeesInstructions(mintPk);
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
		return error(
			res,
			e.status || 502,
			e.code || 'pump_sdk_error',
			e.message || 'failed to build distribute-creator-fees tx',
		);
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
	// Optional — when omitted the handler decodes the current set from the
	// on-chain sharing_config so the client never has to track it.
	current_shareholders: z.array(z.string().min(32).max(44)).min(1).max(10).optional(),
	new_shareholders: z
		.array(
			z.object({
				address: z.string().min(32).max(44),
				share_bps: z.number().int().min(1).max(10_000),
			}),
		)
		.min(1)
		.max(10)
		.refine((arr) => arr.reduce((s, x) => s + x.share_bps, 0) === 10_000, {
			message: 'share_bps must sum to 10000',
		})
		.refine((arr) => new Set(arr.map((x) => x.address)).size === arr.length, {
			message: 'duplicate shareholder addresses',
		}),
});

async function handleUpdateFeeSharesPrep(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(updateFeeSharesSchema, await readJson(req));
	const mintPk = solanaPubkey(body.mint);
	const payerPk = solanaPubkey(body.wallet_address);
	if (!mintPk || !payerPk) return error(res, 400, 'validation_error', 'invalid pubkeys');

	const guard = await assertCoinNotOwnedByOther({
		userId: user.id,
		mint: body.mint,
		network: body.network,
		res,
	});
	if (guard.blocked) return;

	const newShareholders = body.new_shareholders.map((s) => {
		const addr = solanaPubkey(s.address);
		if (!addr)
			throw Object.assign(new Error(`invalid shareholder ${s.address}`), {
				status: 400,
				code: 'validation_error',
			});
		return { address: addr, shareBps: s.share_bps };
	});

	try {
		const { sdk, connection } = await getPumpSdk({ network: body.network });

		// Current shareholders: trust the client list when supplied, otherwise
		// decode them from the on-chain sharing_config so callers don't have to
		// track on-chain state themselves.
		let currentShareholders;
		if (body.current_shareholders?.length) {
			currentShareholders = body.current_shareholders.map((s) => {
				const pk = solanaPubkey(s);
				if (!pk)
					throw Object.assign(new Error(`invalid current shareholder ${s}`), {
						status: 400,
						code: 'validation_error',
					});
				return pk;
			});
		} else {
			const { feeSharingConfigPda } = await import('@pump-fun/pump-sdk');
			const cfgInfo = await connection.getAccountInfo(feeSharingConfigPda(mintPk));
			if (!cfgInfo) {
				return error(
					res,
					409,
					'no_sharing_config',
					'no fee-sharing config for this coin — create one first via create-fee-sharing-prep',
				);
			}
			const cfg = sdk.decodeSharingConfig(cfgInfo);
			currentShareholders = cfg.shareholders.map((s) => new PublicKey(s.address));
		}

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
		return error(
			res,
			e.status || 502,
			e.code || 'pump_sdk_error',
			e.message || 'failed to build update-fee-shares tx',
		);
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
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(createFeeSharingPrepSchema, await readJson(req));
	const mintPk = solanaPubkey(body.mint);
	const creatorPk = solanaPubkey(body.creator_address);
	const payerPk = solanaPubkey(body.wallet_address);
	if (!mintPk || !creatorPk || !payerPk)
		return error(res, 400, 'validation_error', 'invalid pubkeys');

	const guard = await assertCoinNotOwnedByOther({
		userId: user.id,
		mint: body.mint,
		network: body.network,
		res,
	});
	if (guard.blocked) return;

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

		const ix = await sdk.createFeeSharingConfig({
			creator: creatorPk,
			mint: mintPk,
			pool: poolPk,
		});
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
		return error(
			res,
			e.status || 502,
			e.code || 'pump_sdk_error',
			e.message || 'failed to build create-fee-sharing tx',
		);
	}
}

// Soft ownership guard for connected-wallet fee/delegation actions. If this mint
// was launched through three.ws (a pump_agent_mints row exists), it must belong
// to the session user — this stops one account building fee txs against another
// account's coin. Coins launched outside three.ws have no row and are allowed
// (the on-chain sharing-config admin signature is the real gate either way).
async function assertCoinNotOwnedByOther({ userId, mint, network, res }) {
	const [row] = await sql`
		select id, user_id from pump_agent_mints
		where mint=${mint} and network=${network}
		limit 1
	`;
	if (row && row.user_id !== userId) {
		error(res, 403, 'forbidden', 'this coin belongs to another account');
		return { blocked: true };
	}
	return { blocked: false, row: row || null };
}

// pump.fun social platform ids (matches the SDK's Platform enum):
//   Pump = 0, X = 1, GitHub = 2
const SOCIAL_PLATFORM_ID = { pump: 0, x: 1, github: 2 };

// ── resolve-github-shareholder ─────────────────────────────────────────────
// Turns a GitHub identity into a concrete fee-share recipient address so the
// delegation UI never has to know the mapping. If the GitHub user is on
// three.ws (linked via the existing GitHub OAuth) and has a linked Solana
// wallet, we return that wallet — a fully-claimable shareholder paid by the
// permissionless distribute crank. Otherwise we return the pump.fun social-fee
// escrow PDA for their numeric id; fees can be routed into it, but the final
// claim is brokered by pump.fun's own app (we don't hold the social-claim
// authority), so we flag claimable_now:false and explain.

const resolveGithubShareholderSchema = z
	.object({
		// Platform is now general: 'github' (default) or 'x' (Twitter). The
		// github_* fields are kept for back-compat; `username`/`user_id` are the
		// platform-agnostic inputs the fees panel and Launch Studio use.
		platform: z.enum(['github', 'x']).default('github'),
		username: z.string().trim().min(1).max(40).optional(),
		user_id: z.string().trim().regex(/^\d{1,20}$/).optional(),
		github_username: z.string().trim().min(1).max(40).optional(),
		github_user_id: z.string().trim().regex(/^\d{1,20}$/).optional(),
		network: z.enum(['mainnet', 'devnet']).default('mainnet'),
	})
	.refine((b) => b.username || b.user_id || b.github_username || b.github_user_id, {
		message: 'a username or numeric user id is required',
	});

async function handleResolveGithubShareholder(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(resolveGithubShareholderSchema, await readJson(req));

	// One source of truth for social → reward resolution (github + x), shared with
	// the launch use-case engine and the fees panel.
	const r = await resolveSocialReward({
		platform: body.platform,
		username: body.username || body.github_username,
		userId: body.user_id || body.github_user_id,
		network: body.network,
	});
	return json(res, 200, {
		platform: r.platform,
		mode: r.mode,
		address: r.address,
		username: r.username,
		user_id: r.user_id,
		// Back-compat aliases for existing github callers.
		github_username: r.platform === 'github' ? r.username : undefined,
		github_user_id: r.platform === 'github' ? r.user_id : undefined,
		claimable_now: r.claimable_now,
		note: r.note,
	});
}


// ── create-social-fee-pda-prep ─────────────────────────────────────────────
// Initialises the pump.fun social-fee escrow PDA for a (social_user_id,
// platform) pair so a subsequent update-fee-shares-prep can name it as a
// shareholder address. Idempotent on-chain (no-op if it already exists). The
// returned tx is signed by the connected wallet (the coin admin/payer).

const createSocialFeePdaPrepSchema = z.object({
	wallet_address: z.string().min(32).max(44), // payer / signer
	social_user_id: z.string().trim().min(1).max(20), // numeric social id (SDK caps at 20 chars)
	platform: z.enum(['github', 'x', 'pump']).default('github'),
	mint: z.string().min(32).max(44).optional(), // when set, enforces coin ownership
	network: z.enum(['mainnet', 'devnet']).default('mainnet'),
});

async function handleCreateSocialFeePdaPrep(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(createSocialFeePdaPrepSchema, await readJson(req));
	const payerPk = solanaPubkey(body.wallet_address);
	if (!payerPk) return error(res, 400, 'validation_error', 'invalid wallet_address');

	if (body.mint) {
		const guard = await assertCoinNotOwnedByOther({
			userId: user.id,
			mint: body.mint,
			network: body.network,
			res,
		});
		if (guard.blocked) return;
	}

	const platform = SOCIAL_PLATFORM_ID[body.platform];

	try {
		const { sdk } = await getPumpSdk({ network: body.network });
		const { socialFeePda } = await import('@pump-fun/pump-sdk');
		const ix = await sdk.createSocialFeePda({
			payer: payerPk,
			userId: body.social_user_id,
			platform,
		});
		const tx_base64 = await buildUnsignedTxBase64({
			network: body.network,
			payer: payerPk,
			instructions: Array.isArray(ix) ? ix : [ix],
		});
		return json(res, 201, {
			social_fee_pda: socialFeePda(body.social_user_id, platform).toBase58(),
			platform: body.platform,
			social_user_id: body.social_user_id,
			network: body.network,
			tx_base64,
		});
	} catch (e) {
		return error(
			res,
			e.status || 502,
			e.code || 'pump_sdk_error',
			e.message || 'failed to build create-social-fee-pda tx',
		);
	}
}
// ── fee-info ───────────────────────────────────────────────────────────────
// Read-only resolver: given a mint, report where creator fees go (cashback,
// sharing-config shareholders, or direct creator), the claimable vault balance
// (pump native vault + AMM WSOL vault), graduation status, and the on-chain
// sharing-config shareholders if one exists. Mirrors the coin-fees skill's
// fetch-fee-info.mjs so the studio shows real, on-chain numbers — no estimates.
// Public read (rate-limited) so anyone can inspect a coin's fee posture before
// claiming a delegated share.

const MIN_RENT_EXEMPTION_LAMPORTS = 890_880n;

async function handleFeeInfo(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host}`);
	const mintStr = url.searchParams.get('mint');
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	const mintPk = solanaPubkey(mintStr);
	if (!mintPk) return error(res, 400, 'validation_error', 'valid mint required');

	try {
		const connection = getConnection({ network });
		const [
			{ PumpSdk, OnlinePumpSdk, canonicalPumpPoolPda, creatorVaultPda, feeSharingConfigPda },
			{ OnlinePumpAmmSdk, coinCreatorVaultAuthorityPda, coinCreatorVaultAtaPda },
			{ AccountLayout, NATIVE_MINT, TOKEN_PROGRAM_ID },
		] = await Promise.all([
			import('@pump-fun/pump-sdk'),
			import('@pump-fun/pump-swap-sdk'),
			import('@solana/spl-token'),
		]);

		const onlineSdk = new OnlinePumpSdk(connection);
		const offlineSdk = new PumpSdk();
		const bondingCurve = await onlineSdk.fetchBondingCurve(mintPk).catch(() => null);
		if (!bondingCurve) return error(res, 404, 'not_found', 'no bonding curve for this mint');

		const poolPda = canonicalPumpPoolPda(mintPk);
		const poolInfo = await connection.getAccountInfo(poolPda);
		let isGraduated = false;
		let poolCoinCreator = null;
		let isCashbackCoin = false;

		if (poolInfo) {
			isGraduated = true;
			try {
				const pool = await new OnlinePumpAmmSdk(connection).fetchPool(poolPda);
				poolCoinCreator = pool.coinCreator;
				isCashbackCoin =
					pool.isCashbackCoin === true ||
					(Array.isArray(pool.is_cashback_coin) && pool.is_cashback_coin[0] === true);
			} catch {
				/* pool not fully initialized */
			}
		} else {
			isCashbackCoin =
				bondingCurve.isCashbackCoin === true ||
				(Array.isArray(bondingCurve.is_cashback_coin) &&
					bondingCurve.is_cashback_coin[0] === true);
		}

		const effectiveCreator = poolCoinCreator ?? new PublicKey(bondingCurve.creator);

		let hasSharingConfig = false;
		let sharingConfig = null;
		if (!isCashbackCoin) {
			// When a creator migrates to a fee-sharing config, the on-chain creator
			// field (pool.coinCreator / bondingCurve.creator) becomes the config PDA.
			const cfgPda = feeSharingConfigPda(mintPk);
			hasSharingConfig = effectiveCreator.equals(cfgPda);
			if (hasSharingConfig) {
				const cfgInfo = await connection.getAccountInfo(cfgPda);
				if (cfgInfo) {
					const cfg = offlineSdk.decodeSharingConfig(cfgInfo);
					sharingConfig = {
						address: cfgPda.toBase58(),
						admin: cfg.admin.toBase58(),
						admin_revoked: cfg.adminRevoked ?? false,
						shareholders: cfg.shareholders.map((s) => ({
							address: s.address.toBase58(),
							bps: Number(s.shareBps),
						})),
					};
				} else {
					hasSharingConfig = false;
				}
			}
		}

		// Vault balance = pump native creator vault (minus rent) + AMM WSOL vault.
		// When a sharing config exists, fees accrue under the config PDA.
		let claimableLamports = 0n;
		if (!isCashbackCoin) {
			const vaultCreator = hasSharingConfig ? feeSharingConfigPda(mintPk) : effectiveCreator;
			const nativeVault = creatorVaultPda(vaultCreator);
			const nativeInfo = await connection.getAccountInfo(nativeVault);
			if (nativeInfo) {
				const adjusted = BigInt(nativeInfo.lamports) - MIN_RENT_EXEMPTION_LAMPORTS;
				if (adjusted > 0n) claimableLamports += adjusted;
			}
			try {
				const ammAuthority = coinCreatorVaultAuthorityPda(vaultCreator);
				const ammAta = coinCreatorVaultAtaPda(ammAuthority, NATIVE_MINT, TOKEN_PROGRAM_ID);
				const ammInfo = await connection.getAccountInfo(ammAta);
				if (ammInfo) {
					const parsed = AccountLayout.decode(
						new Uint8Array(
							ammInfo.data.buffer,
							ammInfo.data.byteOffset,
							ammInfo.data.byteLength,
						),
					);
					claimableLamports += BigInt(parsed.amount.toString());
				}
			} catch {
				/* no AMM vault yet */
			}
		}

		const feeDestination = isCashbackCoin
			? 'cashback'
			: hasSharingConfig
				? 'sharing_config'
				: 'creator';

		return json(res, 200, {
			mint: mintPk.toBase58(),
			network,
			is_graduated: isGraduated,
			is_cashback_coin: isCashbackCoin,
			has_sharing_config: hasSharingConfig,
			creator: effectiveCreator.toBase58(),
			claimable_lamports: claimableLamports.toString(),
			claimable_sol: Number(claimableLamports) / LAMPORTS_PER_SOL,
			fee_destination: feeDestination,
			sharing_config: sharingConfig,
		});
	} catch (e) {
		return error(
			res,
			e.status || 502,
			e.code || 'pump_sdk_error',
			e.message || 'failed to read fee info',
		);
	}
}

// Build a v0 transaction from `instructions`, sign with the agent keypair (and
// any extra signers), send, and confirm. Mirrors the launch-agent send path so
// every server-signed pump action uses the same RPC handling.
async function signSendWithAgent({ network, agentKeypair, instructions, extraSigners = [] }) {
	const conn = solanaConnection(network);
	// Protected send: priority fee + CU estimate, rebroadcast with blockhash
	// refresh, hard throw on an on-chain revert.
	const { signature } = await submitProtected({
		network,
		connection: conn,
		payer: agentKeypair,
		instructions,
		opts: { extraSigners },
	});
	return signature;
}

// Resolve the agent + mint the caller controls, and assert the agent's custodial
// wallet is the on-chain creator (agent_authority) of the coin. Returns
// { agent, mintRow, loaded, creator } or sends an error and returns null.
async function resolveAgentFeeContext(req, res, body) {
	const user = await getSessionUser(req);
	if (!user) {
		error(res, 401, 'unauthorized', 'sign in required');
		return null;
	}

	const agent = await resolveLaunchAgentId({
		userId: user.id,
		agentId: body.agent_id,
		avatarId: body.avatar_id,
	});
	if (!agent) {
		error(res, 404, 'not_found', 'agent not found');
		return null;
	}

	const [mintRow] = await sql`
		select id, mint, network, agent_authority, sharing_config
		from pump_agent_mints
		where agent_id=${agent.id} and mint=${body.mint} and network=${body.network}
		limit 1
	`;
	if (!mintRow) {
		error(res, 404, 'not_found', 'coin not found for this agent');
		return null;
	}

	const loaded = await loadAgentForSigning(agent.id, user.id, {
		reason: 'studio_fee_action',
		meta: { mint: body.mint, network: body.network },
	});
	if (loaded.error) {
		error(res, loaded.error.status, loaded.error.code, loaded.error.msg);
		return null;
	}

	const creator = loaded.keypair.publicKey.toBase58();
	if (mintRow.agent_authority && mintRow.agent_authority !== creator) {
		error(
			res,
			409,
			'creator_mismatch',
			'this coin was launched from a connected wallet — claim with that wallet instead of the agent wallet',
		);
		return null;
	}
	return { user, agent, mintRow, loaded, creator };
}

// ── collect-creator-fee-agent ──────────────────────────────────────────────
// Server-signs the creator-fee collection with the agent custodial wallet. Use
// for coins launched from the agent wallet (agent_authority == agent wallet).

const collectFeeAgentSchema = z
	.object({
		agent_id: z.string().uuid().optional(),
		avatar_id: z.string().uuid().optional(),
		mint: z.string().min(32).max(44),
		network: z.enum(['mainnet', 'devnet']).default('mainnet'),
	})
	.refine((b) => b.agent_id || b.avatar_id, { message: 'agent_id or avatar_id required' });

async function handleCollectCreatorFeeAgent(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(collectFeeAgentSchema, await readJson(req));
	const ctx = await resolveAgentFeeContext(req, res, body);
	if (!ctx) return;

	try {
		const { connection } = await getPumpSdk({ network: body.network });
		const { OnlinePumpSdk } = await import('@pump-fun/pump-sdk');
		const onlineSdk = new OnlinePumpSdk(connection);
		const creatorPk = ctx.loaded.keypair.publicKey;
		// Snapshot the creator's SOL before the sweep so we can report the exact
		// lamports the claim delivered (net of tx fee) — callers (the launcher
		// claimer, the studio) need the real figure, not a boolean.
		const balanceBefore = await connection.getBalance(creatorPk).catch(() => null);
		const ixs = await onlineSdk.collectCoinCreatorFeeInstructions(creatorPk, creatorPk);
		const signature = await signSendWithAgent({
			network: body.network,
			agentKeypair: ctx.loaded.keypair,
			instructions: Array.isArray(ixs) ? ixs : [ixs],
		});
		const balanceAfter = balanceBefore == null ? null : await connection.getBalance(creatorPk).catch(() => null);
		const lamports = balanceBefore != null && balanceAfter != null ? Math.max(0, balanceAfter - balanceBefore) : null;
		await sql`
			insert into agent_actions (agent_id, type, payload, source_skill)
			values (${ctx.agent.id}, ${'pumpfun.collect_creator_fee'},
				${JSON.stringify({ mint: body.mint, network: body.network, signature, lamports, source: 'studio_agent_wallet' })}::jsonb,
				${'pumpfun'})
		`.catch((e) => console.error('[pump/collect-creator-fee-agent] log failed', e?.message));
		return json(res, 201, {
			ok: true,
			mint: body.mint,
			network: body.network,
			signature,
			lamports,
			sol: lamports == null ? null : lamports / LAMPORTS_PER_SOL,
			explorer: `https://solscan.io/tx/${signature}${body.network === 'devnet' ? '?cluster=devnet' : ''}`,
		});
	} catch (e) {
		return respondError(res, e.status || 502, e.code || 'rpc_error', e);
	}
}

// ── distribute-creator-fees-agent ──────────────────────────────────────────
// Server-signs distribution of shared fees to the sharing-config shareholders,
// paid by the agent custodial wallet. Distribution is permissionless on-chain;
// this lets the agent wallet crank it without a connected wallet.

async function handleDistributeCreatorFeesAgent(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(collectFeeAgentSchema, await readJson(req));
	const ctx = await resolveAgentFeeContext(req, res, body);
	if (!ctx) return;

	try {
		const { connection } = await getPumpSdk({ network: body.network });
		const { OnlinePumpSdk } = await import('@pump-fun/pump-sdk');
		const onlineSdk = new OnlinePumpSdk(connection);
		const { instructions } = await onlineSdk.buildDistributeCreatorFeesInstructions(
			new PublicKey(body.mint),
		);
		const signature = await signSendWithAgent({
			network: body.network,
			agentKeypair: ctx.loaded.keypair,
			instructions,
		});
		await sql`
			insert into agent_actions (agent_id, type, payload, source_skill)
			values (${ctx.agent.id}, ${'pumpfun.distribute_creator_fees'},
				${JSON.stringify({ mint: body.mint, network: body.network, signature, source: 'studio_agent_wallet' })}::jsonb,
				${'pumpfun'})
		`.catch((e) => console.error('[pump/distribute-creator-fees-agent] log failed', e?.message));
		return json(res, 201, {
			ok: true,
			mint: body.mint,
			network: body.network,
			signature,
			explorer: `https://solscan.io/tx/${signature}${body.network === 'devnet' ? '?cluster=devnet' : ''}`,
		});
	} catch (e) {
		return respondError(res, e.status || 502, e.code || 'rpc_error', e);
	}
}

// ── fee-sharing-agent ──────────────────────────────────────────────────────
// Server-signs the full delegation lifecycle with the agent custodial wallet:
// creates the sharing config if absent, then sets the shareholder split. This
// is the on-chain mechanism behind "reward" coins — creator fees are split to a
// list of delegated wallets (e.g. GitHub contributors) who can each claim their
// share via distribute. Shares are basis points and must sum to 10000.

const feeSharingAgentSchema = z
	.object({
		agent_id: z.string().uuid().optional(),
		avatar_id: z.string().uuid().optional(),
		mint: z.string().min(32).max(44),
		network: z.enum(['mainnet', 'devnet']).default('mainnet'),
		shareholders: z
			.array(
				z.object({
					address: z.string().min(32).max(44),
					share_bps: z.number().int().min(1).max(10_000),
				}),
			)
			.min(1)
			.max(10)
			.refine((arr) => arr.reduce((s, x) => s + x.share_bps, 0) === 10_000, {
				message: 'share_bps must sum to 10000',
			})
			.refine((arr) => new Set(arr.map((x) => x.address)).size === arr.length, {
				message: 'duplicate shareholder addresses',
			}),
	})
	.refine((b) => b.agent_id || b.avatar_id, { message: 'agent_id or avatar_id required' });

async function handleFeeSharingAgent(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(feeSharingAgentSchema, await readJson(req));
	const ctx = await resolveAgentFeeContext(req, res, body);
	if (!ctx) return;

	const newShareholders = body.shareholders.map((s) => {
		const pk = solanaPubkey(s.address);
		if (!pk)
			throw Object.assign(new Error(`invalid shareholder ${s.address}`), {
				status: 400,
				code: 'validation_error',
			});
		return { address: pk, shareBps: s.share_bps };
	});

	try {
		const { sdk, connection } = await getPumpSdk({ network: body.network });
		const [
			{ feeSharingConfigPda, bondingCurvePda },
			{ canonicalPumpPoolPda },
			{ isLegacyQuoteMint },
		] = await Promise.all([
			import('@pump-fun/pump-sdk'),
			import('@pump-fun/pump-swap-sdk'),
			getPumpSdkV2({ network: body.network }),
		]);

		const mintPk = new PublicKey(body.mint);
		const creator = ctx.loaded.keypair.publicKey;

		// The sharing-config account existing on-chain means the split has already
		// been initialized — skip creation and go straight to updating shares.
		const cfgPda = feeSharingConfigPda(mintPk);
		const cfgInfo = await connection.getAccountInfo(cfgPda);
		const configExists = !!cfgInfo;

		const signatures = [];

		// Step 1 — create the config if it doesn't exist yet. A fresh config seeds
		// the creator as the sole shareholder at 10000 bps.
		if (!configExists) {
			const bcInfo = await connection.getAccountInfo(bondingCurvePda(mintPk));
			const bc = bcInfo ? sdk.decodeBondingCurve(bcInfo) : null;
			const poolPk =
				bc && bc.quoteMint && !isLegacyQuoteMint(bc.quoteMint)
					? canonicalPumpPoolPda(mintPk, bc.quoteMint)
					: canonicalPumpPoolPda(mintPk);
			const createIx = await sdk.createFeeSharingConfig({
				creator,
				mint: mintPk,
				pool: poolPk,
			});
			signatures.push(
				await signSendWithAgent({
					network: body.network,
					agentKeypair: ctx.loaded.keypair,
					instructions: [createIx],
				}),
			);
		}

		// Step 2 — set the shareholder split. Right after creation the current set
		// is [creator] at 10000 bps; otherwise it's whatever the cached config holds.
		const cached = Array.isArray(ctx.mintRow.sharing_config?.shareholders)
			? ctx.mintRow.sharing_config.shareholders
			: null;
		const currentShareholders =
			configExists && cached?.length
				? cached.map((s) => new PublicKey(s.address))
				: [creator];
		const updateIx = await sdk.updateFeeShares({
			authority: creator,
			mint: mintPk,
			currentShareholders,
			newShareholders,
		});
		signatures.push(
			await signSendWithAgent({
				network: body.network,
				agentKeypair: ctx.loaded.keypair,
				instructions: [updateIx],
			}),
		);

		// Cache the split so the next update knows the current shareholder set and
		// the UI reflects delegation immediately. On-chain fee-info remains the
		// source of truth.
		const sharingConfig = {
			address: cfgPda.toBase58(),
			admin: creator,
			shareholders: body.shareholders.map((s) => ({ address: s.address, bps: s.share_bps })),
			updated_at: new Date().toISOString(),
		};
		await sql`
			update pump_agent_mints set sharing_config=${JSON.stringify(sharingConfig)}::jsonb
			where id=${ctx.mintRow.id}
		`;
		await sql`
			insert into agent_actions (agent_id, type, payload, source_skill)
			values (${ctx.agent.id}, ${'pumpfun.set_fee_sharing'},
				${JSON.stringify({ mint: body.mint, network: body.network, shareholders: sharingConfig.shareholders, signatures, source: 'studio_agent_wallet' })}::jsonb,
				${'pumpfun'})
		`.catch((e) => console.error('[pump/fee-sharing-agent] log failed', e?.message));

		return json(res, 201, {
			ok: true,
			mint: body.mint,
			network: body.network,
			created: !configExists,
			signatures,
			sharing_config: sharingConfig,
			explorer: `https://solscan.io/tx/${signatures[signatures.length - 1]}${body.network === 'devnet' ? '?cluster=devnet' : ''}`,
		});
	} catch (e) {
		return error(
			res,
			e.status || 502,
			e.code || 'rpc_error',
			e.message || 'fee sharing failed',
		);
	}
}

// ── github-resolve ─────────────────────────────────────────────────────────
// Validate a GitHub handle and return its public profile + numeric id. The
// numeric id is what pump.fun's social-fee program keys on (platform=2), and
// the avatar/profile let the launch UI confirm "rewards → @handle" before the
// user delegates fees. Read-only; best-effort (GitHub rate-limits unauthed IPs
// at 60/hr — set GITHUB_TOKEN to raise that).

async function handleGithubResolve(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host}`);
	const handle = (url.searchParams.get('handle') || '').replace(/^@/, '').trim();
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(handle)) {
		return error(res, 400, 'validation_error', 'invalid github handle');
	}

	try {
		const headers = { 'user-agent': 'three.ws', accept: 'application/vnd.github+json' };
		if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
		const gh = await fetch(`https://api.github.com/users/${encodeURIComponent(handle)}`, {
			headers,
			signal: AbortSignal.timeout(8000),
		});
		if (gh.status === 404)
			return error(res, 404, 'github_user_not_found', `@${handle} not found on GitHub`);
		if (gh.status === 403)
			return error(res, 429, 'github_rate_limited', 'GitHub rate limit — try again shortly');
		if (!gh.ok) return error(res, 502, 'github_error', `github responded ${gh.status}`);
		const j = await gh.json();
		if (!j?.id) return error(res, 502, 'github_error', 'github id missing');
		return json(res, 200, {
			ok: true,
			login: j.login,
			id: String(j.id), // social-fee user_id (≤20 chars, fits u64)
			name: j.name || null,
			avatar_url: j.avatar_url || null,
			html_url: j.html_url || `https://github.com/${j.login}`,
			type: j.type || 'User',
		});
	} catch (e) {
		return respondError(res, 502, 'github_error', e);
	}
}

// Read pump.fun's global FeeProgramGlobal account and decode the single field we
// need — `social_claim_authority` — the only signer allowed to release social
// (GitHub/X) fee claims. We surface it so the UI can be honest that claiming
// native social rewards is gated by pump.fun, not self-custodial. No exported
// decoder exists for FeeProgramGlobal, so we slice the known layout:
//   [8 disc][1 bump][32 authority][1 disable_flags][32 social_claim_authority]…
async function readSocialClaimAuthority(connection) {
	try {
		const { FEE_PROGRAM_GLOBAL_PDA } = await import('@pump-fun/pump-sdk');
		const info = await connection.getAccountInfo(FEE_PROGRAM_GLOBAL_PDA);
		if (!info?.data || info.data.length < 8 + 1 + 32 + 1 + 32) return null;
		const off = 8 + 1 + 32 + 1;
		return new PublicKey(info.data.subarray(off, off + 32)).toBase58();
	} catch {
		return null;
	}
}

// ── social-fee-claim-status ────────────────────────────────────────────────
// Read-only view of a GitHub/X identity's pump.fun social-fee PDA: how much has
// accrued and been claimed, and the gated deep-link to claim it. We CANNOT build
// a claim tx ourselves — claim_social_fee_pda requires pump.fun's global
// `social_claim_authority` to co-sign — so this endpoint is read + deep-link.
// Self-custodial "reward" delegation is the fee-sharing split (see
// fee-sharing-agent / update-fee-shares-prep), which IS claimable directly.

async function handleSocialFeeClaimStatus(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host}`);
	const userId = (url.searchParams.get('user_id') || '').trim();
	const platform = Number(url.searchParams.get('platform') ?? '2'); // 0=pump 1=X 2=GitHub
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	if (!/^\d{1,20}$/.test(userId))
		return error(res, 400, 'validation_error', 'numeric user_id required');
	if (![0, 1, 2].includes(platform))
		return error(res, 400, 'validation_error', 'platform must be 0,1,2');

	try {
		const connection = getConnection({ network });
		const { socialFeePda, PUMP_SDK } = await import('@pump-fun/pump-sdk');
		const pda = socialFeePda(userId, platform);
		const info = await connection.getAccountInfo(pda);

		let decoded = null;
		let claimableLamports = 0n;
		if (info) {
			claimableLamports = BigInt(info.lamports) - MIN_RENT_EXEMPTION_LAMPORTS;
			if (claimableLamports < 0n) claimableLamports = 0n;
			try {
				const d = PUMP_SDK.decodeSocialFeePda(info);
				decoded = {
					user_id: d.userId,
					platform: Number(d.platform),
					total_claimed_lamports: d.totalClaimed?.toString?.() ?? '0',
					last_claimed: d.lastClaimed?.toString?.() ?? '0',
				};
			} catch {
				/* layout drift — still return the balance */
			}
		}

		const social_claim_authority = await readSocialClaimAuthority(connection);
		return json(res, 200, {
			user_id: userId,
			platform,
			network,
			social_fee_pda: pda.toBase58(),
			exists: !!info,
			claimable_lamports: claimableLamports.toString(),
			claimable_sol: Number(claimableLamports) / LAMPORTS_PER_SOL,
			decoded,
			// Claiming is gated: only pump.fun's social_claim_authority can sign.
			gated: true,
			social_claim_authority,
			claim_url: 'https://pump.fun/profile',
		});
	} catch (e) {
		return error(
			res,
			e.status || 502,
			e.code || 'pump_sdk_error',
			e.message || 'failed to read social fee status',
		);
	}
}

function _sse(res, event, data) {
	res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
