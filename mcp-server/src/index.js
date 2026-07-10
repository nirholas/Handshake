#!/usr/bin/env node
// @three-ws/mcp-server entry point.
//
// Boots an MCP server over stdio that exposes paid tools for pose generation,
// pump.fun snapshots, ERC-8004 reputation lookups, and Solana vanity mining.
// Tool calls without payment return the v2 MCP-transport `PaymentRequired`
// envelope (per @x402/mcp + transports-v2/mcp.md). Successful settlements are
// reported back to the client under `_meta["x402/payment-response"]`.
//
// Run standalone:
//   node mcp-server/src/index.js
//
// Or wire into Claude Desktop / Cursor as documented in README.md.
//
// Testability: `buildServer()` constructs and returns the fully-registered
// McpServer WITHOUT connecting the stdio transport and WITHOUT requiring any
// runtime payment env — tool registration (names/descriptions/schemas) is
// secret-free. Only an actual paid tool *invocation* requires
// MCP_SVM_PAYMENT_ADDRESS (enforced lazily inside `paid()`). The stdio boot in
// `main()` runs only when this file is the process entry point.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { assertPaymentEnv, getLastFacilitatorInitError, getResourceServer } from './payments.js';
import { buildPoseSeedTool } from './tools/pose-seed.js';
import { buildPumpSnapshotTool } from './tools/pump-snapshot.js';
import { buildAgentReputationTool } from './tools/agent-reputation.js';
import { buildVanityGrinderTool } from './tools/vanity-grinder.js';
import { buildVanityPremiumTool } from './tools/vanity-premium.js';
import { buildTextToAvatarTool } from './tools/text-to-avatar.js';
import { buildMeshForgeTool } from './tools/mesh-forge.js';
import { buildForgeFreeTool } from './tools/forge-free.js';
import { buildRigMeshTool } from './tools/rig-mesh.js';
import { buildForgeAvatarTool } from './tools/forge-avatar.js';
import { buildRefineModelTool } from './tools/refine-model.js';
import { buildRestyleMaterialTool } from './tools/restyle-material.js';
import { buildSentimentPulseTool } from './tools/sentiment-pulse.js';
import { buildEnsSnsResolveTool } from './tools/ens-sns-resolve.js';
import { buildAgentDelegateActionTool } from './tools/agent-delegate-action.js';
import { buildAgentHireDiscoverTool } from './tools/agent-hire-discover.js';
import { buildAgentHireTool } from './tools/agent-hire.js';
import { buildAgenCListTasksTool } from './tools/agenc-list-tasks.js';
import { buildAgenCGetTaskTool } from './tools/agenc-get-task.js';
import { buildAgenCGetAgentTool } from './tools/agenc-get-agent.js';
import { buildAixbtIntelTool } from './tools/aixbt-intel.js';
import { buildAixbtProjectsTool } from './tools/aixbt-projects.js';
import { buildCryptoNewsTool } from './tools/crypto-news.js';
import { buildCryptoNewsDigestTool } from './tools/crypto-news-digest.js';
import { buildCryptoNewsArchiveTool } from './tools/crypto-news-archive.js';
import {
	UI_RESOURCE_URI,
	UI_MIME_TYPE,
	UI_RESOURCE_META,
	loadReceiptHtml,
} from './commerce-ui.js';

