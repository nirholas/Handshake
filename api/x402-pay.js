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
// Env (required for prod): the x402 payer keypair, resolved via loadSeedKeypair
//   from X402_SEED_SOLANA_SECRET_BASE58 (primary) then X402_AGENT_SOLANA_SECRET_BASE58
//   (fallback name) — the same wallet the x402 ring pays from (see solana-signers.js
//   x402-ring-payer). Accepts base58 / base64 / JSON-array encodings.
// Local dev fallback (NODE_ENV !== 'production' only): reads keypair JSON at
//   /home/codespace/.config/x402-test-wallets/solana.json
//
// Also: GET /api/x402-pay?balance=1 → returns the agent wallet's USDC + SOL
// balance so the UI can show it ticking down during the demo.

import { solanaConnection } from './_lib/solana/connection.js';
import {
	PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram,
} from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync, createTransferCheckedInstruction,
	createAssociatedTokenAccountIdempotentInstruction,
	TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { mintDecimals, ataExists, getRecentBlockhash, isRpcUnavailable, RPC_RETRY_AFTER_SECONDS } from './_lib/solana/read-guards.js';
import { cors, json, readJson, wrap, rateLimited, setRateLimitHeaders, respondError } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { requireCsrf } from './_lib/csrf.js';
import {
	paymentRequirements,
	verifyPayment,
	settlePayment,
	resolveResourceUrl,
	NETWORK_SOLANA_MAINNET,
} from './_lib/x402-spec.js';
import { loadSeedKeypair } from './_lib/x402/pay.js';
import { dispatch } from './_mcp/dispatch.js';
import { env } from './_lib/env.js';
import { getRedis as _getSharedRedis } from './_lib/redis.js';
import { sql } from './_lib/db.js';
import { thumbnailUrl } from './_lib/r2.js';
import { logger } from './_lib/usage.js';
import { getSessionUser, authenticateBearer, extractBearer } from './_lib/auth.js';
import { recoverSolanaAgentKeypair } from './_lib/agent-wallet.js';
import { SpendLimitError, reserveSpendUsd, updateCustodyEvent, releaseSpendReservation } from './_lib/agent-trade-guards.js';
import { validatePublicUrl, resolvePublicHost, pinnedAgent, SsrfError } from './_lib/ssrf.js';
import { BUILDER_CODE } from './_lib/x402-builder-code.js';

const log = logger('x402-pay');

// ---- Persistent feed of recent paid calls -------------------------------
// Backed by Upstash Redis when available; falls back to an in-memory ring
// in dev so the feed still works locally.
const FEED_KEY = 'x402:pay:feed';
const FEED_MAX = 50;
const memFeed = [];

function redis() { return _getSharedRedis(); }

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
	feedReadCache = null; // a new payment must show up on the next read
	memFeed.unshift(entry);
	if (memFeed.length > FEED_MAX) memFeed.length = FEED_MAX;
}

// The feed is polled by several always-on surfaces (the /pay page, the in-world
// jumbotron and exchange NPCs), and every poll used to spend a Redis LRANGE.
// That steady drip was a top contributor to exhausting the Upstash monthly
// request quota (June 2026). One instance-local snapshot per FEED_CACHE_TTL_MS,
// with in-flight coalescing, collapses all of it to ≤ one command per window —
// a few seconds of staleness on a public activity feed is invisible.
const FEED_CACHE_TTL_MS = 10_000;
let feedReadCache = null; // { at: epoch-ms, rows: entry[] }
let feedReadInflight = null;

async function readFeed(limit = 25) {
	const r = redis();
	if (r) {
		if (feedReadCache && Date.now() - feedReadCache.at < FEED_CACHE_TTL_MS) {
			return feedReadCache.rows.slice(0, limit);
		}
		// The inflight promise must never reject: both the originating call and any
		// coalesced waiters await it, and an unhandled rejection on a Redis outage
		// (e.g. WRONGPASS) would otherwise surface as a 500 instead of degrading to
		// the in-memory feed. Catch inside and fall back here.
		if (!feedReadInflight) {
			feedReadInflight = (async () => {
				try {
					const raw = await r.lrange(FEED_KEY, 0, FEED_MAX - 1);
					const rows = raw
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
					feedReadCache = { at: Date.now(), rows };
					return rows;
				} catch (err) {
					if (!err?.circuitOpen) log.warn('feed_read_failed', { message: err?.message });
					return memFeed.slice();
				} finally {
					feedReadInflight = null;
				}
			})();
		}
		const rows = await feedReadInflight;
		return rows.slice(0, limit);
	}
	return memFeed.slice(0, limit);
}

// Per-tx record so /pay/calls/<tx> can show the full receipt + tool result.
// A Solana signature is 64 bytes of base58 (86-88 chars); the bound is generous
// enough for any real signature and tight enough that the Redis key stays bounded.
export const TX_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{32,128}$/;
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

