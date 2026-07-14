// OKX.AI REST services — engine adapters for the decomposed 3D studio.
//
// One exported invoke() per catalog row (api/_lib/okx-catalog.js), each a thin
// wrapper over an engine the platform already runs — NO duplicated pipeline
// logic:
//
//   text-to-3d       → /api/forge submit on the free NVIDIA NIM TRELLIS lane
//                      (draft tier) via _mcp-studio/forge-client.js
//   text-to-3d-pro   → Granite art director (fail-soft) + /api/forge submit at
//                      standard/high tier — the mesh_forge chain
//   image-to-3d      → /api/forge submit, image lane (TRELLIS reconstruct)
//   rig              → /api/forge?action=rig submit (UniRig worker)
//   avatar           → the forge_avatar chain: generate to completion, then
//                      submit the rig job (humanoid gate included)
//   retarget         → apply_animation MCP tool handler (in-process retarget)
//   pose-seed        → pose_model MCP tool handler (deterministic presets)
//   fbx-export       → remesh_model MCP tool handler, operation=convert
//
// Contract with the route (api/okx/3d/[service].js): invoke AFTER payment
// verification and BEFORE settlement — a thrown error means the buyer is not
// charged. Async lanes return { status:'queued', job_id, poll_url } (polling
// GET /api/forge?job=<id> is free, no payment or account); fast lanes return
// their result inline with status:'done'.

import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { catalogEntry } from '../_lib/okx-catalog.js';
import { MESH_DIRECTOR, resolveLogoPrompt } from '../_lib/forge-director-prompts.js';
import {
	originFromReq,
	viewerUrl,
	startForge,
	startRig,
	generate,
	directPrompt,
} from '../_mcp-studio/forge-client.js';
import { TOOLS as STUDIO_TOOLS } from '../_mcp3d/catalog.js';

const ajv = new Ajv({ allErrors: true, useDefaults: true, coerceTypes: true, strict: false });
addFormats(ajv);

// Compile each paid REST row's inputSchema once; invoke() validates before any
// engine call so malformed input fails fast and free of charge.
const validators = new Map();
function validatorFor(entry) {
	let v = validators.get(entry.id);
	if (!v) {
		v = ajv.compile(entry.inputSchema);
		validators.set(entry.id, v);
	}
	return v;
}

function inputError(message) {
	const e = new Error(message);
	e.status = 400;
	e.code = 'invalid_input';
	return e;
}

// Errors from the studio MCP tool handlers carry JSON-RPC codes; normalize to
// HTTP-shaped errors the route can map without leaking internals.
function normalizeToolError(err, service) {
	if (err?.status) return err;
	const e = new Error(err?.message || `${service} failed`);
	e.status = typeof err?.code === 'number' && err.code === -32602 ? 400 : 502;
	e.code = e.status === 400 ? 'invalid_input' : 'service_failed';
	return e;
}

// The synthetic principal MCP tool handlers see for a paid OKX call: no
// account scope (payer-keyed rate limits), same shape mcp-3d.js synthesizes.
function okxAuth(payer) {
	return { userId: null, rateKey: `okx:${payer || 'anon'}`, scope: '', source: 'x402', payer };
}

function queuedResponse(job, extra = {}) {
	if (job.status === 'done' && job.glb_url) {
		return { status: 'done', glb_url: job.glb_url, ...extra };
	}
	return {
		status: 'queued',
		job_id: job.job_id,
		poll_url: job.poll_url || `/api/forge?job=${encodeURIComponent(job.job_id)}`,
		...extra,
	};
}

// Prompt used by text-to-3d-pro — the same single-subject art-director spec
// mesh_forge uses (imported from _lib/forge-director-prompts.js, the shared
// source of truth across api/_mcp-studio/tools.js, this file, and /api/forge).

// Humanoid gate for the avatar chain — mirror of the forge_avatar steer in
// api/_mcp-studio/tools.js so both surfaces refuse the same obvious objects.
const NON_HUMANOID = /\b(chair|sofa|couch|table|desk|lamp|car|truck|vehicle|building|house|tree|plant|sword|gun|bottle|cup|mug|phone|laptop|rock|stone|food|fruit|flower|dog|cat|horse|cow|fish|bird|dragon|snake|spider|dinosaur)\b/i;
const HUMANOID = /\b(human|person|man|woman|boy|girl|character|avatar|hero|warrior|knight|robot|android|figure|mascot|humanoid|biped|wizard|elf|orc|zombie|ninja|soldier|astronaut)\b/i;
function looksNonHumanoid(prompt) {
	const t = String(prompt || '');
	return NON_HUMANOID.test(t) && !HUMANOID.test(t);
}

async function callStudioTool(name, args, { req, payer }) {
	const tool = STUDIO_TOOLS[name];
	if (!tool) {
		const e = new Error(`engine tool ${name} is not available`);
		e.status = 500;
		e.code = 'engine_missing';
		throw e;
	}
	let result;
	try {
		result = await tool.handler(args, okxAuth(payer), req);
	} catch (err) {
		throw normalizeToolError(err, name);
	}
	if (result?.isError) {
		const message = result.content?.find((c) => c.type === 'text')?.text || `${name} failed`;
		throw inputError(message);
	}
	return result;
}

