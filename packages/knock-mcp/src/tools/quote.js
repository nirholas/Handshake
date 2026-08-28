// `knock_quote` — what it costs to reach one person. Read-only, no credential.

import { z } from 'zod';
import { apiRequest } from '../lib/api.js';

export const def = {
	name: 'knock_quote',
	title: 'Quote a door',
	annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
	description:
		'Read one person\'s public door on three.ws: the price of a single message to them, which chains ' +
		'they take it on, how long the message may be, what they say they want to hear about, and the exact ' +
		'endpoint to use. Costs nothing and needs no credential. ALWAYS call this before knock_send on a ' +
		'priced door: the owner can change their price at any time, and the quote you show a human before ' +
		'they approve a payment must be the live one. Read-only.',
	inputSchema: { handle: z.string().min(1).max(40).describe('The recipient\'s three.ws username, with or without the @.') },
	async handler({ handle }) {
		const data = await apiRequest('/api/knock/door', { query: { handle: String(handle).replace(/^@+/, '') } });
		return { ok: true, door: data.door };
	},
};
