// MCP tools for American Sign Language.
//
//   • list_sign_vocabulary (free) — the words that have a real sign, with the
//                                   handshape/place/movement each one performs.
//   • sign_text            (free) — compile text into a signed utterance: the
//                                   performed timeline, and on request the
//                                   retargetable animation clip itself.
//
// Both run the same platform-free compiler the browser runs (src/sign-speech.js
// via api/sign.js), so an agent asking for a signed utterance gets exactly what
// /sign-language would perform. Nothing here touches the network, the database,
// or the filesystem: it is pure computation over an in-process lexicon.
//
// The clip is deliberately opt-in. A short sentence compiles to tens of
// thousands of numbers, which is worth fetching over HTTP and worthless inside
// a chat transcript, so the default answer is the timeline plus the URL that
// returns the bytes.

import { compile, descriptor, readParams } from '../../sign.js';
import { resolveOrigin } from '../origin.js';
import { SIGNABLE_WORDS } from '../../../src/sign-dictionary.js';

function rpcError(code, message) {
	const e = new Error(message);
	e.code = code;
	return e;
}

/** `HAPPY (1.9s) · T-O spelled (1.3s)` — the utterance as one readable line. */
function describeTimeline(timeline) {
	return timeline
		.map((s) => {
			const secs = `${(s.end - s.start).toFixed(1)}s`;
			if (s.signed) return `  ${s.word.padEnd(12)} signed   ${secs.padStart(6)}   ${s.gloss}`;
			const letters = s.letters?.map((l) => l.letter).join('-') ?? s.word;
			return `  ${s.word.padEnd(12)} spelled  ${secs.padStart(6)}   ${letters}`;
		})
		.join('\n');
}

export const toolDefs = [
	{
		name: 'list_sign_vocabulary',
		title: 'List the ASL vocabulary',
		// Reads a frozen in-process lexicon: deterministic and closed-world.
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		description:
			'List every word three.ws avatars have a real American Sign Language sign for, with a plain description of the handshape, place on the body, and movement each one performs. Words outside this list are fingerspelled letter by letter instead. Use it to know in advance what a phrase will sign versus spell.',
		inputSchema: {
			type: 'object',
			properties: {
				search: {
					type: 'string',
					description: 'Optional substring filter over the words and their descriptions.',
				},
			},
			additionalProperties: false,
		},
		async handler(args) {
			const { vocabulary } = descriptor('https://three.ws');
			const q = String(args.search ?? '').trim().toLowerCase();
			const matched = q
				? vocabulary.filter(
						(v) => v.word.toLowerCase().includes(q) || v.gloss.toLowerCase().includes(q),
					)
				: vocabulary;
			const lines = matched.map((v) => `  ${v.word.padEnd(10)} ${v.gloss}`).join('\n');
			return {
				content: [
					{
						type: 'text',
						text:
							`${matched.length} signed word${matched.length === 1 ? '' : 's'}` +
							`${q ? ` matching "${q}"` : ''} (everything else fingerspells):\n${lines}`,
					},
				],
				structuredContent: {
					count: matched.length,
					vocabulary: matched,
					// Aliases resolve onto the same signs (THANKS → THANK), so the set a
					// caller can rely on signing is wider than the sign list itself.
					recognized_words: SIGNABLE_WORDS,
				},
			};
		},
	},
	{
		name: 'sign_text',
		title: 'Sign text in ASL',
		// Pure computation over a frozen lexicon: same input, same clip, every time.
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		description:
			'Compile English text into one continuous American Sign Language performance for a 3D avatar. Words with a real sign are signed; everything else is fingerspelled, in the same clip. Returns the performed timeline (every word, whether it signed or spelled, the seconds it occupies, and where each spelled letter lands) plus a link that plays it on a live avatar. Set include_clip to also get the three.js AnimationClip document, keyed to the canonical humanoid skeleton, to retarget onto any rigged avatar and play.',
		inputSchema: {
			type: 'object',
			properties: {
				text: {
					type: 'string',
					description: 'The text to sign. Letters, digits and spaces are performed; punctuation is dropped.',
				},
				hand: {
					type: 'string',
					enum: ['right', 'left'],
					default: 'right',
					description: 'Dominant signing hand. The whole sign mirrors, not just the hand.',
				},
				speed: {
					type: 'number',
					default: 1,
					description: 'Playback rate, 0.25–1.5. Below 1 is a signer taking longer over the same signs.',
				},
				max_seconds: {
					type: 'number',
					default: 45,
					description: 'Cap the utterance length; longer text truncates at a word boundary and is flagged.',
				},
				include_clip: {
					type: 'boolean',
					default: false,
					description:
						'Include the full animation clip document. It is large (tens of thousands of numbers); leave it off and fetch clip_url when you need the bytes.',
				},
			},
			required: ['text'],
			additionalProperties: false,
		},
		async handler(args, auth, req) {
			const origin = resolveOrigin(req);
			const params = readParams({
				text: args.text,
				hand: args.hand,
				speed: args.speed,
				max_seconds: args.max_seconds,
				format: args.include_clip ? 'clip' : 'timeline',
			});
			if (!params.text.trim()) throw rpcError(-32602, 'text is required');

			let result;
			try {
				result = compile(params, origin);
			} catch (err) {
				// The compiler throws only when nothing in the text is performable.
				throw rpcError(-32602, `${err.message} (fingerspelling covers A-Z and 0-9)`);
			}

			const clipUrl = `${origin}/api/sign?text=${encodeURIComponent(params.text)}${
				params.hand === 'Left' ? '&hand=left' : ''
			}${params.speed === 1 ? '' : `&speed=${params.speed}`}`;

			const headline =
				`"${result.text}" signs in ${result.duration.toFixed(1)}s: ` +
				`${result.signed.length} signed, ${result.spelled.length} fingerspelled` +
				`${result.truncated ? ' (truncated to fit max_seconds)' : ''}.`;

			return {
				content: [
					{
						type: 'text',
						text:
							`${headline}\n\n${describeTimeline(result.timeline)}\n\n` +
							`Watch it: ${result.viewer}\nClip JSON: ${clipUrl}`,
					},
				],
				structuredContent: {
					ok: true,
					text: result.text,
					duration: result.duration,
					hand: result.hand,
					speed: result.speed,
					signed: result.signed,
					spelled: result.spelled,
					truncated: result.truncated,
					timeline: result.timeline,
					viewer_url: result.viewer,
					clip_url: clipUrl,
					...(result.clip ? { clip: result.clip } : {}),
				},
			};
		},
	},
];
