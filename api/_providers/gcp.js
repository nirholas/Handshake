// GCP Cloud Run provider — implements the same contract as the Replicate provider.
//
//   submit(request)  → { extJobId, eta }
//   status(extJobId) → { status, resultGlbUrl?, resultImageUrl?, error? }
//
// Supported modes and the Cloud Run service they route to:
//
//   reconstruct  → GCP_RECONSTRUCTION_URL   (avatar-pipeline-controller)
//                  POST /reconstruct → { job_id }  GET /jobs/:id → { status, glb_url }
//
//   trellis      → MODEL_TRELLIS_URL        (workers/model-trellis)
//                  Native single-image→3D via Microsoft TRELLIS. Standard task
//                  shape: POST /infer → { task_id }  GET /tasks/:id → result_gcs_url.
//
//   hunyuan      → GCP_HUNYUAN3D_URL        (workers/model-hunyuan3d)
//                  Image→3D via Tencent Hunyuan3D-2 (shape DiT + multiview
//                  paint). Same standard task shape as the TRELLIS worker:
//                  POST /infer → { task_id }  GET /tasks/:id → result_gcs_url.
//                  NOT the avatar controller's /reconstruct + /jobs/:id shape.
//
//   remesh       → GCP_REMESH_URL           (workers/remesh)
//   stylize      → GCP_STYLIZE_URL          (workers/stylize)
//   retex        → GCP_TEXTURE_URL          (workers/texture)
//   rembg        → GCP_REMBG_URL            (workers/rembg)
//   segment      → GCP_SEGMENT_URL          (workers/segment)
//   sketch       → GCP_TRIPOSG_URL          (workers/model-triposg, scribble mode)
//   rerig        → GCP_RECONSTRUCTION_URL   (avatar-pipeline-controller, /rig endpoint)
//   video2scene  → GCP_VIDEO2SCENE_URL      (workers/model-video2scene, LingBot-Map)
//                  Streaming video → 3D point cloud. Standard /infer + /tasks/:id
//                  shape; the result is a .ply point cloud, not a GLB mesh.
//   video2motion → GCP_VIDEO2MOTION_URL     (workers/model-video2motion, MediaPipe)
//                  Video of a person → AnimationClip JSON + person-mask video +
//                  normalized video + per-frame screen anchors (body swap).
//
// All workers share the same bearer secret (GCP_RECONSTRUCTION_KEY).
// Each worker exposes the same task shape:
//   POST /…  → { task_id, status: "queued" }
//   GET /tasks/:id → { task_id, status, result_url|result_gcs_url?, error? }
//
// The extJobId is a JSON envelope base64url-encoded so it can carry both
// the service discriminator and the upstream task_id without another DB call.

function readEnv(name) {
	if (typeof process !== 'undefined' && process.env?.[name]) return process.env[name];
	return null;
}

function packJobId(payload) {
	return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}
