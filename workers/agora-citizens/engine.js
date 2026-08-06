// agora-citizens — the daily loop. The heartbeat that makes Agora alive: each
// citizen, on its own jittered cadence, runs
//
//   IDLE → SEEK (read the board) → CLAIM (on-chain) → WORK (real Fetcher call)
//        → PROVE (proofHash + completeTask) → EARN → IDLE
//
// Every transition is a REAL on-chain action with a tx signature, projected into
// agora_citizens / agora_activity and the shared feed. On-chain is the source of
// truth; we only ever project what actually happened. A single citizen's failure
// is caught and never halts the fleet.
//
// Devnet work supply: with no human/agent bounties yet (Task 03), an internal
// dispatcher keeps a small pool of real on-chain Fetcher tasks open so citizens
// have genuine work to claim → do → prove → earn. The dispatcher is infra
// (native-SOL devnet plumbing), not a projected citizen and not the Task-03
// bounty product.

import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { log } from './log.js';
import { buildRoster, professionBits, capabilitiesSatisfy, PROFESSIONS } from './roster.js';
import { citizenCanClaim, normalizeTaskType, isMultiWorkerType, isArenaType, TASK_TYPES } from './policy.js';
import { markPatrons, maybePatronPost, maybePatronVerify, maybeHire, hiringEnabled, subtaskReward } from './demand.js';
import { arenaWonNarrative, arenaLostNarrative, guildContributedNarrative } from './narrative.js';
import { loadOrCreateKeypair, ensureBalance } from './keypair.js';
import {
	makeReadClient,
	makeSignerClient,
	deriveIdentity,
	ensureRegistered,
	getAgent,
	listCreatorTasks,
	createTask,
	claimTask,
	completeTask,
	generateTaskId,
	deriveTaskPda,
	getTask,
	readEscrowState,
	measuredShareAtomic,
	withRetry,
	TASK_STATE,
} from './agenc.js';
import { defaultTarget } from './work/fetcher.js';
import { runProfession } from './work/index.js';

const FETCHER_BITS = professionBits(['fetcher']); // 1n
const BOARD_TTL_MS = 60_000;
const WORK_SUPPLY_TTL_MS = 30_000;

function explorerTx(sig, cluster) {
	return `https://explorer.solana.com/tx/${sig}${cluster === 'devnet' ? '?cluster=devnet' : ''}`;
}
function solStr(lamports) {
	return `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(3)} SOL`;
}
function hostOf(url) {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}
function wander(home) {
	// Small deterministic-ish drift around home so the world reads as alive
	// without inventing motion. Bounded ±3 units.
	const jitter = () => Math.round((Math.random() * 6 - 3) * 100) / 100;
	return { x: home.x + jitter(), z: home.z + jitter() };
}

// Reward shape for a completed job. Devnet plumbing settles in native SOL (never
// another real token); mainnet would settle in $THREE (out of scope here).
function rewardShape(cfg, lamports) {
	if (cfg.cluster === 'mainnet') {
		return { mint: '$THREE', label: `${lamports} $THREE`, atomic: lamports };
	}
	return { mint: null, label: `${solStr(lamports)} · devnet`, atomic: lamports };
}

// ── Fleet registration ───────────────────────────────────────────────────────

async function setupDispatcher(ctx) {
	if (!ctx.cfg.dispatchTasks) return null;
	const cfg = ctx.cfg;
	const signer = await loadOrCreateKeypair('agora-dispatcher');
	await ensureBalance(ctx.readClient.connection, signer, cfg, 'dispatcher');
	const ident = await deriveIdentity({ handle: 'agora-dispatcher' });
	const client = await makeSignerClient(cfg, signer);
	const reg = await ensureRegistered(
		client,
		ident.agentIdHex,
		{
			// The AgenC program REJECTS a zero bitmask (register_agent.rs
			// InvalidCapabilities: "Agent capabilities bitmask cannot be zero"), so a
			// dispatcher registered with 0n could never boot the fleet: every fresh
			// deployment died at setupDispatcher before a single citizen existed.
			// Bit 0 is the platform's own default for a registering agent
			// (api/agenc/[action].js) and is honest here: the dispatcher does call
			// HTTP. It is an identity marker, not a work claim. The dispatcher is a
			// separate identity that never runs the citizen loop, so it is never
			// matched to a task by this bit.
			capabilities: professionBits(['fetcher']),
			endpoint: `${cfg.apiBase}/agora/dispatcher`,
			metadataUri: ident.metadataUri,
			stakeLamports: cfg.stakeLamports,
		},
		cfg,
	);
	log.info('dispatcher ready', {
		pubkey: signer.publicKey.toBase58(),
		agentPda: reg.agentPda.toBase58(),
		existed: reg.existed,
		tx: reg.txSignature ? explorerTx(reg.txSignature, cfg.cluster) : null,
	});
	return {
		signer,
		client,
		agentIdHex: ident.agentIdHex,
		agentPda: reg.agentPda,
		pubkey: signer.publicKey,
	};
}

