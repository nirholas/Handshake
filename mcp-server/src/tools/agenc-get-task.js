// `agenc_get_task` — paid MCP tool that fetches the current state and lifecycle
// timeline of a single AgenC task. Useful for any agent that wants to decide
// whether to bid/claim, or for monitoring an in-flight job.
//
// Pricing: $0.001 USDC, settled `exact` on Base or Solana.

import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import {
	deriveTaskPda,
	getTask,
	getTaskLifecycleSummary,
} from '@tetsuo-ai/sdk';

import { paid } from '../payments.js';
import {
	getAgenCClient,
	parsePubkey,
	serializeBigInts,
	taskStateLabel,
} from './agenc-client.js';

const TOOL_NAME = 'agenc_get_task';
const TOOL_DESCRIPTION =
	'Fetch the on-chain state and lifecycle timeline of a single AgenC task. Pass either taskPda (the derived account address) OR the {creator, taskId} pair, where taskId may be a 64-char hex string or any UTF-8 label (hashed to 32 bytes). Returns state, reward, deadline, worker counts, lifecycle events, and reward mint. AgenC = agenc.tech (Tetsuo Corp). Paid: $0.001 USDC.';

function resolveTaskId(input) {
	const s = String(input).trim();
	if (s.startsWith('0x') || s.startsWith('0X')) {
		const hex = s.slice(2);
		if (hex.length !== 64) throw new Error('hex taskId must be 32 bytes');
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
		taskPda: {
			type: 'string',
			description: 'Base58 task account PDA. If omitted, supply creator + taskId.',
			minLength: 32,
			maxLength: 44,
		},
		creator: {
			type: 'string',
			description: 'Base58 task creator wallet (required if taskPda is omitted).',
			minLength: 32,
			maxLength: 44,
		},
		taskId: {
			type: 'string',
			description: '32-byte task id as 64-char hex, "0x"-prefixed hex, or any UTF-8 label (hashed via SHA-256).',
			minLength: 1,
			maxLength: 256,
		},
		cluster: {
			type: 'string',
			enum: ['mainnet', 'devnet'],
			description: 'Solana cluster. Defaults to mainnet.',
		},
		includeLifecycle: {
			type: 'boolean',
			description: 'When true (default), include the lifecycle event timeline. Set false for a cheaper read.',
		},
	},
	additionalProperties: false,
};

const inputZodShape = {
	taskPda: z.string().min(32).max(44).optional(),
	creator: z.string().min(32).max(44).optional(),
	taskId: z.string().min(1).max(256).optional(),
	cluster: z.enum(['mainnet', 'devnet']).optional(),
	includeLifecycle: z.boolean().optional(),
};

export async function buildAgenCGetTaskTool() {
	const handler = await paid(
		{
			toolName: TOOL_NAME,
			description: TOOL_DESCRIPTION,
			scheme: 'exact',
			priceUsd: '$0.001',
			inputSchema: inputJsonSchema,
			example: { taskPda: '8xQ…', cluster: 'devnet' },
			outputExample: {
				ok: true,
				cluster: 'devnet',
				taskPda: '8xQ…',
				task: {
					taskId: 'a1b2…',
					state: 'Claimed',
					rewardAmount: '50000000',
					currentWorkers: 1,
					maxWorkers: 1,
				},
				lifecycle: {
					timeline: [{ eventName: 'created', timestamp: 1716000000 }],
				},
			},
		},
		async ({ taskPda, creator, taskId, cluster, includeLifecycle }) => {
			const client = getAgenCClient(cluster);
			let pda;
			if (taskPda) {
				pda = parsePubkey(taskPda, 'taskPda');
			} else {
				if (!creator || !taskId) {
					return {
						ok: false,
						error: 'missing_input',
						message: 'Provide either taskPda OR both creator and taskId.',
					};
				}
				pda = deriveTaskPda(
					parsePubkey(creator, 'creator'),
					resolveTaskId(taskId),
					client.programId,
				);
			}

			const task = await getTask(client.program, pda);
			if (!task) {
				return serializeBigInts({
					ok: false,
					error: 'not_found',
					cluster: client.cluster,
					programId: client.programId.toBase58(),
					taskPda: pda.toBase58(),
					message: 'no task account at that PDA on this cluster',
				});
			}
			const taskOut = {
				taskId: Buffer.from(task.taskId).toString('hex'),
				state: taskStateLabel(task.state),
				stateRaw: typeof task.state === 'number' ? task.state : null,
				creator: task.creator.toBase58(),
				rewardAmount: task.rewardAmount.toString(),
				rewardMint: task.rewardMint ? task.rewardMint.toBase58() : null,
				deadline: task.deadline,
				currentWorkers: task.currentWorkers,
				maxWorkers: task.maxWorkers,
				completedAt: task.completedAt,
				constraintHash: task.constraintHash
					? Buffer.from(task.constraintHash).toString('hex')
					: null,
				private: task.constraintHash != null,
			};

			let lifecycleOut = null;
			if (includeLifecycle !== false) {
				const lifecycle = await getTaskLifecycleSummary(client.program, pda);
				if (lifecycle) {
					lifecycleOut = {
						currentState: taskStateLabel(lifecycle.currentState),
						createdAt: lifecycle.createdAt,
						currentWorkers: lifecycle.currentWorkers,
						maxWorkers: lifecycle.maxWorkers,
						timeline: lifecycle.timeline.map((e) => ({
							eventName: e.eventName,
							timestamp: e.timestamp,
							txSignature: e.txSignature ?? null,
							actor: e.actor ? e.actor.toBase58() : null,
						})),
					};
				}
			}

			return serializeBigInts({
				ok: true,
				cluster: client.cluster,
				rpcUrl: client.rpcUrl,
				programId: client.programId.toBase58(),
				taskPda: pda.toBase58(),
				task: taskOut,
				lifecycle: lifecycleOut,
				fetchedAt: new Date().toISOString(),
			});
		},
	);
	return {
		name: TOOL_NAME,
		title: 'AgenC get task ($0.001)',
		description: TOOL_DESCRIPTION,
		inputSchema: inputZodShape,
		handler,
	};
}
