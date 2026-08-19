#!/usr/bin/env node
// @three-ws/metaplex-agent-mcp: MCP server entry point.
//
// Deploy AI agents on-chain into the Metaplex Agent Registry on Solana, the
// exact way the three.ws Genesis 333 shipped:
//   • mint_onchain_agent      : atomic mint + register, signed by the agent's own key
//   • prepare_agent_mint      : the same tx built for Phantom/Solflare/any wallet to sign
//   • send_signed_transaction : broadcast a wallet-signed tx and confirm it
//   • register_agent_identity : enrol an already-minted Core asset
//   • get_onchain_agent       : read any registered agent (asset, docs, wallet)
//   • agent_wallet            : an agent's built-in wallet (Asset Signer PDA) + balance
//   • build_registration      : the EIP-8004 document + data: URI, offline
//   • list_onchain_agents     : the live registration feed
//
// Self-custodial: mints are signed by YOUR key (SOLANA_SECRET_KEY) or your own
// browser wallet via prepare/send. The read tools and the wallet flow need no
// key at all. Real Metaplex programs on real Solana; nothing is mocked.
//
// Run standalone:
//   SOLANA_SECRET_KEY=<base58> node packages/metaplex-agent-mcp/src/index.js
//
// Or wire into Claude Code / Cursor: see README.md.

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { def as mintOnchainAgent } from './tools/mint-onchain-agent.js';
import { def as prepareAgentMint } from './tools/prepare-agent-mint.js';
import { def as sendSignedTransaction } from './tools/send-signed-transaction.js';
import { def as registerAgentIdentity } from './tools/register-agent-identity.js';
import { def as getOnchainAgent } from './tools/get-onchain-agent.js';
import { def as agentWallet } from './tools/agent-wallet.js';
import { def as buildRegistration } from './tools/build-registration.js';
import { def as listOnchainAgents } from './tools/list-onchain-agents.js';

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json');

export const TOOLS = [
	mintOnchainAgent,
	prepareAgentMint,
	sendSignedTransaction,
	registerAgentIdentity,
	getOnchainAgent,
	agentWallet,
	buildRegistration,
	listOnchainAgents,
];

/**
 * Construct a fully-registered McpServer without connecting a transport or
 * requiring a signer. Registration is env-free; only the signing tools need
 * SOLANA_SECRET_KEY. Safe to import from tests.
 * @returns {McpServer}
 */
export function buildServer() {
	const server = new McpServer(
		{ name: 'metaplex-agent-mcp', title: 'Metaplex Agent Registry', version: PKG_VERSION },
		{
			capabilities: { tools: {} },
			instructions:
				'Metaplex Agent Registry MCP by three.ws: put an AI agent on-chain on Solana with its own wallet, ' +
				'identity, and reputation surface, Genesis-333 style. mint_onchain_agent is the self-custody path ' +
				'(one atomic tx, signed by SOLANA_SECRET_KEY, ~0.007 SOL, gated by confirm:true). prepare_agent_mint ' +
				'+ send_signed_transaction are the SAME mint for a human wallet (Phantom, Solflare, anything) with ' +
				'no key configured. register_agent_identity enrols an existing Core asset. get_onchain_agent, ' +
				'agent_wallet, build_registration, and list_onchain_agents are read-only. Every Core plugin and ' +
				'metadata field is customizable; the defaults reproduce the three.ws Genesis mint shape exactly.',
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
	console.error(`[metaplex-agent-mcp@${PKG_VERSION}] connected over stdio with ${TOOLS.length} tools`);
}

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
		console.error('[metaplex-agent-mcp] fatal:', err);
		process.exit(1);
	});
}
