// POST /api/x402-pay
//
// Server-side x402 payer for the /pay demo. Streams the payment lifecycle
// (challenge → build → verify → settle → result) as Server-Sent Events when
// the client requests `accept: text/event-stream`; otherwise returns a single
// JSON envelope on completion.
//
// In-process: this handler skips the HTTP round-trip to /api/mcp by
// replicating the same flow internally — paymentRequirements() + verifyPayment +
// dispatch() + settlePayment(). Saves ~50–200ms vs an external fetch and
// removes a self-egress hop.
//
// Env (required for prod):
//   X402_AGENT_SOLANA_SECRET_BASE58  base58-encoded 64-byte ed25519 secret
// Local dev fallback (NODE_ENV !== 'production' only): reads keypair JSON at
//   /home/codespace/.config/x402-test-wallets/solana.json
//
// Also: GET /api/x402-pay?balance=1 → returns the agent wallet's USDC + SOL
// balance so the UI can show it ticking down during the demo.

import { readFileSync } from 'node:fs';
import {
	Connection, PublicKey, Keypair, TransactionMessage, VersionedTransaction,
	ComputeBudgetProgram,
} from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync, createTransferCheckedInstruction,
	createAssociatedTokenAccountIdempotentInstruction,
	TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getMint,
} from '@solana/spl-token';
import bs58 from 'bs58';

import { Redis } from '@upstash/redis';
import { cors, json, readJson, wrap } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import {
	paymentRequirements,
	verifyPayment,
	settlePayment,
	resolveResourceUrl,
	NETWORK_SOLANA_MAINNET,
} from './_lib/x402-spec.js';
import { dispatch } from './_mcp/dispatch.js';
import { env } from './_lib/env.js';
import { sql } from './_lib/db.js';
import { logger } from './_lib/usage.js';
import { getSessionUser, authenticateBearer, extractBearer } from './_lib/auth.js';
import { recoverSolanaAgentKeypair } from './_lib/agent-wallet.js';

const log = logger('x402-pay');

// ---- Persistent feed of recent paid calls -------------------------------
// Backed by Upstash Redis when available; falls back to an in-memory ring
// in dev so the feed still works locally.
const FEED_KEY = 'x402:pay:feed';
const FEED_MAX = 50;
const memFeed = [];

let _redis = null;
function redis() {
	if (_redis !== null) return _redis;
	if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
		_redis = new Redis({
			url: env.UPSTASH_REDIS_REST_URL,
			token: env.UPSTASH_REDIS_REST_TOKEN,
		});
	} else {
		_redis = false;
	}
	return _redis;
}

async function recordFeedEntry(entry) {
	const r = redis();
	if (r) {
		try {
			await r.lpush(FEED_KEY, JSON.stringify(entry));
			await r.ltrim(FEED_KEY, 0, FEED_MAX - 1);
		} catch (err) {
			log.warn('feed_write_failed', { message: err?.message });
		}
	}
	memFeed.unshift(entry);
	if (memFeed.length > FEED_MAX) memFeed.length = FEED_MAX;
}

async function readFeed(limit = 25) {
	const r = redis();
	if (r) {
		try {
			const rows = await r.lrange(FEED_KEY, 0, limit - 1);
			return rows
				.map((row) => {
					if (typeof row === 'string') {
						try {
							return JSON.parse(row);
						} catch (parseErr) {
							log.warn('feed_row_parse_failed', { message: parseErr?.message });
							return null;
						}
					}
					return row;
				})
				.filter(Boolean);
		} catch (err) {
			log.warn('feed_read_failed', { message: err?.message });
		}
	}
	return memFeed.slice(0, limit);
}

// Per-tx record so /pay/calls/<tx> can show the full receipt + tool result.
const memCalls = new Map();
const CALL_KEY = (tx) => `x402:pay:call:${tx}`;
const CALL_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

async function persistCall(tx, record) {
	const r = redis();
	if (r) {
		try {
			await r.set(CALL_KEY(tx), JSON.stringify(record), { ex: CALL_TTL_SECONDS });
		} catch (err) {
			log.warn('call_persist_failed', { tx, message: err?.message });
		}
	}
	memCalls.set(tx, record);
}