async function registerCitizen(ctx, spec) {
	const cfg = ctx.cfg;
	const signer = await loadOrCreateKeypair(spec.key);
	await ensureBalance(ctx.readClient.connection, signer, cfg, spec.key);

	const ident = await deriveIdentity(spec.identityRef);
	const client = await makeSignerClient(cfg, signer);
	const reg = await ensureRegistered(
		client,
		ident.agentIdHex,
		{
			capabilities: spec.professionBits,
			endpoint: `${cfg.apiBase}/agora/citizens/${ident.agentIdHex}`,
			metadataUri: ident.metadataUri,
			stakeLamports: cfg.stakeLamports,
		},
		cfg,
	);

	const reputation = reg.agent?.reputation ?? 0;
	const stake = reg.agent?.stakeAmount != null ? reg.agent.stakeAmount : cfg.stakeLamports;

	const citizenId = await ctx.store.upsertCitizen(spec, {
		agentIdHex: ident.agentIdHex,
		agentPda: reg.agentPda.toBase58(),
		capabilityBits: spec.professionBits,
		identitySource: ident.source,
		identityLabel: ident.label,
		reputation,
		stakeLamports: stake,
		status: 'idle',
	});

	// Project the registration once. A fresh register carries a tx (idempotent on
	// it); a reconciled-existing agent has no new tx, so guard on existence.
	const already = await ctx.store.activityExists(citizenId, 'registered', reg.txSignature);
	if (!already) {
		await ctx.store.appendActivity({
			citizenId,
			kind: 'registered',
			profession: spec.profession,
			txSignature: reg.txSignature,
			narrative: `${spec.displayName} registered with AgenC as a ${capLabel(spec.profession)} (reputation ${reputation}).`,
			repAfter: reputation,
			worldX: spec.home.x,
			worldZ: spec.home.z,
			meta: { agentPda: reg.agentPda.toBase58(), identitySource: ident.source, existed: reg.existed },
		});
		await ctx.store.publishFeed({
			type: 'agora-registered',
			actor: spec.displayName,
			citizenId,
			agentPda: reg.agentPda.toBase58(),
			profession: spec.profession,
			narrative: `${spec.displayName} joined Agora as a ${capLabel(spec.profession)}.`,
		});
	}

	log.info('citizen registered', {
		key: spec.key,
		name: spec.displayName,
		agentPda: reg.agentPda.toBase58(),
		existed: reg.existed,
		reputation,
		tx: reg.txSignature ? explorerTx(reg.txSignature, cfg.cluster) : null,
	});

	return {
		spec,
		id: citizenId,
		agentIdHex: ident.agentIdHex,
		agentPda: reg.agentPda,
		pubkey: signer.publicKey.toBase58(),
		signer,
		client,
		capabilityBits: spec.professionBits,
		reputation,
		claimed: new Set(),
		home: spec.home,
		busy: false,
	};
}

function capLabel(key) {
	return PROFESSIONS.find((p) => p.key === key)?.label || key || 'Citizen';
}

/**
 * Boot the fleet: seed from real platform agents, register every citizen on
 * AgenC (idempotent), set up the work dispatcher. Returns the runtime context.
 * A single citizen failing to register is logged and skipped — the rest proceed.
 */
export async function bootFleet(cfg, store) {
	const readClient = await makeReadClient(cfg);
	const ctx = {
		cfg,
		store,
		readClient,
		dispatcher: null,
		citizens: [],
		board: { at: 0, services: [], tasks: [] },
		lastSupplyAt: 0,
	};

	// The dispatcher is the devnet work supply, not the fleet. If it can't be
	// funded or registered, citizens still boot and work whatever the board
	// already carries: one component's failure never grounds the city.
	try {
		ctx.dispatcher = await setupDispatcher(ctx);
	} catch (err) {
		log.error('dispatcher setup failed, running on externally-supplied work only', { err: err?.message });
		ctx.dispatcher = null;
	}

	const seedAgents = await store.listSeedAgents(cfg.maxCitizens);
	const specs = buildRoster(seedAgents, cfg);
	log.info('roster assembled', {
		seeded: seedAgents.length,
		total: specs.length,
		standalone: specs.filter((s) => !s.agentDbId).length,
	});

	for (const spec of specs) {
		try {
			const citizen = await registerCitizen(ctx, spec);
			ctx.citizens.push(citizen);
		} catch (err) {
			log.error('citizen registration failed — skipping', { key: spec.key, err: err?.message });
		}
	}

	if (!ctx.citizens.length) throw new Error('[agora-citizens] no citizens registered — cannot run the loop');

	// SPEND node (Task 03): designate patrons who post real $THREE/SOL bounties on
	// the board, giving the economy demand beyond the devnet dispatcher. Patrons
	// still work jobs themselves — a patron is also a Fetcher.
	const patrons = markPatrons(ctx.citizens, cfg);
	log.info('demand wired', { patrons, hiring: hiringEnabled(cfg) });
	return ctx;
}

// ── Work supply (devnet dispatcher) ──────────────────────────────────────────

function openTasksOf(tasks) {
	const nowSec = Date.now() / 1000;
	return (tasks || []).filter(
		(t) => t.state === TASK_STATE.Open && t.currentWorkers < t.maxWorkers && Number(t.deadline) > nowSec,
	);
}

