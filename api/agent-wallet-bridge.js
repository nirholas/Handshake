// Hosted agent-wallet x402 bridge — the production equivalent of
// scripts/agent-wallet-x402-bridge.mjs, so the /play/agent-wallet page works
// for real visitors instead of dead-ending on "bridge offline".
//
//   GET  /api/agent-wallet-bridge?status=1                      → wallet + balances
//   GET  /api/agent-wallet-bridge?quote=1&endpoint=<url>&...    → parsed 402 challenge
//   POST /api/agent-wallet-bridge?pay=1  {endpoint,method,body} → SSE real payment
//
// The platform-held A2A payer keypair (A2A_PAYER_SOLANA_SECRET) signs a real SPL
// USDC TransferChecked on Solana mainnet against three.ws's own x402 endpoints
// (standard x402 v2 `exact` scheme via @x402/svm — the same flow the local
// bridge runs). Settlement happens at the paid endpoint's facilitator; real
// USDC moves.
//
// Because the payer wallet is shared, the spend path is protected:
//   • status / quote are read-only and public.
//   • pay requires a signed-in session (or bearer) — anonymous visitors get a
//     clear "sign in" error instead of draining the wallet.
//   • per-IP rate limit + per-payment cap + per-wallet daily USDC cap.
//   • target endpoints must be on an allowlisted origin (three.ws + local dev).

import { cors, wrap, error, serverError, setRateLimitHeaders } from './_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from './_lib/auth.js';
import { requireCsrf } from './_lib/csrf.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { createSolanaSigner } from './_lib/x402/a2a-client.js';
import { enforceCap, commit, rollbackReservation } from './_lib/x402-spending-cap.js';
import { env } from './_lib/env.js';
import { fetchUpstream } from './_lib/upstream-fetch.js';

const SOLANA_RPC_URL = env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const USDC_MINT_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PAYER_SECRET = env.A2A_PAYER_SOLANA_SECRET || '';

// Caps (micro-USDC == micro-USD for USDC). Per-payment default $0.10, matching
// the local bridge; per-wallet daily default $2.00. Both env-overridable.
const MAX_PER_CALL_MICROS = Number(process.env.AGENT_WALLET_MAX_USDC_MICROS || 100_000);
const MAX_PER_DAY_MICROS = Number(process.env.AGENT_WALLET_DAILY_USDC_MICROS || 2_000_000);

const ALLOWED_ENDPOINT_ORIGINS = (
	process.env.AGENT_WALLET_ALLOWED_ORIGINS ||
	'https://three.ws,http://localhost:3000,http://127.0.0.1:3000'
)
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);

const BUILDER_CODE_PATTERN = /^[a-z0-9_]{1,32}$/;

function fmtUsdc(micros) {
	return '$' + (Number(micros) / 1e6).toFixed(2);
}

function endpointAllowed(endpoint) {
	try {
		return ALLOWED_ENDPOINT_ORIGINS.includes(new URL(endpoint).origin);
	} catch {
		return false;
	}
}

// A co-signable Solana accept: exact scheme, Solana CAIP-2 network, and the
// facilitator fee payer the @x402/svm scheme needs to build the transaction.
function isSolanaExactAccept(a) {
	return a && a.scheme === 'exact' && String(a.network || '').startsWith('solana:') && a.extra?.feePayer;
}

let signerPromise = null;
function agentSigner() {
	if (!PAYER_SECRET) {
		return Promise.reject(new Error('agent wallet not configured on the server'));
	}
	if (!signerPromise) {
		signerPromise = createSolanaSigner(PAYER_SECRET);
		signerPromise.catch(() => { signerPromise = null; });
	}
	return signerPromise;
}

