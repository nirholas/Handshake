// `forge_avatar` — paid MCP tool: text/image → rigged, ANIMATION-READY avatar.
//
// Pricing: $0.45 USDC, settled `exact` on Solana. That is the sum of the two
// production ops it bundles — generation (mesh_forge, $0.25) + auto-rig
// (rig_mesh, $0.20) — with no hidden margin. One call does what previously took
// two: prompt → textured GLB → humanoid skeleton + skin weights → a model that
// drops straight into the three.ws pose studio and drives the canonical
// idle/walk clip library.
//
// Like mesh_forge / rig_mesh, this is a thin x402-gated client over the three.ws
// prod pipeline (/api/forge). It holds NO generation or rigging credentials; the
// USDC payment gates the call and all GPU work runs on prod.
//
// The full chain (humanoid gate → Granite director → generate → auto-rig) lives
// in `_studio-core.js` (runForgeAvatar) so every stdio tool that bundles the
// chain shares ONE implementation and never drifts. The hosted FREE 3D Studio
// endpoint (/api/mcp-studio) runs the same chain over /api/forge through its own
// client, api/_mcp-studio/forge-client.js.
//
// Money safety (real users, real funds): a humanoid gate runs BEFORE any work —
// a confidently non-humanoid prompt returns a toolError (which the x402 wrapper
// treats as a failure and CANCELS the payment), and every downstream failure
// also returns a toolError, so a caller is NEVER charged for a bundle that did
// not produce a rigged avatar. Pass allow_non_humanoid to override the gate.
//
// Environment (all optional — sensible prod defaults):
//   MESH_FORGE_API_BASE         — three.ws origin. Default https://three.ws
//   FORGE_AVATAR_DIRECTOR       — "0" to skip the Granite prompt-director stage.
//   FORGE_AVATAR_GEN_TIMEOUT_MS — generation poll budget. Default 180000.
//   FORGE_AVATAR_RIG_TIMEOUT_MS — rig poll budget. Default 180000.
//   FORGE_AVATAR_POLL_MS        — poll interval for both stages. Default 3000.

import { z } from 'zod';

import { paid } from '../payments.js';
import { jsonSchemaFromZod } from './_shared.js';
import { runForgeAvatar } from './_studio-core.js';

const TOOL_NAME = 'forge_avatar';
const TOOL_DESCRIPTION =
	'Generate a rigged, ANIMATION-READY 3D avatar from a single text prompt or reference image(s) — in ONE call. ' +
	'Chains the full three.ws pipeline: an IBM Granite prompt director optimizes the prompt, FLUX + TRELLIS/Hunyuan3D ' +
	'reconstruct a textured GLB, then the auto-rigger (Make-It-Animatable) adds a humanoid skeleton and skin weights so the ' +
	'model loads straight into the three.ws pose studio and plays the canonical idle/walk animation library. ' +
	'Accepts a text prompt, a single image_url, or 1–4 image_urls (front/back/left/right) for higher-fidelity multi-view ' +
	'reconstruction. A humanoid gate runs first: a clearly non-humanoid subject (furniture, vehicle, quadruped) is ' +
	'rejected WITHOUT charge (use mesh_forge or forge_free for those) unless allow_non_humanoid is set. Returns the rigged ' +
	'GLB URL, the intermediate mesh URL, a pose-studio link, the directed prompt, and per-stage timing. Paid: $0.45 USDC ' +
	'(generation + rig bundled; you are not charged if no rigged avatar is produced).';

const inputZodShape = {
	prompt: z
		.string()
		.min(3)
		.max(1000)
		.describe('Text→avatar: natural-language description of a single humanoid character, e.g. "a friendly cartoon astronaut in a glossy white suit". Optional when image_url(s) are provided (then used as guidance + for the humanoid gate).')
		.optional(),
	image_url: z
		.string()
		.url()
		.describe('Image→avatar: an http(s) URL to a reference image of a character to reconstruct and rig. The prompt-director and text-to-image stages are skipped.')
		.optional(),
	image_urls: z
		.array(z.string().url())
		.min(1)
		.max(4)
		.describe('Multi-view → avatar: 1–4 http(s) URLs of the SAME character from different angles (front/back/left/right) for higher-fidelity reconstruction with no hallucinated back. Takes precedence over image_url.')
		.optional(),
	aspect_ratio: z
		.enum(['1:1', '4:3', '3:4', '16:9', '9:16'])
		.describe('Reference image aspect ratio (text mode). Default 3:4 (portrait — best framing for a full-body figure).')
		.optional(),
	direct: z
		.boolean()
		.describe('Run the IBM Granite prompt-director stage to optimize the prompt for a riggable full-body figure (text mode only). Default true.')
		.optional(),
	allow_non_humanoid: z
		.boolean()
		.describe('Bypass the humanoid gate and rig even when the prompt does not look like a character. Off by default — leaving it off means a non-character prompt is rejected WITHOUT charge.')
		.optional(),
};

const inputJsonSchema = jsonSchemaFromZod(inputZodShape);

export async function buildForgeAvatarTool() {
	const handler = await paid(
		{
			toolName: TOOL_NAME,
			description: TOOL_DESCRIPTION,
			scheme: 'exact',
			priceUsd: '$0.45',
			inputSchema: inputJsonSchema,
			example: { prompt: 'a friendly cartoon astronaut in a glossy white suit', aspect_ratio: '3:4' },
			outputExample: {
				ok: true,
				riggedGlbUrl: 'https://three.ws/cdn/creations/def456/rigged.glb',
				meshGlbUrl: 'https://three.ws/cdn/creations/abc123/mesh.glb',
				poseStudioUrl: 'https://three.ws/pose?src=https%3A%2F%2Fthree.ws%2F...',
				prompt: 'a friendly cartoon astronaut in a glossy white suit',
				directedPrompt: 'A single full-body cartoon astronaut in a glossy white space suit...',
				directed: true,
				humanoid: { confidence: 'high', reason: 'humanoid character signals: astronaut' },
				generationMs: 96000,
				rigMs: 48000,
				durationMs: 144000,
			},
		},
		async (args) => {
			const r = await runForgeAvatar(args);
			// The shared core degrades a rig-stage failure to a mesh-only SUCCESS —
			// right for the free hosted studio lane, but on this PAID transport the
			// advertised contract is "you are not charged if no rigged avatar is
			// produced". Remap that degrade to the no-charge error envelope with the
			// mesh still attached, so the caller keeps the asset without settling.
			if (r?.ok === true && r.rigged === false) {
				return {
					ok: false,
					error: r.rigError?.code || 'rig_failed',
					message:
						`The mesh generated but rigging failed (${r.rigError?.message || 'no detail'}). ` +
						'You were NOT charged. The unrigged mesh URL is attached — rig it separately with rig_mesh once the rig lane recovers.',
					meshGlbUrl: r.meshGlbUrl,
					viewerUrl: r.viewerUrl,
					backend: r.backend ?? null,
					meshCreationId: r.meshCreationId ?? null,
					...(r.rigError?.rigJobId ? { rigJobId: r.rigError.rigJobId } : {}),
					...(r.rigError?.resumeUrl ? { resumeUrl: r.rigError.resumeUrl } : {}),
				};
			}
			return r;
		},
	);

	return {
		name: TOOL_NAME,
		title: 'Text/Image → rigged avatar ($0.45)',
		description: TOOL_DESCRIPTION,
		inputSchema: inputZodShape,
		// Mints two fresh hosted GLB artifacts (mesh + rigged) via external
		// generation/rigging APIs; destroys nothing, every call yields new assets.
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		handler,
	};
}
