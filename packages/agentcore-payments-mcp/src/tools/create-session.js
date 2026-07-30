// `create_payment_session` — fund a new payment session from your credits.
//
// Creates a spend envelope: the platform reserves the budget from your credit
// balance and returns a one-time bearer token. Hand this token to an agent via
// PAYMENT_SESSION_TOKEN or pass it inline to pay_with_session. When the session
// expires or is cancelled, the un-spent budget is refunded to your credits.
//
// Required: THREE_WS_SESSION (your account session for credit deduction).

import { z } from 'zod';
import { apiRequest } from '../lib/api.js';

export const def = {
	name: 'create_payment_session',
	title: 'Create a funded agent payment session',
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	description:
		'Create a platform-managed payment session that funds agent x402 payments from your credits. ' +
		'The agent never needs a private key — it uses the returned session token to call pay_with_session. ' +
		'Governance enforces your budget_usd ceiling, optional per-payment cap (max_per_tx_usd), URL allowlist, ' +
		'and time expiry. Un-spent budget is automatically refunded on cancel or expiry. ' +
		'Returns: session object + token (shown once — store securely). Requires THREE_WS_SESSION.',
	inputSchema: {
		budget_usd: z.number().positive()
			.describe('Total budget in USD to allocate to this session (drawn from your credits). Min $0.001, max $1000.'),
		label: z.string().max(120).optional()
			.describe('Human-readable label for this session (e.g. "Research run #4").'),
		expiry_seconds: z.number().int().min(60).max(7776000).default(3600)
			.describe('Session lifetime in seconds. After expiry, payments are rejected. Default: 3600 (1 hour).'),
		max_per_tx_usd: z.number().positive().optional()
			.describe('Optional per-payment ceiling in USD. Payments exceeding this are rejected before any money moves.'),
		allowed_hosts: z.array(z.string()).max(50).optional()
			.describe('If set, only allow payments to endpoints at these hosts (e.g. ["api.weather.com"]). Empty = any host.'),
		agent_id: z.string().uuid().optional()
			.describe('Optional: restrict this session token to a specific agent identity UUID.'),
		network: z.literal('solana').default('solana')
			.describe('Settlement network for x402 payments. Solana USDC only.'),
		metadata: z.record(z.any()).optional()
			.describe('Optional arbitrary metadata to attach to this session for bookkeeping.'),
	},
	async handler(args) {
		const data = await apiRequest('/api/pay/session', {
			method: 'POST',
			auth: true,
			body: {
				budget_usd: args.budget_usd,
				label: args.label ?? '',
				expiry_seconds: args.expiry_seconds ?? 3600,
				max_per_tx_usd: args.max_per_tx_usd ?? null,
				allowed_hosts: args.allowed_hosts ?? [],
				agent_id: args.agent_id ?? null,
				network: args.network ?? 'solana',
				metadata: args.metadata ?? {},
			},
		});

		return {
			ok: true,
			session: data.session,
			token: data.token,
			note: data.note ?? 'Store this token securely. It is shown once and cannot be recovered. Set PAYMENT_SESSION_TOKEN to use it as the default.',
		};
	},
};
