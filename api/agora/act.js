// Agora — human citizen actions (Task 08, see docs/agora.md § Citizens).
//
// The single authenticated, mutating entry point for a signed-in human living
// in Agora. Every action runs the SAME real on-chain AgenC operation an agent
// would and projects into the SAME agora_activity ledger + feed — there is no
// separate "fake human" path (docs/agora.md invariant 1 + 3).
//
// POST /api/agora/act   { action, ... }
//   join        → upsert a human citizen + custodial wallet, place in the Commons
//   post-task   → escrow a bounty on AgenC (createTask) for a target profession
//   hire        → post a bounty routed to a specific citizen (profession + minRep)
//   claim       → claim an open on-chain task as the worker yourself
//   complete    → submit a real proof (sha256 of your deliverable) → earn
//   vouch       → leave a real on-chain attestation for a citizen
//
// Guards (all server-side): session-or-bearer auth + CSRF (api/_lib/labor-auth),
// per-user rate limit, boundary input validation, a durable per-user spend
// policy (api/_lib/agora-policy) gating real-money escrow + the mainnet $THREE
// gate, and Idempotency-Key support so a retried POST never double-escrows.

import { createHash } from 'node:crypto';
import { cors, error, json, method, rateLimited, readJson, wrap, serverError, reportServerError } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { authWrite } from '../_lib/labor-auth.js';
import { TOKEN_MINT } from '../_lib/token/config.js';
import {
	ensureHumanCitizen, ensureRegistered, ensureDevnetBalance, requireFunded,
	projectActivity, bumpCitizenStats, citizenBalances, professionToCapabilityBits,
	PROFESSION_BITS, THREE_ATOMICS_PER_TOKEN, rewardLabel, proofHashFor,
	sendOnchainAttestation, explorerTx,
} from '../_lib/agora-human.js';
import { resolveCluster, checkPostSpend } from '../_lib/agora-policy.js';
import { redactUrlSecrets as redactSecrets } from '../_lib/scrub-secrets.js';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const MAX_TITLE = 140;
const MAX_DESC = 4000;
const MAX_DELIVERABLE = 8000;

// ── small helpers ─────────────────────────────────────────────────────────────

async function loadUser(userId) {
	const [u] = await sql`
		select id, display_name, username, avatar_url from users
		where id = ${userId} and deleted_at is null limit 1`;
	return u || null;
}

function reqHash(action, body) {
	return createHash('sha256').update(JSON.stringify({ action, body })).digest('hex');
}

// Durable idempotency on (user, action, key). Returns one of:
//   { replay: response }   — a prior identical request already completed
//   { conflict: true }     — same key, different payload (409)
//   { inflight: true }     — a request with this key is still running (409)
//   { proceed: true }      — we own the lock; finish() captures the result
async function idemBegin(userId, action, key, hash) {
	if (!key) return { proceed: true, key: null };
	try {
		await sql`
			insert into agora_idempotency (user_id, action, idem_key, status, request_hash)
			values (${userId}, ${action}, ${key}, 'pending', ${hash})`;
		return { proceed: true, key };
	} catch {
		const [row] = await sql`
			select status, response, request_hash from agora_idempotency
			where user_id = ${userId} and action = ${action} and idem_key = ${key} limit 1`;
		if (!row) return { proceed: true, key }; // race lost then row gone — proceed
		if (row.request_hash && row.request_hash !== hash) return { conflict: true };
		if (row.status === 'done') return { replay: row.response };
		return { inflight: true };
	}
}

async function idemFinish(userId, action, key, response) {
	if (!key) return;
	await sql`
		update agora_idempotency set status = 'done', response = ${JSON.stringify(response)}::jsonb
		where user_id = ${userId} and action = ${action} and idem_key = ${key}`.catch(() => {});
}

async function idemRelease(userId, action, key) {
	if (!key) return;
	await sql`
		delete from agora_idempotency
		where user_id = ${userId} and action = ${action} and idem_key = ${key} and status = 'pending'`.catch(() => {});
}

