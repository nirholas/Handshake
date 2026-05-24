// Hugging Face provider for avatar reconstruction.
//
// Calls a HF Space's modern Gradio /call/<api_name> endpoint for image-to-3D
// inference. Default target: tencent/Hunyuan3D-2's `/generation_all` endpoint,
// which takes 4 multi-view photos (front/back/left/right) and produces a
// textured GLB — a natural fit for the selfie pipeline's 3-photo capture
// (frontal → mv_image_front, left → mv_image_left, right → mv_image_right;
// back is left null).
//
// Submit is BLOCKING: Gradio queue state lives in the server-side event_id
// and there's no "reconnect to in-flight job" — once /call/<api>/<event_id>
// SSE is consumed, the result is gone. The reconstruct endpoint's
// maxDuration is bumped to 300s in vercel.json to absorb queue wait
// (typically <30s) plus processing (Hunyuan3D-2 generation_all runs 30-90s
// on the Space's GPU).
//
// status() echoes the resultGlbUrl back from a packed extJobId so the
// regenerate-status poll loop materializes the avatar without re-hitting HF.
//
// Env:
//   HF_TOKEN                      — required, from huggingface.co/settings/tokens
//                                   (read-only token is sufficient; the Space is public)
//   HF_RECONSTRUCT_SPACE          — default 'tencent/Hunyuan3D-2'
//   HF_RECONSTRUCT_API_NAME       — default 'generation_all'

const HF_INFERENCE_TIMEOUT_MS = 280_000; // leave headroom for response framing
const HF_DEFAULT_SPACE = 'tencent/Hunyuan3D-2';
const HF_DEFAULT_API = 'generation_all';

function readEnv(name) {
	if (typeof process !== 'undefined' && process.env && process.env[name]) return process.env[name];
	return null;
}

function packExtJobId(payload) {
	return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}
function unpackExtJobId(extJobId) {
	try {
		return JSON.parse(Buffer.from(extJobId, 'base64url').toString('utf8'));
	} catch {
		return null;
	}
}

