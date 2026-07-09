// Auto-rig on create — upgrade any freshly-created static avatar into an
// animation-ready (skeleton-bearing) one, the same way Avaturn ships rigged
// avatars. The reconstruct (prompt → avatar / selfie → avatar) pipeline already
// auto-rigs inline via reconstruct-finalize.js; this brings the SAME capability
// to every OTHER way an avatar — and therefore a 3D agent — can be born: a GLB
// upload, a URL import, or a chat/MCP "text → 3D avatar" forge save. No matter
// the path, the avatar ends up able to walk, wave, and emote.
//
// The decision mirrors reconstruct-finalize's gate exactly so the two never
// diverge:
//   • Already rigged (a skeleton is present — e.g. an Avaturn export, a
//     Mixamo/VRM upload, or any skinned GLB)? Do nothing. We never re-rig a
//     usable skeleton; canonicalization at ingest already lets it drive the
//     clip library.
//   • No rerig model configured (provider.supportsMode('rerig') === false)?
//     Do nothing — the avatar stays a static mesh, exactly as before. Rigging is
//     dormant until REPLICATE_RERIG_MODEL is set.
//   • Otherwise submit a 'rerig' job tagged { auto_rig: true } against the
//     stored mesh and let the shared completion stage (the Replicate webhook and
//     the regenerate-status poll) MATERIALIZE the rigged GLB as a NEW sibling
//     avatar row (parent = the static source) when it lands, then re-point the
//     owning agent identity at it — so the agent the user already owns becomes
//     animation-ready while the original static avatar survives untouched.
//
// Why a sibling, not an in-place swap: several systems treat an avatar row as an
// immutable, content-addressed artifact keyed by its id — on-chain glTF
// attestations bind to a specific glbSha256, IPFS pins resolve a CID to specific
// bytes, and the id-keyed GLB proxy serves `immutable` cache headers on the
// premise that rotation produces a new key. Mutating the bytes under a row whose
// checksum / pin / cache still describe the old static mesh corrupts all three.
// Minting a sibling (the same model reconstruct-finalize already uses) keeps the
// source's integrity fields valid and makes the rig upgrade reversible.
//
// Best-effort by contract: maybeAutoRigAvatar never throws into its caller. A
// creation request must succeed whether or not rigging could be kicked off; the
// worst case is the avatar stays static — the identical graceful state we had
// before this existed.

import { randomUUID, createHash } from 'crypto';
import { sql } from './db.js';
import { putObject, publicUrl, presignGet } from './r2.js';
import { storageKeyFor, createAvatar } from './avatars.js';
import { getRegenProviderForMode } from './regen-provider.js';
import { inspectGlb, isValidGlbHeader } from './glb-inspect.js';
import { dispatchWebhooks } from './webhook-dispatch.js';
import { limits } from './rate-limit.js';
import { isAutoRigEligible } from './auto-rig-eligibility.js';
// Single source of truth for the humanoid classifier (one declaration of the
// term lists, in the MCP tool). Imported directly so the API reuses the exact
// gate forge_avatar already runs before paid work — the module is dependency-free
// and synchronous, so it bundles cleanly into the Vercel function.
import { classifyHumanoidPrompt } from '../../mcp-server/src/tools/_humanoid.js';
// The rigged GLB returned by the provider is fetched through the shared guard:
// host allowlist + IP-pinned SSRF connect + the single 64 MB ceiling (MAX_GLB_BYTES
// now lives there, no longer duplicated here). No bare fetch() of a provider URL
// remains in this file.
import { fetchProviderGlbBuffer } from './provider-result-url.js';

// Does this rig signal indicate a usable skeleton? Mirrors classifyRig
// (src/shared/rig-classify.js) on the snake_case source_meta shape so the
// server-side gate and the client-side badge agree on what "rigged" means.
export function rigInfoIsRigged(rigInfo) {
	if (!rigInfo) return false;
	if (rigInfo.is_rigged === true) return true;
	const joints = rigInfo.skeleton_joint_count;
	return typeof joints === 'number' && joints > 0;
}

// Re-run bone-name + up-axis canonicalization on a rigged GLB so the new
// skeleton lands in the canonical convention the clip retargeter expects —
// identical to the canonicalization every other stored avatar gets at ingest.
async function canonicalize(buf) {
	try {
		const { canonicalizeGLBBones } = await import('../../src/glb-canonicalize.js');
		const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
		const canonical = canonicalizeGLBBones(ab);
		if (canonical.renamed > 0 || canonical.orientationCorrected) return Buffer.from(canonical.buffer);
	} catch (err) {
		console.warn('[auto-rig] canonicalize skipped:', err?.message);
	}
	return buf;
}

