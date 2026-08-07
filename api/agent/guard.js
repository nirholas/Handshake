// POST /api/agent/guard - preflight one or more proposed agent tool calls
// through the seven-layer GuardChain from @three-ws/agent-runtime (security
// blacklist → human intervention → capability → permission → trade guard →
// spend envelope → x402 budget).
//
// The chain is pure and I/O-free: every fact it reasons over (USD notional,
// tier, caps, balances, x402 payment context) arrives in the request, and the
// verdict comes back deterministic: decision, the layer that decided it, a
// per-layer trace, blind spots (checks that SHOULD have run but could not),
// and a coverage score. The chat client calls this before executing any
// fund-moving tool so a block or approval requirement is decided by platform
// policy, not by whichever UI happens to render the button. Nothing here
// signs, sends, or mutates: the caller still owns execution.
//
// No auth on purpose: the evaluation uses only caller-supplied data, touches
// no secrets and no state, and its whole job is to be reachable from an
// anonymous BYOK chat session. Rate-limited per IP like the other open
// compute endpoints.

import { cors, error, json, method, rateLimited, readJson, wrap } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { solUsdPrice } from '../_lib/avatar-wallet.js';
import { GuardChain, SpendGuard, TradeGuard, createX402Hook } from '@three-ws/agent-runtime';

const MAX_CALLS = 20;
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Resolve the USD notional server-side where the call shape makes it
// unambiguous (the GuardChain's own guidance: the guard never prices token
// amounts itself, the caller resolves notionals). SOL-denominated amounts are
// the common case across the chat wallet tools; anything else stays
// unresolved and surfaces as a VALUE_UNRESOLVED blind spot instead of a
// wrong number.
function solAmountOf(call) {
	const a = call.arguments || {};
	switch (call.apiName) {
		case 'solana_transfer': {
			const token = String(a.token || 'SOL');
			return token.toUpperCase() === 'SOL' ? Number(a.amount) : undefined;
		}
		case 'solana_swap':
			return String(a.inputMint || '') === SOL_MINT ? Number(a.amount) : undefined;
		case 'pumpfunBuy':
			return Number(a.sol ?? a.solAmount);
		case 'LaunchPumpToken':
			return Number(a.sol_buy_in);
		default:
			return undefined;
	}
}

// One TradeGuard serves every request: it is stateless and its registries are
// module-level. SpendGuard instances are per-request because the envelope
// (caps, firewall) is caller-supplied.
const tradeGuard = new TradeGuard();

