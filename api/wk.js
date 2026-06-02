// Consolidated /.well-known/* handler.
// Dispatches on ?name= query param set by vercel.json rewrites.

import { cors, json, method, wrap, error } from './_lib/http.js';
import { env } from './_lib/env.js';
import {
	paymentRequirements,
	bazaarExtension,
	build402Body,
	declareEip2612GasSponsoringExtension,
	declareErc20ApprovalGasSponsoringExtension,
	permit2VariantOf,
	NETWORK_BASE_MAINNET,
	NETWORK_SOLANA_MAINNET,
} from './_lib/x402-spec.js';
import { declareMcpDiscovery, withService } from './_lib/x402/bazaar-helpers.js';
import { TOOL_CATALOG } from './_mcp/catalog.js';
import { priceFor } from './_lib/pump-pricing.js';

// ── agent-attestation-schemas ─────────────────────────────────────────────────

const COMMON = {
	v: { type: 'integer', const: 1 },
	kind: { type: 'string' },
	agent: { type: 'string', description: 'Metaplex Core asset pubkey (base58)' },
	ts: { type: 'integer', description: 'Unix seconds when attestation was created' },
};

const SCHEMAS = {
	'threews.feedback.v1': {
		description: 'Client → agent feedback.',
		required: ['v', 'kind', 'agent', 'score'],
		properties: {
			...COMMON,
			score: { type: 'integer', minimum: 1, maximum: 5 },
			task_id: { type: 'string' },
			uri: { type: 'string', format: 'uri' },
		},
	},
	'threews.validation.v1': {
		description: 'Validator attestation about an agent task result.',
		required: ['v', 'kind', 'agent', 'task_hash', 'passed'],
		properties: {
			...COMMON,
			task_hash: { type: 'string' },
			passed: { type: 'boolean' },
			uri: { type: 'string', format: 'uri' },
		},
	},
	'threews.task.v1': {
		description: 'Client posts a task offer to an agent.',
		required: ['v', 'kind', 'agent', 'task_id', 'scope_hash'],
		properties: {
			...COMMON,
			task_id: { type: 'string' },
			scope_hash: { type: 'string' },
			uri: { type: 'string', format: 'uri' },
		},
	},
	'threews.accept.v1': {
		description: 'Agent accepts a task.',
		required: ['v', 'kind', 'agent', 'task_id'],
		properties: { ...COMMON, task_id: { type: 'string' } },
	},
	'threews.revoke.v1': {
		description: 'Revoke a previous attestation.',
		required: ['v', 'kind', 'agent', 'target_signature'],
		properties: { ...COMMON, target_signature: { type: 'string' }, reason: { type: 'string' } },
	},
	'threews.dispute.v1': {
		description: 'Agent owner disputes a feedback or validation.',
		required: ['v', 'kind', 'agent', 'target_signature'],
		properties: {
			...COMMON,
			target_signature: { type: 'string' },
			reason: { type: 'string' },
			uri: { type: 'string', format: 'uri' },
		},
	},
};

function handleAttestationSchemas(req, res) {
	return json(
		res,
		200,
		{
			version: 1,
			transport: {
				type: 'spl-memo',
				program: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
				note: 'Each attestation is a signed memo tx with the agent asset pubkey as a non-signer key.',
			},
			schemas: SCHEMAS,
			discovery: {
				list_endpoint: '/api/agents/solana-attestations?asset=<pubkey>&kind=...',
				reputation_endpoint: '/api/agents/solana-reputation?asset=<pubkey>',
			},
		},
		{ 'cache-control': 'public, max-age=300' },
	);
}

// ── oauth-authorization-server ────────────────────────────────────────────────

function handleOauthAuthServer(req, res) {
	const base = env.APP_ORIGIN;
	return json(
		res,
		200,
		{
			issuer: base,
			authorization_endpoint: `${base}/oauth/authorize`,
			token_endpoint: `${base}/api/oauth/token`,
			registration_endpoint: `${base}/api/oauth/register`,
			revocation_endpoint: `${base}/api/oauth/revoke`,
			introspection_endpoint: `${base}/api/oauth/introspect`,
			response_types_supported: ['code'],
			grant_types_supported: ['authorization_code', 'refresh_token'],
			code_challenge_methods_supported: ['S256'],
			token_endpoint_auth_methods_supported: [
				'none',
				'client_secret_basic',
				'client_secret_post',
			],
			scopes_supported: [
				'avatars:read',
				'avatars:write',
				'avatars:delete',
				'profile',
				'offline_access',
				// USE-21 auth-hints: paid endpoints advertise these scopes for
				// Bearer-token bypass via the auth-hints extension.
				'read:agent-reputation',
				'x402:bypass',
			],
			service_documentation: `${base}/docs/mcp`,
			ui_locales_supported: ['en'],
		},
		{ 'cache-control': 'public, max-age=300' },
	);
}

// ── oauth-protected-resource ──────────────────────────────────────────────────

function handleOauthProtectedResource(req, res) {
	return json(
		res,
		200,
		{
			resource: env.MCP_RESOURCE,
			authorization_servers: [env.APP_ORIGIN],
			bearer_methods_supported: ['header'],
			resource_documentation: `${env.APP_ORIGIN}/docs/mcp`,
			scopes_supported: ['avatars:read', 'avatars:write', 'avatars:delete', 'profile'],
		},
		{ 'cache-control': 'public, max-age=300' },
	);
}

// ── x402 ─────────────────────────────────────────────────────────────────────

function handleX402(req, res) {
	const mcpResource = `${env.APP_ORIGIN}/api/mcp`;
	const mcpService = withService({
		serviceName: 'three.ws MCP',
		tags: ['mcp', '3d', 'gltf', 'solana', 'agent'],
	});
	const body = build402Body({
		resourceUrl: mcpResource,
		accepts: paymentRequirements(mcpResource),
		serviceName: mcpService.serviceName,
		tags: mcpService.tags,
		iconUrl: mcpService.iconUrl,
	});
	return json(
		res,
		200,
		{
			...body,
			schemes: ['pump-agent-payments', 'x402', 'x402-v2'],
			pump_agent_payments: {
				prep: '/api/pump/accept-payment-prep',
				confirm: '/api/pump/accept-payment-confirm',
				balances: '/api/pump/balances',
			},
		},
		{ 'cache-control': 'public, max-age=300' },
	);
}

