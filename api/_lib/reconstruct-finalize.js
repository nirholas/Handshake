// Reconstruct-finalize - the shared tail of the selfie → 3D pipeline, called by
// both the /api/avatars/regenerate-status poll and the Replicate webhook so the
// two completion paths never drift.
//
// A reconstruction model returns a textured mesh. Whether that mesh is rigged
// depends on the model family: Hunyuan3D's generation_all and our GCP UniRig
// pipeline emit a skeleton; TRELLIS / TripoSR return a static mesh. The /scan
// page promises a *rigged* model you can animate, so when the reconstructed
// mesh has no skeleton AND the active provider has a rig model configured, we
// chain a 'rerig' job and only surface the avatar once it's rigged. If no rig
// model is configured, or rigging fails, we deliver the static mesh tagged
// `unrigged` - the user is never left empty-handed.
//
// Auto-rig is dormant by default: it activates only when the provider reports
// supportsMode('rerig') (e.g. REPLICATE_RERIG_MODEL is set), so existing
// deployments keep their exact current behavior until rigging is wired.

import { sql } from './db.js';
import { putObject, publicUrl } from './r2.js';
import { storageKeyFor, createAvatar } from './avatars.js';
import { inspectGlb, isValidGlbHeader } from './glb-inspect.js';
import { dispatchWebhooks } from './webhook-dispatch.js';
import { getRegenProviderForMode } from './regen-provider.js';
// Every provider-returned GLB fetched here - the reconstruct output, the rigged
// result, and our own stored bare mesh (rig.unriggedUrl) - goes through the
// shared guard: host allowlist + IP-pinned SSRF connect + 64 MB ceiling. No bare
// fetch() of a provider URL remains in this file.
import { fetchProviderGlbBuffer } from './provider-result-url.js';
import { registerReconstructionCreation } from './forge-store.js';

function glbMetaFrom(info) {
	return info
		? {
			is_rigged: info.isRigged,
			skin_count: info.skinCount,
			skeleton_joint_count: info.skeletonJointCount,
			node_count: info.nodeCount,
			mesh_count: info.meshCount,
			animation_count: info.animationCount,
			glb_generator: info.generator,
		}
		: { is_rigged: null, glb_inspect_error: 'invalid_glb_header' };
}

// One log line summarising a draft mint, per leg. `skipped` carries its reason
// (an unconfigured authority secret is the common one) so an operator reading
// the reconstruct logs can tell "the mint was never armed" from "the mint ran".
export function describeDraftMint(mint) {
	if (!mint) return 'no result';
	if (mint.status !== 'ok') return `status=${mint.status}`;
	const leg = (name, r) => {
		if (!r) return `${name}=off`;
		const detail =
			r.status === 'skipped'
				? `:${r.reason || 'unspecified'}`
				: r.signature || r.txHash
					? `:${r.signature || r.txHash}`
					: '';
		return `${name}=${r.status}${detail}`;
	};
	return `agent=${mint.agentId} ${leg('solana', mint.solana)} ${leg('evm', mint.evm)}`;
}

