import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { buildGettingStartedTool } from '../_lib/mcp-getting-started.js';
import { toolDefs } from './tools.js';

// Free, public entry point, listed first so discovery clients see it up top.
// Annotations: a static, local overview built at module load. Read-only,
// deterministic, closed-world (destructiveHint is explicit because the MCP
// spec defaults it to true when omitted).
const gettingStarted = {
	...buildGettingStartedTool({
		server: 'three.ws x402 Bazaar',
		tagline: 'Discover, price, and locate paid agent services across the live x402 facilitator network.',
		tools: toolDefs,
		access: [
			'Connect with a three.ws account (OAuth) or an x402 wallet. Discovery tools query the live x402 facilitator network.',
			'Use get_service(resource_url) to see a service’s exact price, payment networks, and a ready pay link before calling it.',
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

const allDefs = [gettingStarted, ...toolDefs];

// Schema objects for tools/list: strip internal fields (scope, handler).
export const TOOL_CATALOG = allDefs.map(({ scope: _s, handler: _h, ...schema }) => schema);

const ajv = new Ajv({ allErrors: true, useDefaults: true, coerceTypes: true, strict: false });
addFormats(ajv);

export const TOOLS = Object.fromEntries(
	allDefs.map(({ name, scope, handler, inputSchema }) => [
		name,
		{ scope, handler, validate: inputSchema ? ajv.compile(inputSchema) : null },
	]),
);
