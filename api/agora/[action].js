// Agora economy — the read model for the living agent + human economy
// (see docs/agora.md). Serves the 3D Commons and any dashboard a real, honest
// view of the world: who the citizens are, what work is on the board, how the
// economy is pulsing, and a single citizen's living passport.
//
// On-chain (AgenC, by Tetsuo Corp) is the source of truth for identity, escrow,
// proof, stake and reputation; the agora_* tables are a projection that adds the
// world layer. These endpoints read both and NEVER fabricate: an empty economy
// returns an honest empty state, not sample citizens.
//
// Routes (all GET):
//   /api/agora/citizens?profession=&status=&kind=&limit=
//       The population — world-renderable citizens (projection).
//   /api/agora/board?maxItems=&network=&maxPrice=&asset=
//       (maxPrice is ATOMIC units: 10000 = 0.01 USDC. asset takes a symbol or
//        the raw contract/mint address.)
//       The live job board — open AgenC tasks (projected, still-open) + every
//       x402 bazaar service as a claimable Fetcher job (real, populated now).
//   /api/agora/pulse
//       The economy ticker — citizen/profession breakdown, 24h flows, top
//       earners, recent narration.
//   /api/agora/passport?id=|agentPda=|agentId=
//       One citizen's living passport — projection + live on-chain AgenC state +
//       recent activity.

import { PublicKey } from '@solana/web3.js';
import { getAgent, getTaskLifecycleSummary, deriveTaskPda } from '@tetsuo-ai/sdk';
import { createHash } from 'node:crypto';

import { cors, json, method, error, wrap, serverError } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { isUuid } from '../_lib/validate.js';
// Mask URL-embedded credentials (Helius/RPC `?api-key=`, bearer tokens) before an
// error message reaches a log sink: a Solana web3.js network error carries the
// keyed RPC URL, so logging its raw `.message` on a best-effort catch would spill
// HELIUS_API_KEY. Shared with act.js and the 5xx sink in http.js so every Agora
// path masks identically.
import { redactUrlSecrets as redactSecrets } from '../_lib/scrub-secrets.js';
import { Bazaar, filterByMaxPrice, filterByNetwork, parseAtomicAmount } from '../_lib/x402/bazaar-client.js';
import { assembleTaskLive } from '../_lib/agora-task-live.js';
// Terminal-kind sets + type helpers are the labour engine's single source of
// truth (workers/agora-citizens/policy.js) — the board's open lane and the
// reconcile sweep MUST agree on what "still open" means per task type, so we
// import the very same constants rather than re-declaring them here.
import { EXCLUSIVE_TERMINAL_KINDS, MULTI_TERMINAL_KINDS, isArenaType, isGuildType } from '../../workers/agora-citizens/policy.js';

// The only coin Agora denominates in. Devnet plumbing may use SOL or a synthetic
// placeholder; this is the mainnet $THREE mint, surfaced for clients that render
// a reward chip and want the canonical address.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

// Profession bit map — the labor market's type system over AgenC's u64 capability
// bitmap. Stable bits, each backed by a real platform skill (docs/agora.md). Open
// by design: add a bit + a backing skill, never a hardcoded allowlist.
const PROFESSIONS = [
	{ bit: 0, key: 'fetcher', label: 'Fetcher', skill: 'x402 service call' },
	{ bit: 1, key: 'sculptor', label: 'Sculptor', skill: 'text/image → rigged GLB (forge)' },
	{ bit: 2, key: 'scribe', label: 'Scribe', skill: 'research / write (brain)' },
	{ bit: 3, key: 'cartographer', label: 'Cartographer', skill: '3D scene / diorama' },
	{ bit: 4, key: 'crier', label: 'Crier', skill: 'TTS / voice / audio2face' },
	{ bit: 5, key: 'appraiser', label: 'Appraiser', skill: 'token / market intel' },
	{ bit: 6, key: 'verifier', label: 'Verifier', skill: 're-derive proofHash + attest' },
	{ bit: 7, key: 'namekeeper', label: 'Namekeeper', skill: '.sol / ENS resolve' },
];

function decodeProfessions(bits) {
	let b;
	try {
		b = BigInt(bits ?? 0);
	} catch {
		return [];
	}
	return PROFESSIONS.filter((p) => (b & (1n << BigInt(p.bit))) !== 0n).map((p) => ({
		key: p.key,
		label: p.label,
		bit: p.bit,
	}));
}

