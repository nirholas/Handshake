// Cloudflare Workers mirror of /api/pump-fun-mcp (Vercel).
//
// Implements the MCP Streamable HTTP transport: POST — JSON-RPC 2.0 (single +
// batch), GET/HEAD — SSE handshake, DELETE — session terminate. Tool
// definitions (and the snake_case ↔ camelCase alias map) are shared with the
// Vercel handler via src/pump/mcp-tools.js. Handler logic is adapted from
// api/pump-fun-mcp.js — see README.md for the documented divergences (no
// auth/x402-gated tools, on-chain + indexer subset only).
//
// Secrets (wrangler secret put <NAME>):
//   SOLANA_RPC_URL          mainnet RPC endpoint (default: public)
//   SOLANA_RPC_URL_DEVNET   devnet  RPC endpoint (default: public)
//   PUMPFUN_BOT_URL         upstream indexer endpoint (optional)
//   PUMPFUN_BOT_TOKEN       bearer token for indexer (optional)
//
// Deploy: wrangler deploy

import { TOOLS, resolveToolName, rpcError, rpcEnvelope } from '../../src/pump/mcp-tools.js';

// ── Constants ────────────────────────────────────────────────────────────────

const GRADUATION_REAL_SOL_LAMPORTS = 85_000_000_000n;

// Keep in sync with api/pump-fun-mcp.js (which mirrors api/_lib/mcp-dispatch.js).
const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'pump-fun-mcp-worker', version: '1.0.0' };
const INSTRUCTIONS =
	'Free, read-only pump.fun + Solana data tools (Cloudflare Workers mirror of ' +
	'https://three.ws/api/pump-fun-mcp). Token discovery (search_tokens, ' +
	'get_trending_tokens, get_new_tokens, get_graduated_tokens, get_king_of_the_hill), ' +
	'on-chain analysis (get_bonding_curve, get_token_holders, get_token_details, ' +
	'get_token_trades), and creator intelligence (get_creator_profile). Indexer-backed ' +
	'tools are listed only when the backend is configured — call pumpfun_bot_status ' +
	'(always available) to check. All data is live and on-chain; no API keys required.';
const MAX_BATCH = 16;

const CORS_HEADERS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET,HEAD,POST,DELETE,OPTIONS',
	'access-control-allow-headers':
		'authorization, content-type, mcp-session-id, mcp-protocol-version, x-payment',
	'access-control-expose-headers': 'mcp-protocol-version',
	'access-control-max-age': '86400',
};

// ── Solana helpers (adapted for CF Workers env bindings) ─────────────────────

function getRpcUrl(env, network = 'mainnet') {
	if (network === 'devnet') {
		return env.SOLANA_RPC_URL_DEVNET || 'https://api.devnet.solana.com';
	}
	return env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
}

// ── On-chain handlers ────────────────────────────────────────────────────────

async function handleGetBondingCurve({ mint, network = 'mainnet' }, env) {
	const { Connection, PublicKey } = await import('@solana/web3.js');
	let pk;
	try {
		pk = new PublicKey(mint);
	} catch {
		throw rpcError(-32602, 'invalid mint');
	}

	const conn = new Connection(getRpcUrl(env, network), 'confirmed');
	const { OnlinePumpSdk, PumpSdk } = await import('@pump-fun/pump-sdk');

	let curve;
	try {
		const sdk = new OnlinePumpSdk(conn);
		if (sdk.fetchBuyState) {
			const state = await sdk.fetchBuyState(pk, pk);
			curve = state.bondingCurve;
		} else if (sdk.fetchBondingCurve) {
			curve = await sdk.fetchBondingCurve(pk);
		}
		if (!curve) {
			const sdk2 = new PumpSdk(conn);
			if (sdk2.fetchBondingCurve) curve = await sdk2.fetchBondingCurve(pk);
		}
	} catch (e) {
		throw rpcError(-32004, `bonding curve unavailable: ${e?.message || 'unknown'}`);
	}
	if (!curve) throw rpcError(-32004, 'no bonding curve found for this mint');

	const realSol = BigInt(curve.realSolReserves?.toString?.() ?? '0');
	const realToken = BigInt(curve.realTokenReserves?.toString?.() ?? '0');
	const virtSol = BigInt(curve.virtualSolReserves?.toString?.() ?? '0');
	const virtToken = BigInt(curve.virtualTokenReserves?.toString?.() ?? '0');
	const complete = !!curve.complete;
	const graduationPercent = complete
		? 100
		: Number((realSol * 10000n) / GRADUATION_REAL_SOL_LAMPORTS) / 100;

	return {
		mint,
		network,
		complete,
		graduationPercent,
		solReserves: (Number(realSol) / 1e9).toFixed(4),
		tokenReserves: realToken.toString(),
		virtualSolReserves: virtSol.toString(),
		virtualTokenReserves: virtToken.toString(),
	};
}