function unpackJobId(extJobId) {
	try {
		return JSON.parse(Buffer.from(extJobId, 'base64url').toString('utf8'));
	} catch {
		return null;
	}
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

// Resolve which Cloud Run base URL handles a given mode.
function serviceUrlForMode(mode) {
	switch (mode) {
		case 'reconstruct':
			return readEnv('GCP_RECONSTRUCTION_URL');
		case 'remesh':
			return readEnv('GCP_REMESH_URL');
		case 'stylize':
			return readEnv('GCP_STYLIZE_URL');
		case 'retex':
		case 'retex_region':
			// Region (magic-brush) edits run on the same texture worker.
			return readEnv('GCP_TEXTURE_URL');
		case 'rembg':
			return readEnv('GCP_REMBG_URL');
		case 'segment':
			return readEnv('GCP_SEGMENT_URL');
		case 'sketch':
			return readEnv('GCP_TRIPOSG_URL');
		case 'trellis':
			// Self-hosted Microsoft TRELLIS image→3D worker (workers/model-trellis):
			// native single-image reconstruction, no FLUX intermediate. Distinct from
			// the avatar pipeline's `reconstruct` (face-only, /reconstruct + /jobs/:id);
			// this worker speaks the standard /infer + /tasks/:id task shape.
			return readEnv('MODEL_TRELLIS_URL');
		case 'hunyuan':
			// Self-hosted Hunyuan3D-2 image→3D worker (workers/model-hunyuan3d).
			// Same standard /infer + /tasks/:id task shape as the TRELLIS worker.
			return readEnv('GCP_HUNYUAN3D_URL');
		case 'text2motion':
			return readEnv('GCP_TEXT2MOTION_URL');
		case 'video2scene':
			// Streaming video → 3D point-cloud worker (workers/model-video2scene,
			// LingBot-Map). Standard /infer + /tasks/:id task shape; result is a PLY.
			return readEnv('GCP_VIDEO2SCENE_URL');
		case 'video2motion':
			// Video of a person → animation clip + body-swap plates
			// (workers/model-video2motion, MediaPipe pose + segmentation). Standard
			// /infer + /tasks/:id task shape; result is an AnimationClip JSON plus
			// mask/video/meta sidecar URLs.
			return readEnv('GCP_VIDEO2MOTION_URL');
		case 'rerig':
			// Rigging: prefer the standalone rig worker (workers/rig, Cloud Run
			// `model-rig`: direct /rig + /tasks/:id, `mesh_gcs_url` request schema)
			// when GCP_UNIRIG_URL is set; otherwise the legacy pipeline-controller
			// /rig endpoint behind GCP_RECONSTRUCTION_URL. The deployed
			// avatar-reconstruction service exposes no /rig, so without
			// GCP_UNIRIG_URL every rig submit 404s.
			return readEnv('GCP_UNIRIG_URL') || readEnv('GCP_RECONSTRUCTION_URL');
		default:
			return null;
	}
}

// Build the request body and path suffix for each worker's API shape.
function buildWorkerRequest(request) {
	const { mode, sourceUrl, params } = request;

	if (mode === 'reconstruct') {
		const photos = Array.isArray(params?.images) && params.images.length
			? params.images
			: [sourceUrl].filter(Boolean);
		const body = { images: photos, body_type: params?.bodyType || 'neutral' };
		// Quality-tier provenance + poly budget for the self-host high-detail path.
		// Only forwarded when set, so the default request shape is unchanged.
		if (Number.isFinite(Number(params?.target_polycount))) {
			body.target_polycount = Math.round(Number(params.target_polycount));
		}
		if (params?.tier) body.tier = params.tier;
		if (params?.path) body.path = params.path;
		return {
			path: '/reconstruct',
			resultKey: 'glb_url',
			body,
		};
	}

	if (mode === 'trellis') {
		// Self-hosted TRELLIS image→3D (workers/model-trellis). Reconstructs a
		// textured mesh from the reference views — user photos, or the synthesized
		// view for a text prompt. `body_type` rides along for parity with the
		// shared worker request shape.
		const photos = Array.isArray(params?.images) && params.images.length
			? params.images
			: [sourceUrl].filter(Boolean);
		const body = { images: photos, body_type: params?.bodyType || 'neutral' };
		// Per-tier sampler/export budgets (see SELFHOST_TRELLIS_QUALITY in
		// forge-tiers.js). The worker clamps every knob server-side and treats an
		// absent field as its own defaults, so this is pure opt-in quality.
		if (params?.quality && typeof params.quality === 'object') {
			body.quality = params.quality;
		}
		// Opt-in background pre-matting: the worker routes each view through its
		// sibling rembg service before reconstruction (workers/model-trellis
		// main.py `do_matte`). Only forwarded when the caller asks — the worker
		// otherwise defaults matte off for every tier below `max`, so the free/
		// default lane is unchanged unless we explicitly request it here.
		if (params?.matte === true) body.matte = true;
		if (Number.isFinite(Number(params?.seed))) body.seed = Math.floor(Number(params.seed));
		return {
			path: '/infer',
			resultKey: 'result_gcs_url',
			body,
		};
	}

	if (mode === 'hunyuan') {
		// Self-hosted Hunyuan3D-2 image→3D (workers/model-hunyuan3d). Shape DiT
		// conditions on the primary reference view; the worker isolates the
		// subject (rembg), cleans the mesh, decimates to the poly budget, and
		// paints it with the multiview texture pipeline.
		const photos = Array.isArray(params?.images) && params.images.length
			? params.images
			: [sourceUrl].filter(Boolean);
		const body = { images: photos, body_type: params?.bodyType || 'neutral' };
		if (Number.isFinite(Number(params?.target_polycount))) {
			body.target_polycount = Math.round(Number(params.target_polycount));
		}
		// Tier + path select the worker's per-tier generation budget and record
		// provenance; absent fields mean its high-quality defaults.
		if (params?.tier) body.tier = params.tier;
		if (params?.path) body.path = params.path;
		if (Number.isFinite(Number(params?.seed))) body.seed = Math.floor(Number(params.seed));
		return {
			path: '/infer',
			resultKey: 'result_gcs_url',
			body,
		};
	}

	if (mode === 'remesh') {
		return {
			path: '/process',
			resultKey: 'result_url',
			body: {
				mesh: sourceUrl,
				remesh_mode: params?.remesh_mode || 'triangle',
				operation: params?.operation || 'full',
				target_faces: params?.target_faces || 50_000,
				texture_size: params?.texture_size || 1024,
				output_format: params?.output_format || 'glb',
			},
		};
	}

	if (mode === 'stylize') {
		return {
			path: '/process',
			resultKey: 'result_url',
			body: {
				mesh: sourceUrl,
				style: params?.style || 'voxel',
				resolution: params?.resolution ?? null,
				output_format: params?.output_format || 'glb',
			},
		};
	}

	if (mode === 'retex') {
		return {
			path: '/texture',
			resultKey: 'result_url',
			body: {
				mesh: sourceUrl,
				prompt: params?.prompt || '',
				negative_prompt: params?.negative_prompt || 'blurry, low quality, distorted',
				num_views: params?.num_views || 8,
				texture_size: params?.texture_size || 1024,
				// person|metal|wood|fabric|plastic|glass — bakes measured-value
				// roughness/metallic factors instead of the flat default and
				// nudges the SDXL prompt with material-appropriate descriptors
				// (workers/texture/main.py MATERIAL_CLASS_PBR). Optional: omit to
				// keep the old flat-guess behavior.
				material_class: params?.material_class || null,
			},
		};
	}

	if (mode === 'retex_region') {
		// Magic brush: repaint only the masked UV region of the existing texture.
		// The mask arrives as inline base64 (browser canvas) or a public URL.
		return {
			path: '/retexture_region',
			resultKey: 'result_url',
			body: {
				mesh: sourceUrl,
				prompt: params?.prompt || '',
				negative_prompt:
					params?.negative_prompt || 'blurry, low quality, distorted, watermark, seam',
				mask_b64: params?.mask_b64 || null,
				mask: params?.mask || null,
				color: params?.color || null,
				texture_size: params?.texture_size || 1024,
				strength: params?.strength ?? 0.85,
				feather: params?.feather ?? 24,
				seed: params?.seed ?? 0,
			},
		};
	}

	if (mode === 'rembg') {
		return {
			path: '/remove',
			resultKey: 'result_url',
			body: {
				image: sourceUrl,
				model: params?.model || 'rmbg2',
			},
		};
	}

	if (mode === 'segment') {
		return {
			path: '/segment',
			resultKey: 'result_url',
			body: {
				mesh: sourceUrl,
				method: params?.method || 'auto',
				max_parts: params?.max_parts || 24,
				min_part_faces: params?.min_part_faces || 64,
				crease_angle: params?.crease_angle ?? 40,
				...(params?.only_part ? { only_part: params.only_part } : {}),
			},
		};
	}

	if (mode === 'sketch') {
		// Sketch→3D on the TripoSG worker's scribble pipeline: the source is the
		// drawing, the prompt names what it depicts (the model is prompt-
		// conditioned). Geometry only — no textures.
		const body = {
			images: [sourceUrl],
			prompt: params?.prompt || '',
			mode: 'scribble',
		};
		if (Number.isFinite(Number(params?.target_polycount))) {
			body.target_polycount = Math.round(Number(params.target_polycount));
		}
		if (Number.isFinite(Number(params?.scribble_confidence))) {
			body.scribble_confidence = Number(params.scribble_confidence);
		}
		return {
			path: '/infer',
			resultKey: 'result_gcs_url',
			body,
		};
	}

	if (mode === 'video2scene') {
		// Streaming video → 3D point cloud (workers/model-video2scene, LingBot-Map).
		// The source is a public video URL; an `images` array of frames is the
		// alternate input. Reconstruction params (sampling/quality) ride in `params`
		// and are forwarded only when set so the worker's defaults stand otherwise.
		const body = {};
		if (Array.isArray(params?.images) && params.images.length) {
			body.images = params.images;
		} else {
			body.video_url = sourceUrl;
		}
		for (const key of [
			'mode', 'fps', 'keyframe_interval', 'num_scale_frames',
			'window_size', 'overlap_size', 'conf_percentile', 'max_points', 'voxel_size',
		]) {
			if (params?.[key] !== undefined && params[key] !== null) body[key] = params[key];
		}
		if (params?.mask_sky !== undefined) body.mask_sky = Boolean(params.mask_sky);
		return {
			path: '/infer',
			resultKey: 'result_gcs_url',
			body,
		};
	}

	if (mode === 'rerig') {
		// Two rig backends share the /rig path but disagree on the schema. The
		// standalone rig worker behind GCP_UNIRIG_URL (workers/rig, the
		// Make-It-Animatable service; the env name predates it) takes
		// `mesh_gcs_url` (any https URL, the name is historical) and reports
		// `rigged_gcs_url`; the legacy pipeline controller takes
		// `mesh_url`/`rig_type` and reports `glb_url`. Branch on which env the
		// rerig URL resolved from.
		if (readEnv('GCP_UNIRIG_URL')) {
			return {
				path: '/rig',
				resultKey: 'rigged_gcs_url',
				body: {
					mesh_gcs_url: sourceUrl,
					template: params?.template || 'wolf3d_neutral',
					blendshapes: params?.blendshapes !== false,
				},
			};
		}
		return {
			path: '/rig',
			resultKey: 'glb_url',
			body: {
				mesh_url: sourceUrl,
				rig_type: params?.rig_type || 'biped',
			},
		};
	}

	if (mode === 'video2motion') {
		// Video of a person → motion clip + compositing plates. The source is a
		// public video URL; capture params ride in `params`.
		const body = { video_url: sourceUrl };
		if (params?.fps !== undefined && params.fps !== null) body.fps = params.fps;
		if (params?.max_seconds !== undefined && params.max_seconds !== null) {
			body.max_seconds = params.max_seconds;
		}
		return {
			path: '/infer',
			resultKey: 'result_url',
			body,
		};
	}

	if (mode === 'text2motion') {
		// Text→motion has no source mesh: the prompt rides in params. The worker
		// returns a three.js AnimationClip JSON URL (result_url), not a GLB.
		return {
			path: '/infer',
			resultKey: 'result_url',
			body: {
				prompt: params?.prompt || '',
				duration_seconds: params?.duration_seconds ?? 4,
				fps: params?.fps ?? 30,
			},
		};
	}

	return null;
}

// Expected wall-clock ETAs (seconds) per mode — used to populate the
// progress indicator on the client side.
const MODE_ETA = {
	reconstruct: 120,
	trellis: 60,
	// 50-step shape diffusion + multiview paint on the L4: much heavier than
	// TRELLIS's single pass.
	hunyuan: 300,
	remesh: 30,
	stylize: 25,
	retex: 180,
	retex_region: 60,
	rembg: 5,
	segment: 45,
	sketch: 45,
	text2motion: 30,
	rerig: 45,
	video2scene: 240,
	// CPU pose+segmentation over every frame: scales with clip length; a 30 s
	// clip lands around this.
	video2motion: 120,
};

// `reconstructUrl` overrides where `reconstruct` jobs go. The forge Hunyuan3D
// lane no longer needs it (it has its own `hunyuan` mode above); this remains
// as an escape hatch for pointing `reconstruct` at an alternate controller.
// Polling needs no override: the job envelope packs the base URL it was
// submitted to.
export function createRegenProvider({ reconstructUrl } = {}) {
	const apiKey = readEnv('GCP_RECONSTRUCTION_KEY');
	if (!apiKey) {
		throw new Error('GCP_RECONSTRUCTION_KEY env var is required for the gcp provider');
	}

	const authHeaders = {
		authorization: `Bearer ${apiKey}`,
		'content-type': 'application/json',
	};

	const urlForMode = (mode) =>
		mode === 'reconstruct' && reconstructUrl ? reconstructUrl : serviceUrlForMode(mode);

	return {
		supportsMode(mode) {
			return Boolean(urlForMode(mode));
		},

		// The reconstruction worker accepts an `images` array and fuses every
		// supplied view, so multi-view conditioning is available whenever the
		// reconstruct service is configured.
		supportsMultiview() {
			return Boolean(urlForMode('reconstruct'));
		},

		async submit(request) {
			const { mode } = request;
			const baseUrl = urlForMode(mode);
			if (!baseUrl) {
				throw Object.assign(
					new Error(`gcp provider: no service URL configured for mode "${mode}"`),
					{ code: 'mode_unconfigured', status: 501 },
				);
			}

			const workerReq = buildWorkerRequest(request);
			if (!workerReq) {
				throw Object.assign(
					new Error(`gcp provider: unsupported mode "${mode}"`),
					{ code: 'mode_unconfigured', status: 501 },
				);
			}

			const url = `${baseUrl.replace(/\/$/, '')}${workerReq.path}`;
			let response;
			try {
				response = await fetch(url, {
					method: 'POST',
					headers: authHeaders,
					body: JSON.stringify(workerReq.body),
				});
			} catch (err) {
				throw Object.assign(
					new Error(`gcp ${mode} service unreachable: ${err?.message}`),
					{ code: 'provider_unreachable', status: 502 },
				);
			}

			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				throw Object.assign(
					new Error(data?.detail || data?.error || `gcp service returned ${response.status}`),
					{ code: 'provider_error', status: 502, providerStatus: response.status },
				);
			}

			// Workers return either task_id (new) or job_id (legacy reconstruct).
			const taskId = data.task_id || data.job_id;
			if (!taskId) {
				throw Object.assign(
					new Error('gcp service returned no task_id'),
					{ code: 'provider_error', status: 502 },
				);
			}

			// Report how the job was conditioned. For reconstruct the worker fuses
			// every image in the body; the Hunyuan3D worker conditions on the
			// primary view only (report 1 so a multi-view request is never
			// silently claimed as fused); other modes are single-source.
			const viewsUsed =
				mode === 'hunyuan'
					? 1
					: (mode === 'reconstruct' || mode === 'trellis') && Array.isArray(workerReq.body.images)
						? workerReq.body.images.length
						: 0;

			return {
				extJobId: packJobId({ mode, taskId, baseUrl, resultKey: workerReq.resultKey }),
				eta: MODE_ETA[mode] ?? 60,
				backend: 'gcp',
				multiview: viewsUsed > 1,
				viewsUsed,
			};
		},

		async status(extJobId) {
			if (!extJobId) {
				return { status: 'failed', error: 'missing ext_job_id' };
			}

			const job = unpackJobId(extJobId);
			if (!job?.taskId || !job?.baseUrl) {
				return { status: 'failed', error: 'malformed ext_job_id' };
			}

			const { mode, taskId, baseUrl, resultKey } = job;

			// Legacy reconstruct path uses /jobs/:id; new workers use /tasks/:id.
			const pollPath = mode === 'reconstruct'
				? `/jobs/${encodeURIComponent(taskId)}`
				: `/tasks/${encodeURIComponent(taskId)}`;

			let response;
			try {
				response = await fetch(
					`${baseUrl.replace(/\/$/, '')}${pollPath}`,
					{ headers: authHeaders },
				);
			} catch (err) {
				return { status: 'running', error: `poll failed: ${err?.message}` };
			}

			if (response.status === 404) {
				// A 404 means the durable task record isn't visible to the instance
				// this poll landed on — usually the post-submit cross-instance window
				// (worker at high concurrency, no session affinity), not a real loss.
				// Tag it recoverable so the router can grace/recover instead of failing
				// on the first miss (see _lib/forge-selfhost-recovery.js).
				return { status: 'failed', error: 'task not found on gcp service', code: 'gcp_task_missing' };
			}

			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				return { status: 'running', error: `gcp returned ${response.status}` };
			}

			const status = translateStatus(data.status);
			const result = { status };

			if (status === 'done') {
				const url = data[resultKey] || data.result_url || data.glb_url || data.result_gcs_url;
				if (!url) {
					result.status = 'failed';
					result.error = `${mode} finished but no result URL in response`;
				} else if (mode === 'rembg') {
					result.resultImageUrl = url;
				} else if (mode === 'text2motion') {
					// The result is a three.js AnimationClip JSON, not a mesh.
					result.resultClipUrl = url;
					if (typeof data.frames === 'number') result.frames = data.frames;
					if (typeof data.fps === 'number') result.fps = data.fps;
				} else if (mode === 'video2motion') {
					// Clip JSON plus the body-swap compositing plates.
					result.resultClipUrl = url;
					if (data.meta_url) result.metaUrl = data.meta_url;
					if (data.video_url) result.videoUrl = data.video_url;
					if (data.mask_url) result.maskUrl = data.mask_url;
					if (typeof data.frames === 'number') result.frames = data.frames;
					if (typeof data.fps === 'number') result.fps = data.fps;
				} else if (mode === 'video2scene') {
					// The result is a .ply point cloud, not a GLB mesh. Surface the
					// reconstruction telemetry so the client can show point/frame counts.
					result.resultPointCloudUrl = url;
					if (typeof data.num_points === 'number') result.numPoints = data.num_points;
					if (typeof data.frames === 'number') result.frames = data.frames;
					if (typeof data.bytes === 'number') result.bytes = data.bytes;
					// The worker caps a job at its frame budget; say so rather than let a
					// partial reconstruction look like the whole clip.
					if (typeof data.frames_truncated === 'boolean') result.framesTruncated = data.frames_truncated;
					if (typeof data.sky_points_removed === 'number') result.skyPointsRemoved = data.sky_points_removed;
				} else {
					result.resultGlbUrl = url;
				}
				// Surface remesh telemetry so callers can show topology stats.
				if (mode === 'remesh') {
					if (typeof data.face_count === 'number') result.faceCount = data.face_count;
					if (typeof data.quad_ratio === 'number') result.quadRatio = data.quad_ratio;
					if (typeof data.textured === 'boolean') result.textured = data.textured;
					if (data.texture_url) result.textureUrl = data.texture_url;
					if (data.mode) result.mode = data.mode;
				}
				// Surface the parts manifest so callers can render a selectable
				// part list without a second fetch.
				if (mode === 'segment') {
					if (data.manifest_url) result.manifestUrl = data.manifest_url;
					if (Array.isArray(data.parts)) result.parts = data.parts;
					if (typeof data.part_count === 'number') result.partCount = data.part_count;
					if (typeof data.source_faces === 'number') result.sourceFaces = data.source_faces;
					if (data.method) result.segmentMethod = data.method;
					if (Array.isArray(data.warnings) && data.warnings.length) result.warnings = data.warnings;
				}
			}

			if (status === 'failed') {
				result.error = data.error || `${mode} failed`;
			}

			return result;
		},
	};
}
