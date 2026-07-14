// three.ws 3D Studio (FREE) — tool definitions for /api/mcp-studio.
//
// Five generation tools, exposed FREE: no x402, no wallet, no payment surface.
// They reuse the REAL production generation handlers (mcp-server/src/tools/
// _studio-core.js — the same cores the paid stdio MCP server runs), so there is
// no fork and no mock. The provider cost is operator-funded by server-side keys;
// abuse is bounded by per-IP rate limits in the endpoint (api/mcp-studio.js).
//
// OpenAI Apps SDK submission posture (developers.openai.com/apps-sdk):
//   • Zero token/crypto/payment surface — no coin, mint, price, or x402 field
//     appears in any tool name, description, input, or response.
//   • Responses carry ONLY what a caller needs: the GLB URL (documented key
//     `glbUrl`), a viewer link, minimal task metadata, and an inline
//     <model-viewer> artifact. Internal identifiers (job/creation/prediction
//     ids, resume URLs, pinned model versions, backend internals) are STRIPPED.
//   • Inputs are minimal and task-specific — a prompt, an optional image, and
//     the few knobs that change the result. No chat-history requests.

import {
	runForgeFree,
	runMeshForge,
	runRigMesh,
	runTextToAvatar,
	runForgeAvatar,
} from '../../mcp-server/src/tools/_studio-core.js';
import { renderModelViewerHtml } from '../_mcp/render.js';

// Public origin used to build viewer / pose-studio links in the SANITIZED
// response — independent of whichever internal origin the cores call. Always a
// public three.ws URL the Apps SDK component can open.
const PUBLIC_BASE = (process.env.STUDIO_PUBLIC_BASE || 'https://three.ws').replace(/\/$/, '');

const viewerUrl = (glbUrl) => `${PUBLIC_BASE}/viewer?src=${encodeURIComponent(glbUrl)}`;
const poseUrl = (glbUrl) => `${PUBLIC_BASE}/pose?src=${encodeURIComponent(glbUrl)}`;
// Device-aware AR launch (/api/ar): iPhone → Quick Look, Android → Scene
// Viewer, desktop → WebGL viewer. The SAME one-tap "place it in your home"
// flow the forge site uses; every generation response carries it.
const arUrl = (glbUrl) => buildArLaunchUrl(PUBLIC_BASE, glbUrl);

// Generation annotations (per Apps SDK guidance): these tools mint a fresh
// external artifact, so they are writes, non-destructive, non-idempotent, and
// open-world (they reach external model APIs).
const GEN_ANNOTATIONS = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
};

// Build the MCP CallToolResult for a SUCCESSFUL generation. `structured` is the
// already-sanitized public payload; `glbUrl` drives the inline 3D artifact and
// the human-readable text mirror. The component reads `structuredContent.glbUrl`.
function ok(structured, glbUrl, name) {
	const artifact = {
		type: 'resource',
		resource: {
			uri: glbUrl,
			mimeType: 'text/html',
			text: renderModelViewerHtml({
				src: glbUrl,
				name: name || '3D model',
				background: 'transparent',
				height: '480px',
				width: '100%',
				autoRotate: true,
				ar: true,
			}),
		},
	};
	return {
		content: [
			{ type: 'text', text: JSON.stringify(structured) },
			artifact,
		],
		structuredContent: structured,
	};
}

// Build the MCP CallToolResult for a FAILED generation. Only the stable
// { ok:false, error, message, retryAfter? } contract is surfaced — every
// internal id / resume URL / raw provider output the core attached is dropped.
function fail(raw) {
	const structured = { ok: false, error: raw.error || 'error', message: raw.message || 'failed' };
	if (raw.retryAfter != null) structured.retryAfter = raw.retryAfter;
	return {
		content: [{ type: 'text', text: JSON.stringify(structured) }],
		structuredContent: structured,
		isError: true,
	};
}