// Decide which wallet signs an x402 payment. An agent context — an `agentId`
// on the request, which the wallet hub always sends and any authenticated owner
// call carries — ALWAYS pays from that agent's own custodial wallet. The shared
// platform wallet (X402_AGENT_SOLANA_SECRET_BASE58) is an explicit fallback for
// platform-level/demo calls that carry no agent context. The handler logs that
// fallback so a regression where an agent call drops its agentId is visible in
// the logs instead of silently spending the shared wallet on the agent's behalf.
export function resolvePayerRouting(input) {
	const agentId = input && input.agentId ? String(input.agentId) : '';
	if (agentId) return { mode: 'agent', agentId };
	return { mode: 'platform' };
}

async function loadAgentKeypairForUser(agentId, userId) {
	const [row] = await sql`
		SELECT id, meta FROM agent_identities
		WHERE id = ${agentId} AND user_id = ${userId} AND deleted_at IS NULL
	`;
	if (!row) return null;
	const enc = row.meta?.encrypted_solana_secret;
	if (!enc) return null;
	const keypair = await recoverSolanaAgentKeypair(enc, {
		agentId,
		userId,
		reason: 'x402_pay_tool_call',
	});
	// Carry the agent meta so the caller can enforce + record against the shared
	// per-agent spend policy without a second DB round-trip.
	return { keypair, meta: row.meta || {} };
}

async function getAgentsForUser(userId) {
	const rows = await sql`
		SELECT i.id, i.name, i.description, i.avatar_id, i.meta,
		       a.thumbnail_key AS avatar_thumbnail_key,
		       a.visibility    AS avatar_visibility
		FROM agent_identities i
		LEFT JOIN avatars a ON a.id = i.avatar_id AND a.deleted_at IS NULL
		WHERE i.user_id = ${userId} AND i.deleted_at IS NULL
		ORDER BY i.created_at ASC
	`;
	const conn = solanaConnection({ url: SOLANA_RPC, commitment: 'confirmed' });
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
		// Thumbnails carry the same public/unlisted gate as everywhere else
		// (api/agents.js, characters.js): a private avatar's R2 object is not
		// publicly readable, so emitting its URL only paints a broken image.
		// Null lets the card fall back to the initial-letter avatar it already
		// renders as a sibling.
		const avatarPubliclyReadable =
			row.avatar_visibility === 'public' || row.avatar_visibility === 'unlisted';
		return {
			id: row.id,
			name: row.name,
			description: row.description,
			avatar_id: row.avatar_id,
			avatar_thumbnail_url:
				row.avatar_thumbnail_key && avatarPubliclyReadable
					? thumbnailUrl(row.avatar_thumbnail_key)
					: null,
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

// In-house x402 routes the public showcase pages buy from the shared platform
// wallet (/agent-exchange drives the crypto-intel one). This branch is
// unauthenticated, exactly like the MCP `tool` path above, and it spends real
// USDC per call, so what it can buy is a fixed server-side allowlist and never
// a caller-supplied URL. Arbitrary endpoints go through handleExternalPay,
// which is owner-authenticated and pays from that owner's own agent wallet.
const SHOWCASE_ENDPOINTS = new Set(['/api/x402/crypto-intel']);

const SOLANA_RPC = env.SOLANA_RPC_URL;
const USDC_MAINNET_MINT = env.X402_ASSET_MINT_SOLANA;

let _agent = null;
function loadAgentKeypair() {
	if (_agent) return _agent;
	// Single source of truth for the x402 payer keypair: loadSeedKeypair honors
	// the registry's declared chain (X402_SEED_SOLANA_SECRET_BASE58 first, then
	// the X402_AGENT_SOLANA_SECRET_BASE58 fallback name — see solana-signers.js
	// x402-ring-payer), auto-detects base58/base64/JSON encodings, and reads the
	// dev test keypair off disk when NODE_ENV !== 'production'. Reusing it keeps
	// this endpoint on the same wallet as the ring payer instead of a second,
	// separately-configured key.
	try {
		_agent = loadSeedKeypair();
		return _agent;
	} catch (err) {
		const e = new Error(err?.message || 'x402 agent wallet not configured');
		e.status = 503;
		e.code = /undecodable/i.test(err?.message || '') ? 'wallet_misconfigured' : 'wallet_unconfigured';
		e.cause = err;
		throw e;
	}
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
	// Guarded reads (api/_lib/solana/read-guards.js): USDC decimals never touch the
	// network, the ATA probe fails open to an idempotent create, and the blockhash
	// is served from cache inside its validity window when every RPC lane is down.
	// What still fails throws a typed 503 rpc_unavailable; no funds have moved yet.
	const decimals = await mintDecimals(conn, mint);

	const ixs = [
		ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
		ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
	];
	if (!(await ataExists(conn, receiverAta))) {
		ixs.push(createAssociatedTokenAccountIdempotentInstruction(
			feePayer, receiverAta, payTo, mint,
			TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
		));
	}
	ixs.push(createTransferCheckedInstruction(
		senderAta, mint, receiverAta, buyer.publicKey,
		amount, decimals, [], TOKEN_PROGRAM_ID,
	));

	const blockhash = await getRecentBlockhash(conn, SOLANA_RPC);
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

// ── External x402 endpoint pay (wallet hub "Pay" tab) ─────────────────────
// Pays an ARBITRARY x402 endpoint discovered via the bazaar from the agent's
// own Solana wallet. Distinct from runFlow (which pays the platform's own MCP):
// here the 402 challenge, payTo, asset and feePayer all come from the external
// resource server, and that server — not us — verifies + settles. We only build
// and sign the SPL transfer with the agent key and present it as X-PAYMENT.

// A paid flow makes TWO sequential calls to the external resource server (the 402
// probe, then the X-PAYMENT settle) plus on-chain blockhash + settlement work, all
// inside the function's 60s ceiling. At the old 30s-per-fetch budget two slow
// probes alone consumed the entire window, leaving nothing for settlement and
// surfacing a 504 instead of a clean, retryable timeout. 20s still tolerates a
// genuinely slow-but-alive server while leaving room for the second call + Solana.
const EXTERNAL_FETCH_TIMEOUT_MS = 20_000;

// SSRF-guarded one-shot fetch of an untrusted URL: https-only (http in dev),
// DNS resolved + checked against the private-range blocklist, the socket pinned
// to the validated addresses (closes the DNS-rebinding TOCTOU), redirects never
// followed into an internal target. Returns { status, ok, headers, text }.
// Throws SsrfError on a blocked target.
async function guardedFetch(rawUrl, { method = 'GET', headers = {}, body } = {}) {
	const url = validatePublicUrl(rawUrl);
	const addrs = await resolvePublicHost(url.hostname);
	const agent = pinnedAgent(url.hostname, addrs);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), EXTERNAL_FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			method,
			redirect: 'manual',
			signal: controller.signal,
			dispatcher: agent,
			headers: {
				'user-agent': '3d-agent-x402/1.0 (+https://three.ws/)',
				accept: 'application/json, text/plain;q=0.8, */*;q=0.5',
				...(body != null ? { 'content-type': 'application/json' } : {}),
				...headers,
			},
			...(body != null
				? { body: typeof body === 'string' ? body : JSON.stringify(body) }
				: {}),
		});
		const text = await res.text();
		return { status: res.status, ok: res.ok, headers: res.headers, text };
	} finally {
		clearTimeout(timer);
		await agent.close().catch(() => {});
	}
}

