// three.ws native launch lane dispatcher: the self-hosted coin launchpad on
// Meteora's Dynamic Bonding Curve (DBC), alongside the pump.fun lane in
// api/pump/[action].js. Same custody model: the server builds unsigned
// transactions, the user's wallet (plus the mint keypair) signs client-side,
// and a confirm step verifies the landed transaction on-chain before
// recording the launch.
//
// Namespaced /api/native-launch/* (NOT /api/launchpad/*, which is the
// unrelated Launchpad Studio page builder).
//
// Action map:
//   config          -> handleConfig        (public: lane economics + config key)
//   quote           -> handleQuote         (public: buy quote on a live curve)
//   pool            -> handlePool          (public: pool state / curve progress)
//   launch-prep     -> handleLaunchPrep    (authed: unsigned create-pool tx)
//   launch-confirm  -> handleLaunchConfirm (authed: verify + record launch)
//   launches        -> handleLaunches      (public: native launch directory)

import { z } from 'zod';
import { Keypair } from '@solana/web3.js';
import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { thumbnailUrl } from '../_lib/r2.js';
import { env } from '../_lib/env.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { resolveOrCreateAgentForAvatar } from '../_lib/agent-identity.js';
import { parse, isUuid } from '../_lib/validate.js';
import { randomToken } from '../_lib/crypto.js';
import { publishFeedEvent } from '../_lib/feed.js';
import { normalizeGatewayURL } from '../../src/ipfs.js';
import { THREE_WS_VANITY, hasThreeWsMark } from '../../src/solana/vanity/brand.js';
import { grindVanityNode, GrindExhaustedError } from '../../src/solana/vanity/grinder-node.js';
import { verifySignature, solanaPubkey } from '../_lib/pump.js';
import { laneInfo, configKeyFor } from '../_lib/native-launch/config.js';
import {
	buildCreatePoolTx,
	txInvokesDbcProgram,
	getPoolState,
	quoteBuy,
} from '../_lib/native-launch/dbc.js';
import { logger } from '../_lib/usage.js';

const log = logger('launchpad');

function shortAddr(a) {
	return a && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || '';
}

// ── config ─────────────────────────────────────────────────────────────────

async function handleConfig(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	const url = new URL(req.url, `http://${req.headers.host}`);
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	const info = laneInfo(network);
	return json(res, 200, { ...info, available: Boolean(info.config_key) }, {
		'cache-control': 'public, max-age=60, s-maxage=300',
	});
}

// ── quote / pool (public reads) ────────────────────────────────────────────

async function handleQuote(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	const url = new URL(req.url, `http://${req.headers.host}`);
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	const mint = url.searchParams.get('mint');
	const solIn = Number(url.searchParams.get('sol_in') || '0.1');
	if (!mint || !solanaPubkey(mint)) return error(res, 400, 'validation_error', 'valid mint required');
	if (!(solIn > 0) || solIn > 1000) return error(res, 400, 'validation_error', 'sol_in must be in (0, 1000]');
	try {
		const quote = await quoteBuy({ network, mint, solIn });
		return json(res, 200, { network, mint, ...quote });
	} catch (e) {
		return error(res, e.status || 500, e.code || 'quote_failed', e.message);
	}
}

async function handlePool(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	const url = new URL(req.url, `http://${req.headers.host}`);
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	const mint = url.searchParams.get('mint');
	if (!mint || !solanaPubkey(mint)) return error(res, 400, 'validation_error', 'valid mint required');
	try {
		const state = await getPoolState({ network, mint });
		return json(res, 200, { network, mint, ...state }, { 'cache-control': 'public, max-age=5' });
	} catch (e) {
		return error(res, e.status || 500, e.code || 'pool_state_failed', e.message);
	}
}

// ── launch-prep ────────────────────────────────────────────────────────────

const launchPrepSchema = z
	.object({
		agent_id: z.string().uuid().optional(),
		avatar_id: z.string().uuid().optional(),
		wallet_address: z.string().min(32).max(44),
		creator_address: z.string().min(32).max(44).optional(),
		name: z.string().trim().min(1).max(32),
		symbol: z.string().trim().min(1).max(10),
		uri: z.string().url().max(200),
		network: z.enum(['mainnet', 'devnet']).default('mainnet'),
		sol_buy_in: z.number().min(0).max(50).default(0),
		mint_address: z.string().min(32).max(44).optional(),
	})
	.refine((b) => b.agent_id || b.avatar_id, { message: 'agent_id or avatar_id required' });

