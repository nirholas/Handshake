/**
 * Vendored @three-ws/tool-sdk (packages/tool-sdk), copied verbatim so the
 * published package installs with no file: dependency. The workspace tool-sdk
 * is private and unpublished; without this copy, `npm install
 * @three-ws/concierge-mcp` cannot resolve it outside the monorepo. Same
 * convention as the HTTP core shared across the @three-ws/* SDK family: shared
 * code is copied into each package so every package stays self-contained.
 * When the upstream SDK changes, re-copy these four modules.
 */

export { defineTool } from './define-tool.js';
export { defineExecutor } from './define-executor.js';
export { toMcpTools } from './mcp-adapter.js';
export { guardedFetch, createRateLimiter, normalizePermissions } from './permissions.js';
