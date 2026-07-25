// MCP tools for the Garment Forge: agents generate wearable, rigged catalog
// garments from a text prompt and follow the job to its published manifest.
//
// The heavy pipeline runs on the garment-forge Cloud Run worker
// (workers/garment-forge/README.md): Vertex reference image → GPU mesh fleet
// → composed onto the canonical body → auto-rigged → validated against the
// 6 rules of specs/GARMENT_MANIFEST.md → published to the public wardrobe
// catalog. These tools are the agent-facing face of the same lane the
// /api/garment-forge HTTP route exposes; the worker's bearer secret stays
// server-side.

import { limits } from '../../_lib/rate-limit.js';

const GARMENT_SLOTS = [
	'top', 'bottom', 'footwear', 'outerwear', 'hair', 'headwear', 'glasses', 'accessory',
];
const CATALOG_URL = 'https://storage.googleapis.com/three-ws-garments/garments/catalog.json';
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function rpcError(code, message, data) {
	const e = new Error(message);
	e.code = code;
	e.data = data;
	return e;
}

function workerConfig() {
	const base = (process.env.GCP_GARMENT_FORGE_URL || '').replace(/\/$/, '');
	const key = process.env.GCP_RECONSTRUCTION_KEY || '';
	if (!base || !key) {
		throw rpcError(
			-32001,
			'garment generation is not configured (GCP_GARMENT_FORGE_URL / GCP_RECONSTRUCTION_KEY unset)',
		);
	}
	return { base, key };
}

export const toolDefs = [
	{
		name: 'generate_garment',
		title: 'Generate a wearable garment from a text prompt',
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		description:
			'Turn a text prompt (e.g. "a red varsity jacket") into a rigged, wearable garment ' +
			'published to the three.ws wardrobe catalog. The pipeline generates a reference ' +
			'image, sculpts a PBR mesh on the GPU fleet, skins it to the canonical humanoid ' +
			'skeleton, and validates it (including the 60% bind-coverage gate) before ' +
			'publishing garment.glb + manifest.json + thumbnail. Runs asynchronously for ' +
			'about 7 minutes; poll with garment_status. The finished piece appears in the ' +
			'public catalog automatically and attaches to any humanoid avatar.',
		inputSchema: {
			type: 'object',
			properties: {
				prompt: {
					type: 'string',
					minLength: 3,
					maxLength: 500,
					description: 'Describe the garment (fabric, color, style).',
				},
				slot: {
					type: 'string',
					enum: GARMENT_SLOTS,
					description: 'Wardrobe slot the garment occupies.',
				},
			},
			required: ['prompt', 'slot'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			const rl = await limits.mcp3dGenerate(auth.userId || auth.rateKey);
			if (!rl.success) {
				throw rpcError(-32000, 'rate_limited', {
					retry_after: Math.ceil((rl.reset - Date.now()) / 1000),
				});
			}
			const { base, key } = workerConfig();
			const res = await fetch(`${base}/generate`, {
				method: 'POST',
				headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
				body: JSON.stringify({ prompt: args.prompt, slot: args.slot }),
			}).catch(() => null);
			if (!res || !res.ok) {
				throw new Error(`garment worker ${res ? `returned ${res.status}` : 'unreachable'}`);
			}
			const job = await res.json();
			return {
				content: [{
					type: 'text',
					text:
						`Garment job ${job.job_id} queued (slot: ${args.slot}). The pipeline takes ` +
						'about 7 minutes; call garment_status with this job_id to follow ' +
						'image → mesh → compose → rig → extract → validate → publish.',
				}],
				structuredContent: { job_id: job.job_id, status: job.status || 'queued', eta_seconds: 450 },
			};
		},
	},
	{
		name: 'garment_status',
		title: 'Check a garment generation job',
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		description:
			'Poll a generate_garment job. While running, reports the pipeline stage. When ' +
			'done, returns the published glb_url, manifest_url, thumbnail, measured bind ' +
			'coverage, and the occluded body regions — at that point the garment is already ' +
			'live in the wardrobe catalog.',
		inputSchema: {
			type: 'object',
			properties: {
				job_id: { type: 'string', description: 'Job id returned by generate_garment.' },
			},
			required: ['job_id'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			const rl = await limits.mcp3dStatus(auth.userId || auth.rateKey);
			if (!rl.success) {
				throw rpcError(-32000, 'rate_limited', {
					retry_after: Math.ceil((rl.reset - Date.now()) / 1000),
				});
			}
			if (!JOB_ID_RE.test(args.job_id)) throw new Error('malformed job id');
			const { base, key } = workerConfig();
			const res = await fetch(`${base}/jobs/${args.job_id}`, {
				headers: { authorization: `Bearer ${key}` },
			}).catch(() => null);
			if (!res) throw new Error('garment worker unreachable');
			if (res.status === 404) throw new Error('no such garment job');
			if (!res.ok) throw new Error(`garment worker returned ${res.status}`);
			const job = await res.json();
			const pub = {
				job_id: job.job_id,
				status: job.status,
				stage: job.stage || null,
				glb_url: job.glb_url || null,
				manifest_url: job.manifest_url || null,
				thumb_url: job.thumb_url || null,
				coverage: typeof job.coverage === 'number' ? job.coverage : null,
				occludes: Array.isArray(job.occludes) ? job.occludes : null,
				garment_id: job.garment_id || null,
				error: job.error || null,
			};
			const line = pub.status === 'done'
				? `Garment ${pub.garment_id} published: ${pub.glb_url} (coverage ${(pub.coverage * 100).toFixed(1)}%, occludes ${pub.occludes?.join(', ') || 'nothing'}).`
				: pub.status === 'failed'
					? `Garment job failed: ${pub.error}`
					: `Garment job ${pub.status} — stage: ${pub.stage}.`;
			return {
				content: [{ type: 'text', text: line }],
				structuredContent: pub,
			};
		},
	},
	{
		name: 'list_garment_catalog',
		title: 'List the wardrobe garment catalog',
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		description:
			'Fetch the public three.ws wardrobe catalog: every published garment manifest ' +
			'(id, slot, name, GLB url, thumbnail, occluded regions). Any entry attaches to ' +
			'any humanoid avatar via the additive wardrobe.',
		inputSchema: {
			type: 'object',
			properties: {
				slot: {
					type: 'string',
					enum: GARMENT_SLOTS,
					description: 'Optional: only garments for this slot.',
				},
			},
			additionalProperties: false,
		},
		async handler(args, auth) {
			const rl = await limits.mcp3dStatus(auth.userId || auth.rateKey);
			if (!rl.success) {
				throw rpcError(-32000, 'rate_limited', {
					retry_after: Math.ceil((rl.reset - Date.now()) / 1000),
				});
			}
			const res = await fetch(CATALOG_URL).catch(() => null);
			if (!res || !res.ok) throw new Error('garment catalog unreachable');
			const raw = await res.json();
			const garments = (Array.isArray(raw) ? raw : [])
				.filter((m) => !args.slot || m?.slot === args.slot)
				.map((m) => ({
					id: m.id,
					name: m.name,
					slot: m.slot,
					version: m.version,
					glb_url: m.model?.uri || null,
					thumbnail: m.preview?.thumbnail || null,
					occludes: m.occludes || [],
					license: m.license,
				}));
			return {
				content: [{
					type: 'text',
					text: garments.length
						? garments.map((g) => `${g.slot}/${g.id} v${g.version} — ${g.name}`).join('\n')
						: 'The catalog is empty for that filter.',
				}],
				structuredContent: { garments, count: garments.length },
			};
		},
	},
];
