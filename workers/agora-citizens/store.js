// agora-citizens — projection sink. The worker runs OUTSIDE api/, so it owns its
// own Neon client (not api/_lib/db.js) and its own Upstash Redis client mirroring
// api/_lib/redis.js — the SAME `feed:events` bus the serverless API + multiplayer
// server write to. Every write here is a PROJECTION of a real on-chain action:
// agora_activity rows cite a tx_signature / task_pda, and citizen snapshots are
// the last synced view of the chain (which stays authoritative for reputation,
// stake, and status).
//
// Idempotency: agora_activity has a unique index on (citizen_id, kind,
// tx_signature) where tx_signature is not null — re-running the engine never
// double-projects an on-chain action. Activities without a tx (registered-on-
// reconcile) are guarded by an explicit existence check.

import { neon } from '@neondatabase/serverless';
import { Redis } from '@upstash/redis';
import { log } from './log.js';
import { ALLOWED_TYPES } from '../../api/_lib/feed.js';

const FEED_KEY = 'feed:events';
const FEED_MAX = 200; // matches api/_lib/feed.js MAX_EVENTS

let _seq = 0;
function feedEventId(ts) {
	_seq = (_seq + 1) % 1_000_000;
	return `${ts.toString(36)}-${_seq.toString(36)}`;
}

function makeRedis(cfg) {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) return null;
	return new Redis({ url, token });
}