const HANDLERS = {
	// $0.01 — the free NVIDIA NIM TRELLIS lane, draft tier, submit-then-poll.
	async 'text-to-3d'(args, ctx) {
		const job = await startForge(ctx.base, {
			prompt: args.prompt,
			aspect: args.aspect_ratio,
			backend: 'nvidia',
			path: 'image',
		});
		return queuedResponse(job, { mode: 'text_to_3d', tier: 'draft' });
	},

	// $0.30 — Granite director (fail-soft) + the standard/high generation lane.
	// Known brand marks skip the director for the deterministic lexicon spec.
	async 'text-to-3d-pro'(args, ctx) {
		const tier = args.tier === 'high' ? 'high' : 'standard';
		let effective = args.prompt;
		const knownMark = resolveLogoPrompt(args.prompt);
		if (knownMark) {
			effective = knownMark.prompt;
		} else {
			const directed = await directPrompt(MESH_DIRECTOR, args.prompt);
			if (directed) effective = directed;
		}
		const job = await startForge(ctx.base, {
			prompt: effective,
			imageUrls: knownMark?.imagePath ? [`${ctx.base}${knownMark.imagePath}`] : undefined,
			aspect: args.aspect_ratio,
		});
		return queuedResponse(job, { mode: 'text_to_3d', tier });
	},

	// $0.30 — image lane (TRELLIS reconstruct of caller-supplied views).
	async 'image-to-3d'(args, ctx) {
		const job = await startForge(ctx.base, {
			prompt: args.prompt || undefined,
			imageUrls: args.image_urls,
			aspect: '1:1',
		});
		return queuedResponse(job, { mode: 'image_to_3d' });
	},

	// $0.25 — UniRig auto-rigging, submit-then-poll.
	async rig(args, ctx) {
		const job = await startRig(ctx.base, args.glb_url);
		return queuedResponse(job, { mode: 'rig' });
	},

	// $0.50 — the forge_avatar chain: mesh to completion, then the rig job.
	// The mesh GLB is returned even while the rig is still polling, so a rig
	// failure never loses the paid generation.
	async avatar(args, ctx) {
		if (!args.prompt && !args.image_url) {
			throw inputError('Provide a prompt or an image_url.');
		}
		if (args.prompt && !args.image_url && args.allow_non_humanoid !== true && looksNonHumanoid(args.prompt)) {
			throw inputError(
				'That looks like an object rather than a character. Auto-rigging needs a humanoid figure — use text-to-3d for objects, or set allow_non_humanoid to override.',
			);
		}
		const gen = await generate(
			ctx.base,
			{
				prompt: args.prompt || undefined,
				imageUrls: args.image_url ? [args.image_url] : undefined,
				aspect: '1:1',
			},
			{ timeoutEnv: 'STUDIO_FORGE_TIMEOUT_MS' },
		);
		if (gen._timedOut || !gen.glb_url) {
			const e = new Error('Generation took too long — you were not charged; try again.');
			e.status = 504;
			e.code = 'generation_timeout';
			throw e;
		}
		const rigJob = await startRig(ctx.base, gen.glb_url);
		return queuedResponse(rigJob, {
			mode: 'avatar',
			mesh_glb_url: gen.glb_url,
			mesh_viewer_url: viewerUrl(ctx.base, gen.glb_url),
		});
	},

	// $0.10 — in-process clip retargeting; completes inside the request.
	async retarget(args, ctx) {
		const result = await callStudioTool('apply_animation', args, ctx);
		return { status: 'done', ...(result.structuredContent || {}) };
	},

	// $0.02 — deterministic pose-seed resolution; completes inside the request.
	async 'pose-seed'(args, ctx) {
		const result = await callStudioTool('pose_model', { prompt: args.prompt }, ctx);
		return { status: 'done', ...(result.structuredContent || {}) };
	},

	// $0.10 — remesh convert (rig-preserving FBX by default), submit-then-poll.
	async 'fbx-export'(args, ctx) {
		const result = await callStudioTool(
			'remesh_model',
			{ model_url: args.model_url, operation: 'convert', format: args.format || 'fbx' },
			ctx,
		);
		const sc = result.structuredContent || {};
		if (sc.job_id) {
			return {
				status: 'queued',
				job_id: sc.job_id,
				poll_url: `/api/forge?job=${encodeURIComponent(sc.job_id)}`,
				mode: 'convert',
				format: args.format || 'fbx',
			};
		}
		return { status: 'done', ...sc };
	},
};

export function isRestPaidService(id) {
	const entry = catalogEntry(id);
	return Boolean(entry && entry.kind === 'rest' && entry.priceUsd !== '0' && HANDLERS[id]);
}

// Run one paid REST service. Validates input against the catalog schema, then
// dispatches to the engine adapter. Throws HTTP-shaped errors ({status, code,
// message}); the route maps them and skips settlement.
export async function invokeRestService(id, args, { req, payer }) {
	const entry = catalogEntry(id);
	const handler = HANDLERS[id];
	if (!entry || !handler) {
		const e = new Error(`no such service "${id}"`);
		e.status = 404;
		e.code = 'unknown_service';
		throw e;
	}
	const validate = validatorFor(entry);
	const body = args && typeof args === 'object' ? args : {};
	if (!validate(body)) {
		const first = validate.errors?.[0];
		throw inputError(
			`invalid input${first ? `: ${first.instancePath || '(root)'} ${first.message}` : ''}`,
		);
	}
	const base = originFromReq(req);
	return handler(body, { req, base, payer });
}
