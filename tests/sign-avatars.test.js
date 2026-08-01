// @vitest-environment jsdom
//
// The Avatar control shared by /sign-language, /asl-alphabet and the mirror
// drill. Before this module those pages each hardcoded the same two rigs, so a
// visitor could watch the platform's avatars sign but never their own.
//
// The rules that matter to a person using it: a custom avatar persists across
// pages, a rig that cannot sign never gets to stay on stage (the pill snaps
// back to the one that was working), and nothing in localStorage can put a
// junk URL in front of the GLB loader.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	BUILT_IN_RIGS,
	buildRigPicker,
	customRig,
	loadSignPrefs,
	resolveRig,
	rigFromAvatar,
	saveSignPrefs,
} from '../src/sign-avatars.js';

const CUSTOM = { id: 'custom:av_9', label: 'Nova', url: 'https://three.ws/cdn/u/av_9/model.glb' };

beforeEach(() => {
	localStorage.clear();
	document.body.innerHTML = '<div id="rig"></div>';
});

const host = () => document.getElementById('rig');
const pills = () => [...host().querySelectorAll('button')];
const pressed = () => pills().find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent;

describe('preferences', () => {
	it('merges rather than replacing, so one page cannot drop another page setting', () => {
		saveSignPrefs({ dominant: 'Left' });
		saveSignPrefs({ rate: 0.5 });
		expect(loadSignPrefs()).toMatchObject({ dominant: 'Left', rate: 0.5 });
	});

	it('survives unreadable storage', () => {
		localStorage.setItem('threews:sign-prefs', '{not json');
		expect(loadSignPrefs()).toEqual({});
		expect(resolveRig()).toEqual(BUILT_IN_RIGS[0]);
	});
});

describe('resolveRig', () => {
	it('defaults to the classic rig', () => {
		expect(resolveRig({})).toEqual(BUILT_IN_RIGS[0]);
	});

	it('returns the stored custom avatar when it is the active pick', () => {
		expect(resolveRig({ avatar: CUSTOM.id, customRig: CUSTOM })).toMatchObject({ url: CUSTOM.url, custom: true });
	});

	it('keeps a stored custom avatar available while a built-in is on stage', () => {
		const prefs = { avatar: 'expressive', customRig: CUSTOM };
		expect(resolveRig(prefs)).toEqual(BUILT_IN_RIGS[1]);
		expect(customRig(prefs)).toMatchObject({ label: 'Nova' });
	});

	it('rejects a stored rig with a non-http URL', () => {
		const poisoned = { avatar: 'custom:x', customRig: { id: 'custom:x', label: 'x', url: 'javascript:alert(1)' } };
		expect(customRig(poisoned)).toBeNull();
		expect(resolveRig(poisoned)).toEqual(BUILT_IN_RIGS[0]);
	});
});

describe('rigFromAvatar', () => {
	it('reads the gallery record', () => {
		expect(rigFromAvatar({ id: 'av_9', name: 'Nova', model_url: CUSTOM.url })).toEqual({
			id: 'custom:av_9',
			label: 'Nova',
			url: CUSTOM.url,
			custom: true,
		});
	});

	it('refuses an avatar with no model', () => {
		expect(rigFromAvatar({ id: 'av_9', name: 'Nova' })).toBeNull();
	});
});

describe('buildRigPicker', () => {
	it('renders the built-ins plus one custom pill, pressing the active rig', () => {
		buildRigPicker({ host: '#rig', optionClass: 'sl-opt', active: BUILT_IN_RIGS[1], apply: async () => true });
		expect(pills().map((b) => b.textContent)).toEqual(['Classic', 'Expressive face', 'Your avatar…']);
		expect(pressed()).toBe('Expressive face');
	});

	it('names the custom pill after the stored avatar and switches to it without reopening the gallery', async () => {
		saveSignPrefs({ customRig: CUSTOM });
		const apply = vi.fn().mockResolvedValue(true);
		buildRigPicker({ host: '#rig', optionClass: 'sl-opt', active: BUILT_IN_RIGS[0], apply });

		const custom = pills()[2];
		expect(custom.textContent).toBe('Nova');
		custom.click();
		await vi.waitFor(() => expect(apply).toHaveBeenCalled());
		expect(apply.mock.calls[0][0]).toMatchObject({ url: CUSTOM.url, custom: true });
		expect(pressed()).toBe('Nova');
	});

	it('restores the previous pill when a rig cannot sign', async () => {
		saveSignPrefs({ customRig: CUSTOM });
		buildRigPicker({ host: '#rig', optionClass: 'sl-opt', active: BUILT_IN_RIGS[0], apply: async () => false });

		pills()[2].click();
		await vi.waitFor(() => expect(pressed()).toBe('Classic'));
	});

	it('ignores a click on the rig already on stage', async () => {
		const apply = vi.fn().mockResolvedValue(true);
		buildRigPicker({ host: '#rig', optionClass: 'sl-opt', active: BUILT_IN_RIGS[0], apply });
		pills()[0].click();
		await Promise.resolve();
		expect(apply).not.toHaveBeenCalled();
	});

	it('locks every pill while a rig is loading, so a double-click cannot race two mounts', async () => {
		let release;
		const apply = vi.fn(() => new Promise((resolve) => { release = resolve; }));
		buildRigPicker({ host: '#rig', optionClass: 'sl-opt', active: BUILT_IN_RIGS[0], apply });

		pills()[1].click();
		await vi.waitFor(() => expect(pills()[0].disabled).toBe(true));
		pills()[2].click();
		release(true);
		await vi.waitFor(() => expect(pills()[0].disabled).toBe(false));
		expect(apply).toHaveBeenCalledTimes(1);
	});
});