async function readCall(tx) {
	const r = redis();
	if (r) {
		try {
			const row = await r.get(CALL_KEY(tx));
			if (typeof row === 'string') {
				try {
					return JSON.parse(row);
				} catch (parseErr) {
					log.warn('call_read_parse_failed', { tx, message: parseErr?.message });
				}
			} else if (row && typeof row === 'object') return row;
		} catch (err) {
			log.warn('call_read_failed', { tx, message: err?.message });
		}
	}
	return memCalls.get(tx) || null;
}

// ---- User auth + agent wallet loading ----------------------------------

async function requireAuth(req) {
	try {
		const session = await getSessionUser(req);
		if (session) return { userId: session.id };
		const bearer = await authenticateBearer(extractBearer(req));
		if (bearer) return { userId: bearer.userId };
	} catch (err) {
		log.warn('require_auth_failed', { message: err?.message });
	}
	return null;
}

async function loadAgentKeypairForUser(agentId, userId) {
	const [row] = await sql`
		SELECT id, meta FROM agent_identities
		WHERE id = ${agentId} AND user_id = ${userId} AND deleted_at IS NULL
	`;
	if (!row) return null;
	const enc = row.meta?.encrypted_solana_secret;
	if (!enc) return null;
	return recoverSolanaAgentKeypair(enc, {
		agentId,
		userId,
		reason: 'x402_pay_tool_call',
	});
}

async function getAgentsForUser(userId) {
	const rows = await sql`
		SELECT id, name, description, avatar_id, meta
		FROM agent_identities
		WHERE user_id = ${userId} AND deleted_at IS NULL
		ORDER BY created_at ASC
	`;
	const conn = new Connection(SOLANA_RPC, 'confirmed');
	return Promise.all(rows.map(async (row) => {
		const address = row.meta?.solana_address || null;
		const source = row.meta?.solana_wallet_source || null;
		let usdc = null;
		let sol = null;
		if (address) {
			try {
				const lamports = await conn.getBalance(new PublicKey(address));
				sol = lamports / 1e9;
			} catch (err) {
				log.warn('agent_sol_balance_failed', { address, message: err?.message });
			}
			try {
				const ata = getAssociatedTokenAddressSync(
					new PublicKey(USDC_MAINNET_MINT),
					new PublicKey(address), false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
				);
				const acct = await conn.getTokenAccountBalance(ata);
				usdc = Number(acct.value.uiAmount || 0);
			} catch (err) {
				// Missing ATA throws TokenAccountNotFoundError — that's an expected
				// state (agent never received USDC), so debug not warn.
				if (!/could not find account|TokenAccountNotFound/i.test(err?.message || '')) {
					log.warn('agent_usdc_balance_failed', { address, message: err?.message });
				}
				usdc = 0;
			}
		}
		return {
			id: row.id,
			name: row.name,
			description: row.description,
			avatar_id: row.avatar_id,
			solana_address: address,
			solana_wallet_source: source,
			usdc,
			sol,
		};
	}));
}

function summarizeArgs(args) {
	if (!args || typeof args !== 'object') return '';
	if (args.url) {
		try { return new URL(args.url).pathname.split('/').pop() || args.url; }
		catch { return args.url.slice(0, 40); }
	}
	if (args.q) return `q=${String(args.q).slice(0, 24)}`;
	const keys = Object.keys(args);
	return keys.length ? keys.map((k) => `${k}=${String(args[k]).slice(0,16)}`).join(' ') : '';
}

const ALLOWED_TOOLS = new Set([
	'tools/list',
	'validate_model',
	'inspect_model',
	'optimize_model',
	'search_public_avatars',
]);

const SOLANA_RPC = env.SOLANA_RPC_URL;
const USDC_MAINNET_MINT = env.X402_ASSET_MINT_SOLANA;