// ── forge_free ──────────────────────────────────────────────────────────────
const forgeFree = {
	name: 'forge_free',
	title: 'Text → 3D model',
	description:
		'Turn a text prompt into a textured, downloadable 3D model (GLB). Describe a single object or ' +
		'character — e.g. "a friendly round robot mascot, glossy white plastic" — and get back a 3D model ' +
		'URL plus an interactive viewer you can rotate in the browser. Choose quality draft (fast, default), ' +
		'standard, or high. Text only; for image → 3D use mesh_forge. Feed the result to rig_mesh to make it ' +
		'animation-ready.',
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		required: ['prompt'],
		properties: {
			prompt: {
				type: 'string',
				minLength: 3,
				maxLength: 1000,
				title: 'Prompt',
				description:
					'What to model — lead with the subject and its key materials and colors, e.g. "a worn leather armchair, brass studs".',
			},
			tier: {
				type: 'string',
				enum: ['draft', 'standard', 'high'],
				default: 'draft',
				title: 'Quality',
				description: 'draft = fast preview (default), standard = balanced, high = densest mesh.',
			},
		},
	},
	annotations: GEN_ANNOTATIONS,
	handler: async (args) => {
		const r = await runForgeFree({ prompt: args.prompt, tier: args.tier });
		if (r.ok === false) return fail(r);
		const structured = {
			ok: true,
			kind: 'mesh',
			glbUrl: r.glbUrl,
			viewerUrl: viewerUrl(r.glbUrl),
			arUrl: arUrl(r.glbUrl),
			prompt: r.prompt,
			tier: r.tier,
			durationMs: r.durationMs,
		};
		return ok(structured, r.glbUrl, args.prompt);
	},
};

// ── text_to_avatar ──────────────────────────────────────────────────────────
const textToAvatar = {
	name: 'text_to_avatar',
	title: 'Text/Image → 3D avatar',
	description:
		'Generate a textured 3D avatar (GLB) from a text prompt or a reference image. Returns the 3D model ' +
		'URL and an interactive viewer. Provide a prompt describing the character, optionally an image URL to ' +
		'reconstruct from. For a non-character object use forge_free or mesh_forge; to make the avatar ' +
		'animation-ready use forge_avatar (one call) or rig_mesh on the result.',
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			prompt: {
				type: 'string',
				maxLength: 1000,
				title: 'Prompt',
				description: 'Description of the avatar/character to generate. Provide this or an image.',
			},
			image_url: {
				type: 'string',
				format: 'uri',
				title: 'Reference image',
				description:
					'Optional http(s) URL to a reference image. When set, the avatar is reconstructed from the image.',
			},
		},
	},
	annotations: GEN_ANNOTATIONS,
	handler: async (args) => {
		const images = typeof args.image_url === 'string' && args.image_url.trim() ? [args.image_url.trim()] : undefined;
		const r = await runTextToAvatar({ prompt: args.prompt, images });
		if (r.ok === false) return fail(r);
		const structured = {
			ok: true,
			kind: 'avatar',
			glbUrl: r.glbUrl,
			viewerUrl: viewerUrl(r.glbUrl),
			arUrl: arUrl(r.glbUrl),
			prompt: r.prompt,
			durationMs: r.durationMs,
		};
		return ok(structured, r.glbUrl, args.prompt || 'avatar');
	},
};

// ── mesh_forge ──────────────────────────────────────────────────────────────
const meshForge = {
	name: 'mesh_forge',
	title: 'Text/Image → 3D mesh',
	description:
		'Generate a textured 3D mesh (GLB) from a text prompt, a single reference image, or 1–4 reference ' +
		'views of the same object (front/back/left/right) for higher-fidelity reconstruction with no ' +
		'hallucinated back. Returns the 3D model URL and an interactive viewer. Feed the result to rig_mesh to ' +
		'make it animation-ready.',
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			prompt: {
				type: 'string',
				minLength: 3,
				maxLength: 1000,
				title: 'Prompt',
				description:
					'Text → 3D: description of the single object to model. Optional when an image is provided.',
			},
			image_url: {
				type: 'string',
				format: 'uri',
				title: 'Reference image',
				description: 'Image → 3D: an http(s) URL to reconstruct directly.',
			},
			image_urls: {
				type: 'array',
				items: { type: 'string', format: 'uri' },
				minItems: 1,
				maxItems: 4,
				title: 'Multi-view images',
				description:
					'Multi-view → 3D: 1–4 http(s) URLs of the SAME object from different angles. Takes precedence over image_url.',
			},
		},
	},
	annotations: GEN_ANNOTATIONS,
	handler: async (args) => {
		const r = await runMeshForge({
			prompt: args.prompt,
			image_url: args.image_url,
			image_urls: args.image_urls,
		});
		if (r.ok === false) return fail(r);
		const structured = {
			ok: true,
			kind: 'mesh',
			mode: r.mode,
			glbUrl: r.glbUrl,
			viewerUrl: viewerUrl(r.glbUrl),
			arUrl: arUrl(r.glbUrl),
			prompt: r.prompt,
			viewsUsed: r.viewsUsed,
			durationMs: r.durationMs,
		};
		return ok(structured, r.glbUrl, args.prompt || 'mesh');
	},
};

