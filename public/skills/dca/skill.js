// DCA skill — client-side setup and execute handlers.
// Server-side execution (onPeriod) lives in api/cron/run-dca.js.

// Cookie-session mutations need the double-submit CSRF token: fetch a
// single-use token from /api/csrf-token and echo it in x-csrf-token. Inlined
// (not imported from /src/api.js) because this file is also loaded outside
// the page module graph (skill sandbox worker, server-side cron import).
async function csrfToken(fetchImpl) {
	const f = fetchImpl || fetch;
	try {
		const r = await f('/api/csrf-token', { credentials: 'include' });
		if (!r.ok) return '';
		const j = await r.json();
		return j?.data?.token || '';
	} catch {
		return '';
	}
}

// ── Per-chain config ──────────────────────────────────────────────────────────

const CHAIN_CONFIG = {
	// Base Sepolia — default for all v0.1 strategies
	84532: {
		name: 'Base Sepolia',
		swap_router: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4',
		quoter_v2: '0xC5290058841028F1614F3A6F0F5816cAd0df5E27',
		usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
		tokens: {
			WETH: '0x4200000000000000000000000000000000000006',
			cbBTC: null, // not deployed on Sepolia
			USDT: null,
		},
	},
	// Base Mainnet — requires explicit owner opt-in
	8453: {
		name: 'Base Mainnet',
		swap_router: '0x2626664c2603336E57B271c5C0b26F421741e481',
		quoter_v2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
		usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
		tokens: {
			WETH: '0x4200000000000000000000000000000000000006',
			cbBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
			USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
		},
	},
};

// ERC-20 USDC has 6 decimals
const USDC_DECIMALS = 6;

// Function selectors
const SEL_EXACT_INPUT_SINGLE = '0x04e45aaf';
const SEL_APPROVE = '0x095ea7b3';

// ── Scope preset builder ──────────────────────────────────────────────────────

function buildScopePreset(chainId, amountPerExecution, periodSeconds) {
	const cfg = CHAIN_CONFIG[chainId];
	return {
		token: cfg.usdc,
		maxAmount: amountPerExecution,
		period: periodSeconds <= 86400 ? 'daily' : 'weekly',
		targets: [cfg.swap_router, cfg.usdc],
		selectors: [SEL_EXACT_INPUT_SINGLE, SEL_APPROVE],
		expiry_days: 30,
	};
}

// ── setup ─────────────────────────────────────────────────────────────────────

/**
 * Called once when the skill loads. Registers a "Start DCA" action visible only
 * to the agent owner.
 * @param {{ agent: object, host: object }} ctx
 */
export function setup({ agent, host }) {
	if (!host?.registerOwnerAction) return;
	host.registerOwnerAction({
		id: 'start_dca',
		label: 'Start DCA',
		description: 'Set up an automated USDC → WETH recurring swap via Uniswap V3.',
		icon: '🔄',
		handler: (args) => execute({ agent, host, args }),
	});
}

// ── execute ───────────────────────────────────────────────────────────────────

/**
 * Owner-facing: prompts for config, opens grant modal, stores strategy.
 * @param {{ agent: object, host: object, args: object }} ctx
 */
export async function execute({ agent, host, args = {} }) {
	const {
		amount_usdc = '10',
		token_out = 'WETH',
		frequency = 'daily',
		slippage_bps = 50,
		chain_id = 84532,
	} = args;

	// Mainnet guard — require explicit confirmation
	if (chain_id === 8453) {
		const confirmed = await host?.confirm(
			'You are about to set up a DCA strategy on Base Mainnet with real funds. Confirm?',
		);
		if (!confirmed) return { ok: false, code: 'mainnet_not_confirmed' };
	}

	const cfg = CHAIN_CONFIG[chain_id];
	if (!cfg)
		return { ok: false, code: 'unsupported_chain', message: `Chain ${chain_id} not supported` };

	const tokenOutAddress = cfg.tokens[token_out];
	if (!tokenOutAddress) {
		return {
			ok: false,
			code: 'unsupported_token',
			message: `${token_out} is not available on ${cfg.name}`,
		};
	}

	// Clamp slippage
	const slippage = Math.min(500, Math.max(10, Number(slippage_bps)));

	// Convert USDC amount to 6-decimal wei
	const amountPerExecution = String(Math.round(parseFloat(amount_usdc) * 10 ** USDC_DECIMALS));

	const periodSeconds = frequency === 'weekly' ? 7 * 86400 : 86400;

	const scopePreset = buildScopePreset(chain_id, amountPerExecution, periodSeconds);

	// Open delegation grant modal
	let delegationId;
	try {
		const grant = await host.openGrantModal({
			scope: scopePreset,
			description: `Allow agent to swap ${amount_usdc} USDC → ${token_out} ${frequency} for 30 days`,
		});
		if (!grant?.delegationId) {
			return { ok: false, code: 'grant_cancelled', message: 'Grant was not signed' };
		}
		delegationId = grant.delegationId;
	} catch (err) {
		return { ok: false, code: 'grant_error', message: err.message };
	}

	// Store strategy server-side
	const res = await fetch('/api/dca-strategies', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-csrf-token': await csrfToken() },
		credentials: 'include',
		body: JSON.stringify({
			agent_id: agent.id,
			delegation_id: delegationId,
			token_in: cfg.usdc,
			token_out: tokenOutAddress,
			token_out_symbol: token_out,
			amount_per_execution: amountPerExecution,
			period_seconds: periodSeconds,
			slippage_bps: slippage,
			chain_id,
		}),
	});

	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		return { ok: false, code: body.error || 'api_error', message: body.error_description };
	}

	const data = await res.json();
	return {
		ok: true,
		strategy_id: data.id,
		message: `DCA strategy created — ${amount_usdc} USDC → ${token_out} ${frequency} on ${cfg.name}.`,
	};
}

// ── Tool handlers (LLM-callable) ──────────────────────────────────────────────

export async function start_dca(args, ctx) {
	return execute({ agent: ctx.agent, host: ctx.host, args });
}

export async function list_dca_strategies(args, ctx) {
	const agentId = args.agent_id || ctx.agent?.id;
	if (!agentId) return { ok: false, error: 'agent_id required' };

	const res = await ctx.fetch(`/api/dca-strategies?agent_id=${encodeURIComponent(agentId)}`);
	if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
	return res.json();
}

export async function stop_dca(args, ctx) {
	const { strategy_id } = args;
	if (!strategy_id) return { ok: false, error: 'strategy_id required' };

	const res = await ctx.fetch(`/api/dca-strategies/${encodeURIComponent(strategy_id)}`, {
		method: 'DELETE',
		headers: { 'x-csrf-token': await csrfToken(ctx.fetch) },
	});
	if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
	return { ok: true };
}
