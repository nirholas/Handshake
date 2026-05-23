// `agenc_get_agent` — paid MCP tool that looks up an AgenC agent's on-chain
// registration. Returns capability bitmask, status, endpoint, reputation,
// stake, and active-task count.
//
// Pricing: $0.001 USDC, settled `exact` on Base or Solana.

import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { deriveAgentPda, getAgent } from '@tetsuo-ai/sdk';

import { paid } from '../payments.js';
import {
	getAgenCClient,
	parsePubkey,
	serializeBigInts,
	agentStatusLabel,
} from './agenc-client.js';

const TOOL_NAME = 'agenc_get_agent';
const TOOL_DESCRIPTION =
	'Look up an AgenC agent\'s on-chain registration. Pass either agentPda (the derived account address) OR agentId (32-byte hex, "0x"-prefixed hex, or any UTF-8 label which is hashed via SHA-256). Returns the agent\'s authority wallet, capability bitmask, endpoint URL, status, reputation, stake, and active task count. AgenC = agenc.tech (Tetsuo Corp). Paid: $0.001 USDC.';

function resolveAgentId(input) {
	const s = String(input).trim();
	if (s.startsWith('0x') || s.startsWith('0X')) {
		const hex = s.slice(2);
		if (hex.length !== 64) throw new Error('hex agentId must be 32 bytes');
		return Uint8Array.from(Buffer.from(hex, 'hex'));
	}
	if (/^[0-9a-fA-F]{64}$/.test(s)) {
		return Uint8Array.from(Buffer.from(s, 'hex'));
	}
	return Uint8Array.from(createHash('sha256').update(s, 'utf8').digest());
}

const inputJsonSchema = {
	type: 'object',
	properties: {
		agentPda: {
			type: 'string',
			description: 'Base58 agent account PDA. Mutually exclusive with agentId.',
			minLength: 32,
			maxLength: 44,
		},
		agentId: {
			type: 'string',
			description: '32-byte agent id as 64-char hex, "0x"-prefixed hex, or any UTF-8 label (SHA-256 hashed).',
			minLength: 1,
			maxLength: 256,
		},
		cluster: {
			type: 'string',
			enum: ['mainnet', 'devnet'],
			description: 'Solana cluster. Defaults to mainnet.',
		},
	},
	additionalProperties: false,
};

const inputZodShape = {
	agentPda: z.string().min(32).max(44).optional(),
	agentId: z.string().min(1).max(256).optional(),
	cluster: z.enum(['mainnet', 'devnet']).optional(),
};

export async function buildAgenCGetAgentTool() {
	const handler = await paid(
		{
			toolName: TOOL_NAME,
			description: TOOL_DESCRIPTION,
			scheme: 'exact',
			priceUsd: '$0.001',
			inputSchema: inputJsonSchema,
			example: { agentId: 'my-three-ws-bot', cluster: 'devnet' },
			outputExample: {
				ok: true,
				cluster: 'devnet',
				agentPda: '7p…',
				agent: {
					agentId: 'a3…',
					authority: '5y…',
					capabilities: '1',
					status: 'Active',
					endpoint: 'https://three.ws/agents/my-bot',
					reputation: 0,
					stakeAmount: '1000000',
					activeTasks: 0,
					registeredAt: 1716000000,
				},
			},
		},
		async ({ agentPda, agentId, cluster }) => {
			const client = getAgenCClient(cluster);
			let pda;
			if (agentPda) {
				pda = parsePubkey(agentPda, 'agentPda');
			} else if (agentId) {
				pda = deriveAgentPda(resolveAgentId(agentId), client.programId);
			} else {
				return {
					ok: false,
					error: 'missing_input',
					message: 'Provide either agentPda or agentId.',
				};
			}

			const agent = await getAgent(client.program, pda);
			if (!agent) {
				return serializeBigInts({
					ok: false,
					error: 'not_found',
					cluster: client.cluster,
					programId: client.programId.toBase58(),
					agentPda: pda.toBase58(),
					message: 'no agent account at that PDA on this cluster',
				});
			}

			return serializeBigInts({
				ok: true,
				cluster: client.cluster,
				rpcUrl: client.rpcUrl,
				programId: client.programId.toBase58(),
				agentPda: pda.toBase58(),
				agent: {
					agentId: Buffer.from(agent.agentId).toString('hex'),
					authority: agent.authority.toBase58(),
					capabilities: agent.capabilities.toString(),
					status: agentStatusLabel(agent.status),
					statusRaw: typeof agent.status === 'number' ? agent.status : null,
					endpoint: agent.endpoint,
					metadataUri: agent.metadataUri,
					stakeAmount: agent.stakeAmount.toString(),
					activeTasks: agent.activeTasks,
					reputation: agent.reputation,
					registeredAt: agent.registeredAt,
				},
				fetchedAt: new Date().toISOString(),
			});
		},
	);
	return {
		name: TOOL_NAME,
		title: 'AgenC get agent ($0.001)',
		description: TOOL_DESCRIPTION,
		inputSchema: inputZodShape,
		handler,
	};
}
