// Sign speech — the signed-language counterpart of text-to-speech.
//
// Give it text and it produces ONE canonical-skeleton AnimationClip document
// that performs the whole utterance: each word is looked up in a sign
// dictionary (lexical clips captured from real signers via the video2motion
// lane), and any word without a dictionary entry is fingerspelled through
// src/fingerspelling.js. Compiling the utterance to a single clip means every
// chat surface integrates the same way a TTS call does: compile → inject →
// play once — no per-word sequencing, no playback-completion plumbing.
//
// The module is deliberately platform-free (no three.js, no DOM, no fetch):
// the dictionary is injected, and the player is any object with the
// AnimationManager shape (injectClip + playOnce). That keeps it extractable as
// a standalone package.

import { DEFAULT_TIMING, buildFingerspellingClip, normalizeWord } from './fingerspelling.js';

// Chat replies favour pace over ceremony: quicker holds and transitions than
// the studio default, so a sentence stays watchable.
export const CHAT_TIMING = Object.freeze({
	...DEFAULT_TIMING,
	holdSeconds: 0.34,
	transitionSeconds: 0.16,
	leadSeconds: 0.25,
	tailSeconds: 0.3,
});

const WORD_GAP_SECONDS = 0.18;
const NORMAL_BLEND_MODE = 2500;

/**
 * Split text into the word sequence the signer will perform. Letters and
 * digits survive (A–Z fingerspelling plus the ASL number handshapes 0–9);
 * punctuation is dropped.
 */
export function utteranceWords(text) {
	return normalizeWord(text).split(' ').filter(Boolean);
}

/**
 * Rough signing duration in seconds for `text` under `timing`, before
 * compiling anything — used to cap chat replies to a watchable length.
 */
export function estimateDuration(text, timing = CHAT_TIMING) {
	const words = utteranceWords(text);
	const letters = words.reduce((n, w) => n + w.length, 0);
	return (
		timing.leadSeconds +
		timing.tailSeconds +
		letters * (timing.holdSeconds + timing.transitionSeconds) +
		Math.max(0, words.length - 1) * WORD_GAP_SECONDS
	);
}

// Append `clip`'s tracks to the merged timeline starting at `offset`. Bones
// the clip does not drive hold their previous value across the segment so a
// lexical sign that only animates the arms never snaps the fingers to rest.
function appendSegment(merged, clip, offset) {
	const seen = new Set();
	for (const track of clip.tracks) {
		seen.add(track.name);
		let lane = merged.get(track.name);
		if (!lane) {
			lane = { type: track.type, times: [], values: [] };
			merged.set(track.name, lane);
		}
		const stride = track.type === 'quaternion' ? 4 : 3;
		// Bridge from wherever this bone was left to the segment's first key.
		if (lane.times.length && track.times.length) {
			const first = track.times[0] + offset;
			const lastT = lane.times[lane.times.length - 1];
			if (first - lastT > 1e-6) {
				lane.times.push(lastT + Math.min(WORD_GAP_SECONDS, first - lastT) * 0.5);
				lane.values.push(...lane.values.slice(-stride));
			}
		}
		for (let i = 0; i < track.times.length; i++) {
			lane.times.push(track.times[i] + offset);
			lane.values.push(...track.values.slice(i * stride, i * stride + stride));
		}
	}
	// Bones already in the timeline that this clip does not drive: hold their
	// last value through the segment end so nothing snaps.
	const end = offset + clip.duration;
	for (const [name, lane] of merged) {
		if (seen.has(name)) continue;
		const stride = lane.type === 'quaternion' ? 4 : 3;
		lane.times.push(end);
		lane.values.push(...lane.values.slice(-stride));
	}
	return end;
}