async function handleLaunchPrep(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(launchPrepSchema, await readJson(req));
	if (!configKeyFor(body.network)) {
		return error(
			res,
			503,
			'lane_not_configured',
			`native launchpad is not deployed on ${body.network} yet`,
		);
	}
	const signer = solanaPubkey(body.wallet_address);
	if (!signer) return error(res, 400, 'validation_error', 'invalid wallet_address');

	const [walletRow] = await sql`
		select id from user_wallets
		where user_id=${user.id} and address=${body.wallet_address} and chain_type='solana'
		limit 1
	`;
	if (!walletRow) return error(res, 403, 'forbidden', 'wallet not linked to your account');

	// On-chain pool creator (trading-fee recipient). Same ownership rule as the
	// pump lane: when provided, it must be another wallet linked to this user.
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

	const agent = await resolveOrCreateAgentForAvatar({
		userId: user.id,
		agentId: body.agent_id,
		avatarId: body.avatar_id,
	});
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	// Mint pubkey: client-supplied (vanity-ground) or server-ground with the
	// three.ws mark. Identical branding rule to the pump lane.
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
				'three.ws launches must use a mint address carrying the "3ws" mark. Grind one client-side, or omit mint_address to let the server stamp it',
			);
		}
		mint = supplied;
	} else if (enforceMark) {
		try {
			const ground = await grindVanityNode({ ...THREE_WS_VANITY });
			mintKeypair = Keypair.fromSecretKey(ground.secretKey);
			mint = mintKeypair.publicKey;
		} catch (err) {
			if (err instanceof GrindExhaustedError) {
				return error(res, 503, 'mark_grind_failed', 'could not stamp the three.ws mark, retry');
			}
			throw err;
		}
	} else {
		mintKeypair = Keypair.generate();
		mint = mintKeypair.publicKey;
	}

	let built;
	try {
		built = await buildCreatePoolTx({
			network: body.network,
			payer: signer,
			creator,
			baseMint: mint,
			name: body.name,
			symbol: body.symbol,
			uri: body.uri,
			solBuyIn: body.sol_buy_in,
		});
	} catch (e) {
		log.warn('create_pool_build_failed', { message: e.message });
		return error(res, e.status || 502, e.code || 'build_failed', e.message);
	}

	const prepId = await randomToken(24);
	const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
	await sql`
		insert into agent_registrations_pending (user_id, cid, metadata_uri, payload, expires_at)
		values (
			${user.id},
			${mint.toBase58()},
			${body.uri},
			${JSON.stringify({
				kind: 'native_launch',
				agent_id: agent.id,
				wallet_address: body.wallet_address,
				creator_address: creator.toBase58(),
				mint: mint.toBase58(),
				pool: built.pool,
				config_key: built.configKey,
				name: body.name,
				symbol: body.symbol,
				network: body.network,
				prep_id: prepId,
			})}::jsonb,
			${expiresAt}
		)
	`;

	return json(res, 201, {
		prep_id: prepId,
		agent_id: agent.id,
		lane: 'native',
		mint: mint.toBase58(),
		pool: built.pool,
		config_key: built.configKey,
		mint_secret_key_b64: mintKeypair ? Buffer.from(mintKeypair.secretKey).toString('base64') : null,
		client_supplied_mint: !mintKeypair,
		tx_base64: built.txBase64,
		network: body.network,
		expires_at: expiresAt.toISOString(),
		instructions: mintKeypair
			? 'Decode tx_base64 as VersionedTransaction. Sign with the mint keypair (mint_secret_key_b64) AND the user wallet, submit, then POST /api/native-launch/launch-confirm with the tx_signature.'
			: 'Decode tx_base64 as VersionedTransaction. Sign with your locally-held vanity mint keypair AND the user wallet, submit, then POST /api/native-launch/launch-confirm with the tx_signature.',
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
	if (p.kind !== 'native_launch') return error(res, 400, 'wrong_kind', 'prep is not a native launch');

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
	// The confirmed tx must have run the DBC program itself. A memo/transfer
	// touching the mint account can never be recorded as a launch.
	if (!txInvokesDbcProgram(tx)) {
		return error(res, 422, 'not_a_native_launch', 'transaction did not invoke the bonding-curve program');
	}

	const [existing] = await sql`
		select id from native_launches where mint=${p.mint} and network=${p.network} limit 1
	`;
	if (existing) return error(res, 409, 'conflict', 'mint already registered');

	const [row] = await sql`
		insert into native_launches
			(agent_id, user_id, network, mint, pool, config_key, name, symbol, metadata_uri, creator_address)
		values
			(${p.agent_id}, ${user.id}, ${p.network}, ${p.mint}, ${p.pool}, ${p.config_key},
			 ${p.name}, ${p.symbol}, ${pending.metadata_uri || null}, ${p.creator_address})
		returning id, mint, pool, network, created_at
	`;

	await sql`delete from agent_registrations_pending where id=${pending.id}`;

	publishFeedEvent({
		type: 'coin-buy',
		ts: Date.now(),
		actor: shortAddr(p.wallet_address),
		mint: p.mint,
		sol: 0,
		network: p.network,
		branded: hasThreeWsMark(p.mint),
		lane: 'native',
	}).catch(() => {});

	return json(res, 201, { ok: true, native_launch: row, tx_signature: body.tx_signature });
}

// ── launches (public directory) ────────────────────────────────────────────

async function handleLaunches(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host}`);
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	const agentId = url.searchParams.get('agent_id') || null;
	// agent_id lands in a uuid column: an unvalidated value makes Postgres raise
	// and the request surface as a 500. Same 400 the pump lane returns.
	if (agentId && !isUuid(agentId)) {
		return error(res, 400, 'validation_error', 'agent_id must be a uuid');
	}
	const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
	const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '24', 10) || 24));

	const rows = agentId
		? await sql`
				select nl.mint, nl.pool, nl.network, nl.name, nl.symbol, nl.metadata_uri,
				       nl.status, nl.created_at,
				       ai.id as agent_id, ai.name as agent_name,
				       a.thumbnail_key as avatar_thumbnail_key, a.visibility as avatar_visibility
				from native_launches nl
				left join agent_identities ai on ai.id = nl.agent_id and ai.deleted_at is null
				left join avatars a on a.id = ai.avatar_id and a.deleted_at is null
				where nl.network=${network} and nl.agent_id=${agentId}
				order by nl.created_at desc
				limit ${limit + 1} offset ${offset}
			`
		: await sql`
				select nl.mint, nl.pool, nl.network, nl.name, nl.symbol, nl.metadata_uri,
				       nl.status, nl.created_at,
				       ai.id as agent_id, ai.name as agent_name,
				       a.thumbnail_key as avatar_thumbnail_key, a.visibility as avatar_visibility
				from native_launches nl
				left join agent_identities ai on ai.id = nl.agent_id and ai.deleted_at is null
				left join avatars a on a.id = ai.avatar_id and a.deleted_at is null
				where nl.network=${network}
				order by nl.created_at desc
				limit ${limit + 1} offset ${offset}
			`;

	const hasMore = rows.length > limit;
	const launches = rows.slice(0, limit).map((r) => {
		const avatarPublic = r.avatar_visibility === 'public' || r.avatar_visibility === 'unlisted';
		return {
			lane: 'native',
			mint: r.mint,
			pool: r.pool,
			network: r.network,
			name: r.name,
			symbol: r.symbol,
			status: r.status,
			metadata_uri: normalizeGatewayURL(r.metadata_uri) || r.metadata_uri,
			created_at: r.created_at,
			agent: r.agent_id
				? {
						id: r.agent_id,
						name: r.agent_name,
						url: `/agents/${r.agent_id}`,
						avatar_thumbnail_url:
							avatarPublic ? thumbnailUrl(r.avatar_thumbnail_key) : null,
					}
				: null,
		};
	});

	return json(
		res,
		200,
		{ data: { launches, has_more: hasMore, offset, limit, network } },
		{ 'cache-control': 'public, max-age=15' },
	);
}

// ── dispatcher ─────────────────────────────────────────────────────────────

async function dispatch(req, res) {
	const url = new URL(req.url, `http://${req.headers.host}`);
	const action = req.query?.action || url.searchParams.get('action');
	switch (action) {
		case 'config': return handleConfig(req, res);
		case 'quote': return handleQuote(req, res);
		case 'pool': return handlePool(req, res);
		case 'launch-prep': return handleLaunchPrep(req, res);
		case 'launch-confirm': return handleLaunchConfirm(req, res);
		case 'launches': return handleLaunches(req, res);
		default:
			return error(res, 404, 'not_found', `unknown launchpad action: ${action || '(none)'}`);
	}
}

export default wrap(dispatch);