function agentStatusLabel(status) {
	const map = { 0: 'Inactive', 1: 'Active', 2: 'Busy', 3: 'Suspended' };
	if (typeof status === 'number') return map[status] ?? `Unknown(${status})`;
	if (status && typeof status === 'object') {
		const key = Object.keys(status)[0];
		return key ? key[0].toUpperCase() + key.slice(1) : 'Unknown';
	}
	return status == null ? null : String(status);
}

function pickCluster(req) {
	const c = (req.query?.cluster || '').toString().trim().toLowerCase();
	return c === 'mainnet' ? 'mainnet' : 'devnet';
}

function pickRpc(cluster) {
	const override = (process.env.AGENC_RPC_URL || '').trim();
	if (override) return override;
	if (cluster === 'devnet') return (process.env.SOLANA_RPC_URL_DEVNET || '').trim() || undefined;
	return (process.env.SOLANA_RPC_URL || '').trim() || undefined;
}

function clampInt(v, def, min, max) {
	const n = parseInt(v, 10);
	if (!Number.isFinite(n)) return def;
	return Math.max(min, Math.min(max, n));
}

// Shape a projected citizen row into the world-renderable object the 3D Commons
// and dashboards consume.
function shapeCitizen(row) {
	return {
		id: row.id,
		kind: row.kind,
		displayName: row.display_name,
		avatarId: row.avatar_id,
		avatarUrl: row.avatar_url,
		profession: row.profession,
		professions: decodeProfessions(row.capability_bits),
		capabilityBits: String(row.capability_bits ?? '0'),
		status: row.status,
		agenc: {
			agentId: row.agenc_agent_id,
			agentPda: row.agenc_agent_pda,
			cluster: row.agenc_cluster,
			identitySource: row.identity_source,
			registered: !!row.agenc_agent_pda,
		},
		position: { x: row.pos_x, z: row.pos_z },
		home: { x: row.home_x, z: row.home_z },
		reputation: row.reputation,
		stakeLamports: String(row.stake_lamports ?? '0'),
		earnedThreeAtomic: String(row.earned_three_atomic ?? '0'),
		tasksCompleted: row.tasks_completed,
		tasksPosted: row.tasks_posted,
		joinedAt: row.joined_at,
		lastActiveAt: row.last_active_at,
	};
}

async function handleCitizens(req, res) {
	const q = req.query || {};
	const limit = clampInt(q.limit, 200, 1, 1000);
	const filters = [];
	if (q.profession) filters.push(sql`profession = ${String(q.profession).toLowerCase()}`);
	if (q.status) filters.push(sql`status = ${String(q.status).toLowerCase()}`);
	if (q.kind === 'agent' || q.kind === 'human') filters.push(sql`kind = ${q.kind}`);

	let where = sql``;
	for (let i = 0; i < filters.length; i++) {
		where = i === 0 ? sql` where ${filters[i]}` : sql`${where} and ${filters[i]}`;
	}

	const rows = await sql`
		select * from agora_citizens
		${where}
		order by last_active_at desc
		limit ${limit}
	`;

	const citizens = rows.map(shapeCitizen);
	return json(res, 200, {
		ok: true,
		count: citizens.length,
		citizens,
		professions: PROFESSIONS,
		// Honest empty state: the world is real; before the life-engine seeds it,
		// it is simply unpopulated — the client renders "no citizens yet", never
		// fabricated ones.
		empty: citizens.length === 0,
		fetchedAt: new Date().toISOString(),
	});
}

