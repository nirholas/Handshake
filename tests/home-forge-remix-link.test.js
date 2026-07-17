// @vitest-environment jsdom
//
// The create → share → remix loop on the homepage forge (src/home-forge.js).
// `remixLinkFor` turns a prompt into a shareable link; `parseForgeIntent` reads
// that link back on arrival so the visitor lands mid-create. The round-trip is
// the load-bearing property: a link produced by one must be understood by the
// other, or the loop silently breaks.

import { describe, it, expect } from 'vitest';
import { remixLinkFor, parseForgeIntent } from '../src/home-forge.js';

describe('remixLinkFor', () => {
	it('builds a homepage link that carries the prompt and opts into auto-forge', () => {
		expect(remixLinkFor('a brass compass')).toBe('/?prompt=a%20brass%20compass&remix=1');
	});

	it('URL-encodes prompts with reserved characters', () => {
		expect(remixLinkFor('a fox & a hound, 50% chrome')).toBe(
			'/?prompt=a%20fox%20%26%20a%20hound%2C%2050%25%20chrome&remix=1',
		);
	});

	it('trims and clamps overlong prompts to 1000 chars', () => {
		const long = 'x'.repeat(1500);
		const link = remixLinkFor(`   ${long}   `);
		const value = new URLSearchParams(new URL(link, 'https://three.ws').search).get('prompt');
		expect(value).toHaveLength(1000);
	});

	it('degrades to the bare homepage for an empty prompt', () => {
		expect(remixLinkFor('')).toBe('/');
		expect(remixLinkFor('   ')).toBe('/');
		expect(remixLinkFor(null)).toBe('/');
	});
});

describe('parseForgeIntent', () => {
	it('prefills without auto-forging when only a prompt is present', () => {
		expect(parseForgeIntent('?prompt=a%20red%20fox')).toEqual({ prompt: 'a red fox', auto: false });
	});

	it('auto-forges when remix/forge/auto is set', () => {
		expect(parseForgeIntent('?prompt=a%20red%20fox&remix=1').auto).toBe(true);
		expect(parseForgeIntent('?prompt=a%20red%20fox&forge=1').auto).toBe(true);
		expect(parseForgeIntent('?prompt=a%20red%20fox&auto=true').auto).toBe(true);
		expect(parseForgeIntent('?prompt=a%20red%20fox&remix').auto).toBe(true); // bare flag
	});

	it('accepts the `p` alias for prompt', () => {
		expect(parseForgeIntent('?p=a%20teapot&remix=1')).toEqual({ prompt: 'a teapot', auto: true });
	});

	it('never auto-forges without a prompt, even with the flag', () => {
		expect(parseForgeIntent('?remix=1')).toEqual({ prompt: '', auto: false });
	});

	it('ignores a falsy flag value', () => {
		expect(parseForgeIntent('?prompt=x&remix=0').auto).toBe(false);
	});

	it('is null-safe on empty or malformed input', () => {
		expect(parseForgeIntent('')).toEqual({ prompt: '', auto: false });
		expect(parseForgeIntent(undefined)).toEqual({ prompt: '', auto: false });
	});

	it('closes the loop: a remix link round-trips to an auto-forge intent', () => {
		const prompt = 'a weathered brass compass, 50% patina';
		const link = remixLinkFor(prompt);
		const search = new URL(link, 'https://three.ws').search;
		expect(parseForgeIntent(search)).toEqual({ prompt, auto: true });
	});
});
