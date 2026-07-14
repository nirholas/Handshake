// three.ws 3D Studio (free) — tool catalog + handlers.
//
// Six generation tools (five generators + refine_model), all FREE (no x402, no
// wallet, no API key): the platform's server-side keys cover provider cost via
// /api/forge (the public, auth-free twin of the paid pipeline). refine_model adds
// conversational iteration — describe a change and it re-generates a new version
// anchored to the prior model, returning a revertable/branchable version lineage.
// Responses carry ONLY what a client needs
// to show the model — a GLB URL, a viewer link, the kind, and the prompt — with
// every internal identifier (job id, creation id, prediction id, backend name,
// trace) stripped, per OpenAI's data-minimization policy. Each tool links the
// Apps SDK widget via _meta["openai/outputTemplate"] and returns structuredContent
// the widget renders. No coin, token, wallet, or payment surface anywhere.

import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { assertSafePublicUrl, SsrfBlockedError } from '../_lib/ssrf-guard.js';
import { MESH_DIRECTOR, AVATAR_DIRECTOR } from '../_lib/forge-director-prompts.js';
import { checkPromptSafety } from './safety.js';
import {
	originFromReq,
	viewerUrl,
	generate,
	rig,
	directPrompt,
} from './forge-client.js';
import { COMPONENT_URI } from './component.js';
import { buildSpatialArtifact } from '../_lib/spatial-mcp.js';
// Pure, dependency-free lineage core — the SAME module the paid stdio server's
// runRefineModel uses (mcp-server/src/tools/_lineage.js), so conversational
// iteration behaves identically on both tracks and never drifts. It carries
// zero payment/coin/wallet surface — safe to import into the free studio bundle.
import {
	composeRefinement,
	seedLineage,
	appendVersion,
	summarizeLineage,
	buildLineageChain,
	branchFrom,
} from '../../mcp-server/src/tools/_lineage.js';

const VALID_TIER = new Set(['draft', 'standard', 'high']);

// ── result helpers ──────────────────────────────────────────────────────────

// The bucket's public r2.dev domain only answers CORS for our own origin, but
// ChatGPT renders the widget in a sandboxed cross-origin iframe — model-viewer
// there can only fetch a GLB served with open CORS. /cdn/<key> (api/cdn-object.js)
// streams the same object first-party with `access-control-allow-origin: *`, so
// every URL a widget must fetch goes out in its CDN form.
function firstPartyGlbUrl(glbUrl, base) {
	const pub = process.env.S3_PUBLIC_DOMAIN;
	if (!pub || !base || typeof glbUrl !== 'string' || !glbUrl.startsWith(`${pub}/`)) return glbUrl;
	return `${base}/cdn/${glbUrl.slice(pub.length + 1)}`;
}

// Minimal, identifier-free success envelope. structuredContent is the contract
// the widget + model read; content is the human/agent-readable narration.
function ok({ glbUrl, base, kind, prompt, rigged }) {
	glbUrl = firstPartyGlbUrl(glbUrl, base);
	const vUrl = viewerUrl(base, glbUrl);
	const structured = {
		kind,
		glbUrl,
		viewerUrl: vUrl,
		format: 'glb',
		...(prompt ? { prompt } : {}),
		...(rigged ? { rigged: true } : {}),
		// Spatial MCP artifact — the open, coin-clean shape for a 3D-native tool
		// result (specs/SPATIAL_MCP.md). Additive to the fields the widget already
		// reads, so any Spatial-MCP renderer can display this model, not just ours.
		spatial: buildSpatialArtifact({
			glbUrl,
			kind: rigged ? 'rigged-model' : kind === 'avatar' ? 'avatar' : kind === 'mesh' ? 'mesh' : 'model',
			viewerUrl: vUrl,
			prompt: prompt || undefined,
			rigged: Boolean(rigged),
		}),
	};
	const label = rigged ? 'rigged 3D model' : '3D model';
	return {
		content: [
			{
				type: 'text',
				text: `Generated a ${label} (GLB). View it: ${structured.viewerUrl}\nDownload: ${glbUrl}`,
			},
		],
		structuredContent: structured,
	};
}

function toolError(message) {
	return {
		content: [{ type: 'text', text: message }],
		structuredContent: { error: true, message },
		isError: true,
	};
}