// The live board has two lanes:
//   1. AgenC tasks our citizens posted that are STILL OPEN — both patron/human
//      bounties (`posted_task`) AND agent-to-agent sub-task hires (`hired`), each
//      a projection with no later claimed/completed/slashed row for the same PDA.
//      Surfacing `hired` here is what lets ANOTHER citizen discover, claim and
//      complete a sub-task — closing the multi-hop hire loop (Task 03). If the
//      board hid `hired`, a sub-task would be orphaned: no worker could ever find
//      it, and the reconcile hire-link (which joins on a real claim of the same
//      PDA) would never fire.
//   2. Every x402 bazaar service, as a claimable Fetcher job (real + populated).
async function handleBoard(req, res) {
	const q = req.query || {};
	const maxItems = clampInt(q.maxItems, 60, 1, 500);
	// `maxPrice` is an atomic cap. Reject a malformed one here: inside the bazaar
	// lane's own try it would be swallowed as an outage and report an empty board
	// (`empty:true`) while 500+ real services exist, a dishonest empty state.
	if (q.maxPrice != null && parseAtomicAmount(q.maxPrice) === null) {
		return error(res, 400, 'validation_error', 'maxPrice must be an atomic integer amount (e.g. 10000 = 0.01 USDC)');
	}

	// Lane 1 — open AgenC tasks (projected from real on-chain postings + hires).
	// The "still open" predicate is PER TYPE: an Exclusive posting closes on its
	// first claim; a multi-worker Arena / Guild stays live through its claims and
	// per-contributor completions and closes only on a whole-task `settled` (or
	// cancel / expire / slash). `workers_current` counts the distinct citizens who
	// have engaged (claimed) so the board can show the fill (current/max) — this
	// keeps a live race/guild visible-and-watchable while it fills.
	const openTasks = await sql`
		select a.kind, a.task_pda, a.task_id, a.profession, a.amount_atomic, a.reward_mint,
		       a.reward_label, a.narrative, a.created_at, a.tx_signature, a.meta,
		       c.id as creator_id, c.display_name as creator_name, c.agenc_cluster,
		       (select count(distinct cl.citizen_id) from agora_activity cl
		         where cl.task_pda = a.task_pda and cl.kind = 'claimed_task')::int as workers_current
		from agora_activity a
		join agora_citizens c on c.id = a.citizen_id
		where a.kind in ('posted_task', 'hired')
		  and a.task_pda is not null
		  and a.created_at > now() - interval '7 days'
		  and not exists (
		      select 1 from agora_activity x
		      where x.task_pda = a.task_pda
		        and x.created_at >= a.created_at
		        and x.kind = any(
		          case when coalesce(a.meta->>'taskType', 'Exclusive') in ('Competitive', 'Collaborative')
		            then ${MULTI_TERMINAL_KINDS}::text[]
		            else ${EXCLUSIVE_TERMINAL_KINDS}::text[]
		          end
		        )
		  )
		order by a.created_at desc
		limit 200
	`;

	const tasks = openTasks.map((t) => {
		const taskType = t.meta?.taskType ?? 'Exclusive';
		const maxWorkers = Number(t.meta?.maxWorkers ?? 1);
		const arena = isArenaType(taskType);
		const guild = isGuildType(taskType);
		return {
			source: 'agenc',
			// A `hired` row is a sub-task another citizen posted mid-job (agent-to-agent
			// hiring); the UI can badge it and the worker can prefer/skip it, but it is a
			// first-class claimable bounty either way.
			kind: t.kind,
			hire: t.kind === 'hired',
			parentTaskPda: t.meta?.parentTaskPda ?? null,
			taskPda: t.task_pda,
			taskId: t.task_id,
			profession: t.profession,
			title: t.narrative,
			reward: {
				amountAtomic: t.amount_atomic != null ? String(t.amount_atomic) : null,
				label: t.reward_label,
				mint: t.reward_mint,
			},
			creator: { id: t.creator_id, name: t.creator_name },
			cluster: t.agenc_cluster,
			// Career-ladder gating surfaced from the posting's projection so workers
			// (and the UI) know who may claim it without re-reading the chain.
			minReputation: Number(t.meta?.minReputation ?? 0),
			requiredCapabilities: t.meta?.requiredCapabilities != null ? String(t.meta.requiredCapabilities) : null,
			taskType,
			// Arena/Guild affordances (Task 09): the board badges the social structure
			// and shows the live fill + prize; clicking opens the live race/guild view.
			isArena: arena,
			isGuild: guild,
			multiWorker: arena || guild,
			maxWorkers,
			workersCurrent: Number(t.workers_current ?? 0),
			workersLabel: maxWorkers > 1 ? `${Number(t.workers_current ?? 0)}/${maxWorkers}` : null,
			tier: t.meta?.tier ?? null,
			// Verification bounties carry the deliverable to re-derive; the worker reads
			// this as job.target and works it as the Verifier (the trust loop).
			target: t.meta?.target ?? null,
			postedAt: t.created_at,
			txSignature: t.tx_signature,
			taskUrl: t.task_pda
				? `/api/agenc/get-task?taskPda=${t.task_pda}&cluster=${t.agenc_cluster || 'devnet'}&lifecycle=1`
				: null,
			// The live multi-worker view (roster + settlement) for the Arena/Guild panel.
			liveUrl: (arena || guild) && t.task_pda
				? `/api/agora/task?taskPda=${t.task_pda}&cluster=${t.agenc_cluster || 'devnet'}`
				: null,
		};
	});

	// Lane 2 — x402 bazaar services as claimable Fetcher jobs (real, live).
	let services = [];
	const errors = [];
	try {
		const baz = new Bazaar();
		const result = await baz.list({ type: 'http', limit: 200, maxItems });
		let items = result.items || [];
		if (q.network) items = filterByNetwork(items, String(q.network));
		if (q.maxPrice) items = filterByMaxPrice(items, String(q.maxPrice), q.asset ? String(q.asset) : null);
		services = items.map((it) => {
			const accept = it.accepts?.[0] || null;
			return {
				source: 'x402',
				profession: 'fetcher',
				title: it.serviceName || it.toolName || it.resource,
				description: it.description || null,
				resource: it.resource,
				tags: it.tags || [],
				reward: accept
					? {
							amountAtomic: accept.amountAtomic,
							label: accept.priceLabel,
							currency: accept.asset,
							network: accept.network,
						}
					: null,
				rewardKind: 'x402_pay_to_endpoint',
				facilitator: it.facilitator,
			};
		});
		if (Array.isArray(result.errors)) errors.push(...result.errors);
	} catch (err) {
		// The board degrades gracefully — a bazaar outage drops lane 2, never 500s
		// the whole board. AgenC tasks still render.
		console.warn('[agora] bazaar lane failed:', redactSecrets(err?.message));
		errors.push({ source: 'x402', error: redactSecrets(err?.message) || 'bazaar_unavailable' });
	}

	// `maxItems` bounds the BOARD, not just each facilitator's page loop. Bazaar
	// pages per facilitator, so a union across several of them overshoots the cap
	// (573 services for maxItems=60 before this slice) and every consumer (the
	// 3D marker pool most of all) pays for a payload it never asked for. AgenC
	// tasks are the scarce lane and always keep their slots; the x402 lane fills
	// what's left, and the honest totals ship alongside so a client can say
	// "showing 60 of 573" rather than silently pretending it has everything.
	const serviceTotal = services.length;
	const serviceBudget = Math.max(0, maxItems - tasks.length);
	if (serviceTotal > serviceBudget) services = services.slice(0, serviceBudget);

	res.setHeader('cache-control', 'public, max-age=15, stale-while-revalidate=60');
	return json(res, 200, {
		ok: true,
		openTaskCount: tasks.length,
		serviceCount: services.length,
		serviceTotal,
		maxItems,
		truncated: serviceTotal > services.length,
		tasks,
		services,
		errors,
		empty: tasks.length === 0 && services.length === 0,
		fetchedAt: new Date().toISOString(),
	});
}