// Store a reconstructed GLB into R2 and create the durable avatar row, marking
// the job done. Shared by every terminal path (rigged-as-is, rigged-after-chain,
// unrigged fallback) so all three produce an identical avatar shape.
async function materializeReconstructAvatar({
	userId,
	jobId,
	job,
	glbBuf,
	glbInfo,
	storageKey,
	slug,
	extraTags = [],
	sourceMetaExtra = {},
}) {
	const params = job.params || {};
	// Both the selfie capture flow and the text → avatar flow land here; tag and
	// describe the result by how it was actually made so the library stays honest.
	const fromPrompt = params.source === 'prompt';
	const baseTag = fromPrompt ? 'prompt' : 'selfie';
	const name = String(params.name || (fromPrompt ? 'My prompt avatar' : 'My selfie avatar')).slice(0, 120);
	const description = params.description ? String(params.description).slice(0, 500) : null;
	const visibility = ['private', 'unlisted', 'public'].includes(params.visibility)
		? params.visibility
		: 'private';

	// Canonicalize bone names + up-axis orientation so generated avatars are
	// stored in the canonical convention, matching user-uploaded avatars.
	try {
		const { canonicalizeGLBBones } = await import('../../src/glb-canonicalize.js');
		const ab = glbBuf.buffer.slice(glbBuf.byteOffset, glbBuf.byteOffset + glbBuf.byteLength);
		const canonical = canonicalizeGLBBones(ab);
		if (canonical.renamed > 0 || canonical.orientationCorrected) {
			glbBuf = Buffer.from(canonical.buffer);
		}
	} catch (err) {
		console.warn('[reconstruct] canonicalize skipped:', err?.message);
	}

	await putObject({
		key: storageKey,
		body: glbBuf,
		contentType: 'model/gltf-binary',
		metadata: { source: 'reconstruct', job_id: jobId },
	});

	const tags = [baseTag, ...extraTags];
	if (glbInfo && !glbInfo.isRigged && !tags.includes('unrigged')) tags.push('unrigged');

	const promptMeta = fromPrompt
		? { prompt: params.prompt ?? null, referenceImageUrl: params.referenceImageUrl ?? null }
		: {};

	const avatar = await createAvatar({
		userId,
		storageKey,
		input: {
			slug,
			name,
			description,
			size_bytes: glbBuf.length,
			content_type: 'model/gltf-binary',
			source: 'reconstruct',
			source_meta: { jobId, provider: job.provider, ...glbMetaFrom(glbInfo), ...promptMeta, ...sourceMetaExtra },
			visibility,
			tags,
			checksum_sha256: null,
			parent_avatar_id: null,
		},
	});

	await sql`
		update avatar_regen_jobs
		set result_avatar_id = ${avatar.id}, status = 'done', updated_at = now()
		where job_id = ${jobId} and user_id = ${userId}
	`;

	dispatchWebhooks({
		userId,
		eventType: 'avatar.created',
		data: { id: avatar.id, name: avatar.name, slug: avatar.slug, source: 'reconstruct' },
	}).catch(() => {});

	// Register the result in the Forge store so galleries, share/embed pages,
	// and leaderboards see reconstructions like any other creation. Visibility
	// rides along so private captures never surface publicly. Best-effort: the
	// avatar is already delivered, a store hiccup must not fail the job.
	try {
		const referenceUrl =
			typeof promptMeta.referenceImageUrl === 'string' && /^https:\/\//i.test(promptMeta.referenceImageUrl)
				? promptMeta.referenceImageUrl
				: null;
		await registerReconstructionCreation({
			userId,
			avatarId: avatar.id,
			jobId,
			provider: job.provider,
			prompt: fromPrompt && params.prompt ? String(params.prompt) : name,
			glbKey: storageKey,
			glbUrl: publicUrl(storageKey),
			sizeBytes: glbBuf.length,
			visibility,
			previewImageUrl: referenceUrl,
		});
	} catch (err) {
		console.warn('[reconstruct] forge registration skipped:', err?.message);
	}

	// Roadmap Phase 1: a successful reconstruction is also minted as a draft
	// on-chain agent identity - Metaplex Core on Solana (devnet is the default
	// automated path; mainnet only via the explicit DRAFT_AGENT_MINT_NETWORK
	// flag), ERC-8004 on EVM behind DRAFT_AGENT_MINT_EVM_ENABLED. Best-effort,
	// same contract as the webhook + forge steps above: the avatar is already
	// delivered, so a mint hiccup must never fail the job.
	//
	// The outcome is logged per leg rather than discarded. A leg that reports
	// 'skipped' is a silent no-op otherwise, which is indistinguishable from the
	// mint never being attempted: exactly the state a deployment lands in when
	// no authority secret is configured, and the reason it can go unnoticed
	// across hundreds of reconstructions.
	try {
		const { mintDraftAgentIdentity } = await import('./draft-mint.js');
		const mint = await mintDraftAgentIdentity({ userId, avatarId: avatar.id, jobId });
		console.log('[reconstruct] draft agent mint:', describeDraftMint(mint));
	} catch (err) {
		console.warn('[reconstruct] draft agent mint skipped:', err?.message);
	}

	return avatar;
}

