#!/usr/bin/env node
// @three-ws/onchain-agent-wallets: MCP server entry point.
//
// Give an AI agent a real Solana wallet without giving it your money.
//
// The owner's wallet holds the funds. Each agent gets a vault token account the
// owner owns, plus a capped SPL Token delegation over it. The token program
// enforces the ceiling on-chain; this server enforces the owner's finer rules
// (per-transaction cap, rolling daily cap, recipient and host allowlists,
// expiry, pause, confirm-above threshold) before it signs anything.
//
//   Custody      create_agent_wallet, fund_agent_wallet, approve_agent_allowance,
//                withdraw_from_vault, revoke_agent_wallet
//   Guardrails   set_guardrails
//   Spending     agent_pay, pay_x402
//   Visibility   agent_wallet_status, list_agent_wallets, spend_log
//   Deployment   deploy_agent_onchain, export_agent_runtime
//   Wallet lane  send_signed_transaction
//
// Nothing is mocked: real SPL Token delegations, real Solana, real x402
// settlement. Devnet works end to end for free rehearsal (OAW_NETWORK=devnet).
//
// Run standalone:
//   OWNER_SECRET_KEY=<base58> node src/index.js
//
// Or wire into Claude Code / Cursor: see README.md.

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { NETWORK } from './config.js';

import { def as createAgentWallet } from './tools/create-agent-wallet.js';
import { def as fundAgentWallet } from './tools/fund-agent-wallet.js';
import { def as approveAgentAllowance } from './tools/approve-agent-allowance.js';
import { def as setGuardrails } from './tools/set-guardrails.js';
import { def as agentPay } from './tools/agent-pay.js';
import { def as payX402 } from './tools/pay-x402.js';
import { def as withdrawFromVault } from './tools/withdraw-from-vault.js';
import { def as revokeAgentWallet } from './tools/revoke-agent-wallet.js';
import { def as agentWalletStatus } from './tools/agent-wallet-status.js';
import { def as listAgentWallets } from './tools/list-agent-wallets.js';
import { def as spendLog } from './tools/spend-log.js';
import { def as deployAgentOnchain } from './tools/deploy-agent-onchain.js';
import { def as exportAgentRuntime } from './tools/export-agent-runtime.js';
import { def as sendSignedTransaction } from './tools/send-signed-transaction.js';

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json');

export const TOOLS = [
	createAgentWallet,
	fundAgentWallet,
	approveAgentAllowance,
	setGuardrails,
	agentPay,
	payX402,
	withdrawFromVault,
	revokeAgentWallet,
	agentWalletStatus,
	listAgentWallets,
	spendLog,
	deployAgentOnchain,
	exportAgentRuntime,
	sendSignedTransaction,
];

/**
 * Construct a fully-registered McpServer without connecting a transport or
 * requiring a key. Registration is env-free; only signing needs material.
 * Safe to import from tests.
 * @returns {McpServer}
 */
export function buildServer() {
	const server = new McpServer(
		{ name: 'onchain-agent-wallets', title: 'Onchain Agent Wallets', version: PKG_VERSION },
		{
			capabilities: { tools: {} },
			instructions:
				'Onchain agent wallets on Solana, by three.ws. The owner keeps custody: funds sit in a vault token ' +
				'account the OWNER owns, and the agent holds only a capped SPL Token delegation over it, which the token ' +
				'program enforces and the owner can revoke in one instruction. create_agent_wallet sets this up in one ' +
				'call; fund_agent_wallet backs it; set_guardrails adds per-transaction, daily, recipient, host, expiry, ' +
				'and pause rules on top; agent_pay and pay_x402 are how the agent spends inside them; ' +
				'revoke_agent_wallet is the kill switch. Every value-moving tool shows a summary first and refuses to ' +
				'broadcast without confirm:true. If no owner key is configured, owner actions come back as an unsigned ' +
				'transaction for Phantom, Solflare, Backpack, or a Ledger to sign, then send_signed_transaction ' +
				'broadcasts it, so a secret key never has to touch this machine. When a spend is refused, the error ' +
				'names the exact rule and what the owner would have to change.',
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
						// Guardrail refusals carry their full reasoning so the caller
						// can see which rule stopped it rather than guessing.
						...(err?.checks ? { checks: err.checks } : {}),
						...(err?.policy ? { guardrails: err.policy } : {}),
						...(err?.spendable ? { spendable: err.spendable } : {}),
						...(err?.spent_24h ? { spent_24h: err.spent_24h } : {}),
						...(err?.signature ? { signature: err.signature } : {}),
						...(err?.link ? { link: err.link } : {}),
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
	console.error(
		`[onchain-agent-wallets@${PKG_VERSION}] connected over stdio with ${TOOLS.length} tools on ${NETWORK}`,
	);
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
		console.error('[onchain-agent-wallets] fatal:', err);
		process.exit(1);
	});
}
