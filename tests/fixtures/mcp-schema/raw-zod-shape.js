// `inputSchema` as a raw zod shape, which the MCP SDK converts itself.
//
// The first field is deliberately named `type`: a reader that decided "JSON
// Schema or zod shape?" by looking for a `type` key classified shapes like this
// one as JSON Schema and emitted the tool with no arguments at all.

import { z } from 'zod';

import { BASE58_RE, FORMATS } from './constants.js';

const subscription = z
	.object({
		endpoint: z.string().url().describe('Push endpoint.'),
		keys: z.object({ auth: z.string() }),
	})
	.describe('A Web Push subscription.');

export const def = {
	name: 'find_things',
	title: 'Find things',
	description: 'Finds things.',
	annotations: { readOnlyHint: true },
	inputSchema: {
		type: z.enum(['http', 'mcp']).default('http').describe('Service kind to search.'),
		query: z.string().min(1).max(200).describe('What you need.'),
		mint: z.string().regex(BASE58_RE, 'must be base58').optional().describe('Coin mint.'),
		limit: z.number().int().min(1).max(100).optional().describe('Max results.'),
		threshold: z.number().positive().optional(),
		format: z.enum(Object.keys(FORMATS)).optional().describe('Audio format.'),
		subscription,
	},
	async handler() {
		return { ok: true };
	},
};
