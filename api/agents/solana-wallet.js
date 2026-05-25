// /api/agents/:id/solana — wallet, activity, and airdrop handlers.
// Dispatched from api/agents/[id].js with the `action` sub-path.

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, json, method, error, readJson } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { generateSolanaAgentWallet } from '../_lib/agent-wallet.js';
import { solanaConnection, solanaPublicConnection } from '../_lib/agent-pumpfun.js';
import { reverseLookupAddress } from '../../src/solana/sns.js';
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { webcrypto } from 'node:crypto';
import { env } from '../_lib/env.js';
import { recordEvent } from '../_lib/usage.js';

const subtle = globalThis.crypto?.subtle || webcrypto.subtle;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const AIRDROP_LAMPORTS = LAMPORTS_PER_SOL;

// ── Solana RPC in-process cache ───────────────────────────────────────────────
// Keys: "sol:bal:<address>:<network>" and "sol:sigs:<address>:<network>:<limit>"
// Prevents Helius free-plan 429s on repeated wallet card polls.

const SOL_CACHE_TTL_MS = 60_000; // 60 s
const _solRpcCache = new Map();

function _solCacheGet(key) {
	const entry = _solRpcCache.get(key);
	if (!entry) return undefined;
	if (entry.expiry < Date.now()) {
		_solRpcCache.delete(key);
		return undefined;
	}
	return entry.value;
}

function _solCacheSet(key, value) {
	// Purge stale entries on each write so the map doesn't grow unbounded.
	const now = Date.now();
	for (const [k, e] of _solRpcCache.entries()) {
		if (e.expiry < now) _solRpcCache.delete(k);
	}
	_solRpcCache.set(key, { value, expiry: now + SOL_CACHE_TTL_MS });
}

// Calls `fn(conn)` with exponential backoff (500 ms → 1000 ms) before the
// public-RPC fallback fires. Returns { ok, value } or { ok: false, error }.
async function _solRpcWithBackoffFallback(primaryConn, fallbackConn, fn, label) {
	// Attempt 1 — primary
	try {
		return { ok: true, value: await fn(primaryConn) };
	} catch (err1) {
		const is429 =
			err1?.message?.includes('429') ||
			err1?.message?.includes('Too Many Requests') ||
			err1?.status === 429;
		console.warn(`[agents/solana] ${label} primary failed${is429 ? ' (429)' : ''}: ${err1?.message || err1}`);

		// 500 ms wait before first retry
		await new Promise((r) => setTimeout(r, 500));

		// Attempt 2 — retry primary (backoff)
		try {
			return { ok: true, value: await fn(primaryConn) };
		} catch (err2) {
			console.warn(`[agents/solana] ${label} primary retry failed: ${err2?.message || err2}`);

			// 1000 ms wait before falling back to public RPC
			await new Promise((r) => setTimeout(r, 1_000));
		}
	}

	// Attempt 3 — public fallback
	if (fallbackConn) {
		try {
			return { ok: true, value: await fn(fallbackConn) };
		} catch (err3) {
			console.error(`[agents/solana] ${label} fallback failed: ${err3?.message || err3}`);
			return { ok: false, error: err3 };
		}
	}
	return { ok: false, error: new Error(`${label}: all RPC attempts failed`) };
}

// Bonfida reverse-lookup is rate-limited and pulls a few KB per call. Memoize
// 10 minutes per-address so wallet card refreshes (every 30s) don't refetch.
const SNS_CACHE_TTL_MS = 10 * 60_000;
const _snsCache = new Map();
async function _reverseSnsCached(address) {
	const hit = _snsCache.get(address);
	if (hit && Date.now() - hit.at < SNS_CACHE_TTL_MS) return hit.value;
	let value = null;
	try { value = await reverseLookupAddress(address); } catch { value = null; }
	_snsCache.set(address, { at: Date.now(), value });
	return value;
}

