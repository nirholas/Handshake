// `knock_inbox`: the knocks YOUR door has taken. Authenticated, read-only.

import { z } from 'zod';
import { apiRequest } from '../lib/api.js';

export const def = {
	name: 'knock_inbox',
	title: 'Read your knocks',
	annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
	description:
		'Read the knocks your own door has taken, newest first, each with what the sender paid for it. Use ' +
		'this to triage: the amount is the sender\'s own statement of how much reaching you was worth. Also ' +
		'returns totals (waiting, all time, earned). Requires THREE_WS_API_KEY for the account that owns the ' +
		'door; it can never read anyone else\'s. Read-only.',
	inputSchema: {
		limit: z.number().int().min(1).max(50).optional().describe('Page size. Default 30.'),
		status: z.enum(['pending', 'read', 'replied', 'dismissed']).optional().describe('Filter to one status.'),
		before: z.string().optional().describe('ISO timestamp cursor for paging.'),
	},
	async handler({ limit, status, before }) {
		const data = await apiRequest('/api/knock/inbox', { auth: true, query: { limit, status, before } });
		return { ok: true, totals: data.totals, has_more: data.has_more, knocks: data.knocks };
	},
};