// Shape the "you" HUD payload — citizen status + balances + live tasks/earnings.
async function shapeMe(citizen, cluster) {
	const balances = await citizenBalances(citizen, cluster).catch(() => ({ sol: null, three: null, address: citizen.meta?.solana_address || null }));
	const [posted, open] = await Promise.all([
		sql`select count(*)::int as n from agora_activity where citizen_id = ${citizen.id} and kind = 'posted_task'`,
		sql`select a.task_pda, a.reward_label, a.profession, a.created_at
		    from agora_activity a
		    where a.citizen_id = ${citizen.id} and a.kind = 'posted_task' and a.task_pda is not null
		      and not exists (
		        select 1 from agora_activity x where x.task_pda = a.task_pda
		          and x.kind in ('claimed_task','completed_task','cancelled_task','expired_task','slashed')
		          and x.created_at >= a.created_at)
		    order by a.created_at desc limit 20`,
	]);
	return {
		citizenId: citizen.id,
		displayName: citizen.display_name,
		avatarUrl: citizen.avatar_url,
		status: citizen.status,
		cluster: citizen.agenc_cluster,
		walletAddress: balances.address,
		registered: !!citizen.agenc_agent_pda,
		agentPda: citizen.agenc_agent_pda,
		reputation: citizen.reputation,
		tasksPosted: citizen.tasks_posted,
		tasksCompleted: citizen.tasks_completed,
		earnedThreeAtomic: String(citizen.earned_three_atomic ?? '0'),
		balances: { sol: balances.sol, three: balances.three },
		home: { x: citizen.home_x, z: citizen.home_z },
		position: { x: citizen.pos_x, z: citizen.pos_z },
		openPostedCount: posted[0]?.n || 0,
		openPosted: open.map((t) => ({ taskPda: t.task_pda, rewardLabel: t.reward_label, profession: t.profession, postedAt: t.created_at })),
	};
}

// Resolve the reward in atomic units for a cluster from the request body. Devnet
// rewards are SOL (lamports); mainnet rewards are $THREE (token atomics).
function resolveRewardAtomic(body, cluster) {
	if (cluster === 'mainnet') {
		const three = Number(body.rewardThree);
		if (!Number.isFinite(three) || three <= 0) return null;
		const whole = BigInt(Math.floor(three));
		const frac = BigInt(Math.round((three - Math.floor(three)) * Number(THREE_ATOMICS_PER_TOKEN)));
		return whole * THREE_ATOMICS_PER_TOKEN + frac;
	}
	const sol = Number(body.rewardSol);
	if (!Number.isFinite(sol) || sol <= 0) return null;
	const whole = BigInt(Math.floor(sol));
	const frac = BigInt(Math.round((sol - Math.floor(sol)) * Number(LAMPORTS_PER_SOL)));
	return whole * LAMPORTS_PER_SOL + frac;
}

// ── shared task-posting core (post-task + hire) ───────────────────────────────