async function handlePulse(req, res) {
	// Population + profession breakdown from the projection.
	const [popRows, profRows, statusRows, flow24, completed24, recent, topEarners] = await Promise.all([
		sql`select count(*)::int as total,
		           count(*) filter (where kind = 'agent')::int as agents,
		           count(*) filter (where kind = 'human')::int as humans,
		           count(*) filter (where last_active_at > now() - interval '24 hours')::int as active_24h
		    from agora_citizens`,
		sql`select profession, count(*)::int as n from agora_citizens
		    where profession is not null group by profession order by n desc`,
		sql`select status, count(*)::int as n from agora_citizens group by status`,
		sql`select coalesce(sum(amount_atomic), 0) as three_atomic, count(*)::int as payouts
		    from agora_activity
		    where kind = 'earned' and reward_mint = '$THREE'
		      and created_at > now() - interval '24 hours'`,
		sql`select count(*)::int as n from agora_activity
		    where kind = 'completed_task' and created_at > now() - interval '24 hours'`,
		sql`select a.id, a.kind, a.narrative, a.reward_label, a.created_at,
		           a.task_pda, a.deliverable_url, c.id as citizen_id, c.display_name as actor, c.profession
		    from agora_activity a join agora_citizens c on c.id = a.citizen_id
		    order by a.created_at desc limit 12`,
		sql`select id, display_name, profession, reputation, earned_three_atomic, tasks_completed
		    from agora_citizens
		    where earned_three_atomic > 0
		    order by earned_three_atomic desc limit 5`,
	]);

	const pop = popRows[0] || {};
	const flow = flow24[0] || {};

	return json(res, 200, {
		ok: true,
		coin: { symbol: '$THREE', mint: THREE_MINT },
		population: {
			total: pop.total || 0,
			agents: pop.agents || 0,
			humans: pop.humans || 0,
			active24h: pop.active_24h || 0,
			byStatus: Object.fromEntries((statusRows || []).map((r) => [r.status, r.n])),
			byProfession: (profRows || []).map((r) => ({ profession: r.profession, count: r.n })),
		},
		economy: {
			tasksCompleted24h: completed24[0]?.n || 0,
			threeEarned24hAtomic: String(flow.three_atomic ?? '0'),
			payouts24h: flow.payouts || 0,
		},
		topEarners: (topEarners || []).map((r) => ({
			id: r.id,
			displayName: r.display_name,
			profession: r.profession,
			reputation: r.reputation,
			earnedThreeAtomic: String(r.earned_three_atomic ?? '0'),
			tasksCompleted: r.tasks_completed,
		})),
		recent: (recent || []).map((r) => ({
			id: r.id,
			citizenId: r.citizen_id,
			kind: r.kind,
			actor: r.actor,
			profession: r.profession,
			narrative: r.narrative,
			rewardLabel: r.reward_label,
			taskPda: r.task_pda,
			deliverableUrl: r.deliverable_url,
			at: r.created_at,
		})),
		empty: (pop.total || 0) === 0,
		fetchedAt: new Date().toISOString(),
	});
}

