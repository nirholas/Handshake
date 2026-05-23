// `agenc_list_tasks` — paid MCP tool that lists every public AgenC task
// created by a given Solana wallet on the AgenC coordination protocol.
//
// Pricing: $0.001 USDC, settled `exact` on Base or Solana.
//
// AgenC = agenc.tech (Tetsuo Corp). Coordination protocol on Solana. This tool
// surfaces the on-chain task marketplace so any MCP client (Claude Desktop,
// Cursor, three.ws agents) can discover open jobs without standing up Anchor.

import { z } from 'zod';
import { getTasksByCreator } from '@tetsuo-ai/sdk';

import { paid } from '../payments.js';
import {
	getAgenCClient,
	parsePubkey,
	serializeBigInts,
	taskStateLabel,
} from './agenc-client.js';

const TOOL_NAME = 'agenc_list_tasks';
const TOOL_DESCRIPTION =
	'List every public AgenC task created by a given Solana wallet. AgenC (agenc.tech, by Tetsuo Corp) is a Solana coordination protocol where agents bid on, claim, and complete tasks with SOL/SPL escrow and optional zero-knowledge settlement. Returns task PDA, state, reward, deadline, worker counts, and reward mint for each task. Specify cluster="devnet" for the dev cluster (program 6UcJzbT...), otherwise mainnet. Paid: $0.001 USDC.';

const inputJsonSchema = {
	type: 'object',
	properties: {
		creator: {
			type: 'string',
			description: 'Base58 Solana pubkey of the task creator wallet.',
			minLength: 32,
			maxLength: 44,
		},
		cluster: {
			type: 'string',
			enum: ['mainnet', 'devnet'],
			description: 'Solana cluster to query. Defaults to mainnet.',
		},
	},
	required: ['creator'],
	additionalProperties: false,
};

const inputZodShape = {
	creator: z.string().min(32).max(44),
	cluster: z.enum(['mainnet', 'devnet']).optional(),
};

export async function buildAgenCListTasksTool() {
	const handler = await paid(
		{
			toolName: TOOL_NAME,
			description: TOOL_DESCRIPTION,
			scheme: 'exact',
			priceUsd: '$0.001',
			inputSchema: inputJsonSchema,
			example: {
				creator: '5yC9BM8KUsJTPbWPLfA2N8qH1s9V8DQ3Vcw1G6Jdpump',
				cluster: 'devnet',
			},
			outputExample: {
				ok: true,
				cluster: 'devnet',
				programId: '6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab',
				creator: '5yC9BM8KUsJTPbWPLfA2N8qH1s9V8DQ3Vcw1G6Jdpump',
				count: 1,
				tasks: [
					{
						taskId: '11d3...',
						state: 'Open',
						rewardAmount: '50000000',
						rewardMint: null,
						deadline: 1716508800,
						currentWorkers: 0,
						maxWorkers: 1,
					},
				],
			},
		},
		async ({ creator, cluster }) => {
			const creatorPk = parsePubkey(creator, 'creator');
			const client = getAgenCClient(cluster);
			const tasks = await getTasksByCreator(client.program, creatorPk);
			const rows = tasks.map((t) => ({
				taskId: Buffer.from(t.taskId).toString('hex'),
				state: taskStateLabel(t.state),
				stateRaw: typeof t.state === 'number' ? t.state : null,
				rewardAmount: t.rewardAmount.toString(),
				rewardMint: t.rewardMint ? t.rewardMint.toBase58() : null,
				deadline: t.deadline,
				currentWorkers: t.currentWorkers,
				maxWorkers: t.maxWorkers,
				completedAt: t.completedAt,
				constraintHash: t.constraintHash
					? Buffer.from(t.constraintHash).toString('hex')
					: null,
			}));
			return serializeBigInts({
				ok: true,
				cluster: client.cluster,
				rpcUrl: client.rpcUrl,
				programId: client.programId.toBase58(),
				creator: creatorPk.toBase58(),
				count: rows.length,
				tasks: rows,
				fetchedAt: new Date().toISOString(),
			});
		},
	);
	return {
		name: TOOL_NAME,
		title: 'AgenC list tasks ($0.001)',
		description: TOOL_DESCRIPTION,
		inputSchema: inputZodShape,
		handler,
	};
}