async function postTaskCore({ user, body, requestedCluster, hire }) {
	const cluster = resolveCluster(requestedCluster);

	const title = String(body.title || '').trim();
	const description = String(body.description || body.spec || '').trim();
	if (!title || title.length > MAX_TITLE) return { err: [400, 'validation_error', `title is required (≤${MAX_TITLE} chars)`] };
	if (description.length > MAX_DESC) return { err: [400, 'validation_error', `description must be ≤${MAX_DESC} chars`] };

	// Resolve the target profession (and, for hire, the routed-to citizen).
	let profession = String(body.profession || '').toLowerCase() || null;
	let target = null;
	let minReputation = Number.isFinite(+body.minReputation) ? Math.max(0, Math.floor(+body.minReputation)) : 0;
	if (hire) {
		if (!body.citizenId) return { err: [400, 'validation_error', 'hire requires citizenId'] };
		[target] = await sql`select * from agora_citizens where id = ${String(body.citizenId)} limit 1`;
		if (!target) return { err: [404, 'not_found', 'no such citizen to hire'] };
		profession = profession || target.profession;
		// Route so the target qualifies: minReputation must not exceed theirs.
		minReputation = Math.min(minReputation, Number(target.reputation || 0));
	}
	if (!profession || !(profession in PROFESSION_BITS)) {
		return { err: [400, 'validation_error', `profession must be one of: ${Object.keys(PROFESSION_BITS).join(', ')}`] };
	}

	const amountAtomic = resolveRewardAtomic(body, cluster);
	if (amountAtomic == null) {
		return { err: [400, 'validation_error', cluster === 'mainnet' ? 'rewardThree must be > 0' : 'rewardSol must be > 0'] };
	}

	// Per-user spend policy + mainnet gate (server-side, ledger-backed).
	const { citizen } = await ensureHumanCitizen({ user, cluster });
	const policy = await checkPostSpend({ citizenId: citizen.id, cluster, amountAtomic, requestedCluster });
	if (!policy.ok) return { err: [policy.status, policy.code, policy.message, policy.detail] };

	// Register on-chain (lazy) + fund the reward escrow on devnet.
	const reg = await ensureRegistered({ citizen, cluster });
	const { PublicKey } = await import('@solana/web3.js');

	const createArgs = {
		creatorAgentId: reg.agentId,
		requiredCapabilities: professionToCapabilityBits(profession),
		description: description || title,
		rewardAmount: amountAtomic,
		maxWorkers: 1,
		deadline: Math.floor(Date.now() / 1000) + Math.max(1, Math.min(720, Number(body.deadlineHours) || 24)) * 3600,
		taskType: 'Exclusive',
		minReputation,
	};

	if (cluster === 'mainnet') {
		const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
		createArgs.rewardMint = new PublicKey(TOKEN_MINT);
		createArgs.creatorTokenAccount = getAssociatedTokenAddressSync(new PublicKey(TOKEN_MINT), reg.signer.publicKey, false);
		// Real money: check the $THREE the escrow will actually debit before we
		// sign, so "you don't hold enough $THREE" is a designed state and not an
		// SPL transfer failure surfaced as a 502.
		const held = await citizenBalances(citizen, cluster).catch(() => ({ three: null }));
		const needThree = Number(amountAtomic) / Number(THREE_ATOMICS_PER_TOKEN);
		if (held.three != null && held.three < needThree) {
			return {
				err: [409, 'insufficient_funds',
					`This bounty escrows ${rewardLabel(amountAtomic, cluster)} and your Agora wallet holds ${held.three.toLocaleString('en-US')} $THREE. Send $THREE to your wallet address, then post again.`,
					{ walletAddress: held.address, asset: '$THREE', cluster, needed: needThree, have: held.three }],
			};
		}
	} else {
		// Devnet native-SOL escrow: top up, then gate on the real balance so a
		// throttled faucet reads as "fund this address", not a 500.
		const needLamports = Number(amountAtomic) + 10_000_000;
		await ensureDevnetBalance(reg.client.connection, reg.signer, needLamports);
		await requireFunded({
			connection: reg.client.connection, address: reg.signer.publicKey,
			neededLamports: needLamports, cluster, purpose: 'escrow this bounty',
		});
	}

	const { createAgenCTask } = await import('@three-ws/solana-agent');
	let created;
	try {
		created = await createAgenCTask(reg.client, createArgs);
	} catch (e) {
		return { err: [502, 'escrow_failed', 'the bounty was not posted — no funds moved'], cause: e };
	}

	const taskPda = created.taskPda.toBase58();
	const taskIdHex = Buffer.from(created.taskId).toString('hex');
	const label = rewardLabel(amountAtomic, cluster);
	const mintLabel = cluster === 'mainnet' ? '$THREE' : null;

	const narrative = hire
		? `${citizen.display_name} hired ${target.display_name} for a ${profession} task — ${label}.`
		: `${citizen.display_name} posted a ${profession} bounty — ${label}.`;

	await projectActivity({
		citizenId: citizen.id,
		kind: hire ? 'hired' : 'posted_task',
		taskPda, taskId: taskIdHex, profession,
		counterpartyCitizenId: hire ? target.id : null,
		amountAtomic: amountAtomic.toString(), rewardMint: mintLabel, rewardLabel: label,
		txSignature: created.txSignature, narrative,
		worldX: citizen.home_x, worldZ: citizen.home_z,
		meta: { minReputation, maxWorkers: 1 },
	});
	await bumpCitizenStats(citizen.id, { incPosted: 1, status: 'idle' });

	const { publishFeedEvent } = await import('../_lib/feed.js');
	publishFeedEvent({
		type: hire ? 'agora-hired' : 'agora-task-posted',
		actor: citizen.display_name.slice(0, 32),
		taskPda, profession, rewardLabel: label, minReputation, cluster,
	}).catch(() => {});

	return {
		ok: true,
		body: {
			ok: true,
			taskPda, taskId: taskIdHex,
			txSignature: created.txSignature,
			explorerUrl: explorerTx(created.txSignature, cluster),
			reward: { amountAtomic: amountAtomic.toString(), label, mint: mintLabel },
			profession, minReputation, cluster,
			routedTo: hire ? { citizenId: target.id, name: target.display_name } : null,
			taskUrl: `/api/agenc/get-task?taskPda=${taskPda}&cluster=${cluster}&lifecycle=1`,
		},
	};
}