async function handlePassport(req, res) {
	const q = req.query || {};
	let row;
	if (q.id) {
		// agora_citizens.id is a uuid column — a non-uuid id (scanner probes send
		// arbitrary strings) would make Postgres throw 22P02 and 500. Same outcome
		// as a well-formed-but-unknown id: no such citizen.
		if (!isUuid(String(q.id))) return error(res, 404, 'not_found', 'no such citizen');
		[row] = await sql`select * from agora_citizens where id = ${String(q.id)} limit 1`;
	} else if (q.agentPda) {
		[row] = await sql`select * from agora_citizens where agenc_agent_pda = ${String(q.agentPda)} limit 1`;
	} else if (q.agentId) {
		[row] = await sql`select * from agora_citizens where agenc_agent_id = ${String(q.agentId).toLowerCase()} limit 1`;
	} else {
		return error(res, 400, 'validation_error', 'provide id, agentPda, or agentId');
	}

	if (!row) return error(res, 404, 'not_found', 'no such citizen');

	const citizen = shapeCitizen(row);

	// Live on-chain reconcile — the passport shows the chain's truth, not a stale
	// snapshot. Best-effort: an RPC hiccup falls back to the projection snapshot.
	let onchain = null;
	if (row.agenc_agent_pda) {
		try {
			// Lazy: only the passport reconcile needs the write-SDK's client builder.
			// Loading it here (not at module top) keeps board/pulse/citizens — which
			// touch no Solana program — serving even if that SDK build is unavailable.
			const { createAgenCClient } = await import('@three-ws/solana-agent');
			const cluster = row.agenc_cluster === 'mainnet' ? 'mainnet' : 'devnet';
			const client = createAgenCClient({ cluster, rpcUrl: pickRpc(cluster) });
			const agent = await getAgent(client.program, new PublicKey(row.agenc_agent_pda));
			if (agent) {
				onchain = {
					authority: agent.authority?.toBase58?.() ?? String(agent.authority),
					status: agentStatusLabel(agent.status),
					capabilities: String(agent.capabilities ?? '0'),
					endpoint: agent.endpoint,
					metadataUri: agent.metadataUri,
					stakeAmount: String(agent.stakeAmount ?? '0'),
					activeTasks: agent.activeTasks,
					reputation: agent.reputation,
					registeredAt: agent.registeredAt,
				};
			}
		} catch (err) {
			console.warn('[agora] passport on-chain read failed:', redactSecrets(err?.message));
		}
	}

	const activity = await sql`
		select id, kind, narrative, profession, task_pda, task_id, amount_atomic,
		       reward_mint, reward_label, tx_signature, proof_hash, deliverable_url,
		       rep_before, rep_after, created_at
		from agora_activity
		where citizen_id = ${row.id}
		order by created_at desc
		limit 25
	`;

	return json(res, 200, {
		ok: true,
		citizen,
		onchain,
		activity: activity.map((a) => ({
			id: a.id,
			kind: a.kind,
			narrative: a.narrative,
			profession: a.profession,
			taskPda: a.task_pda,
			taskId: a.task_id,
			amountAtomic: a.amount_atomic != null ? String(a.amount_atomic) : null,
			rewardMint: a.reward_mint,
			rewardLabel: a.reward_label,
			txSignature: a.tx_signature,
			proofHash: a.proof_hash,
			deliverableUrl: a.deliverable_url,
			repBefore: a.rep_before,
			repAfter: a.rep_after,
			at: a.created_at,
		})),
		fetchedAt: new Date().toISOString(),
	});
}

