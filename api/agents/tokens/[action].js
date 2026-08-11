/**
 * Agent Tokens Dispatcher
 * -----------------------
 * GET    /api/agents/tokens/plan          read the agent's saved launch plan
 * PUT    /api/agents/tokens/plan          save it (owner only)
 * DELETE /api/agents/tokens/plan          discard an unlaunched plan (owner only)
 * POST   /api/agents/tokens/plan-dry-run  compile + simulate the plan, no broadcast
 * POST   /api/agents/tokens/launch-prep
 * POST   /api/agents/tokens/launch-confirm
 * GET    /api/agents/tokens/launch-quote
 *
 * Single Vercel function that dispatches on req.query.action (auto-populated
 * from the [action] filename). Consolidated to reduce function count and
 * avoid bundling the heavy Pump.fun/Solana SDKs three times.
 *
 * The plan is the agent's token identity before it exists on chain: one saved,
 * editable configuration per (agent, network) that launch-prep reads instead of
 * re-collecting, that the profile renders while the coin is still unlaunched,
 * and that launch-confirm flips to 'launched' with the real mint. The rules live
 * in api/_lib/agent-token-plan.js; only the HTTP shell is here.
 */

import { z } from 'zod';
import { solanaConnection } from '../../_lib/solana/connection.js';
import { createHash } from 'crypto';

import { sql } from '../../_lib/db.js';
import { getSessionUser, isSameSiteOrigin } from '../../_lib/auth.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { parse } from '../../_lib/validate.js';
import { randomToken } from '../../_lib/crypto.js';
import { env } from '../../_lib/env.js';
import { r2, publicUrl } from '../../_lib/r2.js';
import { buildTokenMetadata, agentHomeUrl } from '../../_lib/three-brand.js';
import { usdcMintFor } from '../../_lib/pump-quote.js';
import {
	getPlan,
	upsertPlan,
	deletePlan,
	recordDryRun,
	markPlanLaunched,
	shapePlan,
	planReadiness,
	estimateLaunchCost,
	normalizePlanInput,
	FIXED_LAUNCH_COST_SOL,
	FIXED_LAUNCH_TOTAL_SOL,
	PLAN_LIMITS,
} from '../../_lib/agent-token-plan.js';

// Heavy SDKs (Solana web3, Pump.fun, AWS S3 commands) are dynamic-imported
// inside the handlers that need them. Loading them at module top-level was
// pushing the function over Vercel's cold-start budget and producing
// FUNCTION_INVOCATION_FAILED on every invocation, including launch-quote
// which doesn't even touch them when initial_buy_sol=0.
async function loadSolanaWeb3() {
	return import('@solana/web3.js');
}
async function loadPumpSdk() {
	const [pump, BNmod] = await Promise.all([
		import('@pump-fun/pump-sdk'),
		import('bn.js').then((m) => m.default || m),
	]);
	return { ...pump, BN: BNmod };
}
async function loadS3Commands() {
	return import('@aws-sdk/client-s3');
}

function rpcUrl(cluster) {
	return cluster === 'devnet'
		? process.env.SOLANA_RPC_URL_DEVNET || 'https://api.devnet.solana.com'
		: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
}

export default wrap(async (req, res) => {
	const action = req.query?.action;
	switch (action) {
		case 'plan':
			return handlePlan(req, res);
		case 'plan-dry-run':
			return handlePlanDryRun(req, res);
		case 'launch-prep':
			return handleLaunchPrep(req, res);
		case 'launch-confirm':
			return handleLaunchConfirm(req, res);
		case 'launch-quote':
			return handleLaunchQuote(req, res);
		default:
			return error(res, 404, 'not_found', 'unknown tokens action');
	}
});

// ── plan ─────────────────────────────────────────────────────────────────────
//
// The launch configuration bound to the agent record. One plan per (agent,
// network). Reads are public for a plan the owner has finished ('ready') or
// already launched — an agent announcing the coin it is about to become is a
// product feature, and the launch history that follows renders from the same
// object. Drafts stay private to the owner: an unfinished ticker is not an
// announcement.

/**
 * Load an agent and decide whether the caller owns it. Returns null when the
 * agent does not exist or is deleted, so callers answer a single 404 for both.
 *
 * @returns {Promise<{ agent: object, isOwner: boolean, userId: string|null }|null>}
 */
async function loadAgentForPlan(req, agentId) {
	if (!agentId) return null;
	const [agent] = await sql`
		select id, name, user_id, wallet_address, meta
		from agent_identities
		where id = ${agentId} and deleted_at is null
		limit 1
	`;
	if (!agent) return null;
	const user = await getSessionUser(req);
	return { agent, isOwner: !!user && agent.user_id === user.id, userId: user?.id || null };
}

