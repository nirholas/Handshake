// threews-agent MCP — "add a wallet to Claude."
//
// Three tools turn a Claude (or any MCP client) into an autonomous economic
// agent on the live x402 network:
//   • wallet_status   — what the agent's wallet holds and is allowed to spend
//   • find_services   — discover paid services it can call
//   • pay_and_call    — pay an x402 endpoint in USDC from the user's own wallet
//                       and return the result, bounded by spending caps
//
// pay_and_call moves real money. It requires an authenticated (OAuth) user so
// the agent spends THAT user's wallet, and it is hard-gated by
// THREEWS_AGENT_PAY_ENABLED on the server. When spend is disabled it degrades
// to returning the exact payment requirements + a pay link rather than failing.
import { limits } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';
import { Bazaar, filterByMaxPrice, filterByNetwork } from '../_lib/x402/bazaar-client.js';
import {
	getUserWalletStatus,
	payExternalX402,
	resolveSpendEnabled,
} from '../_lib/x402-user-payer.js';

function rpcError(code, message, data) {
	const e = new Error(message);
	e.code = code;
	e.data = data;
	return e;
}

async function enforce(limiter, auth) {
	const rl = await limiter(auth.userId || auth.rateKey || 'anon');
	if (!rl.success) {
		throw rpcError(-32000, 'rate_limited', {
			retry_after: Math.ceil((rl.reset - Date.now()) / 1000),
		});
	}
}

function payLink(resource) {
	const u = new URL(`${env.APP_ORIGIN}/pay`);
	u.searchParams.set('resource', resource);
	return u.toString();
}

export const toolDefs = [
	{
		name: 'wallet_status',
		title: "Check the agent's wallet",
		description:
			"Show the signed-in user's three.ws agent wallet: address, SOL and USDC balance, the per-call/hour/day spending caps, and whether autonomous spending is enabled. Read-only — never moves funds. Call this before pay_and_call to confirm there's balance and headroom.",
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		async handler(args, auth) {
			await enforce(limits.mcpAgent, auth);
			if (!auth.userId) {
				return {
					content: [
						{ type: 'text', text: 'Sign in to three.ws to see your agent wallet.' },
					],
					structuredContent: { provisioned: false, signed_in: false },
					isError: true,
				};
			}
			const status = await getUserWalletStatus(auth.userId);
			const lines = status.provisioned
				? [
						`Agent wallet${status.agent_name ? ` (${status.agent_name})` : ''}: ${status.address}`,
						`Network: ${status.network}`,
						`Balance: ${status.balances.sol ?? '?'} SOL, ${status.balances.usdc ?? '?'} USDC`,
						`Spending caps: $${status.caps.max_per_call_usdc}/call, $${status.caps.max_per_hour_usdc}/hr, $${status.caps.max_per_day_usdc}/day`,
						`Autonomous spend: ${status.spend_enabled ? 'enabled' : 'disabled'}`,
					]
				: ['No agent wallet is provisioned for this account yet. Create one on three.ws to enable payments.'];
			return {
				content: [{ type: 'text', text: lines.join('\n') }],
				structuredContent: { signed_in: true, ...status },
			};
		},
	},
	{
		name: 'find_services',
		title: 'Find paid services the agent can call',
		description:
			'Search the live x402 facilitator network for paid services (HTTP APIs and MCP tools). Returns each match with its price and resource URL — feed a resource into pay_and_call to actually use it.',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'What you need, e.g. "weather", "image upscale".' },
				type: { type: 'string', enum: ['http', 'mcp'], default: 'http' },
				network: { type: 'string', description: 'CAIP-2 network filter, e.g. "solana:*" or "eip155:8453".' },
				max_price_usdc: { type: 'number', minimum: 0 },
				limit: { type: 'integer', minimum: 1, maximum: 50, default: 15 },
			},
			required: ['query'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			await enforce(limits.mcpAgent, auth);
			const type = args.type || 'http';
			const { resources, errors } = await new Bazaar({}).search({ query: args.query, type });
			let out = resources;
			if (args.network) out = filterByNetwork(out, args.network);
			if (args.max_price_usdc != null)
				out = filterByMaxPrice(out, String(Math.round(args.max_price_usdc * 1_000_000)));
			const services = out.slice(0, args.limit || 15).map((it) => ({
				resource: it.resource,
				name: it.serviceName || undefined,
				description: it.description || undefined,
				price: it.minPriceLabel || undefined,
				networks: it.networks,
				tool_name: it.toolName || undefined,
			}));
			const text = services.length
				? services
						.map((s, i) => `${i + 1}. ${s.name || s.resource}${s.price ? ` — ${s.price}` : ''}\n   ${s.resource}`)
						.join('\n')
				: `No services matched "${args.query}".`;
			return {
				content: [{ type: 'text', text }],
				structuredContent: { query: args.query, count: services.length, services, errors },
			};
		},
	},
	{
		name: 'pay_and_call',
		title: 'Pay an x402 service and return its result',
		description:
			"Call a paid x402 endpoint and settle the USDC payment automatically from the signed-in user's three.ws agent wallet, bounded by spending caps. Returns the service's response. Requires sign-in. If the per-call price exceeds max_usd (or the caps), the call is refused before any money moves.",
		inputSchema: {
			type: 'object',
			properties: {
				resource_url: { type: 'string', format: 'uri', description: 'The x402 endpoint to call.' },
				method: { type: 'string', enum: ['GET', 'POST'], default: 'GET' },
				body: { type: 'object', description: 'JSON body for POST requests.' },
				max_usd: {
					type: 'number',
					minimum: 0,
					description: 'Hard ceiling for THIS call in USD. Can only lower the server caps, never raise them.',
				},
			},
			required: ['resource_url'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			await enforce(limits.mcpAgentPay, auth);

			// Degrade gracefully when spend is off or the user can't pay: return the
			// exact payment details + a pay link instead of moving (or failing to move) funds.
			if (!resolveSpendEnabled() || !auth.userId) {
				return {
					content: [
						{
							type: 'text',
							text:
								(auth.userId
									? 'Autonomous spending is not enabled on this server yet. '
									: 'Sign in to pay from your wallet. ') +
								`You can complete this payment manually: ${payLink(args.resource_url)}`,
						},
					],
					structuredContent: {
						paid: false,
						reason: auth.userId ? 'spend_disabled' : 'auth_required',
						resource: args.resource_url,
						pay_link: payLink(args.resource_url),
					},
				};
			}

			try {
				const res = await payExternalX402({
					userId: auth.userId,
					url: args.resource_url,
					method: args.method || 'GET',
					body: args.body,
					maxUsd: args.max_usd,
				});
				return {
					content: [
						{
							type: 'text',
							text: `Paid and called ${args.resource_url} from ${res.payer}. Result returned below.`,
						},
					],
					structuredContent: {
						paid: true,
						payer: res.payer,
						resource: args.resource_url,
						result: res.result,
						receipt: res.receipt,
					},
				};
			} catch (err) {
				const friendly = {
					spend_disabled: 'Autonomous spending is disabled on this server.',
					auth_required: 'Sign in to pay from your wallet.',
					no_wallet: 'No agent wallet found for your account — create one on three.ws.',
					no_solana_wallet: 'Your agent has no Solana wallet provisioned.',
				};
				const msg = friendly[err.code] || `Payment failed: ${err.message}`;
				return {
					content: [{ type: 'text', text: msg }],
					structuredContent: {
						paid: false,
						reason: err.code || 'error',
						resource: args.resource_url,
						pay_link: payLink(args.resource_url),
					},
					isError: true,
				};
			}
		},
	},
];