// ── action handlers ───────────────────────────────────────────────────────────

async function actJoin(user, body) {
	const cluster = resolveCluster(body.cluster);
	const { citizen, created } = await ensureHumanCitizen({ user, cluster });
	const me = await shapeMe(citizen, cluster);
	return { ok: true, body: { ok: true, created, me } };
}

async function actPostTask(user, body) {
	const r = await postTaskCore({ user, body, requestedCluster: body.cluster, hire: false });
	return r.err ? { err: r.err } : { ok: true, body: r.body };
}

async function actHire(user, body) {
	const r = await postTaskCore({ user, body, requestedCluster: body.cluster, hire: true });
	return r.err ? { err: r.err } : { ok: true, body: r.body };
}

async function actClaim(user, body) {
	const cluster = resolveCluster(body.cluster);
	const taskPda = String(body.taskPda || '').trim();
	if (!taskPda) return { err: [400, 'validation_error', 'taskPda is required'] };

	const { citizen } = await ensureHumanCitizen({ user, cluster });
	const reg = await ensureRegistered({ citizen, cluster });
	const { PublicKey } = await import('@solana/web3.js');
	const { claimAgenCTask } = await import('@three-ws/solana-agent');

	let claim;
	try {
		claim = await claimAgenCTask(reg.client, { taskPda: new PublicKey(taskPda), workerAgentId: reg.agentId });
	} catch (e) {
		return { err: [502, 'claim_failed', 'could not claim the task'], cause: e };
	}

	await projectActivity({
		citizenId: citizen.id, kind: 'claimed_task', taskPda,
		txSignature: claim.txSignature,
		narrative: `${citizen.display_name} claimed a task to work on it.`,
		worldX: citizen.home_x, worldZ: citizen.home_z,
	});
	await bumpCitizenStats(citizen.id, { status: 'busy' });

	const { publishFeedEvent } = await import('../_lib/feed.js');
	publishFeedEvent({
		type: 'agora-task-claimed', actor: citizen.display_name.slice(0, 32),
		citizenId: citizen.id, agentPda: reg.agentPda, taskPda,
		txSig: claim.txSignature, explorerUrl: explorerTx(claim.txSignature, cluster),
		narrative: `${citizen.display_name} claimed a task`,
	}).catch(() => {});

	return { ok: true, body: { ok: true, taskPda, txSignature: claim.txSignature, explorerUrl: explorerTx(claim.txSignature, cluster), cluster } };
}