/** The Solana address a launch from this agent would pay and sign from. */
function agentLaunchWallet(agent) {
	const onchain = agent?.meta?.onchain;
	if (onchain?.family === 'solana' && onchain.wallet) return onchain.wallet;
	return agent?.meta?.solana_address || agent?.wallet_address || null;
}

const planSaveSchema = z.object({
	agent_id: z.string().uuid(),
	network: z.enum(['mainnet', 'devnet']).default('mainnet'),
	name: z.string().trim().max(PLAN_LIMITS.nameMax).default(''),
	symbol: z.string().trim().max(PLAN_LIMITS.symbolMax).default(''),
	description: z.string().trim().max(PLAN_LIMITS.descriptionMax).default(''),
	image_url: z.string().trim().max(500).default(''),
	website: z.string().trim().max(500).default(''),
	twitter: z.string().trim().max(500).default(''),
	telegram: z.string().trim().max(500).default(''),
	coin_type: z.enum(['regular', 'mayhem', 'agent']).default('agent'),
	quote_currency: z.enum(['sol', 'usdc']).default('sol'),
	buyback_bps: z.coerce.number().int().min(0).max(PLAN_LIMITS.buybackBpsMax).default(0),
	sol_buy_in: z.coerce.number().min(0).max(PLAN_LIMITS.solBuyInMax).default(0),
	usdc_buy_in: z.coerce.number().min(0).max(PLAN_LIMITS.usdcBuyInMax).default(0),
});

