// `knock_receipt` — what became of a knock you sent. Read-only, no credential.

import { z } from 'zod';
import { apiRequest } from '../lib/api.js';

export const def = {
	name: 'knock_receipt',
	title: 'Read a knock receipt',
	annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
	description:
		'Read the state of a knock you sent, using the receipt_url it returned. Statuses: pending (not opened), ' +
		'read (opened, no answer written), replied (they wrote back, and the reply is included), dismissed ' +
		'(read and closed). The receipt carries its own proof, so this needs no account and reveals nothing ' +
		'about the recipient beyond the reply they chose to write. Read-only.',
	inputSchema: { receipt_url: z.string().min(10).describe('The receipt_url a knock returned.') },
	async handler({ receipt_url: receiptUrl }) {
		const data = await apiRequest(String(receiptUrl));
		return { ok: true, knock: data.knock };
	},
};
