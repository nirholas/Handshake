// agora-citizens — the demand generator (Task 03). The SPEND node of the daily
// loop, made real: a patron citizen with a budget posts bounties on an interval,
// and a citizen working a high-value job hires a sub-agent (true agent-to-agent
// hiring). Both pay out of a REAL balance, so when a citizen exhausts its budget
// it stops posting — honest scarcity, never an infinite tap.
//
// This bridges policy.js (pure decisions) and post.js (real escrowed bounties):
// it reads live balances, applies the policy, and posts only when the policy says
// go. The patron's "budget" is a bounded allowance over its real balance — the
// on-chain balance is the hard gate (it matters most on mainnet $THREE, where no
// faucet refills it), the allowance bounds devnet posting so it's visibly finite.

import { PublicKey } from '@solana/web3.js';
import { decidePatronPost, decideHire, REPUTATION_BASELINE } from './policy.js';
import { postBounty } from './post.js';
import { log } from './log.js';

// Fee/rent reserve never spent on rewards (devnet lamports). A claim/complete
// pays fees and AgenC locks rent for the task account; keep headroom so posting a
// bounty can't strand a citizen unable to pay for its own work.
const FEE_HEADROOM_LAMPORTS = 12_000_000n; // 0.012 SOL

function bigEnv(name, def) {
	const raw = (process.env[name] || '').trim();
	if (!raw) return def;
	try {
		return BigInt(raw);
	} catch {
		return def;
	}
}
function intEnv(name, def) {
	const n = Number(process.env[name]);
	return Number.isFinite(n) ? n : def;
}
function boolEnv(name, def) {
	const raw = process.env[name];
	if (raw == null || raw === '') return def;
	return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

/** Is agent-to-agent hiring enabled? Default on for devnet. */
export function hiringEnabled(cfg) {
	return boolEnv('AGORA_ENABLE_HIRING', cfg.cluster === 'devnet');
}

/** Reward a worker offers when hiring a sub-agent (cluster reward unit, atomic). */
export function subtaskReward(cfg) {
	return bigEnv('AGORA_SUBTASK_REWARD_ATOMIC', BigInt(cfg.taskRewardLamports));
}

/**
 * The patron's tier schedule — the visible career ladder. Rewards scale with the
 * reputation gate so high-rep work pays more (docs: README § Reputation ladder).
 * Authored in the cluster's reward unit (devnet lamports; mainnet would override
 * via env). profession is Fetcher — the one profession every citizen carries, so
 * an Arena/Guild always has a full field of eligible racers/contributors.
 *
 * The rotation is mostly single-worker Exclusive work with the occasional Arena
 * (Competitive) and Guild (Collaborative) rung woven in (Task 09), so the board
 * regularly lights up with a live race or a filling guild without drowning the
 * everyday labour market. Each tier's taskType/maxWorkers flow straight through
 * decidePatronPost → postBounty → createTask.
 */
export function defaultPatronTiers(cfg) {
	const base = BigInt(cfg.taskRewardLamports); // devnet: 0.001 SOL default
	// minReputation is omitted on purpose: decidePatronPost fills it from
	// REPUTATION_LADDER, so the ladder in policy.js stays the single source of
	// truth for what each tier gates on. Restating the numbers here is how they
	// drifted into being absolutes that gate nothing.
	const tiers = [
		{ tier: 'apprentice', profession: 'fetcher', rewardAtomic: base },
		{ tier: 'apprentice', profession: 'fetcher', rewardAtomic: base },
		{ tier: 'journeyman', profession: 'fetcher', rewardAtomic: base * 2n },
	];
	// Arena — a Competitive purse several citizens race for; the first valid proof
	// takes the WHOLE escrow. Gated on reputation so a juicy purse belongs to
	// proven racers (the "single entrant" edge case is honest: if only one clears
	// the gate, it's a one-runner race that still settles for real).
	if (cfg.enableArena) {
		tiers.push({
			tier: 'arena',
			profession: 'fetcher',
			rewardAtomic: base * BigInt(cfg.arenaRewardMultiplier ?? 6),
			// A delta above the registration baseline, like every ladder gate.
			minReputation: REPUTATION_BASELINE + (cfg.arenaMinReputation ?? 0),
			taskType: 'Competitive',
			maxWorkers: cfg.arenaMaxWorkers ?? 3,
		});
	}
	tiers.push({ tier: 'master', profession: 'fetcher', rewardAtomic: base * 4n });
	// Guild — a Collaborative pool that SPLITS across contributors. Open entry work
	// (minReputation 0) so newcomers can contribute a real part and climb.
	if (cfg.enableGuild) {
		tiers.push({
			tier: 'guild',
			profession: 'fetcher',
			rewardAtomic: base * BigInt(cfg.guildRewardMultiplier ?? 6),
			minReputation: 0,
			taskType: 'Collaborative',
			maxWorkers: cfg.guildMaxWorkers ?? 3,
		});
	}
	return tiers;
}

/**
 * Designate patrons in the fleet and attach their budget + tracking state. By
 * default the first AGORA_PATRON_COUNT citizens become patrons (they still work
 * jobs themselves — a patron is also a Fetcher). The budget is a bounded
 * allowance so devnet demand is visibly finite. Mutates the citizen objects.
 */
export function markPatrons(citizens, cfg) {
	const count = Math.max(0, Math.min(intEnv('AGORA_PATRON_COUNT', 1), citizens.length));
	const budgetAtomic = bigEnv('AGORA_PATRON_BUDGET_ATOMIC', BigInt(cfg.taskRewardLamports) * 30n);
	const minPostIntervalMs = Math.max(5_000, intEnv('AGORA_PATRON_POST_INTERVAL_MS', 90_000));
	const tiers = defaultPatronTiers(cfg);
	for (let i = 0; i < count; i++) {
		const c = citizens[i];
		c.patron = { tiers, budgetAtomic, minPostIntervalMs };
		c.postedSpentAtomic = 0n;
		c.lastPostAt = 0;
		c.lastVerifyPostAt = 0;
		c.postedCount = 0;
		log.info('patron designated', {
			citizen: c.spec.displayName,
			budgetAtomic: budgetAtomic.toString(),
			intervalMs: minPostIntervalMs,
		});
	}
	return count;
}

// Spendable reward balance for a poster, in the cluster's reward unit (atomic).
async function onchainBalance(cfg, connection, walletPubkey) {
	if (cfg.cluster === 'mainnet') {
		const tokenAccount = (process.env.AGORA_THREE_TOKEN_ACCOUNT || '').trim();
		if (!tokenAccount) return 0n;
		try {
			const bal = await connection.getTokenAccountBalance(new PublicKey(tokenAccount));
			return BigInt(bal?.value?.amount ?? '0');
		} catch (err) {
			log.warn('token balance read failed', { err: err?.message });
			return 0n;
		}
	}
	try {
		return BigInt(await connection.getBalance(walletPubkey));
	} catch (err) {
		log.warn('balance read failed', { err: err?.message });
		return 0n;
	}
}

// Headroom only applies to the native-SOL devnet path (reward unit == fee unit).
function headroomFor(cfg) {
	return cfg.cluster === 'mainnet' ? 0n : FEE_HEADROOM_LAMPORTS;
}

// Mainnet escrow spend cap (Task 03 guardrail — escrow is real money). Cumulative
// $THREE atomic this process may post; 0/unset blocks mainnet posting entirely.
function mainnetSpendCapAtomic() {
	return bigEnv('AGORA_MAINNET_SPEND_CAP_ATOMIC', 0n);
}
let _spentThisRunAtomic = 0n;
function withinSpendCap(cfg, rewardAtomic) {
	if (cfg.cluster !== 'mainnet') return true;
	const cap = mainnetSpendCapAtomic();
	if (cap <= 0n) {
		log.warn('mainnet post blocked — set AGORA_MAINNET_SPEND_CAP_ATOMIC to enable $THREE escrow');
		return false;
	}
	if (_spentThisRunAtomic + BigInt(rewardAtomic) > cap) {
		log.warn('mainnet spend cap reached', { cap: cap.toString(), spent: _spentThisRunAtomic.toString() });
		return false;
	}
	return true;
}

/**
 * Patron demand: maybe post a bounty this tick. Reads the citizen's REAL balance,
 * caps it by the remaining allowance, and posts only if the policy clears it.
 * Updates the citizen's spend/interval tracking on success.
 *
 * @returns {object|null} the post result, or null if the policy held.
 */
export async function maybePatronPost(ctx, citizen) {
	const { cfg, store } = ctx;
	if (!citizen?.patron) return null;

	const bal = await onchainBalance(cfg, citizen.client.connection, citizen.signer.publicKey);
	const remainingBudget = citizen.patron.budgetAtomic - citizen.postedSpentAtomic;
	// Effective budget is the lesser of the real balance and the remaining
	// allowance — when either is exhausted, scarcity kicks in and posting stops.
	const effectiveBalance = bal < remainingBudget ? bal : remainingBudget;

	const decision = decidePatronPost({
		citizen,
		now: Date.now(),
		lastPostAt: citizen.lastPostAt,
		balanceAtomic: effectiveBalance,
		headroomAtomic: headroomFor(cfg),
		postedCount: citizen.postedCount,
	});

	if (!decision.post) {
		if (decision.reason === 'insufficient_funds') {
			log.loop('patron out of budget — holding (honest scarcity)', {
				citizen: citizen.spec.displayName,
				remaining: remainingBudget.toString(),
				balance: bal.toString(),
			});
		}
		return null;
	}
	if (!withinSpendCap(cfg, decision.plan.rewardAtomic)) return null;

	if (cfg.dryRun) {
		log.loop('[dry] would post bounty', { citizen: citizen.spec.displayName, tier: decision.plan.tier });
		return null;
	}

	const result = await postBounty({
		cfg,
		store,
		client: citizen.client,
		poster: { id: citizen.id, agentIdHex: citizen.agentIdHex, displayName: citizen.spec.displayName },
		plan: decision.plan,
	});

	citizen.postedSpentAtomic += BigInt(decision.plan.rewardAtomic);
	citizen.lastPostAt = Date.now();
	citizen.postedCount += 1;
	if (cfg.cluster === 'mainnet') _spentThisRunAtomic += BigInt(decision.plan.rewardAtomic);

	log.info('bounty posted', {
		citizen: citizen.spec.displayName,
		tier: decision.plan.tier,
		minReputation: decision.plan.minReputation,
		taskPda: result.taskPda,
		reward: result.rewardLabel,
		tx: result.txSignature,
	});
	return result;
}

/** Is the autonomous trust loop (patron-posted verification bounties) enabled? */
export function verifyEnabled(cfg) {
	return boolEnv('AGORA_ENABLE_VERIFY', cfg.cluster === 'devnet');
}

/** Reward a patron offers for a verification bounty (cluster reward unit, atomic). */
function verifyReward(cfg) {
	return bigEnv('AGORA_VERIFY_REWARD_ATOMIC', BigInt(cfg.taskRewardLamports));
}

const VERIFIER_BITS = 1n << 6n; // capability bit 6 (see roster.js PROFESSIONS)

/**
 * The trust loop (Task 04 DoD): a patron posts a REAL verification bounty against
 * a recent peer deliverable nobody has checked yet. A Verifier-capable citizen
 * claims it, re-downloads the deliverable, re-derives sha256, and attests
 * pass/fail on-chain — agents checking agents' work. Fail-safe: with no
 * unverified deliverable (or no R2-stored artifacts) it simply holds, and the
 * paid-work loop is untouched.
 *
 * @returns {object|null} the post result, or null if held.
 */
export async function maybePatronVerify(ctx, citizen) {
	const { cfg, store } = ctx;
	if (!citizen?.patron || !verifyEnabled(cfg)) return null;
	const now = Date.now();
	if (now - (citizen.lastVerifyPostAt || 0) < citizen.patron.minPostIntervalMs) return null;

	// Find a peer deliverable that's re-downloadable + has an on-chain proof and
	// hasn't been vouched yet. None → hold (honest: nothing to verify).
	const target = await store.recentUnverifiedDeliverable({ excludeCitizenId: citizen.id });
	if (!target) return null;

	const reward = verifyReward(cfg);
	const bal = await onchainBalance(cfg, citizen.client.connection, citizen.signer.publicKey);
	const remainingBudget = citizen.patron.budgetAtomic - citizen.postedSpentAtomic;
	const effectiveBalance = bal < remainingBudget ? bal : remainingBudget;
	if (effectiveBalance < reward + headroomFor(cfg)) return null;
	if (!withinSpendCap(cfg, reward)) return null;

	if (cfg.dryRun) {
		log.loop('[dry] would post verification bounty', { citizen: citizen.spec.displayName, target: target.taskPda });
		return null;
	}

	const result = await postBounty({
		cfg,
		store,
		client: citizen.client,
		poster: { id: citizen.id, agentIdHex: citizen.agentIdHex, displayName: citizen.spec.displayName },
		plan: {
			profession: 'verifier',
			requiredCapabilities: VERIFIER_BITS,
			rewardAtomic: reward,
			minReputation: 0,
			taskType: 'Exclusive',
			maxWorkers: 1,
			tier: 'trust',
			// The deliverable to re-derive — flows board → job.target → runVerifier.
			target: {
				deliverableUrl: target.deliverableUrl,
				proofHash: target.proofHash,
				taskPda: target.taskPda,
				citizenId: target.citizenId,
				profession: target.profession,
			},
		},
	});

	citizen.postedSpentAtomic += BigInt(reward);
	citizen.lastVerifyPostAt = now;
	if (cfg.cluster === 'mainnet') _spentThisRunAtomic += BigInt(reward);

	log.info('verification bounty posted', {
		citizen: citizen.spec.displayName,
		verifyTask: result.taskPda,
		targetTask: target.taskPda,
		tx: result.txSignature,
	});
	return result;
}

/**
 * Sub-task hiring: a citizen working a high-value job hires a sub-agent (real
 * agent-to-agent hiring). Pays from the worker's own balance — same scarcity rule.
 *
 * @param {object} parent  { taskPda, label } the parent job being worked
 * @returns {object|null}  the hire post result, or null if held
 */
export async function maybeHire(ctx, citizen, { parent, neededProfession, subRewardAtomic }) {
	const { cfg, store } = ctx;
	const bal = await onchainBalance(cfg, citizen.client.connection, citizen.signer.publicKey);
	const decision = decideHire({
		neededProfession,
		balanceAtomic: bal,
		subRewardAtomic,
		headroomAtomic: headroomFor(cfg),
	});
	if (!decision.hire) {
		log.loop('cannot hire sub-agent — holding', { citizen: citizen.spec.displayName, reason: decision.reason });
		return null;
	}
	if (!withinSpendCap(cfg, decision.plan.rewardAtomic)) return null;
	if (cfg.dryRun) return null;

	const result = await postBounty({
		cfg,
		store,
		client: citizen.client,
		poster: { id: citizen.id, agentIdHex: citizen.agentIdHex, displayName: citizen.spec.displayName },
		plan: decision.plan,
		hire: { parentTaskPda: parent?.taskPda || null, parentLabel: parent?.label || null },
	});
	if (cfg.cluster === 'mainnet') _spentThisRunAtomic += BigInt(decision.plan.rewardAtomic);

	log.info('sub-agent hired', {
		citizen: citizen.spec.displayName,
		needs: neededProfession,
		taskPda: result.taskPda,
		tx: result.txSignature,
	});
	return result;
}

// Test/ops hook — reset the per-process mainnet spend tracker.
export function _resetSpendTracker() {
	_spentThisRunAtomic = 0n;
}
