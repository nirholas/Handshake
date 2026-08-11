// `defineTool` — declare a tool's identity, API surface, and permission
// manifest once, and derive everything else (JSON-Schema params for the
// manifest, a raw Zod shape for MCP registration, per-API metadata for the
// executor) from that single declaration.
//
// Ported from the owner's SperaxOS `@sperax/plugin-sdk` (`defineTool.ts`),
// adapted from TypeScript to plain ESM + JSDoc to match this repo's other JS
// packages, and re-scoped from a chat-UI plugin manifest (`BuiltinToolManifest`,
// LLM system-role text, marketplace category) to a portable MCP tool manifest
// with an explicit permission model. See `packages/tool-sdk/README.md` for the
// full API + a runnable example.

import { zodToJsonSchema } from 'zod-to-json-schema';

import { normalizePermissions } from './permissions.js';

/**
 * @typedef {object} PluginApiConfig
 * @property {string} name API name — the method key on the executor's
 *   implementation map, and (via `toMcpTools`) the registered MCP tool name.
 * @property {string} description Short, LLM-facing description of what this
 *   API does.
 * @property {import('zod').ZodObject<any>} parameters A `z.object({...})`
 *   schema for the API's parameters. Converted to JSON Schema for the
 *   manifest, and kept as a raw Zod shape for MCP registration.
 * @property {string} [title] Human-facing title for this specific API.
 *   Defaults to the tool's `title`.
 * @property {object} [annotations] MCP `ToolAnnotations` for this API
 *   (`readOnlyHint`, `idempotentHint`, `openWorldHint`, `destructiveHint`).
 */

/**
 * @typedef {object} PluginToolConfig
 * @property {string} id Unique identifier, e.g. "sns-resolve". Kebab-case.
 * @property {string} title Display name shown to the calling agent/UI.
 * @property {string} description Short description of the tool as a whole.
 * @property {string} version Semantic version, e.g. "1.0.0".
 * @property {import('./permissions.js').PluginPermissions} [permissions]
 *   Permission manifest — network allowlist, rate limit, wallet access.
 * @property {PluginApiConfig[]} apis API surface of the tool. Must be non-empty.
 */

/**
 * Define a three.ws tool: convert each API's Zod parameter schema to JSON
 * Schema (for manifests / documentation) while keeping the original Zod
 * schema attached (for runtime validation in `defineExecutor` and MCP
 * registration in `toMcpTools`).
 *
 * @param {PluginToolConfig} config
 * @returns {{
 *   manifest: { id: string, title: string, description: string, version: string, permissions: object, apis: Array<{ name: string, title: string, description: string, parameters: object }> },
 *   _apis: Array<{ name: string, title: string, description: string, annotations: object | undefined, parametersJsonSchema: object, parametersZod: import('zod').ZodObject<any> }>,
 *   _config: PluginToolConfig,
 * }}
 *
 * @example
 * ```js
 * import { defineTool, z } from '@three-ws/tool-sdk';
 *
 * export const priceTool = defineTool({
 *   id: 'my-org-price-feed',
 *   title: 'My Price Feed',
 *   description: 'Fetches token prices from My API.',
 *   version: '1.0.0',
 *   permissions: { network: ['api.example.com'] },
 *   apis: [{
 *     name: 'getPrice',
 *     description: 'Get the current USD price for a token symbol.',
 *     parameters: z.object({ symbol: z.string().describe('Token ticker, e.g. "ETH"') }),
 *   }],
 * });
 * ```
 */
export function defineTool(config) {
	if (!config || typeof config !== 'object') {
		throw new TypeError('defineTool: a config object is required');
	}
	const { id, title, description, version, permissions, apis } = config;

	if (!id || typeof id !== 'string') throw new TypeError('defineTool: "id" (string) is required');
	if (!title || typeof title !== 'string') throw new TypeError('defineTool: "title" (string) is required');
	if (!description || typeof description !== 'string') {
		throw new TypeError('defineTool: "description" (string) is required');
	}
	if (!version || typeof version !== 'string') throw new TypeError('defineTool: "version" (string) is required');
	if (!Array.isArray(apis) || apis.length === 0) {
		throw new TypeError('defineTool: "apis" must be a non-empty array');
	}

	const seenNames = new Set();
	const resolvedApis = apis.map((apiConfig) => {
		if (!apiConfig || typeof apiConfig !== 'object' || !apiConfig.name) {
			throw new TypeError('defineTool: every entry in "apis" needs a "name"');
		}
		if (seenNames.has(apiConfig.name)) {
			throw new TypeError(`defineTool: duplicate api name "${apiConfig.name}"`);
		}
		seenNames.add(apiConfig.name);

		if (!apiConfig.description || typeof apiConfig.description !== 'string') {
			throw new TypeError(`defineTool: api "${apiConfig.name}" needs a "description"`);
		}
		if (!apiConfig.parameters || typeof apiConfig.parameters.safeParse !== 'function') {
			throw new TypeError(`defineTool: api "${apiConfig.name}" needs a Zod schema in "parameters"`);
		}

		const jsonSchema = /** @type {Record<string, any>} */ (
			zodToJsonSchema(apiConfig.parameters, { $refStrategy: 'none', target: 'jsonSchema7' })
		);
		// zod-to-json-schema adds a top-level `$schema` meta key — strip it so
		// the manifest carries a lean, self-contained object schema.
		delete jsonSchema.$schema;

		return {
			name: apiConfig.name,
			title: apiConfig.title ?? title,
			description: apiConfig.description,
			annotations: apiConfig.annotations,
			parametersJsonSchema: jsonSchema,
			parametersZod: apiConfig.parameters,
		};
	});

	const manifest = {
		id,
		title,
		description,
		version,
		permissions: normalizePermissions(permissions),
		apis: resolvedApis.map((api) => ({
			name: api.name,
			title: api.title,
			description: api.description,
			parameters: api.parametersJsonSchema,
		})),
	};

	return { manifest, _apis: resolvedApis, _config: config };
}
