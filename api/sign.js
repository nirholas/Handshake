/**
 * /api/sign — text → American Sign Language, as a retargetable animation clip.
 *
 *   GET  /api/sign
 *     → the descriptor: parameters, limits, and the full lexical vocabulary
 *       with each sign's gloss. Call this to discover what will sign vs spell.
 *
 *   GET  /api/sign?text=happy+to+meet+you[&hand=left][&speed=0.75][&format=timeline]
 *   POST /api/sign  { text, hand, speed, max_seconds, format }
 *     → { text, duration, words, signed, spelled, timeline, clip, viewer }
 *
 * This is the writing half of the signing stack; /api/asl-recognition is the
 * reading half. The compiler (src/sign-speech.js) is the same one the browser
 * runs, and it is platform-free by design — no three.js, no DOM — so the server
 * produces a byte-identical clip to the one /sign-language plays. `clip` is a
 * three.js AnimationClip document keyed to the canonical skeleton: load it
 * alongside any rigged humanoid, retarget it (src/animation-retarget.js, or
 * @three-ws/retarget), and play. Nothing here needs an account or a key.
 *
 * `timeline` is the part a UI wants: one entry per word with the seconds it
 * occupies, whether it was signed or spelled, the sign's gloss, and for a
 * spelled word where every letter lands. That is enough to caption an utterance
 * in sync without re-deriving the cadence it was compiled from.
 */

