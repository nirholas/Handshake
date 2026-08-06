// api/_lib/x402/circuit-breaker.js
//
// Cross-Network Payment Circuit Breaker — the cheapest possible end-to-end
// proof that the entire x402 payment stack is alive.
//
// A run()-style registry entry (autonomous-registry.js → `circuit-breaker-cross-network`).
// Once per hour the autonomous loop calls runCircuitBreaker(ctx). It:
//
//   1. Probes a real $0.001 402-gated three.ws endpoint (dance-tip) for a live
//      payment challenge.
//   2. Inspects the challenge's `accepts` array and confirms the facilitator
//      advertises a well-formed route for EVERY supported network — Solana
//      (scheme=exact), Base (scheme=exact), and BSC (scheme=direct). A missing
//      or malformed accept means a facilitator/config route has gone dark: the
//      breaker trips for that network.
//   3. Settles a REAL $0.001 USDC payment on Solana — the only network with a
//      configured autonomous outbound keypair (X402_SEED/AGENT_SOLANA_SECRET_BASE58)
//      — via the shared payX402() client, proving build → verify → settle →
//      receipt works end-to-end, not just that the route is advertised.
//      Base/BSC outbound settlement is not attempted because no autonomous EVM
//      signing wallet is provisioned; their route health is verified from the
//      live challenge instead (real data, no mock). The day an autonomous EVM
//      payer is configured, settlement for those networks switches on here
//      without touching the loop.
//   4. Upserts per-network status into `x402_circuit_breaker` (latest snapshot
//      keyed by network) and returns a compact outcome the loop records to
//      `x402_autonomous_log` (response_data + signal_data).
//
// Downstream consumer: api/ops/health.js reads `x402_circuit_breaker` and
// surfaces payment-stack liveness (per-network route + Solana settlement) in the
// internal health dashboard, folding a tripped breaker into the overall `ok`
// verdict. On-call alerting / the status page consume that verdict.
//
// No mocks. Every check reads live challenge data or makes a real on-chain
// payment. The loop owns recording, cooldown, and daily-spend accounting; this
// module owns the probe, the cross-network verification, the payment, and the
// value extraction/storage.

import { fetchWithTimeout, payX402 } from '../pay.js';

// Stable network identifiers — source of truth is api/_lib/x402-spec.js
// (NETWORK_SOLANA_MAINNET / NETWORK_BASE_MAINNET / NETWORK_BSC_MAINNET). Matched
// here by chain id so this module stays free of the heavy x402-spec import graph.
const NET_SOLANA_PREFIX = 'solana';
const NET_BASE = 'eip155:8453';
const NET_BSC = 'eip155:56';

// The probe target: the cheapest real 402-gated endpoint on the platform
// ($0.001 USDC). A settled pay books one dance on the club stage — the same real
// side effect the volume entries already produce, so an hourly breaker tip is
// consistent with existing traffic. A 402 challenge alone (the probe) books
// nothing; the ticket is created only after payment settles.
//
// dance-tip is a GET route (paidEndpoint({ method: 'GET' }) in api/x402/dance-tip.js)
// and takes its dancer/dance selection as QUERY params. The paid endpoint answers a
// credential-less request on the wrong method with the 402 challenge (so discovery
// still works), but a request that CARRIES a payment on the wrong method gets a
// strict 405, which is exactly what the breaker's settle leg was collecting every
// hour ("solana FAILED" with a hidden http_405 in signal_data). Probe and settle
// both ride the documented GET now.
const PROBE_QUERY = 'dancer=4&dance=hiphop';
const PROBE_PATH = `/api/x402/dance-tip?${PROBE_QUERY}`;
const PROBE_METHOD = 'GET';

// Networks the breaker expects the platform to advertise. `settle` flags the one
// network we actually pay on (Solana) vs. those we only route-verify (Base/BSC).
const TARGET_NETWORKS = [
	{
		key: 'solana',
		label: 'Solana',
		scheme: 'exact',
		settle: true,
		match: (a) => typeof a?.network === 'string' && a.network.startsWith(NET_SOLANA_PREFIX),
		// Solana accepts must carry a fee payer for the facilitator co-sign path.
		extraValid: (a) => !!a?.extra?.feePayer,
	},
	{
		key: 'base',
		label: 'Base',
		scheme: 'exact',
		settle: false,
		match: (a) => a?.network === NET_BASE,
		extraValid: () => true,
	},
	{
		key: 'bsc',
		label: 'BSC',
		scheme: 'direct',
		settle: false,
		match: (a) => a?.network === NET_BSC,
		// Direct-scheme BSC accepts must name the payments contract + method.
		extraValid: (a) => !!a?.extra?.contract && !!a?.extra?.method,
	},
];

