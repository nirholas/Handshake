#!/usr/bin/env node
// @three-ws/billing-mcp — MCP server entry point.
//
// Gives an AI agent programmatic access to its OWN account economics over stdio:
//   • get_billing_summary      — plan tier, quota ceilings, and usage against them
//   • query_usage              — metered usage rolled into an invoice statement
//   • export_billing_history   — that statement as a downloadable CSV
//   • get_receipt              — one itemized receipt (per-charge or per-purchase)
//   • get_fee_info             — the current platform fee rate (public)
//
// Every read hits the live three.ws API (THREE_WS_BASE). The account-scoped reads
// resolve the caller from your three.ws session (THREE_WS_SESSION) and return only
// your data; get_fee_info is public. This server only ever reads — it never signs
// or moves funds.
//
// Run standalone:
//   node packages/billing-mcp/src/index.js
//
// Or wire into Claude Code / Cursor — see README.md.

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { def as getBillingSummary } from './tools/billing-summary.js';
import { def as queryUsage } from './tools/query-usage.js';
import { def as exportBillingHistory } from './tools/export-billing-history.js';
import { def as getReceipt } from './tools/get-receipt.js';
import { def as getFeeInfo } from './tools/fee-info.js';

// Single source of truth for the advertised server version — package.json.
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json');

export const TOOLS = [
	getBillingSummary,
	queryUsage,
	exportBillingHistory,
	getReceipt,
	getFeeInfo,
];

/**
 * Construct a fully-registered McpServer without connecting a transport.
 * Registration is env-free, so this is safe to import from tests.
 * @returns {McpServer}
 */
export function buildServer() {
	const server = new McpServer(
		{ name: 'billing-mcp', title: 'three.ws Billing', version: PKG_VERSION },
		{
			capabilities: { tools: {} },
			instructions:
				'three.ws Billing MCP — an agent’s own account economics, read-only. get_billing_summary returns your ' +
				'plan tier, its quota ceilings, and live usage against them (avatars + storage, agents, MCP tool calls ' +
				'in 24h, LLM calls this month) with a remaining-headroom map. query_usage rolls your metered usage into ' +
				'an invoice statement for a period — per-action line items, totals, and a reconciliation summary; ' +
				'export_billing_history returns the same as a downloadable CSV. get_receipt fetches one itemized ' +
				'receipt, either a per-charge receipt by event_id (with its settlement tx + explorer link) or the ' +
				'signed receipt JSON of a skill purchase by purchase_id. get_fee_info ' +
				'is the public platform fee rate. Every account-scoped read needs THREE_WS_SESSION (your `__Host-sid` ' +
				'cookie); only get_fee_info is public. This server never signs or moves funds — it only reads.',
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
					return { content: [{ type: 'text', text }] };
				} catch (err) {
					const payload = {
						ok: false,
						error: err?.code || 'unhandled',
						message: err?.message || String(err),
						...(err?.status ? { status: err.status } : {}),
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

async function main() {
	const server = buildServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error(`[billing-mcp@${PKG_VERSION}] connected over stdio with ${TOOLS.length} tools`);
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
	main().catch((err) => {
		console.error('[billing-mcp] fatal:', err);
		process.exit(1);
	});
}
