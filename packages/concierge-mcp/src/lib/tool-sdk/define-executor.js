// `defineExecutor` — wire a typed implementation map onto a tool defined
// with `defineTool`. Every call goes through one `invoke(apiName, params, ctx)`
// entry point that:
//
//   1. Rejects unknown API names / unimplemented methods with a structured error.
//   2. Enforces the tool's declared rate limit (if any), per API name.
//   3. Validates `params` against the API's Zod schema before calling the method.
//   4. Wraps thrown errors into `{ success: false, error: { message, code } }`
//      instead of letting them propagate.
//   5. Normalizes a successful return into `{ success: true, content, state }`
//      — unless the implementation already returned that shape itself (an
//      implementation is free to return a full result envelope when it needs
//      to set `content` and `state` to different values).
//
// Ported from the owner's SperaxOS `@sperax/plugin-sdk` (`defineExecutor.ts`);
// adapted from TypeScript to plain ESM + JSDoc, and extended with the
// rate-limit + Zod-validation enforcement this repo's permission manifest adds.

import { createRateLimiter } from './permissions.js';

/**
 * @typedef {object} ToolResult
 * @property {boolean} success
 * @property {*} [content] Present on success (and on `ExecutorError` failures,
 *   as a human-readable summary — mirrors the reference SDK's shape).
 * @property {*} [state] Present on success — structured data for callers that
 *   want more than the rendered `content`.
 * @property {{ message: string, code?: string, issues?: unknown, body?: unknown }} [error]
 *   Present on failure.
 */

/**
 * @param {ReturnType<import('./define-tool.js').defineTool>} tool
 * @param {Record<string, (params: any, ctx?: object) => Promise<*> | *>} implementation
 *   Map of API name → handler. A handler may return plain data (wrapped into
 *   `{ success: true, content, state }` automatically) or a full `ToolResult`
 *   envelope (passed through unchanged).
 * @returns {{
 *   id: string,
 *   getApiNames(): string[],
 *   hasApi(name: string): boolean,
 *   invoke(apiName: string, params: any, ctx?: object): Promise<ToolResult>,
 * }}
 *
 * @example
 * ```js
 * import { defineExecutor } from '@three-ws/tool-sdk';
 * import { priceTool } from './index.js';
 *
 * export const executor = defineExecutor(priceTool, {
 *   async getPrice({ symbol }) {
 *     const res = await fetch(`https://api.example.com/v1/price/${symbol}`);
 *     const data = await res.json();
 *     return { symbol, price: data.price }; // wrapped into { success: true, content, state }
 *   },
 * });
 *
 * const result = await executor.invoke('getPrice', { symbol: 'ETH' });
 * ```
 */
export function defineExecutor(tool, implementation) {
	if (!tool?.manifest || !Array.isArray(tool._apis)) {
		throw new TypeError('defineExecutor: first argument must be a tool returned by defineTool()');
	}
	if (!implementation || typeof implementation !== 'object') {
		throw new TypeError('defineExecutor: an implementation map is required');
	}

	const identifier = tool.manifest.id;
	const apiByName = new Map(tool._apis.map((api) => [api.name, api]));
	const limiter = createRateLimiter(tool.manifest.permissions?.rateLimit);

	return {
		id: identifier,

		getApiNames() {
			return [...apiByName.keys()];
		},

		hasApi(apiName) {
			return apiByName.has(apiName);
		},

		async invoke(apiName, params, ctx = {}) {
			const api = apiByName.get(apiName);
			if (!api) {
				return {
					success: false,
					error: {
						message: `[${identifier}] Unknown API: "${apiName}". Supported: ${[...apiByName.keys()].join(', ')}`,
						code: 'API_NOT_FOUND',
					},
				};
			}

			const method = implementation[apiName];
			if (typeof method !== 'function') {
				return {
					success: false,
					error: { message: `[${identifier}] Method not implemented: "${apiName}"`, code: 'METHOD_NOT_IMPLEMENTED' },
				};
			}

			if (limiter && !limiter.tryTake(apiName)) {
				return {
					success: false,
					error: { message: `[${identifier}.${apiName}] rate limit exceeded`, code: 'RATE_LIMITED' },
				};
			}

			const parsed = api.parametersZod.safeParse(params ?? {});
			if (!parsed.success) {
				const message = parsed.error.issues
					.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
					.join('; ');
				return {
					success: false,
					error: {
						message: `[${identifier}.${apiName}] invalid params: ${message}`,
						code: 'INVALID_PARAMS',
						issues: parsed.error.issues,
					},
				};
			}

			try {
				const result = await method(parsed.data, ctx);
				if (result && typeof result === 'object' && 'success' in result) {
					// The implementation already returned a full ToolResult envelope.
					return result;
				}
				return { success: true, content: result, state: result };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
				return {
					success: false,
					content: `${identifier}.${apiName} failed: ${message}`,
					error: { message, code, body: error instanceof Error ? undefined : error },
				};
			}
		},
	};
}