// Merge-stamp a few breadcrumbs onto the avatar's source_meta (never clobber the
// whole object). Used to record a skip reason or that the mesh left the platform.
// Best-effort: a stamp failure never blocks or fails the rig decision.
async function stampSourceMeta({ avatarId, userId, currentMeta, patch }) {
	try {
		const meta = { ...(currentMeta || {}), ...patch };
		await sql`
			update avatars
			set source_meta = ${JSON.stringify(meta)}::jsonb, updated_at = now()
			where id = ${avatarId} and owner_id = ${userId}
		`;
	} catch (err) {
		console.warn('[auto-rig] source_meta stamp failed:', err?.message);
	}
}

// Enforce the three spend buckets in order (per-user burst → per-user daily cost
// cap → global GPU-budget breaker). Returns a skip reason string on the first
// denial, or null when all pass. A limiter outage degrades to "skip rig" — never
// a thrown create — though the critical buckets already fail closed in prod.
async function checkRigLimits(userId) {
	try {
		const burst = await limits.rig(userId);
		if (!burst.success) return 'rate_limited';
		const daily = await limits.rigDaily(userId);
		if (!daily.success) return 'daily_cap';
		const global = await limits.rigGlobal();
		if (!global.success) return 'global_cap';
		return null;
	} catch (err) {
		console.warn('[auto-rig] rate-limit check degraded → skipping rig:', err?.message);
		return 'rate_limited';
	}
}

/**
 * Decide whether a just-created avatar should be auto-rigged and, if so, submit
 * the rerig job. Never throws — returns a small status object the caller can log
 * or ignore.
 *
 * Gates run cheapest/most-decisive first, so no paid budget is wasted: already-
 * rigged short-circuit → provider configured → in-flight idempotency → privacy
 * (private opt-out / presign) → plan/$THREE tier eligibility → humanoid
 * classification → rate limits → submit.
 *
 * @param {Object} opts
 * @param {string} opts.userId         — owner of the avatar.
 * @param {{ id: string, storage_key: string, source_meta?: Object }} opts.avatar — the created row.
 * @param {Object|null} [opts.rigInfo] — source_meta rig signal { is_rigged, skeleton_joint_count }.
 * @param {string} [opts.source]       — provenance tag for the job params (e.g. 'upload', 'studio').
 * @param {string} [opts.visibility]   — avatar visibility ('public'|'unlisted'|'private'); gates external handoff.
 * @param {string|null} [opts.prompt]  — generation prompt, classified for humanoid eligibility when present.
 * @param {string|null} [opts.plan]    — owner's subscription plan, for the eligibility gate (DB-resolved if omitted).
 * @returns {Promise<{ queued: boolean, jobId?: string, skipped?: string }>}
 */
