import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { buildGettingStartedTool } from '../_lib/mcp-getting-started.js';
import { priceFor } from '../_lib/pump-pricing.js';
import { toolDefs as avatarDefs } from './tools/avatars.js';
import { toolDefs as modelDefs } from './tools/models.js';
import { toolDefs as printDefs } from './tools/print.js';
import { toolDefs as solanaDefs } from './tools/solana.js';
import { toolDefs as pumpfunDefs } from './tools/pumpfun.js';
import { toolDefs as agentDefs } from './tools/agents.js';
import { toolDefs as animationDefs } from './tools/animations.js';
import { toolDefs as memoryDefs } from './tools/memory.js';
import { toolDefs as embedDefs } from './tools/embed.js';
import { toolDefs as oracleDefs } from './tools/oracle.js';
import { toolDefs as traderDefs } from './tools/trader.js';
import { toolDefs as tokenizeDefs } from './tools/tokenize.js';
import { toolDefs as cryptoDataDefs } from './tools/crypto-data.js';
import { toolDefs as garmentDefs } from './tools/garments.js';
import { toolDefs as signDefs } from './tools/sign.js';
import { toolDefs as feedbackDefs } from './tools/feedback.js';
import { toolDefs as homeDefs } from './tools/home.js';
import { toolDefs as libraryDefs } from './tools/library.js';

const baseDefs = [
	...libraryDefs,
	...avatarDefs,
	...embedDefs,
	...modelDefs,
	...printDefs,
	...animationDefs,
	...signDefs,
	...solanaDefs,
	...pumpfunDefs,
	...agentDefs,
	...memoryDefs,
	...oracleDefs,
	...traderDefs,
	...tokenizeDefs,
	...cryptoDataDefs,
	...garmentDefs,
	...feedbackDefs,
	...homeDefs,
];

// Free, public entry point — listed first so discovery clients see it up top.
// priceFor annotates the per-call price of the paid tools in the overview.
// Annotations: a static, local overview built at module load — read-only,
// deterministic, closed-world (destructiveHint is explicit because the MCP
// spec defaults it to true when omitted).
const gettingStarted = {
	...buildGettingStartedTool({
		server: 'three.ws',
		tagline:
			'The main three.ws MCP server: render and manage 3D avatars and models, animations, American Sign Language, a free searchable catalog of ready-made CC0 props, rigged characters and motion clips with paste-ready embed source, an agent registry, agent memory, live pump.fun market data, Oracle conviction signals, the trader leaderboard + copy-trading system, and safe control of a connected Home Assistant house.',
		tools: baseDefs,
		priceFor,
		access: [
			'Connect with a three.ws account (OAuth) for your account-scoped avatars, agents, and memory.',
			'Or pay per call via x402 (USDC) for the public tools — each priced tool shows its price in tools/list.',
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

// Compile each tool's inputSchema once per process so dispatch can validate
// args before invoking the handler. The handlers currently trust their args
// and pass them to DB / external APIs; dispatch-level validation is
// defense-in-depth that fails fast on malformed input with a clear MCP
// JSON-RPC error instead of bubbling up a Postgres parse error or worse.
//
// `useDefaults: true` lets the per-tool `default` in JSON Schema (e.g.
// limit defaults) fill in for clients that omit optional fields, matching
// the existing handler behavior (`args.limit || 25`).
//
// `coerceTypes: true` accepts string forms of integers ("25") which some
// older MCP clients emit — same forgiveness the handlers currently rely on.
const ajv = new Ajv({
	allErrors: true,
	useDefaults: true,
	coerceTypes: true,
	strict: false,
});
addFormats(ajv);

// Handler lookup for tools/call — keyed by tool name.
export const TOOLS = Object.fromEntries(
	allDefs.map(({ name, scope, handler, inputSchema }) => [
		name,
		{
			scope,
			handler,
			validate: inputSchema ? ajv.compile(inputSchema) : null,
		},
	]),
);