function spaceBaseUrl(slug) {
	const host = slug.replace(/\//g, '-').toLowerCase();
	return `https://${host}.hf.space`;
}

// Gradio file-component input. data: URIs and http(s) URLs both work; the
// Space's preprocessor will fetch URLs server-side.
function toFileData(imageUrl) {
	if (!imageUrl) return null;
	return {
		path: imageUrl,
		url: imageUrl,
		meta: { _type: 'gradio.FileData' },
	};
}

function withTimeout(promise, ms, message) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Walk a Gradio output tree for the first GLB-looking URL. The Space returns
// outputs like:
//   [ { path: "/tmp/x.glb", url: "https://...hf.space/file=/tmp/x.glb", ... },
//     { ...white-mesh file...}, "Output text", {...stats...}, 1234 ]
// We want the *first* file: it's the textured mesh from /generation_all.
function extractFirstGlbUrl(data) {
	const visit = (node) => {
		if (!node) return null;
		if (typeof node === 'string') {
			if (/^https?:\/\/.+\.glb($|\?)/i.test(node)) return node;
			return null;
		}
		if (Array.isArray(node)) {
			for (const child of node) {
				const found = visit(child);
				if (found) return found;
			}
			return null;
		}
		if (typeof node === 'object') {
			if (typeof node.url === 'string' && /\.glb($|\?)/i.test(node.url)) return node.url;
			if (typeof node.path === 'string' && /\.glb($|\?)/i.test(node.path)) return node.path;
			for (const v of Object.values(node)) {
				const found = visit(v);
				if (found) return found;
			}
		}
		return null;
	};
	return visit(data);
}

// Build the 13-arg payload for tencent/Hunyuan3D-2 /generation_all.
//
// Parameters in order:
//   caption(str), image(file), mv_front, mv_back, mv_left, mv_right,
//   steps(int), guidance_scale(float), seed(int), octree_resolution(int),
//   check_box_rembg(bool), num_chunks(int), randomize_seed(bool)
//
// We default to the Space's own defaults so users get a baseline-quality
// result; selfie callers can override via params.steps / params.seed / etc.
function buildHunyuanPayload({ photos, params }) {
	const [frontal, left, right] = photos;
	return [
		params?.caption ?? '',
		toFileData(params?.image || frontal),
		toFileData(frontal),
		null, // mv_back — we don't capture a back photo in the selfie flow
		toFileData(left),
		toFileData(right),
		Number(params?.steps ?? 30),
		Number(params?.guidance_scale ?? 5.0),
		Number(params?.seed ?? 1234),
		Number(params?.octree_resolution ?? 256),
		params?.check_box_rembg !== false,
		Number(params?.num_chunks ?? 8000),
		params?.randomize_seed !== false,
	];
}

// Stream SSE response and resolve with the parsed `complete` payload.
// Throws on `error` event or when the stream ends without `complete`.
async function consumeSseUntilComplete(response) {
	if (!response.ok || !response.body) {
		const body = await response.text().catch(() => '');
		throw Object.assign(
			new Error(`huggingface /call stream not available: ${response.status} ${body.slice(0, 200)}`),
			{ code: 'provider_error', status: 502 },
		);
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder('utf-8');
	let buffer = '';
	let pendingEvent = null;
	let result = null;
	let errorMessage = null;

	const drain = (async () => {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let nlIdx;
			while ((nlIdx = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, nlIdx).replace(/\r$/, '');
				buffer = buffer.slice(nlIdx + 1);
				if (line === '') {
					pendingEvent = null;
					continue;
				}
				if (line.startsWith('event:')) {
					pendingEvent = line.slice(6).trim();
					continue;
				}
				if (line.startsWith('data:')) {
					const dataStr = line.slice(5).trim();
					if (pendingEvent === 'complete') {
						try { result = JSON.parse(dataStr); } catch { result = dataStr; }
						return;
					}
					if (pendingEvent === 'error') {
						errorMessage = dataStr || 'inference reported error';
						return;
					}
					// heartbeat / generating / unknown: ignore
				}
			}
		}
	})();

	try {
		await withTimeout(drain, HF_INFERENCE_TIMEOUT_MS, 'huggingface SSE stream timed out');
	} catch (err) {
		try { await reader.cancel(); } catch (_) {}
		throw Object.assign(
			new Error(err?.message || 'huggingface stream timed out'),
			{ code: 'provider_timeout', status: 504 },
		);
	}

	if (errorMessage) {
		throw Object.assign(new Error(`huggingface inference failed: ${errorMessage}`), {
			code: 'provider_error',
			status: 502,
		});
	}
	if (result === null) {
		throw Object.assign(new Error('huggingface stream closed without complete event'), {
			code: 'provider_error',
			status: 502,
		});
	}
	return result;
}

export function createRegenProvider() {
	const token = readEnv('HF_TOKEN');
	if (!token) {
		throw Object.assign(new Error('HF_TOKEN env var is required for the huggingface provider'), {
			code: 'provider_unconfigured',
			status: 501,
		});
	}

	const spaceSlug = readEnv('HF_RECONSTRUCT_SPACE') || HF_DEFAULT_SPACE;
	const apiName = readEnv('HF_RECONSTRUCT_API_NAME') || HF_DEFAULT_API;
	const spaceUrl = spaceBaseUrl(spaceSlug);

	const authHeaders = {
		authorization: `Bearer ${token}`,
		'content-type': 'application/json',
	};

	return {
		async submit(request) {
			if (request.mode !== 'reconstruct') {
				throw Object.assign(
					new Error(`huggingface provider only supports mode "reconstruct" (got "${request.mode}")`),
					{ code: 'mode_unconfigured', status: 501 },
				);
			}

			const photos = Array.isArray(request.params?.images) ? request.params.images : [];
			if (photos.length === 0) {
				throw Object.assign(new Error('huggingface provider needs at least one input image'), {
					code: 'invalid_input',
					status: 400,
				});
			}

			// Build the per-Space payload. Today we only support Hunyuan3D-2's
			// /generation_all shape; when adding a different Space, branch on
			// apiName here and write its payload builder.
			const payload = apiName === HF_DEFAULT_API
				? buildHunyuanPayload({ photos, params: request.params })
				: [toFileData(photos[0])]; // generic single-image fallback

			// Step 1 — POST to /call/<api> to enqueue. Returns an event_id.
			let queueRes;
			try {
				queueRes = await fetch(`${spaceUrl}/call/${apiName}`, {
					method: 'POST',
					headers: authHeaders,
					body: JSON.stringify({ data: payload }),
				});
			} catch (err) {
				throw Object.assign(new Error(`huggingface /call failed: ${err?.message}`), {
					code: 'provider_unreachable',
					status: 502,
				});
			}
			if (!queueRes.ok) {
				const body = await queueRes.text().catch(() => '');
				throw Object.assign(
					new Error(`huggingface /call returned ${queueRes.status}: ${body.slice(0, 200)}`),
					{ code: 'provider_error', status: 502, providerStatus: queueRes.status },
				);
			}
			const queueBody = await queueRes.json().catch(() => ({}));
			const eventId = queueBody?.event_id;
			if (!eventId) {
				throw Object.assign(new Error('huggingface /call returned no event_id'), {
					code: 'provider_error',
					status: 502,
				});
			}

			// Step 2 — GET /call/<api>/<event_id> as SSE; block until complete.
			let streamRes;
			try {
				streamRes = await fetch(`${spaceUrl}/call/${apiName}/${eventId}`, {
					headers: {
						authorization: `Bearer ${token}`,
						accept: 'text/event-stream',
					},
				});
			} catch (err) {
				throw Object.assign(new Error(`huggingface SSE GET failed: ${err?.message}`), {
					code: 'provider_unreachable',
					status: 502,
				});
			}

			const output = await consumeSseUntilComplete(streamRes);

			let glbUrl = extractFirstGlbUrl(output);
			if (!glbUrl) {
				throw Object.assign(
					new Error('huggingface inference returned no GLB in output'),
					{ code: 'provider_error', status: 502 },
				);
			}

			// Gradio may emit relative /file= references; absolutize.
			if (glbUrl.startsWith('/')) glbUrl = `${spaceUrl}${glbUrl}`;
			else if (!/^https?:\/\//i.test(glbUrl)) glbUrl = `${spaceUrl}/file=${glbUrl}`;

			return {
				extJobId: packExtJobId({ resultGlbUrl: glbUrl, space: spaceSlug, api: apiName }),
				eta: 0,
				rawStatus: 'completed',
			};
		},

		async status(extJobId) {
			const payload = unpackExtJobId(extJobId);
			if (!payload?.resultGlbUrl) {
				return { status: 'failed', error: 'missing or malformed ext_job_id' };
			}
			return {
				status: 'done',
				rawStatus: 'completed',
				resultGlbUrl: payload.resultGlbUrl,
			};
		},
	};
}