/** Keep the dispatcher's open Fetcher-task pool topped up. Throttled per sweep. */
export async function replenishWork(ctx, force = false) {
	const { cfg } = ctx;
	if (!ctx.dispatcher) return;
	if (!force && Date.now() - ctx.lastSupplyAt < WORK_SUPPLY_TTL_MS) return;
	ctx.lastSupplyAt = Date.now();

	let tasks;
	try {
		tasks = await listCreatorTasks(ctx.readClient, ctx.dispatcher.pubkey);
	} catch (err) {
		log.warn('replenishWork: list tasks failed', { err: err?.message });
		return;
	}
	const open = openTasksOf(tasks);
	const deficit = cfg.minOpenTasks - open.length;
	if (deficit <= 0) return;

	const room = Math.max(0, cfg.maxOpenTasks - open.length);
	const toPost = Math.min(deficit, room);
	for (let i = 0; i < toPost; i++) {
		try {
			const taskId = await generateTaskId();
			const deadline = Math.floor(Date.now() / 1000) + cfg.taskDeadlineSecs;
			const created = await createTask(
				ctx.dispatcher.client,
				{
					taskId,
					creatorAgentId: ctx.dispatcher.agentIdHex,
					requiredCapabilities: FETCHER_BITS,
					description: `Agora Fetcher job — fingerprint a live bazaar service @ ${new Date().toISOString()}`,
					rewardAmount: cfg.taskRewardLamports,
					maxWorkers: 1,
					deadline,
					taskType: 'Exclusive',
					minReputation: 0,
				},
				cfg,
			);
			log.info('dispatched task', {
				taskPda: created.taskPda.toBase58(),
				reward: solStr(cfg.taskRewardLamports),
				tx: explorerTx(created.txSignature, cfg.cluster),
			});
		} catch (err) {
			// A faucet-starved dispatcher can't post — log and stop trying this sweep.
			log.warn('dispatch task failed', { err: err?.message });
			break;
		}
	}
}

// ── Board read (honest "read the board" step) ────────────────────────────────

async function refreshBoard(ctx) {
	if (Date.now() - ctx.board.at < BOARD_TTL_MS) return ctx.board;
	try {
		const r = await fetch(`${ctx.cfg.apiBase}/api/agora/board?maxItems=20`, {
			headers: { accept: 'application/json' },
		});
		if (r.ok) {
			const body = await r.json();
			ctx.board = { at: Date.now(), services: body.services || [], tasks: body.tasks || [] };
		}
	} catch (err) {
		log.warn('board read failed', { err: err?.message });
	}
	return ctx.board;
}

// ── The per-citizen tick ─────────────────────────────────────────────────────

async function reconcile(ctx, citizen) {
	try {
		const agent = await getAgent(ctx.readClient, citizen.agentPda);
		if (agent) citizen.reputation = agent.reputation ?? citizen.reputation;
	} catch (err) {
		log.warn('reconcile failed (using last-known)', { name: citizen.spec.displayName, err: err?.message });
	}
}

async function pickClaimableTask(ctx, citizen) {
	if (!ctx.dispatcher) return null;
	let tasks;
	try {
		tasks = await listCreatorTasks(ctx.readClient, ctx.dispatcher.pubkey);
	} catch (err) {
		log.warn('seek: list tasks failed', { name: citizen.spec.displayName, err: err?.message });
		return null;
	}
	// Dispatcher posts Fetcher work (required ⊆ Fetcher), so any Fetcher citizen
	// satisfies it; we still check the capability gate explicitly.
	if (!capabilitiesSatisfy(citizen.capabilityBits, FETCHER_BITS)) return null;
	for (const t of openTasksOf(tasks)) {
		// TaskStatus carries no PDA — re-derive it from creator + taskId.
		let taskPda;
		try {
			taskPda = await deriveTaskPda(ctx.readClient, ctx.dispatcher.pubkey, t.taskId);
		} catch {
			continue;
		}
		const pda = taskPda.toBase58();
		if (citizen.claimed.has(pda)) continue; // already worked this one in-process
		return { taskPda, pda, reward: ctx.cfg.taskRewardLamports };
	}
	return null;
}

/**
 * Would this citizen be working both sides of the bounty? Two ways, both barred:
 *
 *  1. It posted the bounty. Claiming your own posting pays your escrow back to
 *     yourself and fakes demand.
 *  2. It produced the deliverable the bounty asks someone to VERIFY. The
 *     poster-side query already excludes the patron's own deliverables, but the
 *     bounty is then open to the whole board, so the citizen that made the
 *     artifact could claim the job of checking it. A self-vouch attests nothing:
 *     re-deriving your own hash from your own bytes always passes, and it is
 *     precisely the attestation an attacker would want to mint. Independence is
 *     the entire product of the trust loop.
 */
export function isSelfDealing(task, citizenId) {
	if (!citizenId) return false;
	if (task?.creator?.id && task.creator.id === citizenId) return true;
	if (task?.target?.citizenId && task.target.citizenId === citizenId) return true;
	return false;
}

/**
 * Can a citizen still engage this task on-chain? An Exclusive task is claimable only
 * while it is Open. A multi-worker task (Arena / Guild) leaves Open the moment its
 * FIRST worker claims, but it is still filling: the race wants every racer and the
 * guild wants every contributor, and the free-slot check below is what actually bounds
 * it. Gating these on Open alone let one claim lock everyone else out and strand the
 * remaining slots until the deadline expired. Reconcile already treats a mid-fill
 * multi-worker task as live; this is the same rule on the engage side.
 */
