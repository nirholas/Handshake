// Consolidated /.well-known/* handler.
// Dispatches on ?name= query param set by vercel.json rewrites.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cors, json, method, wrap, error } from './_lib/http.js';
import { env } from './_lib/env.js';
import {
	paymentRequirements,
	bazaarExtension,
	build402Body,
	declareEip2612GasSponsoringExtension,
	declareErc20ApprovalGasSponsoringExtension,
	permit2VariantOf,
	baseSettleable,
	solanaSettleable,
	NETWORK_BASE_MAINNET,
	NETWORK_SOLANA_MAINNET,
} from './_lib/x402-spec.js';
import {
	declareHttpDiscovery,
	declareMcpDiscovery,
	withService,
} from './_lib/x402/bazaar-helpers.js';
import { TOOL_CATALOG } from './_mcp/catalog.js';
import { STUDIO_CHALLENGE } from './_mcp3d/discovery.js';
import { TOOL_CATALOG as STUDIO_TOOL_CATALOG } from './_mcp3d/catalog.js';
import { priceFor as studioPriceFor } from './_mcp3d/pricing.js';
import { priceFor } from './_lib/pump-pricing.js';
import { priceFor as datapointPriceFor } from './_lib/x402-prices.js';
import {
	DATAPOINT_FAMILIES,
	DATAPOINT_DEFAULT_ATOMICS,
	datapointDescription,
} from './_lib/market-data/datapoints.js';
import { fetchMarketsTable } from './_lib/market-fallbacks.js';
import { buildProtocols } from './defi/protocols.js';
import { FORGE_OUTPUT_EXAMPLE } from './_lib/forge-listing.js';
import { listBazaarServices, serviceResourceUrl } from './_lib/agent-paid-services.js';
import { toBazaarDiscovery } from './_lib/service-catalog/index.js';

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
		description:
			'Validator attestation. Two forms: a task validation (task_hash) or a ' +
			'glTF/GLB schema validation of the agent model (subkind "glb-schema", ' +
			'carrying proof_hash + proof_uri) — the Solana analog of the EVM ' +
			'ValidationRegistry recordValidation.',
		required: ['v', 'kind', 'agent', 'passed'],
		properties: {
			...COMMON,
			passed: { type: 'boolean' },
			subkind: { type: 'string', enum: ['glb-schema'], description: 'Present for model (glTF/GLB schema) validations.' },
			task_hash: { type: 'string', description: 'Task validation form: sha256 of the validated task.' },
			proof_hash: { type: 'string', description: 'Model form: sha256 of the canonical validation report JSON.' },
			proof_uri: { type: 'string', description: 'Model form: URL to the full pinned validation report.' },
			model_sha256: { type: 'string', description: 'Model form: sha256 of the GLB bytes.' },
			source: { type: 'string' },
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
				validation_endpoint: '/api/agents/solana-validation?asset=<pubkey>',
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
				// Agent memory MCP tools (remember / recall / forget).
				'memory:read',
				'memory:write',
				// On-chain agent identity MCP tools (register_agent / identity_check).
				'agents:read',
				'agents:write',
				// USE-21 auth-hints: paid endpoints advertise these scopes for
				// Bearer-token bypass via the auth-hints extension.
				'read:agent-reputation',
				'x402:bypass',
				// Agent wallet MCP (api/mcp-agent): read status, provision a wallet,
				// and publish a paid endpoint to earn USDC.
				'wallet:read',
				'wallet:write',
				'services:write',
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
			scopes_supported: [
				'avatars:read',
				'avatars:write',
				'avatars:delete',
				'profile',
				'memory:read',
				'memory:write',
				'agents:read',
				'agents:write',
			],
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
// Normalize the second arg into a spec-shaped v2 bazaar extension
// ({discoverable, info, schema}). Catalog entries historically passed a raw
// {method, discoverable, input, inputSchema} descriptor straight through,
// which facilitator validators reject as a malformed discovery extension —
// every REST row was silently uncatalogable while the MCP rows (already
// spec-shaped) validated fine. Already-proper extensions (bazaarExtension(),
// declareMcpDiscovery(), STUDIO_CHALLENGE.bazaar) pass through untouched.
function extensionsForAccepts(accepts, bazaar) {
	const normalized =
		bazaar && bazaar.info && bazaar.schema
			? bazaar
			: declareHttpDiscovery({
					method: bazaar?.method || 'GET',
					input: bazaar?.input,
					inputSchema: bazaar?.inputSchema,
					// Catalog descriptors that carry their own output example declare it
					// here; older entries get theirs backfilled by addOutputExample.
					output: bazaar?.output,
				});
	const exts = { bazaar: normalized };
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
	// Solana-first platform default — the Solana accept leads so first-accept
	// clients and marketplaces treat it as the primary rail; Base follows.
	// Solana only when settlement is fulfillable — solanaSettleable() confirms the
	// self-facilitator can co-sign (its X402_FEE_PAYER_SECRET_BASE58 is loaded), so
	// the catalog never lists a Solana rail the live 402 now drops. See
	// solanaSettleable() / baseSettleable() in x402-spec.js.
	if (env.X402_PAY_TO_SOLANA && solanaSettleable()) {
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
	// Base only when a WORKING facilitator will settle it (CDP creds or the
	// X402_ADVERTISE_BASE opt-in). A bare facilitator URL is not enough — the prod
	// host was decommissioned and 404s /verify, so an unsettleable Base accept would
	// drift from the live 402 (which now drops Base) and hand buyers a catalog rail
	// that 502s at verify. See baseSettleable().
	if (env.X402_PAY_TO_BASE && baseSettleable()) {
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
	return out;
}

// USE-13: one Bazaar catalog row per priced MCP tool. Facilitators key MCP
// rows on (resource, toolName) so each priced tool needs its own row; the
// shared `/api/mcp` resource alone would collapse them into one entry. We
// only emit rows for priced tools (otherwise the row would advertise a paid
// catalog entry for a free tool and confuse buyers about what's actually
// gated). Falls back to the canonical `mcp://tool/<name>` identifier when
// the spec wants a logical resource that distinguishes tools at the URL
// level, while the actual call still goes to the server's own path.
// Generic over the server: pass the endpoint path/url, its accepts, its
// service metadata, its tool catalog, and its per-tool pricing lookup —
// /api/mcp and /api/mcp-3d both feed through here.
function buildMcpToolItems({ path, mcpUrl, mcpAccepts, mcpService, catalog, priceForTool }) {
	const items = [];
	for (const tool of catalog) {
		const pricing = priceForTool(tool.name);
		if (!pricing) continue;
		const exampleArgs = exampleArgsForTool(tool);
		const discovery = declareMcpDiscovery({
			toolName: tool.name,
			description: tool.description,
			// MCP 2025-06-18 transport: Streamable HTTP is the default for
			// these servers; SSE clients still work through the same path.
			transport: 'streamable-http',
			inputSchema: tool.inputSchema,
			example: exampleArgs,
		});
		items.push({
			type: 'mcp',
			path,
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

// Agent-published paid services (the `monetize_endpoint` tool). Each active,
// bazaar-listed row in agent_paid_services becomes a discovery catalog entry so
// facilitators — and therefore find_services / the bazaar — index the agent's
// endpoint the moment it's published. The advertised payTo is the agent's OWN
// payout wallet, mirroring the live 402 that api/x402/service.js serves.
//
// Never throws: a DB hiccup (or no DB, as in unit tests) yields an empty list so
// the static catalog still renders. Capped by listBazaarServices().
async function buildAgentServiceItems(origin) {
	let rows;
	try {
		rows = await listBazaarServices({ limit: 200 });
	} catch (err) {
		console.error('[wk/x402-discovery] agent services unavailable', err?.message || err);
		return [];
	}

	const items = [];
	for (const row of rows) {
		const url = serviceResourceUrl(row.slug);
		const price = RAW_AMOUNT_TO_USDC(row.price_atomics);
		const accepts = [];
		if (row.network === 'base' && row.payout_address && env.X402_ASSET_ADDRESS_BASE && baseSettleable()) {
			pushAcceptWithPermit2Sibling(accepts, {
				scheme: 'exact',
				network: NETWORK_BASE_MAINNET,
				network_label: 'base-mainnet',
				amount: String(row.price_atomics),
				price,
				payTo: row.payout_address,
				asset: env.X402_ASSET_ADDRESS_BASE,
				asset_symbol: 'USDC',
				maxTimeoutSeconds: 60,
				resource: url,
				extra: { name: 'USD Coin', version: '2', decimals: 6 },
			});
		} else if (
			row.network === 'solana' &&
			row.payout_address &&
			env.X402_ASSET_MINT_SOLANA &&
			env.X402_FEE_PAYER_SOLANA &&
			solanaSettleable()
		) {
			accepts.push({
				scheme: 'exact',
				network: NETWORK_SOLANA_MAINNET,
				network_label: 'solana-mainnet',
				amount: String(row.price_atomics),
				price,
				payTo: row.payout_address,
				asset: env.X402_ASSET_MINT_SOLANA,
				asset_symbol: 'USDC',
				maxTimeoutSeconds: 60,
				resource: url,
				extra: { name: 'USDC', decimals: 6, feePayer: env.X402_FEE_PAYER_SOLANA },
			});
		}
		// No advertisable accept (missing payout / env for this network) → skip,
		// matching the live 402 which would also refuse to advertise it.
		if (!accepts.length) continue;

		const inputSchema = row.input_schema || { type: 'object', additionalProperties: true };
		items.push({
			path: `/api/x402/service/${row.slug}`,
			url,
			method: row.target_method,
			description: row.description,
			mimeType: 'application/json',
			serviceName: row.name,
			tags: ['agent', 'monetized', row.network],
			accepts,
			extensions: extensionsForAccepts(accepts, {
				method: row.target_method,
				discoverable: true,
				input: {},
				inputSchema,
			}),
		});
	}
	return items;
}

// Datapoint fabric (/api/x402/d/<family>/<id>/<metric>) — 400k+ addressable
// single-datapoint endpoints served by one dynamic route. The discovery doc
// can't (and shouldn't) list them all; it lists a curated slice indexers can
// surface: every no-id metric (global / gas / fear-greed) plus a
// runtime-derived set of concrete high-traffic ids (top coins by market cap ×
// headline metrics, top protocols by TVL × tvl). Ids come from the live
// cached feeds at render time — nothing here hardcodes a third-party asset —
// and any upstream hiccup degrades to the static slice (the fabric itself
// keeps serving every id regardless; /api/x402/d enumerates the full space).
async function buildDatapointItems(origin) {
	const items = [];
	const svc = withService({
		serviceName: 'three.ws Datapoints',
		tags: ['crypto', 'market-data', 'datapoint', 'x402'],
	});

	const push = (family, id, metric, exampleValue) => {
		const familyDef = DATAPOINT_FAMILIES[family];
		const metricDef = familyDef.metrics[metric];
		const priceAtomics = datapointPriceFor(`datapoint-${family}`, DATAPOINT_DEFAULT_ATOMICS);
		const path =
			id != null
				? `/api/x402/d/${family}/${encodeURIComponent(id)}/${metric}`
				: `/api/x402/d/${family}/${metric}`;
		const url = `${origin}${path}`;
		const accepts = acceptsForPrice(priceAtomics, url);
		items.push({
			path,
			url,
			method: 'GET',
			description: datapointDescription({ family, metric, priceAtomics }),
			mimeType: 'application/json',
			serviceName: svc.serviceName,
			tags: [...svc.tags.slice(0, 4), family].slice(0, 5),
			iconUrl: svc.iconUrl,
			accepts,
			extensions: extensionsForAccepts(accepts, {
				method: 'GET',
				discoverable: true,
				input: {},
				inputSchema: { type: 'object', properties: {} },
				output: {
					example: {
						family,
						...(id != null ? { id } : {}),
						metric,
						label: metricDef.label,
						unit: metricDef.unit,
						value: exampleValue,
						as_of: '2026-07-11T00:00:00.000Z',
						source: 'three.ws market-data',
					},
				},
			}),
		});
	};

	// Every metric of the no-id families — static, always present.
	for (const family of ['global', 'fear-greed', 'gas']) {
		for (const metric of Object.keys(DATAPOINT_FAMILIES[family].metrics)) {
			push(family, null, metric, metric === 'label' ? 'Greed' : 42.5);
		}
	}

	// Top coins × headline metrics — ids resolved from the live cached table.
	try {
		const { rows } = await fetchMarketsTable({ page: 1, perPage: 20, category: '' });
		for (const row of rows) {
			for (const metric of ['price', 'market-cap', 'change-24h']) {
				push('coin', row.id, metric, metric === 'price' ? row.price : 42.5);
			}
		}
	} catch (err) {
		console.error('[wk/x402-discovery] datapoint coin slice unavailable', err?.message || err);
	}

	// Top protocols by TVL × tvl — same runtime derivation.
	try {
		const { protocols } = await buildProtocols();
		for (const p of protocols.slice(0, 10)) {
			if (p.slug) push('protocol', p.slug, 'tvl', p.tvl);
		}
	} catch (err) {
		console.error('[wk/x402-discovery] datapoint protocol slice unavailable', err?.message || err);
	}

	return items;
}

// ── output.example backfill ──────────────────────────────────────────────────
// Indexers (agentic.market / x402scan) render and rank a resource by its
// response example. A resource with no `bazaar.info.output.example` still
// catalogs, but ranks poorly and shows an empty result card — the verifier
// (`scripts/verify-x402-discovery.mjs`) flags every one as a warning. These maps
// are the single source of a realistic, schema-shaped success example for each
// paid endpoint so the catalog renders fully everywhere it's indexed.
//
// Every value here is SYNTHETIC: $THREE (the only coin) or an obviously-fake
// placeholder address — never a real third-party mint/creator/holder. Examples
// mirror the actual 200-response keys each handler emits (post-settlement).
const REST_OUTPUT_EXAMPLES = Object.freeze({
	'/api/x402/model-check': {
		url: 'https://three.ws/avatar/character-studio/sample.glb',
		fetchedBytes: 1572864,
		model: {
			container: 'glb',
			generator: 'three.ws CharacterStudio v1.5',
			version: '2.0',
			extensionsUsed: ['KHR_materials_unlit'],
			extensionsRequired: [],
			counts: {
				scenes: 1,
				nodes: 18,
				meshes: 6,
				materials: 4,
				textures: 3,
				animations: 1,
				skins: 1,
				totalVertices: 12480,
				totalTriangles: 24812,
			},
		},
		suggestions: [
			{
				id: 'texture_size',
				severity: 'info',
				message: 'All textures are within 1024x1024 — good for mobile.',
			},
		],
	},
	'/api/x402/token-intel': {
		mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
		symbol: 'THREE',
		name: 'three.ws',
		chain: 'solana',
		price_usd: 0.003685,
		change_24h: 12.4,
		market_cap_usd: 3685000,
		liquidity_usd: 412000,
		volume_24h_usd: 1268079,
		momentum: { m5: 0.3, h1: 1.8, h6: 6.1, h24: 12.4 },
		signal: 'bullish',
		headline: 'THREE climbs +12.40% — moderate upside',
		rationale:
			'THREE is up +12.40% over 24 h, trading at $0.003685. Volume is healthy against liquidity; participation is real. Buyers dominate the tape. The last hour confirms the trend.',
		confidence: 0.86,
		risk: {
			score: 8,
			level: 'low',
			summary: 'THREE clears the basic depth, age, and flow checks.',
			factors: [
				{ label: 'Liquidity', status: 'low', detail: '$412,000 pooled — healthy depth.' },
				{ label: 'Age', status: 'low', detail: 'Pair is 240d old — established.' },
				{ label: 'Float', status: 'low', detail: 'Cap is 8.9× liquidity — well backed.' },
				{ label: 'Flow', status: 'low', detail: '63% of 24 h trades are buys — net accumulation.' },
			],
		},
		ts: '2026-06-12T10:00:00Z',
	},
	'/api/x402/analytics': {
		ok: true,
		report: 'clubs',
		period: '24h',
		generated_at: '2026-06-27T18:42:09.000Z',
		metrics: {
			active_clubs: 3,
			total_clubs: 4,
			members: 27,
			tips: { count: 41, volume_atomics: '410000', volume_usdc: 0.41 },
			cover_charges: { count: 12, atomics: '120000', usdc: 0.12 },
		},
		top_clubs: [
			{ dancer: '1', display_name: 'Nyx', volume_atomics: '190000', volume_usdc: 0.19, tips: 19 },
		],
	},
	'/api/x402/api-key-health': {
		valid: true,
		scopes: ['internal', 'autonomous_loop', 'bypass_x402'],
		expires_at: null,
		key_type: 'internal',
		source: 'env',
		key_prefix: null,
		rate_limit_per_minute: null,
		checked_at: '2026-06-28T12:00:00Z',
	},
	'/api/x402/auth-health': {
		all_pass: true,
		failed_step: null,
		latency_ms: 38,
		steps: {
			create: { pass: true, latency_ms: 8 },
			validate: { pass: true, latency_ms: 3 },
			refresh: { pass: true, latency_ms: 11 },
			expire: { pass: true, latency_ms: 2 },
		},
		ts: '2026-06-28T00:00:00Z',
	},
	'/api/x402/avatar-optimize-batch': {
		analyzed: 50,
		critical_count: 12,
		warn_count: 38,
		info_count: 91,
		total_size_bytes: 82000000,
		avatars: [
			{
				id: '7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55',
				name: 'My Avatar',
				size_bytes: 2100000,
				critical_count: 1,
				warn_count: 3,
				info_count: 5,
				top_suggestion: 'Apply Draco compression to reduce geometry size by ~60%',
			},
		],
	},
	'/api/x402/pipeline-rig': {
		stage: 'rig',
		input_url: 'https://three.ws/forge/character.glb',
		output_url: 'https://cdn.three.ws/x402-pipeline/rig/abc123.glb',
		bytes: 1940112,
		persisted: true,
		rig_type: 'biped',
	},
	'/api/x402/pipeline-remesh': {
		stage: 'remesh',
		input_url: 'https://three.ws/forge/sample.glb',
		output_url: 'https://cdn.three.ws/x402-pipeline/remesh/abc123.glb',
		bytes: 812044,
		persisted: true,
		remesh_mode: 'quad',
		operation: 'full',
		face_count: 20000,
		quad_ratio: 0.98,
		textured: true,
	},
	'/api/x402/pipeline-gameready': {
		stage: 'gameready',
		input_url: 'https://three.ws/forge/prop.glb',
		output_url: 'https://cdn.three.ws/x402-pipeline/gameready/abc123.glb',
		bytes: 640220,
		persisted: true,
		topology: 'quad',
		poly_budget: 12000,
		face_count: 12000,
		quad_ratio: 0.97,
		textured: true,
	},
	'/api/x402/pipeline-stylize': {
		stage: 'stylize',
		input_url: 'https://three.ws/forge/statue.glb',
		output_url: 'https://cdn.three.ws/x402-pipeline/stylize/abc123.glb',
		bytes: 512880,
		persisted: true,
		style: 'voxel',
		resolution: 48,
		face_count: 18240,
	},
	'/api/x402/pipeline-rembg': {
		stage: 'rembg',
		input_url: 'https://three.ws/uploads/photo.jpg',
		output_url: 'https://cdn.three.ws/x402-pipeline/rembg/abc123.png',
		bytes: 284112,
		persisted: true,
		model: 'rmbg2',
	},
	'/api/x402/bazaar-feed': {
		filter: 'new',
		limit: 10,
		count: 3,
		listings: [
			{
				id: 'http:https://svc.example/x402',
				name: 'Example Feed',
				price: '0.001 USDC',
				first_seen: '2026-06-28T00:00:00Z',
			},
		],
		activity: {
			new_24h: 3,
			new_7d: 9,
			daily_avg_7d: 1.29,
			signal: 'active',
			headline: '3 new bazaar listings in 24 h',
			confidence: 0.65,
		},
		generated_at: '2026-06-28T10:00:00Z',
	},
	'/api/x402/billboard': {
		ok: true,
		coin: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
		image: 'https://three.ws/og-image.png',
		caption: 'gm from the gallery',
		slotHours: 6,
		startsAt: '2026-06-28T18:42:09.000Z',
		endsAt: '2026-06-29T00:42:09.000Z',
		payer: 'wwwPqsM4N7T9J69tB82nLyzxqsH159j4orftLTQfUGV',
		network: 'solana',
		amountAtomics: '50000',
		asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	},
	'/api/x402/cross-chain': {
		mode: 'bridge_status',
		bridges: [
			{ chain: 'wormhole', status: 'operational', latency_ms: 210, provider: 'wormholescan' },
			{ chain: 'lifi', status: 'operational', latency_ms: 334, provider: 'li.fi' },
			{ chain: 'debridge', status: 'degraded', latency_ms: 1870, provider: 'dln.trade' },
		],
		down_count: 0,
		signal: 'neutral',
		headline: 'All Solana bridges operational',
		confidence: 0.82,
		ts: '2026-06-28T12:00:00Z',
	},
	'/api/x402/did': {
		verified: true,
		latency_ms: 142,
		did: 'did:three:canary',
		mode: 'verify',
		resolved_did: 'did:web:three.ws',
		http_status: 200,
		within_latency: true,
		malformed: false,
		configured: true,
		checks: {
			is_object: true,
			has_did_context: true,
			has_did_id: true,
			has_verification_method: true,
			assertion_resolves: true,
			has_x402_service: true,
			valid: true,
		},
		ts: '2026-06-27T10:00:00Z',
	},
	'/api/x402/feed-health': {
		feed: 'changelog_rss',
		valid: true,
		item_count: 1241,
		latest_title: 'x402 Volume Analytics — the platform measures its own payment economy',
		title_match: true,
		fetch_ms: 312,
		checked_at: '2026-06-28T12:00:00.000Z',
	},
	'/api/x402/llm-proxy': {
		content: '1, 2, 3.',
		model: 'llama-3.3-70b-versatile',
		provider: 'groq',
		latency_ms: 312,
		tokens_used: 11,
		input_tokens: 5,
		output_tokens: 6,
	},
	'/api/x402/mcp-tool-catalog': {
		ok: true,
		mode: 'discover',
		total_tools: 24,
		priced_tools: 11,
		free_tools: 13,
		new_tools: [
			{ name: 'segment_model', description: 'Split a mesh into named parts', priced: true, price_usdc: 0.04, input_fields: 2 },
		],
		changed_tools: [
			{ name: 'render_avatar', change: 'price', price_usdc: 0.005, prev_price_usdc: 0.003 },
		],
		removed_tools: [],
		ts: '2026-06-27T10:00:00.000Z',
	},
	'/api/x402/model-validation-sweep': {
		ok: true,
		avatar_id: 'a3f3d6c2-1f1b-4f10-9b6c-1b1f5e0c9c34',
		avatar_name: 'Realistic Male',
		score: 82,
		has_errors: false,
		missing_bones: false,
		counts: {
			scenes: 1,
			nodes: 22,
			meshes: 4,
			materials: 3,
			textures: 5,
			animations: 12,
			skins: 1,
			totalVertices: 8432,
			totalTriangles: 14200,
			indexedPrimitives: 4,
			nonIndexedPrimitives: 0,
		},
		extensions_used: ['KHR_draco_mesh_compression'],
		file_size_bytes: 1572864,
		inspected_at: '2026-06-27T10:00:00.000Z',
	},
	'/api/x402/notify': {
		delivered: true,
		channel: 'canary',
		latency_ms: 18,
		notification_id: 'a3f3d6c2-1f1b-4f10-9b6c-1b1f5e0c9c34',
		message: 'x402 loop heartbeat',
		priority: 'low',
		payer: null,
		ts: '2026-06-28T10:00:00Z',
	},
	'/api/x402/pay-by-name': {
		data: {
			name: 'nich.threews.sol',
			address: 'wwwPqsM4N7T9J69tB82nLyzxqsH159j4orftLTQfUGV',
			verified: true,
			source: 'sns',
		},
	},
	'/api/x402/rate-limit-probe': {
		endpoint: '/api/x402/forge',
		remaining_calls: 42,
		reset_at: '2026-06-29T00:00:00.000Z',
		limit: 500,
		daily_cap_atomic: 5000000,
		daily_spent_atomic: 4580000,
		remaining_capacity_atomic: 420000,
		price_atomic: 10000,
		cooldown_active: false,
		cooldown_ttl_seconds: null,
	},
	'/api/x402/schema-check': {
		ok: true,
		api: 'changelog_json',
		valid: true,
		version: '2026-06-28',
		entry_count: 42,
		schema_errors: [],
		fetched_at: '2026-06-28T12:00:00.000Z',
	},
	'/api/x402/solana-register-health': {
		tool: 'solana_register',
		healthy: true,
		network: 'mainnet',
		canary_agent_id: '7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55',
		asset: 'THREEsynthetic1111111111111111111111111111',
		identity_pda: 'AgentRegyPDA11111111111111111111111111111111',
		registration_uri: 'https://three.ws/api/agents/7b9a4f30/registration.json',
		checks: {
			indexed: true,
			registry_enrolled: true,
			asset_onchain: true,
			identity_pda_onchain: true,
		},
		rpc_latency_ms: 184,
		checked_at: '2026-06-27T18:00:00Z',
	},
	'/api/x402/spend-session': {
		ok: true,
		mode: 'canary',
		created: true,
		consumed: true,
		latency_ms: 12,
		session_id: 'a3f3d6c2-1f1b-4f10-9b6c-1b1f5e0c9c34',
		budget: 0.01,
		payer: 'wwwPqsM4N7T9J69tB82nLyzxqsH159j4orftLTQfUGV',
		network: 'solana',
		amountAtomics: '10000',
		asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	},
	'/api/x402/telegram-health': {
		bot: 'changelog',
		reachable: true,
		bot_id: 7234567890,
		bot_username: 'three_ws_bot',
		latency_ms: 142,
		reason: null,
		checked_at: '2026-06-28T12:00:00.000Z',
	},
	'/api/x402/wallet-connect': {
		mode: 'health',
		session_created: true,
		latency_ms: 83,
		slow: false,
		nonce_valid: true,
		domain: 'three.ws',
		reason: null,
		checked_at: '2026-06-28T00:00:00Z',
	},
	'/api/x402/agent-reputation': {
		subject: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
		subjectType: 'solana_mint',
		score: 71,
		tier: 'high',
		signals: {
			dimensions: {
				activity: { available: true, weight: 25, norm: 0.62, points: 16, value: 124 },
				age: { available: true, weight: 15, norm: 0.48, points: 7, days: 176 },
				counterparties: { available: true, weight: 15, norm: 0.72, points: 11, value: 18 },
				holdings: { available: true, weight: 10, norm: 1, points: 10, usd: 412000 },
				reliability: { available: true, weight: 15, norm: 0.98, points: 15, failure_rate: 0.02 },
				attestations: { available: true, weight: 20, norm: 0.6, points: 12, count: 6, avg_feedback: null },
			},
			weight_considered: 100,
		},
		evidence: [
			{ kind: 'solana_token', ref: 'https://solscan.io/token/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump' },
			{ kind: 'threews_agent', ref: '/agent/7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55' },
		],
		caveats: [],
		ts: '2026-07-07T00:00:00Z',
	},
	'/api/x402/agent-bouncer': {
		ok: true,
		admitted: true,
		banned: false,
		tier: 'trusted',
		reason: null,
		reasons: [],
		newcomer: false,
		agent_id: '7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55',
		name: 'Helios',
		visits: 4,
		reputation: {
			deployed_mints: 2,
			payments: { confirmed_count: 142, distinct_payers: 87, failure_rate: 0.021 },
			distributions: { confirmed: 12, failed: 1, success_rate: 0.923 },
		},
		policy: {
			minPayments: 10,
			minDistinctPayers: 3,
			maxFailureRate: 0.2,
			allowNewcomers: true,
		},
		fetchedAt: '2026-06-22T17:00:00.000Z',
	},
	'/api/x402/onchain-identity-verify': {
		claim: {
			identity: 'vitalik.eth',
			address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
			chain: 'eip155:1',
		},
		identity_type: 'ens',
		verified: true,
		method: 'ens-resolution',
		evidence: [
			{
				kind: 'ens_forward_resolution',
				ref: 'vitalik.eth',
				detail: 'resolves to 0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
			},
		],
		caveats: [],
		ts: '2026-07-07T00:00:00.000Z',
	},
	'/api/x402/pump-launch': {
		mint: 'HEL1oXyzABCDEFGHJKLMNopqrstuvwxyZ12345abcdef',
		signature: '5xYExampleTxSignatureDoNotUse...',
		creator: 'wwwPqsM4N7T9J69tB82nLyzxqsH159j4orftLTQfUGV',
		name: 'Helios',
		symbol: 'HELIO',
		metadataUri: 'https://ipfs.io/ipfs/QmExampleMetadataCid',
		network: 'mainnet',
		pumpfun_url: 'https://pump.fun/coin/HEL1oXyzABCDEFGHJKLMNopqrstuvwxyZ12345abcdef',
		vanity_prefix: 'HEL',
		vanity_iterations: 4821,
	},
	// Sourced from the shared forge listing so the discovery output example
	// matches the live 402's exactly (backend field included).
	'/api/x402/forge': FORGE_OUTPUT_EXAMPLE,
	'/api/x402/skill-marketplace': {
		skill_filter: 'inspect_model',
		count: 1,
		cheapest: {
			agent_name: 'Helios',
			skill: 'inspect_model',
			amount_atomics: '10000',
			chain: 'solana',
		},
		listings: [
			{
				agent_id: '7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55',
				agent_name: 'Helios',
				skill: 'inspect_model',
				amount_atomics: '10000',
				mint_decimals: 6,
				chain: 'solana',
				trial_uses: 1,
				time_pass_hours: 24,
			},
		],
		indexed_at: '2026-05-14T17:00:00Z',
	},
	'/api/x402/symbol-availability': {
		ticker: 'HELIO',
		network: 'mainnet',
		exact_collision: false,
		exact_matches: [],
		similar: [
			{
				ticker: 'HELIOS',
				mint: 'C3vQABCDEFGHJKLMNopqrstuvwxyZ12345abcdefghi',
				name: 'Helios',
				similarity: 0.71,
			},
		],
		recommendation: 'available — one near-match exists at similarity 0.71',
		indexed_at: '2026-05-14T17:00:00Z',
	},
	'/api/x402/vanity': {
		address: 'SoEXAMPLEdoNotUse1111111111111111111111111111',
		prefix: 'So',
		suffix: null,
		ignoreCase: false,
		format: 'keypair',
		secretKeyBase58: '<example only — the live endpoint returns the ground secret key here>',
		mnemonic: null,
		wordCount: null,
		derivationPath: null,
		attempts: 160,
		durationMs: 6,
		expectedAttempts: 58,
		network: 'solana',
		explorerUrl: 'https://solscan.io/account/SoEXAMPLEdoNotUse1111111111111111111111111111',
		verifyUrl: 'https://three.ws/vanity/verify',
		serviceKeyUrl: 'https://three.ws/.well-known/three-vanity.json',
	},
	'/api/x402/vanity-verifiable': {
		protocol: 'three-vanity/v1',
		receiptType: 'grind-receipt',
		address: 'SoEXAMPLEdoNotUse1111111111111111111111111111',
		pattern: { prefix: 'So', suffix: null, ignoreCase: false },
		commitment: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
		winningIndex: 3041,
		attempts: 3042,
		sealed: false,
		servicePublicKey: '3WzwpVSmSExamplePublicKeyDoNotUse',
		signature: 'ed25519:abcdef1234567890...',
		network: 'solana',
		verifyUrl: 'https://three.ws/vanity/verify',
		serviceKeyUrl: 'https://three.ws/.well-known/three-vanity.json',
	},
	'/api/x402/vanity-premium': {
		address: 'PUMPEXAMPLEdoNotUse1111111111111111111111111',
		prefix: 'PUMP',
		suffix: null,
		patternLabel: 'PUMP…',
		rarityTier: 'rare',
		format: 'keypair',
		priceUsd: 12,
		secretKeyBase58: '<delivered once — ciphertext destroyed on delivery>',
		delivery: 'once',
		network: 'solana',
		explorerUrl: 'https://solscan.io/account/PUMPEXAMPLEdoNotUse1111111111111111111111111',
		custodyNotice:
			'Platform-generated key delivered once — use as a token mint or sweep to self-generated custody, not as a treasury.',
	},
	'/api/x402/asset-download': {
		ok: true,
		slug: 'pole-dancer-rumba',
		title: 'Pole Dancer (Rumba)',
		mimeType: 'model/gltf-binary',
		sizeBytes: 6492840,
		expiresAt: '2026-05-21T18:48:09.000Z',
		downloadUrl: 'https://three-ws-public.r2.dev/assets/pole-dancer-rumba.glb?X-Amz-Algorithm=...',
	},
	'/api/x402/skill-call': {
		ok: true,
		skill: { slug: 'wallet-balance', name: 'Wallet Balance', category: 'crypto' },
		tools: [{ type: 'function', function: { name: 'get_balance', description: 'Fetch balances.' } }],
		content: '# Wallet Balance\n\nUse get_balance to fetch token balances...',
		calledAt: '2026-05-31T18:48:09.000Z',
	},
	'/api/x402/cosmetic-purchase': {
		ok: true,
		id: 'skin-midnight',
		name: 'Midnight',
		slot: 'skin',
		rarity: 'legendary',
		account: 'g_5f3c9a21b8',
		owned: true,
		newlyOwned: true,
		network: 'solana',
		amountAtomics: '3000000',
	},
	'/api/x402/animation-download': {
		ok: true,
		id: '00000000-0000-0000-0000-000000000000',
		slug: 'spin-kick-combo',
		name: 'Spin Kick Combo',
		mimeType: 'model/gltf-binary',
		sizeBytes: 248400,
		expiresAt: '2026-06-15T18:48:09.000Z',
		downloadUrl: 'https://three.ws/cdn/u/spin-kick-combo.glb?X-Amz-Algorithm=...',
	},
	'/api/x402/analytics': {
		ok: true,
		report: 'marketplace',
		period: '7d',
		generated_at: '2026-06-28T00:00:00.000Z',
		catalog: { listing_count: 128, priced_listings: 41, free_listings: 87, new_in_period: 9 },
		pricing: {
			avg_price_usd: 4.21,
			avg_price_sol: 0.028,
			min_price_usd: 0.5,
			max_price_usd: 25,
			priceable_count: 41,
			sol_usd_price: 150.0,
			by_currency: [
				{ currency: 'USDC', currency_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', chain: 'solana', count: 38, avg_price: 4.1, priceable: true },
			],
		},
		engagement: {
			total_views: 9521,
			total_forks: 642,
			most_viewed_id: '7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55',
			most_viewed_name: 'Helios',
			most_viewed_count: 1840,
			most_forked_id: 'a1b2c3d4-1111-2222-3333-444455556666',
			most_forked_name: 'Forge',
			most_forked_count: 96,
		},
	},
	'/api/x402/club-cover': {
		ok: true,
		admitted: true,
		banned: false,
		tier: 'regular',
		visits: 4,
		passId: 'a3f3d6c2-1f1b-4f10-9b6c-1b1f5e0c9c34',
		issuedAt: '2026-06-15T18:42:09.000Z',
		expiresAt: '2026-06-16T00:42:09.000Z',
		network: 'solana',
		amountAtomics: '10000',
	},
	// Only advertised when CDP creds are present (its sole accept is a Permit2
	// sibling), so it never appears in the public non-CDP catalog — but include
	// its example so the catalog stays green in CDP-credentialed environments.
	'/api/x402/permit2-paid-demo': {
		ok: true,
		demo: 'permit2-eip2612-gas-sponsoring',
		method: 'permit2',
		supportsEip2612: true,
		payer: '0x1111111111111111111111111111111111111111',
		network: 'eip155:8453',
		asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
		amountAtomics: '1000',
		transaction: '0x9c0a7e5ad5c9c0bb6f04f6ad9c52f4f44bb6c5d9c0a7e5ad5c9c0bb6f04f6ad9',
		explorer:
			'https://basescan.org/tx/0x9c0a7e5ad5c9c0bb6f04f6ad9c52f4f44bb6c5d9c0a7e5ad5c9c0bb6f04f6ad9',
		settledAt: '2026-06-15T18:42:09.000Z',
	},
});

// MCP tool result examples, keyed by toolName. Wrapped in the same JSON-RPC 2.0
// CallToolResult envelope the live /api/mcp + /api/mcp-3d transports return, so
// the example mirrors exactly what a buyer's MCP client receives.
const MCP_TOOL_OUTPUT_SUMMARIES = Object.freeze({
	render_avatar: { ok: true, scene: 'avatar', format: 'glb', url: 'https://three.ws/cdn/avatar-preview.glb' },
	validate_model: { ok: true, warnings: [], errors: [], meta: { vertices: 12480, triangles: 24812 } },
	inspect_model: { container: 'glb', meshes: 6, materials: 4, animations: 1, vertices: 12480 },
	optimize_model: { ok: true, before: { bytes: 1572864 }, after: { bytes: 640000 }, savedPct: 59 },
	apply_animation: { ok: true, clip: 'walk', format: 'glb', url: 'https://three.ws/cdn/animated.glb' },
	text_to_3d: { job_id: 'f1.eyJwIjoiZXhhbXBsZSJ9.sig', status: 'queued', poll_url: '/api/forge?job=f1.eyJwIjoiZXhhbXBsZSJ9.sig' },
	image_to_3d: { job_id: 'f1.eyJpIjoiZXhhbXBsZSJ9.sig', status: 'queued', poll_url: '/api/forge?job=f1.eyJpIjoiZXhhbXBsZSJ9.sig' },
	remove_background: { ok: true, image_url: 'https://three.ws/cdn/cutout.png' },
	remesh_model: { ok: true, glb_url: 'https://three.ws/cdn/remeshed.glb', triangles: 20000 },
	stylize_model: { ok: true, glb_url: 'https://three.ws/cdn/stylized.glb', style: 'voxel' },
	segment_model: { ok: true, parts: ['head', 'torso', 'legs'], glb_url: 'https://three.ws/cdn/segmented.glb' },
	retexture_model: { ok: true, glb_url: 'https://three.ws/cdn/retextured.glb' },
	retexture_region: { ok: true, glb_url: 'https://three.ws/cdn/retextured-region.glb', region: 'face' },
	auto_rig_model: { ok: true, glb_url: 'https://three.ws/cdn/rigged.glb', bones: 52 },
	pose_model: { ok: true, glb_url: 'https://three.ws/cdn/posed.glb', pose: 't-pose' },
	direct_prompt: { job_id: 'f1.eyJkIjoiZXhhbXBsZSJ9.sig', status: 'queued', poll_url: '/api/forge?job=f1.eyJkIjoiZXhhbXBsZSJ9.sig' },
	generate_material: { ok: true, material_url: 'https://three.ws/cdn/material.glb' },
	search_public_avatars: {
		count: 2,
		avatars: [
			{ id: '7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55', slug: 'midnight-robot', name: 'Midnight Robot', tags: ['robot', 'sci-fi'], thumbnail_url: 'https://three.ws/cdn/avatars/midnight-robot.png' },
			{ id: 'c1e8a902-5b44-4f0a-8e21-7d3f0c2b1a90', slug: 'anime-dancer', name: 'Anime Dancer', tags: ['anime', 'dancer'], thumbnail_url: 'https://three.ws/cdn/avatars/anime-dancer.png' },
		],
	},
	solana_agent_reputation: {
		asset: 'AgEntWa11etExamp1eDoNotUse111111111111111111',
		network: 'mainnet',
		feedback: { total: 142, verified: 118 },
		score: { average: 4.6, verified_average: 4.8 },
		validation: { passed: 8, failed: 1 },
		tasks: { accepted: 96, disputed: 2 },
		indexed_at: '2026-05-14T17:00:00Z',
	},
	capture_scene: {
		job_id: 'v2s.eyJ2IjoiZXhhbXBsZSJ9.sig',
		status: 'queued',
		source_video_url: 'https://three.ws/cdn/sample-room-walkthrough.mp4',
		mode: 'streaming',
		eta_seconds: 180,
	},
	// Mirrors mintTokenized3dAsset()'s structuredContent in api/_mcp/tools/tokenize.js.
	mint_3d_asset: {
		status: 'minted',
		idempotent: false,
		name: 'Midnight Robot',
		network: 'devnet',
		mint: 'M1ntExamp1eDoNotUse1111111111111111111111111',
		explorer_asset_url: 'https://core.metaplex.com/explorer/M1ntExamp1eDoNotUse1111111111111111111111111?env=devnet',
		explorer_tx_url: 'https://explorer.solana.com/tx/5synthetictransactionsignature111111111111111111111111111111111111111111111111111111?cluster=devnet',
		viewer_url: 'https://three.ws/viewer?src=https%3A%2F%2Fcdn.three.ws%2Favatars%2Fmidnight-robot.glb',
		royalty: { percent: 5, requested_basis_points: 500, cap_basis_points: 1000, capped: false },
	},
	// Mirrors handleAnchor()'s structuredContent in api/_mcp3d/tools/provenance.js.
	anchor_provenance: {
		status: 'anchored',
		glbSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		credentialHash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
		issuer: 'AtteStIssuerExamp1eDoNotUse11111111111111111',
		anchor: {
			tx: '5synthetictransactionsignature111111111111111111111111111111111111111111111111111111',
			cluster: 'devnet',
			explorerUrl: 'https://explorer.solana.com/tx/5synthetictransactionsignature111111111111111111111111111111111111111111111111111111?cluster=devnet',
		},
	},
});

// Wrap a tool result summary in the JSON-RPC CallToolResult envelope.
function mcpResultExample(summary) {
	return {
		jsonrpc: '2.0',
		id: 1,
		result: { content: [{ type: 'text', text: JSON.stringify(summary) }] },
	};
}

// Backfill bazaar.info.output.example on one resource that lacks it, from the
// maps above. Mutates the already-built bazaar extension in place (the root info
// schema permits the extra `output` field — verified against both the REST and
// MCP meta-schemas) and returns the resource so it composes as an array .map().
// Resources that already carry an output example (the /api/mcp + /api/mcp-3d
// transport rows) are left untouched. Agent-published dynamic listings get a
// generic settled-result example so they catalog fully too.
function addOutputExample(r) {
	const info = r?.extensions?.bazaar?.info;
	if (!info || info.output?.example !== undefined) return r;
	let example;
	if (r.toolName && MCP_TOOL_OUTPUT_SUMMARIES[r.toolName]) {
		example = mcpResultExample(MCP_TOOL_OUTPUT_SUMMARIES[r.toolName]);
	} else if (REST_OUTPUT_EXAMPLES[r.path]) {
		example = REST_OUTPUT_EXAMPLES[r.path];
	} else if (typeof r.path === 'string' && r.path.startsWith('/api/x402/service/')) {
		// Agent-published listing: the response shape is the agent's own, so
		// advertise a generic settled envelope rather than a fabricated body.
		example = { ok: true, paid: true, result: {} };
	}
	if (example !== undefined) info.output = { type: 'json', example };
	return r;
}

async function handleX402Discovery(req, res) {
	const origin = env.APP_ORIGIN;
	const mcpUrl = `${origin}/api/mcp`;
	const mcp3dUrl = `${origin}/api/mcp-3d`;
	const price = RAW_AMOUNT_TO_USDC(env.X402_MAX_AMOUNT_REQUIRED);

	// Build the MCP accept list (Base + Solana). `resource` is echoed on every
	// accept so reviewers + spend logs can reconcile the entry against the
	// resource it gates without walking back to the parent resource[] entry.
	function buildMcpAccepts(resourceUrl) {
		const out = [];
		// Solana-first platform default — Solana leads, Base follows. Gated on
		// solanaSettleable() so the catalog never advertises a Solana rail the live
		// 402 drops when the self-facilitator's co-signing secret is missing.
		if (env.X402_PAY_TO_SOLANA && solanaSettleable()) {
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
		// Base only when settleable (CDP creds or the X402_ADVERTISE_BASE opt-in) —
		// else the catalog would advertise a rail the live 402 now drops. See baseSettleable().
		if (env.X402_PAY_TO_BASE && baseSettleable()) {
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
		return out;
	}

	// model-check is CDP-Bazaar-cataloged.
	// CDP supports Base mainnet + Arbitrum One; advertise both here so
	// agentic.market shows the same network options buyers will see in the
	// live 402 challenge. Each EVM entry gets a Permit2 sibling so
	// EIP-2612-aware clients can pick the gasless Permit2-via-EIP-2612 path.
	const ARB_USDC = env.X402_ASSET_ADDRESS_ARBITRUM;
	function buildBazaarAccepts(resourceUrl) {
		const out = [];
		// Solana-first platform default — Solana leads the catalog entry. The
		// Base + Arbitrum accepts still follow so CDP keeps processing an EVM
		// verify+settle for agentic.market cataloging.
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
		// Base + Arbitrum are CDP-settled EVM rails; advertise them only when a
		// working facilitator is configured (CDP creds or the X402_ADVERTISE_BASE
		// opt-in). Without one the live 402 drops Base, so an ungated catalog entry
		// would drift and 502.
		if (env.X402_PAY_TO_BASE && baseSettleable()) {
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
		if (env.X402_PAY_TO_BASE && ARB_USDC && baseSettleable()) {
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
		}
		return out;
	}

	const mcpAccepts = buildMcpAccepts(mcpUrl);
	const mcp3dAccepts = buildMcpAccepts(mcp3dUrl);
	// Service metadata for the two MCP transport entries. Every static
	// /api/x402/* resource entry now derives from the unified service catalog
	// (api/_lib/service-catalog/) — its per-service descriptors carry each
	// route's serviceName/tags, which used to be mapped inline here.
	const mcpService = withService({
		serviceName: 'three.ws MCP',
		tags: ['mcp', '3d', 'gltf', 'solana', 'agent'],
	});

	// USE-13: per-tool MCP catalog entries. Each priced tool is its own
	// catalog row keyed on (resource, toolName) so search can find them
	// individually instead of all hiding behind the parent /api/mcp resource.
	// Built from the live TOOL_CATALOG so adding a new priced tool only
	// requires a pricing entry; the discovery shape follows automatically.
	const mcpToolItems = buildMcpToolItems({
		path: '/api/mcp',
		mcpUrl,
		mcpAccepts,
		mcpService,
		catalog: TOOL_CATALOG,
		priceForTool: priceFor,
	});

	// 3D Studio paid tools — one row per priced tool so "text to 3d" searches
	// on facilitators land on the tool, not just the transport. Service
	// identity comes from STUDIO_CHALLENGE (same source as the live 402).
	const studioService = {
		serviceName: STUDIO_CHALLENGE.serviceName,
		tags: STUDIO_CHALLENGE.tags,
		iconUrl: STUDIO_CHALLENGE.iconUrl,
	};
	const studioToolItems = buildMcpToolItems({
		path: '/api/mcp-3d',
		mcpUrl: mcp3dUrl,
		mcpAccepts: mcp3dAccepts,
		mcpService: studioService,
		catalog: STUDIO_TOOL_CATALOG,
		priceForTool: studioPriceFor,
	});

	// Every static /api/x402/* resource entry, derived from the unified
	// service catalog (one descriptor per service — the single source of truth
	// both storefronts read; see specs/service-catalog.md). The env-aware
	// accepts builders stay here so the advertised rails keep matching the
	// live 402 exactly.
	const x402CatalogItems = toBazaarDiscovery({
		origin,
		extensionsForAccepts,
		acceptsFor(service, url) {
			// model-check is CDP-Bazaar-cataloged: Base + Arbitrum + Solana.
			if (service.acceptsBuilder === 'cdp-bazaar') return buildBazaarAccepts(url);
			if (service.acceptsBuilder === 'permit2-only') {
				// Permit2-only demo: skip the EIP-3009 entry that acceptsForPrice
				// would push first, so SDK clients are forced through the gasless
				// EIP-2612 → settleWithPermit path the endpoint is meant to prove.
				// permit2VariantOf returns null without CDP creds, in which case we
				// omit the resource from discovery (matches the runtime 402 behavior).
				const baseAccept = env.X402_PAY_TO_BASE
					? {
							scheme: 'exact',
							network: NETWORK_BASE_MAINNET,
							network_label: 'base-mainnet',
							amount: service.priceAtomics,
							price: RAW_AMOUNT_TO_USDC(service.priceAtomics),
							payTo: env.X402_PAY_TO_BASE,
							asset: env.X402_ASSET_ADDRESS_BASE,
							asset_symbol: 'USDC',
							maxTimeoutSeconds: 60,
							resource: url,
							extra: { name: 'USD Coin', version: '2', decimals: 6 },
						}
					: null;
				const permit2 = baseAccept ? permit2VariantOf(baseAccept) : null;
				return permit2 ? [permit2] : null;
			}
			return acceptsForPrice(service.priceAtomics, url);
		},
	});

	// Agent-published paid services — dynamic, one entry per active listing.
	const agentServiceItems = await buildAgentServiceItems(origin);
	const datapointItems = await buildDatapointItems(origin);

	return json(
		res,
		200,
		{
			$schema: 'https://x402.org/schemas/discovery.json',
			service: {
				name: 'three.ws',
				legal_name: 'three.ws',
				tagline: '3D generation + crypto data + launch/trust tools for AI agents.',
				description:
					'three.ws — 3D generation + crypto data + launch/trust tools for AI agents. ' +
					'Free Crypto Data API (token snapshots, security checks, holders, whales, trending, wallets — keyless) and free text→3D generation; ' +
					'pay-per-call for Forge Pro, rigged avatars, vanity addresses, pump.fun token launches, and cross-chain trust checks (agent reputation, on-chain identity verify). ' +
					'Reachable as paid REST endpoints (x402 v2) and MCP tool calls. USDC on Solana, Base, and Arbitrum mainnet.',
				operator: 'three.ws',
				mission:
					'Give autonomous agents the tools they reach for mid-task — 3D assets, crypto data, launches, and trust — machine-native over HTTP 402.',
				website: origin,
				docs: `${origin}/docs/start-here`,
				repository: 'https://github.com/nirholas/three.ws',
				contact: `${origin}/`,
				tags: [
					'x402',
					'x402-v2',
					'mcp',
					'agent-first',
					'3d',
					'text-to-3d',
					'crypto-data',
					'trust',
					'token-launch',
					'solana',
					'base',
					'arbitrum',
					'usdc',
				],
				categories: ['3D', 'AI', 'Crypto', 'Data', 'Utility'],
				environment: 'apex',
				origin,
			},
			// `.filter(Boolean)` drops any resource whose IIFE returned null —
			// e.g. permit2-paid-demo is omitted when CDP creds are missing,
			// matching the runtime 402 behavior so we don't catalog a route that
			// would fail at first paid call. The trailing .map(addOutputExample)
			// backfills a realistic response example onto every entry so indexers
			// render and rank each one (no empty result cards, no verifier warnings).
			resources: [
				{
					path: '/api/mcp',
					url: mcpUrl,
					method: 'POST',
					description:
						'MCP 2025-06-18 Streamable HTTP transport — 3D avatar viewer, glTF model validation/inspection/optimization, and Solana agent data exposed as MCP tools. JSON-RPC 2.0 batch-aware. Currency: USDC.',
					mimeType: 'application/json',
					serviceName: mcpService.serviceName,
					tags: mcpService.tags,
					iconUrl: mcpService.iconUrl,
					accepts: mcpAccepts,
					extensions: extensionsForAccepts(mcpAccepts, bazaarExtension()),
					links: {
						openapi: `${origin}/openapi.json`,
						docs: `${origin}/docs/mcp`,
						agent_card: `${origin}/.well-known/agent-card.json`,
						payment_config: `${origin}/.well-known/x402`,
					},
				},
				{
					path: '/api/mcp-3d',
					url: mcp3dUrl,
					method: 'POST',
					description: STUDIO_CHALLENGE.description,
					mimeType: 'application/json',
					serviceName: STUDIO_CHALLENGE.serviceName,
					tags: STUDIO_CHALLENGE.tags,
					iconUrl: STUDIO_CHALLENGE.iconUrl,
					accepts: mcp3dAccepts,
					extensions: extensionsForAccepts(mcp3dAccepts, STUDIO_CHALLENGE.bazaar),
					links: {
						docs: `${origin}/docs/mcp-3d-studio`,
						payment_config: `${origin}/.well-known/x402`,
					},
				},
				// Every static /api/x402/* entry (model-check through wallet-connect),
				// generated from the unified service catalog in catalog order. Editing
				// a listing = editing api/_lib/service-catalog/services/<slug>.js.
				...x402CatalogItems,
				// USE-13: one Bazaar catalog row per priced MCP tool. The shared
				// `/api/mcp` and `/api/mcp-3d` resources above are the transport
				// entries; these are the individual paid tools facilitators
				// index by toolName.
				...mcpToolItems,
				...studioToolItems,
				// Agent-published paid endpoints (monetize_endpoint). Dynamic —
				// one entry per active agent_paid_services listing.
				...agentServiceItems,
				// Datapoint fabric (/api/x402/d/…): a curated, runtime-derived
				// slice of the 400k+ addressable single-datapoint endpoints, so
				// indexers surface the fabric; the full id space is enumerated
				// free at /api/x402/d.
				...datapointItems,
			]
				.filter(Boolean)
				.map(addOutputExample),
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

// SperaxOS / plugin.delivery manifest. Single source of truth is the static
// file at public/sperax/manifest.json (also served verbatim at /sperax/manifest.json);
// this alias adds cross-origin headers so the marketplace + browser validators
// can fetch it from /.well-known/sperax-plugin.json.
let speraxManifest;
try {
	speraxManifest = JSON.parse(
		readFileSync(join(process.cwd(), 'public/sperax/manifest.json'), 'utf8'),
	);
} catch (err) {
	console.error('[wk/sperax-plugin] failed to load manifest', err);
}

function handleSperaxPlugin(req, res) {
	if (!speraxManifest) return error(res, 500, 'internal_error', 'manifest unavailable');
	return json(res, 200, speraxManifest, { 'cache-control': 'public, max-age=3600' });
}

// ── three-vanity (/.well-known/three-vanity.json) ────────────────────────────
// Publishes the provably-fair vanity grinder's service identity: the long-lived
// Ed25519 public key that signs every verifiable-grind receipt, the protocol
// version, and the scheme ids. The SDK + CLI + /vanity/verify page pin this key
// so a buyer can prove a receipt really came from three.ws. The SECRET seed
// never leaves the server — only the public key is published here.
async function handleThreeVanity(req, res) {
	let identity;
	try {
		const mod = await import('./_lib/vanity-service-key.js');
		identity = await mod.getServiceIdentity();
	} catch (err) {
		console.error('[wk/three-vanity] service key unavailable', err?.message || err);
		return error(res, 500, 'service_key_unavailable', 'vanity service key not configured');
	}
	const origin = env.APP_ORIGIN;
	return json(
		res,
		200,
		{
			protocol: 'three-vanity/v1',
			protocols: ['three-vanity/v1', 'three-pog/v1'],
			description:
				'Provably-fair Solana vanity grinding. Keys are ground under a commit–reveal ' +
				'seed-mixing protocol (three-vanity/v1) and/or attested with a proof-of-grind ' +
				'certificate (three-pog/v1). Both are signed by the attestation key below and ' +
				'verified entirely client-side — nothing here is trusted, everything is recomputed.',
			serviceKey: {
				curve: 'ed25519',
				keyId: identity.keyId,
				publicKeyBase58: identity.publicKeyBase58,
				publicKeyHex: identity.publicKeyHex,
				use: 'receipt-signing, proof-of-grind-attestation',
			},
			// Rotation-aware verifier keyring: the set of attestation keys a verifier
			// should accept. On rotation, the retiring key stays here (with a
			// `retired` flag/date) until all in-flight certs age out, so historical
			// proofs keep verifying. Today there is one active key.
			keyring: [
				{
					keyId: identity.keyId,
					curve: 'ed25519',
					publicKeyBase58: identity.publicKeyBase58,
					status: 'active',
				},
			],
			schemes: {
				commitment: 'sha256(domain‖serverSeed)',
				seedMix: 'hkdf-sha256(serverSeed‖clientSeed‖requestNonce)',
				candidate: 'hmac-sha256(masterSeed, domain‖uint64_be(index)) → ed25519 seed',
				signature: 'ed25519',
				sealedEnvelope: 'x25519-hkdf-sha256-aes256gcm/v1',
				proofOfGrind: 'ed25519 over canonical(three-pog/cert/v1 ‖ sorted-json(core))',
				splitKeyNonCustody: 'P1 + a2·B == address (recomputed from public points)',
			},
			endpoints: {
				grind: `${origin}/api/x402/vanity`,
				verifiableGrind: `${origin}/api/x402/vanity-verifiable`,
				certRegistry: `${origin}/api/vanity/cert`,
				verifyPage: `${origin}/vanity/verify`,
			},
			documentation: `${origin}/vanity/verify`,
			protocolSpec: 'https://github.com/nirholas/three.ws/blob/main/docs/PROTOCOL-vanity.md',
		},
		{ 'cache-control': 'public, max-age=300' },
	);
}

const DISPATCH = {
	'agent-attestation-schemas': handleAttestationSchemas,
	'three-vanity': handleThreeVanity,
	'chat-plugin': handleChatPlugin,
	'sperax-plugin': handleSperaxPlugin,
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
	'sperax-plugin',
	'agent-attestation-schemas',
	'three-vanity',
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
