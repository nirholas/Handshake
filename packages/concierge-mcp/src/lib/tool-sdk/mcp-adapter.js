// `toMcpTools` — the piece that makes this port ours: adapt a `defineTool` +
// `defineExecutor` pair into the exact registration shape three.ws's MCP
// servers already use, so adoption is one call.
//
// Target shape (derived from `packages/naming-mcp/src/tools/*.js` and
// `packages/naming-mcp/src/index.js`'s `server.registerTool(name, { title,
// description, inputSchema, annotations }, handler)`):
//
//   {
//     name: string,
//     title: string,
//     description: string,
//     inputSchema: Record<string, ZodTypeAny>,  // raw Zod shape, NOT JSON Schema —
//                                                // the MCP SDK converts this itself.
//     annotations: { readOnlyHint, idempotentHint, openWorldHint, ... },
//     async handler(args, extra) { ... },       // returns data on success, THROWS on failure
//   }
//
// One tool-sdk API becomes one MCP tool (three.ws's convention: each MCP
// tool exposes exactly one operation). The handler throws on failure instead
// of returning a `{ success: false }` envelope, matching every hand-written
// tool in `packages/*-mcp/src/tools/` and `mcp-server/src/tools/`, whose
// server wrappers `try { await tool.handler(...) } catch (err) { ...isError }`.

const DEFAULT_ANNOTATIONS = Object.freeze({
	readOnlyHint: false,
	idempotentHint: false,
	openWorldHint: true,
});

/**
 * @param {ReturnType<import('./define-tool.js').defineTool>} tool
 * @param {ReturnType<import('./define-executor.js').defineExecutor>} executor
 * @returns {Array<{
 *   name: string,
 *   title: string,
 *   description: string,
 *   inputSchema: Record<string, import('zod').ZodTypeAny>,
 *   annotations: object,
 *   handler: (args: any, extra?: object) => Promise<*>,
 * }>}
 *
 * @example
 * ```js
 * import { defineTool, defineExecutor, toMcpTools, z } from '@three-ws/tool-sdk';
 * import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
 *
 * const tool = defineTool({
 *   id: 'my-org-price-feed', title: 'Price Feed', description: '...', version: '1.0.0',
 *   apis: [{ name: 'getPrice', description: '...', parameters: z.object({ symbol: z.string() }) }],
 * });
 * const executor = defineExecutor(tool, {
 *   async getPrice({ symbol }) { return { symbol, price: 42 }; },
 * });
 *
 * const server = new McpServer({ name: 'my-server', version: '1.0.0' });
 * for (const def of toMcpTools(tool, executor)) {
 *   server.registerTool(def.name, { title: def.title, description: def.description, inputSchema: def.inputSchema, annotations: def.annotations }, def.handler);
 * }
 * ```
 */
export function toMcpTools(tool, executor) {
	if (!tool?._apis || !Array.isArray(tool._apis)) {
		throw new TypeError('toMcpTools: first argument must be a tool returned by defineTool()');
	}
	if (!executor || typeof executor.invoke !== 'function') {
		throw new TypeError('toMcpTools: second argument must be an executor returned by defineExecutor()');
	}

	return tool._apis.map((api) => {
		const shape = api.parametersZod?.shape;
		if (!shape) {
			throw new TypeError(
				`toMcpTools: api "${api.name}" must declare "parameters" as a z.object({...}) schema (found no .shape)`,
			);
		}

		return {
			name: api.name,
			title: api.title,
			description: api.description,
			inputSchema: shape,
			annotations: api.annotations ?? DEFAULT_ANNOTATIONS,
			async handler(args, extra) {
				const result = await executor.invoke(api.name, args, extra ?? {});
				if (!result.success) {
					const err = new Error(result.error?.message ?? `${tool.manifest.id}.${api.name} failed`);
					if (result.error?.code !== undefined) err.code = result.error.code;
					if (result.error?.status !== undefined) err.status = result.error.status;
					if (result.error?.body !== undefined) err.body = result.error.body;
					throw err;
				}
				return result.content;
			},
		};
	});
}
