#!/usr/bin/env node
// A complete MCP server whose tools charge per call in USDC on Solana over x402.
//
// Run it:
//   X402_PAY_TO_SOLANA=<your-solana-address> node src/index.js
//
// Wire it into a client:
//   claude mcp add model-inspect --env X402_PAY_TO_SOLANA=<addr> -- node /abs/path/src/index.js
//
// Inspect it:
//   npm run inspect
//
// The full walkthrough lives at https://three.ws/tutorials/monetize-mcp-server

import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { assertPaymentEnv, getFacilitatorInitError, getResourceServer } from './payments.js';
import { buildGettingStartedTool, buildInspectModelTool, PAID_TOOL_NAME, PAID_TOOL_PRICE } from './tools.js';

const SERVER_INSTRUCTIONS =
	'A pay-per-call 3D model inspector. Call getting_started (free) for prices and the payment flow. ' +
	`Call ${PAID_TOOL_NAME} (${PAID_TOOL_PRICE} in USDC on Solana) with a public glTF or GLB URL to get a ` +
	'structural report and prioritized optimization findings. An unpaid call returns a PaymentRequired ' +
	'envelope quoting the exact price; x402-capable clients pay and retry automatically.';

/**
 * Build the registered server without connecting a transport.
 * Registration touches no secrets, so tests can enumerate tools with no env set.
 */
export function buildServer() {
	const server = new McpServer(
		{ name: 'paid-mcp-server', version: '0.1.0' },
		{ capabilities: { tools: { listChanged: false } }, instructions: SERVER_INSTRUCTIONS },
	);

	for (const tool of [buildGettingStartedTool(), buildInspectModelTool()]) {
		server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: tool.inputSchema,
				annotations: tool.annotations,
			},
			tool.handler,
		);
	}

	return server;
}

async function main() {
	try {
		assertPaymentEnv();
	} catch (err) {
		console.error(`[paid-mcp-server] configuration error: ${err.message}`);
		process.exit(1);
		return;
	}

	// Warm the resource server so the first sale does not pay the facilitator
	// handshake cost inside the caller's request.
	await getResourceServer();
	const initErr = getFacilitatorInitError();
	if (initErr) console.error(`[paid-mcp-server] facilitator warning: ${initErr.message}`);

	const server = buildServer();
	await server.connect(new StdioServerTransport());
	console.error(`[paid-mcp-server] ready over stdio: 1 free tool, 1 paid tool at ${PAID_TOOL_PRICE}`);
}

// Launched through a bin symlink, process.argv[1] is the link while import.meta.url
// is the resolved target, so compare both forms.
function isEntryPoint() {
	const argvPath = process.argv[1];
	if (!argvPath) return false;
	if (import.meta.url === pathToFileURL(argvPath).href) return true;
	try {
		return import.meta.url === pathToFileURL(realpathSync(argvPath)).href;
	} catch {
		return false;
	}
}

if (isEntryPoint()) {
	main().catch((err) => {
		console.error(`paid-mcp-server: ${err?.message || err}`);
		process.exit(1);
	});
}