async function _deriveKey() {
	const raw = new TextEncoder().encode(env.JWT_SECRET);
	const base = await subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
	return subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('agent-wallet-v1'), info: new Uint8Array(0) },
		base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
	);
}
async function _encryptSecret(plaintext) {
	const key = await _deriveKey();
	const iv = new Uint8Array(12);
	(globalThis.crypto || webcrypto).getRandomValues(iv);
	const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
	const buf = new Uint8Array(iv.length + ct.byteLength);
	buf.set(iv, 0); buf.set(new Uint8Array(ct), iv.length);
	return Buffer.from(buf).toString('base64');
}

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

// ── activity ──────────────────────────────────────────────────────────────────

async function handleActivity(req, res, id) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.walletRead(auth.userId);
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const [row] = await sql`SELECT id, user_id, meta FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	if (!row) return error(res, 404, 'not_found', 'agent not found');
	if (row.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	const address = row.meta?.solana_address;
	if (!address) return error(res, 404, 'not_found', 'agent has no solana wallet');

	const url = new URL(req.url, 'http://x');
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 50);
	const pk = new PublicKey(address);

	const primaryConn = solanaConnection(network);
	const fallbackConn = solanaPublicConnection(network);
	const sigsCacheKey = `sol:sigs:${address}:${network}:${limit}`;

	let sigs = _solCacheGet(sigsCacheKey);
	if (sigs === undefined) {
		const sigInfos = await _solRpcWithBackoffFallback(
			primaryConn,
			fallbackConn,
			(c) => c.getSignaturesForAddress(pk, { limit }),
			'getSignaturesForAddress',
		);
		if (!sigInfos.ok) {
			console.error('[agents/solana/activity] signature fetch failed on all RPCs', sigInfos.error);
			return error(res, 502, 'rpc_error', 'failed to fetch on-chain activity');
		}
		sigs = sigInfos.value;
		_solCacheSet(sigsCacheKey, sigs);
	}

	// getParsedTransactions is the expensive call and the one most often rate-limited.
	// Degrade gracefully: if it fails everywhere, we still return the signature list
	// without the lamport delta / summary enrichment instead of 502-ing the whole call.
	let parsed = null;
	if (sigs.length) {
		const parsedRes = await _solRpcWithBackoffFallback(
			primaryConn,
			fallbackConn,
			(c) => c.getParsedTransactions(sigs.map((s) => s.signature), {
				maxSupportedTransactionVersion: 0,
				commitment: 'confirmed',
			}),
			'getParsedTransactions',
		);
		if (parsedRes.ok) {
			parsed = parsedRes.value;
		} else {
			console.warn('[agents/solana/activity] parsed-tx enrichment unavailable', parsedRes.error?.message);
		}
	}

	const signatures = sigs.map((s, i) => {
		const tx = parsed?.[i] ?? null;
		let lamportDelta = null;
		let summary = null;
		if (tx?.meta && tx?.transaction) {
			const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey?.toString());
			const idx = keys.indexOf(address);
			if (idx >= 0 && tx.meta.preBalances && tx.meta.postBalances) {
				lamportDelta = tx.meta.postBalances[idx] - tx.meta.preBalances[idx];
			}
			const ix = tx.transaction.message.instructions?.[0];
			if (ix?.parsed?.type) summary = ix.parsed.type;
			else if (ix?.programId) summary = `program ${ix.programId.toString().slice(0, 6)}…`;
		}
		return {
			signature: s.signature,
			slot: s.slot,
			block_time: s.blockTime ?? null,
			success: !s.err && !tx?.meta?.err,
			error: s.err || tx?.meta?.err || null,
			lamport_delta: lamportDelta,
			sol_delta: lamportDelta == null ? null : lamportDelta / 1e9,
			summary,
		};
	});

	return json(res, 200, {
		data: { address, network, signatures, parsed_available: parsed !== null },
	});
}

// ── airdrop ───────────────────────────────────────────────────────────────────

async function handleAirdrop(req, res, id) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const [row] = await sql`SELECT id, user_id, meta FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	if (!row) return error(res, 404, 'not_found', 'agent not found');
	if (row.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	const address = row.meta?.solana_address;
	if (!address) return error(res, 404, 'not_found', 'agent has no solana wallet');

	let signature;
	try {
		const conn = solanaConnection('devnet');
		signature = await conn.requestAirdrop(new PublicKey(address), AIRDROP_LAMPORTS);
		await conn.confirmTransaction(signature, 'confirmed');
	} catch (err) {
		console.error('[agents/solana/airdrop] failed', err);
		return error(res, 502, 'faucet_unavailable',
			err?.message?.includes('429') || err?.message?.includes('limit')
				? 'Devnet faucet is rate-limited — try again in a minute.'
				: `Devnet airdrop failed: ${err?.message || 'unknown'}`);
	}

	recordEvent({ userId: auth.userId, agentId: id, kind: 'solana_airdrop', tool: 'devnet', status: 'ok', meta: { address, signature, lamports: AIRDROP_LAMPORTS } });
	return json(res, 200, { data: { signature, address, network: 'devnet', lamports: AIRDROP_LAMPORTS, sol: AIRDROP_LAMPORTS / 1e9 } });
}

