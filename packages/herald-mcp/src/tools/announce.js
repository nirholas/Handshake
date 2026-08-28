// `announce` — say one line, in person, on the owner's own screen.

import { z } from 'zod';

import { apiRequest } from '../lib/api.js';

export const def = {
	name: 'announce',
	title: 'Tell your human, in person',
	annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
	description:
		'Deliver one line to the human who owns this key, in person: their 3D companion walks onto the ' +
		'browser tab they have open, gestures, and says it, with an optional link to click through. Use ' +
		'this for the handful of moments that deserve to interrupt someone (a long task finished, a ' +
		'decision is needed, something broke), not for progress chatter: the client applies an importance ' +
		'floor, a rate limit, quiet hours and dedupe, so noise is dropped rather than queued. The message ' +
		'is always delivered to the key owner and nobody else. If no browser is open it expires quietly in ' +
		'about five minutes; the durable record is the notification inbox, not this. Returns the queued ' +
		'announcement and how long it stays deliverable.',
	inputSchema: {
		text: z
			.string()
			.trim()
			.min(1)
			.max(280)
			.describe('The line to say out loud. One sentence. Write it as speech, not as a log line.'),
		from: z
			.string()
			.trim()
			.max(60)
			.optional()
			.describe('Who it is from, spoken as attribution ("your build", "Stripe", the agent\'s name).'),
		importance: z
			.number()
			.int()
			.min(0)
			.max(100)
			.optional()
			.describe(
				'0-100, default 70. The client drops anything under its floor (50 by default) and only ' +
					'lets 90+ through quiet hours. Use 90+ for something broken or blocking, 60-80 for a ' +
					'finished task, under 50 for something that can wait for the inbox.',
			),
		url: z
			.string()
			.trim()
			.max(2048)
			.optional()
			.describe('Where clicking through goes: an absolute https URL or a three.ws path.'),
		tone: z
			.enum(['neutral', 'alert', 'celebrate', 'error'])
			.optional()
			.describe('Colours the bubble and picks a default gesture. Default alert.'),
		emote: z
			.enum(['wave', 'dance', 'punch', 'backflip'])
			.optional()
			.describe('Gesture the avatar arrives with. Rigs without it fall back to a wave.'),
		key: z
			.string()
			.trim()
			.max(120)
			.optional()
			.describe(
				'Dedupe key. Two announcements sharing a key are said once, so a retrying job can call ' +
					'this every attempt without repeating itself.',
			),
	},
	async handler(args) {
		const data = await apiRequest('/api/herald/announce', {
			method: 'POST',
			body: {
				text: args.text,
				from: args.from,
				importance: args.importance,
				url: args.url,
				tone: args.tone,
				emote: args.emote,
				key: args.key,
			},
		});
		return {
			ok: true,
			id: data?.id ?? null,
			queued: data?.queued === true,
			expires_in_seconds: data?.expires_in ?? null,
			delivered_to: 'the key owner\'s own live sessions',
			announcement: data?.announcement ?? null,
		};
	},
};