const SERVER_INSTRUCTIONS =
	'MCP tools from three.ws. Most are paid: each quotes its USDC price in its description, and a call ' +
	'without an x402 payment payload in _meta returns a PaymentRequired structuredContent (v2 MCP ' +
	'transport spec). FOUR tools need no payment, wallet, or API key to start: forge_free generates a ' +
	'textured 3D GLB from a text prompt on the free NVIDIA NIM (Microsoft TRELLIS) lane and returns a ' +
	'GLB URL + three.ws viewer link — use it for zero-cost text→3D — and the crypto-news trio: ' +
	'crypto_news (live headlines from 192 publisher feeds, filterable by category/source/language/search, ' +
	'fully free), crypto_news_digest (the last 1–72h clustered into distinct narratives with stance, ' +
	'tickers, and every covering outlet — the right first call for "what happened in crypto today", fully ' +
	'free), and crypto_news_archive (search 660,000+ articles back to September 2017 by ' +
	'keyword/ticker/date/sentiment/language — stats and trending modes free, search free up to a daily ' +
	'quota then $0.001 USDC per search via x402). ' +
	'Tools cover: free text→3D generation (forge_free), 3D avatar generation (text_to_avatar), ' +
	'text/image-to-3D mesh generation via a Granite-directed model chain (mesh_forge), ' +
	'auto-rigging a GLB into an animation-ready model (rig_mesh), ' +
	'one-call text→rigged-avatar generation that chains mesh generation and auto-rigging with a ' +
	'humanoid gate (forge_avatar), ' +
	'conversational refinement that iterates on a model by describing a change ("make it metallic", ' +
	'"bigger helmet") with a revertable/branchable version lineage (refine_model), ' +
	're-skinning an existing GLB WITHOUT regenerating its mesh — AI PBR restyle from an instruction ' +
	'("make it chrome", "wooden", "cyberpunk neon") or seeded, reproducible colorway variant fan-out from a ' +
	'PBR preset (restyle_material), ' +
	'ENS + SNS name resolution ' +
	'(ens_sns_resolve), agent-to-agent delegation (agent_delegate_action), token sentiment pulse ' +
	'(sentiment_pulse), pose generation (get_pose_seed), Solana token snapshots (pump_snapshot), ' +
	'ERC-8004 agent reputation (agent_reputation), Solana vanity address mining ' +
	'(vanity_grinder) plus a free browse of the premium pre-ground vanity inventory ' +
	'(vanity_premium), and AgenC coordination protocol reads — ' +
	'task discovery, task status + lifecycle, and agent registry lookup ' +
	'(agenc_list_tasks, agenc_get_task, agenc_get_agent), aixbt market ' +
	'intelligence — narrative intel feed and momentum-ranked project scans ' +
	'(aixbt_intel, aixbt_projects), and live agent-to-agent commerce: discover and ' +
	'reputation-rank agents to hire for a task (agent_hire_discover), then hire one ' +
	'end to end — quote the price, settle real USDC via x402, run the remote agent, ' +
	'and return its result plus an inline provenance receipt with hard spend caps ' +
	'(agent_hire).';

// The advertised MCP server version comes straight from package.json so it
// can never drift from the published npm version.
const { version: PKG_VERSION } = createRequire(import.meta.url)('../package.json');

// Every tool builder. Each returns a descriptor
// { name, title, description, inputSchema (Zod shape), annotations, handler }.
// None of these require payment env — the env requirement is deferred to the
// first paid call.
const TOOL_BUILDERS = [
	buildTextToAvatarTool,
	buildMeshForgeTool,
	buildForgeFreeTool,
	buildRigMeshTool,
	buildForgeAvatarTool,
	buildRefineModelTool,
	buildRestyleMaterialTool,
	buildEnsSnsResolveTool,
	buildAgentDelegateActionTool,
	buildAgentHireDiscoverTool,
	buildAgentHireTool,
	buildSentimentPulseTool,
	buildPoseSeedTool,
	buildPumpSnapshotTool,
	buildAgentReputationTool,
	buildVanityGrinderTool,
	buildVanityPremiumTool,
	buildAgenCListTasksTool,
	buildAgenCGetTaskTool,
	buildAgenCGetAgentTool,
	buildAixbtIntelTool,
	buildAixbtProjectsTool,
	buildCryptoNewsTool,
	buildCryptoNewsDigestTool,
	buildCryptoNewsArchiveTool,
];

/**
 * Build every tool descriptor. Side-effect-free w.r.t. payment env and the
 * stdio transport — safe to call from tests to enumerate the tool surface.
 *
 * @returns {Promise<Array<{name:string,title:string,description:string,inputSchema:object,annotations:object,handler:Function}>>}
 */
export async function buildTools() {
	return Promise.all(TOOL_BUILDERS.map((build) => build()));
}

/**
 * Construct and return a fully-registered McpServer WITHOUT connecting any
 * transport and WITHOUT requiring runtime payment env. Tool registration
 * (names/descriptions/schemas) works with no secrets; only an actual paid tool
 * invocation requires MCP_SVM_PAYMENT_ADDRESS.
 *
 * @returns {Promise<McpServer>}
 */