async function handleGetTokenDetails({ mint, network = 'mainnet' }, env) {
	const { Connection, PublicKey } = await import('@solana/web3.js');
	const { MintLayout } = await import('@solana/spl-token');

	let pk;
	try {
		pk = new PublicKey(mint);
	} catch {
		throw rpcError(-32602, 'invalid mint');
	}

	const conn = new Connection(getRpcUrl(env, network), 'confirmed');
	const info = await conn.getAccountInfo(pk);
	if (!info) throw rpcError(-32004, 'mint account not found');
	const mintAccount = MintLayout.decode(info.data);

	const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
	const [metadataPda] = PublicKey.findProgramAddressSync(
		[Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), pk.toBuffer()],
		METADATA_PROGRAM,
	);
	let name = null;
	let symbol = null;
	let uri = null;
	try {
		const metaInfo = await conn.getAccountInfo(metadataPda);
		if (metaInfo) {
			const buf = Buffer.from(metaInfo.data);
			let cursor = 1 + 32 + 32;
			const readStr = (max) => {
				const len = Math.min(buf.readUInt32LE(cursor), max);
				cursor += 4;
				const slice = buf.slice(cursor, cursor + len);
				cursor += len;
				return slice.toString('utf8').replace(/\0+$/g, '').trim();
			};
			name = readStr(32);
			symbol = readStr(10);
			uri = readStr(200);
		}
	} catch {
		// Metadata is optional.
	}

	return {
		mint,
		name,
		symbol,
		uri,
		decimals: mintAccount.decimals,
		supply: mintAccount.supply.toString(),
		mintAuthority: mintAccount.mintAuthorityOption ? mintAccount.mintAuthority.toString() : null,
		freezeAuthority: mintAccount.freezeAuthorityOption
			? mintAccount.freezeAuthority.toString()
			: null,
	};
}

async function handleGetTokenHolders({ mint, limit = 10, network = 'mainnet' }, env) {
	const { Connection, PublicKey } = await import('@solana/web3.js');

	let pk;
	try {
		pk = new PublicKey(mint);
	} catch {
		throw rpcError(-32602, 'invalid mint');
	}

	const conn = new Connection(getRpcUrl(env, network), 'confirmed');
	let largest;
	try {
		largest = await conn.getTokenLargestAccounts(pk);
	} catch (e) {
		throw rpcError(-32004, `holders unavailable: ${e?.message || 'rpc error'}`);
	}
	const accounts = (largest?.value || []).slice(0, Math.min(20, Math.max(1, limit)));
	const total = accounts.reduce((sum, a) => sum + Number(a.uiAmount || 0), 0);
	const holders = accounts.map((a) => ({
		address: a.address.toString(),
		amount: a.amount,
		uiAmount: a.uiAmount,
		percent: total > 0 ? (Number(a.uiAmount || 0) / total) * 100 : 0,
	}));
	return {
		mint,
		count: holders.length,
		topHolderPercent: holders[0]?.percent ?? 0,
		holders,
	};
}

// ── Indexer-backed handlers ──────────────────────────────────────────────────

