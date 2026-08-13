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
import { sql } from '../_lib/db.js';
import { confirmOrThrow } from '../_lib/solana/confirm.js';
import { hasScope } from '../_lib/auth.js';
import { Bazaar, filterByMaxPrice, filterByNetwork } from '../_lib/x402/bazaar-client.js';
import {
	getUserWalletStatus,
	payExternalX402,
	resolveSpendEnabled,
} from '../_lib/x402-user-payer.js';
import { getOrCreateAgentSolanaWallet, getSolanaAddressBalances } from '../_lib/agent-wallet.js';
import {
	createPaidService,
	validateTargetUrl,
	resolvePayoutAddress,
	serviceResourceUrl,
	atomicsToUsdc,
	usdcToAtomics,
	MonetizeError,
} from '../_lib/agent-paid-services.js';

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

// Designed "sign in" result for the null x402 path — these tools write to the
// user's own account, so an anonymous pay-per-call caller can never use them.
function signInRequired(text) {
	return {
		content: [{ type: 'text', text }],
		structuredContent: { signed_in: false },
		isError: true,
	};
}

// Scope is enforced inside the handler (not via the dispatcher's tool.scope) so
// the null-userId x402 path gets the friendly signInRequired() message first,
// and an authenticated-but-under-scoped token gets a clear, designed error
// rather than a bare JSON-RPC code.
function scopeRequired(scope) {
	return {
		content: [
			{
				type: 'text',
				text: `This action needs the ${scope} scope. Re-authorize with it granted.`,
			},
		],
		structuredContent: { ok: false, reason: 'insufficient_scope', required: scope },
		isError: true,
	};
}

// Load an agent the caller owns. Returns { row } on success or { error } with a
// designed not-found / forbidden result so handlers stay flat.
async function loadOwnedAgent(agentId, auth) {
	const [row] = await sql`
		SELECT id, user_id, meta, wallet_address
		FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
		LIMIT 1
	`;
	if (!row) {
		return {
			error: {
				content: [{ type: 'text', text: `No agent found with id ${agentId}.` }],
				structuredContent: { ok: false, reason: 'agent_not_found' },
				isError: true,
			},
		};
	}
	if (row.user_id !== auth.userId) {
		return {
			error: {
				content: [{ type: 'text', text: "That agent isn't on your account." }],
				structuredContent: { ok: false, reason: 'forbidden' },
				isError: true,
			},
		};
	}
	return { row };
}

// Request a 1 SOL devnet airdrop for a freshly provisioned wallet. Devnet only;
// never called on mainnet. Returns the signature or a reason on failure — an
// unavailable faucet must not fail the whole provision call.
async function requestDevnetAirdrop(address) {
	const { solanaConnection } = await import('../_lib/agent-pumpfun.js');
	const { PublicKey, LAMPORTS_PER_SOL } = await import('@solana/web3.js');
	try {
		const conn = solanaConnection('devnet');
		const signature = await conn.requestAirdrop(new PublicKey(address), LAMPORTS_PER_SOL);
		await confirmOrThrow(conn, signature, 'confirmed');
		return { ok: true, signature, sol: 1 };
	} catch (err) {
		const rateLimited = /429|limit/i.test(err?.message || '');
		return {
			ok: false,
			reason: rateLimited ? 'faucet_rate_limited' : 'faucet_unavailable',
			message: err?.message || 'devnet airdrop failed',
		};
	}
}

