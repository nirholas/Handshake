// `run_macro` — "good night" to the scene this house actually has, then run it.
//
// Resolution goes through a synonym table and then fuzzy matching over the
// house's own scene and script names, so "goodnight", "bedtime" and "time for
// bed" all reach the same place, and a house with no match runs nothing rather
// than firing the closest thing it can find.

import { home } from '../lib/home.js';
import { refusal } from '../lib/gate.js';

export const def = {
	name: 'run_macro',
	title: 'Resolve a phrase to one of the household\'s own scenes and run it',
	annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
	description:
		'Turn a phrase like "good night", "movie time" or "away" into the scene or script this house actually ' +
		'has, and run it. Returns `ran`, and `match` with the `entity_id`, `confidence` (0-1) and a `reason` ' +
		'you can say out loud. A house with no matching macro returns ran:false and match:null and runs ' +
		'NOTHING, which is correct: firing the nearest scene is how a "good night" turns into an away mode. ' +
		'Pass `dry_run: true` to resolve without running, which is the right first call when you are not sure ' +
		'the phrase maps to anything. A macro that would open the house goes through the same gate as ' +
		'`call_service` and is refused here too.',
	inputSchema: {
		phrase: {
			type: 'string',
			description: 'What the person said, e.g. "good night", "movie time", "I am leaving".',
		},
		dry_run: {
			type: 'boolean',
			description: 'Resolve the phrase and report the match without running it. Default false.',
		},
	},
	async handler(args = {}) {
		const phrase = String(args.phrase || '').trim();
		if (!phrase) return { ok: false, error: 'bad_request', message: '`phrase` is required.' };

		const bridge = await home();
		let result;
		try {
			result = await bridge.activate(phrase, { dryRun: Boolean(args.dry_run) });
		} catch (err) {
			const refused = refusal(err);
			if (refused) return refused;
			throw err;
		}

		if (!result.match) {
			return {
				ok: true,
				ran: false,
				match: null,
				message: `Nothing in this house matches "${phrase}". Call list_macros to see what it does have, and do not substitute a different scene.`,
			};
		}

		return {
			ok: true,
			ran: result.ran,
			dry_run: Boolean(args.dry_run),
			match: {
				entity_id: result.match.entityId,
				name: result.match.name ?? null,
				macro: result.match.macro ?? null,
				confidence: result.match.confidence,
				reason: result.match.reason,
			},
		};
	},
};