async function rawBotCall(tool, args, env) {
	const url = env.PUMPFUN_BOT_URL;
	if (!url) return { ok: false, error: 'PUMPFUN_BOT_URL not set' };
	const headers = { 'content-type': 'application/json', accept: 'application/json' };
	if (env.PUMPFUN_BOT_TOKEN) headers.authorization = `Bearer ${env.PUMPFUN_BOT_TOKEN}`;
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), 8000);
	try {
		const r = await fetch(url.replace(/\/$/, ''), {
			method: 'POST',
			headers,
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: tool, arguments: args || {} },
			}),
			signal: ctrl.signal,
		});
		if (!r.ok) return { ok: false, error: `bot ${r.status}` };
		const j = await r.json();
		if (j.error) return { ok: false, error: j.error.message || 'rpc error' };
		const payload = j.result?.structuredContent ?? j.result?.content ?? j.result;
		return { ok: true, data: payload };
	} catch (err) {
		return {
			ok: false,
			error: err?.name === 'AbortError' ? 'timeout' : err?.message || 'fetch failed',
		};
	} finally {
		clearTimeout(t);
	}
}

function indexerHandler(name, env) {
	return async (args) => {
		if (!env.PUMPFUN_BOT_URL) {
			throw rpcError(
				-32004,
				`tool "${name}" requires the pump.fun indexer (PUMPFUN_BOT_URL) to be configured`,
			);
		}
		// Canonical tool name → the upstream bot's (camelCase) surface.
		const upstreamMap = {
			search_tokens: { tool: 'searchTokens', args: { query: args.query, limit: args.limit } },
			get_token_trades: { tool: 'getTokenTrades', args: { mint: args.mint, limit: args.limit } },
			get_trending_tokens: { tool: 'getTrendingTokens', args: { limit: args.limit } },
			get_new_tokens: { tool: 'getNewTokens', args: { limit: args.limit } },
			get_graduated_tokens: { tool: 'getGraduatedTokens', args: { limit: args.limit } },
			get_king_of_the_hill: { tool: 'getKingOfTheHill', args: {} },
			get_creator_profile: { tool: 'getCreatorIntel', args: { wallet: args.creator } },
		};
		const upstream = upstreamMap[name];
		if (!upstream) throw rpcError(-32601, `tool "${name}" not implemented`);
		const r = await rawBotCall(upstream.tool, upstream.args, env);
		if (!r.ok) throw rpcError(-32004, r.error || 'indexer error');
		return r.data;
	};
}

// ── pumpfun_bot_status (metadata, always available) ──────────────────────────

// Reports whether the indexer is configured and, when it is, whether it's
// answering. Always available (never filtered) so MCP clients can discover
// backend capability without parsing tools/list. Mirrors the Vercel handler.
async function handlePumpfunBotStatus(_args, env) {
	if (!env.PUMPFUN_BOT_URL) {
		return {
			configured: false,
			healthy: false,
			message:
				'PUMPFUN_BOT_URL is not configured. On-chain tools are available; indexer-backed discovery tools are disabled.',
		};
	}
	const url = env.PUMPFUN_BOT_URL.replace(/\/$/, '');
	const headers = { 'content-type': 'application/json', accept: 'application/json' };
	if (env.PUMPFUN_BOT_TOKEN) headers.authorization = `Bearer ${env.PUMPFUN_BOT_TOKEN}`;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 3000);
	const startedAt = Date.now();
	try {
		const r = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'getNewTokens', arguments: { limit: 1 } },
			}),
			signal: ctrl.signal,
		});
		const latencyMs = Date.now() - startedAt;
		if (!r.ok) return { configured: true, healthy: false, latencyMs, error: `bot ${r.status}` };
		const j = await r.json().catch(() => null);
		if (j?.error)
			return { configured: true, healthy: false, latencyMs, error: j.error.message || 'rpc error' };
		return { configured: true, healthy: true, latencyMs };
	} catch (err) {
		return {
			configured: true,
			healthy: false,
			error: err?.name === 'AbortError' ? 'timeout after 3000ms' : err?.message || 'fetch failed',
		};
	} finally {
		clearTimeout(timer);
	}
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

