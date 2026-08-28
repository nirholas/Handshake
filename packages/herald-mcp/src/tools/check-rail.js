// `check_rail`: prove the credential and the rail work, without interrupting.

import { z } from 'zod';

import { apiRequest } from '../lib/api.js';
import { THREE_WS_BASE } from '../config.js';

export const def = {
	name: 'check_rail',
	title: 'Check the delivery rail',
	annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
	description:
		'Verify that the configured key works and the delivery rail accepts announcements, without ' +
		'interrupting anybody: it queues a line at importance 0, which every client drops under its own ' +
		'floor. Use this once when wiring an agent up, or when announce fails and you need to tell a bad ' +
		'key apart from an unreachable rail. Returns the base URL and whether the credential was accepted.',
	inputSchema: {
		note: z
			.string()
			.trim()
			.max(60)
			.optional()
			.describe('Optional label recorded on the probe, to tell two agents apart in a log.'),
	},
	async handler(args) {
		await apiRequest('/api/herald/announce', {
			method: 'POST',
			body: {
				text: `herald check${args?.note ? `: ${args.note}` : ''}`,
				importance: 0,
				key: 'herald:mcp:check',
			},
		});
		return {
			ok: true,
			base: THREE_WS_BASE,
			credential: 'accepted',
			interrupted_anyone: false,
			note: 'Queued at importance 0, which every client drops under its own floor.',
		};
	},
};
