// `announce_result` — report a finished task with the urgency it deserves.
//
// The importance/tone choice is the part an agent gets wrong, so this tool
// makes it for you from the outcome: a failure is loud enough to cut through
// quiet hours, a success is not.

import { z } from 'zod';

import { apiRequest } from '../lib/api.js';

const IMPORTANCE = { failed: 95, needs_input: 90, succeeded: 65 };
const TONE = { failed: 'error', needs_input: 'alert', succeeded: 'celebrate' };
const EMOTE = { failed: undefined, needs_input: 'wave', succeeded: 'dance' };

function humanDuration(seconds) {
	if (!Number.isFinite(seconds) || seconds <= 0) return null;
	if (seconds < 60) return `${Math.round(seconds)}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	return `${(seconds / 3600).toFixed(1)}h`;
}

export const def = {
	name: 'announce_result',
	title: 'Report a finished task in person',
	annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
	description:
		'Tell the human how a task went, in person, with the urgency chosen for you from the outcome: ' +
		'`failed` and `needs_input` are loud enough to cut through quiet hours, `succeeded` is not. Pass ' +
		'the task name, the outcome, and optionally how long it took and where to look. This is the right ' +
		'tool at the end of anything long enough that the person walked away from it. Returns the queued ' +
		'announcement.',
	inputSchema: {
		task: z
			.string()
			.trim()
			.min(1)
			.max(120)
			.describe('What was being done, in human words ("the nightly backfill", "your test suite").'),
		outcome: z
			.enum(['succeeded', 'failed', 'needs_input'])
			.describe('How it ended. Drives importance, tone and gesture.'),
		detail: z
			.string()
			.trim()
			.max(160)
			.optional()
			.describe('One short clause of context ("3 tests failing", "waiting on your approval").'),
		seconds: z
			.number()
			.min(0)
			.optional()
			.describe('How long it took, in seconds. Rendered as "in 4m" when given.'),
		url: z
			.string()
			.trim()
			.max(2048)
			.optional()
			.describe('Where to look: the run, the diff, the dashboard.'),
		key: z
			.string()
			.trim()
			.max(120)
			.optional()
			.describe('Dedupe key, so a retry loop reporting the same result says it once.'),
	},
	async handler(args) {
		const took = humanDuration(args.seconds);
		const verb =
			args.outcome === 'succeeded' ? 'finished' : args.outcome === 'failed' ? 'failed' : 'needs you';
		const parts = [`${args.task} ${verb}`];
		if (took) parts[0] += args.outcome === 'succeeded' ? ` in ${took}` : ` after ${took}`;
		if (args.detail) parts.push(args.detail);

		const data = await apiRequest('/api/herald/announce', {
			method: 'POST',
			body: {
				text: parts.join(': ').slice(0, 280),
				importance: IMPORTANCE[args.outcome],
				tone: TONE[args.outcome],
				emote: EMOTE[args.outcome],
				url: args.url,
				key: args.key,
			},
		});
		return {
			ok: true,
			id: data?.id ?? null,
			queued: data?.queued === true,
			said: data?.announcement?.text ?? null,
			importance: IMPORTANCE[args.outcome],
		};
	},
};