/**
 * Compile `text` into one signed-utterance AnimationClip document.
 *
 * @param {string} text
 * @param {{
 *   signs?: Map<string, object>|((word: string) => object|null),
 *   timing?: object,
 *   maxSeconds?: number,
 *   name?: string,
 * }} [opts]
 *   `signs` resolves a word to a lexical sign clip document (canonical-bone
 *   tracks, the animation library shape); words it misses are fingerspelled.
 * @returns {{ clip: object, words: string[], signed: string[], spelled: string[], truncated: boolean }}
 * @throws when the text has no spellable content.
 */
export function compileUtterance(text, opts = {}) {
	const timing = { ...CHAT_TIMING, ...(opts.timing ?? {}) };
	const maxSeconds = opts.maxSeconds ?? 45;
	const lookup =
		typeof opts.signs === 'function' ? opts.signs : (w) => (opts.signs ? opts.signs.get(w) : null) ?? null;

	const words = utteranceWords(text);
	if (!words.length) throw new Error('text has no signable characters (A-Z, 0-9)');

	const merged = new Map();
	let cursor = 0;
	const signed = [];
	const spelled = [];
	let truncated = false;

	for (const word of words) {
		const sign = lookup(word);
		const segment = sign ?? buildFingerspellingClip(word, { ...timing, name: `fs-${word.toLowerCase()}` });
		const segmentEnd = cursor + segment.duration + (cursor > 0 ? WORD_GAP_SECONDS : 0);
		if (cursor > 0 && segmentEnd > maxSeconds) {
			truncated = true;
			break;
		}
		if (cursor > 0) cursor += WORD_GAP_SECONDS;
		cursor = appendSegment(merged, segment, cursor);
		(sign ? signed : spelled).push(word);
	}

	const tracks = [];
	for (const [name, lane] of merged) {
		if (name === 'Hips.position') continue; // re-added as a single origin key
		tracks.push({ type: lane.type, name, times: lane.times, values: lane.values });
	}
	tracks.push({ type: 'vector', name: 'Hips.position', times: [0], values: [0, 0, 0] });

	return {
		clip: {
			name: opts.name ?? `sign-${words.join('-').toLowerCase()}`.slice(0, 60),
			duration: cursor,
			tracks,
			uuid: undefined,
			blendMode: NORMAL_BLEND_MODE,
		},
		words,
		signed,
		spelled,
		truncated,
	};
}

/**
 * SignSpeaker — drive an avatar's AnimationManager like a TTS engine.
 *
 *   const speaker = new SignSpeaker({ manager });
 *   await speaker.speak('hello world');   // resolves when the signing ends
 *
 * `manager` is anything with the AnimationManager shape:
 *   injectClip(name, clipJSON, opts) and playOnce(name, opts).
 * `signs` (optional) is the lexical dictionary passed through to the compiler.
 */
export class SignSpeaker {
	constructor({ manager, signs = null, timing = null, maxSeconds = 45 } = {}) {
		if (!manager) throw new Error('SignSpeaker needs a manager');
		this.manager = manager;
		this.signs = signs;
		this.timing = timing;
		this.maxSeconds = maxSeconds;
		this._counter = 0;
		this._activeToken = 0;
		this.speaking = false;
	}

	/**
	 * Sign `text` on the avatar. A newer speak() supersedes an in-flight one.
	 * Resolves after the clip's duration with the compile summary.
	 */
	async speak(text, opts = {}) {
		const token = ++this._activeToken;
		const result = compileUtterance(text, {
			signs: this.signs,
			timing: this.timing ?? undefined,
			maxSeconds: this.maxSeconds,
			...opts,
		});
		const name = `sign-speech-${++this._counter}`;
		this.manager.injectClip(name, result.clip, { loop: false });
		if (token !== this._activeToken) return { ...result, superseded: true };
		this.speaking = true;
		this.manager.playOnce(name, opts.playOpts ?? {});
		await new Promise((r) => setTimeout(r, result.clip.duration * 1000));
		if (token === this._activeToken) this.speaking = false;
		return { ...result, superseded: token !== this._activeToken };
	}

	/** Abandon the current utterance (the next speak() takes over cleanly). */
	cancel() {
		this._activeToken++;
		this.speaking = false;
	}
}