function sanitizeCall(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const identifier = typeof raw.identifier === 'string' ? raw.identifier.slice(0, 200) : '';
	const apiName = typeof raw.apiName === 'string' ? raw.apiName.slice(0, 200) : identifier;
	if (!identifier && !apiName) return null;
	return {
		identifier: identifier || apiName,
		apiName: apiName || identifier,
		arguments:
			raw.arguments && typeof raw.arguments === 'object' && !Array.isArray(raw.arguments)
				? raw.arguments
				: {},
		valueUsd: Number.isFinite(Number(raw.valueUsd)) ? Number(raw.valueUsd) : undefined,
		protocol: typeof raw.protocol === 'string' ? raw.protocol.slice(0, 100) : undefined,
		chainId: Number.isFinite(Number(raw.chainId)) ? Number(raw.chainId) : undefined,
		token: typeof raw.token === 'string' ? raw.token.slice(0, 200) : undefined,
		destination: typeof raw.destination === 'string' ? raw.destination.slice(0, 200) : undefined,
		interventionConfig: raw.interventionConfig,
		executionPath: raw.executionPath === 'batch' ? 'batch' : 'single',
		x402: raw.x402 && typeof raw.x402 === 'object' ? raw.x402 : undefined,
	};
}

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'POST, OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const ip =
		String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
		req.socket?.remoteAddress ||
		'unknown';
	const rl = await limits.agentGuardIp(ip);
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try {
		body = await readJson(req, 256_000);
	} catch (err) {
		return error(res, err?.status || 400, 'bad_json', err?.message || 'Body must be JSON.');
	}

	const rawCalls = Array.isArray(body?.calls) ? body.calls : body?.call ? [body.call] : [];
	const calls = rawCalls.map(sanitizeCall).filter(Boolean);
	if (calls.length === 0) {
		return error(res, 400, 'no_calls', 'Provide `calls: [{ identifier, apiName, arguments }]`.');
	}
	if (calls.length > MAX_CALLS) {
		return error(res, 400, 'too_many_calls', `At most ${MAX_CALLS} calls per request.`);
	}

	// Per-request spend envelope. Absent config means the layer reports itself
	// as unwired; that is signal (a SPEND_UNSCOPED blind spot), not an error.
	let spendGuard;
	if (body.spend && typeof body.spend === 'object') {
		spendGuard = new SpendGuard({
			perTxMaxUsd: Number.isFinite(Number(body.spend.perTxMaxUsd))
				? Number(body.spend.perTxMaxUsd)
				: undefined,
			dailyMaxUsd: Number.isFinite(Number(body.spend.dailyMaxUsd))
				? Number(body.spend.dailyMaxUsd)
				: undefined,
			reserveFloorUsd: Number.isFinite(Number(body.spend.reserveFloorUsd))
				? Number(body.spend.reserveFloorUsd)
				: undefined,
			firewall:
				body.spend.firewall && typeof body.spend.firewall === 'object'
					? body.spend.firewall
					: undefined,
		});
	}

	const chain = new GuardChain({
		defiGuard: tradeGuard,
		spendGuard,
		x402Hook: createX402Hook(
			Number.isFinite(Number(body.x402HourlyBudgetUsd)) ? Number(body.x402HourlyBudgetUsd) : undefined,
		),
	});

	const approvalMode = ['auto-run', 'allow-list', 'manual', 'headless'].includes(body.approvalMode)
		? body.approvalMode
		: 'manual';
	const allowList = Array.isArray(body.allowList) ? body.allowList.slice(0, 500).map(String) : [];
	const confirmedHistory = Array.isArray(body.confirmedHistory)
		? body.confirmedHistory.slice(0, 500).map(String)
		: [];
	const userTier = typeof body.userTier === 'string' ? body.userTier : undefined;
	const agentId = typeof body.agentId === 'string' ? body.agentId.slice(0, 200) : undefined;
	const userId = typeof body.userId === 'string' ? body.userId.slice(0, 200) : undefined;
	const balanceUsd = Number.isFinite(Number(body.balanceUsd)) ? Number(body.balanceUsd) : undefined;

	// One price fetch covers every call in the batch; on failure the notional
	// stays unresolved, which the verdict reports rather than hides.
	let solUsd = null;
	if (calls.some((c) => c.valueUsd === undefined && solAmountOf(c) > 0)) {
		try {
			solUsd = await solUsdPrice();
		} catch {
			solUsd = null;
		}
	}

	const verdicts = [];
	for (const call of calls) {
		if (call.valueUsd === undefined && solUsd) {
			const sol = solAmountOf(call);
			if (sol > 0) call.valueUsd = sol * solUsd;
		}
		const verdict = await chain.evaluate({
			agentId,
			allowList,
			apiName: call.apiName,
			approvalMode,
			arguments: call.arguments,
			balanceUsd,
			chainId: call.chainId,
			confirmedHistory,
			destination: call.destination,
			executionPath: call.executionPath,
			identifier: call.identifier,
			interventionConfig: call.interventionConfig,
			protocol: call.protocol,
			token: call.token,
			userId,
			userSwapCaps: body.userSwapCaps,
			userSwapVolume: body.userSwapVolume,
			userTier,
			valueUsd: call.valueUsd,
			x402: call.x402,
		});
		verdicts.push({ apiName: call.apiName, identifier: call.identifier, verdict });
	}

	return json(res, 200, { engine: '@three-ws/agent-runtime', verdicts });
});