async function actComplete(user, body) {
	const cluster = resolveCluster(body.cluster);
	const taskPda = String(body.taskPda || '').trim();
	if (!taskPda) return { err: [400, 'validation_error', 'taskPda is required'] };

	const deliverable = String(body.deliverable || body.deliverableUrl || '').trim();
	if (!deliverable) return { err: [400, 'validation_error', 'deliverable (text or url) is required'] };
	if (deliverable.length > MAX_DELIVERABLE) return { err: [400, 'validation_error', `deliverable must be ≤${MAX_DELIVERABLE} chars`] };

	const proofHash = proofHashFor(deliverable);
	const { citizen } = await ensureHumanCitizen({ user, cluster });
	const reg = await ensureRegistered({ citizen, cluster });
	const { PublicKey } = await import('@solana/web3.js');
	const { completeAgenCTask, getAgenCTask, getAgenCAgent } = await import('@three-ws/solana-agent');

	const pda = new PublicKey(taskPda);
	// resultData is an on-chain [u8;64]; size it by BYTES, not characters, so a
	// multibyte deliverable (emoji/CJK/accents) can't overflow Anchor's fixed slot
	// and fail serialization. Zero-padded; the first byte is non-zero (deliverable
	// is validated non-empty above) so it's never the rejected all-zero slot.
	const resultData = Buffer.alloc(64);
	Buffer.from(deliverable, 'utf8').copy(resultData, 0, 0, 64);
	let completion;
	try {
		completion = await completeAgenCTask(reg.client, {
			taskPda: pda, workerAgentId: reg.agentId, proofHash, resultData,
		});
	} catch (e) {
		return { err: [502, 'complete_failed', 'could not submit the proof'], cause: e };
	}

	// Re-read the chain for the real reward + reputation — never invent them.
	const task = await getAgenCTask(reg.client, pda).catch(() => null);
	const onchainAgent = await getAgenCAgent(reg.client, new PublicKey(reg.agentPda)).catch(() => null);
	const rewardAmount = task?.rewardAmount != null ? BigInt(task.rewardAmount) : 0n;
	const label = rewardLabel(rewardAmount, cluster);
	const mintLabel = cluster === 'mainnet' ? '$THREE' : null;
	const repAfter = onchainAgent?.reputation != null ? Number(onchainAgent.reputation) : citizen.reputation;
	const deliverableUrl = /^https?:\/\//i.test(deliverable) ? deliverable : null;

	await projectActivity({
		citizenId: citizen.id, kind: 'completed_task', taskPda,
		proofHash, txSignature: completion.txSignature, deliverableUrl,
		amountAtomic: rewardAmount.toString(), rewardMint: mintLabel, rewardLabel: label,
		repBefore: citizen.reputation, repAfter,
		narrative: `${citizen.display_name} completed a task with an accepted proof (rep ${citizen.reputation} → ${repAfter}).`,
		worldX: citizen.home_x, worldZ: citizen.home_z,
	});
	// 'earned' cites the SAME completion tx — projectActivity is keyed by
	// (citizen, kind, tx) so this is a distinct, idempotent row.
	await projectActivity({
		citizenId: citizen.id, kind: 'earned', taskPda,
		amountAtomic: rewardAmount.toString(), rewardMint: mintLabel, rewardLabel: label,
		txSignature: completion.txSignature,
		narrative: `${citizen.display_name} earned ${label}.`,
	});
	await bumpCitizenStats(citizen.id, {
		incCompleted: 1, status: 'idle', setReputation: repAfter,
		addEarnedAtomic: cluster === 'mainnet' ? rewardAmount.toString() : null,
	});

	const { publishFeedEvent } = await import('../_lib/feed.js');
	publishFeedEvent({
		type: 'agora-task-completed', actor: citizen.display_name.slice(0, 32),
		citizenId: citizen.id, agentPda: reg.agentPda, taskPda, proofHash,
		txSig: completion.txSignature, explorerUrl: explorerTx(completion.txSignature, cluster),
		narrative: `${citizen.display_name} completed a task`,
	}).catch(() => {});
	if (rewardAmount > 0n) {
		publishFeedEvent({
			type: 'agora-earned', actor: citizen.display_name.slice(0, 32),
			citizenId: citizen.id, agentPda: reg.agentPda, rewardLabel: label,
			txSig: completion.txSignature, explorerUrl: explorerTx(completion.txSignature, cluster),
			narrative: `${citizen.display_name} earned ${label}`,
		}).catch(() => {});
	}

	return {
		ok: true,
		body: {
			ok: true, taskPda, proofHash: `0x${proofHash}`,
			txSignature: completion.txSignature, explorerUrl: explorerTx(completion.txSignature, cluster),
			reward: { amountAtomic: rewardAmount.toString(), label, mint: mintLabel },
			reputation: repAfter, cluster,
		},
	};
}

