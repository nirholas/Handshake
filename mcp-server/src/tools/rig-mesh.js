// `rig_mesh` — paid MCP tool: static GLB → rigged, animation-ready GLB.
//
// Pricing: $0.20 USDC, settled `exact` on Solana.
//
// Takes a GLB mesh URL and returns a rigged GLB — a humanoid skeleton plus
// per-vertex skin weights — produced by the three.ws auto-rig pipeline
// (/api/forge?action=rig, Make-It-Animatable by default). Like mesh_forge, this is
// a thin x402-gated client over the prod pipeline: it holds no generation
// credentials; the USDC payment gates the call and all GPU work runs on
// three.ws prod.
//
// The rig logic lives in `_studio-core.js` (runRigMesh) so every stdio tool that
// rigs shares ONE implementation and never drifts. The hosted FREE 3D Studio
// endpoint (/api/mcp-studio) rigs over the same /api/forge pipeline through its
// own client, api/_mcp-studio/forge-client.js.
//
// Environment (all optional — sensible prod defaults):
//   MESH_FORGE_API_BASE  — three.ws origin. Default https://three.ws
//   RIG_MESH_TIMEOUT_MS  — overall rig poll budget. Default 180000.
//   RIG_MESH_POLL_MS     — poll interval. Default 3000.

import { z } from 'zod';

import { paid } from '../payments.js';
import { jsonSchemaFromZod } from './_shared.js';
import { runRigMesh } from './_studio-core.js';

const TOOL_NAME = 'rig_mesh';
const TOOL_DESCRIPTION =
	'Auto-rig a static 3D GLB mesh into an animation-ready model: adds a humanoid skeleton and per-vertex skin weights via the three.ws rig pipeline (Make-It-Animatable by default). Takes a GLB URL, returns the rigged GLB URL and a three.ws pose-studio link. Pairs with mesh_forge: forge a mesh, then rig it. Paid: $0.20 USDC.';

const inputZodShape = {
	glb_url: z
		.string()
		.url()
		.describe('http(s) URL to the static GLB mesh to rig (e.g. the glbUrl returned by mesh_forge).'),
};

const inputJsonSchema = jsonSchemaFromZod(inputZodShape);

export async function buildRigMeshTool() {
	const handler = await paid(
		{
			toolName: TOOL_NAME,
			description: TOOL_DESCRIPTION,
			scheme: 'exact',
			priceUsd: '$0.20',
			inputSchema: inputJsonSchema,
			example: { glb_url: 'https://three.ws/avatars/cesium-man.glb' },
			outputExample: {
				ok: true,
				riggedGlbUrl: 'https://three.ws/cdn/creations/def456/rigged.glb',
				sourceGlbUrl: 'https://three.ws/avatars/cesium-man.glb',
				poseStudioUrl: 'https://three.ws/pose?src=https%3A%2F%2Fthree.ws%2F...',
				jobId: 'r9k2m7x4',
				creationId: 'def456',
				durationMs: 48000,
			},
		},
		(args) => runRigMesh(args),
	);

	return {
		name: TOOL_NAME,
		title: 'Rig 3D mesh ($0.20)',
		description: TOOL_DESCRIPTION,
		inputSchema: inputZodShape,
		// Creates a new hosted rigged-GLB artifact via external rigging APIs;
		// the input mesh is never modified or deleted.
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		handler,
	};
}
