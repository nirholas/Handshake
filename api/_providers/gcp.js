// GCP Cloud Run provider for avatar reconstruction.
//
// Implements the same contract as the replicate provider:
//   submit(request)  → { extJobId, eta }
//   status(extJobId) → { status, resultGlbUrl?, error? }
//
// The Cloud Run service can be either:
//   - workers/avatar-pipeline-controller/ (v2 — real 3D mesh generation via
//     Hunyuan3D / TRELLIS / TripoSR + UniRig auto-rigging)
//   - workers/avatar-reconstruction/ (v1 — face texture transfer only)
//
// Both expose the same API:
//   POST /reconstruct  → { job_id, status }
//   GET  /jobs/:id     → { status, glb_url?, error? }
//
// Required env vars:
//   GCP_RECONSTRUCTION_URL  — Cloud Run service URL
//                             e.g. https://avatar-pipeline-controller-xxx-uc.a.run.app
//   GCP_RECONSTRUCTION_KEY  — bearer secret matching the service's API_KEY

function readEnv(name) {
	if (typeof process !== 'undefined' && process.env?.[name]) return process.env[name];
	return null;
}

function translateStatus(s) {
	switch (s) {
		case 'queued':  return 'queued';
		case 'running': return 'running';
		case 'done':    return 'done';
		case 'failed':  return 'failed';
		default:        return 'queued';
	}
}

export function createRegenProvider() {
	const serviceUrl = readEnv('GCP_RECONSTRUCTION_URL');
	const apiKey     = readEnv('GCP_RECONSTRUCTION_KEY');

	if (!serviceUrl) {
		throw new Error('GCP_RECONSTRUCTION_URL env var is required for the gcp provider');
	}
	if (!apiKey) {
		throw new Error('GCP_RECONSTRUCTION_KEY env var is required for the gcp provider');
	}

	const base = serviceUrl.replace(/\/$/, '');
	const authHeaders = {
		authorization: `Bearer ${apiKey}`,
		'content-type': 'application/json',
	};

	return {
		async submit(request) {
			if (request.mode !== 'reconstruct') {
				throw Object.assign(
					new Error(`gcp provider only supports 'reconstruct' mode, got '${request.mode}'`),
					{ code: 'mode_unconfigured', status: 501 },
				);
			}

			const images = Array.isArray(request.params?.images) && request.params.images.length
				? request.params.images
				: [request.sourceUrl].filter(Boolean);

			if (!images.length) {
				throw Object.assign(
					new Error('no images provided for reconstruction'),
					{ code: 'invalid_request', status: 400 },
				);
			}

			const bodyType = request.params?.bodyType || 'neutral';

			let response;
			try {
				response = await fetch(`${base}/reconstruct`, {
					method: 'POST',
					headers: authHeaders,
					body: JSON.stringify({ images, body_type: bodyType }),
				});
			} catch (err) {
				throw Object.assign(
					new Error(`gcp reconstruction service unreachable: ${err?.message}`),
					{ code: 'provider_unreachable', status: 502 },
				);
			}

			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				throw Object.assign(
					new Error(data?.detail || `gcp service returned ${response.status}`),
					{ code: 'provider_error', status: 502, providerStatus: response.status },
				);
			}

			return {
				extJobId: data.job_id,
				// v2 pipeline: mesh generation (30–120s) + UniRig rigging (15–30s).
				// v1 fallback: face texture transfer (15–30s).
				eta: 120,
			};
		},

		async status(extJobId) {
			if (!extJobId) {
				return { status: 'failed', error: 'missing ext_job_id' };
			}

			let response;
			try {
				response = await fetch(`${base}/jobs/${encodeURIComponent(extJobId)}`, {
					headers: authHeaders,
				});
			} catch (err) {
				// Treat network errors as transient — keep polling.
				return { status: 'running', error: `poll failed: ${err?.message}` };
			}

			if (response.status === 404) {
				return { status: 'failed', error: 'job not found on reconstruction service' };
			}

			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				// Treat unexpected errors as transient so the poller keeps retrying.
				return { status: 'running', error: `gcp returned ${response.status}` };
			}

			const status = translateStatus(data.status);
			const result = { status };

			if (status === 'done') {
				if (data.glb_url) {
					result.resultGlbUrl = data.glb_url;
				} else {
					result.status = 'failed';
					result.error  = 'reconstruction finished but no GLB URL in response';
				}
			}

			if (status === 'failed') {
				result.error = data.error || 'reconstruction failed';
			}

			return result;
		},
	};
}
