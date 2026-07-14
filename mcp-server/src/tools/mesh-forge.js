// `mesh_forge` — paid MCP tool: text → textured 3D GLB, as a model chain.
//
// Pricing: $0.25 USDC, settled `exact` on Solana.
//
// This is a thin, x402-gated client over the three.ws production pipeline — it
// does NOT hold any generation credentials itself. The npx-distributed MCP
// server can run anywhere; all GPU/LLM work happens on three.ws prod (which
// holds the Replicate / watsonx keys). The x402 USDC payment is what gates the
// call.
//
// The generation logic lives in `_studio-core.js` (runMeshForge) so the paid
// stdio transport and the hosted FREE 3D Studio endpoint (api/_studio,
// /api/mcp-studio) share ONE implementation and never drift. Two modes:
//   • text→3D — IBM Granite directs the prompt, FLUX renders a reference image,
//     then TRELLIS / Hunyuan3D reconstruct a textured GLB.
//   • image→3D — a caller-supplied image_url (or 1–4 multi-view image_urls) is
//     reconstructed directly.
//
// Environment (all optional — sensible prod defaults):
//   MESH_FORGE_API_BASE       — three.ws origin. Default https://three.ws
//   MESH_FORGE_DIRECTOR       — "0" to skip the prompt-director stage. Default on.
//   MESH_FORGE_DIRECTOR_MODEL — model id for direction, resolved by the server's
//                               anonymous chat chain. Default server default.
//   MESH_FORGE_TIMEOUT_MS     — overall reconstruct poll budget. Default 180000.
//   MESH_FORGE_POLL_MS        — poll interval. Default 3000.

import { z } from 'zod';

import { paid } from '../payments.js';
import { jsonSchemaFromZod } from './_shared.js';
import { runMeshForge } from './_studio-core.js';

const TOOL_NAME = 'mesh_forge';
const TOOL_DESCRIPTION =
	'Generate a textured 3D GLB model from a text prompt, a single reference image, OR 2–4 reference views of the same object. In text mode, a chain of specialist models runs: an IBM Granite "prompt director" rewrites the prompt into an optimized 3D spec, FLUX renders a reference image, then Microsoft TRELLIS / Tencent Hunyuan3D reconstruct the mesh. In image mode, a supplied image_url is reconstructed directly. In multi-view mode, pass image_urls (1–4 angles such as front/back/left/right) and the backend fuses them for a higher-fidelity mesh with no hallucinated back. Returns the GLB URL, a three.ws viewer link, how many views were fused, which backend handled it, the directed prompt (text mode), and timing. Feed the GLB to rig_mesh for a rigged, animation-ready model. Paid: $0.25 USDC.';

const inputZodShape = {
	prompt: z
		.string()
		.min(3)
		.max(1000)
		.describe('Text→3D: natural-language description of the single object to model, e.g. "a worn leather armchair". Optional when image_url is provided (then used only as guidance).')
		.optional(),
	image_url: z
		.string()
		.url()
		.describe('Image→3D: an http(s) URL to a reference image to reconstruct directly. When set, the prompt-director and text-to-image stages are skipped.')
		.optional(),
	image_urls: z
		.array(z.string().url())
		.min(1)
		.max(4)
		.describe('Multi-view → 3D: 1–4 http(s) URLs of the SAME object from different angles (e.g. front, back, left, right). More than one view enables multi-view reconstruction, which removes the back-of-object guesswork of single-image reconstruction. Takes precedence over image_url.')
		.optional(),
	aspect_ratio: z
		.enum(['1:1', '4:3', '3:4', '16:9', '9:16'])
		.describe('Reference image aspect ratio (text mode). Default 1:1 (best for isolated objects).')
		.optional(),
	direct: z
		.boolean()
		.describe('Run the IBM Granite prompt-director stage to optimize the prompt before generation (text mode only). Default true.')
		.optional(),
};

const inputJsonSchema = jsonSchemaFromZod(inputZodShape);

export async function buildMeshForgeTool() {
	const handler = await paid(
		{
			toolName: TOOL_NAME,
			description: TOOL_DESCRIPTION,
			scheme: 'exact',
			priceUsd: '$0.25',
			inputSchema: inputJsonSchema,
			example: { prompt: 'a worn leather armchair, brass studs', aspect_ratio: '1:1' },
			outputExample: {
				ok: true,
				glbUrl: 'https://three.ws/cdn/creations/abc123/mesh.glb',
				preview: 'https://three.ws/viewer?src=https%3A%2F%2Fthree.ws%2Fcdn%2F...',
				prompt: 'a worn leather armchair, brass studs',
				imageUrls: null,
				viewsRequested: 0,
				viewsUsed: 1,
				multiview: false,
				backend: 'replicate',
				directedPrompt: 'A single worn brown leather wingback armchair with brass stud trim...',
				directed: true,
				jobId: 'k7m2q9x4',
				creationId: 'abc123',
				referenceImageUrl: 'https://replicate.delivery/.../ref.png',
				durationMs: 96000,
			},
		},
		(args) => runMeshForge(args),
	);

	return {
		name: TOOL_NAME,
		title: 'Text → 3D mesh ($0.25)',
		description: TOOL_DESCRIPTION,
		inputSchema: inputZodShape,
		// Creates a hosted mesh artifact via external generation APIs; destroys
		// nothing, and every call mints a fresh asset.
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		handler,
	};
}
