#!/usr/bin/env node
// @three-ws/agentcore-payments-mcp — Agent Payment Sessions over MCP.
//
// Implements the governance-first payment pattern:
//   "The agent does not hold a wallet. It proposes spend. Governance enforces policy."
//
// Tools:
//   create_payment_session   — fund a session from credits; get a bearer token
//   pay_with_session         — execute x402 payment via session (no private key)
//   check_payment_session    — inspect budget / status / executions
//   list_payment_sessions    — list sessions + aggregate spend stats
//   cancel_payment_session   — cancel + refund un-spent budget
//
// Two credential types:
//   THREE_WS_SESSION         — your account session for management operations
//   PAYMENT_SESSION_TOKEN    — the session bearer token for agent payments
//
// Run standalone:
//   node packages/agentcore-payments-mcp/src/index.js
//
// Wire into Claude Code / Cursor — see README.md.

import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { def as createSession } from './tools/create-session.js';
import { def as payWithSession } from './tools/pay-with-session.js';
import { def as checkSession } from './tools/check-session.js';
import { def as listSessions } from './tools/list-sessions.js';
import { def as cancelSession } from './tools/cancel-session.js';

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json');

export const TOOLS = [
	createSession,
	payWithSession,
	checkSession,
	listSessions,
	cancelSession,
];

export function buildServer() {
	const server = new McpServer(
		{
			name: 'agentcore-payments-mcp',
			title: 'three.ws Agent Payments',
			version: PKG_VERSION,
		},
		{
			capabilities: { tools: {} },
			instructions:
				'three.ws Agent Payment Sessions — governance-first x402 micropayments for AI agents. ' +
				'No private key required. Create a session with a budget, give the token to an agent, ' +
				'and the agent pays x402 endpoints via pay_with_session. The platform\'s wallet signs ' +
				'all transactions; spend is bounded by your session budget, URL allowlist, and per-tx ceiling. ' +
				'Management operations (create/list/cancel) require THREE_WS_SESSION. ' +
				'Payment execution requires PAYMENT_SESSION_TOKEN (or pass inline to pay_with_session). ' +
				'Workflow: 1) create_payment_session to get a token → 2) pay_with_session to call paid endpoints → ' +
				'3) check_payment_session to monitor spend → 4) cancel_payment_session to reclaim unused budget.',
		},
	);

	for (const tool of TOOLS) {
		server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: tool.inputSchema,
				// MCP ToolAnnotations (readOnlyHint / destructiveHint / idempotentHint /
				// openWorldHint) — lets clients gate confirmation prompts per tool
				// instead of treating every call as a destructive write.
				annotations: tool.annotations,
			},
			async (args, extra) => {
				try {
					const result = await tool.handler(args, extra);
					return {
						content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
					};
				} catch (err) {
					const payload = {
						ok: false,
						error: err?.message ?? 'unknown error',
						code: err?.code ?? 'error',
						...(err?.status ? { status: err.status } : {}),
						...(err?.body ? { detail: err.body } : {}),
					};
					return {
						content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
						isError: true,
					};
				}
			},
		);
	}

	return server;
}

// Connect stdio ONLY when this file is the process entry point. Importing the
// module (tests, embedding) must not grab the transport. realpath both sides:
// npm bin shims are symlinks, so argv[1] may differ from import.meta.url.
function isProcessEntryPoint() {
	if (!process.argv[1]) return false;
	try {
		return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
	} catch {
		return false;
	}
}

if (isProcessEntryPoint()) {
	const server = buildServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
}