export function makeStore(cfg) {
	// Dry runs and DB-less smoke tests can skip the Neon client; the engine never
	// writes in dry-run mode, so a null sql is fine there.
	const sql = cfg.databaseUrl ? neon(cfg.databaseUrl) : null;
	const redis = cfg.dryRun ? null : makeRedis(cfg);

	function requireSql() {
		if (!sql) throw new Error('[agora-citizens] DATABASE_URL not configured (required for non-dry writes)');
		return sql;
	}

	return {
		hasRedis: !!redis,

		/**
		 * Real platform agents to seed citizens from. Prefer public, non-deleted
		 * agents with a usable name (agent_identities has no is_template column;
		 * is_public is the visibility gate).
		 * Empty on a fresh DB — the roster then fills with standalone citizens.
		 */
		async listSeedAgents(limit) {
			if (!sql) return [];
			try {
				const rows = await sql`
					select id, name, avatar_url, profile_image_url, erc8004_agent_id, meta
					from agent_identities
					where deleted_at is null
					  and is_public = true
					  and length(coalesce(name, '')) > 0
					order by created_at asc
					limit ${Math.max(0, Number(limit) || 0)}
				`;
				return rows || [];
			} catch (err) {
				log.warn('listSeedAgents failed — falling back to standalone roster', { err: err?.message });
				return [];
			}
		},

		/**
		 * Real platform agents that carry a RIGGED humanoid GLB avatar: the ones that
		 * can actually walk the Commons as citizens. Joins the avatar record and keeps
		 * only public, humanoid (model_category='avatar'), publicly-resolvable models
		 * with a stored GLB. De-duped to ONE agent per distinct avatar (many agents
		 * are forks/drafts of the same model — seeding all of them would fill the
		 * square with clones), then ordered by popularity so the nicest, most-varied
		 * avatars fill the world first. Population source for the world-seed (seed.js):
		 * each becomes a citizen with its REAL avatar; nothing is invented. Returns []
		 * on a fresh DB.
		 */
		async listRiggedSeedAgents(limit) {
			if (!sql) return [];
			try {
				const rows = await sql`
					select t.id, t.name, t.avatar_id, t.erc8004_agent_id,
					       t.category, t.tags, t.voice_id, t.voice_provider, t.meta
					from (
						select distinct on (a.avatar_id)
						       a.id, a.name, a.avatar_id, a.erc8004_agent_id,
						       a.category, a.tags, a.voice_id, a.voice_provider, a.meta,
						       coalesce(av.view_count, 0) as vc, a.created_at
						from agent_identities a
						join avatars av on av.id = a.avatar_id
						where a.deleted_at is null
						  and a.is_public = true
						  and av.deleted_at is null
						  and av.storage_key is not null
						  and av.model_category = 'avatar'
						  and av.visibility = 'public'
						  and length(coalesce(a.name, '')) > 0
						order by a.avatar_id, coalesce(av.view_count, 0) desc, a.created_at asc
					) t
					order by t.vc desc, t.created_at asc
					limit ${Math.max(0, Number(limit) || 0)}
				`;
				return rows || [];
			} catch (err) {
				log.warn('listRiggedSeedAgents failed', { err: err?.message });
				return [];
			}
		},

		/**
		 * Remove world-seeded citizens that have NOT registered on-chain yet
		 * (agenc_agent_pda is null and meta.seedMode='world'). Lets a re-seed refresh
		 * the population cleanly — swapping in a more varied/distinct-avatar set —
		 * without ever touching a citizen that has a real on-chain PDA or a human.
		 * Returns the number of rows removed.
		 */
		async clearUnregisteredWorldSeed() {
			const db = requireSql();
			const rows = await db`
				delete from agora_citizens
				where kind = 'agent'
				  and agenc_agent_pda is null
				  and coalesce(meta->>'seedMode', '') = 'world'
				returning id
			`;
			return rows.length;
		},

		/**
		 * Seed a real rigged agent into the world as a citizen WITHOUT an on-chain
		 * registration (agenc_agent_pda stays null, so the API/world render it as
		 * "pending registration"). Keyed on agent_id (one citizen per platform agent),
		 * so re-seeding refreshes the avatar/profession without duplicating or
		 * clobbering a later on-chain PDA. No activity row is projected: the citizen
		 * simply exists and idles until the funded life-engine registers it and it
		 * starts working. Returns { id, registered }.
		 */
		async seedWorldCitizen(spec, info) {
			const db = requireSql();
			const meta = JSON.stringify({
				identityHint: spec.identityHint,
				identitySource: info.identitySource,
				home: spec.home,
				seedMode: 'world',
			});
			const rows = await db`
				insert into agora_citizens (
					kind, agent_id, display_name, avatar_id, avatar_url,
					agenc_agent_id, agenc_cluster, identity_source,
					profession, capability_bits, status,
					home_x, home_z, pos_x, pos_z, last_active_at, meta
				) values (
					${spec.kind}, ${spec.agentDbId}, ${spec.displayName}, ${info.avatarId}, ${info.avatarUrl},
					${info.agentIdHex}, ${cfg.cluster}, ${info.identitySource},
					${spec.profession}, ${info.capabilityBits.toString()}, 'idle',
					${spec.home.x}, ${spec.home.z}, ${spec.home.x}, ${spec.home.z}, now(), ${meta}::jsonb
				)
				on conflict (agent_id) where agent_id is not null do update set
					display_name = excluded.display_name,
					avatar_id = coalesce(excluded.avatar_id, agora_citizens.avatar_id),
					avatar_url = coalesce(excluded.avatar_url, agora_citizens.avatar_url),
					agenc_agent_id = coalesce(agora_citizens.agenc_agent_id, excluded.agenc_agent_id),
					identity_source = coalesce(agora_citizens.identity_source, excluded.identity_source),
					profession = excluded.profession,
					capability_bits = excluded.capability_bits,
					last_active_at = now(),
					meta = agora_citizens.meta || ${meta}::jsonb
				returning id, (agenc_agent_pda is not null) as registered
			`;
			return rows[0] || null;
		},

		/**
		 * Upsert a citizen by its deterministic on-chain PDA (the stable key — the
		 * same agent always derives the same PDA). Returns the citizen row id.
		 */
		async upsertCitizen(spec, info) {
			const db = requireSql();
			const meta = JSON.stringify({
				identityHint: spec.identityHint,
				identitySource: info.identitySource,
				identityLabel: info.identityLabel,
				home: spec.home,
			});
			const rows = await db`
				insert into agora_citizens (
					kind, agent_id, display_name, avatar_url,
					agenc_agent_id, agenc_agent_pda, agenc_cluster, identity_source,
					profession, capability_bits, status,
					home_x, home_z, pos_x, pos_z,
					reputation, stake_lamports, synced_at, last_active_at, meta
				) values (
					${spec.kind}, ${spec.agentDbId}, ${spec.displayName}, ${spec.avatarUrl},
					${info.agentIdHex}, ${info.agentPda}, ${cfg.cluster}, ${info.identitySource},
					${spec.profession}, ${info.capabilityBits.toString()}, ${info.status || 'idle'},
					${spec.home.x}, ${spec.home.z}, ${spec.home.x}, ${spec.home.z},
					${info.reputation ?? 0}, ${String(info.stakeLamports ?? 0)}, now(), now(), ${meta}::jsonb
				)
				on conflict (agenc_agent_pda) where agenc_agent_pda is not null do update set
					agent_id = coalesce(excluded.agent_id, agora_citizens.agent_id),
					display_name = excluded.display_name,
					avatar_url = coalesce(excluded.avatar_url, agora_citizens.avatar_url),
					agenc_agent_id = excluded.agenc_agent_id,
					identity_source = excluded.identity_source,
					profession = excluded.profession,
					capability_bits = excluded.capability_bits,
					reputation = excluded.reputation,
					stake_lamports = excluded.stake_lamports,
					synced_at = now(),
					last_active_at = now(),
					meta = agora_citizens.meta || ${meta}::jsonb
				returning id
			`;
			return rows[0]?.id;
		},

		/** Has this (citizen, kind) already been projected for this tx? */
		async activityExists(citizenId, kind, txSignature) {
			if (!sql) return false;
			if (txSignature) {
				const r = await sql`
					select 1 from agora_activity
					where citizen_id = ${citizenId} and kind = ${kind} and tx_signature = ${txSignature}
					limit 1
				`;
				return r.length > 0;
			}
			const r = await sql`
				select 1 from agora_activity
				where citizen_id = ${citizenId} and kind = ${kind} and tx_signature is null
				limit 1
			`;
			return r.length > 0;
		},

		/**
		 * Has this citizen already got a row of `kind` for this task PDA? Idempotency
		 * for tx-less multi-worker projections (an Arena stand-down has no winning tx
		 * to dedup on — the loss is the ABSENCE of a completion), so re-running the
		 * loop never double-projects a citizen standing down from the same race.
		 */
		async taskActivityExists(citizenId, taskPda, kind) {
			if (!sql) return false;
			const r = await sql`
				select 1 from agora_activity
				where citizen_id = ${citizenId} and task_pda = ${taskPda} and kind = ${kind}
				limit 1
			`;
			return r.length > 0;
		},

		/**
		 * The display name of the citizen who WON an Arena (the accepted first proof)
		 * for this task PDA, or null. Reads the `settled`/won `completed_task` row the
		 * winner's own tick projected — an honest attribution, never a client guess.
		 * `excludeCitizenId` skips the caller (the loser asking who beat it).
		 */
		async winnerNameForTask(taskPda, excludeCitizenId = null) {
			if (!sql) return null;
			const rows = await sql`
				select c.display_name
				from agora_activity a
				join agora_citizens c on c.id = a.citizen_id
				where a.task_pda = ${taskPda}
				  and (a.kind = 'settled' or (a.kind = 'completed_task' and a.meta->>'outcome' = 'won'))
				  and (${excludeCitizenId}::text is null or a.citizen_id <> ${excludeCitizenId})
				order by a.created_at asc
				limit 1
			`;
			return rows[0]?.display_name ?? null;
		},

		/**
		 * A recent peer deliverable nobody has verified yet — the Verifier's work
		 * queue. Returns a completed_task by ANOTHER citizen that has a
		 * re-downloadable deliverable_url + an on-chain proof_hash and no `vouched`
		 * row yet, or null. Powers the trust loop: a patron posts a verification
		 * bounty against this, a Verifier claims it and re-derives the proof.
		 */
		async recentUnverifiedDeliverable({ excludeCitizenId } = {}) {
			if (!sql || !excludeCitizenId) return null;
			const rows = await sql`
				select a.task_pda, a.proof_hash, a.deliverable_url, a.citizen_id, a.profession
				from agora_activity a
				where a.kind = 'completed_task'
				  and a.deliverable_url is not null
				  and a.proof_hash is not null
				  and a.task_pda is not null
				  and a.citizen_id <> ${excludeCitizenId}
				  and a.created_at > now() - interval '2 hours'
				  and not exists (
				    select 1 from agora_activity v
				    where v.task_pda = a.task_pda and v.kind = 'vouched'
				  )
				order by a.created_at desc
				limit 1
			`;
			const r = rows[0];
			if (!r) return null;
			return {
				taskPda: r.task_pda,
				proofHash: r.proof_hash,
				deliverableUrl: r.deliverable_url,
				citizenId: r.citizen_id,
				profession: r.profession,
			};
		},

		/**
		 * Append an activity row (idempotent on tx_signature). Returns the new row
		 * id, or null if it already existed. Every caller passes a non-empty
		 * narrative — an activity with no story isn't worth recording.
		 */
		async appendActivity(a) {
			const db = requireSql();
			const rows = await db`
				insert into agora_activity (
					citizen_id, kind, task_pda, task_id, profession, counterparty_citizen_id,
					amount_atomic, reward_mint, reward_label,
					tx_signature, proof_hash, deliverable_url,
					narrative, rep_before, rep_after, world_x, world_z, meta
				) values (
					${a.citizenId}, ${a.kind}, ${a.taskPda ?? null}, ${a.taskId ?? null}, ${a.profession ?? null},
					${a.counterpartyCitizenId ?? null},
					${a.amountAtomic != null ? String(a.amountAtomic) : null}, ${a.rewardMint ?? null}, ${a.rewardLabel ?? null},
					${a.txSignature ?? null}, ${a.proofHash ?? null}, ${a.deliverableUrl ?? null},
					${a.narrative}, ${a.repBefore ?? null}, ${a.repAfter ?? null},
					${a.worldX ?? null}, ${a.worldZ ?? null}, ${JSON.stringify(a.meta || {})}::jsonb
				)
				on conflict (citizen_id, kind, tx_signature) where tx_signature is not null
				do nothing
				returning id
			`;
			return rows[0]?.id ?? null;
		},

		/** Advance a citizen's world + economy snapshot after a real action. */
		async updateCitizen(citizenId, patch) {
			const db = requireSql();
			await db`
				update agora_citizens set
					status = coalesce(${patch.status ?? null}, status),
					reputation = coalesce(${patch.reputation ?? null}, reputation),
					stake_lamports = coalesce(${patch.stakeLamports != null ? String(patch.stakeLamports) : null}, stake_lamports),
					earned_three_atomic = earned_three_atomic + ${patch.earnedDelta != null ? String(patch.earnedDelta) : '0'},
					tasks_completed = tasks_completed + ${Math.max(0, Number(patch.tasksCompletedDelta || 0))},
					tasks_posted = tasks_posted + ${Math.max(0, Number(patch.tasksPostedDelta || 0))},
					pos_x = coalesce(${patch.posX ?? null}, pos_x),
					pos_z = coalesce(${patch.posZ ?? null}, pos_z),
					synced_at = case when ${patch.synced ? true : false} then now() else synced_at end,
					last_active_at = now()
				where id = ${citizenId}
			`;
		},

		/** Lightweight status/position write for the IDLE/SEEK/BUSY transitions. */
		async setStatus(citizenId, status, pos) {
			const db = requireSql();
			await db`
				update agora_citizens set
					status = ${status},
					pos_x = coalesce(${pos?.x ?? null}, pos_x),
					pos_z = coalesce(${pos?.z ?? null}, pos_z),
					last_active_at = now()
				where id = ${citizenId}
			`;
		},

		/**
		 * Publish an event onto the shared `feed:events` bus (newest-first capped
		 * list — identical shape + write path to api/_lib/feed.js). Best-effort:
		 * a Redis outage degrades to no ticker line, never a thrown error.
		 */
		async publishFeed(event) {
			if (!redis || !event || !event.type) return null;
			// One vocabulary, one source of truth: GET /api/feed drops any type the
			// API's ALLOWED_TYPES doesn't carry, so emitting one here would be a
			// silent dead end. Fail loudly in the log instead of on the ticker.
			if (!ALLOWED_TYPES.has(event.type)) {
				log.warn('feed type not in api/_lib/feed.js ALLOWED_TYPES, dropped', { type: event.type });
				return null;
			}
			const ts = Number.isFinite(event.ts) ? event.ts : Date.now();
			const record = { ...event, ts, id: event.id || feedEventId(ts) };
			try {
				await redis.lpush(FEED_KEY, JSON.stringify(record));
				await redis.ltrim(FEED_KEY, 0, FEED_MAX - 1);
				return record;
			} catch (err) {
				log.warn('feed publish failed', { err: err?.message, type: event.type });
				return null;
			}
		},

		/** Liveness heartbeat into the shared bot_heartbeat table. */
		async heartbeat(meta) {
			if (!sql) return;
			try {
				await sql`
					insert into bot_heartbeat (worker, mode, last_beat_at, meta)
					values ('agora-citizens', ${cfg.cluster}, now(), ${JSON.stringify(meta || {})}::jsonb)
					on conflict (worker) do update
					set mode = excluded.mode, last_beat_at = excluded.last_beat_at, meta = excluded.meta
				`;
			} catch (err) {
				log.warn('heartbeat write failed', { err: err?.message });
			}
		},
	};
}