// ── public wallet read ─────────────────────────────────────────────────────────
// GET /api/agents/:id/solana — no auth required. Returns wallet address + balance
// so external services (explorers, dashboards, other agents) can look up an
// agent's on-chain identity without a session. Write operations (POST, DELETE)
// still require owner auth — see handleWallet below.

async function handlePublicWalletRead(req, res, id) {
	const url = new URL(req.url, 'http://x');
	const network = (url.searchParams.get('network') || 'mainnet').toString();
	const net = network === 'devnet' ? 'devnet' : 'mainnet';

	const [row] = await sql`SELECT id, meta FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	if (!row) return error(res, 404, 'not_found', 'agent not found');

	const address = row.meta?.solana_address ?? null;
	if (!address) {
		return json(res, 200, {
			data: {
				agentId: id,
				wallet: null,
				balance: null,
				chain: 'solana',
			},
		});
	}

	let lamports = null;
	const balCacheKey = `sol:bal:${address}:${net}`;
	const cached = _solCacheGet(balCacheKey);
	if (cached !== undefined) {
		lamports = cached;
	} else {
		const balResult = await _solRpcWithBackoffFallback(
			solanaConnection(net),
			solanaPublicConnection(net),
			(c) => c.getBalance(new PublicKey(address)),
			'getBalance',
		);
		lamports = balResult.ok ? balResult.value : null;
		if (balResult.ok) _solCacheSet(balCacheKey, lamports);
	}

	console.info(`[agents/solana] public read agentId=${id} address=${address} net=${net} lamports=${lamports}`);
	return json(res, 200, {
		data: {
			agentId: id,
			wallet: address,
			balance: lamports == null ? null : lamports / 1e9,
			chain: 'solana',
			network: net,
			lamports,
		},
	});
}

// ── wallet ────────────────────────────────────────────────────────────────────

async function handleWallet(req, res, id) {
	if (cors(req, res, { methods: 'GET,POST,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST', 'DELETE'])) return;

	// Unauthenticated GET: serve public wallet info without requiring sign-in.
	// Write operations still require owner auth below.
	if (req.method === 'GET') {
		const auth = await resolveAuth(req);
		if (!auth) return handlePublicWalletRead(req, res, id);
	}

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = req.method === 'GET'
		? await limits.walletRead(auth.userId)
		: await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const [row] = await sql`SELECT id, user_id, meta FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	if (!row) return error(res, 404, 'not_found', 'agent not found');
	if (row.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	let meta = { ...(row.meta || {}) };

	if (req.method === 'DELETE') {
		delete meta.solana_address;
		delete meta.encrypted_solana_secret;
		delete meta.solana_vanity_prefix;
		delete meta.solana_wallet_source;
		await sql`UPDATE agent_identities SET meta = ${JSON.stringify(meta)}::jsonb WHERE id = ${id}`;
		return json(res, 200, { data: { ok: true } });
	}

	if (req.method === 'POST') {
		const body = await readJson(req).catch(() => ({}));
		const importing = body && (body.secret_key || body.vanity_prefix);

		if (importing) {
			const sk = body.secret_key;
			if (!Array.isArray(sk) || sk.length !== 64 || !sk.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
				return error(res, 400, 'validation_error', 'secret_key must be a 64-byte number array');
			}
			let kp;
			try { kp = Keypair.fromSecretKey(Uint8Array.from(sk)); }
			catch { return error(res, 400, 'validation_error', 'secret_key did not parse as a valid Solana keypair'); }
			const address = kp.publicKey.toBase58();
			if (body.vanity_prefix) {
				if (!BASE58_RE.test(body.vanity_prefix) || body.vanity_prefix.length > 6) return error(res, 400, 'validation_error', 'vanity_prefix is not valid base58 (max 6 chars)');
				if (!address.startsWith(body.vanity_prefix)) return error(res, 400, 'validation_error', 'vanity_prefix does not match the keypair address');
			}
			if (meta.solana_address) return error(res, 409, 'conflict', 'agent already has a Solana wallet — DELETE /api/agents/:id/solana first to replace');
			const encrypted_secret = await _encryptSecret(Buffer.from(kp.secretKey).toString('base64'));
			meta = { ...meta, solana_address: address, encrypted_solana_secret: encrypted_secret, solana_wallet_source: 'imported_vanity', ...(body.vanity_prefix ? { solana_vanity_prefix: body.vanity_prefix } : {}) };
			await sql`UPDATE agent_identities SET meta = ${JSON.stringify(meta)}::jsonb WHERE id = ${id}`;
		} else if (!meta.solana_address) {
			const sol = await generateSolanaAgentWallet();
			meta = { ...meta, solana_address: sol.address, encrypted_solana_secret: sol.encrypted_secret, solana_wallet_source: 'generated' };
			await sql`UPDATE agent_identities SET meta = ${JSON.stringify(meta)}::jsonb WHERE id = ${id}`;
		}
	}

	if (!meta.solana_address) return error(res, 404, 'not_found', 'agent has no solana wallet — POST to provision');

	const network = (req.query?.network || new URL(req.url, 'http://x').searchParams.get('network') || 'mainnet').toString();
	const net = network === 'devnet' ? 'devnet' : 'mainnet';
	const balCacheKey = `sol:bal:${meta.solana_address}:${net}`;
	let lamports = _solCacheGet(balCacheKey);
	if (lamports === undefined) {
		const balResult = await _solRpcWithBackoffFallback(
			solanaConnection(net),
			solanaPublicConnection(net),
			(c) => c.getBalance(new PublicKey(meta.solana_address)),
			'getBalance',
		);
		lamports = balResult.ok ? balResult.value : null;
		if (balResult.ok) _solCacheSet(balCacheKey, lamports);
	}

	// SNS is mainnet-only. Skip the lookup on devnet — it always returns null
	// and just burns a network round-trip. Prefer the user's manually-attached
	// SNS id (meta.sns_domain) over the on-chain favorite so the wallet card
	// matches whatever they picked on the SNS dashboard.
	const attachedSns = meta.sns_domain ? `${meta.sns_domain}.sol` : null;
	const favoriteSns = net === 'mainnet' && !attachedSns
		? await _reverseSnsCached(meta.solana_address)
		: null;

	return json(res, req.method === 'POST' ? 201 : 200, {
		data: {
			address: meta.solana_address,
			network,
			lamports,
			sol: lamports == null ? null : lamports / 1e9,
			vanity_prefix: meta.solana_vanity_prefix || null,
			source: meta.solana_wallet_source || (meta.encrypted_solana_secret ? 'generated' : null),
			sns_domain: attachedSns || favoriteSns,
			sns_source: attachedSns ? 'attached' : (favoriteSns ? 'favorite' : null),
		},
	});
}

// ── dispatcher ────────────────────────────────────────────────────────────────

export default async function handler(req, res, id, action) {
	if (action === 'activity') return handleActivity(req, res, id);
	if (action === 'airdrop') return handleAirdrop(req, res, id);
	return handleWallet(req, res, id);
}
