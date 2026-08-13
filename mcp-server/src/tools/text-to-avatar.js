// `text_to_avatar` — paid MCP tool that generates a textured 3D GLB avatar
// from either a text prompt or one/more reference image URLs, by driving
// Replicate's text-to-3D / image-to-3D pipeline (Tencent Hunyuan-3D 3.1 by
// default, configurable via REPLICATE_TEXT_TO_AVATAR_MODEL).
//
// Pricing: $0.15 USDC, settled `exact` in USDC on Solana mainnet.
//
// The generation logic lives in `_studio-core.js` (runTextToAvatar), the shared
// core the stdio server's generators are built on, so none of them drift. The
// hosted FREE 3D Studio endpoint (/api/mcp-studio) has its own avatar lane in
// api/_mcp-studio/forge-client.js. It synchronously
// submits a Replicate prediction and polls until terminal/timeout; the returned
// GLB URL is the Replicate-hosted output (optionally rehosted on three.ws R2
// when MCP_TEXT_TO_AVATAR_REHOST is enabled).
//
// Environment:
//   REPLICATE_API_TOKEN                — required.
//   REPLICATE_TEXT_TO_AVATAR_MODEL     — required version hash. Pin a
//                                        commercial-OK image/text-to-3D model
//                                        (e.g. tencent/hunyuan-3d-3.1 latest).
//   MCP_TEXT_TO_AVATAR_TIMEOUT_MS      — optional, defaults to 110_000.
//   MCP_TEXT_TO_AVATAR_POLL_MS         — optional, defaults to 2_000.
//   MCP_TEXT_TO_AVATAR_REHOST          — "1" to rehost via MCP_REHOST_ENDPOINT.
//   MCP_REHOST_ENDPOINT                — three.ws URL that ingests external
//                                        GLB URLs.
//   MCP_REHOST_KEY                     — bearer for MCP_REHOST_ENDPOINT.

import { z } from 'zod';

import { paid } from '../payments.js';
import { jsonSchemaFromZod } from './_shared.js';
import { runTextToAvatar } from './_studio-core.js';

const TOOL_NAME = 'text_to_avatar';
const TOOL_DESCRIPTION =
	'Generate a textured 3D GLB avatar from a text prompt or one or more reference image URLs. Drives Replicate (Hunyuan-3D 3.1 by default, configurable) and polls the prediction synchronously until a GLB is produced or the timeout fires. When the Replicate lane is unconfigured or fails, the request automatically falls over to the platform forge chain (free lanes + auto-rig) and reports the switch via lane/fallback_from — the result may then arrive rigged. Returns the GLB URL, the source prompt/images, the picked model version, the prediction id, and timing metadata. Paid: $0.15 USDC.';

// Single source of truth: Zod shape carries descriptions + bounds; JSON Schema
// derived. (No required fields — the handler enforces "prompt OR images".)
const inputZodShape = {
	prompt: z.string().max(1000).describe('Natural-language description of the avatar to generate.').optional(),
	images: z
		.array(z.string().url())
		.max(4)
		.describe('Optional reference image URLs. When provided, the model performs image-to-3D reconstruction.')
		.optional(),
	seed: z.number().int().min(0).max(2147483647).optional(),
	texture: z.boolean().describe('Request PBR textures when supported (default true).').optional(),
};

const inputJsonSchema = jsonSchemaFromZod(inputZodShape);

export async function buildTextToAvatarTool() {
	const handler = await paid(
		{
			toolName: TOOL_NAME,
			description: TOOL_DESCRIPTION,
			scheme: 'exact',
			priceUsd: '$0.15',
			inputSchema: inputJsonSchema,
			example: { prompt: 'a cheerful cyberpunk fox in a red hoodie' },
			outputExample: {
				ok: true,
				predictionId: 'qb...8',
				glbUrl: 'https://replicate.delivery/.../mesh.glb',
				prompt: 'a cheerful cyberpunk fox in a red hoodie',
				model: 'tencent/hunyuan-3d-3.1@<version-hash>',
				durationMs: 41000,
				preview: 'https://three.ws/viewer?src=https%3A%2F%2Freplicate.delivery%2F...',
			},
		},
		(args) => runTextToAvatar(args),
	);
	return {
		name: TOOL_NAME,
		title: 'Text → 3D avatar ($0.15)',
		description: TOOL_DESCRIPTION,
		inputSchema: inputZodShape,
		// Creates a hosted GLB artifact via external generation APIs; destroys
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