export async function buildServer() {
	const server = new McpServer(
		{
			// Stable MCP identity — matches the bin name and the registry
			// mcpName suffix (io.github.nirholas/3d-agent-mcp). Deliberately
			// NOT derived from the scoped npm package name.
			name: '3d-agent-mcp',
			version: PKG_VERSION,
		},
		{
			// Declare full tools capability so clients on the strict MCP 2025-06-18
			// spec know we don't push tools/list_changed notifications (our tool
			// surface is fixed per-process). `resources` is declared because
			// agent_hire ships an MCP Apps UI resource (the provenance receipt
			// card). `logging` stays undeclared — we ship no logging API.
			capabilities: {
				tools: { listChanged: false },
				resources: { listChanged: false },
			},
			instructions: SERVER_INSTRUCTIONS,
		},
	);

	const tools = await buildTools();
	for (const t of tools) {
		server.registerTool(
			t.name,
			{
				title: t.title,
				description: t.description,
				inputSchema: t.inputSchema,
				// MCP ToolAnnotations (readOnlyHint / destructiveHint /
				// idempotentHint / openWorldHint) — lets clients gate
				// confirmation prompts per tool instead of treating every call
				// as a destructive write.
				annotations: t.annotations,
				// Optional tool-level _meta (e.g. MCP Apps _meta.ui.resourceUri,
				// which links agent_hire to its inline provenance receipt card).
				...(t._meta ? { _meta: t._meta } : {}),
			},
			t.handler,
		);
	}

	// MCP Apps UI resource: the agent_hire provenance receipt card the host
	// renders in a sandboxed iframe. agent_hire links to it via
	// _meta.ui.resourceUri; the resource carries the sandbox CSP grant.
	server.registerResource(
		'hire-receipt',
		UI_RESOURCE_URI,
		{
			title: 'Agent hire receipt',
			description: 'Inline provenance receipt rendered by agent_hire.',
			mimeType: UI_MIME_TYPE,
			_meta: UI_RESOURCE_META,
		},
		async (uri) => ({
			contents: [
				{
					uri: uri.href ?? UI_RESOURCE_URI,
					mimeType: UI_MIME_TYPE,
					text: loadReceiptHtml(),
					_meta: UI_RESOURCE_META,
				},
			],
		}),
	);

	return server;
}

/**
 * Connect the server to stdio. Runs only as the process entry point. Eagerly
 * warms the shared x402 resource server so the first paid call doesn't pay the
 * /supported fetch cost, then connects the StdioServerTransport.
 */
async function main() {
	// Fail fast: a running server that can't receive payments is useless. This
	// is the ONLY startup env gate — it does not run during buildServer()/tests.
	assertPaymentEnv();

	// Force the shared x402 resource server to initialize before any tool is
	// invoked — this fetches /supported from each facilitator so verify + settle
	// don't pay that cost on the first paid call.
	await getResourceServer();
	const initErr = getLastFacilitatorInitError();
	if (initErr) {
		console.error(`[mcp-server] facilitator init returned warnings: ${initErr.message}`);
	}

	const server = await buildServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	// Log to stderr so the stdout channel stays clean for MCP JSON-RPC frames.
	console.error('[mcp-server] ready — paid tools registered over stdio');
}

// Run the stdio boot ONLY when this file is the process entry point. Importing
// the module for tests (or to reuse buildServer/buildTools) must NOT connect a
// transport or require payment env.
//
// The entry path is compared both directly and via its realpath: when launched
// through the npm bin (`node_modules/.bin/3d-agent-mcp`, a symlink to this file),
// process.argv[1] is the symlink while import.meta.url is the resolved target —
// so a direct compare alone would wrongly treat the bin launch as "imported" and
// never start the server.
function isProcessEntryPoint() {
	const argvPath = process.argv[1];
	if (!argvPath) return false;
	if (import.meta.url === pathToFileURL(argvPath).href) return true;
	try {
		return import.meta.url === pathToFileURL(realpathSync(argvPath)).href;
	} catch {
		return false;
	}
}
const isEntryPoint = isProcessEntryPoint();

if (isEntryPoint) {
	main().catch((err) => {
		// One clean, actionable line to stderr — never a raw multi-line stack.
		console.error(`mcp-server: ${err?.message || err}`);
		process.exit(1);
	});
}