// Hostname of a URL (or null) — used as the scoped-capability holder ref / target
// host for x402 payments, so an owner can leash an integration to specific services.
function hostOf(u) {
	try { return new URL(String(u)).hostname || null; } catch { return null; }
}

function safeJsonParse(text) {
	if (typeof text !== 'string' || !text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function b64decodeJson(s) {
	if (!s) return null;
	try {
		return JSON.parse(Buffer.from(String(s), 'base64').toString('utf8'));
	} catch {
		return null;
	}
}

// Probe an external x402 endpoint for its payment requirements WITHOUT paying.
// Returns the parsed 402 challenge + the Solana accept (the only network an
// agent wallet can pay), { free: true } when the endpoint served a result
// without a 402, or { unsupported: true, networks } when it has no Solana accept.
async function probeExternalRequirements({ url, method, body }) {
	let res;
	try {
		res = await guardedFetch(url, { method, body });
	} catch (err) {
		if (err instanceof SsrfError) {
			throw Object.assign(new Error('that endpoint is not a reachable public https URL'), {
				status: 400,
				code: 'blocked_url',
			});
		}
		throw Object.assign(
			new Error(`could not reach the service: ${err?.message || 'network error'}`),
			{ status: 502, code: 'endpoint_unreachable' },
		);
	}
	if (res.status !== 402) {
		// The endpoint returned without challenging for payment — nothing to pay.
		return { free: true, status: res.status, result: safeJsonParse(res.text) ?? res.text };
	}
	const challenge = safeJsonParse(res.text) || b64decodeJson(res.headers.get('payment-required'));
	if (!challenge || !Array.isArray(challenge.accepts)) {
		throw Object.assign(new Error('the service returned an unreadable payment challenge'), {
			status: 502,
			code: 'invalid_challenge',
		});
	}
	const solAccept = challenge.accepts.find(
		(a) => typeof a?.network === 'string' && a.network.startsWith('solana'),
	);
	if (!solAccept) {
		const networks = [...new Set(challenge.accepts.map((a) => a?.network).filter(Boolean))];
		return { unsupported: true, networks, challenge };
	}
	// Pin the asset to the configured Solana USDC mint. Without this an external
	// server could name ANY SPL token as `asset` (e.g. one the agent holds) and we
	// would sign a transferChecked of THAT token — draining the wallet — while the
	// USD spend cap (which divides amount by 1e6 assuming 6-decimal USDC) badly
	// mis-counts a non-USDC charge. Refuse anything that isn't the known USDC mint.
	if (!USDC_MAINNET_MINT || solAccept.asset !== USDC_MAINNET_MINT) {
		throw Object.assign(
			new Error('this service requested payment in a non-USDC asset; agent wallets only pay Solana USDC'),
			{
				status: 422,
				code: 'unsupported_asset',
				detail: { asset: solAccept.asset ?? null, expected: USDC_MAINNET_MINT ?? null },
			},
		);
	}
	const resource =
		challenge.resource && typeof challenge.resource === 'object'
			? challenge.resource
			: { url: typeof challenge.resource === 'string' ? challenge.resource : url };
	return { challenge, accept: solAccept, resource };
}

// Echo the builder-code app tag the challenge declared so the external server's
// on-chain attribution is honoured (mirrors x402-buyer-fetch.ensureBuilderCodeEcho).
function echoBuilderCode(challenge, paymentPayload) {
	const declaredA = challenge?.extensions?.[BUILDER_CODE]?.info?.a;
	if (!declaredA) return paymentPayload;
	const existing = paymentPayload.extensions || {};
	const block = { ...(existing[BUILDER_CODE] || {}), a: declaredA };
	if (env.X402_BUILDER_CODE_WALLET && !block.w) block.w = env.X402_BUILDER_CODE_WALLET;
	paymentPayload.extensions = { ...existing, [BUILDER_CODE]: block };
	return paymentPayload;
}

// Summarize the resource a probe surfaced for the SSE 'challenge'/'result' events
// and the spend ledger — never trust raw fields into innerHTML on the client.
function resourceSummary(probe, fallbackUrl) {
	const r = probe.resource || {};
	return {
		url: r.url || fallbackUrl,
		description: typeof r.description === 'string' ? r.description : null,
		serviceName: typeof r.serviceName === 'string' ? r.serviceName : null,
	};
}

// Run the full external-endpoint pay flow, emitting the same SSE event vocabulary
// the internal flow uses (challenge → built → settled → result) so the client can
// render one progress timeline. `buyer` is the agent's recovered keypair.
async function runExternalFlow({ url, method, body, emit, buyer, spendGuard, serviceLabel }) {
	const conn = solanaConnection({ url: SOLANA_RPC, commitment: 'confirmed' });

	const probe = await probeExternalRequirements({ url, method, body });
	if (probe.free) {
		emit('result', { ok: true, free: true, result: probe.result, payment: null });
		return;
	}
	if (probe.unsupported) {
		throw Object.assign(
			new Error('this service does not accept Solana USDC — agent wallets pay in Solana USDC'),
			{ status: 422, code: 'no_solana_accept', detail: { networks: probe.networks } },
		);
	}
	const accept = probe.accept;
	if (!accept.extra?.feePayer) {
		throw Object.assign(
			new Error('the service did not advertise a Solana fee payer, so it cannot be paid from here'),
			{ status: 422, code: 'missing_fee_payer' },
		);
	}
	const resource = resourceSummary(probe, url);
	const spendUsd = Number(accept.amount) / 1e6;
	const t0 = Date.now();
	emit('challenge', {
		network: accept.network,
		amount: accept.amount,
		asset: accept.asset,
		payTo: accept.payTo,
		price_usdc: spendUsd,
		resource,
	});

	// Per-agent spend policy — enforced BEFORE the payment is built/signed so a
	// breach moves no funds. reserveSpendUsd atomically checks the cap AND writes a
	// pending ledger row under a per-agent lock, so concurrent calls can't all pass
	// the same stale daily total and overspend the cap. Finalize/release below.
	let spendReservationId = null;
	if (spendGuard) {
		try {
			const reservation = await reserveSpendUsd({
				agentId: spendGuard.agentId,
				userId: spendGuard.userId,
				meta: spendGuard.meta,
				category: 'x402',
				usdValue: spendUsd,
				destination: accept.payTo,
				network: 'mainnet',
				asset: 'USDC',
				// Scoped session keys: the service URL is the capability target (a
				// service-scoped grant matches on its host), and the host is the holder
				// ref so a per-integration capability resolves preferentially.
				target: resource.url || url,
				capabilityHolderRef: hostOf(resource.url || url),
				rowMeta: { url, service: serviceLabel || resource.serviceName || null, resource: resource.url },
			});
			spendReservationId = reservation.reservationId;
		} catch (e) {
			if (e instanceof SpendLimitError) {
				throw Object.assign(new Error(e.message), { status: e.status, code: e.code, detail: e.detail });
			}
			throw e;
		}
	}

	const paymentPayload = await buildSolanaPaymentPayload({
		accept,
		buyer,
		conn,
		resourceUrl: resource.url,
	});
	echoBuilderCode(probe.challenge, paymentPayload);
	const tBuilt = Date.now();
	emit('built', { build_ms: tBuilt - t0 });

	const xPayment = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');
	let paid;
	try {
		paid = await guardedFetch(url, { method, body, headers: { 'X-PAYMENT': xPayment } });
	} catch (err) {
		// The signed payment went out but we never saw the response — the chain
		// state is unknown, so do NOT promise the wallet was untouched.
		throw Object.assign(
			new Error('the payment was submitted but its status could not be confirmed — check the wallet activity before retrying'),
			{ status: 502, code: 'settle_uncertain', cause: err },
		);
	}
	const paidJson = safeJsonParse(paid.text) ?? paid.text;
	if (!paid.ok) {
		if (paid.status === 402) {
			// Explicit pre-settlement rejection: no funds moved, so release the
			// reservation — it must not count toward the daily cap. (The
			// settle_uncertain path below deliberately KEEPS the reservation:
			// chain state is unknown, so we conservatively count it as spent.)
			if (spendReservationId) await releaseSpendReservation(spendReservationId, 'payment_rejected_402');
			throw Object.assign(
				new Error('the service rejected the payment before settlement; no funds were transferred'),
				{ status: 402, code: 'payment_required', detail: typeof paidJson === 'object' ? paidJson : null },
			);
		}
		throw Object.assign(
			new Error(`the service returned an error after payment (HTTP ${paid.status}); check the wallet activity before retrying`),
			{ status: 502, code: 'settle_uncertain', detail: typeof paidJson === 'object' ? paidJson : null },
		);
	}
	const settled = b64decodeJson(paid.headers.get('x-payment-response'));
	const tx = settled?.transaction || null;
	const payer = settled?.payer || buyer.publicKey.toBase58();
	const tSettled = Date.now();
	emit('settled', {
		settle_ms: tSettled - tBuilt,
		tx,
		network: settled?.network || accept.network,
		payer,
		explorer: tx ? `https://solscan.io/tx/${tx}` : null,
	});

	// Finalize the pending reservation written before signing: flip it to
	// confirmed/ok and attach the tx signature. It already counts toward the daily
	// cap (written under the advisory lock), so this just records the outcome.
	if (spendReservationId) {
		void updateCustodyEvent(spendReservationId, {
			status: tx ? 'confirmed' : 'ok',
			signature: tx,
			meta: { settledAt: new Date(tSettled).toISOString() },
		}).catch((err) => log.warn('x402_external_spend_record_failed', { message: err?.message }));
	}

	emit('result', {
		ok: true,
		result: paidJson,
		payment: {
			network: settled?.network || accept.network,
			payer,
			payTo: accept.payTo,
			asset: accept.asset,
			amount: accept.amount,
			tx,
			explorer: tx ? `https://solscan.io/tx/${tx}` : null,
		},
		receipt: settled,
		resource,
		durations: { build_ms: tBuilt - t0, settle_ms: tSettled - tBuilt, total_ms: tSettled - t0 },
	});
}

async function getAgentBalance() {
	const buyer = loadAgentKeypair();
	const conn = solanaConnection({ url: SOLANA_RPC, commitment: 'confirmed' });
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

async function runFlow({ tool, args, emit, buyer: buyerOverride, resourceUrl, spendGuard = null }) {
	const buyer = buyerOverride ?? loadAgentKeypair();
	const conn = solanaConnection({ url: SOLANA_RPC, commitment: 'confirmed' });

	const requirements = paymentRequirements();
	const accept = requirements.find((r) => r.network === NETWORK_SOLANA_MAINNET);
	if (!accept) throw Object.assign(new Error('no_solana_accept_configured'), { status: 500 });

	// Per-agent spend policy — enforced BEFORE any payment is built/signed so a
	// breach moves no funds. USDC is dollar-denominated (6 decimals), so the
	// payment amount converts straight to the USD ceiling unit.
	const spendUsd = Number(accept.amount) / 1e6;
	let spendReservationId = null;
	if (spendGuard) {
		try {
			const reservation = await reserveSpendUsd({
				agentId: spendGuard.agentId,
				userId: spendGuard.userId,
				meta: spendGuard.meta,
				category: 'x402',
				usdValue: spendUsd,
				destination: accept.payTo,
				network: spendGuard.network || 'mainnet',
				asset: 'USDC',
				// Scoped session keys: the resolved MCP resource is the capability target.
				target: resourceUrl,
				capabilityHolderRef: hostOf(resourceUrl),
				rowMeta: { tool },
			});
			spendReservationId = reservation.reservationId;
		} catch (e) {
			if (e instanceof SpendLimitError) {
				throw Object.assign(new Error(e.message), { status: e.status, code: e.code, detail: e.detail });
			}
			throw e;
		}
	}

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
		// Dispatch failed before settlement — no funds moved, release the reservation.
		if (spendReservationId) await releaseSpendReservation(spendReservationId, 'mcp_dispatch_error');
		throw Object.assign(
			new Error(rpcResp.error.message || 'mcp_dispatch_error'),
			{ status: 502, mcpError: rpcResp.error },
		);
	}

	const settled = await settlePayment({ verified });
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
	// Finalize the pending reservation written before signing: it already counts
	// toward the daily cap (reserved under the advisory lock); attach the outcome.
	if (spendReservationId) {
		void updateCustodyEvent(spendReservationId, {
			status: settled.transaction ? 'confirmed' : 'ok',
			signature: settled.transaction || null,
		}).catch((err) => log.warn('x402_spend_record_failed', { message: err?.message }));
	}
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

// Build the client-facing envelope for a failed payment flow. Carries the
// upstream status/code through (so a facilitator 5xx surfaces as 502, an
// invalid/under-paid payment as 402, an MCP tool error as 502) and adds an
// honest charging note: a flow that never reached on-chain settlement moved no
// funds, while a post-settlement mismatch is ambiguous and must not promise the
// wallet was untouched.
function payErrorEnvelope(err) {
	const code = err?.code || (err?.mcpError ? 'mcp_dispatch_error' : 'flow_failed');
	let error_description;
	if (code === 'facilitator_unreachable' || code === 'facilitator_error' || code === 'settle_failed') {
		error_description = 'Payment could not be completed and no funds were transferred from the agent wallet. Please try again.';
	} else if (code === 'facilitator_bad_response' || code === 'settle_uncertain') {
		error_description = 'Payment status could not be confirmed. Check the payment activity before retrying to avoid paying twice.';
	} else if (code === 'no_solana_accept' || code === 'missing_fee_payer' || code === 'endpoint_unreachable' || code === 'invalid_challenge' || code === 'blocked_url') {
		error_description = 'No payment was attempted, so no funds were transferred from the agent wallet.';
	} else if (code === 'invalid_payment' || code === 'payment_required' || code === 'builder_code_tampered') {
		error_description = 'The payment was rejected before settlement; no funds were transferred.';
	} else if (code === 'rpc_unavailable') {
		error_description = 'The Solana RPC is temporarily unavailable, so the payment could not be built. No funds were transferred; retry shortly.';
	}
	const envelope = {
		ok: false,
		error: err?.message || 'flow_failed',
		code,
		mcpError: err?.mcpError || null,
	};
	if (error_description) envelope.error_description = error_description;
	return envelope;
}

// Map a flow error to its HTTP status. X402Error carries an explicit `status`
// (402 rejected payment, 502 facilitator/upstream); MCP dispatch errors are
// 502; everything else is an unexpected 500.
function payErrorStatus(err) {
	if (Number.isInteger(err?.status)) return err.status;
	if (err?.mcpError) return 502;
	return 500;
}

// Response headers for a flow error: an RPC outage advertises Retry-After so
// callers and CDNs back off instead of hammering a dead chain.
function payErrorHeaders(err) {
	return isRpcUnavailable(err) ? { 'retry-after': String(RPC_RETRY_AFTER_SECONDS) } : {};
}

// Buy one of the in-house SHOWCASE_ENDPOINTS from the shared platform wallet and
// stream the payment lifecycle. This is what /agent-exchange runs: the two 3D
// avatars are a view over a real x402 purchase of /api/x402/crypto-intel, so the
// flow here is the same probe → sign → settle path an external agent would take
// against the same public route. Unauthenticated by design (a viewer has no
// wallet), bounded by the per-IP and global rate limits already applied on the
// POST path plus the platform wallet's own balance.
async function handleShowcasePay(req, res, input, ip) {
	const endpoint = String(input.endpoint || '');
	if (!SHOWCASE_ENDPOINTS.has(endpoint)) {
		log.warn('showcase_endpoint_rejected', { endpoint: endpoint.slice(0, 120), ip });
		return json(res, 400, {
			error: 'invalid_endpoint',
			error_description: 'that endpoint is not payable from the showcase wallet',
			allowed: [...SHOWCASE_ENDPOINTS],
		});
	}

	let buyer;
	try {
		buyer = loadAgentKeypair();
	} catch {
		return json(res, 503, {
			error: 'config_missing',
			error_description: 'payment processing not available',
		});
	}

	const url = resolveResourceUrl(req, endpoint);
	const body = input.body && typeof input.body === 'object' ? input.body : {};
	const wantsStream =
		(req.headers.accept || '').includes('text/event-stream') || input.stream === true;

	// No spendGuard: the platform wallet has no per-agent daily policy to charge
	// against. The rate limiters upstream are the ceiling for this path.
	const flowArgs = {
		url,
		method: 'POST',
		body,
		buyer,
		spendGuard: null,
		serviceLabel: typeof input.service_label === 'string' ? input.service_label : null,
	};

	if (wantsStream) {
		sseInit(res);
		const emit = (ev, data) => sseSend(res, ev, data);
		try {
			await runExternalFlow({ ...flowArgs, emit });
		} catch (err) {
			emit('error', payErrorEnvelope(err));
		} finally {
			res.end();
		}
		return;
	}

	let final = null;
	const emit = (ev, data) => {
		if (ev === 'result') final = data;
	};
	try {
		await runExternalFlow({ ...flowArgs, emit });
	} catch (err) {
		return json(res, payErrorStatus(err), payErrorEnvelope(err), payErrorHeaders(err));
	}
	return json(res, 200, final);
}

// Pay an arbitrary external x402 endpoint from the owner's agent wallet. This is
// the money core behind the wallet hub Pay tab. Owner-authenticated + ownership-
// gated; the agent key is decrypted server-side via recoverSolanaAgentKeypair
// (audit-logged) and never leaves the server. Two modes:
//   { preview: true } — probe requirements only (no funds moved, no key signs).
//   default           — full pay; SSE-streams progress when the client asks.
async function handleExternalPay(req, res, input, ip) {
	const auth = await requireAuth(req);
	if (!auth) return json(res, 401, { error: 'authentication_required' });
	const agentId = input.agentId ? String(input.agentId) : '';
	if (!agentId) {
		// An external pay with no agent context would have no wallet to pay from —
		// never silently reach for the shared platform wallet here.
		log.warn('external_pay_missing_agent', { ip });
		return json(res, 400, {
			error: 'agent_required',
			error_description: 'paying a service requires an agent context',
		});
	}

	const loaded = await loadAgentKeypairForUser(agentId, auth.userId);
	if (!loaded) return json(res, 403, { error: 'agent_not_found_or_no_solana_wallet' });

	const method =
		typeof input.method === 'string' && /^(GET|POST|PUT|PATCH|DELETE)$/i.test(input.method)
			? input.method.toUpperCase()
			: 'GET';
	const body = input.body != null ? input.body : undefined;

	// Preview: surface the live price + what's being bought before the owner
	// confirms. Moves no funds.
	if (input.preview === true) {
		try {
			const probe = await probeExternalRequirements({ url: input.url, method, body });
			if (probe.free) {
				return json(res, 200, { ok: true, requires_payment: false, status: probe.status });
			}
			if (probe.unsupported) {
				return json(res, 200, {
					ok: true,
					requires_payment: true,
					payable: false,
					code: 'no_solana_accept',
					networks: probe.networks,
				});
			}
			const accept = probe.accept;
			const resource = resourceSummary(probe, input.url);
			return json(res, 200, {
				ok: true,
				requires_payment: true,
				payable: !!accept.extra?.feePayer,
				...(accept.extra?.feePayer ? {} : { code: 'missing_fee_payer' }),
				network: accept.network,
				amount: accept.amount,
				asset: accept.asset,
				payTo: accept.payTo,
				price_usdc: Number(accept.amount) / 1e6,
				resource,
				method,
			});
		} catch (err) {
			return json(res, payErrorStatus(err), payErrorEnvelope(err), payErrorHeaders(err));
		}
	}

	// CSRF on the settle path (funds move + the agent key signs). The preview branch
	// above returns before this point, so a live price probe never burns a token.
	// Bearer/API-key callers are exempt inside requireCsrf.
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const spendGuard = { agentId, userId: auth.userId, meta: loaded.meta, network: 'mainnet' };
	const wantsStream =
		(req.headers.accept || '').includes('text/event-stream') || input.stream === true;

	if (wantsStream) {
		sseInit(res);
		const emit = (ev, data) => sseSend(res, ev, data);
		try {
			await runExternalFlow({
				url: input.url,
				method,
				body,
				emit,
				buyer: loaded.keypair,
				spendGuard,
				serviceLabel: typeof input.service_label === 'string' ? input.service_label : null,
			});
		} catch (err) {
			emit('error', payErrorEnvelope(err));
		} finally {
			res.end();
		}
		return;
	}

	let final = null;
	const emit = (ev, data) => {
		if (ev === 'result') final = data;
	};
	try {
		await runExternalFlow({
			url: input.url,
			method,
			body,
			emit,
			buyer: loaded.keypair,
			spendGuard,
			serviceLabel: typeof input.service_label === 'string' ? input.service_label : null,
		});
	} catch (err) {
		return json(res, payErrorStatus(err), payErrorEnvelope(err), payErrorHeaders(err));
	}
	return json(res, 200, final);
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
					return json(res, 200, { configured: false, code: err.code, error: err.message, address: null, sol: 0, usdc: 0 });
				}
				// A balance read failure here is a Solana RPC fault, and web3.js
				// embeds the keyed RPC URL in its error text, so the raw message
				// must never reach the client. respondError sanitizes the 5xx to a
				// support ref (and still passes a 4xx client-fault message through).
				return respondError(res, err.status || 500, err.code || 'balance_unavailable', err);
			}
		}
		if (u.searchParams.get('feed') === '1') {
			const limit = Math.max(1, Math.min(50, Number(u.searchParams.get('limit') || 25)));
			const items = await readFeed(limit);
			return json(res, 200, { items });
		}
		const txParam = u.searchParams.get('call');
		if (txParam) {
			// The lookup key is a Solana transaction signature. Shape-check it before
			// it becomes a Redis key: an unbounded caller-controlled suffix turns a
			// public GET into arbitrary key reads against the Upstash request budget
			// this feed already had to be rewritten to protect (see readFeed above).
			if (!TX_SIGNATURE_RE.test(txParam)) {
				return json(res, 400, { error: 'invalid_call', error_description: 'call must be a base58 transaction signature' });
			}
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
		return rateLimited(res, ipRl);
	}
	const globalRl = await limits.x402PayGlobal();
	if (!globalRl.success) {
		// Distinct code from the per-IP limit so the demo UI can tell a global
		// budget exhaustion apart from a single caller's burst. Headers are the
		// same standard shape as rateLimited().
		const retryAfter = Math.max(1, setRateLimitHeaders(res, globalRl));
		res.setHeader('retry-after', String(retryAfter));
		return json(res, 429, { error: 'rate_limited_global', retry_after: retryAfter });
	}

	const input = await readJson(req, 50_000);

	// External x402 endpoint pay (wallet hub Pay tab): a target `url` means an
	// arbitrary bazaar service paid from the agent's OWN wallet — never the shared
	// platform wallet. Owner-authenticated, per-agent spend policy enforced.
	if (typeof input.url === 'string' && input.url) {
		return handleExternalPay(req, res, input, ip);
	}

	// Showcase pay: an in-house /api/x402/* route bought from the platform wallet
	// for a public demo page. Allowlisted server-side (SHOWCASE_ENDPOINTS).
	if (typeof input.endpoint === 'string' && input.endpoint) {
		return handleShowcasePay(req, res, input, ip);
	}

	const tool = String(input.tool || '');
	const args = input.args && typeof input.args === 'object' ? input.args : {};
	if (!ALLOWED_TOOLS.has(tool)) {
		return json(res, 400, { error: 'invalid_tool', allowed: [...ALLOWED_TOOLS] });
	}

	// Resolve payer. An agent context (agentId) ALWAYS pays from that agent's own
	// wallet; the shared showcase wallet is the explicit, logged fallback for
	// platform/demo calls with no agent context (see resolvePayerRouting).
	const routing = resolvePayerRouting(input);
	let buyer;
	let spendGuard = null;
	if (routing.mode === 'agent') {
		const auth = await requireAuth(req);
		if (!auth) return json(res, 401, { error: 'authentication_required' });
		const loaded = await loadAgentKeypairForUser(routing.agentId, auth.userId);
		if (!loaded) return json(res, 403, { error: 'agent_not_found_or_no_solana_wallet' });
		// CSRF: this tool call pays from the agent's own wallet. Bearer callers exempt.
		if (!(await requireCsrf(req, res, auth.userId))) return;
		buyer = loaded.keypair;
		// Per-agent spend policy applies to x402 just like trade/snipe/withdraw.
		spendGuard = { agentId: routing.agentId, userId: auth.userId, meta: loaded.meta, network: 'mainnet' };
	} else {
		// No agent context — fall back to the shared platform wallet, but log it so
		// a regression that drops agentId off an agent call is visible, not silent.
		log.warn('platform_wallet_fallback', { tool, reason: 'no_agent_context', ip });
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
			await runFlow({ tool, args, emit, buyer, resourceUrl, spendGuard });
		} catch (err) {
			emit('error', payErrorEnvelope(err));
		} finally {
			res.end();
		}
		return;
	}

	// Non-streaming JSON path: collect the result event, surface any throw with
	// its real status + honest charging guidance.
	let final = null;
	const emit = (ev, data) => {
		if (ev === 'result') final = data;
	};
	try {
		await runFlow({ tool, args, emit, buyer, resourceUrl, spendGuard });
	} catch (err) {
		return json(res, payErrorStatus(err), payErrorEnvelope(err), payErrorHeaders(err));
	}
	return json(res, 200, final);
});
