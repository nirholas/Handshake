/**
 * AgentAvatar.sign(): performing caller-supplied text in ASL.
 *
 * tests/sign-speech.test.js pins the engine (text in, one clip out) and
 * tests/sign-rig.test.js pins the rig requirements. This file pins the half
 * neither can see: the public entry point an embed calls when it has its own
 * text (a caption track, an accessibility overlay) rather than an assistant
 * reply to sign.
 *
 * The two failures worth guarding are the ones the conversational path already
 * had answers for and a direct call could easily lose: signing without the
 * attribute having been set first (the caller should not have to enable the
 * engine by hand), and a rig with no finger bones, which must decline rather
 * than perform something wrong.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

let AgentAvatar;

function makeRoot() {
	return {
		isObject3D: true,
		children: [],
		traverse(fn) {
			fn(this);
		},
	};
}

/**
 * The manager shape SignSpeaker drives: it injects a compiled clip and plays it
 * once. `canonical` is what supportsCanonicalClips() reports, i.e. whether the
 * loaded rig has the canonical skeleton the signing poses are authored against.
 */
function makeAnimationManager({ canonical = true } = {}) {
	const injected = [];
	const played = [];
	return {
		currentName: null,
		isLoaded: () => false,
		getAnimationDefs: () => [],
		play: () => Promise.resolve(true),
		crossfadeTo: () => {},
		supportsCanonicalClips: () => canonical,
		injectClip: (name, clip, opts) => injected.push({ name, clip, opts }),
		playOnce: (name, opts) => played.push({ name, opts }),
		injected,
		played,
	};
}

function makeAvatar(am) {
	return new AgentAvatar(
		{ content: makeRoot(), animationManager: am, state: {} },
		{},
		{
			id: 'test',
		},
	);
}

beforeEach(async () => {
	vi.useRealTimers();
	if (!AgentAvatar) ({ AgentAvatar } = await import('../src/agent-avatar.js'));
});

describe('AgentAvatar.sign', () => {
	it('enables the engine on first use and performs the text', async () => {
		const am = makeAnimationManager();
		const avatar = makeAvatar(am);

		// No setSignLanguage(true) first: a caller with its own text should not
		// have to turn the engine on by hand.
		const result = await avatar.sign('hello friend');

		expect(result).toBeTruthy();
		expect(result.signed).toContain('HELLO');
		expect(am.injected).toHaveLength(1);
		expect(am.injected[0].clip.duration).toBeGreaterThan(0);
		expect(am.played).toHaveLength(1);
		expect(am.played[0].name).toBe(am.injected[0].name);
	}, 20000);

	it('reports which words were signed and which fingerspelled', async () => {
		const am = makeAnimationManager();
		const avatar = makeAvatar(am);

		const result = await avatar.sign('hello zqxj');

		expect(result.signed).toContain('HELLO');
		expect(result.spelled).toContain('ZQXJ');
	}, 20000);

	it('declines on a rig that cannot sign instead of performing something wrong', async () => {
		const am = makeAnimationManager({ canonical: false });
		const avatar = makeAvatar(am);

		expect(await avatar.sign('hello friend')).toBe(null);
		expect(am.injected).toHaveLength(0);
		expect(avatar.signLanguage).toBe(false);
	});

	it('ignores empty text without touching the rig', async () => {
		const am = makeAnimationManager();
		const avatar = makeAvatar(am);

		expect(await avatar.sign('')).toBe(null);
		expect(am.injected).toHaveLength(0);
	});
});