export function isJoinableState(state, taskType) {
	if (state === TASK_STATE.Open) return true;
	if (!isMultiWorkerType(taskType)) return false;
	return state === TASK_STATE.InProgress || state === TASK_STATE.PendingValidation;
}

/**
 * SEEK the board's AgenC lane for a real bounty a patron (or human, in Task 08)
 * posted. Honors the career ladder: a citizen only takes a job it's qualified for
 * (capability subset + on-chain reputation ≥ the task's minReputation). A low-rep
 * citizen skips a master-tier bounty; a qualified one takes it. We re-read the
 * task on-chain before claiming so we never chase a stale-open projection.
 */
async function pickBoardBounty(ctx, citizen) {
	const tasks = ctx.board?.tasks || [];
	for (const t of tasks) {
		if (t.source !== 'agenc' || !t.taskPda) continue;
		if (citizen.claimed.has(t.taskPda)) continue;
		if (isSelfDealing(t, citizen.id)) continue;

		// Career-ladder gate from the projection (surfaced by /api/agora/board).
		const eligible = citizenCanClaim(citizen, {
			requiredCapabilities: t.requiredCapabilities ?? 0,
			minReputation: t.minReputation ?? 0,
		});
		if (!eligible) {
			log.loop('skipping bounty — not qualified', {
				name: citizen.spec.displayName,
				taskPda: t.taskPda,
				needRep: t.minReputation ?? 0,
				haveRep: citizen.reputation,
				tier: t.tier || null,
			});
			continue;
		}

		// On-chain truth check before claiming — must still be Open with a slot.
		let onchain;
		try {
			onchain = await getTask(ctx.readClient, t.taskPda);
		} catch {
			continue;
		}
		if (!onchain || !isJoinableState(onchain.state, normalizeTaskType(t.taskType))) continue;
		if (onchain.currentWorkers >= onchain.maxWorkers) continue;
		if (Number(onchain.deadline) <= Date.now() / 1000) continue;

		const rewardAtomic = t.reward?.amountAtomic != null ? Number(t.reward.amountAtomic) : ctx.cfg.taskRewardLamports;
		// Thread the task type + slot count so the loop knows whether to race
		// (Arena / Competitive), collaborate (Guild), or work it solo (Exclusive).
		return {
			taskPda: new PublicKey(t.taskPda),
			pda: t.taskPda,
			reward: rewardAtomic,
			minReputation: t.minReputation ?? 0,
			fromBoard: true,
			target: t.target ?? null,
			taskType: normalizeTaskType(t.taskType),
			maxWorkers: Number(onchain.maxWorkers) || Number(t.maxWorkers) || 1,
		};
	}
	return null;
}

// ── Multi-worker settlement (Arena race / Guild split) ───────────────────────

/** Has this task settled on-chain (Completed/Cancelled or account closed)? */
async function isTaskSettled(ctx, taskPda) {
	let task;
	try {
		task = await getTask(ctx.readClient, taskPda);
	} catch {
		return false; // RPC hiccup — don't fabricate a settle
	}
	if (task === null) return true; // account closed / rent reclaimed → settled
	return task.state === TASK_STATE.Completed || task.state === TASK_STATE.Cancelled;
}

/**
 * Settle a Competitive (Arena) job for one racer. It has already done the REAL
 * work; here it submits its proof and the CHAIN decides: the first valid proof
 * accepted wins the whole escrow, everyone else's completeTask reverts and they
 * stand down. We never choose the winner — we read the outcome.
 */
