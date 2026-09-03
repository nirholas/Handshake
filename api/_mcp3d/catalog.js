import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { buildGettingStartedTool } from '../_lib/mcp-getting-started.js';
import { priceUsdcForTier } from '../_lib/forge-tiers.js';
import { toolDefs as studioDefs } from './tools/studio.js';
import { toolDefs as spatialDefs } from './tools/spatial.js';
import { toolDefs as arDefs } from './tools/ar.js';
import { toolDefs as provenanceDefs } from './tools/provenance.js';
import { toolDefs as simReadinessDefs } from './tools/sim-readiness.js';
import { toolDefs as personaIdentityDefs } from './tools/persona-identity.js';
import { toolDefs as preflightDefs } from './tools/preflight.js';
import { toolDefs as modelDefs } from '../_mcp/tools/models.js';
import { toolDefs as animationDefs } from '../_mcp/tools/animations.js';

// Reuse the battle-tested inspect/optimize tools from the main MCP server so a
// generated model can be analyzed in the same conversation — no duplicated
// glTF logic. validate_model is omitted: in the studio context inspect already
// covers "what is this mesh", and optimize covers "how do I ship it".
const reusedModelDefs = modelDefs.filter(
	(d) => d.name === 'inspect_model' || d.name === 'optimize_model',
);

// The animation library (list_animations + apply_animation) completes the
// pipeline: text_to_3d → auto_rig_model → apply_animation. Same retarget engine
// the main server exposes — reused here, not duplicated.
const baseDefs = [...studioDefs, ...spatialDefs, ...arDefs, ...provenanceDefs, ...simReadinessDefs, ...personaIdentityDefs, ...preflightDefs, ...reusedModelDefs, ...animationDefs];

// Free, public entry point — listed first so discovery clients see it up top.
// Annotations: a static, local overview built at module load — read-only,
// deterministic, closed-world (destructiveHint is explicit because the MCP
// spec defaults it to true when omitted).
const gettingStarted = {
	...buildGettingStartedTool({
		server: 'three.ws 3D Studio',
		tagline: 'Turn text or images into interactive, animation-ready 3D models.',
		tools: baseDefs,
		access: [
			'Discovery is free: initialize, tools/list, ping, and this tool need no credentials.',
			`Connect with a three.ws account (OAuth) to run every tool operator-funded, or pay per call with an x402 wallet (USDC on Base or Solana) — generation is priced by tier ($${priceUsdcForTier('draft')} draft / $${priceUsdcForTier('standard')} standard / $${priceUsdcForTier('high')} high), mesh edits $0.01–0.05, and status/preview/inspection tools are free.`,
			'Generation tools (text_to_3d, image_to_3d) run async jobs; poll generation_status for the GLB and an inline <model-viewer> artifact.',
		],
		links: { homepage: 'https://three.ws', source: 'https://github.com/nirholas/three.ws' },
	}),
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
};

const allDefs = [gettingStarted, ...baseDefs];

// Schema objects for tools/list — strip internal fields (scope, handler).
export const TOOL_CATALOG = allDefs.map(({ scope: _s, handler: _h, ...schema }) => schema);

// Compile each tool's inputSchema once so dispatch can validate args before the
// handler runs — same defense-in-depth + forgiving coercion the main server uses.
const ajv = new Ajv({ allErrors: true, useDefaults: true, coerceTypes: true, strict: false });
addFormats(ajv);

export const TOOLS = Object.fromEntries(
	allDefs.map(({ name, scope, handler, inputSchema }) => [
		name,
		{ scope, handler, validate: inputSchema ? ajv.compile(inputSchema) : null },
	]),
);
