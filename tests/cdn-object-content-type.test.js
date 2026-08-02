// /cdn/<key> serves bucket objects from the three.ws origin, where the session
// cookie lives. These cover the rule that keeps that safe: the served type comes
// from the server-chosen extension, never from a stored header an upstream
// provider may have written, and anything that could render as a scripting
// document is not inline-safe.
import { describe, it, expect } from 'vitest';
import { contentTypeFor, isInlineSafe } from '../api/cdn-object.js';

describe('contentTypeFor', () => {
	it('derives the type from the extension', () => {
		expect(contentTypeFor('u/abc/model.glb')).toBe('model/gltf-binary');
		expect(contentTypeFor('thumb/abc.png')).toBe('image/png');
		expect(contentTypeFor('forge/abc.webp')).toBe('image/webp');
	});

	it('ignores a stored type that contradicts the extension', () => {
		expect(contentTypeFor('u/abc/model.glb', 'text/html')).toBe('model/gltf-binary');
		expect(contentTypeFor('thumb/abc.png', 'image/svg+xml')).toBe('image/png');
	});

	it('still upgrades objects stored as octet-stream', () => {
		expect(contentTypeFor('u/abc/model.glb', 'application/octet-stream')).toBe('model/gltf-binary');
	});

	it('falls back to octet-stream for an unknown extension with an unsafe stored type', () => {
		expect(contentTypeFor('legacy/blob.weird', 'text/html; charset=utf-8')).toBe('application/octet-stream');
		expect(contentTypeFor('legacy/blob', 'application/xhtml+xml')).toBe('application/octet-stream');
	});

	it('keeps a safe stored type when the extension says nothing', () => {
		expect(contentTypeFor('legacy/blob', 'image/png')).toBe('image/png');
	});
});

describe('isInlineSafe', () => {
	it('accepts the media types the product actually renders', () => {
		for (const type of ['image/png', 'model/gltf-binary', 'video/mp4', 'audio/mpeg', 'application/json']) {
			expect(isInlineSafe(type)).toBe(true);
		}
	});

	it('rejects anything that can execute script in a document context', () => {
		for (const type of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml']) {
			expect(isInlineSafe(type)).toBe(false);
		}
	});

	it('ignores parameters when matching', () => {
		expect(isInlineSafe('image/png; charset=binary')).toBe(true);
		expect(isInlineSafe('text/html; charset=utf-8')).toBe(false);
	});
});