let _agent = null;
function loadAgentKeypair() {
	if (_agent) return _agent;
	const b58 = process.env.X402_AGENT_SOLANA_SECRET_BASE58;
	if (b58) {
		let raw;
		try {
			raw = bs58.decode(b58);
		} catch (decodeErr) {
			const e = new Error(`X402_AGENT_SOLANA_SECRET_BASE58 is not valid base58: ${decodeErr?.message}`);
			e.status = 503;
			e.code = 'wallet_misconfigured';
			e.cause = decodeErr;
			throw e;
		}
		if (raw.length !== 64) {
			const e = new Error(
				`X402_AGENT_SOLANA_SECRET_BASE58 decoded to ${raw.length} bytes; expected 64 (ed25519 keypair)`,
			);
			e.status = 503;
			e.code = 'wallet_misconfigured';
			throw e;
		}
		_agent = Keypair.fromSecretKey(raw);
		return _agent;
	}
	// Local dev only: load the developer's test keypair from a well-known
	// codespace path so `npm run dev` works without setting env vars. Refusing
	// to read it in production prevents accidental key reuse across deploys.
	if (process.env.NODE_ENV !== 'production') {
		try {
			const path = '/home/codespace/.config/x402-test-wallets/solana.json';
			const arr = JSON.parse(readFileSync(path, 'utf8'));
			_agent = Keypair.fromSecretKey(Uint8Array.from(arr));
			return _agent;
		} catch (err) {
			log.warn('dev_keypair_load_failed', { path: '/home/codespace/.config/x402-test-wallets/solana.json', message: err?.message });
		}
	}
	const e = new Error('agent wallet not configured (set X402_AGENT_SOLANA_SECRET_BASE58)');
	e.status = 503;
	e.code = 'wallet_unconfigured';
	throw e;
}

function buildJsonRpc(tool, args) {
	if (tool === 'tools/list') return { jsonrpc: '2.0', id: 1, method: 'tools/list' };
	return {
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/call',
		params: { name: tool, arguments: args || {} },
	};
}

async function buildSolanaPaymentPayload({ accept, buyer, conn, resourceUrl }) {
	const mint = new PublicKey(accept.asset);
	const payTo = new PublicKey(accept.payTo);
	const feePayer = new PublicKey(accept.extra.feePayer);
	const amount = BigInt(accept.amount);

	const senderAta = getAssociatedTokenAddressSync(
		mint, buyer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
	);
	const receiverAta = getAssociatedTokenAddressSync(
		mint, payTo, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
	);
	const mintInfo = await getMint(conn, mint);

	const ixs = [
		ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
		ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
	];
	const receiverInfo = await conn.getAccountInfo(receiverAta);
	if (!receiverInfo) {
		ixs.push(createAssociatedTokenAccountIdempotentInstruction(
			feePayer, receiverAta, payTo, mint,
			TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
		));
	}
	ixs.push(createTransferCheckedInstruction(
		senderAta, mint, receiverAta, buyer.publicKey,
		amount, mintInfo.decimals, [], TOKEN_PROGRAM_ID,
	));

	const { blockhash } = await conn.getLatestBlockhash('confirmed');
	const message = new TransactionMessage({
		payerKey: feePayer,
		recentBlockhash: blockhash,
		instructions: ixs,
	}).compileToV0Message();
	const vtx = new VersionedTransaction(message);
	vtx.sign([buyer]);

	const txBase64 = Buffer.from(vtx.serialize()).toString('base64');
	return {
		x402Version: 2,
		scheme: 'exact',
		network: accept.network,
		// PayAI's v2 facilitator schema rejects a bare-string `resource` with
		// `invalid_payload` — it requires the same `{url, mimeType}` object
		// shape as the 402-challenge top-level resource. Keep them aligned.
		resource: { url: resourceUrl, mimeType: 'application/json' },
		accepted: accept,
		payload: { transaction: txBase64 },
	};
}

async function getAgentBalance() {
	const buyer = loadAgentKeypair();
	const conn = new Connection(SOLANA_RPC, 'confirmed');
	const sol = await conn.getBalance(buyer.publicKey);
	let usdc = 0;
	try {
		const ata = getAssociatedTokenAddressSync(
			new PublicKey(USDC_MAINNET_MINT),
			buyer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
		);
		const acct = await conn.getTokenAccountBalance(ata);
		usdc = Number(acct.value.uiAmount || 0);
	} catch (err) {
		// Missing ATA is the expected case before the demo wallet has ever held USDC.
		if (!/could not find account|TokenAccountNotFound/i.test(err?.message || '')) {
			log.warn('demo_usdc_balance_failed', { address: buyer.publicKey.toBase58(), message: err?.message });
		}
	}
	return {
		address: buyer.publicKey.toBase58(),
		sol: sol / 1e9,
		usdc,
	};
}

