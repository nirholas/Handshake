// `knock_act` — answer, dismiss, or block one knock. Authenticated write.

import { z } from 'zod';
import { apiRequest } from '../lib/api.js';

export const def = {
	name: 'knock_act',
	title: 'Act on a knock',
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
	description:
		'Act on one knock in your own inbox: mark it read, dismiss it, or reply to it. A reply is delivered ' +
		'back through the receipt link the sender already holds, so answering never hands out your email or ' +
		'any other address. Set block to stop hearing from that sender: they are matched on the wallet that ' +
		'paid when there was one, and they see the same answer a shut door gives, so they cannot tell it was ' +
		'them. Acting on a knock also settles its companion delivery, so your avatar will not walk on later ' +
		'to announce something you have already dealt with. Requires THREE_WS_API_KEY.',
	inputSchema: {
		knock_id: z.string().min(1).describe('The knock id from knock_inbox.'),
		status: z.enum(['read', 'replied', 'dismissed']).optional().describe('The new status. Use replied together with reply.'),
		reply: z.string().max(2000).optional().describe('What to write back. The sender reads it through their receipt link.'),
		block: z.boolean().optional().describe('Never hear from this sender again.'),
	},
	async handler({ knock_id: knockId, status, reply, block }) {
		const body = {};
		if (status) body.status = status;
		if (reply) {
			body.reply = reply;
			body.status = status || 'replied';
		}
		if (block) body.block = true;
		const data = await apiRequest(`/api/knock/inbox/${encodeURIComponent(knockId)}`, { method: 'PATCH', auth: true, body });
		return { ok: true, knock: data.knock };
	},
};