let statusCache = null; // { at, payload }
async function walletStatus() {
	if (statusCache && Date.now() - statusCache.at < 10_000) return statusCache.payload;
	const signer = await agentSigner();
	const [{ PublicKey }, { getAssociatedTokenAddressSync }, { solanaConnection }] = await Promise.all([
		import('@solana/web3.js'),
		import('@solana/spl-token'),
		import('./_lib/solana/connection.js'),
	]);
	// Multi-endpoint failover: a quota-dead or garbage-returning primary is skipped
	// transparently instead of stalling this handler to the 30s Vercel ceiling
	// (the source of the "[agent-wallet-bridge] Task timed out" errors) or throwing
	// a StructError on a poison RPC body.
	const conn = solanaConnection({ url: SOLANA_RPC_URL, commitment: 'confirmed' });
	const owner = new PublicKey(signer.address);
	let sol = null;
	let usdc = 0;
	try {
		sol = (await conn.getBalance(owner)) / 1e9;
		const ata = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT_SOLANA), owner);
		const bal = await conn.getTokenAccountBalance(ata).catch(() => null);
		usdc = bal?.value?.uiAmount ?? 0;
	} catch {
		// RPC hiccup — report the wallet without live balances rather than fail.
	}
	const payload = {
		ok: true,
		wallet: { address: signer.address, mode: 'solana', chainNamespace: 'solana' },
		balance: {
			currency: 'USD',
			totalValue: usdc.toFixed(2),
			chains: [{ network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', sol, usdc }],
		},
	};
	statusCache = { at: Date.now(), payload };
	return payload;
}

async function fetch402(endpoint, method, body) {
	// Any status is a legitimate answer here (we are probing for a 402), so the
	// wrapper only adds the timeout and a retry on a dropped connection.
	const res = await fetchUpstream(endpoint, {
		method,
		headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	}, { timeoutMs: 15_000, attempts: 2, okWhen: () => true });
	if (res.status !== 402) {
		const text = (await res.text()).slice(0, 300);
		throw new Error(`expected a 402 challenge from ${endpoint}, got ${res.status}: ${text}`);
	}
	const challenge = await res.json();
	if (!Array.isArray(challenge?.accepts) || !challenge.accepts.length) {
		throw new Error('402 challenge has no accepts[] entries');
	}
	const accept = challenge.accepts.find(isSolanaExactAccept);
	if (!accept) throw new Error('endpoint does not accept exact-scheme USDC on Solana');
	return { challenge, accept };
}

// ERC-8021 builder-code echo — the server rejects payments that don't echo the
// declared app code. Self-attribute as the wallet/service pair.
function builderCodeEcho(challenge) {
	const declaredA = challenge?.extensions?.['builder-code']?.info?.a;
	if (!declaredA || !BUILDER_CODE_PATTERN.test(declaredA)) return null;
	return {
		a: declaredA,
		w: env.X402_BUILDER_CODE_WALLET || 'threews_agent',
		s: ['agent_wallet_x402_bridge'],
	};
}

async function executePayment({ endpoint, method, body, payerAddress, emit }) {
	// 1. Real 402 challenge from the paid endpoint.
	const { challenge, accept } = await fetch402(endpoint, method, body);
	const amount = BigInt(accept.amount);
	if (amount > BigInt(MAX_PER_CALL_MICROS)) {
		throw new Error(
			`endpoint asks for ${fmtUsdc(accept.amount)} USDC, above the per-payment cap of ${fmtUsdc(MAX_PER_CALL_MICROS)}`,
		);
	}

	// 2. Spending-cap admission (per-payment already checked; this enforces the
	// per-wallet daily ceiling and records the spend).
	const cap = await enforceCap({
		requirement: accept,
		opts: {
			address: payerAddress,
			maxPerCall: MAX_PER_CALL_MICROS,
			maxPerDay: MAX_PER_DAY_MICROS,
			strict: true,
		},
	});
	if (cap.abort) throw new Error(cap.reason || 'spending cap exceeded');

	let committed = false;
	try {
		emit({
			stage: 'challenge',
			amount: accept.amount,
			payTo: accept.payTo,
			asset: accept.asset,
			network: accept.network,
			resource: challenge.resource || null,
		});

		// 3. The agent wallet builds + partially signs the SPL TransferChecked.
		const signer = await agentSigner();
		emit({
			stage: 'signing',
			signer: signer.address,
			network: accept.network,
			mint: accept.asset,
			to: accept.payTo,
			value: accept.amount,
			feePayer: accept.extra.feePayer,
		});
		const { ExactSvmScheme } = await import('@x402/svm');
		const scheme = new ExactSvmScheme(signer, { rpcUrl: SOLANA_RPC_URL });
		const built = await scheme.createPaymentPayload(2, accept);
		emit({ stage: 'signed', signer: signer.address });

		// 4. Retry with the X-PAYMENT header — the endpoint verifies, settles via
		// its facilitator, then does the paid work.
		const paymentPayload = {
			x402Version: built.x402Version || 2,
			scheme: 'exact',
			network: accept.network,
			resource: { url: endpoint, mimeType: 'application/json' },
			accepted: accept,
			payload: built.payload,
		};
		const echo = builderCodeEcho(challenge);
		if (echo) paymentPayload.extensions = { 'builder-code': echo };
		emit({ stage: 'submitting' });

		// A signed payment must never be re-sent (a retry could double-spend), so
		// this is a single attempt: timeout only.
		const paidRes = await fetchUpstream(endpoint, {
			method,
			headers: {
				accept: 'application/json',
				'x-payment': Buffer.from(JSON.stringify(paymentPayload), 'utf8').toString('base64'),
				...(body ? { 'content-type': 'application/json' } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
		}, { timeoutMs: 30_000, attempts: 1, okWhen: () => true });
		const resultText = await paidRes.text();
		let result = null;
		try { result = JSON.parse(resultText); } catch { result = { raw: resultText.slice(0, 1000) }; }
		if (!paidRes.ok) {
			throw new Error(
				`payment rejected by endpoint (HTTP ${paidRes.status}): ${result?.error?.message || result?.error || resultText.slice(0, 300)}`,
			);
		}

		let settlement = null;
		const settleHeader = paidRes.headers.get('x-payment-response');
		if (settleHeader) {
			try { settlement = JSON.parse(Buffer.from(settleHeader, 'base64').toString('utf8')); } catch { settlement = null; }
		}

		await commit(cap.reservation, { endpoint, tx: settlement?.transaction || null });
		committed = true;
		statusCache = null; // balance just changed
		emit({
			stage: 'done',
			amount: accept.amount,
			payer: signer.address,
			payTo: accept.payTo,
			settlement,
			result,
		});
	} finally {
		if (!committed) await rollbackReservation(cap.reservation).catch(() => {});
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;

	const url = new URL(req.url, 'http://x');

	// ── STATUS (public, read-only) ────────────────────────────────────────
	if (req.method === 'GET' && url.searchParams.get('status') === '1') {
		try {
			// Resolve the async payload BEFORE committing headers — writing the head
			// first and awaiting inside res.end() means a rejected walletStatus() lands
			// in the catch with headers already sent, turning a clean 503 into an
			// ERR_HTTP_HEADERS_SENT crash.
			const status = await walletStatus();
			res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
			res.end(JSON.stringify(status));
		} catch (err) {
			// A 503 here means the signer/RPC layer faulted — sanitize so a keyed
				// RPC URL or signer internal can't ride out in the error body.
				serverError(res, 503, 'wallet_unavailable', err);
		}
		return;
	}

	// ── QUOTE (public, read-only) ─────────────────────────────────────────
	if (req.method === 'GET' && url.searchParams.get('quote') === '1') {
		const endpoint = url.searchParams.get('endpoint') || '';
		const method = (url.searchParams.get('method') || 'POST').toUpperCase();
		if (!endpointAllowed(endpoint)) {
			return error(res, 400, 'endpoint_not_allowed', `endpoint origin not allowed (allowed: ${ALLOWED_ENDPOINT_ORIGINS.join(', ')})`);
		}
		try {
			const bodyParam = url.searchParams.get('body');
			const probeBody = bodyParam ? JSON.parse(bodyParam) : undefined;
			const { challenge, accept } = await fetch402(endpoint, method, probeBody);
			res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
			res.end(JSON.stringify({
				ok: true,
				amount: accept.amount,
				payTo: accept.payTo,
				asset: accept.asset,
				network: accept.network,
				feePayer: accept.extra?.feePayer || null,
				maxTimeoutSeconds: accept.maxTimeoutSeconds,
				resource: challenge.resource || null,
			}));
		} catch (err) {
			// Don't echo upstream endpoint URLs / response bodies to the caller —
			// fetch402 errors embed both. Log server-side, return a stable message.
			console.error('[agent-wallet-bridge] quote_failed:', err?.message || err);
			error(res, 502, 'quote_failed', 'Unable to retrieve a payment quote right now. Try again shortly.');
		}
		return;
	}

	// ── PAY (real on-chain spend — auth + rate limit + caps) ──────────────
	if (req.method !== 'POST') {
		return error(res, 405, 'method_not_allowed', 'use ?status=1, ?quote=1, or POST ?pay=1');
	}

	// Real USDC leaves the shared platform wallet — require a signed-in caller.
	const sessionUser = await getSessionUser(req).catch(() => null);
	const bearerUser = sessionUser ? null : await authenticateBearer(extractBearer(req)).catch(() => null);
	if (!sessionUser && !bearerUser) {
		return error(res, 401, 'unauthorized', 'Sign in to let your agent wallet make a real payment.');
	}
	const callerUserId = (sessionUser || bearerUser).userId ?? (sessionUser || bearerUser).id;
	if (!(await requireCsrf(req, res, callerUserId))) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) {
		const retryAfter = Math.max(1, setRateLimitHeaders(res, rl));
		res.setHeader('retry-after', String(retryAfter));
		return error(res, 429, 'rate_limited', 'Too many payment attempts — try again shortly.');
	}

	let parsed;
	try {
		parsed = typeof req.body === 'object' && req.body ? req.body : JSON.parse(await readRawBody(req) || '{}');
	} catch {
		return error(res, 400, 'invalid_body', 'invalid JSON body');
	}
	const endpoint = String(parsed.endpoint || '');
	const payMethod = String(parsed.method || 'POST').toUpperCase();
	if (!['GET', 'POST'].includes(payMethod)) {
		return error(res, 400, 'invalid_method', 'method must be GET or POST');
	}
	if (!endpointAllowed(endpoint)) {
		return error(res, 400, 'endpoint_not_allowed', `endpoint origin not allowed (allowed: ${ALLOWED_ENDPOINT_ORIGINS.join(', ')})`);
	}

	res.writeHead(200, {
		'content-type': 'text/event-stream; charset=utf-8',
		'cache-control': 'no-cache, no-store',
		connection: 'keep-alive',
		'x-accel-buffering': 'no',
		'access-control-allow-origin': '*',
	});
	res.flushHeaders?.();

	let lastStage = 'challenge';
	const emit = (evt) => {
		lastStage = evt.stage || lastStage;
		res.write(`data: ${JSON.stringify(evt)}\n\n`);
	};
	try {
		const signer = await agentSigner();
		await executePayment({ endpoint, method: payMethod, body: parsed.body, payerAddress: signer.address, emit });
	} catch (err) {
		emit({ stage: 'error', failedStage: lastStage, message: err.message });
	}
	res.end();
});

function readRawBody(req) {
	return new Promise((resolve, reject) => {
		let data = '';
		req.on('data', (c) => {
			data += c;
			if (data.length > 64 * 1024) reject(new Error('request body too large'));
		});
		req.on('end', () => resolve(data));
		req.on('error', reject);
	});
}

export const maxDuration = 30;
