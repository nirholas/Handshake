#!/usr/bin/env node
// @3d-agent/mcp-server entry point.
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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { getLastFacilitatorInitError, getResourceServer } from './payments.js';
import { buildPoseSeedTool } from './tools/pose-seed.js';
import { buildPumpSnapshotTool } from './tools/pump-snapshot.js';
import { buildAgentReputationTool } from './tools/agent-reputation.js';
import { buildVanityGrinderTool } from './tools/vanity-grinder.js';
import { buildTextToAvatarTool } from './tools/text-to-avatar.js';
import { buildRenderAvatarClipTool } from './tools/render-avatar-clip.js';
import { buildTtsSpeakTool } from './tools/tts-speak.js';
import { buildOptimizeGlbTool } from './tools/optimize-glb.js';
import { buildSentimentPulseTool } from './tools/sentiment-pulse.js';
import { buildEnsSnsResolveTool } from './tools/ens-sns-resolve.js';
import { buildAgentDelegateActionTool } from './tools/agent-delegate-action.js';
import { buildAgenCListTasksTool } from './tools/agenc-list-tasks.js';
import { buildAgenCGetTaskTool } from './tools/agenc-get-task.js';
import { buildAgenCGetAgentTool } from './tools/agenc-get-agent.js';

async function main() {
	// Force the shared x402 resource server to initialize before any tool is
	// registered — this fetches /supported from each facilitator so verify
	// + settle don't pay that cost on the first paid call.
	await getResourceServer();
	const initErr = getLastFacilitatorInitError();
	if (initErr) {
		console.error(`[mcp-server] facilitator init returned warnings: ${initErr.message}`);
	}

	const server = new McpServer({
		name: '3d-agent-mcp',
		version: '1.0.0',
	}, {
		// Declare full tools capability so clients on the strict MCP 2025-06-18
		// spec know we don't push tools/list_changed notifications (our tool
		// surface is fixed per-process). `resources` + `logging` left
		// undeclared because we don't ship resource or logging APIs over this
		// transport; declaring them empty would mislead clients into calling
		// resources/list and getting a method-not-found.
		capabilities: { tools: { listChanged: false } },
		instructions:
			'Paid x402 MCP tools from three.ws. Each tool quotes its USDC price in its description. ' +
			'Tool calls without an x402 payment payload in _meta return a PaymentRequired structuredContent ' +
			'(v2 MCP transport spec). Tools cover: 3D avatar generation (text_to_avatar), server-side ' +
			'avatar rendering with pose + camera (render_avatar_clip), GLB transcoding/draco/texture ' +
			'compression (optimize_glb), text-to-speech (tts_speak), ENS + SNS name resolution ' +
			'(ens_sns_resolve), agent-to-agent delegation (agent_delegate_action), token sentiment pulse ' +
			'(sentiment_pulse), pose generation (get_pose_seed), Solana token snapshots (pump_snapshot), ' +
			'ERC-8004 agent reputation (agent_reputation), Solana vanity address mining ' +
			'(vanity_grinder, upto-priced), and AgenC coordination protocol reads — ' +
			'task discovery, task status + lifecycle, and agent registry lookup ' +
			'(agenc_list_tasks, agenc_get_task, agenc_get_agent).',
	});

	const tools = await Promise.all([
		buildTextToAvatarTool(),
		buildRenderAvatarClipTool(),
		buildOptimizeGlbTool(),
		buildTtsSpeakTool(),
		buildEnsSnsResolveTool(),
		buildAgentDelegateActionTool(),
		buildSentimentPulseTool(),
		buildPoseSeedTool(),
		buildPumpSnapshotTool(),
		buildAgentReputationTool(),
		buildVanityGrinderTool(),
		buildAgenCListTasksTool(),
		buildAgenCGetTaskTool(),
		buildAgenCGetAgentTool(),
	]);

	for (const t of tools) {
		server.registerTool(
			t.name,
			{
				title: t.title,
				description: t.description,
				inputSchema: t.inputSchema,
			},
			t.handler,
		);
	}

	const transport = new StdioServerTransport();
	await server.connect(transport);
	// Log to stderr so the stdout channel stays clean for MCP JSON-RPC frames.
	console.error(`[mcp-server] ready — ${tools.length} paid tools registered over stdio`);
}

main().catch((err) => {
	console.error(`[mcp-server] fatal: ${err.stack || err.message || err}`);
	process.exit(1);
});