// Stage 1: a reconstruct job just succeeded. Inspect the mesh and either
// deliver it immediately (already rigged, or no rig model available) or kick
// off an auto-rig job and move the parent job into the 'rigging' state.
//
// Returns { status, resultAvatarId? } reflecting the post-call job state.
export async function finalizeReconstructStage({ userId, jobId, job, glbUrl }) {
	const glbBuf = await fetchProviderGlbBuffer(glbUrl);
	const info = isValidGlbHeader(glbBuf) ? inspectGlb(glbBuf) : null;
	const slugPrefix = job?.params?.source === 'prompt' ? 'prompt' : 'selfie';
	const slug = `${slugPrefix}-${Math.random().toString(36).slice(2, 8)}`;
	const storageKey = storageKeyFor({ userId, slug });

	let provider = null;
	try {
		provider = await getRegenProviderForMode('rerig');
	} catch (_) {
		provider = null;
	}
	const canRig = !!(info && !info.isRigged && provider?.instance);

	if (!canRig) {
		const avatar = await materializeReconstructAvatar({ userId, jobId, job, glbBuf, glbInfo: info, storageKey, slug });
		return { status: 'done', resultAvatarId: avatar.id };
	}

	// Store the bare mesh durably first: it gives the rig model a stable URL to
	// fetch and guarantees a fallback if rigging fails.
	await putObject({
		key: storageKey,
		body: glbBuf,
		contentType: 'model/gltf-binary',
		metadata: { source: 'reconstruct', job_id: jobId, stage: 'unrigged' },
	});
	const unriggedUrl = publicUrl(storageKey);

	let rigSubmission;
	try {
		rigSubmission = await provider.instance.submit({
			userId,
			mode: 'rerig',
			params: { ...(job.params || {}) },
			sourceUrl: unriggedUrl,
			sourceStorageKey: storageKey,
		});
	} catch (rigErr) {
		// Couldn't even start rigging - deliver the bare mesh now rather than
		// failing the whole reconstruction the user already waited for.
		const avatar = await materializeReconstructAvatar({
			userId,
			jobId,
			job,
			glbBuf,
			glbInfo: info,
			storageKey,
			slug,
			extraTags: ['unrigged'],
			sourceMetaExtra: { rigError: String(rigErr?.message || rigErr) },
		});
		return { status: 'done', resultAvatarId: avatar.id };
	}

	// Drop the (multi-MB base64) source images from the persisted params now that
	// reconstruction is done - the rig stage works off the stored GLB, not the
	// photos - so the job row stays lean across the remaining 'rigging' polls.
	const { images: _images, image: _image, ...leanParams } = job.params || {};
	const nextParams = {
		...leanParams,
		rig: { extJobId: rigSubmission.extJobId ?? null, storageKey, slug, unriggedUrl },
	};
	await sql`
		update avatar_regen_jobs
		set status = 'rigging', params = ${JSON.stringify(nextParams)}, updated_at = now()
		where job_id = ${jobId} and user_id = ${userId}
	`;
	return { status: 'rigging' };
}

// Stage 2: the parent job is in 'rigging' - poll the child rig job. On success
// swap in the rigged GLB; on failure fall back to the stored bare mesh. Returns
// { status, resultAvatarId? }; status stays 'rigging' while the rig job runs.
export async function pollRiggingStage({ userId, jobId, job }) {
	const rig = (job.params && job.params.rig) || {};
	const slug = rig.slug || `selfie-${Math.random().toString(36).slice(2, 8)}`;
	const storageKey = rig.storageKey || storageKeyFor({ userId, slug });

	let provider = null;
	try {
		provider = await getRegenProviderForMode('rerig');
	} catch (_) {
		provider = null;
	}

	// No way to advance (provider gone or no child id): salvage the bare mesh so
	// the job can't hang forever in 'rigging'.
	if (!provider?.instance || !rig.extJobId) {
		if (!rig.unriggedUrl) return { status: 'rigging' };
		const glbBuf = await fetchProviderGlbBuffer(rig.unriggedUrl);
		const info = isValidGlbHeader(glbBuf) ? inspectGlb(glbBuf) : null;
		const avatar = await materializeReconstructAvatar({
			userId, jobId, job, glbBuf, glbInfo: info, storageKey, slug,
			extraTags: ['unrigged'],
			sourceMetaExtra: { rigError: 'rig job not pollable' },
		});
		return { status: 'done', resultAvatarId: avatar.id };
	}

	const update = await provider.instance.status(rig.extJobId);

	if (update.status === 'done' && update.resultGlbUrl) {
		const glbBuf = await fetchProviderGlbBuffer(update.resultGlbUrl);
		const info = isValidGlbHeader(glbBuf) ? inspectGlb(glbBuf) : null;
		const avatar = await materializeReconstructAvatar({
			userId, jobId, job, glbBuf, glbInfo: info, storageKey, slug,
			sourceMetaExtra: { rigged: true, rigJobId: rig.extJobId, reconstructGlb: rig.unriggedUrl },
		});
		return { status: 'done', resultAvatarId: avatar.id };
	}

	if (update.status === 'failed') {
		// Rigging failed - deliver the bare mesh we stored before rigging.
		const glbBuf = await fetchProviderGlbBuffer(rig.unriggedUrl);
		const info = isValidGlbHeader(glbBuf) ? inspectGlb(glbBuf) : null;
		const avatar = await materializeReconstructAvatar({
			userId, jobId, job, glbBuf, glbInfo: info, storageKey, slug,
			extraTags: ['unrigged'],
			sourceMetaExtra: { rigFailed: true, rigError: update.error || null },
		});
		return { status: 'done', resultAvatarId: avatar.id };
	}

	return { status: 'rigging' };
}