async function settleArena(ctx, citizen, { job, work, profession, name }) {
	const cfg = ctx.cfg;
	const repBefore = citizen.reputation;
	let completion;
	try {
		completion = await completeTask(
			citizen.client,
			{ taskPda: job.taskPda, workerAgentId: citizen.agentIdHex, proofHash: work.proofHashBytes, resultData: work.resultData },
			cfg,
		);
	} catch (err) {
		// completeTask reverted: we either LOST the race (a rival's proof already
		// settled the escrow) or hit a transient error. Confirm on-chain before
		// projecting a loss — never invent a winner or a phantom stand-down.
		const settled = await isTaskSettled(ctx, job.taskPda);
		if (!settled) {
			log.warn('arena complete failed (task still live) — retry next tick', { name, pda: job.pda, err: err?.message });
			await ctx.store.setStatus(citizen.id, 'idle', wander(citizen.home));
			return 'arena-retry';
		}
		const winner = await ctx.store.winnerNameForTask(job.pda, citizen.id).catch(() => null);
		const already = await ctx.store.taskActivityExists(citizen.id, job.pda, 'stood_down').catch(() => false);
		if (!already) {
			await ctx.store.appendActivity({
				citizenId: citizen.id,
				kind: 'stood_down',
				profession,
				taskPda: job.pda,
				proofHash: work.proofHashHex,
				deliverableUrl: work.deliverableUrl,
				narrative: arenaLostNarrative({ worker: name, winner }),
				repBefore,
				repAfter: repBefore,
				meta: { taskType: TASK_TYPES.COMPETITIVE, arena: true, outcome: 'lost', winner: winner || null },
			});
			await ctx.store.publishFeed({
				type: 'agora-arena-lost',
				actor: name,
				citizenId: citizen.id,
				agentPda: citizen.agentPda.toBase58(),
				profession,
				taskPda: job.pda,
				narrative: arenaLostNarrative({ worker: name, winner }),
			});
		}
		const restPos = wander(citizen.home);
		await ctx.store.updateCitizen(citizen.id, { status: 'idle', posX: restPos.x, posZ: restPos.z });
		log.info('arena lost', { name, pda: job.pda, winner: winner || 'unknown' });
		return 'arena-lost';
	}

	// WON — the first valid proof took the whole escrow.
	await reconcile(ctx, citizen);
	const repAfter = citizen.reputation > repBefore ? citizen.reputation : repBefore + 1;
	citizen.reputation = repAfter;
	const reward = rewardShape(cfg, job.reward); // the full purse
	await ctx.store.appendActivity({
		citizenId: citizen.id,
		kind: 'completed_task',
		profession,
		taskPda: job.pda,
		txSignature: completion.txSignature,
		proofHash: work.proofHashHex,
		deliverableUrl: work.deliverableUrl,
		narrative: arenaWonNarrative({ worker: name, reward: reward.label, repBefore, repAfter }),
		repBefore,
		repAfter,
		meta: { taskType: TASK_TYPES.COMPETITIVE, arena: true, outcome: 'won' },
	});
	await ctx.store.appendActivity({
		citizenId: citizen.id,
		kind: 'earned',
		profession,
		taskPda: job.pda,
		txSignature: completion.txSignature,
		amountAtomic: reward.atomic,
		rewardMint: reward.mint,
		rewardLabel: reward.label,
		narrative: `${name} took the full Arena purse of ${reward.label}.`,
		repBefore,
		repAfter,
		meta: { taskType: TASK_TYPES.COMPETITIVE, arena: true },
	});
	// Whole-task settle terminal — closes the Arena off the open board at once
	// (reconcile also projects one per PDA; idempotent by task_pda + kind).
	await ctx.store.appendActivity({
		citizenId: citizen.id,
		kind: 'settled',
		profession,
		taskPda: job.pda,
		txSignature: completion.txSignature,
		narrative: `The Arena settled — ${name} won ${reward.label}.`,
		meta: { taskType: TASK_TYPES.COMPETITIVE, arena: true, winnerCitizenId: citizen.id },
	});
	await ctx.store.publishFeed({
		type: 'agora-arena-won',
		actor: name,
		citizenId: citizen.id,
		agentPda: citizen.agentPda.toBase58(),
		profession,
		taskPda: job.pda,
		rewardLabel: reward.label,
		txSig: completion.txSignature,
		explorerUrl: explorerTx(completion.txSignature, cfg.cluster),
		narrative: arenaWonNarrative({ worker: name, reward: reward.label, repBefore, repAfter }),
	});
	await ctx.store.publishFeed({
		type: 'agora-earned',
		actor: name,
		citizenId: citizen.id,
		agentPda: citizen.agentPda.toBase58(),
		profession,
		rewardLabel: reward.label,
		txSig: completion.txSignature,
		explorerUrl: explorerTx(completion.txSignature, cfg.cluster),
		narrative: `${name} earned ${reward.label}.`,
	});
	const restPos = wander(citizen.home);
	await ctx.store.updateCitizen(citizen.id, {
		status: 'idle',
		reputation: repAfter,
		earnedDelta: reward.atomic,
		tasksCompletedDelta: 1,
		synced: true,
		posX: restPos.x,
		posZ: restPos.z,
	});
	log.info('arena won', { name, pda: job.pda, reward: reward.label, tx: explorerTx(completion.txSignature, cfg.cluster) });
	return 'arena-won';
}

/**
 * Settle a Collaborative (Guild) contribution for one citizen. It landed a REAL
 * sub-result; here it completes on-chain and earns a share of the pool. The share
 * is MEASURED from the escrow the completion drew down — a real on-chain figure,
 * never a fabricated split. If the escrow can't be read the share projects as null
 * ("settling") rather than a guess.
 */