async function actVouch(user, body) {
	const cluster = resolveCluster(body.cluster);
	const subjectId = String(body.subjectCitizenId || body.citizenId || '').trim();
	if (!subjectId) return { err: [400, 'validation_error', 'subjectCitizenId is required'] };

	const { citizen } = await ensureHumanCitizen({ user, cluster });
	if (subjectId === citizen.id) return { err: [400, 'validation_error', 'you cannot vouch for yourself'] };

	const [subject] = await sql`select id, display_name, agenc_agent_pda from agora_citizens where id = ${subjectId} limit 1`;
	if (!subject) return { err: [404, 'not_found', 'no such citizen to vouch for'] };

	// Dedupe per ordered (voucher, subject): refresh an existing edge, never stack.
	const [existing] = await sql`
		select id from agora_vouches where voucher_citizen_id = ${citizen.id} and subject_citizen_id = ${subject.id} limit 1`;

	const reg = await ensureRegistered({ citizen, cluster });
	const note = String(body.note || '').slice(0, 280);
	const taskPda = body.taskPda ? String(body.taskPda).trim() : null;
	const memo = `agora:vouch v1 by=${reg.agentPda} for=${subject.agenc_agent_pda || subject.id}${taskPda ? ` task=${taskPda}` : ''}`;

	let sig;
	try {
		sig = await sendOnchainAttestation({ cluster, signer: reg.signer, memo });
	} catch (e) {
		return { err: [502, 'attestation_failed', 'the vouch was not recorded on-chain'], cause: e };
	}

	const [edge] = existing
		? await sql`
			update agora_vouches set tx_signature = ${sig}, cluster = ${cluster}, note = ${note || null},
			    task_pda = ${taskPda}, updated_at = now()
			where id = ${existing.id} returning id`
		: await sql`
			insert into agora_vouches
				(voucher_citizen_id, subject_citizen_id, voucher_user_id, task_pda, tx_signature, cluster, note)
			values (${citizen.id}, ${subject.id}, ${user.id}, ${taskPda}, ${sig}, ${cluster}, ${note || null})
			returning id`;

	await projectActivity({
		citizenId: citizen.id, kind: 'vouched', counterpartyCitizenId: subject.id,
		taskPda, txSignature: sig,
		narrative: `${citizen.display_name} vouched for ${subject.display_name}.`,
		worldX: citizen.home_x, worldZ: citizen.home_z,
	});

	const { publishFeedEvent } = await import('../_lib/feed.js');
	publishFeedEvent({
		type: 'agora-vouched', actor: citizen.display_name.slice(0, 32),
		citizenId: citizen.id, subjectCitizenId: subject.id, subject: subject.display_name.slice(0, 32),
		txSig: sig, explorerUrl: explorerTx(sig, cluster),
		narrative: `${citizen.display_name} vouched for ${subject.display_name}`,
	}).catch(() => {});

	return {
		ok: true,
		body: { ok: true, edgeId: edge.id, refreshed: !!existing, txSignature: sig, explorerUrl: explorerTx(sig, cluster), subject: { id: subject.id, name: subject.display_name }, cluster },
	};
}

const ACTIONS = {
	join: actJoin,
	'post-task': actPostTask,
	hire: actHire,
	claim: actClaim,
	complete: actComplete,
	vouch: actVouch,
};

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await authWrite(req, res);
	if (!auth) return; // authWrite already wrote 401/403
	const { userId } = auth;

	const rl = await limits.mcpAgentPay(userId);
	if (!rl.success) return rateLimited(res, rl, 'agora action rate limit exceeded');

	const body = (await readJson(req)) || {};
	const action = String(body.action || '').toLowerCase();
	const handler = ACTIONS[action];
	if (!handler) return error(res, 400, 'validation_error', `unknown action "${action}"`);

	const user = await loadUser(userId);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	// Idempotency-Key (optional). Durable across serverless invocations so a
	// retried escrow/claim/complete returns the first result rather than re-running.
	const idemKey = (req.headers['idempotency-key'] || '').toString().trim().slice(0, 200) || null;
	const hash = reqHash(action, body);
	const idem = await idemBegin(userId, action, idemKey, hash);
	if (idem.replay) return json(res, 200, idem.replay);
	if (idem.conflict) return error(res, 409, 'idempotency_conflict', 'this Idempotency-Key was used with a different request');
	if (idem.inflight) return error(res, 409, 'idempotency_inflight', 'a request with this Idempotency-Key is still in progress');

	try {
		const result = await handler(user, body);
		if (result.err) {
			await idemRelease(userId, action, idemKey);
			const [status, code, message, detail] = result.err;
			const extra = { ...(detail || {}) };
			// A ≥500 carries an upstream on-chain cause: log + capture it server-side
			// under a correlation id and return only that ref — never the raw RPC
			// error string, which can embed the keyed RPC URL (HELIUS_API_KEY).
			if (result.cause && status >= 500) {
				extra.ref = reportServerError(result.cause, { code, status, context: { action } });
			}
			return error(res, status, code, message, extra);
		}
		await idemFinish(userId, action, idemKey, result.body);
		return json(res, 200, result.body);
	} catch (err) {
		await idemRelease(userId, action, idemKey);
		// A typed 4xx thrown from the service layer is a DESIGNED state the user can
		// act on (no custodial wallet yet, a dry devnet wallet the faucet wouldn't
		// top up). Surface it verbatim; only genuinely unexpected failures collapse
		// into an opaque 500 with a support ref.
		const status = Number(err?.status);
		if (Number.isInteger(status) && status >= 400 && status < 500) {
			return error(res, status, err.code || 'agora_act_error', err.message, err.detail || {});
		}
		// Redact before logging: an unexpected failure here is usually an on-chain
		// RPC error whose message carries the keyed endpoint URL.
		console.error('[agora/act] error', action, redactSecrets(err?.message));
		return serverError(res, 500, 'agora_act_error', err);
	}
});
