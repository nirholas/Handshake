/**
 * @three-ws/tool-sdk
 *
 * Typed tool authoring for three.ws MCP servers: define a tool's identity,
 * API surface, and permission manifest once with `defineTool`, wire an
 * implementation with `defineExecutor`, and adapt it into a live MCP server
 * with `toMcpTools`.
 *
 * Quick start:
 * ```js
 * import { defineTool, defineExecutor, toMcpTools, z } from '@three-ws/tool-sdk';
 *
 * export const quoteTool = defineTool({
 *   id: 'three-ws-vanity-quote',
 *   title: 'Vanity Quote',
 *   description: 'Prices how hard a Solana vanity address pattern is to grind.',
 *   version: '1.0.0',
 *   permissions: { network: ['three.ws'], rateLimit: { calls: 30, perSeconds: 60 } },
 *   apis: [{
 *     name: 'getQuote',
 *     description: 'Quote the difficulty and suggested USDC bounty for a Base58 prefix.',
 *     parameters: z.object({ prefix: z.string() }),
 *   }],
 * });
 *
 * export const quoteExecutor = defineExecutor(quoteTool, {
 *   async getQuote({ prefix }) {
 *     const res = await fetch(`https://three.ws/api/vanity/bounties?view=quote&prefix=${prefix}`);
 *     const data = await res.json();
 *     return { prefix, tier: data.difficulty.tierLabel };
 *   },
 * });
 *
 * export const mcpTools = toMcpTools(quoteTool, quoteExecutor);
 * ```
 *
 * See `README.md` in this package for the full API reference, permission
 * model, and a complete runnable example.
 */

export { defineTool } from './define-tool.js';
export { defineExecutor } from './define-executor.js';
export { toMcpTools } from './mcp-adapter.js';
export { guardedFetch, createRateLimiter, normalizePermissions } from './permissions.js';
export { z } from 'zod';