export const toolDefs = [
	{
		name: 'wallet_status',
		title: "Check the agent's wallet",
		// Read-only; balances move between calls, so not idempotent.
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
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
			// Address, balances and caps are account data, so the token has to
			// carry a wallet grant. wallet:write satisfies it too: a caller
			// allowed to spend may obviously read what it is spending.
			if (!hasScope(auth.scope, 'wallet:read') && !hasScope(auth.scope, 'wallet:write')) {
				return scopeRequired('wallet:read');
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
				: [
						'No agent wallet is provisioned for this account yet. Create one on three.ws to enable payments.',
					];
			return {
				content: [{ type: 'text', text: lines.join('\n') }],
				structuredContent: { signed_in: true, ...status },
			};
		},
	},
	{
		name: 'find_services',
		title: 'Find paid services the agent can call',
		// Read-only search over the live facilitator network.
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		description:
			'Search the live x402 facilitator network for paid services (HTTP APIs and MCP tools). Returns each match with its price and resource URL — feed a resource into pay_and_call to actually use it.',
		inputSchema: {
			type: 'object',
			properties: {
				query: {
					type: 'string',
					description: 'What you need, e.g. "weather", "image upscale".',
				},
				type: { type: 'string', enum: ['http', 'mcp'], default: 'http' },
				network: {
					type: 'string',
					description: 'CAIP-2 network filter, e.g. "solana:*" or "eip155:8453".',
				},
				// Bounded: past 1e21 the atomic conversion stringifies in
				// exponential notation, which filterByMaxPrice rejects with an
				// internal TypeError. A ceiling keeps it a designed -32602.
				max_price_usdc: { type: 'number', minimum: 0, maximum: 1_000_000 },
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
						.map(
							(s, i) =>
								`${i + 1}. ${s.name || s.resource}${s.price ? ` — ${s.price}` : ''}\n   ${s.resource}`,
						)
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
		// Spends the user's USDC — an irreversible transfer, so destructive.
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
		description:
			"Call a paid x402 endpoint and settle the USDC payment automatically from the signed-in user's three.ws agent wallet, bounded by spending caps. Returns the service's response. Requires sign-in. If the per-call price exceeds max_usd (or the caps), the call is refused before any money moves.",
		inputSchema: {
			type: 'object',
			properties: {
				resource_url: {
					type: 'string',
					format: 'uri',
					description: 'The x402 endpoint to call.',
				},
				method: { type: 'string', enum: ['GET', 'POST'], default: 'GET' },
				body: { type: 'object', description: 'JSON body for POST requests.' },
				max_usd: {
					type: 'number',
					minimum: 0,
					description:
						'Hard ceiling for THIS call in USD. Can only lower the server caps, never raise them.',
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

			// Spending the user's USDC needs the same wallet:write grant that
			// provision_wallet requires. Checked after the degrade branch so a
			// spend-disabled server still answers with the manual pay link, and
			// before payExternalX402 so no money can move without the grant.
			if (!hasScope(auth.scope, 'wallet:write')) return scopeRequired('wallet:write');

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
					invalid_url: 'That resource URL is not a permitted public https endpoint.',
					blocked_url:
						'That resource URL resolves to a non-public address and was blocked.',
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
	{
		name: 'provision_wallet',
		title: "Create the agent's wallet",
		// Creates a wallet (idempotent for an existing one, but airdrop:true
		// re-requests the faucet each call — conservative hint is false).
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		description:
			'Create (or return) the custodial Solana wallet for one of your agents so it can hold and earn USDC. Idempotent — if the agent already has a wallet, its address and live SOL/USDC balances are returned unchanged. On devnet you can request a 1 SOL airdrop for testing; mainnet wallets are never airdropped. Requires sign-in; you can only provision wallets for agents on your own account.',
		inputSchema: {
			type: 'object',
			properties: {
				agent_id: {
					type: 'string',
					format: 'uuid',
					description: 'The agent to provision a wallet for.',
				},
				cluster: { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
				airdrop: {
					type: 'boolean',
					default: false,
					description: 'Devnet only — request a 1 SOL faucet airdrop after provisioning.',
				},
			},
			required: ['agent_id'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			await enforce(limits.mcpAgent, auth);
			if (!auth.userId) {
				return signInRequired('Sign in to three.ws to provision an agent wallet.');
			}
			if (!hasScope(auth.scope, 'wallet:write')) return scopeRequired('wallet:write');

			const cluster = args.cluster === 'devnet' ? 'devnet' : 'mainnet';
			const owned = await loadOwnedAgent(args.agent_id, auth);
			if (owned.error) return owned.error;

			const { address, created } = await getOrCreateAgentSolanaWallet(args.agent_id);

			// Airdrop is devnet-only and best-effort — never on mainnet, never
			// fabricated. A faucet failure is surfaced as a note, not an error.
			let airdrop = null;
			if (cluster === 'devnet' && args.airdrop) {
				airdrop = await requestDevnetAirdrop(address);
			}

			const balances = await getSolanaAddressBalances(address, cluster);

			const lines = [
				`${created ? 'Provisioned' : 'Wallet already exists for'} agent ${args.agent_id}`,
				`Address: ${address}`,
				`Cluster: ${cluster}`,
				`Balance: ${balances.sol ?? '?'} SOL, ${balances.usdc ?? '?'} USDC`,
			];
			if (cluster === 'mainnet' && args.airdrop) {
				lines.push('Airdrop skipped: the faucet is devnet only.');
			}
			if (airdrop) {
				lines.push(
					airdrop.ok
						? `Airdropped 1 SOL on devnet (sig ${airdrop.signature}).`
						: `Devnet airdrop unavailable: ${airdrop.reason}.`,
				);
			}

			return {
				content: [{ type: 'text', text: lines.join('\n') }],
				structuredContent: {
					ok: true,
					agent_id: args.agent_id,
					address,
					cluster,
					sol_balance: balances.sol,
					usdc_balance: balances.usdc,
					created,
					...(airdrop ? { airdrop } : {}),
				},
			};
		},
	},
	{
		name: 'monetize_endpoint',
		title: 'Publish a paid endpoint to earn USDC',
		// Publishes a new listing each call — additive write, never destructive.
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		description:
			"Put a price on an upstream API your agent already serves and publish it as an x402 endpoint other agents can pay to call. three.ws hosts the paywall, settles each buyer's USDC to your agent's own wallet, and proxies the call to your target_url. The listing becomes discoverable via find_services / the bazaar and callable by pay_and_call. Requires a provisioned wallet for the chosen network — run provision_wallet first if you haven't. Requires sign-in; you can only monetize agents on your own account.",
		inputSchema: {
			type: 'object',
			properties: {
				agent_id: { type: 'string', format: 'uuid' },
				name: { type: 'string', minLength: 1, maxLength: 120 },
				description: { type: 'string', minLength: 1, maxLength: 2000 },
				price_usdc: {
					type: 'number',
					exclusiveMinimum: 0,
					description: 'Price per call in USDC.',
				},
				target_url: {
					type: 'string',
					format: 'uri',
					description:
						'The public https upstream you already serve, called after payment settles.',
				},
				method: { type: 'string', enum: ['GET', 'POST'], default: 'POST' },
				input_schema: {
					type: 'object',
					description: 'Optional JSON Schema for the request body.',
				},
				// Base is the default monetization rail: it matches the handler's own
				// fallback (`args.network === 'solana' ? 'solana' : 'base'`) and
				// createPaidService's `network = 'base'`. The validator compiles with
				// Ajv `useDefaults: true`, so this default is written into `args.network`
				// before the handler runs — a `'solana'` default here silently forced
				// every default-network call onto the Solana payout path (reading the
				// usually-empty meta.solana_address) and rejected it as no_payout_wallet,
				// even for an agent with a Base EVM wallet.
				network: { type: 'string', enum: ['solana', 'base'], default: 'base' },
			},
			required: ['agent_id', 'name', 'description', 'price_usdc', 'target_url'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			await enforce(limits.mcpAgent, auth);
			if (!auth.userId) {
				return signInRequired('Sign in to three.ws to monetize an endpoint.');
			}
			if (!hasScope(auth.scope, 'services:write')) return scopeRequired('services:write');

			const network = args.network === 'solana' ? 'solana' : 'base';
			const owned = await loadOwnedAgent(args.agent_id, auth);
			if (owned.error) return owned.error;

			// Validate price early so an invalid value never reaches SSRF / DNS.
			let priceAtomics;
			try {
				priceAtomics = usdcToAtomics(args.price_usdc);
			} catch (err) {
				return {
					content: [{ type: 'text', text: err.message }],
					structuredContent: { ok: false, reason: err.code || 'invalid_price' },
					isError: true,
				};
			}

			// The agent must already have a payout wallet for this network.
			const payoutAddress = resolvePayoutAddress({ network, agentRow: owned.row });
			if (!payoutAddress) {
				const need = network === 'solana' ? 'a Solana wallet' : 'an EVM wallet';
				const hint =
					network === 'solana'
						? `Run provision_wallet for this agent to create ${need}, then monetize.`
						: `This agent needs ${need} (registered at agent creation) before it can earn on Base.`;
				return {
					content: [
						{
							type: 'text',
							text: `This agent has no payout wallet on ${network}. ${hint}`,
						},
					],
					structuredContent: { ok: false, reason: 'no_payout_wallet', network },
					isError: true,
				};
			}

			// SSRF-guard the upstream before we persist anything.
			let targetUrl;
			try {
				targetUrl = await validateTargetUrl(args.target_url);
			} catch (err) {
				const message =
					err instanceof MonetizeError
						? err.message
						: `target_url rejected: ${err?.message || err}`;
				return {
					content: [{ type: 'text', text: message }],
					structuredContent: { ok: false, reason: 'invalid_target_url' },
					isError: true,
				};
			}

			const row = await createPaidService({
				ownerUserId: auth.userId,
				agentId: args.agent_id,
				name: args.name,
				description: args.description,
				priceUsdc: args.price_usdc,
				targetUrl,
				method: args.method || 'POST',
				inputSchema: args.input_schema || null,
				network,
				payoutAddress,
			});

			const resourceUrl = serviceResourceUrl(row.slug);
			const priceUsdc = atomicsToUsdc(priceAtomics);
			return {
				content: [
					{
						type: 'text',
						text: [
							`Published "${row.name}" — $${priceUsdc} USDC per call on ${network}.`,
							`Resource: ${resourceUrl}`,
							`Payouts settle to ${payoutAddress}.`,
							'Other agents can now find it via find_services and pay it with pay_and_call.',
						].join('\n'),
					},
				],
				structuredContent: {
					ok: true,
					service_id: row.id,
					resource_url: resourceUrl,
					price_usdc: priceUsdc,
					network,
					bazaar_listed: row.bazaar_listed,
				},
			};
		},
	},
];
