import Ajv from 'ajv';

import { toolDefs as studioDefs } from './tools/studio.js';
import { toolDefs as modelDefs } from '../_mcp/tools/models.js';

// Reuse the battle-tested inspect/optimize tools from the main MCP server so a
// generated model can be analyzed in the same conversation — no duplicated
// glTF logic. validate_model is omitted: in the studio context inspect already
// covers "what is this mesh", and optimize covers "how do I ship it".
const reusedModelDefs = modelDefs.filter((d) => d.name === 'inspect_model' || d.name === 'optimize_model');

const allDefs = [...studioDefs, ...reusedModelDefs];

// Schema objects for tools/list — strip internal fields (scope, handler).
export const TOOL_CATALOG = allDefs.map(({ scope: _s, handler: _h, ...schema }) => schema);

// Compile each tool's inputSchema once so dispatch can validate args before the
// handler runs — same defense-in-depth + forgiving coercion the main server uses.
const ajv = new Ajv({ allErrors: true, useDefaults: true, coerceTypes: true, strict: false });

export const TOOLS = Object.fromEntries(
	allDefs.map(({ name, scope, handler, inputSchema }) => [
		name,
		{ scope, handler, validate: inputSchema ? ajv.compile(inputSchema) : null },
	]),
);