// Keyed by CANONICAL (snake_case) names. tools/call resolves legacy camelCase
// aliases through resolveToolName before this lookup.
function buildHandlers(env) {
	return {
		get_bonding_curve: (a) => handleGetBondingCurve(a, env),
		get_token_details: (a) => handleGetTokenDetails(a, env),
		get_token_holders: (a) => handleGetTokenHolders(a, env),
		search_tokens: indexerHandler('search_tokens', env),
		get_token_trades: indexerHandler('get_token_trades', env),
		get_trending_tokens: indexerHandler('get_trending_tokens', env),
		get_new_tokens: indexerHandler('get_new_tokens', env),
		get_graduated_tokens: indexerHandler('get_graduated_tokens', env),
		get_king_of_the_hill: indexerHandler('get_king_of_the_hill', env),
		get_creator_profile: indexerHandler('get_creator_profile', env),
		pumpfun_bot_status: (a) => handlePumpfunBotStatus(a, env),
	};
}

// ── Tool catalog (worker subset) ─────────────────────────────────────────────

// The worker serves the pump.fun data subset of the shared catalog — only what
// buildHandlers implements. Advertising the full Vercel surface here would be
// dishonest (calls would 404); the canonical full server lives at
// https://three.ws/api/pump-fun-mcp.
const WORKER_TOOL_NAMES = new Set([
	'get_bonding_curve',
	'get_token_details',
	'get_token_holders',
	'search_tokens',
	'get_token_trades',
	'get_trending_tokens',
	'get_new_tokens',
	'get_graduated_tokens',
	'get_king_of_the_hill',
	'get_creator_profile',
	'pumpfun_bot_status',
]);
const WORKER_TOOLS = TOOLS.filter((t) => WORKER_TOOL_NAMES.has(t.name));

// Tools whose data comes only from the external indexer (PUMPFUN_BOT_URL).
// Filtered out of tools/list when the bot is unconfigured so clients never see
// a tool that would just return -32004. get_token_trades IS here: unlike the
// Vercel handler (which has an on-chain trade-history fallback), this worker's
// get_token_trades is indexer-only, so it can't be served without the bot.
// pumpfun_bot_status is never filtered — it reports this very capability.
const WORKER_INDEXER_TOOLS = new Set([
	'search_tokens',
	'get_token_trades',
	'get_trending_tokens',
	'get_new_tokens',
	'get_graduated_tokens',
	'get_king_of_the_hill',
	'get_creator_profile',
]);

// ── JSON-RPC dispatch ────────────────────────────────────────────────────────

// Dispatch ONE JSON-RPC message; returns the response envelope or null for
// notifications (no response owed). Mirrors api/pump-fun-mcp.js dispatchRpc
// minus the auth-gated tools (see README).
async function dispatchRpc(msg, env) {
	const { id = null, method, params } = msg || {};
	const isNotification = msg?.id === undefined && typeof method === 'string';

	if (method === 'initialize') {
		return rpcEnvelope(id, {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: { tools: { listChanged: false } },
			// indexerEnabled lets client authors check indexer capability without a
			// tools/list round-trip — it tracks the same env presence as the filter.
			serverInfo: { ...SERVER_INFO, indexerEnabled: !!env.PUMPFUN_BOT_URL },
			instructions: INSTRUCTIONS,
		});
	}
	if (method === 'ping') return rpcEnvelope(id, {});
	if (method === 'notifications/initialized') return null;
	if (method === 'tools/list') {
		// Advertise indexer-backed tools only when the bot is configured, so clients
		// never see a tool that would just return -32004. pumpfun_bot_status (always
		// listed, not in WORKER_INDEXER_TOOLS) reports capability.
		const tools = env.PUMPFUN_BOT_URL
			? WORKER_TOOLS
			: WORKER_TOOLS.filter((t) => !WORKER_INDEXER_TOOLS.has(t.name));
		return rpcEnvelope(id, { tools });
	}
	if (method === 'resources/list') return rpcEnvelope(id, { resources: [] });
	if (method === 'resources/templates/list') return rpcEnvelope(id, { resourceTemplates: [] });
	if (method === 'prompts/list') return rpcEnvelope(id, { prompts: [] });

	if (method === 'tools/call') {
		const requestedName = params?.name;
		// Legacy camelCase aliases resolve to the canonical snake_case names —
		// both forms are accepted forever (TOOL_NAME_ALIASES is the contract).
		const name = resolveToolName(requestedName);
		const args = params?.arguments || {};
		const handlers = buildHandlers(env);
		// Own-property lookup only — "__proto__"/"constructor" must not resolve
		// an inherited member and pass the !handler guard.
		const handler =
			typeof name === 'string' && Object.hasOwn(handlers, name) ? handlers[name] : null;
		if (!handler) {
			return rpcEnvelope(id, null, { code: -32601, message: `unknown tool: ${requestedName}` });
		}
		try {
			const data = await handler(args);
			return rpcEnvelope(id, {
				content: [{ type: 'text', text: JSON.stringify(data) }],
				structuredContent: data,
			});
		} catch (err) {
			const code = err.rpcCode || -32603;
			return rpcEnvelope(id, null, { code, message: err.message || 'tool error' });
		}
	}

	if (isNotification) return null;
	return rpcEnvelope(id, null, { code: -32601, message: `unknown method: ${method}` });
}