// ── x402 Bazaar discovery (/.well-known/x402.json) ───────────────────────────
// Crawled by agentic.market / Bazaar to index our paid endpoints.
// Schema: https://x402.org/schemas/discovery.json

const RAW_AMOUNT_TO_USDC = (raw) => {
	const n = Number(raw || 0) / 1_000_000;
	const decimals = n < 0.01 ? 4 : 2;
	const s = n.toFixed(decimals);
	const trimmed = s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
	return `$${trimmed}`;
};

// Build the per-endpoint `accepts` block for a given USDC atomics price.
// Each new /api/x402/* endpoint has its own price set in its handler via
// paidEndpoint(priceAtomics); the discovery doc has to mirror that or
// agentic.market shows the wrong price to potential buyers.
// Push an EVM accept entry followed by its Permit2 sibling so the Bazaar
// discovery doc mirrors the live 402 response exactly (EIP-3009 first,
// Permit2 second). Non-EVM entries get no sibling.
function pushAcceptWithPermit2Sibling(out, accept) {
	out.push(accept);
	const sibling = permit2VariantOf(accept);
	if (sibling) out.push(sibling);
}

// Per-resource extensions for the discovery catalog. The bazaar entry is
// always present; the two gasless-Permit2-onboarding extensions are added
// whenever any accept in the list opts into the Permit2 transfer method.
// EIP-2612 covers tokens that implement `permit()` (USDC, DAI, ...); the
// ERC-20 approval variant covers tokens that don't. Both let the facilitator
// sponsor the approve() so the payer never broadcasts the approval tx.
function extensionsForAccepts(accepts, bazaar) {
	const exts = { bazaar };
	if (accepts.some((a) => a?.extra?.assetTransferMethod === 'permit2')) {
		Object.assign(
			exts,
			declareEip2612GasSponsoringExtension(),
			declareErc20ApprovalGasSponsoringExtension(),
		);
	}
	return exts;
}

// Build the accepts[] block for a discovery-catalog entry. `resourceUrl` is
// echoed on every accept so reviewers + wallet/facilitator spend logs can
// reconcile each accept entry against the resource it gates, without having
// to walk back to the parent resource[] entry.
function acceptsForPrice(amountAtomics, resourceUrl) {
	const out = [];
	const price = RAW_AMOUNT_TO_USDC(amountAtomics);
	if (env.X402_PAY_TO_BASE) {
		pushAcceptWithPermit2Sibling(out, {
			scheme: 'exact',
			network: NETWORK_BASE_MAINNET,
			network_label: 'base-mainnet',
			amount: String(amountAtomics),
			price,
			payTo: env.X402_PAY_TO_BASE,
			asset: env.X402_ASSET_ADDRESS_BASE,
			asset_symbol: 'USDC',
			maxTimeoutSeconds: 60,
			resource: resourceUrl,
			extra: { name: 'USD Coin', version: '2', decimals: 6 },
		});
	}
	if (env.X402_PAY_TO_SOLANA) {
		out.push({
			scheme: 'exact',
			network: NETWORK_SOLANA_MAINNET,
			network_label: 'solana-mainnet',
			amount: String(amountAtomics),
			price,
			payTo: env.X402_PAY_TO_SOLANA,
			asset: env.X402_ASSET_MINT_SOLANA,
			asset_symbol: 'USDC',
			maxTimeoutSeconds: 60,
			resource: resourceUrl,
			extra: { name: 'USDC', decimals: 6, feePayer: env.X402_FEE_PAYER_SOLANA },
		});
	}
	return out;
}

// USE-13: one Bazaar catalog row per priced MCP tool. Facilitators key MCP
// rows on (resource, toolName) so each priced tool needs its own row; the
// shared `/api/mcp` resource alone would collapse them into one entry. We
// only emit rows for priced tools (otherwise the row would advertise a paid
// catalog entry for a free tool and confuse buyers about what's actually
// gated). Falls back to the canonical `mcp://tool/<name>` identifier when
// the spec wants a logical resource that distinguishes tools at the URL
// level, while the actual call still goes to `/api/mcp`.
function buildMcpToolItems({ mcpUrl, mcpAccepts, mcpService }) {
	const items = [];
	for (const tool of TOOL_CATALOG) {
		const pricing = priceFor(tool.name);
		if (!pricing) continue;
		const exampleArgs = exampleArgsForTool(tool);
		const discovery = declareMcpDiscovery({
			toolName: tool.name,
			description: tool.description,
			// MCP 2025-06-18 transport: Streamable HTTP is the default for
			// /api/mcp; SSE clients still work through the same path.
			transport: 'streamable-http',
			inputSchema: tool.inputSchema,
			example: exampleArgs,
		});
		items.push({
			type: 'mcp',
			path: '/api/mcp',
			url: mcpUrl,
			toolName: tool.name,
			method: 'POST',
			description: tool.description,
			mimeType: 'application/json',
			serviceName: mcpService.serviceName,
			tags: mcpService.tags,
			iconUrl: mcpService.iconUrl,
			pricing: {
				amount_usdc: pricing.amount_usdc,
				currency: 'USDC',
				description: pricing.description,
			},
			accepts: mcpAccepts,
			extensions: extensionsForAccepts(mcpAccepts, discovery),
		});
	}
	return items;
}

// Synthesize a minimal example arguments object that satisfies the tool's
// inputSchema.required fields. We use type-appropriate placeholders rather
// than the full schema so the example stays short — facilitators index it
// for search relevance, not exact matching.
function exampleArgsForTool(tool) {
	const props = tool.inputSchema?.properties || {};
	const required = tool.inputSchema?.required || [];
	const out = {};
	for (const key of required) {
		const def = props[key] || {};
		if (def.type === 'integer' || def.type === 'number') out[key] = def.default ?? 1;
		else if (def.type === 'boolean') out[key] = def.default ?? true;
		else if (def.type === 'array') out[key] = [];
		else out[key] = def.default ?? `example-${key}`;
	}
	return out;
}