// Success envelope for a conversational refinement. Carries the same minimal,
// identifier-free fields as ok() PLUS the version lineage the widget renders as
// a version strip. The lineage is the durable record the client passes back on
// the next refinement (parent_lineage) so branch/revert work without any
// server-side session — a pointer move over an immutable array, never a mutation.
function refineOk({ glbUrl, base, prompt, instruction, lineage, activeIndex }) {
	glbUrl = firstPartyGlbUrl(glbUrl, base);
	const vUrl = viewerUrl(base, glbUrl);
	const structured = {
		kind: 'refined model',
		glbUrl,
		viewerUrl: vUrl,
		format: 'glb',
		...(prompt ? { prompt } : {}),
		...(instruction ? { instruction } : {}),
		// Version chips swap GLBs inside the same sandboxed iframe, so every
		// lineage URL needs the CDN form too.
		lineage: summarizeLineage(lineage, activeIndex).map((v) => ({
			...v,
			glbUrl: firstPartyGlbUrl(v.glbUrl, base),
		})),
		activeIndex,
		// Conformant Spatial MCP artifact (specs/SPATIAL_MCP.md) for the refined model.
		spatial: buildSpatialArtifact({ glbUrl, kind: 'model', viewerUrl: vUrl, prompt: prompt || undefined, title: instruction || undefined }),
	};
	const versionNo = activeIndex; // 0 = original, 1 = first refinement, …
	return {
		content: [
			{
				type: 'text',
				text: `Refined the model (v${versionNo}: "${instruction}"). View it: ${structured.viewerUrl}\nDownload: ${glbUrl}`,
			},
		],
		structuredContent: structured,
	};
}

// Map a coded forge-client failure to a clean, user-facing message — never leak
// provider internals, hostnames, or stack text.
function failureMessage(err) {
	switch (err?.code) {
		case 'timeout':
			return 'Generation is taking longer than expected. Please try again.';
		case 'busy':
			return 'The 3D generator is busy right now. Please try again in a moment.';
		case 'not_configured':
			return 'This capability is temporarily unavailable. Please try again later.';
		case 'generation_failed':
			return 'Generation failed for this prompt. Try rephrasing or simplifying it.';
		default:
			return 'Could not generate the model right now. Please try again.';
	}
}

async function guardImage(url) {
	if (!url) return;
	try {
		await assertSafePublicUrl(url);
	} catch (err) {
		if (err instanceof SsrfBlockedError) throw Object.assign(new Error('That image URL is not allowed.'), { userMessage: true });
		throw err;
	}
}

// Compact humanoid heuristic for the avatar gate — auto-rigging assumes a biped.
// A clearly non-humanoid subject is steered to mesh generation instead of
// silently wasting a rig pass. Conservative: only obvious objects/quadrupeds
// short-circuit; ambiguous prompts proceed.
const NON_HUMANOID = /\b(chair|sofa|couch|table|desk|lamp|car|truck|vehicle|building|house|tree|plant|sword|gun|bottle|cup|mug|phone|laptop|rock|stone|food|fruit|flower|dog|cat|horse|cow|fish|bird|dragon|snake|spider|dinosaur)\b/i;
const HUMANOID = /\b(human|person|man|woman|boy|girl|character|avatar|hero|warrior|knight|robot|android|figure|mascot|humanoid|biped|wizard|elf|orc|zombie|ninja|soldier|astronaut)\b/i;

function looksNonHumanoid(prompt) {
	const t = String(prompt || '');
	return NON_HUMANOID.test(t) && !HUMANOID.test(t);
}

// ── handlers ────────────────────────────────────────────────────────────────

async function handleForgeFree(args, _auth, req) {
	const base = originFromReq(req);
	const prompt = String(args.prompt || '').trim();
	if (prompt.length < 3) return toolError('Provide a text prompt of at least 3 characters.');
	const safety = checkPromptSafety(prompt);
	if (!safety.allowed) return toolError(safety.message);
	const tier = VALID_TIER.has(args.tier) ? args.tier : 'draft';
	let job;
	try {
		job = await generate(base, { prompt, backend: 'nvidia', path: 'image', tier }, { timeoutEnv: 'STUDIO_FORGE_TIMEOUT_MS' });
	} catch (err) {
		return toolError(failureMessage(err));
	}
	if (job._timedOut || !job.glb_url) return toolError('Generation is taking longer than expected. Please try again.');
	return ok({ glbUrl: job.glb_url, base, kind: 'model', prompt });
}

