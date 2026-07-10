/**
 * Agent Tokens Dispatcher
 * -----------------------
 * POST /api/agents/tokens/launch-prep
 * POST /api/agents/tokens/launch-confirm
 * GET  /api/agents/tokens/launch-quote
 *
 * Single Vercel function that dispatches on req.query.action (auto-populated
 * from the [action] filename). Consolidated to reduce function count and
 * avoid bundling the heavy Pump.fun/Solana SDKs three times.
 */

import { z } from 'zod';
import { solanaConnection } from '../../_lib/solana/connection.js';
import { createHash } from 'crypto';

import { sql } from '../../_lib/db.js';
import { getSessionUser } from '../../_lib/auth.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { parse } from '../../_lib/validate.js';
import { randomToken } from '../../_lib/crypto.js';
import { env } from '../../_lib/env.js';
import { r2, publicUrl } from '../../_lib/r2.js';
import { buildTokenMetadata, agentHomeUrl } from '../../_lib/three-brand.js';

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
});

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

	const body = parse(launchPrepSchema, await readJson(req));

	// Resolve agent + ownership + Solana deploy state
	const [agent] = await sql`
		select id, name, user_id, wallet_address, meta
		from agent_identities
		where id = ${body.agent_id} and user_id = ${user.id} and deleted_at is null
		limit 1
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	const onchain = agent.meta?.onchain;
	if (!onchain || onchain.family !== 'solana') {
		return error(
			res,
			409,
			'precondition_failed',
			'agent must be deployed on Solana before launching a token',
		);
	}
	if (onchain.wallet?.toLowerCase?.() !== body.wallet_address.toLowerCase?.()) {
		// Solana addresses are case-sensitive; equality check is exact.
		if (onchain.wallet !== body.wallet_address) {
			return error(res, 403, 'forbidden', 'wallet does not match agent owner');
		}
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
	});
}

// ── launch-quote ─────────────────────────────────────────────────────────────

const launchQuoteSchema = z.object({
	initial_buy_sol: z.coerce.number().min(0).max(50).default(0),
	cluster: z.enum(['mainnet', 'devnet']).default('mainnet'),
});

// Conservative upper bounds, in SOL.
const FIXED_LAUNCH_COST = {
	mintRent: 0.00146,
	bondingCurveRent: 0.00203,
	metadataRent: 0.00561,
	txFee: 0.000005,
};
const FIXED_LAUNCH_TOTAL =
	FIXED_LAUNCH_COST.mintRent +
	FIXED_LAUNCH_COST.bondingCurveRent +
	FIXED_LAUNCH_COST.metadataRent +
	FIXED_LAUNCH_COST.txFee;

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