function handleX402Discovery(req, res) {
	const origin = env.APP_ORIGIN;
	const mcpUrl = `${origin}/api/mcp`;
	const modelCheckUrl = `${origin}/api/x402/model-check`;
	const mintToMeshUrl = `${origin}/api/x402/mint-to-mesh`;
	const revenueVisionUrl = `${origin}/api/insights/revenue-vision`;
	const price = RAW_AMOUNT_TO_USDC(env.X402_MAX_AMOUNT_REQUIRED);

	// Build the MCP accept list (Base + Solana). `resource` is echoed on every
	// accept so reviewers + spend logs can reconcile the entry against the
	// resource it gates without walking back to the parent resource[] entry.
	function buildMcpAccepts(resourceUrl) {
		const out = [];
		if (env.X402_PAY_TO_BASE) {
			pushAcceptWithPermit2Sibling(out, {
				scheme: 'exact',
				network: NETWORK_BASE_MAINNET,
				network_label: 'base-mainnet',
				amount: env.X402_MAX_AMOUNT_REQUIRED,
				price,
				payTo: env.X402_PAY_TO_BASE,
				asset: env.X402_ASSET_ADDRESS_BASE,
				asset_symbol: 'USDC',
				maxTimeoutSeconds: 60,
				resource: resourceUrl,
				extra: { name: 'USDC', version: '2', decimals: 6 },
			});
		}
		if (env.X402_PAY_TO_SOLANA) {
			out.push({
				scheme: 'exact',
				network: NETWORK_SOLANA_MAINNET,
				network_label: 'solana-mainnet',
				amount: env.X402_MAX_AMOUNT_REQUIRED,
				price,
				payTo: env.X402_PAY_TO_SOLANA,
				asset: env.X402_ASSET_MINT_SOLANA,
				asset_symbol: 'USDC',
				maxTimeoutSeconds: 60,
				resource: resourceUrl,
				extra: { name: 'USDC', decimals: 6, feePayer: env.X402_FEE_PAYER_SOLANA },
			});
		}
		return out;
	}

	// model-check / mint-to-mesh / revenue-vision are CDP-Bazaar-cataloged.
	// CDP supports Base mainnet + Arbitrum One; advertise both here so
	// agentic.market shows the same network options buyers will see in the
	// live 402 challenge. Each EVM entry gets a Permit2 sibling so
	// EIP-2612-aware clients can pick the gasless Permit2-via-EIP-2612 path.
	const ARB_USDC = env.X402_ASSET_ADDRESS_ARBITRUM;
	function buildBazaarAccepts(resourceUrl) {
		const out = [];
		pushAcceptWithPermit2Sibling(out, {
			scheme: 'exact',
			network: NETWORK_BASE_MAINNET,
			network_label: 'base-mainnet',
			amount: env.X402_MAX_AMOUNT_REQUIRED,
			price,
			payTo: env.X402_PAY_TO_BASE,
			asset: env.X402_ASSET_ADDRESS_BASE,
			asset_symbol: 'USDC',
			maxTimeoutSeconds: 60,
			resource: resourceUrl,
			extra: { name: 'USDC', version: '2', decimals: 6 },
		});
		pushAcceptWithPermit2Sibling(out, {
			scheme: 'exact',
			network: 'eip155:42161',
			network_label: 'arbitrum-one',
			amount: env.X402_MAX_AMOUNT_REQUIRED,
			price,
			payTo: env.X402_PAY_TO_BASE,
			asset: ARB_USDC,
			asset_symbol: 'USDC',
			maxTimeoutSeconds: 60,
			resource: resourceUrl,
			extra: { name: 'USDC', version: '2', decimals: 6 },
		});
		if (env.X402_PAY_TO_SOLANA) {
			out.push({
				scheme: 'exact',
				network: NETWORK_SOLANA_MAINNET,
				network_label: 'solana-mainnet',
				amount: env.X402_MAX_AMOUNT_REQUIRED,
				price,
				payTo: env.X402_PAY_TO_SOLANA,
				asset: env.X402_ASSET_MINT_SOLANA,
				asset_symbol: 'USDC',
				maxTimeoutSeconds: 60,
				resource: resourceUrl,
				extra: { name: 'USDC', decimals: 6, feePayer: env.X402_FEE_PAYER_SOLANA },
			});
		}
		return out;
	}

	const mcpAccepts = buildMcpAccepts(mcpUrl);
	const modelCheckAccepts = buildBazaarAccepts(modelCheckUrl);
	const mintToMeshAccepts = buildBazaarAccepts(mintToMeshUrl);
	const revenueVisionAccepts = buildBazaarAccepts(revenueVisionUrl);

	// USE-13: per-route Bazaar service metadata. Echoed on each resource[]
	// entry so facilitators crawling /.well-known/x402-discovery surface a
	// human-readable serviceName + topical tags + icon in their search UI.
	// Tags are deliberately short (≤32 chars each) and ≤5 entries per the
	// spec; iconUrl falls back to THREEWS_SERVICE.iconUrl when unset.
	const routeMeta = {
		modelCheck: withService({
			serviceName: 'three.ws Model Check',
			tags: ['3d', 'gltf', 'glb', 'inspection', 'validation'],
		}),
		mintToMesh: withService({
			serviceName: 'three.ws Mint to Mesh',
			tags: ['3d', 'gltf', 'solana', 'token', 'render'],
		}),
		mintToMeshBatch: withService({
			serviceName: 'three.ws Mint Mesh Batch',
			tags: ['3d', 'gltf', 'solana', 'batch', 'render'],
		}),
		revenueVision: withService({
			serviceName: 'three.ws Revenue Vision',
			tags: ['ai', 'analysis', 'growth', 'insight', 'claude'],
		}),
		mcp: withService({
			serviceName: 'three.ws MCP',
			tags: ['mcp', '3d', 'gltf', 'solana', 'agent'],
		}),
		agentReputation: withService({
			serviceName: 'three.ws Agent Reputation',
			tags: ['reputation', 'agent', 'solana', 'attestation', 'trust'],
		}),
		onchainIdentity: withService({
			serviceName: 'three.ws Identity Verify',
			tags: ['identity', 'verification', 'agent', 'trust', 'onchain'],
		}),
		pumpAudit: withService({
			serviceName: 'three.ws Pump Audit',
			tags: ['pump.fun', 'audit', 'agent', 'risk', 'solana'],
		}),
		pumpLaunch: withService({
			serviceName: 'three.ws Pump Launcher',
			tags: ['pump.fun', 'launch', 'deploy', 'token', 'solana', 'mint'],
		}),
		skillMarket: withService({
			serviceName: 'three.ws Skill Market',
			tags: ['marketplace', 'agent', 'skills', 'pricing', 'discovery'],
		}),
		skillCall: withService({
			serviceName: 'three.ws Skill Call',
			tags: ['skill', 'agent', 'tool', 'pay-per-call'],
		}),
		symbolCheck: withService({
			serviceName: 'three.ws Symbol Check',
			tags: ['ticker', 'pump.fun', 'collision', 'launch', 'solana'],
		}),
		vanity: withService({
			serviceName: 'three.ws Vanity Grinder',
			tags: ['solana', 'vanity', 'keypair', 'wallet', 'address'],
		}),
		permit2Demo: withService({
			serviceName: 'three.ws Permit2 Demo',
			tags: ['x402', 'permit2', 'eip2612', 'gasless', 'demo'],
		}),
		danceTip: withService({
			serviceName: 'three.ws Pole Club',
			tags: ['3d', 'avatar', 'club', 'tip', 'dance'],
		}),
		assetDownload: withService({
			serviceName: 'three.ws Asset Bazaar',
			tags: ['3d', 'asset', 'glb', 'avatar', 'download'],
		}),
		factCheck: withService({
			serviceName: 'three.ws Fact Checker',
			tags: ['fact-check', 'search', 'verification', 'llm', 'attestation'],
		}),
		tutor: withService({
			serviceName: 'three.ws Pay-As-You-Learn Tutor',
			tags: ['tutor', 'education', 'llm', 'explain', 'pay-per-call'],
		}),
	};

	// USE-13: per-tool MCP catalog entries. Each priced tool is its own
	// catalog row keyed on (resource, toolName) so search can find them
	// individually instead of all hiding behind the parent /api/mcp resource.
	// Built from the live TOOL_CATALOG so adding a new priced tool only
	// requires a pricing entry; the discovery shape follows automatically.
	const mcpToolItems = buildMcpToolItems({ mcpUrl, mcpAccepts, mcpService: routeMeta.mcp });

	return json(
		res,
		200,
		{
			$schema: 'https://x402.org/schemas/discovery.json',
			service: {
				name: 'three.ws',
				legal_name: 'three.ws',
				tagline: 'AI-powered 3D model viewer and validation agent.',
				description:
					'three.ws is an agent-first 3D model platform. Drag-and-drop glTF/GLB preview, model validation/inspection/optimization, plus Solana agent data — reachable both as MCP tool calls and as paid REST endpoints (x402 v2). USDC on Base, Arbitrum, and Solana mainnet.',
				operator: 'three.ws',
				mission:
					'Make 3D model tooling and Solana agent data machine-native so any AI agent can transact with the HTTP 402 protocol.',
				website: origin,
				docs: `${origin}/docs/mcp`,
				repository: 'https://github.com/nirholas/three.ws',
				contact: `${origin}/`,
				tags: [
					'x402',
					'x402-v2',
					'mcp',
					'agent-first',
					'3d',
					'gltf',
					'glb',
					'three-js',
					'solana',
					'base',
					'arbitrum',
					'usdc',
				],
				environment: 'apex',
				origin,
			},
			// `.filter(Boolean)` drops any resource whose IIFE returned null —
			// e.g. permit2-paid-demo is omitted when CDP creds are missing,
			// matching the runtime 402 behavior so we don't catalog a route that
			// would fail at first paid call.
			resources: [
				{
					path: '/api/x402/model-check',
					url: modelCheckUrl,
					method: 'GET',
					description:
						'Fetches a glTF/GLB model from a URL and returns structural stats (vertex/triangle counts, materials, textures, animations, extensions) plus a prioritized list of optimization recommendations. Single GET, ?url=…. CDP-Bazaar-cataloged.',
					mimeType: 'application/json',
					serviceName: routeMeta.modelCheck.serviceName,
					tags: routeMeta.modelCheck.tags,
					iconUrl: routeMeta.modelCheck.iconUrl,
					accepts: modelCheckAccepts,
					extensions: extensionsForAccepts(modelCheckAccepts, {
						method: 'GET',
						discoverable: true,
						input: { url: 'https://three.ws/avatar/character-studio/sample.glb' },
						inputSchema: {
							type: 'object',
							required: ['url'],
							properties: {
								url: {
									type: 'string',
									format: 'uri',
									description: 'Public HTTPS URL of a glTF/GLB model.',
								},
							},
						},
					}),
				},
				{
					path: '/api/x402/mint-to-mesh',
					url: mintToMeshUrl,
					method: 'GET',
					description:
						'Mint to Mesh — pass a Solana fungible-token mint, get back a binary glTF (GLB) cube themed for that token. Color is derived from a stable hash of the mint; when the off-chain Metaplex JSON exposes a PNG/JPEG, that image is embedded as a baseColor texture on every face. Asset.extras carry mint, name, symbol, and timestamp. Useful for any agent that needs an instantly renderable 3D representation of a token. CDP-Bazaar-cataloged.',
					mimeType: 'application/json',
					serviceName: routeMeta.mintToMesh.serviceName,
					tags: routeMeta.mintToMesh.tags,
					iconUrl: routeMeta.mintToMesh.iconUrl,
					accepts: mintToMeshAccepts,
					extensions: extensionsForAccepts(mintToMeshAccepts, {
						method: 'GET',
						discoverable: true,
						input: { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
						inputSchema: {
							type: 'object',
							required: ['mint'],
							properties: {
								mint: {
									type: 'string',
									minLength: 32,
									maxLength: 64,
									description: 'Base58 SPL mint address on Solana mainnet.',
								},
							},
						},
					}),
				},
				{
					path: '/api/insights/revenue-vision',
					url: revenueVisionUrl,
					method: 'GET',
					description:
						'Revenue Vision — agentic growth analysis powered by Claude. Hand over a mission_brief and get back a single prioritized next-best move, a data-grounded insight, and an honestly-calibrated confidence rating. CDP-Bazaar-cataloged.',
					mimeType: 'application/json',
					serviceName: routeMeta.revenueVision.serviceName,
					tags: routeMeta.revenueVision.tags,
					iconUrl: routeMeta.revenueVision.iconUrl,
					accepts: revenueVisionAccepts,
					extensions: extensionsForAccepts(revenueVisionAccepts, {
						method: 'GET',
						discoverable: true,
						input: {
							agent_codename: 'ledger-bot',
							power_request: 'revenue-vision',
							mission_brief: 'Find the highest-converting buyer segment this week.',
						},
						inputSchema: {
							type: 'object',
							required: ['agent_codename', 'power_request', 'mission_brief'],
							properties: {
								agent_codename: { type: 'string' },
								power_request: { type: 'string', enum: ['revenue-vision'] },
								mission_brief: {
									type: 'string',
									minLength: 4,
									maxLength: 4000,
								},
							},
						},
					}),
				},
				{
					path: '/api/mcp',
					url: mcpUrl,
					method: 'POST',
					description:
						'MCP 2025-06-18 Streamable HTTP transport — 3D avatar viewer, glTF model validation/inspection/optimization, and Solana agent data exposed as MCP tools. JSON-RPC 2.0 batch-aware. Currency: USDC.',
					mimeType: 'application/json',
					serviceName: routeMeta.mcp.serviceName,
					tags: routeMeta.mcp.tags,
					iconUrl: routeMeta.mcp.iconUrl,
					accepts: mcpAccepts,
					extensions: extensionsForAccepts(mcpAccepts, bazaarExtension()),
					links: {
						openapi: `${origin}/openapi.json`,
						docs: `${origin}/docs/mcp`,
						agent_card: `${origin}/.well-known/agent-card.json`,
						payment_config: `${origin}/.well-known/x402`,
					},
				},
				(() => {
					const url = `${origin}/api/x402/agent-reputation`;
					const accepts = acceptsForPrice('10000', url);
					return {
						path: '/api/x402/agent-reputation',
						url,
						method: 'GET',
						description:
							"Agent Reputation — return a reputation snapshot for a three.ws agent (USDC paid in to its pump-agent tokens, distinct payers, deployed mints, distribution success rate, Solana attestation counts). Built from three.ws's proprietary index of pump_agent_payments, pump_distribute_runs, and solana_attestations.",
						mimeType: 'application/json',
						serviceName: routeMeta.agentReputation.serviceName,
						tags: routeMeta.agentReputation.tags,
						iconUrl: routeMeta.agentReputation.iconUrl,
						accepts,
						extensions: extensionsForAccepts(accepts, {
							method: 'GET',
							discoverable: true,
							input: { agent_id: '7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55' },
							inputSchema: {
								type: 'object',
								required: ['agent_id'],
								properties: { agent_id: { type: 'string', format: 'uuid' } },
							},
						}),
					};
				})(),
				(() => {
					const url = `${origin}/api/x402/onchain-identity-verify`;
					const accepts = acceptsForPrice('5000', url);
					return {
						path: '/api/x402/onchain-identity-verify',
						url,
						method: 'GET',
						description:
							'On-Chain Identity Verifier — given a three.ws agent_id + CAIP-2 chain + contract/mint, verify ownership from the canonical meta.onchain index and return tx_hash/wallet/deploy time evidence when verified. Trust primitive before paying counterparty agents.',
						mimeType: 'application/json',
						serviceName: routeMeta.onchainIdentity.serviceName,
						tags: routeMeta.onchainIdentity.tags,
						iconUrl: routeMeta.onchainIdentity.iconUrl,
						accepts,
						extensions: extensionsForAccepts(accepts, {
							method: 'GET',
							discoverable: true,
							input: {
								agent_id: '7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55',
								chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
								contract_or_mint: 'C3vQABCDEFGHJKLMNopqrstuvwxyZ12345abcdefghi',
							},
							inputSchema: {
								type: 'object',
								required: ['agent_id', 'chain', 'contract_or_mint'],
								properties: {
									agent_id: { type: 'string', format: 'uuid' },
									chain: { type: 'string', description: 'CAIP-2 chain ID' },
									contract_or_mint: { type: 'string' },
								},
							},
						}),
					};
				})(),
				(() => {
					const url = `${origin}/api/x402/pump-agent-audit`;
					const accepts = acceptsForPrice('20000', url);
					return {
						path: '/api/x402/pump-agent-audit',
						url,
						method: 'GET',
						description:
							"Pump-Agent Audit — full operational audit of a pump.fun agent-payments token: total USDC in, unique payers, distribute/buyback success history, latest error reasons, and risk flags (never_distributed, high_distribute_failure_rate, no_buybacks_run). Backed by three.ws's indexed pump_distribute_runs and pump_buyback_runs tables.",
						mimeType: 'application/json',
						serviceName: routeMeta.pumpAudit.serviceName,
						tags: routeMeta.pumpAudit.tags,
						iconUrl: routeMeta.pumpAudit.iconUrl,
						accepts,
						extensions: extensionsForAccepts(accepts, {
							method: 'GET',
							discoverable: true,
							input: { mint: 'C3vQABCDEFGHJKLMNopqrstuvwxyZ12345abcdefghi' },
							inputSchema: {
								type: 'object',
								required: ['mint'],
								properties: {
									mint: { type: 'string', minLength: 32, maxLength: 44 },
								},
							},
						}),
					};
				})(),
				(() => {
					const url = `${origin}/api/x402/pump-launch`;
					const accepts = acceptsForPrice('5000000', url);
					return {
						path: '/api/x402/pump-launch',
						url,
						method: 'POST',
						description:
							'Pump Launcher — deploy a brand-new pump.fun token in one paid call. Supply name + symbol and either a pre-pinned metadataUri or an imageUrl (we pin the image + descriptor to pump.fun IPFS). The server fronts the SOL deploy cost and signs the create-coin tx, so the buyer needs no SOL and no account. Creator rewards accrue to any Solana wallet you nominate; optional vanity prefix/suffix grinds a custom mint address. Returns mint + tx signature + pump.fun URL.',
						mimeType: 'application/json',
						serviceName: routeMeta.pumpLaunch.serviceName,
						tags: routeMeta.pumpLaunch.tags,
						iconUrl: routeMeta.pumpLaunch.iconUrl,
						accepts,
						extensions: extensionsForAccepts(accepts, {
							method: 'POST',
							discoverable: true,
							input: {
								name: 'Helios',
								symbol: 'HELIO',
								imageUrl: 'https://example.com/helios.png',
								creator: 'wwwPqsM4N7T9J69tB82nLyzxqsH159j4orftLTQfUGV',
							},
							inputSchema: {
								type: 'object',
								required: ['name', 'symbol'],
								properties: {
									name: { type: 'string', maxLength: 32 },
									symbol: { type: 'string', maxLength: 10 },
									metadataUri: { type: 'string', maxLength: 2048 },
									imageUrl: { type: 'string', maxLength: 2048 },
									description: { type: 'string', maxLength: 2000 },
									creator: { type: 'string', minLength: 32, maxLength: 44 },
									vanityPrefix: { type: 'string', maxLength: 5 },
									vanitySuffix: { type: 'string', maxLength: 5 },
								},
							},
						}),
					};
				})(),
				(() => {
					const url = `${origin}/api/x402/skill-marketplace`;
					const accepts = acceptsForPrice('1000', url);
					return {
						path: '/api/x402/skill-marketplace',
						url,
						method: 'GET',
						description:
							'Skill Marketplace — list active skill listings with prices across all three.ws agents. Filter by skill name to find the cheapest provider for a given capability. Returns price atomics, chain, currency, trial offer, and time-pass terms.',
						mimeType: 'application/json',
						serviceName: routeMeta.skillMarket.serviceName,
						tags: routeMeta.skillMarket.tags,
						iconUrl: routeMeta.skillMarket.iconUrl,
						accepts,
						extensions: extensionsForAccepts(accepts, {
							method: 'GET',
							discoverable: true,
							input: { skill: 'inspect_model', limit: 20 },
							inputSchema: {
								type: 'object',
								properties: {
									skill: { type: 'string' },
									limit: { type: 'integer', minimum: 1, maximum: 200 },
								},
							},
						}),
					};
				})(),
				(() => {
					const url = `${origin}/api/x402/symbol-availability`;
					const accepts = acceptsForPrice('1000', url);
					return {
						path: '/api/x402/symbol-availability',
						url,
						method: 'GET',
						description:
							"Symbol Availability — pre-launch ticker collision check against three.ws's pump.fun mint index. Returns exact-symbol collisions plus trigram-similar tickers so launch agents can avoid name confusion and aggregator-search dilution.",
						mimeType: 'application/json',
						serviceName: routeMeta.symbolCheck.serviceName,
						tags: routeMeta.symbolCheck.tags,
						iconUrl: routeMeta.symbolCheck.iconUrl,
						accepts,
						extensions: extensionsForAccepts(accepts, {
							method: 'GET',
							discoverable: true,
							input: { ticker: 'HELIO', network: 'mainnet' },
							inputSchema: {
								type: 'object',
								required: ['ticker'],
								properties: {
									ticker: { type: 'string', minLength: 1, maxLength: 32 },
									network: { type: 'string', enum: ['mainnet', 'devnet'] },
								},
							},
						}),
					};
				})(),
				(() => {
					// Vanity grind is difficulty-tiered ($0.01–$0.25); the catalog
					// advertises the 1-char entry tier ('10000' = $0.01) while the live
					// 402 quotes the exact price for the requested pattern length.
					const url = `${origin}/api/x402/vanity`;
					const accepts = acceptsForPrice('10000', url);
					return {
						path: '/api/x402/vanity',
						url,
						method: 'GET',
						description:
							'Vanity Grinder — generate a brand-new Solana keypair whose Base58 address starts with a chosen prefix and/or ends with a chosen suffix. Returns the public address and its secret key (Base58 + 64-byte array) so it imports into any Solana wallet. Ground fresh per request in a Rust/WASM ed25519 engine and never stored. Difficulty-tiered price ($0.01 for 1 char, $0.05 for 2, $0.25 for 3); combined pattern capped at 3 Base58 characters. Settlement runs only after a successful grind, so an exhausted budget costs nothing.',
						mimeType: 'application/json',
						serviceName: routeMeta.vanity.serviceName,
						tags: routeMeta.vanity.tags,
						iconUrl: routeMeta.vanity.iconUrl,
						accepts,
						extensions: extensionsForAccepts(accepts, {
							method: 'GET',
							discoverable: true,
							input: { prefix: 'So', suffix: '', ignoreCase: '0' },
							inputSchema: {
								type: 'object',
								anyOf: [{ required: ['prefix'] }, { required: ['suffix'] }],
								properties: {
									prefix: {
										type: 'string',
										maxLength: 3,
										description:
											'Base58 characters the address must start with (excludes 0, O, I, l). Combined with suffix, max 3.',
									},
									suffix: {
										type: 'string',
										maxLength: 3,
										description:
											'Base58 characters the address must end with. Combined with prefix, max 3.',
									},
									ignoreCase: {
										type: 'string',
										enum: ['0', '1', 'true', 'false'],
										description:
											'When 1/true, match case-insensitively (faster, less specific).',
									},
								},
							},
						}),
					};
				})(),
				(() => {
					// Permit2-only demo: skip the EIP-3009 entry that acceptsForPrice
					// would push first, so SDK clients are forced through the gasless
					// EIP-2612 → settleWithPermit path the endpoint is meant to prove.
					// permit2VariantOf returns null without CDP creds, in which case we
					// omit the resource from discovery (matches the runtime 402 behavior).
					const url = `${origin}/api/x402/permit2-paid-demo`;
					const price = RAW_AMOUNT_TO_USDC('1000');
					const baseAccept = env.X402_PAY_TO_BASE
						? {
								scheme: 'exact',
								network: NETWORK_BASE_MAINNET,
								network_label: 'base-mainnet',
								amount: '1000',
								price,
								payTo: env.X402_PAY_TO_BASE,
								asset: env.X402_ASSET_ADDRESS_BASE,
								asset_symbol: 'USDC',
								maxTimeoutSeconds: 60,
								resource: url,
								extra: { name: 'USD Coin', version: '2', decimals: 6 },
							}
						: null;
					const permit2 = baseAccept ? permit2VariantOf(baseAccept) : null;
					if (!permit2) return null;
					const accepts = [permit2];
					return {
						path: '/api/x402/permit2-paid-demo',
						url,
						method: 'GET',
						description:
							"Permit2 + EIP-2612 Gas Sponsoring Demo — forces the gasless Permit2 path so a fresh wallet holding USDC but ZERO ETH can complete the flow. CDP's x402ExactPermit2Proxy submits the EIP-2612 permit + Permit2 transfer atomically via settleWithPermit. Response surfaces the on-chain tx hash and a Basescan link.",
						mimeType: 'application/json',
						serviceName: routeMeta.permit2Demo.serviceName,
						tags: routeMeta.permit2Demo.tags,
						iconUrl: routeMeta.permit2Demo.iconUrl,
						accepts,
						extensions: extensionsForAccepts(accepts, {
							method: 'GET',
							discoverable: true,
							input: {},
							inputSchema: {
								type: 'object',
								properties: {},
								additionalProperties: false,
							},
						}),
					};
				})(),
				(() => {
					const url = `${origin}/api/x402/mint-to-mesh-batch`;
					const accepts = acceptsForPrice('50000', url);
					return {
						path: '/api/x402/mint-to-mesh-batch',
						url,
						method: 'POST',
						description:
							'Mint-to-Mesh (Batch) — resolve 1–10 Solana SPL mints to themed binary glTF cubes in a single paid call. Per-mint failures report ok:false individually instead of failing the whole batch. Output is base64 GLB bytes for Three.js / Babylon.js / model-viewer.',
						mimeType: 'application/json',
						serviceName: routeMeta.mintToMeshBatch.serviceName,
						tags: routeMeta.mintToMeshBatch.tags,
						iconUrl: routeMeta.mintToMeshBatch.iconUrl,
						accepts,
						extensions: extensionsForAccepts(accepts, {
							method: 'POST',
							discoverable: true,
							input: {
								mints: [
									'C3vQABCDEFGHJKLMNopqrstuvwxyZ12345abcdefghi',
									'F7kXZYXWVUTSRQPONMLKJIHGFEDCba9876543210xyz',
								],
							},
							inputSchema: {
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
						}),
					};
				})(),
				(() => {
					const url = `${origin}/api/x402/dance-tip`;
					const accepts = acceptsForPrice('1000', url);
					return {
						path: '/api/x402/dance-tip',
						url,
						method: 'GET',
						description:
							'three.ws Pole Club — tip a dancer to perform one routine on the 3D pole stage. Pay $0.001 USDC per performance. Pick a dancer slot (1-4) and a dance style. The settled call returns a performance ticket the /club page consumes to spawn the dancer and play the routine for ~12 seconds.',
						mimeType: 'application/json',
						serviceName: routeMeta.danceTip.serviceName,
						tags: routeMeta.danceTip.tags,
						iconUrl: routeMeta.danceTip.iconUrl,
						accepts,
						extensions: extensionsForAccepts(accepts, {
							method: 'GET',
							discoverable: true,
							input: { dancer: '1', dance: 'rumba' },
							inputSchema: {
								type: 'object',
								required: ['dancer', 'dance'],
								properties: {
									dancer: {
										type: 'string',
										enum: ['1', '2', '3', '4'],
										description:
											'Stage slot 1-4 — which dancer should take the pole.',
									},
									dance: {
										type: 'string',
										enum: ['rumba', 'silly', 'thriller', 'capoeira', 'hiphop'],
										description:
											'Performance style — a clip in /animations/manifest.json.',
									},
								},
							},
						}),
					};
				})(),
				(() => {
					// Asset Bazaar advertises a representative price ($0.10 USDC =
					// 100_000 atomics); the live 402 challenge always reflects the
					// per-asset row from the paid_assets table. The discovery entry
					// is a placeholder so the Bazaar indexer can find the route;
					// per-asset listings would explode the catalog and aren't worth
					// the noise here. The `?slug=<slug>` query param is documented
					// in the input schema so crawlers know how to drive it.
					const url = `${origin}/api/x402/asset-download`;
					const accepts = acceptsForPrice('100000', url);
					return {
						path: '/api/x402/asset-download',
						url,
						method: 'GET',
						description:
							'three.ws Asset Bazaar — pay once in USDC to unlock a 3D asset (GLB, avatar, or accessory) hosted on R2. Wallets that have already paid can re-download for free by signing in with SIWX (CAIP-122). Each asset has its own price and creator payout address; the response carries a short-lived presigned R2 URL the client uses to fetch the file directly.',
						mimeType: 'application/json',
						serviceName: routeMeta.assetDownload.serviceName,
						tags: routeMeta.assetDownload.tags,
						iconUrl: routeMeta.assetDownload.iconUrl,
						accepts,
						extensions: extensionsForAccepts(accepts, {
							method: 'GET',
							discoverable: true,
							input: { slug: 'pole-dancer-rumba' },
							inputSchema: {
								type: 'object',
								required: ['slug'],
								properties: {
									slug: {
										type: 'string',
										minLength: 1,
										maxLength: 128,
										description:
											'Unique asset slug from the paid_assets catalog.',
									},
								},
							},
						}),
					};
				})(),
				(() => {
					const url = `${origin}/api/x402/skill-call`;
					// Per-call price is set per skill from marketplace_skills; advertise
					// a representative $0.01 so facilitators can index the route.
					const accepts = acceptsForPrice('10000', url);
					return {
						path: '/api/x402/skill-call',
						url,
						method: 'GET',
						description:
							"three.ws Skill Call — pay the per-call price of a marketplace skill in USDC (Base or Solana) and receive its executable payload: the tool schema and content the calling agent runs. Payment settles straight to the skill author's wallet. Per-call pricing — every invocation is a fresh payment.",
						mimeType: 'application/json',
						serviceName: routeMeta.skillCall.serviceName,
						tags: routeMeta.skillCall.tags,
						iconUrl: routeMeta.skillCall.iconUrl,
						accepts,
						extensions: extensionsForAccepts(accepts, {
							method: 'GET',
							discoverable: true,
							input: { skill: 'wallet-balance' },
							inputSchema: {
								type: 'object',
								required: ['skill'],
								properties: {
									skill: {
										type: 'string',
										minLength: 1,
										maxLength: 128,
										description:
											'Unique skill slug from the marketplace_skills catalog.',
									},
								},
							},
						}),
					};
				})(),
				(() => {
					const url = `${origin}/api/x402/fact-check`;
					const accepts = acceptsForPrice('100000', url);
					return {
						path: '/api/x402/fact-check',
						url,
						method: 'POST',
						description:
							'three.ws Fact Checker — pay $0.10 USDC to verify a factual claim. Generates search queries, runs multi-source web search, extracts per-source stance with an LLM, computes a weighted verdict + confidence, and returns supporting sources plus a SHA-256 attestation of the result.',
						mimeType: 'application/json',
						serviceName: routeMeta.factCheck.serviceName,
						tags: routeMeta.factCheck.tags,
						iconUrl: routeMeta.factCheck.iconUrl,
						accepts,
						extensions: extensionsForAccepts(accepts, {
							method: 'POST',
							discoverable: true,
							input: { claim: 'The Eiffel Tower is in Paris.', strictness: 'medium' },
							inputSchema: {
								type: 'object',
								required: ['claim'],
								properties: {
									claim: {
										type: 'string',
										minLength: 5,
										maxLength: 1000,
										description: 'The factual claim to verify.',
									},
									strictness: {
										type: 'string',
										enum: ['high', 'medium', 'low'],
										description:
											'high: penalizes low-authority sources. medium: default. low: accepts all sources equally.',
									},
								},
							},
						}),
					};
				})(),
				(() => {
					const url = `${origin}/api/x402/tutor`;
					const accepts = acceptsForPrice('10000', url);
					return {
						path: '/api/x402/tutor',
						url,
						method: 'POST',
						description:
							'three.ws Pay-As-You-Learn Tutor — pay $0.01 USDC per answered question. Returns a leveled explanation, key points, a worked example, and a follow-up, plus a running session tab for a live itemized invoice. Pass a sessionId to accumulate a tab across questions.',
						mimeType: 'application/json',
						serviceName: routeMeta.tutor.serviceName,
						tags: routeMeta.tutor.tags,
						iconUrl: routeMeta.tutor.iconUrl,
						accepts,
						extensions: extensionsForAccepts(accepts, {
							method: 'POST',
							discoverable: true,
							input: { question: 'Why is the sky blue?', level: 'intermediate' },
							inputSchema: {
								type: 'object',
								required: ['question'],
								properties: {
									sessionId: {
										type: 'string',
										maxLength: 100,
										description:
											'Stable session identifier to accumulate a running tab. Omit to start a new session.',
									},
									question: {
										type: 'string',
										minLength: 5,
										maxLength: 2000,
										description: 'The question to be explained.',
									},
									context: {
										type: 'string',
										maxLength: 6000,
										description:
											'Optional code or context to ground the explanation.',
									},
									level: {
										type: 'string',
										enum: ['beginner', 'intermediate', 'expert'],
										description:
											'Target expertise level — controls depth and assumed background.',
									},
								},
							},
						}),
					};
				})(),
				// USE-13: one Bazaar catalog row per priced MCP tool. The shared
				// `/api/mcp` resource above is the transport entry; these are
				// the individual paid tools facilitators index by toolName.
				...mcpToolItems,
			].filter(Boolean),
		},
		{ 'cache-control': 'public, max-age=300' },
	);
}

// ── dispatcher ────────────────────────────────────────────────────────────────

function handleChatPlugin(req, res) {
	return json(
		res,
		200,
		{
			identifier: '3dagent',
			schemaVersion: 1,
			meta: {
				title: 'three.ws',
				description: 'Render a 3D avatar that reacts to the chat.',
				avatar: 'https://three.ws/favicon.ico',
				tags: ['avatar', '3d', 'agent'],
			},
			ui: { position: 'right', size: { width: 320, height: 420 } },
			settings: [
				{ name: 'agentId', type: 'string', required: true, title: 'Agent ID' },
				{
					name: 'apiOrigin',
					type: 'string',
					default: 'https://three.ws/',
					title: 'API Origin',
				},
			],
		},
		{ 'cache-control': 'public, max-age=3600' },
	);
}

const DISPATCH = {
	'agent-attestation-schemas': handleAttestationSchemas,
	'chat-plugin': handleChatPlugin,
	'oauth-authorization-server': handleOauthAuthServer,
	'oauth-protected-resource': handleOauthProtectedResource,
	x402: handleX402,
	'x402-discovery': handleX402Discovery,
};

// Public discovery docs (x402, x402-discovery, chat-plugin, agent-attestation-schemas)
// must be readable cross-origin so browser-based validators (agentic.market,
// x402scan, bazaar) can fetch them. OAuth metadata stays restricted.
const PUBLIC_DISCOVERY = new Set([
	'x402',
	'x402-discovery',
	'chat-plugin',
	'agent-attestation-schemas',
]);

export default wrap(async (req, res) => {
	const name = req.query?.name ?? new URL(req.url, 'http://x').searchParams.get('name');
	const corsOpts = PUBLIC_DISCOVERY.has(name)
		? { methods: 'GET,OPTIONS', origins: '*' }
		: { methods: 'GET,OPTIONS' };
	if (cors(req, res, corsOpts)) return;
	if (!method(req, res, ['GET'])) return;
	const fn = DISPATCH[name];
	if (!fn) return error(res, 404, 'not_found', `unknown well-known resource: ${name}`);
	return fn(req, res);
});