async function handleTextToAvatar(args, _auth, req) {
	const base = originFromReq(req);
	const prompt = String(args.prompt || '').trim();
	const imageUrl = args.image_url ? String(args.image_url).trim() : '';
	if (!prompt && !imageUrl) return toolError('Provide a text prompt or a reference image_url.');
	if (prompt) {
		const safety = checkPromptSafety(prompt);
		if (!safety.allowed) return toolError(safety.message);
	}
	try {
		await guardImage(imageUrl);
	} catch (err) {
		return toolError(err.userMessage ? err.message : 'That image URL could not be used.');
	}
	let job;
	try {
		job = await generate(
			base,
			{ prompt: prompt || undefined, imageUrls: imageUrl ? [imageUrl] : undefined, aspect: '1:1' },
			{ timeoutEnv: 'STUDIO_FORGE_TIMEOUT_MS' },
		);
	} catch (err) {
		return toolError(failureMessage(err));
	}
	if (job._timedOut || !job.glb_url) return toolError('Generation is taking longer than expected. Please try again.');
	return ok({ glbUrl: job.glb_url, base, kind: 'avatar', prompt: prompt || undefined });
}

async function handleMeshForge(args, _auth, req) {
	const base = originFromReq(req);
	const prompt = String(args.prompt || '').trim();
	const imageUrl = args.image_url ? String(args.image_url).trim() : '';
	if (!prompt && !imageUrl) return toolError('Provide a text prompt or a reference image_url.');
	if (prompt) {
		const safety = checkPromptSafety(prompt);
		if (!safety.allowed) return toolError(safety.message);
	}
	try {
		await guardImage(imageUrl);
	} catch (err) {
		return toolError(err.userMessage ? err.message : 'That image URL could not be used.');
	}
	// Granite prompt director (text mode only; fail-soft — original prompt on any failure).
	let effective = prompt;
	if (prompt && !imageUrl) {
		const directed = await directPrompt(base, MESH_DIRECTOR, prompt);
		if (directed) effective = directed;
	}
	let job;
	try {
		job = await generate(
			base,
			{ prompt: effective || undefined, imageUrls: imageUrl ? [imageUrl] : undefined, aspect: '1:1' },
			{ timeoutEnv: 'STUDIO_FORGE_TIMEOUT_MS' },
		);
	} catch (err) {
		return toolError(failureMessage(err));
	}
	if (job._timedOut || !job.glb_url) return toolError('Generation is taking longer than expected. Please try again.');
	return ok({ glbUrl: job.glb_url, base, kind: 'mesh', prompt: prompt || undefined });
}

