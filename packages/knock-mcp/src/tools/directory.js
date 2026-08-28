// `knock_directory` — everyone reachable right now. Read-only, no credential.

import { z } from 'zod';
import { apiRequest } from '../lib/api.js';

export const def = {
	name: 'knock_directory',
	title: 'Browse open doors',
	annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
	description:
		'List every open, listed door on three.ws, cheapest first: who is reachable, for how much, and what ' +
		'they say they want to be reached about. This is how an agent discovers which humans it can pay to ' +
		'talk to. Costs nothing and needs no credential. Read-only.',
	inputSchema: { limit: z.number().int().min(1).max(100).optional().describe('How many doors to return. Default 60.') },
	async handler({ limit }) {
		const data = await apiRequest('/api/knock/directory', { query: { limit } });
		return { ok: true, count: data.count, doors: data.doors };
	},
};