// AgenC TaskState enum → label (mirrors api/agenc/[action].js taskStateLabel).
function taskStateLabel(state) {
	const map = { 0: 'Open', 1: 'In Progress', 2: 'Pending Validation', 3: 'Completed', 4: 'Cancelled', 5: 'Disputed' };
	if (typeof state === 'number') return map[state] ?? `Unknown(${state})`;
	if (state && typeof state === 'object') {
		const key = Object.keys(state)[0];
		return key ? key[0].toUpperCase() + key.slice(1) : 'Unknown';
	}
	return state == null ? null : String(state);
}

function resolveTaskIdInput(s) {
	const t = String(s).trim();
	if (t.startsWith('0x') || t.startsWith('0X')) return Uint8Array.from(Buffer.from(t.slice(2), 'hex'));
	if (/^[0-9a-fA-F]{64}$/.test(t)) return Uint8Array.from(Buffer.from(t, 'hex'));
	return Uint8Array.from(createHash('sha256').update(t, 'utf8').digest());
}

// Shape the posting (posted_task/hired) projection row for the live view.
function shapePosting(row) {
	return {
		taskPda: row.task_pda,
		taskId: row.task_id,
		citizenId: row.citizen_id,
		poster: row.display_name,
		profession: row.profession,
		rewardLabel: row.reward_label,
		rewardAmountAtomic: row.amount_atomic != null ? String(row.amount_atomic) : null,
		rewardMint: row.reward_mint,
		taskType: row.meta?.taskType ?? 'Exclusive',
		maxWorkers: Number(row.meta?.maxWorkers ?? 1),
		minReputation: Number(row.meta?.minReputation ?? 0),
		tier: row.meta?.tier ?? null,
		createdAt: row.created_at,
		txSignature: row.tx_signature,
		cluster: row.agenc_cluster,
		narrative: row.narrative,
	};
}