export async function maybeAutoRigAvatar({
	userId,
	avatar,
	rigInfo,
	source = 'upload',
	visibility = 'unlisted',
	prompt = null,
	plan = null,
}) {
	try {
		if (!avatar?.id || !avatar?.storage_key) return { queued: false, skipped: 'no_avatar' };

		// Already animation-ready (Avaturn, VRM, Mixamo, any skinned GLB) — leave it.
		if (rigInfoIsRigged(rigInfo)) return { queued: false, skipped: 'already_rigged' };

		let provider;
		try {
			provider = await getRegenProviderForMode('rerig');
		} catch {
			return { queued: false, skipped: 'no_provider' };
		}
		if (!provider?.instance) return { queued: false, skipped: 'no_rig_model' };

		// Idempotency: never stack a second auto-rig job on the same avatar. A
		// retry or a double-create would otherwise race two rigged siblings off the
		// one source. If an auto_rig job for this avatar is still in flight,
		// let it finish. (Runs before any spend so a no-op never consumes budget.)
		const inFlight = await sql`
			select 1 from avatar_regen_jobs
			where source_avatar_id = ${avatar.id}
			  and mode = 'rerig'
			  and (params->>'auto_rig') = 'true'
			  and status in ('queued', 'running', 'rigging', 'finalizing')
			limit 1
		`;
		if (inFlight[0]) return { queued: false, skipped: 'already_in_flight' };

		// (5) Privacy decision. A private avatar means the owner did NOT consent to
		// shipping the mesh to a third-party rigger. Default: don't auto-rig it at
		// all. AUTO_RIG_PRIVATE=presigned opts in, and then the provider gets a
		// short-lived signed GET URL (1h) rather than a permanent public CDN URL.
		// Public/unlisted avatars are already externally reachable → public URL.
		const vis = String(visibility || 'unlisted');
		const privateMode = String(process.env.AUTO_RIG_PRIVATE || 'off').trim().toLowerCase();
		let urlKind = 'public';
		if (vis === 'private') {
			if (privateMode !== 'presigned') {
				return { queued: false, skipped: 'private_opt_out' };
			}
			urlKind = 'presigned';
		}

		// (6) Plan / $THREE holder tier eligibility — the deliberate spend lever.
		const eligible = await isAutoRigEligible({ userId, plan });
		if (!eligible) return { queued: false, skipped: 'plan_gate' };

		// (7) Humanoid eligibility. Rigging assumes a humanoid skeleton; a confident
		// non-humanoid prompt (furniture, vehicle, quadruped) would burn a paid job
		// on a garbage skeleton. Mirror forge_avatar: ONLY hard-skip on a confident
		// humanoid:false; ambiguity proceeds (the user explicitly created an avatar).
		// No prompt (raw GLB upload) → proceed; the spend caps remain the backstop.
		const promptText = typeof prompt === 'string' ? prompt.trim() : '';
		if (promptText.length >= 3) {
			const verdict = classifyHumanoidPrompt(promptText);
			if (verdict.humanoid === false) {
				await stampSourceMeta({
					avatarId: avatar.id,
					userId,
					currentMeta: avatar.source_meta,
					patch: { auto_rig_skipped: 'not_humanoid', auto_rig_skip_reason: verdict.reason },
				});
				return { queued: false, skipped: 'not_humanoid' };
			}
		} else {
			await stampSourceMeta({
				avatarId: avatar.id,
				userId,
				currentMeta: avatar.source_meta,
				patch: { auto_rig_humanoid_check: 'no_prompt' },
			});
		}

		// (8) Spend caps — per-user burst, per-user daily ceiling, global breaker.
		const limited = await checkRigLimits(userId);
		if (limited) return { queued: false, skipped: limited };

		// (9) Build the handoff URL: presigned-short-lived for an opted-in private
		// avatar, public CDN URL for an already-reachable public/unlisted one.
		let sourceUrl;
		try {
			sourceUrl =
				urlKind === 'presigned'
					? await presignGet({ key: avatar.storage_key, expiresIn: 3600 })
					: publicUrl(avatar.storage_key);
		} catch (err) {
			console.warn('[auto-rig] source url build failed:', err?.message);
			return { queued: false, skipped: 'error' };
		}

		// (10) Submit the paid rerig job.
		let submission;
		try {
			submission = await provider.instance.submit({
				userId,
				sourceAvatarId: avatar.id,
				mode: 'rerig',
				params: { auto_rig: true, source },
				sourceUrl,
				sourceStorageKey: avatar.storage_key,
			});
		} catch (err) {
			console.warn('[auto-rig] submit failed:', err?.message);
			return { queued: false, skipped: 'submit_failed' };
		}

		// (11) Record the job, and stamp a durable breadcrumb that the mesh left the
		// platform (and how) so the owner/UI has a record of the external handoff.
		const jobId = `${provider.name}-${randomUUID()}`;
		await sql`
			insert into avatar_regen_jobs
				(job_id, user_id, source_avatar_id, mode, params, status, provider, ext_job_id, created_at, updated_at)
			values
				(${jobId}, ${userId}, ${avatar.id}, ${'rerig'}, ${JSON.stringify({ auto_rig: true, source })}, 'queued', ${provider.name}, ${submission.extJobId ?? null}, now(), now())
		`;
		await stampSourceMeta({
			avatarId: avatar.id,
			userId,
			currentMeta: avatar.source_meta,
			patch: { rig_mesh_sent_external: true, rig_mesh_url_kind: urlKind },
		});
		return { queued: true, jobId };
	} catch (err) {
		// A creation flow must never fail because auto-rig couldn't start.
		console.warn('[auto-rig] maybeAutoRigAvatar error:', err?.message);
		return { queued: false, skipped: 'error' };
	}
}

/**
 * Completion stage for an auto-rig job: the rerig model finished, so fetch the
 * rigged GLB, canonicalize it, store it durably, and MATERIALIZE it as a NEW
 * sibling avatar row whose parent is the static source. The owning agent
 * identity is re-pointed from the source to the sibling, an avatar_versions
 * trail records the upgrade for reversibility, and the source row is left
 * byte-for-byte untouched so a rigging failure can never lose the user's avatar.
 * Shared by the Replicate webhook, the regenerate-status poll, and the cron
 * sweep so every completion path produces an identical sibling.
 *
 * @returns {Promise<{ status: 'done', resultAvatarId?: string }>}
 */