// ── rig_mesh ────────────────────────────────────────────────────────────────
const rigMesh = {
	name: 'rig_mesh',
	title: 'Rig a 3D model',
	description:
		'Turn a static 3D model (GLB) into an animation-ready one: adds a humanoid skeleton and skin weights. ' +
		'Pass a GLB URL (e.g. the result of forge_free or mesh_forge) and get back a rigged GLB plus a ' +
		'pose-studio link to animate it.',
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		required: ['glb_url'],
		properties: {
			glb_url: {
				type: 'string',
				format: 'uri',
				title: 'Model URL',
				description: 'http(s) URL to the static GLB mesh to rig.',
			},
		},
	},
	annotations: GEN_ANNOTATIONS,
	handler: async (args) => {
		const r = await runRigMesh({ glb_url: args.glb_url });
		if (r.ok === false) return fail(r);
		const structured = {
			ok: true,
			kind: 'rigged',
			glbUrl: r.riggedGlbUrl,
			sourceGlbUrl: r.sourceGlbUrl,
			viewerUrl: viewerUrl(r.riggedGlbUrl),
			poseStudioUrl: poseUrl(r.riggedGlbUrl),
			durationMs: r.durationMs,
		};
		return ok(structured, r.riggedGlbUrl, 'rigged model');
	},
};

// ── forge_avatar ────────────────────────────────────────────────────────────
const forgeAvatar = {
	name: 'forge_avatar',
	title: 'Text/Image → rigged avatar',
	description:
		'Generate a rigged, animation-ready 3D avatar from a text prompt or reference image(s) in ONE call: ' +
		'it generates a textured mesh and then adds a humanoid skeleton + skin weights, so the result loads ' +
		'straight into the pose studio and plays the idle/walk animation library. A humanoid check runs first; ' +
		'a clearly non-humanoid subject (furniture, vehicle, quadruped) is declined — use mesh_forge or ' +
		'forge_free for those, or set allow_non_humanoid to rig it anyway. Returns the rigged GLB URL, the ' +
		'intermediate mesh URL, a viewer, and a pose-studio link.',
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			prompt: {
				type: 'string',
				minLength: 3,
				maxLength: 1000,
				title: 'Prompt',
				description:
					'Description of a single humanoid character. Optional when an image is provided.',
			},
			image_url: {
				type: 'string',
				format: 'uri',
				title: 'Reference image',
				description: 'http(s) URL to a reference image of a character to reconstruct and rig.',
			},
			image_urls: {
				type: 'array',
				items: { type: 'string', format: 'uri' },
				minItems: 1,
				maxItems: 4,
				title: 'Multi-view images',
				description:
					'1–4 http(s) URLs of the SAME character from different angles. Takes precedence over image_url.',
			},
			allow_non_humanoid: {
				type: 'boolean',
				default: false,
				title: 'Allow non-humanoid',
				description: 'Rig even when the prompt does not look like a humanoid character.',
			},
		},
	},
	annotations: GEN_ANNOTATIONS,
	handler: async (args) => {
		const r = await runForgeAvatar({
			prompt: args.prompt,
			image_url: args.image_url,
			image_urls: args.image_urls,
			allow_non_humanoid: args.allow_non_humanoid,
		});
		if (r.ok === false) return fail(r);
		const structured = {
			ok: true,
			kind: 'rigged_avatar',
			mode: r.mode,
			glbUrl: r.riggedGlbUrl,
			meshGlbUrl: r.meshGlbUrl,
			viewerUrl: viewerUrl(r.riggedGlbUrl),
			poseStudioUrl: poseUrl(r.riggedGlbUrl),
			prompt: r.prompt,
			animationReady: true,
			durationMs: r.durationMs,
		};
		return ok(structured, r.riggedGlbUrl, args.prompt || 'avatar');
	},
};

// The five FREE generation tools, in the order discovery clients should see them.
export const studioTools = [forgeFree, textToAvatar, meshForge, rigMesh, forgeAvatar];

// Names of the tools that submit a real GPU job — the endpoint applies the
// generation rate limits (per-IP hourly + global breaker) only to these, not to
// discovery calls.
export const GENERATION_TOOL_NAMES = new Set(studioTools.map((t) => t.name));