function validateAccept(target, accept) {
	if (!accept) return { advertised: false, route_ok: false, reason: 'route_not_advertised', amount_atomic: null };
	const reasons = [];
	if (accept.scheme !== target.scheme) reasons.push(`scheme:${accept.scheme || 'none'}`);
	if (!accept.payTo) reasons.push('missing_payTo');
	if (!accept.asset) reasons.push('missing_asset');
	const amount = Number(accept.amount);
	if (!Number.isFinite(amount) || amount <= 0) reasons.push('bad_amount');
	if (!target.extraValid(accept)) reasons.push('missing_extra');
	return {
		advertised: true,
		route_ok: reasons.length === 0,
		amount_atomic: Number.isFinite(amount) ? amount : null,
		reason: reasons.length ? reasons.join(',') : null,
	};
}

async function ensureTable(sql) {
	try {
		await sql`
			CREATE TABLE IF NOT EXISTS x402_circuit_breaker (
				network        text PRIMARY KEY,
				label          text NOT NULL,
				scheme         text NOT NULL,
				advertised     boolean NOT NULL DEFAULT false,
				route_ok       boolean NOT NULL DEFAULT false,
				settled        boolean NOT NULL DEFAULT false,
				receipt_valid  boolean NOT NULL DEFAULT false,
				tx_signature   text,
				amount_atomic  bigint,
				error          text,
				run_id         uuid,
				checked_at     timestamptz DEFAULT now()
			)
		`;
	} catch { /* already exists or migration system handles it */ }
}

async function upsertStatus(sql, runId, row) {
	// Latest-status-per-network snapshot consumed by api/ops/health.js.
	await sql`
		INSERT INTO x402_circuit_breaker
			(network, label, scheme, advertised, route_ok, settled,
			 receipt_valid, tx_signature, amount_atomic, error, run_id, checked_at)
		VALUES
			(${row.network}, ${row.label}, ${row.scheme}, ${row.advertised},
			 ${row.route_ok}, ${row.settled}, ${row.receipt_valid},
			 ${row.tx_signature || null}, ${row.amount_atomic || null},
			 ${row.error || null}, ${runId}, now())
		ON CONFLICT (network) DO UPDATE SET
			label         = EXCLUDED.label,
			scheme        = EXCLUDED.scheme,
			advertised    = EXCLUDED.advertised,
			route_ok      = EXCLUDED.route_ok,
			settled       = EXCLUDED.settled,
			receipt_valid = EXCLUDED.receipt_valid,
			tx_signature  = EXCLUDED.tx_signature,
			amount_atomic = EXCLUDED.amount_atomic,
			error         = EXCLUDED.error,
			run_id        = EXCLUDED.run_id,
			checked_at    = now()
	`;
}

// Persist every per-network row, never crashing the loop on a DB fault.
async function persist(sql, log, runId, rows) {
	try {
		await ensureTable(sql);
		for (const row of rows) await upsertStatus(sql, runId, row);
	} catch (err) {
		log?.warn?.('circuit_breaker_persist_failed', { message: err?.message });
	}
}

function tripResult(errorMsg, stage) {
	return {
		success: false,
		amountAtomic: 0,
		txSig: null,
		network: 'multi',
		responseData: { stage },
		signalData: { tripped: true, reason: errorMsg },
		errorMsg,
		note: errorMsg,
	};
}

/**
 * Cross-network payment circuit breaker executor.
 *
 * @param {object} ctx — supplied by the autonomous loop:
 *   { origin, buyer, conn, blockhash, mintInfo, remainingCap, sql, log, runId }
 * @returns outcome recorded by the loop to x402_autonomous_log:
 *   { success, amountAtomic, txSig, responseData, signalData, errorMsg, note }
 */
