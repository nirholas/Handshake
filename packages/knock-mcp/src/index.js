#!/usr/bin/env node
// @three-ws/knock-mcp: let an agent reach a real person.
//
// Knock is a priced door to a human. Every three.ws account can publish one at
// three.ws/knock/<handle>; paying its price buys exactly one message through,
// and that message is delivered in person: the recipient's 3D companion walks
// on screen wherever they are on the site and says who is at the door and what
// they paid. The USDC settles directly to the recipient.
//
// Tools:
//   knock_quote      what it costs to reach one person (public)
//   knock_directory  everyone reachable right now, cheapest first (public)
//   knock_send       get one message through (free doors send, priced doors quote)
//   knock_receipt    what became of a knock you sent (public, receipt-scoped)
//   knock_inbox      the knocks YOUR door has taken (needs THREE_WS_API_KEY)
//   knock_act        reply to, dismiss, or block one of them (needs THREE_WS_API_KEY)
//
// THIS SERVER HOLDS NO WALLET AND CANNOT SPEND. On a priced door, knock_send
// returns the recipient, the amount, the token and the chain and stops, so the
// decision to pay stays with the human and the payment happens in the wallet
// they already control. That is deliberate, not a missing feature.
//
// Run standalone:
//   node packages/knock-mcp/src/index.js
//
// Or wire into Claude Code / Cursor. See README.md.

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { def as quote } from './tools/quote.js';
import { def as directory } from './tools/directory.js';
import { def as send } from './tools/send.js';
import { def as receipt } from './tools/receipt.js';
import { def as inbox } from './tools/inbox.js';
import { def as act } from './tools/act.js';

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json');

export const TOOLS = [quote, directory, send, receipt, inbox, act];

/**
 * Build the fully-registered server without connecting a transport.
 * Registration is env-free, so tests can import this without a credential.
 * @returns {McpServer}
 */
export function buildServer() {
	const server = new McpServer(
		{ name: 'knock-mcp', title: 'three.ws Knock', version: PKG_VERSION },
		{
			capabilities: { tools: {} },
			instructions:
				'three.ws Knock MCP: a priced door to a real person. knock_quote reads what one person charges ' +
				'for a single message and which chains they take it on; knock_directory lists everyone ' +
				'reachable, cheapest first. knock_send gets one message through, which lands in their inbox ' +
				'AND is delivered out loud by their 3D companion, naming the sender and the amount. This ' +
				'server holds no wallet: a free door sends immediately, and a priced door returns the ' +
				'recipient, amount, token and chain so a HUMAN can approve the spend and pay from their own ' +
				'x402 client (npx @three-ws/knock). Never present a paid knock as sent until a payment ' +
				'settled. knock_receipt reads what became of a knock using the receipt URL it returned, with ' +
				'no account. knock_inbox and knock_act manage your OWN door and need THREE_WS_API_KEY; they ' +
				'are account-scoped server-side and can never touch another account. $THREE is the only coin.',
		},
	);

	for (const tool of TOOLS) {
		server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: tool.inputSchema,
				annotations: tool.annotations,
			},
			async (args, extra) => {
				try {
					const result = await tool.handler(args, extra);
					const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
					return { content: [{ type: 'text', text }], isError: result?.ok === false };
				} catch (err) {
					const payload = {
						ok: false,
						error: err?.code || 'unhandled',
						message: err?.message || String(err),
						...(err?.status ? { status: err.status } : {}),
						...(err?.body ? { detail: err.body } : {}),
					};
					return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
				}
			},
		);
	}

	return server;
}

async function main() {
	const server = buildServer();
	await server.connect(new StdioServerTransport());
	console.error(`[knock-mcp@${PKG_VERSION}] connected over stdio with ${TOOLS.length} tools`);
}

// Connect stdio ONLY when this file is the process entry point, so importing
// the module (tests, embedding) never grabs the transport. realpath both sides:
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
	main().catch((err) => {
		console.error('[knock-mcp] fatal:', err);
		process.exit(1);
	});
}
