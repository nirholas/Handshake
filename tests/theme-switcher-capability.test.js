// @vitest-environment jsdom
//
// Regression guard for the theme switcher's light-capability probe.
//
// The platform is dark-first, so public/theme-switcher.js probes whether the
// current page honours the light palette (does <body> go light when
// data-theme='light'?) and pins the page dark when it does not. That probe used
// to memoise its verdict on the very first call, which runs while the module
// boots.
//
// Most pages get their light palette from public/tokens.css, which arrives
// through nav.css's @import behind an asynchronously injected <link>: two extra
// round trips after that first probe. Reading the page's own dark --bg before
// the token sheet lands therefore cached "this page is a dark island" for the
// whole visit, and a user with light saved was served dark on roughly a third
// of loads of /create/prompt (measured 2026-08-25).
//
// These tests pin the fix: a not-capable verdict stays provisional until a
// stylesheet actually lands, and the page flips to the user's chosen theme the
// moment one does.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(resolve(process.cwd(), 'public/theme-switcher.js'), 'utf8');

// jsdom does not apply stylesheets, so the "does the body go light?" probe is
// driven directly: bodyBg() is what getComputedStyle would report, and the test
// flips it when the token sheet "arrives".
let bodyBg;

function boot() {
	Object.defineProperty(window, 'getComputedStyle', {
		configurable: true,
		writable: true,
		value: (el) => (el === document.body ? { backgroundColor: bodyBg() } : { backgroundColor: 'rgba(0, 0, 0, 0)' }),
	});
	// eslint-disable-next-line no-new-func
	new Function(SOURCE)();
}

function addStylesheet() {
	const link = document.createElement('link');
	link.rel = 'stylesheet';
	link.href = '/nav.css';
	document.head.appendChild(link);
	return link;
}

beforeEach(() => {
	document.documentElement.innerHTML = '<head></head><body></body>';
	document.documentElement.setAttribute('data-theme', 'light');
	localStorage.setItem('twx_theme', 'light');
	delete window.threeTheme;
});

afterEach(() => {
	localStorage.clear();
	delete window.threeTheme;
});

describe('theme switcher light-capability probe', () => {
	it('pins a page dark while its body still reads dark', () => {
		bodyBg = () => 'rgb(0, 0, 0)';
		boot();
		expect(window.threeTheme.supportsLight()).toBe(false);
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
	});

	it('does not freeze that verdict: a stylesheet landing later flips the page to light', async () => {
		bodyBg = () => 'rgb(0, 0, 0)';
		const link = addStylesheet();
		boot();
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

		// tokens.css resolves behind nav.css and the body turns light.
		bodyBg = () => 'rgb(255, 255, 255)';
		link.dispatchEvent(new Event('load'));

		expect(window.threeTheme.supportsLight()).toBe(true);
		expect(document.documentElement.getAttribute('data-theme')).toBe('light');
	});

	it('picks up a stylesheet that is injected after boot, not just one already in the head', async () => {
		bodyBg = () => 'rgb(0, 0, 0)';
		boot();
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

		// nav.js injects its <link> asynchronously, well after this module ran.
		const link = addStylesheet();
		await new Promise((r) => setTimeout(r, 0));
		bodyBg = () => 'rgb(255, 255, 255)';
		link.dispatchEvent(new Event('load'));

		expect(document.documentElement.getAttribute('data-theme')).toBe('light');
	});

	it('keeps a capable page on the theme the user chose', () => {
		bodyBg = () => 'rgb(255, 255, 255)';
		boot();
		expect(window.threeTheme.supportsLight()).toBe(true);
		expect(document.documentElement.getAttribute('data-theme')).toBe('light');
	});

	it('suspends colour transitions for the whole probe and leaves nothing behind', () => {
		// The probe flips data-theme to light and back inside one JS turn. Without
		// a transition suspension the forced recalc arms a colour transition that
		// starts FROM the light palette on every element with a `transition:
		// color` (the shared nav), and the sheet watch re-arms it on each DOM
		// mutation, so the nav sat at the light grey over the dark bar (3:1) for
		// seconds on a cold load. jsdom has no adoptedStyleSheets, so this drives
		// the <style> fallback: the suspension must be in place at the moment the
		// body is read, and gone once the probe returns.
		let suspendedDuringRead = null;
		bodyBg = () => {
			suspendedDuringRead = document.querySelector('style[data-twx-theme-probe]') !== null;
			return 'rgb(255, 255, 255)';
		};
		boot();
		expect(window.threeTheme.supportsLight()).toBe(true);
		expect(suspendedDuringRead).toBe(true);
		expect(document.querySelector('style[data-twx-theme-probe]')).toBeNull();
		expect(document.documentElement.getAttribute('data-theme')).toBe('light');
	});

	it('does not let its own probe stylesheet re-trigger the sheet watch', async () => {
		// A dark island keeps a MutationObserver alive to re-probe when a sheet
		// lands. The probe's fallback <style> is itself a childList mutation; if
		// the watch reacted to it, every probe would schedule another probe and
		// the page would never stop re-probing.
		let probes = 0;
		bodyBg = () => {
			probes += 1;
			return 'rgb(0, 0, 0)';
		};
		boot();
		const afterBoot = probes;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(probes).toBe(afterBoot);
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
	});

	it('still honours an explicit dark preference on a light-capable page', () => {
		localStorage.setItem('twx_theme', 'dark');
		bodyBg = () => 'rgb(255, 255, 255)';
		boot();
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
	});
});
