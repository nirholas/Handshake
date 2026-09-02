// Shared response shaping for the free text-to-3D surfaces.
//
// One shaper, two fronts. `/api/3d/studio` (the ChatGPT Actions contract behind
// the "three.ws 3D Studio" custom GPT) and the OKX.AI A2MCP forge services
// (api/_okx3d/forge.js) hand a buyer exactly the same thing: the model URLs and
// the job state, and nothing else. No upsell block, no pricing paths, no
// internal identifiers. Keeping the shaping here means the GPT and the agent
// marketplace cannot drift into two different contracts over the same lane.
//
// The only per-surface difference is where a pending job is polled: ChatGPT
// polls a REST route, an OKX buyer calls a free MCP tool. That is the
// `pollPath` option; everything else is identical.

import { viewerUrl, arLaunchUrl } from './gpt-forge-client.js';

export const STUDIO_POLL_PATH = '/api/3d/studio';

// The painted reference view of the model, the forge's first, image-generation
// step. Surfaced on every state (pending included) so a caller can show the
// concept image the moment it exists, while the mesh is still generating: the
// same paint-then-reconstruct experience the /forge page gives.
export function previewOf(payload) {
	const u = payload?.preview_image_url;
	return typeof u === 'string' && /^https:\/\//.test(u) ? u : null;
}

export function tierOf(payload) {
	const t = payload?.tier;
	return t === 'draft' || t === 'standard' || t === 'high' ? t : null;
}

// The prompt rides the poll URL as `title` so the eventual done response can
// label the AR/viewer pages without the caller having to resend anything.
function titleSuffix(title) {
	return typeof title === 'string' && title.trim()
		? `&title=${encodeURIComponent(title.trim().slice(0, 80))}`
		: '';
}

// Shape a forge submit response into the published contract: model URLs and job
// state only. Pure + exported so tests pin the boundary against real captured
// forge shapes without any network.
export function shapeSubmit(job, base, prompt, { pollPath = STUDIO_POLL_PATH } = {}) {
	const glbUrl = typeof job?.glb_url === 'string' ? job.glb_url : '';
	const preview = previewOf(job);
	const tier = tierOf(job);
	if (job?.status === 'done' && glbUrl) {
		return {
			status: 'done',
			glbUrl,
			viewerUrl: viewerUrl(base, glbUrl),
			arUrl: arLaunchUrl(base, glbUrl, prompt),
			format: 'glb',
			...(preview ? { previewImageUrl: preview } : {}),
			...(tier ? { tier } : {}),
		};
	}
	const handle = job?.job_id ?? null;
	const t = titleSuffix(prompt);
	const eta = Number(job?.eta_seconds);
	return {
		status: 'pending',
		job: handle,
		poll: handle ? `${pollPath}?job=${encodeURIComponent(handle)}${t}` : null,
		...(handle ? { watchUrl: `${base}/watch?job=${encodeURIComponent(handle)}${t}` } : {}),
		format: 'glb',
		...(preview ? { previewImageUrl: preview } : {}),
		...(tier ? { tier } : {}),
		...(Number.isFinite(eta) && eta > 0 ? { etaSeconds: Math.round(eta) } : {}),
	};
}

// Shape a forge poll response into { status:'pending'|'done'|'error', ... }.
// `paid` says whether the surface asking is a metered one. It only changes what
// a FAILED job is told, and it has to: the free lanes really are free to retry,
// while a metered row settles the moment the lane accepts a job, so the free
// wording would tell a charged buyer something false about their money. See the
// failed branch below.
export function shapePoll(data, base, jobId, title, { pollPath = STUDIO_POLL_PATH, paid = false } = {}) {
	const glbUrl = typeof data?.glb_url === 'string' ? data.glb_url : '';
	const preview = previewOf(data);
	const tier = tierOf(data);
	if (data?.status === 'done' && glbUrl) {
		return {
			status: 'done',
			job: jobId,
			glbUrl,
			viewerUrl: viewerUrl(base, glbUrl),
			arUrl: arLaunchUrl(base, glbUrl, title),
			format: 'glb',
			...(preview ? { previewImageUrl: preview } : {}),
			...(tier ? { tier } : {}),
		};
	}
	if (data?.status === 'failed') {
		// The message is already sanitized by /api/gpt-forge, and the lane only
		// reports a failure once its own backend failover chain is exhausted, so
		// this is terminal for THIS job. What a retry costs depends on the
		// surface, and the difference is not cosmetic: on a metered row payment
		// settles when the lane accepts the job, so the free lanes' "it costs
		// nothing to try again" would tell a buyer who was already charged
		// something false. Neither note claims anything about one particular job
		// (a status row polls any job id it is handed); each states its own
		// surface's payment model, which is what the caller has to act on. The
		// exact per-call answer is the PAYMENT-RESPONSE receipt from the submit.
		if (!paid) {
			return {
				status: 'error',
				job: jobId,
				error: data?.error || '3D generation hit a snag upstream, it costs nothing to try again.',
			};
		}
		const lanes = Array.isArray(data?.retry_backends) ? data.retry_backends.filter((b) => typeof b === 'string') : [];
		const upstream = String(data?.error || '3D generation hit a snag upstream').trim().replace(/[.!]+$/, '');
		const note = 'Jobs here settle when the lane accepts them, so a retry is a new paid call.';
		// The alternate engines ride only on the metered surface. The free lane's
		// response shape is the published custom-GPT Action contract
		// (public/.well-known/3d-studio-openapi.yaml, byte-guarded against its
		// submission source), so a new key there is a contract change for another
		// work stream to make, not a bug fix to slip in here. The /forge UI reads
		// retry_backends straight off /api/gpt-forge and is unaffected.
		return {
			status: 'error',
			job: jobId,
			error: `${upstream}. ${note}`,
			...(lanes.length ? { retryBackends: lanes } : {}),
		};
	}
	// queued / running / anything transient stays pending; keep the title on the
	// poll URL so it survives to the done response. Forward the live remaining
	// estimate the poll carries (falling back to the lane's total estimate)
	// instead of leaving the caller with N identical frames.
	const t = titleSuffix(title);
	const etaRemaining = Number(data?.eta_remaining_seconds ?? data?.eta_seconds);
	const elapsed = Number(data?.elapsed_seconds);
	return {
		status: 'pending',
		job: jobId,
		poll: `${pollPath}?job=${encodeURIComponent(jobId)}${t}`,
		watchUrl: `${base}/watch?job=${encodeURIComponent(jobId)}${t}`,
		...(preview ? { previewImageUrl: preview } : {}),
		...(tier ? { tier } : {}),
		...(Number.isFinite(etaRemaining) && etaRemaining > 0 ? { etaSeconds: Math.round(etaRemaining) } : {}),
		...(Number.isFinite(elapsed) && elapsed >= 0 ? { elapsedSeconds: Math.round(elapsed) } : {}),
	};
}