function sseInit(res) {
	res.statusCode = 200;
	res.setHeader('content-type', 'text/event-stream; charset=utf-8');
	res.setHeader('cache-control', 'no-cache, no-transform');
	res.setHeader('connection', 'keep-alive');
	res.setHeader('x-accel-buffering', 'no');
	if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

function sseSend(res, event, data) {
	res.write(`event: ${event}\n`);
	res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function runFlow({ tool, args, emit, buyer: buyerOverride, resourceUrl }) {
	const buyer = buyerOverride ?? loadAgentKeypair();
	const conn = new Connection(SOLANA_RPC, 'confirmed');

	const requirements = paymentRequirements();
	const accept = requirements.find((r) => r.network === NETWORK_SOLANA_MAINNET);
	if (!accept) throw Object.assign(new Error('no_solana_accept_configured'), { status: 500 });

	const t0 = Date.now();
	emit('challenge', { network: accept.network, amount: accept.amount, payTo: accept.payTo });

	const paymentPayload = await buildSolanaPaymentPayload({
		accept, buyer, conn, resourceUrl,
	});
	const tBuilt = Date.now();
	emit('built', { build_ms: tBuilt - t0, network: accept.network });

	const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');
	const verified = await verifyPayment({ paymentHeader, requirements });
	const tVerified = Date.now();
	emit('verified', { verify_ms: tVerified - tBuilt, payer: verified.payer });

	const auth = {
		userId: null,
		rateKey: `x402:${verified.payer || 'anon'}`,
		scope: '',
		source: 'x402',
		payer: verified.payer,
	};
	const rpcResp = await dispatch(buildJsonRpc(tool, args), auth, null);
	const tDispatched = Date.now();
	emit('dispatched', { dispatch_ms: tDispatched - tVerified });

	if (rpcResp?.error) {
		throw Object.assign(
			new Error(rpcResp.error.message || 'mcp_dispatch_error'),
			{ status: 502, mcpError: rpcResp.error },
		);
	}

	const settled = await settlePayment({
		paymentPayload: verified.paymentPayload,
		requirement: verified.requirement,
	});
	const tSettled = Date.now();
	emit('settled', {
		settle_ms: tSettled - tDispatched,
		tx: settled.transaction,
		network: settled.network,
		payer: settled.payer,
		explorer: settled.transaction ? `https://solscan.io/tx/${settled.transaction}` : null,
	});

	// Persist a feed entry + per-tx record for the public feed and /pay/calls/<tx>.
	const feedEntry = {
		ts: Date.now(),
		tool,
		argsSummary: summarizeArgs(args),
		tx: settled.transaction || null,
		network: settled.network || accept.network,
		amount: accept.amount,
	};
	void recordFeedEntry(feedEntry).catch((err) => {
		log.warn('feed_record_failed', { tx: settled.transaction, message: err?.message });
	});
	if (settled.transaction) {
		void persistCall(settled.transaction, {
			...feedEntry,
			args,
			result: rpcResp?.result ?? rpcResp,
			payer: verified.payer || buyer.publicKey.toBase58(),
			payTo: accept.payTo,
			asset: accept.asset,
			explorer: `https://solscan.io/tx/${settled.transaction}`,
		}).catch((err) => {
			log.warn('call_persist_failed_outer', { tx: settled.transaction, message: err?.message });
		});
	}

	const total_ms = tSettled - t0;
	emit('result', {
		ok: true,
		tool, args,
		result: rpcResp?.result ?? rpcResp,
		payment: {
			network: accept.network,
			payer: verified.payer || buyer.publicKey.toBase58(),
			payTo: accept.payTo,
			asset: accept.asset,
			amount: accept.amount,
			tx: settled.transaction || null,
			explorer: settled.transaction ? `https://solscan.io/tx/${settled.transaction}` : null,
		},
		durations: {
			build_ms: tBuilt - t0,
			verify_ms: tVerified - tBuilt,
			dispatch_ms: tDispatched - tVerified,
			settle_ms: tSettled - tDispatched,
			total_ms,
		},
	});
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;

	if (req.method === 'GET') {
		const u = new URL(req.url, 'http://x');
		if (u.searchParams.get('balance') === '1') {
			try {
				const b = await getAgentBalance();
				return json(res, 200, { configured: true, ...b });
			} catch (err) {
				// Wallet config problems are surfaced as a 200 with a flag so
				// the demo UI can render "wallet not configured" instead of a
				// red console error. Other failures still bubble as 500.
				if (err.code === 'wallet_misconfigured' || err.code === 'wallet_unconfigured') {
					return json(res, 200, { configured: false, error: err.message, address: null, sol: 0, usdc: 0 });
				}
				return json(res, err.status || 500, { error: err.message });
			}
		}
		if (u.searchParams.get('feed') === '1') {
			const limit = Math.max(1, Math.min(50, Number(u.searchParams.get('limit') || 25)));
			const items = await readFeed(limit);
			return json(res, 200, { items });
		}
		const txParam = u.searchParams.get('call');
		if (txParam) {
			const record = await readCall(txParam);
			if (!record) return json(res, 404, { error: 'call_not_found' });
			return json(res, 200, record);
		}
		if (u.searchParams.get('agents') === '1') {
			const auth = await requireAuth(req);
			if (!auth) return json(res, 401, { error: 'authentication_required' });
			const agents = await getAgentsForUser(auth.userId);
			return json(res, 200, { agents });
		}
		return json(res, 404, { error: 'not_found' });
	}
	if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

	const ip = clientIp(req);
	const ipRl = await limits.x402PayIp(ip);
	if (!ipRl.success) {
		return json(res, 429, {
			error: 'rate_limited',
			retry_after: Math.ceil((ipRl.reset - Date.now()) / 1000),
		});
	}
	const globalRl = await limits.x402PayGlobal();
	if (!globalRl.success) {
		return json(res, 429, {
			error: 'rate_limited_global',
			retry_after: Math.ceil((globalRl.reset - Date.now()) / 1000),
		});
	}

	const input = await readJson(req, 50_000);
	const tool = String(input.tool || '');
	const args = input.args && typeof input.args === 'object' ? input.args : {};
	if (!ALLOWED_TOOLS.has(tool)) {
		return json(res, 400, { error: 'invalid_tool', allowed: [...ALLOWED_TOOLS] });
	}

	// Resolve payer: agent wallet (agentId + authed) or shared showcase wallet.
	let buyer;
	if (input.agentId) {
		const auth = await requireAuth(req);
		if (!auth) return json(res, 401, { error: 'authentication_required' });
		const kp = await loadAgentKeypairForUser(String(input.agentId), auth.userId);
		if (!kp) return json(res, 403, { error: 'agent_not_found_or_no_solana_wallet' });
		buyer = kp;
	} else {
		try {
			buyer = loadAgentKeypair();
		} catch (err) {
			return json(res, 503, { error: 'config_missing', error_description: 'payment processing not available' });
		}
	}

	const wantsStream =
		(req.headers.accept || '').includes('text/event-stream') ||
		input.stream === true;
	const resourceUrl = resolveResourceUrl(req, '/api/mcp');

	if (wantsStream) {
		sseInit(res);
		const emit = (ev, data) => sseSend(res, ev, data);
		try {
			await runFlow({ tool, args, emit, buyer, resourceUrl });
		} catch (err) {
			emit('error', {
				ok: false,
				error: err.message || 'flow_failed',
				mcpError: err.mcpError || null,
			});
		} finally {
			res.end();
		}
		return;
	}

	// Non-streaming JSON path: collect events into a final envelope.
	let final = null;
	let errEnv = null;
	const emit = (ev, data) => {
		if (ev === 'result') final = data;
		else if (ev === 'error') errEnv = data;
	};
	try {
		await runFlow({ tool, args, emit, buyer, resourceUrl });
	} catch (err) {
		errEnv = { ok: false, error: err.message || 'flow_failed', mcpError: err.mcpError || null };
	}
	if (errEnv) return json(res, errEnv.mcpError ? 502 : 500, errEnv);
	return json(res, 200, final);
});