// ── HTTP fetch handler ───────────────────────────────────────────────────────

export default {
	async fetch(request, env) {
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		// GET/HEAD — Streamable HTTP SSE handshake. The worker never initiates
		// server→client messages, so the stream opens with the correct
		// content-type and closes immediately (the spec allows the server to
		// close the SSE stream at any time).
		if (request.method === 'GET' || request.method === 'HEAD') {
			return new Response(
				request.method === 'HEAD'
					? null
					: `: ${SERVER_INFO.name} streamable-http — POST JSON-RPC 2.0 to this URL\n\n`,
				{
					status: 200,
					headers: {
						...CORS_HEADERS,
						'content-type': 'text/event-stream',
						'cache-control': 'no-store',
						'mcp-protocol-version': PROTOCOL_VERSION,
					},
				},
			);
		}

		// DELETE — session terminate. Stateless per-request worker: nothing to
		// tear down.
		if (request.method === 'DELETE') {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		if (request.method !== 'POST') {
			return new Response('method not allowed', {
				status: 405,
				headers: { ...CORS_HEADERS, allow: 'GET, HEAD, POST, DELETE, OPTIONS' },
			});
		}

		const respond = (payload, status = 200) =>
			new Response(JSON.stringify(payload), {
				status,
				headers: {
					...CORS_HEADERS,
					'content-type': 'application/json',
					'mcp-protocol-version': PROTOCOL_VERSION,
				},
			});

		let body;
		try {
			body = await request.json();
		} catch {
			return respond(rpcEnvelope(null, null, { code: -32700, message: 'parse error' }), 400);
		}

		const isBatch = Array.isArray(body);
		const messages = isBatch ? body : [body];
		if (isBatch && messages.length === 0) {
			return respond(rpcEnvelope(null, null, { code: -32600, message: 'empty batch' }));
		}
		if (messages.length > MAX_BATCH) {
			return respond(
				rpcEnvelope(null, null, { code: -32600, message: `batch too large (max ${MAX_BATCH})` }),
			);
		}

		const responses = [];
		try {
			for (const msg of messages) {
				const envelope = await dispatchRpc(msg, env);
				if (envelope !== null) responses.push(envelope);
			}
		} catch (err) {
			// dispatchRpc guards each tool call, but an unexpected throw before that
			// guard (a malformed message, a handler-builder failure) would otherwise
			// escape as an opaque Cloudflare 1101 — breaking the JSON-RPC contract.
			// Log the real cause to the worker log; hand the client a sanitized
			// -32603 envelope echoing the request id when it's unambiguous.
			console.error('[pump-fun-mcp] dispatch failed', err?.stack || err);
			return respond(
				rpcEnvelope(isBatch ? null : messages[0]?.id ?? null, null, {
					code: -32603,
					message: 'internal error',
				}),
				500,
			);
		}

		// All-notification requests owe no body — 202 Accepted per Streamable HTTP.
		if (responses.length === 0) {
			return new Response(null, {
				status: 202,
				headers: { ...CORS_HEADERS, 'mcp-protocol-version': PROTOCOL_VERSION },
			});
		}

		return respond(isBatch ? responses : responses[0]);
	},
};