async function handleRigMesh(args, _auth, req) {
	const base = originFromReq(req);
	const glbUrl = String(args.glb_url || '').trim();
	if (!/^https?:\/\//i.test(glbUrl)) return toolError('Provide an http(s) URL to a GLB mesh to rig.');
	try {
		await guardImage(glbUrl);
	} catch (err) {
		return toolError(err.userMessage ? err.message : 'That GLB URL could not be used.');
	}
	let job;
	try {
		job = await rig(base, glbUrl, { timeoutEnv: 'STUDIO_RIG_TIMEOUT_MS' });
	} catch (err) {
		return toolError(failureMessage(err));
	}
	if (job._timedOut || !job.glb_url) return toolError('Rigging is taking longer than expected. Please try again.');
	return ok({ glbUrl: job.glb_url, base, kind: 'rigged model', rigged: true });
}

async function handleForgeAvatar(args, _auth, req) {
	const base = originFromReq(req);
	const prompt = String(args.prompt || '').trim();
	const imageUrl = args.image_url ? String(args.image_url).trim() : '';
	if (!prompt && !imageUrl) return toolError('Provide a text prompt or a reference image_url.');
	if (prompt) {
		const safety = checkPromptSafety(prompt);
		if (!safety.allowed) return toolError(safety.message);
	}
	if (prompt && !imageUrl && args.allow_non_humanoid !== true && looksNonHumanoid(prompt)) {
		return toolError(
			'That looks like an object rather than a character. Auto-rigging needs a humanoid figure — use the 3D mesh generator for objects, or set allow_non_humanoid to override.',
		);
	}
	try {
		await guardImage(imageUrl);
	} catch (err) {
		return toolError(err.userMessage ? err.message : 'That image URL could not be used.');
	}
	// Stage 1 — generate the mesh (Granite director in text mode, fail-soft).
	let effective = prompt;
	if (prompt && !imageUrl) {
		const directed = await directPrompt(base, AVATAR_DIRECTOR, prompt);
		if (directed) effective = directed;
	}
	let gen;
	try {
		gen = await generate(
			base,
			{ prompt: effective || undefined, imageUrls: imageUrl ? [imageUrl] : undefined, aspect: '1:1' },
			{ timeoutEnv: 'STUDIO_FORGE_TIMEOUT_MS' },
		);
	} catch (err) {
		return toolError(failureMessage(err));
	}
	if (gen._timedOut || !gen.glb_url) return toolError('Generation is taking longer than expected. Please try again.');

	// Stage 2 — auto-rig the generated mesh.
	let rigged;
	try {
		rigged = await rig(base, gen.glb_url, { timeoutEnv: 'STUDIO_RIG_TIMEOUT_MS' });
	} catch (err) {
		// Generation succeeded but rigging failed — hand back the (unrigged) mesh so
		// the work isn't lost, and say so plainly.
		return {
			content: [
				{
					type: 'text',
					text: `Generated the mesh but auto-rigging failed (${failureMessage(err)}). You can still use the model: ${viewerUrl(base, gen.glb_url)}`,
				},
			],
			structuredContent: {
				kind: 'mesh',
				glbUrl: gen.glb_url,
				viewerUrl: viewerUrl(base, gen.glb_url),
				format: 'glb',
				...(prompt ? { prompt } : {}),
			},
		};
	}
	if (rigged._timedOut || !rigged.glb_url) return toolError('Rigging is taking longer than expected. Please try again.');
	return ok({ glbUrl: rigged.glb_url, base, kind: 'avatar', prompt: prompt || undefined, rigged: true });
}

// Conversational refinement — carry a prior model forward with a natural-language
// change ("make it metallic", "bigger helmet"). REAL anchored re-generation: the
// parent prompt is folded into the new prompt so form/subject/materials carry
// forward, and when a reference image of the parent is supplied it anchors the
// generation as image→3D. No faked diffing — the composed prompt is what the
// generator actually runs. Every version is recorded in an immutable lineage the
// client passes back to branch/revert. Free, stateless, zero payment surface.
async function handleRefineModel(args, _auth, req) {
	const base = originFromReq(req);
	const glbUrl = String(args.glb_url || '').trim();
	if (!/^https?:\/\//i.test(glbUrl)) return toolError('Provide the http(s) glb_url of the model to refine.');
	const instruction = String(args.instruction || '').trim();
	if (!instruction) return toolError('Provide an instruction describing the change, e.g. "make it metallic".');
	const safety = checkPromptSafety(instruction);
	if (!safety.allowed) return toolError(safety.message);

	const parentPrompt = typeof args.parent_prompt === 'string' ? args.parent_prompt.trim() : '';
	if (parentPrompt) {
		const ps = checkPromptSafety(parentPrompt);
		if (!ps.allowed) return toolError(ps.message);
	}
	const refImageUrl = args.reference_image_url ? String(args.reference_image_url).trim() : '';
	try {
		await guardImage(glbUrl);
		if (refImageUrl) await guardImage(refImageUrl);
	} catch (err) {
		return toolError(err.userMessage ? err.message : 'That URL could not be used.');
	}

	const composed = composeRefinement(parentPrompt, instruction);

	// Resolve the starting lineage: extend the one the client passed, or seed a
	// fresh lineage rooted at the parent model. The client-supplied lineage is
	// UNTRUSTED — validate its structural integrity (contiguous indices, single
	// root, no cycles) with buildLineageChain before extending it. A malformed
	// array (buggy client, tampering) falls back to a fresh lineage rooted at the
	// parent model rather than corrupting history.
	const freshLineage = () => seedLineage({ glbUrl, viewerUrl: viewerUrl(base, glbUrl), prompt: parentPrompt || null });
	const clientLineage = Array.isArray(args.parent_lineage) ? args.parent_lineage : null;
	let baseLineage;
	if (clientLineage && clientLineage.length > 0) {
		const rehydrated = clientLineage.map((v, i) => ({
			index: Number.isInteger(v.index) ? v.index : i,
			parentIndex: v.parentIndex ?? (i > 0 ? i - 1 : null),
			glbUrl: v.glbUrl,
			viewerUrl: v.viewerUrl || null,
			prompt: v.prompt || null,
			instruction: v.instruction || null,
			refKind: v.refKind || (i === 0 ? 'origin' : 'text'),
		}));
		baseLineage = buildLineageChain(rehydrated).ok ? rehydrated : freshLineage();
	} else {
		baseLineage = freshLineage();
	}

	// Branch point: refine off an earlier version instead of the leaf. branchFrom
	// validates the index against the lineage; an out-of-range index falls back to
	// the default (extend the leaf) rather than erroring.
	let parentIndex;
	if (Number.isInteger(args.parent_index)) {
		try {
			parentIndex = branchFrom(baseLineage, args.parent_index);
		} catch {
			parentIndex = undefined;
		}
	}

	let job;
	try {
		job = await generate(
			base,
			refImageUrl ? { prompt: composed, imageUrls: [refImageUrl], aspect: '1:1' } : { prompt: composed },
			{ timeoutEnv: 'STUDIO_REFINE_TIMEOUT_MS' },
		);
	} catch (err) {
		return toolError(failureMessage(err));
	}
	if (job._timedOut || !job.glb_url) return toolError('Refinement is taking longer than expected. Please try again.');

	const lineage = appendVersion(baseLineage, {
		glbUrl: job.glb_url,
		viewerUrl: viewerUrl(base, job.glb_url),
		prompt: composed,
		instruction,
		refKind: refImageUrl ? 'image' : 'text',
		...(parentIndex !== undefined ? { parentIndex } : {}),
	});
	return refineOk({ glbUrl: job.glb_url, base, prompt: composed, instruction, lineage, activeIndex: lineage.length - 1 });
}

// ── definitions ─────────────────────────────────────────────────────────────

const GEN_ANNOTATIONS = {
	readOnlyHint: false, // tools create a new hosted asset
	destructiveHint: false, // they never modify or delete anything
	idempotentHint: false, // same prompt → a fresh, different mesh each call
	openWorldHint: true, // work runs against external model APIs
};

function widgetMeta(invoking, invoked) {
	return {
		'openai/outputTemplate': COMPONENT_URI,
		'openai/toolInvocation/invoking': invoking,
		'openai/toolInvocation/invoked': invoked,
		'openai/widgetAccessible': true,
	};
}

const DEFS = [
	{
		name: 'forge_free',
		title: 'Generate a 3D model from text',
		description:
			'Turn a text prompt into a textured, downloadable 3D model (GLB) — free. Describe a single object, ' +
			'character, or creature; the studio generates an interactive model you can rotate, view, and download. ' +
			'Choose a quality tier (draft = fast, standard, high). Renders inline in an interactive 3D viewer.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			required: ['prompt'],
			properties: {
				prompt: {
					type: 'string',
					minLength: 3,
					maxLength: 1000,
					description: 'Description of the single object or character to model, e.g. "a friendly round robot mascot, glossy white plastic".',
				},
				tier: {
					type: 'string',
					enum: ['draft', 'standard', 'high'],
					description: 'Detail level: draft (fast, default), standard, or high. Higher tiers take longer.',
				},
			},
		},
		annotations: GEN_ANNOTATIONS,
		_meta: widgetMeta('Generating your 3D model…', 'Here is your 3D model'),
		handler: handleForgeFree,
	},
	{
		name: 'text_to_avatar',
		title: 'Generate a 3D avatar',
		description:
			'Generate a textured 3D avatar (GLB) from a text description or a reference image URL. Best for ' +
			'characters and figures. Renders inline in an interactive 3D viewer.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				prompt: { type: 'string', maxLength: 1000, description: 'Description of the avatar to generate.' },
				image_url: { type: 'string', format: 'uri', description: 'Optional http(s) URL to a reference image to reconstruct in 3D.' },
			},
		},
		annotations: GEN_ANNOTATIONS,
		_meta: widgetMeta('Generating your avatar…', 'Here is your avatar'),
		handler: handleTextToAvatar,
	},
	{
		name: 'mesh_forge',
		title: 'Generate a 3D mesh (art-directed)',
		description:
			'Generate a textured 3D mesh (GLB) from a text prompt or a reference image URL. In text mode an AI ' +
			'art-director first refines your prompt into an optimized single-subject spec for higher mesh quality. ' +
			'Renders inline in an interactive 3D viewer.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				prompt: { type: 'string', maxLength: 1000, description: 'Description of the single object to model.' },
				image_url: { type: 'string', format: 'uri', description: 'Optional http(s) URL to a reference image to reconstruct directly.' },
			},
		},
		annotations: GEN_ANNOTATIONS,
		_meta: widgetMeta('Generating your 3D mesh…', 'Here is your 3D mesh'),
		handler: handleMeshForge,
	},
	{
		name: 'rig_mesh',
		title: 'Rig a 3D model for animation',
		description:
			'Auto-rig a static 3D model (GLB) into an animation-ready model: adds a humanoid skeleton and skin ' +
			'weights so it can be posed and animated. Provide the GLB URL of a model (e.g. one generated by the ' +
			'other tools). Renders the rigged result inline in an interactive 3D viewer.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			required: ['glb_url'],
			properties: {
				glb_url: { type: 'string', format: 'uri', description: 'http(s) URL to the static GLB mesh to rig.' },
			},
		},
		annotations: GEN_ANNOTATIONS,
		_meta: widgetMeta('Rigging your model…', 'Here is your rigged model'),
		handler: handleRigMesh,
	},
	{
		name: 'forge_avatar',
		title: 'Generate a rigged, animation-ready avatar',
		description:
			'Generate a rigged, animation-ready 3D avatar (GLB) from a single text prompt or a reference image — ' +
			'in one step. Generates the mesh, then auto-rigs it with a humanoid skeleton so it is ready to pose and ' +
			'animate. Best for characters; objects are steered to the mesh generator. Renders inline in an ' +
			'interactive 3D viewer.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				prompt: { type: 'string', maxLength: 1000, description: 'Description of the character/avatar to generate.' },
				image_url: { type: 'string', format: 'uri', description: 'Optional http(s) URL to a reference image to reconstruct in 3D.' },
				allow_non_humanoid: { type: 'boolean', description: 'Set true to rig a non-humanoid subject anyway (rigging assumes a humanoid figure).' },
			},
		},
		annotations: GEN_ANNOTATIONS,
		_meta: widgetMeta('Generating your rigged avatar…', 'Here is your rigged avatar'),
		handler: handleForgeAvatar,
	},
	{
		name: 'refine_model',
		title: 'Refine a 3D model by describing a change',
		description:
			'Iterate on a model you already generated — just describe the change in words ("make it metallic", ' +
			'"bigger helmet", "add wings"). The studio re-generates a new version anchored to the previous one, ' +
			'carrying its form and materials forward. Pass the previous model\'s glb_url and, when you have it, the ' +
			'prompt that made it (parent_prompt) so the change builds on it. Each refinement is recorded as a new ' +
			'version in a lineage you can revert to or branch from — the returned lineage drives a version strip in ' +
			'the viewer. Renders the new version inline in the interactive 3D viewer.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			required: ['glb_url', 'instruction'],
			properties: {
				glb_url: { type: 'string', format: 'uri', description: 'http(s) URL of the model to refine (e.g. the glbUrl a previous generation returned).' },
				instruction: {
					type: 'string',
					minLength: 1,
					maxLength: 500,
					description: 'The change to make, in plain language: "make it metallic", "bigger helmet", "add a cape".',
				},
				parent_prompt: {
					type: 'string',
					maxLength: 1000,
					description: 'Optional — the prompt that produced the model being refined, so the change builds on it instead of starting over.',
				},
				reference_image_url: {
					type: 'string',
					format: 'uri',
					description: 'Optional http(s) image of the current model to anchor the re-generation (image→3D). Omit for text-guided refinement.',
				},
				parent_lineage: {
					type: 'array',
					description: 'Optional — the lineage array from a previous refine_model result, to extend the same version history.',
					items: { type: 'object', additionalProperties: true },
				},
				parent_index: {
					type: 'integer',
					minimum: 0,
					description: 'Optional — branch off an earlier version in parent_lineage (its index) instead of the latest.',
				},
			},
		},
		annotations: GEN_ANNOTATIONS,
		_meta: widgetMeta('Refining your 3D model…', 'Here is the refined model'),
		handler: handleRefineModel,
	},
];

// Schemas for tools/list — strip the handler (and any server-only field).
export const TOOL_CATALOG = DEFS.map(({ handler: _h, ...schema }) => schema);

const ajv = new Ajv({ allErrors: true, useDefaults: true, coerceTypes: true, strict: false });
addFormats(ajv);

export const TOOLS = Object.fromEntries(
	DEFS.map(({ name, handler, inputSchema }) => [name, { handler, validate: inputSchema ? ajv.compile(inputSchema) : null }]),
);

export const TOOL_NAMES = DEFS.map((d) => d.name);