async function handlePlan(req, res) {
	if (cors(req, res, { methods: 'GET,PUT,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'PUT', 'DELETE'])) return;

	if (req.method === 'GET') return handlePlanRead(req, res);

	// Writes ride the session cookie, so a cross-site POST must never reach them.
	if (!isSameSiteOrigin(req)) return error(res, 403, 'forbidden', 'cross-site request blocked');

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	if (req.method === 'DELETE') {
		const url = new URL(req.url, 'http://x');
		const agentId = url.searchParams.get('agent_id') || '';
		const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
		const loaded = await loadAgentForPlan(req, agentId);
		if (!loaded) return error(res, 404, 'not_found', 'agent not found');
		if (!loaded.isOwner) return error(res, 403, 'forbidden', 'only the agent owner can edit its token plan');
		const removed = await deletePlan({ agentId, network });
		if (!removed) {
			return error(res, 409, 'conflict', 'no editable plan on this network — a launched plan is permanent');
		}
		return json(res, 200, { ok: true, agent_id: agentId, network, plan: null });
	}

	const body = parse(planSaveSchema, await readJson(req));
	const loaded = await loadAgentForPlan(req, body.agent_id);
	if (!loaded) return error(res, 404, 'not_found', 'agent not found');
	if (!loaded.isOwner) return error(res, 403, 'forbidden', 'only the agent owner can edit its token plan');

	const { locked, row } = await upsertPlan({ agentId: body.agent_id, userId: user.id, input: body });
	if (locked) {
		return error(
			res,
			409,
			'conflict',
			'this agent already launched its token on this network — the plan that minted it is permanent',
		);
	}
	return json(res, 200, { ok: true, plan: shapePlan(row), is_owner: true });
}

async function handlePlanRead(req, res) {
	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const agentId = url.searchParams.get('agent_id') || '';
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	if (!agentId) return error(res, 400, 'validation_error', 'agent_id is required');

	const loaded = await loadAgentForPlan(req, agentId);
	if (!loaded) return error(res, 404, 'not_found', 'agent not found');

	const row = await getPlan({ agentId, network });
	// A draft is the owner's private workbench; visitors see it as "no plan yet".
	const visible = row && (loaded.isOwner || row.status !== 'draft') ? row : null;

	return json(
		res,
		200,
		{
			agent_id: agentId,
			network,
			is_owner: loaded.isOwner,
			launch_wallet: loaded.isOwner ? agentLaunchWallet(loaded.agent) : null,
			plan: shapePlan(visible),
		},
		// Ownership changes the body, so this must never land in a shared cache.
		{ 'cache-control': 'private, no-store' },
	);
}

// ── plan-dry-run ─────────────────────────────────────────────────────────────
//
// The free proof path. It builds the SAME pump.fun create instructions the real
// launch builds from the SAME saved plan, compiles them into a real transaction
// against a real blockhash, and simulates that transaction on the cluster. It
// never signs and never broadcasts, so it costs nothing and mints nothing.
//
// Two verdicts come back, deliberately separate:
//   compiled   — the transaction built and fits Solana's 1232-byte packet limit.
//                A plan whose name + ticker + metadata URI overflow fails here,
//                which is the failure a real launch would otherwise hit at
//                signing time with the owner's money already committed.
//   simulation — the cluster executed it. `funding_required` is reported apart
//                from a genuine program failure, because an unfunded devnet
//                rehearsal wallet is a funding fact, not a broken plan.

const planDryRunSchema = z.object({
	agent_id: z.string().uuid(),
	// Devnet is the default: the proof lane should cost nothing and touch nothing
	// that trades. A mainnet dry run is still read-only, so it stays available.
	network: z.enum(['mainnet', 'devnet']).default('devnet'),
});

/** The metadata URI the real launch would carry, derived without pinning. */
function plannedMetadataUri(meta) {
	const bytes = Buffer.from(JSON.stringify(buildTokenMetadata(meta)), 'utf-8');
	const hash = createHash('sha256').update(bytes).digest('hex');
	return { uri: publicUrl(`tm/${hash.slice(0, 16)}.json`), bytes: bytes.length };
}

// Did the cluster reject this only because the payer cannot cover it?
function isFundingFailure(err, logs) {
	const blob = `${JSON.stringify(err ?? '')} ${(logs || []).join(' ')}`;
	return /AccountNotFound|InsufficientFundsForRent|insufficient lamports|insufficient funds|Attempt to debit an account but found no record/i.test(
		blob,
	);
}

async function handlePlanDryRun(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	if (!isSameSiteOrigin(req)) return error(res, 403, 'forbidden', 'cross-site request blocked');

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(planDryRunSchema, await readJson(req));
	const loaded = await loadAgentForPlan(req, body.agent_id);
	if (!loaded) return error(res, 404, 'not_found', 'agent not found');
	if (!loaded.isOwner) return error(res, 403, 'forbidden', 'only the agent owner can dry-run its token plan');

	const row = await getPlan({ agentId: body.agent_id, network: body.network });
	if (!row) {
		return error(
			res,
			404,
			'not_found',
			`no token plan saved for this agent on ${body.network} — save one first`,
		);
	}
	const plan = normalizePlanInput(row);
	const readiness = planReadiness(plan);
	if (!readiness.ready) {
		return json(res, 409, {
			ok: false,
			code: 'plan_not_ready',
			network: body.network,
			readiness,
			plan: shapePlan(row),
		});
	}

	const payerAddress = agentLaunchWallet(loaded.agent);
	if (!payerAddress) {
		return error(
			res,
			409,
			'precondition_failed',
			'this agent has no Solana wallet yet — deploy it on Solana before rehearsing a launch',
		);
	}

	const result = await simulatePlanLaunch({ plan, agent: loaded.agent, payerAddress });
	const saved = await recordDryRun({ agentId: body.agent_id, network: body.network, result });

	return json(res, 200, {
		ok: true,
		broadcast: false,
		network: body.network,
		result,
		plan: shapePlan(saved || row),
	});
}

/**
 * Compile and simulate the plan's launch transaction. Never signs, never sends.
 *
 * @param {{ plan: object, agent: object, payerAddress: string }} o
 * @returns {Promise<object>} the dry-run result, safe to persist as JSON
 */
async function simulatePlanLaunch({ plan, agent, payerAddress }) {
	const { Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } =
		await loadSolanaWeb3();
	const { PumpSdk, OnlinePumpSdk, getBuyTokenAmountFromSolAmount, BN, isLegacyQuoteMint } =
		await loadPumpSdk();

	const { uri: metadataUri, bytes: metadataBytes } = plannedMetadataUri({
		name: plan.name,
		symbol: plan.symbol,
		description: plan.description,
		image: plan.image_url || '',
		website: plan.website || '',
		twitter: plan.twitter || '',
		telegram: plan.telegram || '',
		agentUrl: agentHomeUrl(agent.id),
		creatorAddress: payerAddress,
		createdAt: new Date().toISOString(),
	});

	const conn = solanaConnection({ url: rpcUrl(plan.network), commitment: 'confirmed' });
	const onlineSdk = new OnlinePumpSdk(conn);
	const sdk = new PumpSdk();

	// Ephemeral: a launch mints a brand-new address every time, and this one is
	// discarded when the request ends. The rehearsal only needs an address of the
	// right shape for the instruction layout and the size measurement.
	const mintKeypair = Keypair.generate();
	const creator = new PublicKey(payerAddress);
	const quoteMint = plan.quote_currency === 'usdc' ? new PublicKey(usdcMintFor(plan.network)) : null;
	const isMayhem = plan.coin_type === 'mayhem';

	const ixs = [
		ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }),
		ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
	];

	const createArgs = {
		mint: mintKeypair.publicKey,
		name: plan.name,
		symbol: plan.symbol,
		uri: metadataUri,
		creator,
		user: creator,
		mayhemMode: isMayhem,
	};

	if (quoteMint && !isLegacyQuoteMint(quoteMint)) {
		if (plan.usdc_buy_in > 0) {
			const global = await onlineSdk.fetchGlobal();
			const quoteAmount = new BN(Math.round(plan.usdc_buy_in * 1_000_000));
			const tokenAmount = getBuyTokenAmountFromSolAmount({
				global,
				feeConfig: null,
				mintSupply: null,
				bondingCurve: null,
				amount: quoteAmount,
				quoteMint,
			});
			const built = await sdk.createV2AndBuyV2Instructions({
				global,
				...createArgs,
				quoteAmount,
				amount: tokenAmount,
				quoteMint,
			});
			ixs.push(...(Array.isArray(built) ? built : [built]));
		} else {
			ixs.push(await sdk.createV2Instruction({ ...createArgs, quoteMint }));
		}
	} else if (plan.sol_buy_in > 0) {
		const global = await onlineSdk.fetchGlobal();
		const solAmount = new BN(Math.floor(plan.sol_buy_in * 1_000_000_000));
		const tokenAmount = getBuyTokenAmountFromSolAmount({
			global,
			feeConfig: null,
			mintSupply: null,
			bondingCurve: null,
			amount: solAmount,
		});
		const built = await sdk.createV2AndBuyInstructions({
			global,
			...createArgs,
			amount: tokenAmount,
			solAmount,
		});
		ixs.push(...(Array.isArray(built) ? built : [built]));
	} else {
		ixs.push(await sdk.createV2Instruction(createArgs));
	}

	const { blockhash } = await conn.getLatestBlockhash('confirmed');
	const message = new TransactionMessage({
		payerKey: creator,
		recentBlockhash: blockhash,
		instructions: ixs,
	}).compileToV0Message();
	const tx = new VersionedTransaction(message);

	// Structural proof: a transaction that cannot serialize is a launch that
	// would have died at signing time, and the byte count says by how much.
	let txBytes = null;
	let compileError = null;
	try {
		txBytes = tx.serialize().length;
	} catch (err) {
		compileError = /too large|overruns/i.test(err?.message || '')
			? 'transaction exceeds Solana packet limits — shorten the coin name or the metadata'
			: err?.message || 'transaction failed to serialize';
	}

	const base = {
		checked_at: new Date().toISOString(),
		network: plan.network,
		payer: payerAddress,
		mint_preview: mintKeypair.publicKey.toBase58(),
		metadata_uri: metadataUri,
		metadata_bytes: metadataBytes,
		metadata_pinned: false,
		instruction_count: ixs.length,
		quote_currency: plan.quote_currency,
		cost_estimate: estimateLaunchCost(plan),
		compiled: compileError === null,
		tx_bytes: txBytes,
		compile_error: compileError,
	};
	if (compileError) return { ...base, verdict: 'compile_failed', simulation: null };

	// `sigVerify: false` because nothing is signed here — the point is to execute
	// the instructions, not to prove a signature. `replaceRecentBlockhash` keeps
	// the simulation valid even if the blockhash aged out between the two calls.
	let sim;
	try {
		sim = await conn.simulateTransaction(tx, {
			sigVerify: false,
			replaceRecentBlockhash: true,
			commitment: 'confirmed',
		});
	} catch (err) {
		return {
			...base,
			verdict: 'rpc_unavailable',
			simulation: { error: err?.message || 'simulation RPC call failed', logs: [] },
		};
	}

	const value = sim?.value || {};
	const logs = Array.isArray(value.logs) ? value.logs.slice(-25) : [];
	const simulation = {
		error: value.err ? JSON.stringify(value.err) : null,
		units_consumed: value.unitsConsumed ?? null,
		logs,
	};
	if (!value.err) return { ...base, verdict: 'would_succeed', simulation };
	return {
		...base,
		verdict: isFundingFailure(value.err, logs) ? 'funding_required' : 'would_fail',
		simulation,
	};
}

// ── launch-prep ──────────────────────────────────────────────────────────────

const launchPrepSchema = z.object({
	agent_id: z.string().min(1).max(80),
	provider: z.literal('pumpfun'),
	cluster: z.enum(['mainnet', 'devnet']),
	wallet_address: z.string().min(32).max(44),
	name: z.string().trim().min(1).max(32),
	// Pump.fun caps symbols at ~10 chars; let's be permissive but clamped.
	symbol: z
		.string()
		.trim()
		.min(2)
		.max(10)
		.regex(/^[A-Za-z0-9]+$/, 'symbol must be alphanumeric'),
	description: z.string().trim().max(280).default(''),
	image: z.string().url().or(z.literal('')).default(''),
	// Optional socials surfaced on the pump.fun coin page. When omitted, the
	// metadata still links back to three.ws + the agent profile + our X.
	website: z.string().url().or(z.literal('')).default(''),
	twitter: z.string().url().or(z.literal('')).default(''),
	telegram: z.string().url().or(z.literal('')).default(''),
	initial_buy_sol: z.number().min(0).max(50).default(0),
	// When true, the coin identity comes from the agent's saved plan instead of
	// this body. Anything the caller does supply still wins, so the launch screen
	// can prefill from the plan and let the owner tweak one field at the last
	// moment without discarding the rest.
	use_plan: z.boolean().default(false),
});

/**
 * Overlay the agent's saved plan under an inbound launch body. The body wins on
 * every field it actually carries; the plan fills the rest. Returns null when
 * the agent has no plan on this cluster.
 */
async function launchBodyFromPlan(raw, agentId) {
	const network = raw.cluster === 'devnet' ? 'devnet' : 'mainnet';
	const row = await getPlan({ agentId, network });
	if (!row) return null;
	const plan = normalizePlanInput(row);
	const pick = (bodyValue, planValue) =>
		bodyValue === undefined || bodyValue === null || bodyValue === '' ? planValue : bodyValue;
	return {
		...raw,
		name: pick(raw.name, plan.name),
		symbol: pick(raw.symbol, plan.symbol),
		description: pick(raw.description, plan.description),
		image: pick(raw.image, plan.image_url || ''),
		website: pick(raw.website, plan.website || ''),
		twitter: pick(raw.twitter, plan.twitter || ''),
		telegram: pick(raw.telegram, plan.telegram || ''),
		// This path launches a SOL-paired coin from the user's own wallet, so only
		// the SOL dev buy applies; a USDC-paired plan launches from the agent
		// custodial path (/api/pump/launch-agent) instead.
		initial_buy_sol: pick(raw.initial_buy_sol, plan.sol_buy_in),
	};
}

async function pinTokenMetadata(meta) {
	const json = buildTokenMetadata(meta);
	const bytes = Buffer.from(JSON.stringify(json), 'utf-8');
	const token = process.env.WEB3_STORAGE_TOKEN;
	if (token) {
		try {
			const r = await fetch('https://api.web3.storage/upload', {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}` },
				body: bytes,
			});
			if (r.ok) {
				const data = await r.json();
				if (data.cid) return { cid: data.cid, uri: `ipfs://${data.cid}` };
			}
		} catch (e) {
			console.warn('[token launch-prep] web3.storage pin failed:', e.message);
		}
	}
	const hash = createHash('sha256').update(bytes).digest('hex');
	// Keep this key SHORT. The resulting public URL becomes the coin's on-chain
	// metadata `uri`, which is serialized into the launch transaction. A long key
	// pushes the (legacy) create+buy tx over Solana's 1232-byte packet limit
	// ("Transaction too large"). A content-addressed 16-hex prefix is unique
	// enough and ~30 bytes shorter than a timestamp+random path. (When
	// web3.storage is configured we use the even shorter `ipfs://<cid>` above.)
	const key = `tm/${hash.slice(0, 16)}.json`;
	const { PutObjectCommand } = await loadS3Commands();
	await r2.send(
		new PutObjectCommand({
			Bucket: env.S3_BUCKET,
			Key: key,
			Body: bytes,
			ContentType: 'application/json',
		}),
	);
	const uri = publicUrl(key);
	return { cid: hash, uri };
}

async function handleLaunchPrep(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const raw = (await readJson(req)) || {};

	// Ownership resolves before anything reads the plan, so a signed-in stranger
	// can never probe another owner's unlaunched token configuration through
	// `use_plan`.
	const agentId = typeof raw.agent_id === 'string' ? raw.agent_id.trim() : '';
	if (!agentId) return error(res, 400, 'validation_error', 'agent_id is required');

	// Resolve agent + ownership + Solana deploy state
	const [agent] = await sql`
		select id, name, user_id, wallet_address, meta
		from agent_identities
		where id = ${agentId} and user_id = ${user.id} and deleted_at is null
		limit 1
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	let source = raw;
	if (raw.use_plan === true) {
		source = await launchBodyFromPlan(raw, agentId);
		if (!source) {
			return error(
				res,
				404,
				'not_found',
				`no token plan saved for this agent on ${raw.cluster === 'devnet' ? 'devnet' : 'mainnet'} — save one first`,
			);
		}
	}
	const body = parse(launchPrepSchema, source);

	const onchain = agent.meta?.onchain;
	if (!onchain || onchain.family !== 'solana') {
		return error(
			res,
			409,
			'precondition_failed',
			'agent must be deployed on Solana before launching a token',
		);
	}
	// Solana addresses are case-sensitive base58, so "AbC" and "aBc" are two
	// different accounts. A case-insensitive pre-check used to wrap this
	// comparison, which let a case-variant address skip the exact check entirely
	// and become the launch transaction's creator. Compare exactly, once.
	if (onchain.wallet !== body.wallet_address) {
		return error(res, 403, 'forbidden', 'wallet does not match agent owner');
	}
	if (agent.meta?.token?.mint) {
		return error(res, 409, 'conflict', 'agent already has a launched token');
	}

	// 3. Pin token metadata — links the coin back to three.ws, the agent
	// profile, our X, and the $THREE coin.
	const { cid, uri: metadataUri } = await pinTokenMetadata({
		name: body.name,
		symbol: body.symbol,
		description: body.description,
		image: body.image,
		website: body.website,
		twitter: body.twitter,
		telegram: body.telegram,
		agentUrl: agentHomeUrl(agent.id),
		creatorAddress: body.wallet_address,
		createdAt: new Date().toISOString(),
	});

	// 4. Build the launch tx
	const { Keypair, PublicKey, Transaction, ComputeBudgetProgram } = await loadSolanaWeb3();
	const { PumpSdk, OnlinePumpSdk, getBuyTokenAmountFromSolAmount, BN } = await loadPumpSdk();
	const conn = solanaConnection({ url: rpcUrl(body.cluster), commitment: 'confirmed' });
	const onlineSdk = new OnlinePumpSdk(conn);
	const sdk = new PumpSdk();

	const mintKeypair = Keypair.generate();
	const creator = new PublicKey(body.wallet_address);
	const userPk = creator;

	const ixs = [
		// Bump compute budget — coin creation routinely exceeds the 200k default.
		ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }),
		ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
	];

	if (body.initial_buy_sol > 0) {
		const global = await onlineSdk.fetchGlobal();
		const lamports = new BN(Math.floor(body.initial_buy_sol * 1_000_000_000));
		const tokenAmount = getBuyTokenAmountFromSolAmount({
			global,
			feeConfig: null,
			mintSupply: null,
			bondingCurve: null,
			amount: lamports,
		});
		const launchIxs = await sdk.createV2AndBuyInstructions({
			global,
			mint: mintKeypair.publicKey,
			name: body.name,
			symbol: body.symbol,
			uri: metadataUri,
			creator,
			user: userPk,
			amount: tokenAmount,
			solAmount: lamports,
		});
		ixs.push(...launchIxs);
	} else {
		const ix = await sdk.createV2Instruction({
			mint: mintKeypair.publicKey,
			name: body.name,
			symbol: body.symbol,
			uri: metadataUri,
			creator,
			user: userPk,
			mayhemMode: false,
		});
		ixs.push(ix);
	}

	const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
	const tx = new Transaction({
		feePayer: creator,
		blockhash,
		lastValidBlockHeight,
	}).add(...ixs);

	// Partial-sign with the mint keypair. The user's wallet adds the creator
	// signature client-side before submission. After this serialize, the mint
	// secret key is no longer needed and goes out of scope.
	tx.partialSign(mintKeypair);

	// Serialize defensively. A coin whose name/uri push the create+buy past
	// Solana's 1232-byte packet limit otherwise throws an unhandled RangeError
	// ("Transaction too large" / "encoding overruns Uint8Array") → a 500 with no
	// actionable signal. Catch it and return a clean, typed 413 telling the user
	// exactly what to shorten.
	let txBase64;
	try {
		txBase64 = tx
			.serialize({ requireAllSignatures: false, verifySignatures: false })
			.toString('base64');
	} catch (err) {
		if (/too large|overruns/i.test(err?.message || '')) {
			return error(
				res,
				413,
				'launch_payload_too_large',
				'token launch transaction exceeds Solana size limits — shorten the token name',
			);
		}
		throw err;
	}

	// 5. Persist prep
	const prepId = await randomToken(24);
	const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

	await sql`
		insert into token_launches_pending
			(id, user_id, agent_id, provider, cluster, mint, metadata_uri, cid, payload, expires_at)
		values (
			${prepId},
			${user.id},
			${agent.id},
			'pumpfun',
			${body.cluster},
			${mintKeypair.publicKey.toBase58()},
			${metadataUri},
			${cid},
			${JSON.stringify({
				name: body.name,
				symbol: body.symbol,
				description: body.description,
				image: body.image,
				website: body.website || '',
				twitter: body.twitter || '',
				telegram: body.telegram || '',
				initial_buy_sol: body.initial_buy_sol,
				wallet_address: body.wallet_address,
			})}::jsonb,
			${expiresAt}
		)
		on conflict (id) do nothing
	`;

	return json(res, 201, {
		prep_id: prepId,
		mint: mintKeypair.publicKey.toBase58(),
		tx_base64: txBase64,
		metadata_uri: metadataUri,
		cluster: body.cluster,
		expires_at: expiresAt.toISOString(),
	});
}

// ── launch-confirm ───────────────────────────────────────────────────────────

const launchConfirmSchema = z.object({
	prep_id: z.string().min(8).max(80),
	tx_signature: z.string().min(40).max(120),
	wallet_address: z.string().min(32).max(44),
});

async function handleLaunchConfirm(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(launchConfirmSchema, await readJson(req));

	const [prep] = await sql`
		select id, agent_id, mint, metadata_uri, cluster, payload
		from token_launches_pending
		where id = ${body.prep_id} and user_id = ${user.id} and expires_at > now()
		limit 1
	`;
	if (!prep) return error(res, 404, 'not_found', 'prep expired or not found');

	if (prep.payload?.wallet_address !== body.wallet_address) {
		return error(res, 400, 'validation_error', 'wallet mismatch with prep');
	}

	// Verify on-chain
	const conn = solanaConnection({ url: rpcUrl(prep.cluster), commitment: 'confirmed' });

	const deadline = Date.now() + 30_000;
	let tx;
	while (Date.now() < deadline) {
		tx = await conn.getParsedTransaction(body.tx_signature, {
			maxSupportedTransactionVersion: 0,
			commitment: 'confirmed',
		});
		if (tx) break;
		await new Promise((r) => setTimeout(r, 1500));
	}
	if (!tx) return error(res, 422, 'tx_not_found', 'tx not found on Solana RPC');
	if (tx.meta?.err) return error(res, 422, 'tx_failed', 'tx failed on-chain');

	const accounts = tx.transaction.message.accountKeys.map((k) => k.pubkey?.toString());
	if (!accounts.includes(prep.mint)) {
		return error(res, 422, 'mint_not_in_tx', 'expected mint not in tx');
	}
	if (!accounts.includes(body.wallet_address)) {
		return error(res, 422, 'wrong_signer', 'wallet not in tx signers');
	}

	// Resolve agent (re-check ownership + still no token)
	const [agent] = await sql`
		select id, meta from agent_identities
		where id = ${prep.agent_id} and user_id = ${user.id} and deleted_at is null
		limit 1
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');
	if (agent.meta?.token?.mint) {
		return error(res, 409, 'conflict', 'agent already has a launched token');
	}

	const token = {
		provider: 'pumpfun',
		mint: prep.mint,
		name: prep.payload.name,
		symbol: prep.payload.symbol,
		description: prep.payload.description,
		image: prep.payload.image,
		metadata_uri: prep.metadata_uri,
		cluster: prep.cluster,
		creator: body.wallet_address,
		tx_signature: body.tx_signature,
		launched_at: new Date().toISOString(),
		...(prep.payload.website ? { website: prep.payload.website } : {}),
		...(prep.payload.twitter ? { twitter: prep.payload.twitter } : {}),
		...(prep.payload.telegram ? { telegram: prep.payload.telegram } : {}),
		...(prep.cluster === 'mainnet'
			? { pumpfun_url: `https://pump.fun/${prep.mint}` }
			: {
					explorer_url: `https://explorer.solana.com/address/${prep.mint}?cluster=devnet`,
				}),
		...(prep.payload.initial_buy_sol > 0
			? { initial_buy_sol: prep.payload.initial_buy_sol }
			: {}),
	};

	// Register the launch BEFORE the agent record flips to "has a token". Both
	// writes below are idempotent, and this order means a failure here leaves the
	// agent unmarked so the same prep can simply be confirmed again — the reverse
	// order would strand a confirmed coin outside the launch directory forever,
	// with the retry rejected by the "already has a launched token" guard.
	//
	// pump_agent_mints is the platform's own launch directory: it is what powers
	// /launches, the agent profile's launch history, and GET /api/v1/pump/launches.
	// Coins launched from the user's wallet through this path used to be invisible
	// to all three because only the agent-custodial path (/api/pump/launch-agent)
	// ever wrote a row. buyback_bps is 0 here on purpose: this path creates no
	// on-chain pump agent, so claiming a buyback share would be claiming an
	// enforcement that does not exist.
	await sql`
		insert into pump_agent_mints
			(agent_id, user_id, network, mint, name, symbol, metadata_uri, agent_authority, buyback_bps)
		values
			(${agent.id}, ${user.id}, ${prep.cluster}, ${prep.mint}, ${prep.payload.name},
			 ${prep.payload.symbol}, ${prep.metadata_uri}, ${body.wallet_address}, 0)
		on conflict (mint, network) do nothing
	`;
	const launchedPlan = await markPlanLaunched({
		agentId: agent.id,
		network: prep.cluster,
		mint: prep.mint,
	});

	const mergedMeta = { ...(agent.meta || {}), token };
	const [updated] = await sql`
		update agent_identities
		set meta = ${JSON.stringify(mergedMeta)}::jsonb,
		    updated_at = now()
		where id = ${agent.id}
		returning id, name, description, wallet_address, meta, created_at
	`;

	await sql`delete from token_launches_pending where id = ${prep.id}`;

	return json(res, 201, {
		ok: true,
		agent: { ...updated, token, home_url: `${env.APP_ORIGIN}/agent/${updated.id}` },
		plan: shapePlan(launchedPlan),
	});
}

// ── launch-quote ─────────────────────────────────────────────────────────────

const launchQuoteSchema = z.object({
	initial_buy_sol: z.coerce.number().min(0).max(50).default(0),
	cluster: z.enum(['mainnet', 'devnet']).default('mainnet'),
});

// Conservative upper bounds, in SOL. These live in api/_lib/agent-token-plan.js
// so this quote and the cost estimate a saved plan reports are the same numbers:
// an owner who reads "0.0091 SOL" on the plan card must be quoted the same thing
// at launch time.
const FIXED_LAUNCH_COST = FIXED_LAUNCH_COST_SOL;
const FIXED_LAUNCH_TOTAL = FIXED_LAUNCH_TOTAL_SOL;

async function handleLaunchQuote(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const q = parse(launchQuoteSchema, {
		initial_buy_sol: url.searchParams.get('initial_buy_sol'),
		cluster: url.searchParams.get('cluster') || undefined,
	});

	let buyEstimate = null;
	if (q.initial_buy_sol > 0) {
		try {
			const { OnlinePumpSdk, getBuyTokenAmountFromSolAmount, BN } = await loadPumpSdk();
			const conn = solanaConnection({ url: rpcUrl(q.cluster), commitment: 'confirmed' });
			const onlineSdk = new OnlinePumpSdk(conn);
			const global = await onlineSdk.fetchGlobal();
			const lamports = new BN(Math.floor(q.initial_buy_sol * 1_000_000_000));
			const tokensOut = getBuyTokenAmountFromSolAmount({
				global,
				feeConfig: null,
				mintSupply: null,
				bondingCurve: null,
				amount: lamports,
			});
			// Pump.fun protocol fee on initial buy is ~1%; surface as a separate
			// line so the user sees what's spent vs what funds the curve.
			buyEstimate = {
				sol: q.initial_buy_sol,
				tokens_out: tokensOut.toString(),
				protocol_fee_sol: q.initial_buy_sol * 0.01,
			};
		} catch (e) {
			// If RPC is unhealthy, return the structural estimate without the
			// curve quote — the UI can still show launch costs.
			console.warn('[launch-quote] RPC fetch failed:', e.message);
		}
	}

	const totalSol = FIXED_LAUNCH_TOTAL + q.initial_buy_sol + (buyEstimate?.protocol_fee_sol || 0);

	return json(res, 200, {
		cluster: q.cluster,
		fixed: FIXED_LAUNCH_COST,
		fixed_total_sol: FIXED_LAUNCH_TOTAL,
		initial_buy: buyEstimate,
		total_sol: totalSol,
	});
}
