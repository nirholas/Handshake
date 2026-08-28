// Author a Motion Score from a sentence.
//
// Two lanes, and the fast one always runs first:
//
//   1. The deterministic composer in @three-ws/motion. It recognizes about
//      twenty actions with their modifiers, costs nothing, answers in under a
//      millisecond, and gives the same clip for the same prompt forever. Most
//      of what people type at a motion box is "wave", "nod", "sit down".
//   2. A language model, given the score schema as a tool contract. This is
//      what handles the other half: "she looks up from her desk, considers it,
//      then shakes her head slowly". It runs on the free-first llmComplete
//      chain, and a model that returns something the compiler rejects gets one
//      repair attempt carrying the exact validation path that failed.
//
// If the model lane is unavailable or its output cannot be repaired, the
// composer's nearest match answers instead. The caller is always told which
// lane produced the score and why, because "the model wrote this" and "we
// recognized the word wave" are different enough that a UI should say so.

import {
	ACTION_NAMES,
	composeScore,
	describeScore,
	scoreSchema,
	validateScore,
} from '@three-ws/motion';
import { llmComplete, llmConfigured, LlmUnavailableError } from './llm.js';
import { extractJson } from './bounty-judge.js';

/** How many beats a model is asked for, so a clip stays a clip. */
const BEAT_BUDGET = { min: 2, max: 12 };

const SYSTEM = [
	'You are a movement director. You write Motion Scores: a JSON description of',
	'how a human body moves, in anatomy and timing, which a kinematics solver',
	'turns into a real animation.',
	'',
	'Rules that matter more than anything else you know about animation:',
	`- Answer with ONE JSON object matching the schema. No prose, no markdown fence.`,
	`- ${BEAT_BUDGET.min} to ${BEAT_BUDGET.max} beats. A beat is the body at one instant, not a span.`,
	'- Use ONLY the enum values in the schema. An invented posture, anchor, gaze,',
	'  expression or hand shape is rejected outright, so pick the closest one.',
	'- Start from a beat that establishes the body, end from one it can rest in.',
	'- `in` is seconds of travel INTO the beat; `hold` is seconds spent there.',
	'- Offsets are METRES on a human of about 1.7m. A hand width is 0.09m. Anything',
	'  over 0.4 is almost certainly wrong.',
	'- Angles are DEGREES. `lean` is positive forward, `twist` and `turn` positive',
	'  toward the body\'s own left, gaze `pitch` positive upward.',
	'- Effort is how it is performed, and it is not decoration: pick the preset',
	'  that matches the adverb in the request.',
	'- Every beat gets a short `label` saying what it is. A reader should be able',
	'  to follow the movement from the labels alone.',
	'',
	'Think about what the body does that the words leave out. Weight shifts before',
	'a step. The head leads a turn. A hand comes back to rest. Somebody who is',
	'tired lowers themselves rather than dropping.',
].join('\n');

/**
 * Produce a validated Motion Score for a prompt.
 *
 * @param {string} prompt
 * @param {{
 *   loop?: boolean,
 *   effort?: string,
 *   prefer?: 'auto'|'fast'|'model',
 *   userId?: string|null,
 *   timeoutMs?: number,
 * }} [opts]
 *   `prefer` is 'auto' by default: the composer answers a phrase it recognizes,
 *   and the model handles everything else. 'fast' never calls a model; 'model'
 *   always tries one first.
 * @returns {Promise<{
 *   score: object, lane: 'composer'|'model', matched: string|null,
 *   provider: string|null, model: string|null, note: string|null,
 * }>}
 */
