// /play deep-link hardening: the entry URL
// (/play?coin=<mint>&name=&symbol=&image=) is a link strangers share, so every
// part of it is untrusted text. Three defences are covered here, each of which
// failed in a real audit of the live surface:
//
//   1. cssBgImage(): a coin image lands inside a CSS `url("…")`, so a
//                          crafted value must not be able to close the
//                          declaration and paint its own full-screen overlay.
//   2. isPlausibleMint(): a malformed mint used to build a complete, convincing
//                          world keyed on garbage instead of saying the link was
//                          broken.
//   3. clampParam(): name/symbol are display-only and must be stripped of
//                          control characters and cut to the room server's caps.
//
// The three helpers are module-private (they guard call sites inside very large
// browser modules that cannot be imported under node), so they are re-derived
// here from their source text and exercised directly. The source strings below
// are asserted against the shipping files, so a change to either implementation
// fails this test instead of silently drifting away from it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// Pull a named function's source out of a module and evaluate it in isolation.
function extractFn(source, name) {
	const start = source.indexOf(`function ${name}(`);
	if (start === -1) throw new Error(`${name}() is no longer defined; update this test with the code that replaced it`);
	// Brace-match to the end of the declaration.
	let depth = 0, i = source.indexOf('{', start);
	const from = i;
	for (; i < source.length; i++) {
		if (source[i] === '{') depth++;
		else if (source[i] === '}' && --depth === 0) break;
	}
	return source.slice(start, i + 1);
}

const uiSrc = read('../src/game/coincommunities-ui.js');
const ccSrc = read('../src/game/coincommunities.js');

// eslint-disable-next-line no-new-func
const cssBgImage = new Function(`${extractFn(uiSrc, 'cssBgImage')}; return cssBgImage;`)();
// eslint-disable-next-line no-new-func
const clampParam = new Function(`${extractFn(ccSrc, 'clampParam')}; return clampParam;`)();
const isPlausibleMint = new Function(
	`${ccSrc.match(/const SOLANA_MINT_RE = .*/)[0]}
	 ${ccSrc.match(/const EVM_ADDRESS_RE = .*/)[0]}
	 ${extractFn(ccSrc, 'isPlausibleMint')}
	 return isPlausibleMint;`,
)();

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

describe('cssBgImage: a coin image cannot break out of the CSS declaration', () => {
	it('keeps an ordinary proxied image URL usable', () => {
		const out = cssBgImage(`/api/img?url=https%3A%2F%2Fipfs.io%2Fipfs%2Fbafy&seed=${THREE_MINT}`);
		expect(out).toContain('background-image:url("');
		expect(out).toContain('/api/img');
	});

	it('neutralises a declaration-escape payload', async () => {
		// The live attack shape: close the url() and the declaration, then paint a
		// fixed full-viewport overlay over everyone's lobby.
		const evil = 'x");position:fixed;inset:0;z-index:99999;background:#000 url(//evil/phish.png);content:"';
		const out = cssBgImage(evil);
		// Nothing that could terminate the url() or the declaration survives; the
		// payload is still *present*, but only ever as inert text inside one URL.
		expect(out.startsWith('background-image:url("')).toBe(true);
		expect(out.endsWith('")')).toBe(true);
		expect(out.slice('background-image:url("'.length, -2)).not.toMatch(/["'()\s<>]/);

		// The claim that matters is what a real CSS parser does with it: setting the
		// style must produce exactly one declaration (background-image) and none of
		// the properties the payload was trying to smuggle in.
		const { JSDOM } = await import('jsdom');
		const { document } = new JSDOM('').window;
		const node = document.createElement('div');
		node.setAttribute('style', out);
		expect(node.style.getPropertyValue('position')).toBe('');
		expect(node.style.getPropertyValue('inset')).toBe('');
		expect(node.style.getPropertyValue('z-index')).toBe('');
		expect(node.style.getPropertyValue('content')).toBe('');
		expect(node.style.getPropertyValue('background-image')).not.toBe('');
	});

	it('refuses script-bearing schemes outright', () => {
		for (const url of ['javascript:alert(1)', 'JavaScript:alert(1)', '  vbscript:msgbox', 'data:text/html,<script>']) {
			expect(cssBgImage(url)).toBe('');
		}
	});

	it('returns an empty style for an absent image rather than a broken rule', () => {
		for (const v of ['', null, undefined, 0, {}]) expect(cssBgImage(v)).toBe('');
	});
});

describe('isPlausibleMint: only a real address opens a world', () => {
	it('accepts the $THREE mint and other Solana base58 mints', () => {
		expect(isPlausibleMint(THREE_MINT)).toBe(true);
		expect(isPlausibleMint('So11111111111111111111111111111111111111112')).toBe(true);
	});

	it('accepts an EVM address (Robinhood Chain coins)', () => {
		expect(isPlausibleMint('0x' + 'aF'.repeat(20))).toBe(true);
	});

	it('rejects the shapes that used to build a phantom world', () => {
		for (const bad of ['notarealmint', ' ', '', 'x'.repeat(200), '0x123', 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpum0']) {
			// The last case carries a base58-illegal '0'; every other case is too
			// short, too long, or empty.
			expect(isPlausibleMint(bad)).toBe(false);
		}
	});

	it('ignores surrounding whitespace from a mangled share link', () => {
		expect(isPlausibleMint(`  ${THREE_MINT}  `)).toBe(true);
	});
});

describe('clampParam: name and symbol are display-only text', () => {
	it('strips control characters and line breaks that would rewrap the HUD', () => {
		expect(clampParam('three\n\r\t.ws', 48)).toBe('three .ws');
		expect(clampParam('a\u0000b', 48)).toBe('a b');
	});

	it('strips bidi overrides and zero-width characters', () => {
		// Escaped rather than literal: a raw U+202E inside this file would reverse
		// the reading order of the test source itself.
		expect(clampParam('three\u202Ews\u200B', 48)).toBe('three ws');
	});

	it('cuts to the room server’s own caps', () => {
		expect(clampParam('n'.repeat(500), 48)).toHaveLength(48);
		expect(clampParam('s'.repeat(500), 16)).toHaveLength(16);
	});

	it('coerces a missing value to an empty string, never "undefined"', () => {
		expect(clampParam(undefined, 48)).toBe('');
		expect(clampParam(null, 16)).toBe('');
	});
});
