// Public AgenC bridge endpoints — free reads of the AgenC coordination
// protocol (agenc.tech, by Tetsuo Corp) so three.ws frontends and external
// agents can browse the on-chain task marketplace without standing up an
// Anchor + IDL pipeline of their own.
//
// Routes (all GET unless noted):
//
//   /api/agenc/list-tasks?creator=<base58>&cluster=devnet
//       Returns every task PDA created by `creator`, with state + reward.
//
//   /api/agenc/get-task?taskPda=<base58>&cluster=devnet[&lifecycle=1]
//   /api/agenc/get-task?creator=<base58>&taskId=<hex|label>&cluster=devnet
//       Single task status + (optionally) lifecycle timeline.
//
//   /api/agenc/get-agent?agentPda=<base58>&cluster=devnet
//   /api/agenc/get-agent?agentId=<hex|label>&cluster=devnet
//       Agent registration state.
//
//   /api/agenc/link (POST)
//       body: { erc8004AgentId?, mplCoreAsset?, handle?, cluster? }
//       → { agenCAgentId, agentPda, metadataUri, source, label,
//             registered, agent? }
//       Computes the canonical three.ws → AgenC agentId via the identity
//       bridge and checks whether that PDA is already registered on-chain.
//
// Cluster defaults to `mainnet`. Set `?cluster=devnet` for devnet program
// 6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab. RPC endpoint is the public
// Solana cluster RPC unless `AGENC_RPC_URL` (or `SOLANA_RPC_URL_DEVNET` /
// `SOLANA_RPC_URL`) is set.

import { PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { getTask, getTaskLifecycleSummary, getTasksByCreator, getAgent, deriveTaskPda, deriveAgentPda } from '@tetsuo-ai/sdk';

import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { Bazaar, filterByExtension, filterByMaxPrice, filterByNetwork } from '../_lib/x402/bazaar-client.js';
import {
	createAgenCClient,
	getCanonicalThreewsAgenCId,
	buildThreewsMetadataUri,
	agenCAgentIdToHex,
} from '@three-ws/solana-agent';

function pickCluster(req) {
	const c = (req.query?.cluster || '').toString().trim().toLowerCase();
	return c === 'devnet' ? 'devnet' : 'mainnet';
}

function pickRpc(cluster) {
	const override = (process.env.AGENC_RPC_URL || '').trim();
	if (override) return override;
	if (cluster === 'devnet') {
		return (process.env.SOLANA_RPC_URL_DEVNET || '').trim() || undefined;
	}
	return (process.env.SOLANA_RPC_URL || '').trim() || undefined;
}

function parsePubkey(s, label) {
	if (!s) throw new Error(`${label} is required`);
	try {
		return new PublicKey(String(s).trim());
	} catch {
		throw new Error(`${label} is not a valid base58 pubkey`);
	}
}

function resolveIdInput(s) {
	const t = String(s).trim();
	if (t.startsWith('0x') || t.startsWith('0X')) {
		const hex = t.slice(2);
		if (hex.length !== 64) throw new Error('hex id must be 32 bytes');
		return Uint8Array.from(Buffer.from(hex, 'hex'));
	}
	if (/^[0-9a-fA-F]{64}$/.test(t)) return Uint8Array.from(Buffer.from(t, 'hex'));
	return Uint8Array.from(createHash('sha256').update(t, 'utf8').digest());
}

function serialize(value) {
	if (value === null || value === undefined) return value;
	if (typeof value === 'bigint') return value.toString();
	if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
	if (value instanceof PublicKey) return value.toBase58();
	if (Array.isArray(value)) return value.map(serialize);
	if (typeof value === 'object') {
		const out = {};
		for (const [k, v] of Object.entries(value)) out[k] = serialize(v);
		return out;
	}
	return value;
}

function taskStateLabel(state) {
	const map = { 0: 'Open', 1: 'Claimed', 2: 'Completed', 3: 'Cancelled', 4: 'Disputed', 5: 'Expired' };
	if (typeof state === 'number') return map[state] ?? `Unknown(${state})`;
	if (state && typeof state === 'object') {
		const key = Object.keys(state)[0];
		return key ? key[0].toUpperCase() + key.slice(1) : 'Unknown';
	}
	return String(state);
}

function agentStatusLabel(status) {
	const map = { 0: 'Inactive', 1: 'Active', 2: 'Busy', 3: 'Suspended' };
	if (typeof status === 'number') return map[status] ?? `Unknown(${status})`;
	if (status && typeof status === 'object') {
		const key = Object.keys(status)[0];
		return key ? key[0].toUpperCase() + key.slice(1) : 'Unknown';
	}
	return String(status);
}

async function clientFor(req) {
	const cluster = pickCluster(req);
	const rpcUrl = pickRpc(cluster);
	return createAgenCClient({ cluster, rpcUrl });
}

async function handleListTasks(req, res) {
	let creator;
	try {
		creator = parsePubkey(req.query?.creator, 'creator');
	} catch (err) {
		return error(res, 400, 'validation_error', err.message);
	}
	const client = await clientFor(req);
	const tasks = await getTasksByCreator(client.program, creator);
	return json(res, 200, serialize({
		ok: true,
		cluster: client.cluster,
		programId: client.programId,
		creator,
		count: tasks.length,
		tasks: tasks.map((t) => ({
			taskId: Buffer.from(t.taskId).toString('hex'),
			taskPda: deriveTaskPda(creator, t.taskId, client.programId),
			state: taskStateLabel(t.state),
			stateRaw: typeof t.state === 'number' ? t.state : null,
			rewardAmount: t.rewardAmount,
			rewardMint: t.rewardMint,
			deadline: t.deadline,
			currentWorkers: t.currentWorkers,
			maxWorkers: t.maxWorkers,
			completedAt: t.completedAt,
			private: !!t.constraintHash,
		})),
		fetchedAt: new Date().toISOString(),
	}));
}

async function handleGetTask(req, res) {
	const q = req.query || {};
	const client = await clientFor(req);
	let pda;
	try {
		if (q.taskPda) {
			pda = parsePubkey(q.taskPda, 'taskPda');
		} else if (q.creator && q.taskId) {
			const creator = parsePubkey(q.creator, 'creator');
			pda = deriveTaskPda(creator, resolveIdInput(q.taskId), client.programId);
		} else {
			return error(res, 400, 'validation_error', 'provide taskPda OR (creator + taskId)');
		}
	} catch (err) {
		return error(res, 400, 'validation_error', err.message);
	}

	const task = await getTask(client.program, pda);
	if (!task) {
		return json(res, 404, {
			ok: false,
			error: 'not_found',
			cluster: client.cluster,
			programId: client.programId.toBase58(),
			taskPda: pda.toBase58(),
		});
	}

	const wantLifecycle = q.lifecycle === '1' || q.lifecycle === 'true';
	let lifecycle = null;
	if (wantLifecycle) {
		const s = await getTaskLifecycleSummary(client.program, pda);
		if (s) {
			lifecycle = {
				currentState: taskStateLabel(s.currentState),
				createdAt: s.createdAt,
				currentWorkers: s.currentWorkers,
				maxWorkers: s.maxWorkers,
				timeline: s.timeline.map((e) => ({
					eventName: e.eventName,
					timestamp: e.timestamp,
					txSignature: e.txSignature ?? null,
					actor: e.actor ? e.actor.toBase58() : null,
				})),
			};
		}
	}

	return json(res, 200, serialize({
		ok: true,
		cluster: client.cluster,
		programId: client.programId,
		taskPda: pda,
		task: {
			taskId: Buffer.from(task.taskId).toString('hex'),
			state: taskStateLabel(task.state),
			stateRaw: typeof task.state === 'number' ? task.state : null,
			creator: task.creator,
			rewardAmount: task.rewardAmount,
			rewardMint: task.rewardMint,
			deadline: task.deadline,
			currentWorkers: task.currentWorkers,
			maxWorkers: task.maxWorkers,
			completedAt: task.completedAt,
			constraintHash: task.constraintHash ? Buffer.from(task.constraintHash).toString('hex') : null,
			private: !!task.constraintHash,
		},
		lifecycle,
		fetchedAt: new Date().toISOString(),
	}));
}

async function handleGetAgent(req, res) {
	const q = req.query || {};
	const client = await clientFor(req);
	let pda;
	try {
		if (q.agentPda) {
			pda = parsePubkey(q.agentPda, 'agentPda');
		} else if (q.agentId) {
			pda = deriveAgentPda(resolveIdInput(q.agentId), client.programId);
		} else {
			return error(res, 400, 'validation_error', 'provide agentPda or agentId');
		}
	} catch (err) {
		return error(res, 400, 'validation_error', err.message);
	}
	const agent = await getAgent(client.program, pda);
	if (!agent) {
		return json(res, 404, {
			ok: false,
			error: 'not_found',
			cluster: client.cluster,
			programId: client.programId.toBase58(),
			agentPda: pda.toBase58(),
		});
	}
	return json(res, 200, serialize({
		ok: true,
		cluster: client.cluster,
		programId: client.programId,
		agentPda: pda,
		agent: {
			agentId: Buffer.from(agent.agentId).toString('hex'),
			authority: agent.authority,
			capabilities: agent.capabilities,
			status: agentStatusLabel(agent.status),
			statusRaw: typeof agent.status === 'number' ? agent.status : null,
			endpoint: agent.endpoint,
			metadataUri: agent.metadataUri,
			stakeAmount: agent.stakeAmount,
			activeTasks: agent.activeTasks,
			reputation: agent.reputation,
			registeredAt: agent.registeredAt,
		},
		fetchedAt: new Date().toISOString(),
	}));
}

async function handleLink(req, res) {
	let body;
	try {
		body = await readJson(req);
	} catch {
		return error(res, 400, 'validation_error', 'invalid json');
	}
	const { erc8004AgentId, mplCoreAsset, handle, cluster, baseUrl } = body || {};
	let canonical;
	try {
		canonical = getCanonicalThreewsAgenCId({
			erc8004AgentId: erc8004AgentId ?? null,
			mplCoreAsset: mplCoreAsset ?? null,
			handle: handle ?? null,
		});
	} catch (err) {
		return error(res, 400, 'validation_error', err.message);
	}

	const cl = cluster === 'devnet' ? 'devnet' : 'mainnet';
	const rpcUrl = pickRpc(cl);
	const client = createAgenCClient({ cluster: cl, rpcUrl });
	const pda = deriveAgentPda(canonical.agenCAgentId, client.programId);
	const agent = await getAgent(client.program, pda);

	const metadataUri = buildThreewsMetadataUri(
		{ erc8004AgentId: erc8004AgentId ?? null, mplCoreAsset: mplCoreAsset ?? null, handle: handle ?? null },
		typeof baseUrl === 'string' && baseUrl ? baseUrl : 'https://three.ws',
	);

	return json(res, 200, serialize({
		ok: true,
		cluster: client.cluster,
		programId: client.programId,
		source: canonical.source,
		label: canonical.label,
		agenCAgentId: agenCAgentIdToHex(canonical.agenCAgentId),
		agentPda: pda,
		metadataUri,
		registered: !!agent,
		agent: agent
			? {
					authority: agent.authority,
					status: agentStatusLabel(agent.status),
					endpoint: agent.endpoint,
					metadataUri: agent.metadataUri,
					reputation: agent.reputation,
					activeTasks: agent.activeTasks,
					stakeAmount: agent.stakeAmount,
				}
			: null,
		fetchedAt: new Date().toISOString(),
	}));
}

// Stable 32-byte taskId seed derived from an x402 resource URL — lets the
// same x402 service map to a deterministic AgenC task PDA so re-postings
// idempotently update the same on-chain account.
function x402TaskIdSeed(resource) {
	return createHash('sha256')
		.update('AgenC/three.ws/x402/v1\0', 'utf8')
		.update(String(resource), 'utf8')
		.digest();
}

async function handleX402Services(req, res) {
	const q = req.query || {};
	const type = (q.type || 'http').toString().toLowerCase();
	if (type !== 'http' && type !== 'mcp') {
		return error(res, 400, 'validation_error', 'type must be "http" or "mcp"');
	}
	const network = q.network ? String(q.network) : null;
	const maxPrice = q.maxPrice ? String(q.maxPrice) : null;
	const asset = q.asset ? String(q.asset) : null;
	const extension = q.extension ? String(q.extension) : null;
	const maxItems = Math.max(1, Math.min(parseInt(q.maxItems, 10) || 200, 1000));

	const baz = new Bazaar();
	let result;
	try {
		result = await baz.list({ type, limit: 200, maxItems });
	} catch (err) {
		return error(res, 502, 'facilitator_error', err.message || 'bazaar fetch failed');
	}
	let items = result.items;
	if (network) items = filterByNetwork(items, network);
	if (maxPrice) items = filterByMaxPrice(items, maxPrice, asset);
	if (extension) items = filterByExtension(items, extension);

	const tasks = items.map((it) => {
		const minAccept = it.accepts?.[0] || null;
		const seed = x402TaskIdSeed(it.uniqueKey || it.resource);
		return {
			source: 'three.ws/x402',
			type: it.type,
			resource: it.resource,
			toolName: it.toolName || null,
			serviceName: it.serviceName,
			description: it.description,
			tags: it.tags || [],
			method: it.method || null,
			capabilities: 1, // bit 0: HTTP fetch / x402 settle
			price: minAccept
				? {
						amountAtomic: minAccept.amountAtomic,
						amountLabel: minAccept.priceLabel,
						currency: minAccept.asset,
						network: minAccept.network,
						family: minAccept.family,
					}
				: null,
			input: it.input || null,
			output: it.output || null,
			taskIdSeed: '0x' + Buffer.from(seed).toString('hex'),
			rewardKind: 'x402_pay_to_endpoint',
			facilitator: it.facilitator,
			lastUpdated: it.lastUpdated,
		};
	});

	res.setHeader('cache-control', 'public, max-age=15, stale-while-revalidate=60');
	return json(res, 200, {
		ok: true,
		count: tasks.length,
		tasks,
		sources: result.sources,
		errors: result.errors,
		fetchedAt: new Date().toISOString(),
	});
}

const HANDLERS = {
	'list-tasks': { methods: ['GET'], fn: handleListTasks },
	'get-task': { methods: ['GET'], fn: handleGetTask },
	'get-agent': { methods: ['GET'], fn: handleGetAgent },
	'x402-services': { methods: ['GET'], fn: handleX402Services },
	link: { methods: ['POST'], fn: handleLink },
};

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: false })) return;
	const action = String(req.query?.action || '').toLowerCase();
	const route = HANDLERS[action];
	if (!route) return error(res, 404, 'not_found', `unknown action "${action}"`);
	if (!method(req, res, route.methods)) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	try {
		return await route.fn(req, res);
	} catch (err) {
		return error(res, 500, 'agenc_error', err.message || 'unexpected error');
	}
});