export async function authorScore(prompt, opts = {}) {
	const text = String(prompt ?? '').trim();
	if (!text) throw Object.assign(new Error('a motion needs a description'), { status: 400, code: 'empty_prompt' });

	const prefer = opts.prefer ?? 'auto';
	const fast = composeScore(text, { loop: opts.loop, effort: opts.effort });

	if (prefer === 'fast' || (prefer === 'auto' && fast.score)) {
		if (fast.score) {
			return { score: fast.score, lane: 'composer', matched: fast.matched, provider: null, model: null, note: null };
		}
		throw Object.assign(new Error(fast.reason), { status: 422, code: 'unrecognized_motion', actions: [...ACTION_NAMES] });
	}

	if (!llmConfigured()) {
		if (fast.score) {
			return {
				score: fast.score,
				lane: 'composer',
				matched: fast.matched,
				provider: null,
				model: null,
				note: 'No language model is reachable, so this is the nearest movement the built-in vocabulary knows.',
			};
		}
		throw Object.assign(
			new Error(`No language model is reachable, and "${text}" is not one of the movements this build can compose on its own.`),
			{ status: 503, code: 'model_unavailable', actions: [...ACTION_NAMES] },
		);
	}

	try {
		const authored = await askModel(text, opts);
		return { ...authored, lane: 'model', matched: fast.matched };
	} catch (err) {
		if (fast.score) {
			return {
				score: fast.score,
				lane: 'composer',
				matched: fast.matched,
				provider: null,
				model: null,
				note: `The model lane failed (${err.message}), so this is the built-in movement closest to the request.`,
			};
		}
		if (err instanceof LlmUnavailableError) {
			throw Object.assign(new Error('No language model is reachable right now.'), { status: 503, code: 'model_unavailable' });
		}
		throw err;
	}
}

async function askModel(prompt, opts) {
	const schema = scoreSchema();
	const user = [
		`Movement to write: ${prompt}`,
		opts.loop ? 'It must LOOP: the last beat has to flow back into the first, so end where you began.' : '',
		opts.effort ? `Perform it with the "${opts.effort}" effort unless the request clearly says otherwise.` : '',
		'',
		'Schema:',
		JSON.stringify(schema),
	].filter(Boolean).join('\n');

	const first = await llmComplete({
		system: SYSTEM,
		user,
		maxTokens: 2400,
		timeoutMs: opts.timeoutMs ?? 25_000,
		track: { userId: opts.userId ?? null, tool: 'motion-author' },
	});

	const parsed = readScore(first.text);
	if (parsed.ok) {
		return { score: named(parsed.score, prompt, opts), provider: first.provider, model: first.model, note: null };
	}

	// One repair pass, carrying the exact path that failed. A model that wrote
	// `posture: "sitting"` fixes it immediately when told the word and the enum;
	// asking it to "try again" does not.
	const repair = await llmComplete({
		system: SYSTEM,
		user: [
			user,
			'',
			'Your previous answer was rejected by the compiler:',
			`  ${parsed.error}`,
			'Return the corrected JSON object. Change only what the error names.',
			'',
			'Previous answer:',
			first.text.slice(0, 4000),
		].join('\n'),
		maxTokens: 2400,
		timeoutMs: opts.timeoutMs ?? 25_000,
		track: { userId: opts.userId ?? null, tool: 'motion-author-repair' },
	});

	const second = readScore(repair.text);
	if (!second.ok) {
		throw Object.assign(new Error(`the model could not produce a valid score: ${second.error}`), { status: 502, code: 'invalid_score' });
	}
	return {
		score: named(second.score, prompt, opts),
		provider: repair.provider,
		model: repair.model,
		note: 'The first draft did not validate and was repaired in a second pass.',
	};
}

// Parse whatever the model returned and hold it to the compiler's own rules, so
// a score can never reach a solver in a shape the solver has to guess about.
function readScore(text) {
	let raw;
	try {
		raw = extractJson(text);
	} catch {
		raw = null;
	}
	if (!raw || typeof raw !== 'object') return { ok: false, error: 'the answer was not a JSON object' };
	if (Array.isArray(raw)) return { ok: false, error: 'the answer was an array, not a score object' };
	const result = validateScore(raw);
	if (!result.ok) return { ok: false, error: result.error.message };
	if (result.score.beats.length < BEAT_BUDGET.min) {
		return { ok: false, error: `score.beats: a movement needs at least ${BEAT_BUDGET.min} beats` };
	}
	// The normalized score is what the solver reads, but the raw one is what a
	// caller edits and re-submits, so both travel together.
	return { ok: true, score: raw };
}

function named(score, prompt, opts) {
	return {
		...score,
		name: typeof score.name === 'string' && score.name.trim() ? score.name.trim() : prompt.slice(0, 120),
		loop: opts.loop === true || score.loop === true,
	};
}

export { describeScore, ACTION_NAMES };