import { cors, json, method, readJson, wrap, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { env } from './_lib/env.js';
import { compileUtterance, scaledTiming, utteranceWords } from '../src/sign-speech.js';
import { SIGNS, signLookup } from '../src/sign-dictionary.js';

// Long enough for a paragraph, short enough that one call stays a few tens of
// milliseconds of CPU. Past this the caller should split the text themselves,
// which is also what produces watchable signing.
const MAX_TEXT_CHARS = 600;
const MAX_BODY_BYTES = 16_000;

// Clip coordinates are quaternion components and seconds; five decimals is well
// under a millimetre at arm's length and halves the payload before gzip.
const PRECISION = 1e5;

const SPEED_RANGE = { min: 0.25, max: 1.5 };
const SECONDS_RANGE = { min: 1, max: 60, default: 45 };

function round(n) {
	return Math.round(n * PRECISION) / PRECISION;
}

/** Round every number in a compiled clip document, in place. */
function compactClip(clip) {
	return {
		name: clip.name,
		duration: round(clip.duration),
		blendMode: clip.blendMode,
		tracks: clip.tracks.map((t) => ({
			type: t.type,
			name: t.name,
			times: t.times.map(round),
			values: t.values.map(round),
		})),
	};
}

function clampNumber(raw, { min, max, fallback }) {
	const n = Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

/** The one place request params turn into compiler options. */
function readParams(source) {
	const text = String(source.text ?? '').slice(0, MAX_TEXT_CHARS);
	const hand = String(source.hand ?? '').toLowerCase() === 'left' ? 'Left' : 'Right';
	const speed = clampNumber(source.speed, { ...SPEED_RANGE, fallback: 1 });
	const maxSeconds = clampNumber(source.max_seconds ?? source.maxSeconds, {
		min: SECONDS_RANGE.min,
		max: SECONDS_RANGE.max,
		fallback: SECONDS_RANGE.default,
	});
	const format = String(source.format ?? 'clip').toLowerCase() === 'timeline' ? 'timeline' : 'clip';
	return { text, hand, speed, maxSeconds, format };
}

function descriptor(origin) {
	const vocabulary = Object.entries(SIGNS)
		.map(([word, sign]) => ({ word, gloss: sign.gloss }))
		.sort((a, b) => a.word.localeCompare(b.word));
	return {
		service: 'three.ws sign',
		summary:
			'Compile English text into one continuous American Sign Language animation clip. ' +
			'Words in the vocabulary are signed; everything else is fingerspelled letter by letter.',
		usage: {
			compile: `${origin}/api/sign?text=happy+to+meet+you`,
			timeline_only: `${origin}/api/sign?text=happy+to+meet+you&format=timeline`,
			left_handed: `${origin}/api/sign?text=hello&hand=left`,
			post: `POST ${origin}/api/sign  {"text":"hello","speed":0.75}`,
		},
		parameters: {
			text: `required to compile. Letters, digits and spaces survive; punctuation is dropped. Up to ${MAX_TEXT_CHARS} characters.`,
			hand: 'right (default) or left. The whole sign mirrors, not just the hand.',
			speed: `${SPEED_RANGE.min}-${SPEED_RANGE.max}, default 1. Below 1 is a signer taking longer over the same signs.`,
			max_seconds: `${SECONDS_RANGE.min}-${SECONDS_RANGE.max}, default ${SECONDS_RANGE.default}. Longer text is truncated at a word boundary and flagged.`,
			format: 'clip (default) returns the animation clip plus the timeline; timeline returns only the timeline, which is small and free of clip data.',
		},
		clip_format: {
			description:
				'A three.js AnimationClip document keyed to the canonical humanoid skeleton, rotation lanes only. Retarget it onto any rigged humanoid, then play it.',
			retarget: 'https://www.npmjs.com/package/@three-ws/retarget',
			engine: 'https://www.npmjs.com/package/@three-ws/sign-language',
		},
		vocabulary_size: vocabulary.length,
		vocabulary,
		reading_direction: `${origin}/api/asl-recognition`,
		docs: `${origin}/docs/sign-language`,
		watch: `${origin}/sign-language`,
		scope:
			'Citation-form signs in English word order (signed English), not ASL grammar. It makes an avatar legible to signers; it does not replace an interpreter.',
	};
}

function compile(params, origin) {
	const { text, hand, speed, maxSeconds, format } = params;
	const result = compileUtterance(text, {
		signs: signLookup({ dominant: hand, rate: speed }),
		timing: speed === 1 ? undefined : scaledTiming(speed),
		maxSeconds,
		dominant: hand,
	});

	const timeline = result.segments.map((s) => ({
		word: s.word,
		signed: s.signed,
		gloss: s.gloss,
		start: round(s.start),
		end: round(s.end),
		letters: s.letters?.map((l) => ({ letter: l.letter, start: round(l.start), end: round(l.end) })) ?? null,
	}));

	const body = {
		text,
		duration: round(result.clip.duration),
		words: result.words,
		signed: result.signed,
		spelled: result.spelled,
		truncated: result.truncated,
		hand: hand.toLowerCase(),
		speed,
		timeline,
		viewer: `${origin}/sign-language?say=${encodeURIComponent(text)}`,
	};
	if (format === 'clip') body.clip = compactClip(result.clip);
	return body;
}

// Deterministic output: the same text, hand and speed always compile to the same
// clip, so it caches hard at the edge and the compile only ever runs once.
const CACHE_HEADERS = {
	'cache-control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800',
};

export default wrap(async (req, res) => {
	if (cors(req, res, { origins: '*', methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const origin = env.APP_ORIGIN.replace(/\/$/, '');

	let source;
	if (req.method === 'GET') {
		const url = new URL(req.url, 'http://localhost');
		source = Object.fromEntries(url.searchParams);
		// A bare GET is the discovery call: what this does, and what it can sign.
		if (!String(source.text ?? '').trim()) return json(res, 200, descriptor(origin), CACHE_HEADERS);
	} else {
		const body = await readJson(req, MAX_BODY_BYTES).catch(() => null);
		if (!body || typeof body !== 'object') {
			return json(res, 400, {
				error: 'bad_request',
				message: 'Body must be JSON: { "text": "happy to meet you" }.',
			});
		}
		source = body;
	}

	const params = readParams(source);
	if (!params.text.trim()) {
		return json(res, 400, {
			error: 'missing_text',
			message: 'Pass text to sign, for example { "text": "happy to meet you" }.',
		});
	}
	if (!utteranceWords(params.text).length) {
		return json(res, 400, {
			error: 'unsignable_text',
			message:
				'That text has nothing signable in it. Fingerspelling covers A-Z and 0-9; punctuation and other scripts are dropped.',
		});
	}

	const rl = await limits.signCompileIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'Sign compile limit reached. Try again shortly.');

	return json(res, 200, compile(params, origin), CACHE_HEADERS);
});

export { descriptor, compile, readParams, MAX_TEXT_CHARS };