export async function runCircuitBreaker(ctx) {
	const { origin, buyer, conn, blockhash, mintInfo, remainingCap, sql, log, runId } = ctx;
	const endpointUrl = `${origin}${PROBE_PATH}`;

	// Wallet guard (defence in depth — the loop pre-flights the keypair).
	if (!buyer) {
		const rows = TARGET_NETWORKS.map((t) => ({
			network: t.label.toLowerCase(), label: t.label, scheme: t.scheme,
			advertised: false, route_ok: false, settled: false, receipt_valid: false,
			tx_signature: null, amount_atomic: null, error: 'wallet_unconfigured',
		}));
		await persist(sql, log, runId, rows);
		return { ...tripResult('wallet_unconfigured', 'preflight'), cooldown: false };
	}

	// ── Step 1: probe for the live multi-network challenge ─────────────────────
	let challenge;
	try {
		const probe = await fetchWithTimeout(endpointUrl, {
			method: PROBE_METHOD,
			headers: {
				'content-type': 'application/json',
				'user-agent': 'threews-x402-circuit-breaker/1.0',
			},
		});
		if (probe.status !== 402) {
			// A $0.001 paid endpoint that does NOT challenge is itself a stack fault.
			const errorMsg = `probe_not_402:http_${probe.status}`;
			await persist(sql, log, runId, TARGET_NETWORKS.map((t) => ({
				network: t.label.toLowerCase(), label: t.label, scheme: t.scheme,
				advertised: false, route_ok: false, settled: false, receipt_valid: false,
				tx_signature: null, amount_atomic: null, error: errorMsg,
			})));
			return tripResult(errorMsg, 'probe');
		}
		challenge = probe.body;
	} catch (err) {
		const errorMsg = `probe_failed:${err?.message || 'network'}`;
		await persist(sql, log, runId, TARGET_NETWORKS.map((t) => ({
			network: t.label.toLowerCase(), label: t.label, scheme: t.scheme,
			advertised: false, route_ok: false, settled: false, receipt_valid: false,
			tx_signature: null, amount_atomic: null, error: errorMsg,
		})));
		return tripResult(errorMsg, 'probe');
	}

	const accepts = Array.isArray(challenge?.accepts) ? challenge.accepts : [];

	// ── Step 2: verify each network route from the live challenge ──────────────
	const rows = [];
	let solanaRow = null;
	let solanaAccept = null;
	for (const target of TARGET_NETWORKS) {
		const accept = accepts.find((a) => target.match(a)) || null;
		const v = validateAccept(target, accept);
		const row = {
			network: accept?.network || target.label.toLowerCase(),
			label: target.label,
			scheme: target.scheme,
			advertised: v.advertised,
			route_ok: v.route_ok,
			settled: false,
			receipt_valid: false,
			tx_signature: null,
			amount_atomic: v.amount_atomic,
			error: v.reason,
		};
		rows.push(row);
		if (target.settle && accept && v.route_ok) {
			solanaRow = row;
			solanaAccept = accept;
		}
	}

	// ── Step 3: settle the real $0.001 payment on Solana ───────────────────────
	let amountAtomic = 0;
	let txSig = null;
	let settleResp = null;
	if (solanaAccept) {
		try {
			const r = await payX402({
				url: endpointUrl,
				method: PROBE_METHOD,
				body: null,
				buyer, conn, blockhash, mintInfo,
				remainingCap: remainingCap ?? Infinity,
				userAgent: 'threews-x402-circuit-breaker/1.0',
			});
			amountAtomic = r.paid ? (r.amountAtomic || 0) : 0;
			txSig = r.txSig || null;
			settleResp = r.responseBody || null;
			solanaRow.settled = !!r.paid;
			solanaRow.receipt_valid = !!(r.paid && r.txSig);
			solanaRow.tx_signature = txSig;
			if (r.amountAtomic) solanaRow.amount_atomic = r.amountAtomic;
			if (!r.paid) solanaRow.error = r.errorMsg || `settle_status_${r.status || 0}`;
		} catch (err) {
			// Tx-build / RPC faults (malformed account, blockhash, RPC down) must not
			// crash the loop or skip the DB write — record the settlement as failed.
			solanaRow.error = `settle_threw:${err?.message || 'unknown'}`;
		}
	}

	// ── Step 4: persist per-network status (downstream: ops/health) ────────────
	await persist(sql, log, runId, rows);

	const routesOk = rows.filter((n) => n.route_ok).length;
	const allRoutesOk = routesOk === TARGET_NETWORKS.length;
	const solanaSettled = !!(solanaRow && solanaRow.settled);
	const tripped = !allRoutesOk || !solanaSettled;
	const summary = `routes ${routesOk}/${TARGET_NETWORKS.length} ok, solana ${solanaSettled ? 'settled' : 'FAILED'}`;

	const signalData = {
		tripped,
		all_routes_ok: allRoutesOk,
		routes_ok: routesOk,
		routes_total: TARGET_NETWORKS.length,
		solana_settled: solanaSettled,
		solana_tx: txSig,
		networks: rows.map((n) => ({ network: n.network, route_ok: n.route_ok, settled: n.settled, error: n.error })),
	};

	log?.info?.('circuit_breaker_complete', { run_id: runId, ...signalData, tx: txSig });

	return {
		// success = the breaker's job (proving liveness) completed: all routes
		// advertised + the real Solana settlement landed. amountAtomic reflects
		// only what actually moved on-chain so the loop's spend accounting is exact.
		success: !tripped,
		amountAtomic,
		txSig,
		network: 'multi',
		responseData: { challenge_resource: challenge?.resource || endpointUrl, networks: rows, settle_response: settleResp },
		signalData,
		errorMsg: tripped ? `breaker_tripped:${summary}` : null,
		note: summary,
	};
}

export const CIRCUIT_BREAKER_PROBE = Object.freeze({ path: PROBE_PATH, method: PROBE_METHOD });
