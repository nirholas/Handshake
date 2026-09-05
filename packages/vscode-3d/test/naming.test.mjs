// File naming. A generated model lands next to the user's own files, so the name
// has to be readable, safe on every platform, and never silently overwrite.

import test from 'node:test';
import assert from 'node:assert/strict';
import { slugFromPrompt, slugFromUrl, uniqueName, formatBytes } from '../src/naming.js';

test('a prompt becomes a readable stem', () => {
	assert.equal(slugFromPrompt('A friendly round robot mascot'), 'a-friendly-round-robot-mascot');
	assert.equal(slugFromPrompt('  Spaced   out  '), 'spaced-out');
});

test('accents, punctuation, and path separators are stripped', () => {
	assert.equal(slugFromPrompt('Café Zürich naïve'), 'cafe-zurich-naive');
	assert.equal(slugFromPrompt('../../etc/passwd'), 'etc-passwd');
	assert.equal(slugFromPrompt('emoji 🐸 frog'), 'emoji-frog');
});

test('an empty or unusable prompt falls back', () => {
	assert.equal(slugFromPrompt(''), 'model');
	assert.equal(slugFromPrompt('***'), 'model');
	assert.equal(slugFromPrompt('', 'avatar'), 'avatar');
});

test('a long prompt is truncated without a trailing dash', () => {
	const stem = slugFromPrompt('a'.repeat(20) + ' ' + 'b'.repeat(40));
	assert.ok(stem.length <= 48);
	assert.doesNotMatch(stem, /-$/);
});

test('a URL contributes its file stem', () => {
	assert.equal(slugFromUrl('https://x/forge/anon/abc123.glb'), 'abc123');
	assert.equal(slugFromUrl('not a url'), 'model');
});

test('names never collide with what is already on disk', () => {
	const taken = new Set(['robot.glb', 'robot-2.glb']);
	assert.equal(uniqueName('robot', '.glb', (n) => taken.has(n)), 'robot-3.glb');
	assert.equal(uniqueName('frog', '.glb', () => false), 'frog.glb');
});

test('sizes read the way the viewer reports them', () => {
	assert.equal(formatBytes(512), '512 B');
	assert.equal(formatBytes(2048), '2.0 KB');
	assert.equal(formatBytes(2_500_000), '2.4 MB');
	assert.equal(formatBytes(undefined), '0 B');
});
