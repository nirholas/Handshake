// @vitest-environment jsdom
//
// The /play Controls reference is the only place a player is ever told what the
// keys do, and event traffic is almost entirely first-timers arriving from one
// shared link. Before this test the panel had drifted badly out of sync with
// _bindInput(): it advertised bindings that no longer existed and omitted most
// of the ones that did (camera, friends, emote wheel, attack, zen, photo mode,
// avatar, prop rotation), and the touch list never mentioned that tapping a
// vehicle drives it or that holding breaks a block.
//
// A wrong control is worse than a missing one, because the player trusts it and
// it silently does nothing. So this test reads the real key handler out of
// coincommunities.js and asserts the panel covers it, which means the next
// binding added there fails here instead of quietly going undocumented.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PlayOnboard } from '../src/game/play-onboard.js';

// import.meta.url is not a file: URL under the jsdom environment, so resolve
// from the repo root (vitest's cwd) instead.
const source = readFileSync(resolve(process.cwd(), 'src/game/coincommunities.js'), 'utf8');

const COIN = { mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump', name: 'three.ws', symbol: 'three' };

// Read the panel the way a player sees it: the <kbd> chips and their captions.
function readPanel() {
	const panel = document.querySelector('#po-help');
	if (!panel) return null;
	const keys = [...panel.querySelectorAll('.po-kbd')].map((k) => k.textContent);
	const groups = [...panel.querySelectorAll('.po-ctrl-group')].map((g) => g.textContent);
	return { keys, groups, text: panel.textContent };
}

function openPanel() {
	const ob = new PlayOnboard({ coin: COIN });
	document.querySelector('.po-ctrl-btn').click();
	return ob;
}

// Every `k === '<letter>'` branch in _bindInput() is a real, reachable binding.
function handledKeys() {
	return [...new Set([...source.matchAll(/k === '([a-z])'/g)].map((m) => m[1]))];
}

beforeEach(() => {
	document.body.innerHTML = '';
	try { localStorage.clear(); } catch { /* jsdom without storage */ }
});

describe('/play controls reference', () => {
	it('opens from the always-visible strip', () => {
		expect(document.querySelector('#po-help')).toBeNull();
		openPanel();
		expect(document.querySelector('#po-help')).not.toBeNull();
	});

	it('documents every single-key binding the world actually handles', () => {
		openPanel();
		const listed = readPanel().keys.join(' ').toLowerCase();

		const handled = handledKeys();
		expect(handled.length).toBeGreaterThan(6); // the regex still matches the handler

		const missing = handled.filter((k) => !listed.includes(k));
		expect(missing, `handled in _bindInput() but absent from the Controls panel: ${missing.join(', ')}`).toEqual([]);
	});

	it('never advertises a binding the world does not handle', () => {
		openPanel();
		// Single-letter chips only; multi-key chips (W A S D, Ctrl/⌘ + Z) are
		// combinations covered by the branches above.
		const singles = readPanel().keys.filter((k) => /^[A-Za-z]$/.test(k)).map((k) => k.toLowerCase());
		const handled = new Set(handledKeys());

		const phantom = singles.filter((k) => !handled.has(k));
		expect(phantom, `advertised to players but not handled in _bindInput(): ${phantom.join(', ')}`).toEqual([]);
	});

	it('groups the full reference so it stays scannable', () => {
		openPanel();
		const { groups, keys } = readPanel();

		expect(groups).toContain('Move');
		expect(groups).toContain('Build');
		expect(groups.length).toBeGreaterThanOrEqual(4);
		// Grouping only earns its keep because the list is genuinely long.
		expect(keys.length).toBeGreaterThan(15);
	});

	it('covers the capabilities a player cannot discover on their own', () => {
		openPanel();
		const text = readPanel().text.toLowerCase();

		// Each of these is real and has no obvious on-screen affordance, so the
		// reference is the only place it is ever surfaced.
		for (const phrase of ['emote', 'zen', 'photo', 'friends', 'camera', 'avatar']) {
			expect(text, `Controls panel never mentions "${phrase}"`).toContain(phrase);
		}
	});
});