async function settleGuild(ctx, citizen, { job, work, profession, name }) {
	const cfg = ctx.cfg;
	const repBefore = citizen.reputation;
	const escrowBefore = await readEscrowState(citizen.client, job.taskPda);
	let completion;
	try {
		completion = await completeTask(
			citizen.client,
			{ taskPda: job.taskPda, workerAgentId: citizen.agentIdHex, proofHash: work.proofHashBytes, resultData: work.resultData },
			cfg,
		);
	} catch (err) {
		// Couldn't land the contribution (slot filled / task settled / deadline).
		// The citizen did real work but the guild moved on — no share, no projection.
		log.warn('guild contribute failed', { name, pda: job.pda, err: err?.message });
		await ctx.store.setStatus(citizen.id, 'idle', wander(citizen.home));
		return 'guild-missed';
	}
	await reconcile(ctx, citizen);
	const repAfter = citizen.reputation > repBefore ? citizen.reputation : repBefore + 1;
	citizen.reputation = repAfter;
	const escrowAfter = await readEscrowState(citizen.client, job.taskPda);
	const drawn = measuredShareAtomic(escrowBefore, escrowAfter); // what my completion drew as reward
	const shareAtomic = drawn != null ? Number(drawn) : null;
	const share = shareAtomic != null ? rewardShape(cfg, shareAtomic) : null;
	await ctx.store.appendActivity({
		citizenId: citizen.id,
		kind: 'completed_task',
		profession,
		taskPda: job.pda,
		txSignature: completion.txSignature,
		proofHash: work.proofHashHex,
		deliverableUrl: work.deliverableUrl,
		narrative: guildContributedNarrative({ worker: name, reward: share?.label || null, repBefore, repAfter }),
		repBefore,
		repAfter,
		meta: {
			taskType: TASK_TYPES.COLLABORATIVE,
			guild: true,
			outcome: 'contributed',
			shareAtomic: shareAtomic != null ? String(shareAtomic) : null,
			escrowBefore: escrowBefore != null ? String(escrowBefore.lamports) : null,
			escrowAfter: escrowAfter != null ? String(escrowAfter.lamports) : null,
		},
	});
	if (share) {
		await ctx.store.appendActivity({
			citizenId: citizen.id,
			kind: 'earned',
			profession,
			taskPda: job.pda,
			txSignature: completion.txSignature,
			amountAtomic: share.atomic,
			rewardMint: share.mint,
			rewardLabel: share.label,
			narrative: `${name} earned a ${share.label} Guild share (measured from escrow).`,
			repBefore,
			repAfter,
			meta: { taskType: TASK_TYPES.COLLABORATIVE, guild: true, measured: true },
		});
	}
	await ctx.store.publishFeed({
		type: 'agora-guild-contributed',
		actor: name,
		citizenId: citizen.id,
		agentPda: citizen.agentPda.toBase58(),
		profession,
		taskPda: job.pda,
		rewardLabel: share?.label || undefined,
		txSig: completion.txSignature,
		explorerUrl: explorerTx(completion.txSignature, cfg.cluster),
		narrative: guildContributedNarrative({ worker: name, reward: share?.label || null, repBefore, repAfter }),
	});
	const restPos = wander(citizen.home);
	await ctx.store.updateCitizen(citizen.id, {
		status: 'idle',
		reputation: repAfter,
		earnedDelta: shareAtomic != null ? shareAtomic : 0,
		tasksCompletedDelta: 1,
		synced: true,
		posX: restPos.x,
		posZ: restPos.z,
	});
	log.info('guild contributed', { name, pda: job.pda, share: share?.label || 'settling', tx: explorerTx(completion.txSignature, cfg.cluster) });
	return 'guild-contributed';
}

/**
 * Run one daily-loop tick for a single citizen. Returns the node it ended on
 * (for logging). Throws nothing the caller must handle — all errors are caught
 * and surfaced as a 'failed' outcome so one citizen never stops the fleet.
 */
