// The embed snippet is what a user pastes into their own site, so its shape is
// pinned here: the library URL, the SRI hash, and the element attribute that
// points at a bare GLB (body, not src).

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEmbedSnippet, readRelease, viewerUrl } from '../src/embed.js';

const MANIFEST = {
	latest: '1.5.2',
	channels: {
		'1.5.2': { integrity: { 'agent-3d.js': 'sha384-abc' }, immutable: true },
		latest: { tracks: '*' },
	},
};

test('the pinned release carries its version and hash', () => {
	assert.deepEqual(readRelease(MANIFEST), { channel: '1.5.2', integrity: 'sha384-abc' });
});

test('a manifest with no release falls back to the moving channel', () => {
	assert.deepEqual(readRelease({}), { channel: 'latest', integrity: null });
	assert.deepEqual(readRelease({ latest: '2.0.0' }), { channel: '2.0.0', integrity: null });
});

test('a pinned snippet loads the exact build with integrity', () => {
	const snippet = buildEmbedSnippet({
		src: 'https://three.ws/cdn/creations/abc/mesh.glb',
		origin: 'https://three.ws',
		...readRelease(MANIFEST),
	});
	assert.match(snippet, /src="https:\/\/three\.ws\/agent-3d\/1\.5\.2\/agent-3d\.js"/);
	assert.match(snippet, /integrity="sha384-abc"/);
	assert.match(snippet, /crossorigin="anonymous"/);
	assert.match(snippet, /<agent-3d\n {2}body="https:\/\/three\.ws\/cdn\/creations\/abc\/mesh\.glb"/);
	assert.match(snippet, /width: 400px; height: 500px; display: block;/);
});

test('an unpinned snippet is a single script tag', () => {
	const snippet = buildEmbedSnippet({
		src: 'https://x/y.glb',
		origin: 'https://three.ws',
		channel: 'latest',
		integrity: null,
	});
	assert.match(snippet, /^<script type="module" src="https:\/\/three\.ws\/agent-3d\/latest\/agent-3d\.js"><\/script>$/m);
	assert.doesNotMatch(snippet, /integrity/);
});

test('a model that is not on http(s) cannot be embedded', () => {
	assert.throws(
		() => buildEmbedSnippet({ src: '/models/local.glb', origin: 'https://three.ws', channel: 'latest' }),
		/http\(s\) URL/,
	);
});

test('the hosted viewer link encodes the model URL', () => {
	assert.equal(
		viewerUrl('https://three.ws', 'https://x/y.glb'),
		'https://three.ws/viewer?src=https%3A%2F%2Fx%2Fy.glb',
	);
});
