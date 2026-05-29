// GET /openapi.json — x402 OpenAPI discovery document
// Preferred over /.well-known/x402 by x402scan.

import { env } from './_lib/env.js';
import { cors, json, method, wrap } from './_lib/http.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const origin = env.APP_ORIGIN;

	return json(
		res,
		200,
		{
			openapi: '3.1.0',
			info: {
				title: 'three.ws API',
				version: '1.0.0',
				description:
					'API for 3D avatar management, AI agent identity, and MCP tool access.',
				'x-guidance':
					'Use POST /api/mcp to interact with the MCP server. Send a JSON-RPC 2.0 request body. ' +
					'Authenticate with a Bearer access token obtained via OAuth 2.1 at ' +
					origin +
					'/oauth/authorize, or use a Bearer API key from the dashboard. ' +
					'Available MCP tools: list_my_avatars, get_avatar, search_public_avatars, ' +
					'render_avatar, delete_avatar, validate_model, inspect_model, optimize_model.',
			},
			servers: [{ url: origin }],
			components: {
				securitySchemes: {
					bearerAuth: {
						type: 'http',
						scheme: 'bearer',
						description:
							'Bearer token in the Authorization header. Obtain one via OAuth 2.1 at ' +
							origin +
							'/oauth/authorize, use an API key from the dashboard, or exchange a ' +
							'wallet SIWX (CAIP-122) session for an access token.',
					},
				},
			},
			paths: {
				'/api/mcp': {
					post: {
						operationId: 'mcp_call',
						summary: 'MCP tool call',
						description:
							'JSON-RPC 2.0 request to the MCP server. Supports tools for 3D avatar management, model validation, inspection, and optimization.',
						security: [{ bearerAuth: [] }],
						requestBody: {
							required: true,
							content: {
								'application/json': {
									schema: {
										type: 'object',
										required: ['jsonrpc', 'method'],
										properties: {
											jsonrpc: {
												type: 'string',
												enum: ['2.0'],
											},
											id: {
												oneOf: [{ type: 'string' }, { type: 'number' }],
											},
											method: {
												type: 'string',
												description:
													'MCP method name, e.g. "tools/call" or "initialize".',
											},
											params: {
												type: 'object',
												description: 'Method-specific parameters.',
											},
										},
									},
								},
							},
						},
						responses: {
							200: { description: 'JSON-RPC 2.0 response' },
							401: { description: 'Unauthorized — missing or invalid token' },
							402: { description: 'Payment Required' },
							429: { description: 'Rate limited' },
						},
						'x-payment-info': {
							price: {
								mode: 'fixed',
								currency: 'USD',
								amount: '0.001',
							},
							// Per spec, protocols lists protocol *support* (one entry per
							// protocol). Per-network payment lanes are advertised at runtime
							// in the 402 challenge `accepts[]` array — see api/_lib/x402-spec.js
							// `paymentRequirements()` which emits Solana USDC + Base USDC.
							protocols: [
								{ x402: {} },
								{
									mpp: {
										method: 'solana-pay',
										intent: 'purchase',
										currency: 'USDC',
									},
								},
							],
						},
					},
				},
				'/api/avatars': {
					get: {
						operationId: 'list_avatars',
						summary: 'List my avatars',
						security: [{ bearerAuth: [] }],
						responses: {
							200: { description: 'Array of avatar objects' },
							401: { description: 'Unauthorized' },
						},
					},
					post: {
						operationId: 'create_avatar',
						summary: 'Register an uploaded avatar',
						security: [{ bearerAuth: [] }],
						requestBody: {
							required: true,
							content: {
								'application/json': {
									schema: {
										type: 'object',
										required: ['storage_key', 'name', 'content_type'],
										properties: {
											storage_key: { type: 'string' },
											name: { type: 'string', maxLength: 100 },
											description: { type: 'string', maxLength: 500 },
											content_type: {
												type: 'string',
												enum: ['model/gltf-binary', 'model/gltf+json'],
											},
											visibility: {
												type: 'string',
												enum: ['private', 'unlisted', 'public'],
											},
											tags: {
												type: 'array',
												items: { type: 'string' },
											},
										},
									},
								},
							},
						},
						responses: {
							201: { description: 'Avatar created' },
							401: { description: 'Unauthorized' },
						},
					},
				},
				'/api/avatars/public': {
					get: {
						operationId: 'browse_public_avatars',
						summary: 'Browse public avatars',
						security: [],
						parameters: [
							{ name: 'q', in: 'query', schema: { type: 'string' } },
							{
								name: 'limit',
								in: 'query',
								schema: { type: 'integer', default: 20, maximum: 100 },
							},
							{ name: 'cursor', in: 'query', schema: { type: 'string' } },
						],
						responses: {
							200: { description: 'Paginated list of public avatars' },
						},
					},
				},
				'/api/agents': {
					get: {
						operationId: 'list_agents',
						summary: 'List my agents',
						security: [{ bearerAuth: [] }],
						responses: {
							200: { description: 'Array of agent identity objects' },
							401: { description: 'Unauthorized' },
						},
					},
				},
				'/api/healthz': {
					get: {
						operationId: 'healthz',
						summary: 'Service liveness',
						description: 'Lightweight liveness probe with uptime + service version. No auth.',
						responses: {
							200: { description: 'Health summary JSON' },
						},
					},
				},
				'/api/pump/curve': {
					get: {
						operationId: 'pump_curve',
						summary: 'Pump.fun bonding-curve snapshot',
						description:
							'Returns raw bonding-curve state, current spot price + market cap, and graduation progress for a Pump.fun token. Public, edge-cached for 10s.',
						parameters: [
							{ name: 'mint', in: 'query', required: true, schema: { type: 'string' }, description: 'Base58 SPL mint address' },
							{ name: 'network', in: 'query', schema: { type: 'string', enum: ['mainnet', 'devnet'] } },
						],
						responses: {
							200: { description: 'Bonding curve snapshot' },
							400: { description: 'Bad mint' },
							404: { description: 'No bonding curve for that mint' },
						},
					},
				},
				'/api/pump/quote-sdk': {
					get: {
						operationId: 'pump_quote_sdk',
						summary: 'Pump.fun buy/sell quote (SDK-precise)',
						description:
							'Deterministic buy or sell quote computed via @nirholas/pump-sdk on the live bonding curve. Returns output amount, price impact %, and a market context block.',
						parameters: [
							{ name: 'mint', in: 'query', required: true, schema: { type: 'string' } },
							{ name: 'side', in: 'query', required: true, schema: { type: 'string', enum: ['buy', 'sell'] } },
							{ name: 'amount', in: 'query', required: true, schema: { type: 'number', minimum: 0 }, description: 'For buy: SOL. For sell: tokens (UI units, 6 decimals).' },
							{ name: 'network', in: 'query', schema: { type: 'string', enum: ['mainnet', 'devnet'] } },
						],
						responses: {
							200: { description: 'Quote payload with input/output and priceImpactPct' },
							400: { description: 'Validation error' },
							404: { description: 'No bonding curve for that mint' },
						},
					},
				},
				'/api/x402/agent-reputation': {
					get: {
						operationId: 'x402_agent_reputation',
						summary: 'Paid: Agent Reputation snapshot',
						description:
							'Pay $0.01 USDC to retrieve a three.ws agent\'s reputation snapshot synthesized from pump_agent_payments, distribute/buyback success history, and signed Solana memo attestations.',
						parameters: [
							{ name: 'agent_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } },
						],
						responses: {
							200: { description: 'Reputation snapshot JSON' },
							400: { description: 'Missing or invalid agent_id' },
							402: { description: 'Payment Required (x402)' },
							404: { description: 'agent_id not found' },
						},
						'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.01' } },
					},
				},
				'/api/x402/onchain-identity-verify': {
					get: {
						operationId: 'x402_onchain_identity_verify',
						summary: 'Paid: Verify counterparty agent ownership claim',
						description:
							'Pay $0.005 USDC to verify whether a three.ws agent_id actually owns/deployed a given contract or mint on a given CAIP-2 chain, using the canonical meta.onchain unified index.',
						parameters: [
							{ name: 'agent_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } },
							{ name: 'chain', in: 'query', required: true, schema: { type: 'string' } },
							{ name: 'contract_or_mint', in: 'query', required: true, schema: { type: 'string' } },
						],
						responses: {
							200: { description: 'Verification result JSON' },
							400: { description: 'Missing or invalid parameters' },
							402: { description: 'Payment Required (x402)' },
						},
						'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.005' } },
					},
				},
				'/api/x402/pump-agent-audit': {
					get: {
						operationId: 'x402_pump_agent_audit',
						summary: 'Paid: Operational audit of a pump.fun agent-payments token',
						description:
							'Pay $0.02 USDC to retrieve a full operational audit of a pump.fun mint: USDC paid in, distinct payers, distribute/buyback success history, latest error reasons, and derived risk flags.',
						parameters: [
							{ name: 'mint', in: 'query', required: true, schema: { type: 'string', minLength: 32, maxLength: 44 } },
						],
						responses: {
							200: { description: 'Audit JSON' },
							400: { description: 'Missing or invalid mint' },
							402: { description: 'Payment Required (x402)' },
							404: { description: 'Mint not indexed' },
						},
						'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.02' } },
					},
				},
				'/api/x402/skill-marketplace': {
					get: {
						operationId: 'x402_skill_marketplace',
						summary: 'Paid: Browse the three.ws skill marketplace',
						description:
							'Pay $0.001 USDC to list active skill listings with prices across all three.ws agents. Optional skill filter returns the cheapest provider for that capability.',
						parameters: [
							{ name: 'skill', in: 'query', schema: { type: 'string' } },
							{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
						],
						responses: {
							200: { description: 'Marketplace listings JSON' },
							402: { description: 'Payment Required (x402)' },
						},
						'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.001' } },
					},
				},
				'/api/x402/symbol-availability': {
					get: {
						operationId: 'x402_symbol_availability',
						summary: 'Paid: Check pump.fun ticker collisions before launch',
						description:
							'Pay $0.001 USDC to check whether a candidate ticker collides with any three.ws-indexed pump.fun mint. Returns exact matches plus trigram-similar tickers and a recommendation.',
						parameters: [
							{ name: 'ticker', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 32 } },
							{ name: 'network', in: 'query', schema: { type: 'string', enum: ['mainnet', 'devnet'] } },
						],
						responses: {
							200: { description: 'Symbol availability JSON' },
							400: { description: 'Missing or invalid ticker' },
							402: { description: 'Payment Required (x402)' },
						},
						'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.001' } },
					},
				},
				'/api/x402/mint-to-mesh-batch': {
					post: {
						operationId: 'x402_mint_to_mesh_batch',
						summary: 'Paid: Batch 1–10 mints → themed binary glTF cubes',
						description:
							'Pay $0.05 USDC to resolve 1–10 Solana SPL mints to themed binary glTF cubes in a single call. Per-mint failures report ok:false instead of failing the whole batch.',
						requestBody: {
							required: true,
							content: {
								'application/json': {
									schema: {
										type: 'object',
										required: ['mints'],
										properties: {
											mints: {
												type: 'array',
												minItems: 1,
												maxItems: 10,
												items: { type: 'string', minLength: 32, maxLength: 44 },
											},
										},
									},
								},
							},
						},
						responses: {
							200: { description: 'Batch mesh JSON' },
							400: { description: 'Missing or invalid body' },
							402: { description: 'Payment Required (x402)' },
						},
						'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.05' } },
					},
				},
				'/api/x402/model-check': {
					get: {
						operationId: 'x402_model_check',
						summary: 'Paid: glTF/GLB structural stats + optimization recommendations',
						description:
							'Pay $0.001 USDC to fetch a glTF/GLB model from a URL and return structural stats (vertex/triangle counts, materials, textures, animations, extensions) plus a prioritized list of optimization recommendations.',
						parameters: [
							{
								name: 'url',
								in: 'query',
								required: true,
								schema: { type: 'string', format: 'uri' },
								description: 'Public HTTPS URL of a glTF/GLB model.',
							},
						],
						responses: {
							200: { description: 'Inspection + recommendation JSON' },
							400: { description: 'Missing or invalid url' },
							402: { description: 'Payment Required (x402)' },
						},
						'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.001' } },
					},
				},
				'/api/x402/mint-to-mesh': {
					get: {
						operationId: 'x402_mint_to_mesh',
						summary: 'Paid: Single Solana mint → themed binary glTF cube',
						description:
							'Pay $0.001 USDC to resolve a Solana fungible-token mint to a binary glTF (GLB) cube themed for that token. Color is hashed from the mint; the Metaplex JSON image, when present, is embedded as a baseColor texture.',
						parameters: [
							{
								name: 'mint',
								in: 'query',
								required: true,
								schema: { type: 'string', minLength: 32, maxLength: 44 },
								description: 'Base58 SPL mint address on Solana mainnet.',
							},
						],
						responses: {
							200: { description: 'Themed GLB JSON envelope' },
							400: { description: 'Missing or invalid mint' },
							402: { description: 'Payment Required (x402)' },
						},
						'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.001' } },
					},
				},
				'/api/insights/revenue-vision': {
					get: {
						operationId: 'insights_revenue_vision',
						summary: 'Paid: Claude-powered next-best-move for a mission brief',
						description:
							'Pay $0.001 USDC to receive a single prioritized next-best move, a data-grounded insight, and an honestly-calibrated confidence rating for the supplied mission brief.',
						parameters: [
							{ name: 'agent_codename', in: 'query', required: true, schema: { type: 'string' } },
							{
								name: 'power_request',
								in: 'query',
								required: true,
								description:
									'Analysis mode. Currently only "revenue-vision" is available; the parameter is required so additional modes can be added without a breaking change.',
								schema: { type: 'string', enum: ['revenue-vision'] },
							},
							{
								name: 'mission_brief',
								in: 'query',
								required: true,
								schema: { type: 'string', minLength: 4, maxLength: 4000 },
							},
						],
						responses: {
							200: { description: 'Next-best-move JSON' },
							400: { description: 'Missing or invalid parameters' },
							402: { description: 'Payment Required (x402)' },
						},
						'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.001' } },
					},
				},
				'/api/x402/permit2-paid-demo': {
					get: {
						operationId: 'x402_permit2_paid_demo',
						summary: 'Paid: Gasless Permit2 + EIP-2612 settlement demo',
						description:
							'Pay $0.001 USDC via the Permit2-only path so a wallet holding USDC but zero ETH can complete the flow. CDP\'s x402ExactPermit2Proxy submits the EIP-2612 permit + Permit2 transfer atomically; the response surfaces the on-chain tx hash and a Basescan link.',
						responses: {
							200: { description: 'Settlement summary with tx hash' },
							402: { description: 'Payment Required (x402)' },
						},
						'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.001' } },
					},
				},
				'/api/x402/dance-tip': {
					get: {
						operationId: 'x402_dance_tip',
						summary: 'Paid: Tip a 3D dancer to perform a routine on the club stage',
						description:
							'Pay $0.001 USDC to tip a dancer to perform one routine on the three.ws 3D club stage. ' +
							'Pick a stage slot (1–4) and a style: free-floor (rumba, silly, thriller, capoeira, hiphop) ' +
							'or pole choreography (spin, climb, combo). Returns a performance ticket the /club page ' +
							'consumes to spawn the dancer and play the routine.',
						parameters: [
							{
								name: 'dancer',
								in: 'query',
								required: true,
								schema: { type: 'string', enum: ['1', '2', '3', '4'] },
								description: 'Stage slot — which of the four dancers performs.',
							},
							{
								name: 'dance',
								in: 'query',
								required: true,
								schema: {
									type: 'string',
									enum: [
										'rumba',
										'silly',
										'thriller',
										'capoeira',
										'hiphop',
										'spin',
										'climb',
										'combo',
									],
								},
								description:
									'Performance style. Free-floor styles (rumba, silly, thriller, capoeira, hiphop) play a single looped clip; pole-choreography styles (spin, climb, combo) chain a sequence of clips.',
							},
						],
						responses: {
							200: { description: 'Performance ticket JSON' },
							400: { description: 'Missing or invalid parameters' },
							402: { description: 'Payment Required (x402)' },
						},
						'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.001' } },
					},
				},
				'/api/x402/asset-download': {
					get: {
						operationId: 'x402_asset_download',
						summary: 'Paid: Unlock a 3D asset (GLB / avatar / accessory)',
						description:
							'Pay in USDC once to unlock a 3D asset hosted on R2. Wallets that already paid can re-download for free by signing in with SIWX (CAIP-122). Each asset has its own price and creator payout address; the response carries a short-lived presigned R2 URL.',
						parameters: [
							{
								name: 'slug',
								in: 'query',
								required: true,
								schema: { type: 'string', minLength: 1, maxLength: 128 },
								description: 'Unique asset slug from the paid_assets catalog.',
							},
						],
						responses: {
							200: { description: 'Presigned R2 download URL' },
							400: { description: 'Missing or invalid slug' },
							402: { description: 'Payment Required (x402)' },
							404: { description: 'Asset not found' },
						},
						'x-payment-info': {
							price: { mode: 'variable', currency: 'USD' },
							note: 'Each asset declares its own USDC price; the live 402 challenge reflects the per-asset row.',
						},
					},
				},
			},
		},
		{ 'cache-control': 'public, max-age=300' },
	);
});