export async function tickCitizen(ctx, citizen) {
	if (citizen.busy) return 'busy-skip';
	citizen.busy = true;
	const cfg = ctx.cfg;
	const name = citizen.spec.displayName;
	// The profession this citizen works — drives the WORK dispatch and every
	// projection label. Defaults to Fetcher (the founding workforce).
	const profession = citizen.spec.profession || 'fetcher';
	try {
		await reconcile(ctx, citizen);
		await refreshBoard(ctx);

		// SEEK — dispatcher work first, then the board's real bounties (posted by a
		// patron citizen here; by a human in Task 08).
		let job = await pickClaimableTask(ctx, citizen);
		if (!job) job = await pickBoardBounty(ctx, citizen);
		if (!job) {
			// No claimable work. SPEND node (Task 03): a patron with budget posts a
			// bounty so the economy has demand; everyone else wanders home and idles.
			// World-only motion gets no activity row (no real economic action).
			if (citizen.patron) {
				try {
					await maybePatronPost(ctx, citizen);
				} catch (err) {
					log.warn('patron post failed', { name, err: err?.message });
				}
				// Trust loop: also seed verification bounties against peer deliverables
				// so Verifier-capable citizens have work checking others' proofs.
				try {
					await maybePatronVerify(ctx, citizen);
				} catch (err) {
					log.warn('patron verify-post failed', { name, err: err?.message });
				}
			}
			await ctx.store.setStatus(citizen.id, 'idle', wander(citizen.home));
			return citizen.patron ? 'patron-idle' : 'idle';
		}

		// A verification bounty carries the deliverable to check as job.target; work
		// it as the Verifier regardless of this citizen's headline craft, so the
		// dispatch runs runVerifier (and the trust-loop vouch projects below).
		const workProfession = job.target ? 'verifier' : profession;

		// CLAIM
		await ctx.store.setStatus(citizen.id, 'seeking', wander(citizen.home));
		let claim;
		try {
			claim = await claimTask(citizen.client, { taskPda: job.taskPda, workerAgentId: citizen.agentIdHex }, cfg);
		} catch (err) {
			// Lost the race / task changed state — back to idle, try again next tick.
			log.warn('claim failed', { name, pda: job.pda, err: err?.message });
			await ctx.store.setStatus(citizen.id, 'idle', wander(citizen.home));
			return 'claim-failed';
		}
		citizen.claimed.add(job.pda);
		await ctx.store.setStatus(citizen.id, 'busy', wander(citizen.home));
		// Multi-worker jobs (Arena / Guild) narrate the social structure they joined
		// and carry the type + slot count so the roster + board can read them back.
		const jobTaskType = normalizeTaskType(job.taskType);
		const multiWorker = isMultiWorkerType(jobTaskType);
		const claimNarrative = multiWorker
			? isArenaType(jobTaskType)
				? `${name} entered an Arena race (${rewardShape(cfg, job.reward).label}, winner takes all).`
				: `${name} joined a Guild (contributors split ${rewardShape(cfg, job.reward).label}).`
			: `${name} claimed a ${capLabel(profession)} job (${rewardShape(cfg, job.reward).label}).`;
		const claimMeta = multiWorker ? { taskType: jobTaskType, maxWorkers: job.maxWorkers || 1, arena: isArenaType(jobTaskType), guild: !isArenaType(jobTaskType) } : undefined;
		await ctx.store.appendActivity({
			citizenId: citizen.id,
			kind: 'claimed_task',
			profession,
			taskPda: job.pda,
			txSignature: claim.txSignature,
			narrative: claimNarrative,
			repAfter: citizen.reputation,
			...(claimMeta ? { meta: claimMeta } : {}),
		});
		await ctx.store.publishFeed({
			type: multiWorker ? (isArenaType(jobTaskType) ? 'agora-arena-entered' : 'agora-guild-joined') : 'agora-task-claimed',
			actor: name,
			citizenId: citizen.id,
			agentPda: citizen.agentPda.toBase58(),
			profession,
			taskPda: job.pda,
			taskType: jobTaskType,
			txSig: claim.txSignature,
			explorerUrl: explorerTx(claim.txSignature, cfg.cluster),
			narrative: claimNarrative,
		});
		log.info('claimed', { name, pda: job.pda, taskType: jobTaskType, tx: explorerTx(claim.txSignature, cfg.cluster) });

		// SPEND node (Task 03): on a high-value single-worker board bounty, hire a
		// sub-agent for an extra fetch — true agent-to-agent hiring, paid from the
		// worker's own balance (honest scarcity). Skipped for Arena/Guild jobs so a
		// racer/contributor stays focused on landing its own proof, not spending.
		if (job.fromBoard && !multiWorker && hiringEnabled(cfg) && (job.minReputation || 0) >= 5) {
			try {
				await maybeHire(ctx, citizen, {
					parent: { taskPda: job.pda, label: `Fetcher job ${String(job.pda).slice(0, 8)}` },
					neededProfession: 'fetcher',
					subRewardAtomic: subtaskReward(cfg),
				});
			} catch (err) {
				log.warn('sub-agent hire failed', { name, err: err?.message });
			}
		}

		// WORK — do the REAL work for this citizen's profession (docs/agora.md §
		// Professions). The registry dispatches by capability: a Fetcher calls the
		// x402/HTTP service, a Sculptor forges a GLB, a Scribe writes via the LLM
		// router, a Verifier re-derives another citizen's proof. Every runner returns
		// the same proof shape, so PROVE below stays profession-agnostic.
		const boardService = ctx.board.services.find((s) => typeof s.resource === 'string' && /^https?:\/\//i.test(s.resource));
		const work = await runProfession(workProfession, {
			cfg,
			citizen: { agentIdHex: citizen.agentIdHex, displayName: name, pubkey: citizen.pubkey },
			job: { taskPda: job.pda, source: 'agenc', resource: boardService?.resource || defaultTarget(cfg), ...(job.target ? { target: job.target } : {}) },
		});

		// Multi-worker settlement (Task 09) diverges from the single-worker path: an
		// Arena has exactly ONE winner (the first valid proof accepted on-chain) and
		// every other racer stands down with nothing; a Guild pays each contributor a
		// real, escrow-measured share of the pool. Both outcomes are read from the
		// CHAIN — whoever's completeTask actually lands first wins; we never choose.
		if (multiWorker) {
			return isArenaType(jobTaskType)
				? await settleArena(ctx, citizen, { job, work, profession, name })
				: await settleGuild(ctx, citizen, { job, work, profession, name });
		}

		// PROVE — submit the proof on-chain (Exclusive single-worker path).
		const completion = await completeTask(
			citizen.client,
			{
				taskPda: job.taskPda,
				workerAgentId: citizen.agentIdHex,
				proofHash: work.proofHashBytes,
				resultData: work.resultData,
			},
			cfg,
		);

		// Re-read the chain for the new reputation (truth, not a guess).
		const repBefore = citizen.reputation;
		await reconcile(ctx, citizen);
		const repAfter = citizen.reputation > repBefore ? citizen.reputation : repBefore + 1;
		citizen.reputation = repAfter;

		const reward = rewardShape(cfg, job.reward);
		await ctx.store.appendActivity({
			citizenId: citizen.id,
			kind: 'completed_task',
			profession,
			taskPda: job.pda,
			txSignature: completion.txSignature,
			proofHash: work.proofHashHex,
			deliverableUrl: work.deliverableUrl,
			narrative: work.summary
				? `${name} ${work.summary.charAt(0).toLowerCase()}${work.summary.slice(1)} and proved it; reputation ${repBefore} → ${repAfter}.`
				: `${name} fetched ${hostOf(work.target)} and proved the result; reputation ${repBefore} → ${repAfter}.`,
			repBefore,
			repAfter,
		});
		await ctx.store.appendActivity({
			citizenId: citizen.id,
			kind: 'earned',
			profession,
			taskPda: job.pda,
			txSignature: completion.txSignature,
			amountAtomic: reward.atomic,
			rewardMint: reward.mint,
			rewardLabel: reward.label,
			narrative: `${name} earned ${reward.label} for a completed ${capLabel(profession)} job.`,
			repBefore,
			repAfter,
		});
		await ctx.store.publishFeed({
			type: 'agora-task-completed',
			actor: name,
			citizenId: citizen.id,
			agentPda: citizen.agentPda.toBase58(),
			profession,
			taskPda: job.pda,
			proofHash: work.proofHashHex,
			deliverableUrl: work.deliverableUrl,
			txSig: completion.txSignature,
			explorerUrl: explorerTx(completion.txSignature, cfg.cluster),
			narrative: `${name} completed a ${capLabel(profession)} job (rep ${repBefore} → ${repAfter}).`,
		});
		await ctx.store.publishFeed({
			type: 'agora-earned',
			actor: name,
			citizenId: citizen.id,
			agentPda: citizen.agentPda.toBase58(),
			profession,
			rewardLabel: reward.label,
			txSig: completion.txSignature,
			explorerUrl: explorerTx(completion.txSignature, cfg.cluster),
			narrative: `${name} earned ${reward.label}.`,
		});

		// The trust loop: a Verifier re-derived another citizen's proof. Project the
		// attestation as a `vouched` activity citing the verified task + the proof it
		// re-computed (idempotent on this completion tx). A mismatch is recorded just
		// as honestly as a pass — the graph never carries a false ✓.
		if (work.vouch) {
			const v = work.vouch;
			await ctx.store.appendActivity({
				citizenId: citizen.id,
				kind: 'vouched',
				profession,
				taskPda: v.targetTaskPda || job.pda,
				counterpartyCitizenId: v.targetCitizenId || null,
				txSignature: completion.txSignature,
				proofHash: v.recomputed,
				deliverableUrl: v.targetDeliverableUrl,
				narrative: v.match
					? `${name} verified a ${capLabel(v.targetProfession || 'fetcher')} deliverable — sha256 re-derived, proof holds (${String(v.recomputed).slice(0, 12)}…).`
					: `${name} flagged a ${capLabel(v.targetProfession || 'fetcher')} deliverable — recomputed hash does NOT match the on-chain proof.`,
				repBefore,
				repAfter,
				meta: { verdict: v.verdict, claimed: v.claimed, recomputed: v.recomputed },
			});
			await ctx.store.publishFeed({
				type: v.match ? 'agora-vouched' : 'agora-flagged',
				actor: name,
				citizenId: citizen.id,
				agentPda: citizen.agentPda.toBase58(),
				profession,
				taskPda: v.targetTaskPda || job.pda,
				txSig: completion.txSignature,
				explorerUrl: explorerTx(completion.txSignature, cfg.cluster),
				narrative: v.match ? `${name} vouched for a deliverable.` : `${name} flagged a deliverable mismatch.`,
			});
		}

		const restPos = wander(citizen.home);
		await ctx.store.updateCitizen(citizen.id, {
			status: 'idle',
			reputation: repAfter,
			earnedDelta: reward.atomic,
			tasksCompletedDelta: 1,
			synced: true,
			posX: restPos.x,
			posZ: restPos.z,
		});

		log.info('completed', {
			name,
			pda: job.pda,
			proof: work.proofHashHex.slice(0, 16),
			repAfter,
			tx: explorerTx(completion.txSignature, cfg.cluster),
		});
		return 'completed';
	} catch (err) {
		log.error('tick failed', { name, err: err?.message });
		try {
			await ctx.store.setStatus(citizen.id, 'idle', wander(citizen.home));
		} catch {
			/* projection write best-effort */
		}
		return 'failed';
	} finally {
		citizen.busy = false;
	}
}

// ── Dry-run planner (no signing, no DB writes) ───────────────────────────────

/**
 * Inspect the plan without touching the chain or the DB: which citizens would
 * run, what work the board offers, what the dispatcher would post. Pure reads.
 */
export async function planDryRun(cfg, store) {
	const readClient = await makeReadClient(cfg);
	const ctx = { cfg, store, readClient, board: { at: 0, services: [], tasks: [] } };
	const seedAgents = await store.listSeedAgents(cfg.maxCitizens);
	const specs = buildRoster(seedAgents, cfg);
	const plan = [];
	for (const spec of specs) {
		const ident = await deriveIdentity(spec.identityRef);
		const signer = await loadOrCreateKeypair(spec.key);
		plan.push({
			key: spec.key,
			name: spec.displayName,
			profession: spec.profession,
			capabilityBits: spec.professionBits.toString(),
			agentIdHex: ident.agentIdHex,
			identitySource: ident.source,
			pubkey: signer.publicKey.toBase58(),
			seededFrom: spec.agentDbId || null,
		});
	}
	const board = await refreshBoard(ctx);
	return {
		cluster: cfg.cluster,
		dispatchTasks: cfg.dispatchTasks,
		target: defaultTarget(cfg),
		citizens: plan,
		board: { services: board.services.length, openTasks: board.tasks.length },
	};
}
