// src/shared/image-url.js: remote artwork goes through the same-origin resize
// proxy; local, data: and blob: sources are returned untouched.
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { resizedImageUrl } from '../src/shared/image-url.js';

describe('resizedImageUrl', () => {
	it('routes a remote https image through /api/img with the requested width', () => {
		const out = resizedImageUrl('https://pub-example.r2.dev/forge/a/b.png', 480);
		const u = new URL(out, 'http://localhost');
		expect(u.pathname).toBe('/api/img');
		expect(u.searchParams.get('url')).toBe('https://pub-example.r2.dev/forge/a/b.png');
		expect(u.searchParams.get('w')).toBe('480');
	});
	it('rounds a fractional width and omits w when no width is given', () => {
		expect(new URL(resizedImageUrl('https://cdn.example/x.jpg', 239.6), 'http://l').searchParams.get('w')).toBe('240');
		expect(new URL(resizedImageUrl('https://cdn.example/x.jpg'), 'http://l').searchParams.has('w')).toBe(false);
	});
	it('leaves same-origin, relative, data: and blob: sources untouched', () => {
		const same = `${location.origin}/thumb/abc.png`;
		expect(resizedImageUrl(same, 480)).toBe(same);
		expect(resizedImageUrl('/avatars/default.png', 480)).toBe('/avatars/default.png');
		expect(resizedImageUrl('data:image/png;base64,AAAA', 480)).toBe('data:image/png;base64,AAAA');
		expect(resizedImageUrl('blob:http://localhost/1234', 480)).toBe('blob:http://localhost/1234');
	});
	it('passes through empty and non-string inputs', () => {
		expect(resizedImageUrl('', 480)).toBe('');
		expect(resizedImageUrl(null, 480)).toBe(null);
		expect(resizedImageUrl(undefined, 480)).toBe(undefined);
	});
});
