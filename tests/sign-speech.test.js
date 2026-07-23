import { describe, expect, it, vi } from 'vitest';

import { buildFingerspellingClip } from '../src/fingerspelling.js';
import {
	CHAT_TIMING,
	SignSpeaker,
	compileUtterance,
	estimateDuration,
	utteranceWords,
} from '../src/sign-speech.js';

describe('utteranceWords', () => {
	it('normalizes to signable words', () => {
		expect(utteranceWords('Hey, three.ws! 42')).toEqual(['HEY', 'THREEWS', '42']);
		expect(utteranceWords('$$$')).toEqual([]);
	});
});

describe('compileUtterance', () => {
	it('produces one continuous clip for multiple words', () => {
		const single = compileUtterance('hi');
		const multi = compileUtterance('hi yo');
		expect(multi.clip.duration).toBeGreaterThan(single.clip.duration);
		expect(multi.words).toEqual(['HI', 'YO']);
		expect(multi.spelled).toEqual(['HI', 'YO']);
		expect(multi.signed).toEqual([]);
		for (const track of multi.clip.tracks) {
			for (let i = 1; i < track.times.length; i++) {
				expect(track.times[i], track.name).toBeGreaterThan(track.times[i - 1]);
			}
		}
	});

	it('uses a dictionary sign when available and fingerspells the rest', () => {
		const lexical = buildFingerspellingClip('A', { name: 'sign-hello' });
		const signs = new Map([['HELLO', lexical]]);
		const out = compileUtterance('hello world', { signs });
		expect(out.signed).toEqual(['HELLO']);
		expect(out.spelled).toEqual(['WORLD']);
	});

	it('accepts a lookup function', () => {
		const lexical = buildFingerspellingClip('B', { name: 'sign-yes' });
		const out = compileUtterance('yes no', { signs: (w) => (w === 'YES' ? lexical : null) });
		expect(out.signed).toEqual(['YES']);
		expect(out.spelled).toEqual(['NO']);
	});

	it('caps the utterance at maxSeconds and reports truncation', () => {
		const out = compileUtterance('alpha beta gamma delta epsilon zeta', { maxSeconds: 8 });
		expect(out.truncated).toBe(true);
		expect(out.clip.duration).toBeLessThanOrEqual(8);
		expect(out.spelled.length).toBeLessThan(6);
	});

	it('holds undriven bones instead of dropping them mid-utterance', () => {
		// A "lexical" clip that drives only the right arm: the finger lanes from
		// the fingerspelled word before it must extend across its segment.
		const armOnly = {
			name: 'sign-armonly',
			duration: 1.0,
			tracks: [
				{ type: 'quaternion', name: 'RightArm.quaternion', times: [0, 1], values: [0, 0, 0, 1, 0, 0, 0, 1] },
			],
			blendMode: 2500,
		};
		const out = compileUtterance('hi wave', { signs: new Map([['WAVE', armOnly]]) });
		const finger = out.clip.tracks.find((t) => t.name === 'RightHandIndex1.quaternion');
		expect(finger.times[finger.times.length - 1]).toBeCloseTo(out.clip.duration, 5);
	});

	it('throws on unsignable text', () => {
		expect(() => compileUtterance('!!!')).toThrow();
		expect(compileUtterance('12345').clip.duration).toBeGreaterThan(0);
	});
});

describe('estimateDuration', () => {
	it('tracks compiled duration closely for plain fingerspelling', () => {
		const text = 'hello world';
		const est = estimateDuration(text, CHAT_TIMING);
		const real = compileUtterance(text).clip.duration;
		expect(Math.abs(est - real)).toBeLessThan(1.0);
	});
});

describe('SignSpeaker', () => {
	function fakeManager() {
		return { injectClip: vi.fn(), playOnce: vi.fn() };
	}

	it('injects and plays a compiled clip, resolving after its duration', async () => {
		vi.useFakeTimers();
		const manager = fakeManager();
		const speaker = new SignSpeaker({ manager });
		const p = speaker.speak('hi');
		expect(manager.injectClip).toHaveBeenCalledTimes(1);
		const [, clip, opts] = manager.injectClip.mock.calls[0];
		expect(opts).toEqual({ loop: false });
		expect(speaker.speaking).toBe(true);
		await vi.advanceTimersByTimeAsync(clip.duration * 1000 + 10);
		const out = await p;
		expect(manager.playOnce).toHaveBeenCalledTimes(1);
		expect(out.superseded).toBe(false);
		expect(speaker.speaking).toBe(false);
		vi.useRealTimers();
	});

	it('a newer speak supersedes an older one', async () => {
		vi.useFakeTimers();
		const manager = fakeManager();
		const speaker = new SignSpeaker({ manager });
		const first = speaker.speak('abc');
		const second = speaker.speak('yo');
		await vi.advanceTimersByTimeAsync(60_000);
		const [a, b] = await Promise.all([first, second]);
		expect(a.superseded).toBe(true);
		expect(b.superseded).toBe(false);
		vi.useRealTimers();
	});

	it('cancel stops the speaking state', async () => {
		vi.useFakeTimers();
		const speaker = new SignSpeaker({ manager: fakeManager() });
		const p = speaker.speak('hi');
		speaker.cancel();
		expect(speaker.speaking).toBe(false);
		await vi.advanceTimersByTimeAsync(60_000);
		await p;
		vi.useRealTimers();
	});
});