export async function finalizeAutoRigStage({ userId, jobId, job, glbUrl }) {
	const avatarId = job.source_avatar_id;
	const closeJob = (resultAvatarId = null, errorNote = null) =>
		sql`
			update avatar_regen_jobs
			set result_avatar_id = ${resultAvatarId},
			    status = 'done',
			    error = ${errorNote},
			    updated_at = now()
			where job_id = ${jobId} and user_id = ${userId}
		`;

	// Concurrency claim across the racing callers (webhook + poll + cron — three
	// separate serverless invocations, so an in-process lock is useless). Atomically
	// move the row to 'finalizing'; the single caller whose UPDATE returns a row is
	// the winner and mints the sibling. A loser (zero rows returned) means another
	// driver already owns the job or it's already materialized — no-op WITHOUT
	// fetching the GLB or writing R2/createAvatar, so we never double-bill the
	// provider fetch or orphan a duplicate sibling. `result_avatar_id is null`
	// makes an already-completed job a clean no-op; `status <> 'finalizing'` blocks
	// a second concurrent finalizer mid-flight. This replaces the prior read-then-
	// write idempotency check, which two simultaneous callers could both pass.
	const claim = await sql`
		update avatar_regen_jobs
		set status = 'finalizing', updated_at = now()
		where job_id = ${jobId} and user_id = ${userId}
		  and result_avatar_id is null
		  and status <> 'finalizing'
		returning job_id
	`;
	if (!claim[0]) {
		// Either a sibling already exists, or another driver is finalizing right
		// now. Surface the existing sibling id if there is one; otherwise the
		// in-progress winner will set it.
		const jobRows = await sql`
			select result_avatar_id from avatar_regen_jobs
			where job_id = ${jobId} and user_id = ${userId}
			limit 1
		`;
		return jobRows[0]?.result_avatar_id
			? { status: 'done', resultAvatarId: jobRows[0].result_avatar_id }
			: { status: 'done', skipped: 'in_progress' };
	}

	try {
	if (!avatarId || !glbUrl) {
		await closeJob();
		return { status: 'done' };
	}

	const rows = await sql`
		select id, slug, name, description, storage_key, size_bytes, source_meta,
		       tags, visibility, checksum_sha256, storage_mode
		from avatars
		where id = ${avatarId} and owner_id = ${userId} and deleted_at is null
		limit 1
	`;
	if (!rows[0]) {
		// Avatar was deleted between submit and completion — nothing to upgrade.
		await closeJob(avatarId);
		return { status: 'done', resultAvatarId: avatarId };
	}
	const av = rows[0];

	// Fetch + canonicalize the rigged GLB. A fetch/canonicalize failure throws
	// out of here BEFORE any write, leaving the source avatar fully intact — the
	// caller logs it and the job is retried on the next webhook/poll/sweep.
	let glbBuf = await fetchProviderGlbBuffer(glbUrl);
	glbBuf = await canonicalize(glbBuf);
	const info = isValidGlbHeader(glbBuf) ? inspectGlb(glbBuf) : null;

	// Hash the EXACT bytes we store so the sibling's checksum_sha256 — and the
	// attestation.hash that defaultStorageMode stamps from it — describe the
	// rigged mesh, not the static source. This is what keeps an on-chain glTF
	// attestation verifiable (src/attestations/gltf.js recomputes this hash).
	const checksum = createHash('sha256').update(glbBuf).digest('hex');

	const slug = `rigged-${Math.random().toString(36).slice(2, 8)}`;
	const newKey = storageKeyFor({ userId, slug });
	await putObject({
		key: newKey,
		body: glbBuf,
		contentType: 'model/gltf-binary',
		metadata: { source: 'auto-rig', avatar_id: avatarId, job_id: jobId },
	});

	// The sibling inherits the source's identity (name/description/visibility) so
	// the user's library doesn't sprout a renamed mystery avatar, and carries the
	// provenance needed to trace + reverse the rig.
	const meta = {
		...(av.source_meta || {}),
		is_rigged: true,
		auto_rigged: true,
		rig_provider: 'auto-rig',
		rig_job_id: jobId,
		unrigged_avatar_id: avatarId,
		unrigged_storage_key: av.storage_key,
	};
	// Drop any stale static-mesh provenance that no longer describes the sibling.
	delete meta.rigged_superseded_by;
	if (info) {
		meta.skeleton_joint_count = info.skeletonJointCount;
		meta.skin_count = info.skinCount;
		meta.node_count = info.nodeCount;
		meta.animation_count = info.animationCount;
	}
	const tags = Array.from(new Set([...(av.tags || []).filter((t) => t !== 'unrigged'), 'rigged']));

	const visibility = ['private', 'unlisted', 'public'].includes(av.visibility)
		? av.visibility
		: 'private';

	let sibling;
	try {
		sibling = await createAvatar({
			userId,
			storageKey: newKey,
			input: {
				slug,
				name: av.name,
				description: av.description ?? null,
				size_bytes: glbBuf.length,
				content_type: 'model/gltf-binary',
				source: 'auto-rig',
				source_meta: meta,
				// Rigging adds a skeleton to the same mesh — the source avatar's
				// rendered thumbnail depicts the sibling exactly, so inherit it
				// instead of leaving the card blank until the backfill cron re-renders
				// an identical image.
				thumbnail_key: av.thumbnail_key ?? null,
				visibility,
				tags,
				checksum_sha256: checksum,
				parent_avatar_id: avatarId,
			},
		});
	} catch (err) {
		// Quota exhaustion (402 plan_limit_count / plan_limit_storage) must not
		// leave the job stuck or the source mutated: the user still owns a valid,
		// fallback-animatable static avatar. Close the job terminally with a note
		// and return without a sibling so the callers stop polling.
		if (err?.status === 402 || /^plan_limit_/.test(err?.code || '')) {
			console.warn('[auto-rig] sibling skipped (quota):', err?.code || err?.message);
			await closeJob(null, `rig_sibling_skipped: ${err?.code || 'quota'}`);
			return { status: 'done' };
		}
		throw err;
	}

	// Reversibility trail. Anchor the version on the SOURCE avatar id so the
	// lineage reads "source → rigged storage_key"; created_by records who owns
	// the upgrade. Guarded for envs where the table hasn't been migrated.
	try {
		await sql`
			insert into avatar_versions (avatar_id, storage_key, created_by)
			values (${avatarId}, ${newKey}, ${userId})
		`;
	} catch (e) {
		if (e?.code === '42P01' || String(e?.message).includes('does not exist')) {
			console.warn('[auto-rig] avatar_versions table missing — skipping version insert');
		} else {
			throw e;
		}
	}

	// Re-point the owning agent identity at the now-animatable sibling. The agent
	// keeps its id, wallet, chain id, and ERC-8004 id — only the avatar pointer
	// moves. 0 rows is fine (no agent owned the source yet).
	await sql`
		update agent_identities
		set avatar_id = ${sibling.id}
		where user_id = ${userId}
		  and avatar_id = ${avatarId}
		  and deleted_at is null
	`;

	// No silently-orphaned IPFS pin. The source's CID (if any) resolves to the
	// static bytes; the sibling holds different bytes and starts unpinned (its
	// createAvatar storage_mode has ipfs.cid = null). If the source WAS pinned,
	// mark it superseded so a future re-pin job / the UI can find the rigged
	// version — without touching the source's storage_key/checksum/bytes.
	if (av.storage_mode?.ipfs?.pinned) {
		const supersededMeta = { ...(av.source_meta || {}), rigged_superseded_by: sibling.id };
		await sql`
			update avatars
			set source_meta = ${JSON.stringify(supersededMeta)}::jsonb, updated_at = now()
			where id = ${avatarId} and owner_id = ${userId}
		`;
	}

	await closeJob(sibling.id);

	dispatchWebhooks({
		userId,
		eventType: 'avatar.created',
		data: { id: sibling.id, name: sibling.name, slug: sibling.slug, source: 'auto-rig' },
	}).catch(() => {});

	return { status: 'done', resultAvatarId: sibling.id };
	} catch (err) {
		// The winner threw mid-flight (GLB fetch 5xx, R2 hiccup, createAvatar/DB
		// blip). Release the claim back to 'running' — a non-terminal, cron-
		// selectable status — so the sweep retries from the stored result_glb_url
		// instead of leaving the job wedged at 'finalizing' or stranded at
		// 'done'+null. Guarded on result_avatar_id is null so a release can never
		// clobber a row that another driver has since completed. Then rethrow so the
		// caller (webhook/poll/cron) logs it exactly as before.
		await sql`
			update avatar_regen_jobs
			set status = 'running', updated_at = now()
			where job_id = ${jobId} and user_id = ${userId} and result_avatar_id is null
		`.catch(() => {});
		throw err;
	}
}