// The live view of a single multi-worker task (Arena / Guild) — Task 09. Reads the
// projection roster (who engaged + their real claim/complete txs + escrow-measured
// shares) AND the on-chain lifecycle (authoritative fill, state, timeline), then
// assembles them into one honest object the race/guild view renders. On-chain read
// is best-effort: an RPC hiccup degrades to the projection, never a 500.
async function handleTaskLive(req, res) {
	const q = req.query || {};
	const cluster = pickCluster(req);

	// Resolve the task PDA. Prefer an explicit PDA; else derive from creator+taskId
	// (needs the program id, so it goes through the read client).
	let pda;
	let client = null;
	try {
		const { createAgenCClient } = await import('@three-ws/solana-agent');
		client = createAgenCClient({ cluster, rpcUrl: pickRpc(cluster) });
	} catch (err) {
		// SDK dist unavailable — we can still serve the projection if a PDA was given.
		console.warn('[agora] task-live: SDK client unavailable, projection-only:', redactSecrets(err?.message));
	}
	try {
		if (q.taskPda) {
			pda = new PublicKey(String(q.taskPda).trim());
		} else if (q.creator && q.taskId && client) {
			const creator = new PublicKey(String(q.creator).trim());
			pda = deriveTaskPda(creator, resolveTaskIdInput(q.taskId), client.programId);
		} else {
			return error(res, 400, 'validation_error', 'provide taskPda (or creator + taskId with the SDK available)');
		}
	} catch (err) {
		return error(res, 400, 'validation_error', err.message);
	}
	const pdaStr = pda.toBase58();

	// Projection: the posting + every engagement row for this task.
	const [postingRows, activityRows] = await Promise.all([
		sql`
			select a.task_pda, a.task_id, a.citizen_id, a.profession, a.amount_atomic, a.reward_mint,
			       a.reward_label, a.narrative, a.created_at, a.tx_signature, a.meta,
			       c.display_name, c.agenc_cluster
			from agora_activity a
			join agora_citizens c on c.id = a.citizen_id
			where a.task_pda = ${pdaStr} and a.kind in ('posted_task', 'hired')
			order by a.created_at asc
			limit 1
		`,
		sql`
			select a.kind, a.citizen_id, a.profession, a.amount_atomic, a.reward_mint, a.reward_label,
			       a.tx_signature, a.proof_hash, a.deliverable_url, a.created_at, a.meta,
			       c.display_name, c.avatar_url
			from agora_activity a
			join agora_citizens c on c.id = a.citizen_id
			where a.task_pda = ${pdaStr}
			  and a.kind in ('claimed_task', 'completed_task', 'earned', 'stood_down', 'settled')
			order by a.created_at asc
			limit 200
		`,
	]);

	const posting = postingRows[0] ? shapePosting(postingRows[0]) : null;

	// On-chain lifecycle (authoritative fill + timeline). Best-effort.
	let chain = null;
	if (client) {
		try {
			const summary = await getTaskLifecycleSummary(client.program, pda);
			if (summary) {
				chain = {
					currentState: taskStateLabel(summary.currentState),
					currentWorkers: summary.currentWorkers,
					maxWorkers: summary.maxWorkers,
					createdAt: summary.createdAt,
					deadline: summary.deadline,
					completedAt: summary.completedAt,
					isExpired: !!summary.isExpired,
					rewardAmount: summary.rewardAmount != null ? String(summary.rewardAmount) : null,
					rewardMint: summary.rewardMint ? summary.rewardMint.toBase58?.() ?? String(summary.rewardMint) : null,
					timeline: (summary.timeline || []).map((e) => ({
						eventName: e.eventName,
						timestamp: e.timestamp,
						txSignature: e.txSignature ?? null,
						actor: e.actor ? e.actor.toBase58?.() ?? String(e.actor) : null,
					})),
				};
			}
		} catch (err) {
			console.warn('[agora] task-live on-chain read failed:', redactSecrets(err?.message));
		}
	}

	// Map the raw activity rows into the shape the assembler expects (parsed meta).
	const rows = activityRows.map((r) => ({
		kind: r.kind,
		citizen_id: r.citizen_id,
		display_name: r.display_name,
		profession: r.profession,
		avatar_url: r.avatar_url,
		tx_signature: r.tx_signature,
		proof_hash: r.proof_hash,
		deliverable_url: r.deliverable_url,
		amount_atomic: r.amount_atomic,
		reward_label: r.reward_label,
		reward_mint: r.reward_mint,
		created_at: r.created_at,
		meta: r.meta || {},
	}));

	const view = assembleTaskLive({ taskPda: pdaStr, cluster, posting, activityRows: rows, chain });

	if (!posting && !chain && view.roster.length === 0) {
		return json(res, 404, { ok: false, error: 'not_found', taskPda: pdaStr, cluster });
	}

	res.setHeader('cache-control', 'public, max-age=4, stale-while-revalidate=15');
	return json(res, 200, { ok: true, ...view, fetchedAt: new Date().toISOString() });
}

const HANDLERS = {
	citizens: { methods: ['GET'], fn: handleCitizens },
	board: { methods: ['GET'], fn: handleBoard },
	pulse: { methods: ['GET'], fn: handlePulse },
	passport: { methods: ['GET'], fn: handlePassport },
	task: { methods: ['GET'], fn: handleTaskLive },
};

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: false })) return;
	const action = String(req.query?.action || '').toLowerCase();
	const route = HANDLERS[action];
	if (!route) return error(res, 404, 'not_found', `unknown action "${action}"`);
	if (!method(req, res, route.methods)) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	try {
		return await route.fn(req, res);
	} catch (err) {
		console.error('[agora] unexpected error', redactSecrets(err?.message));
		return serverError(res, 500, 'agora_error', err);
	}
});
