// Tool-surface invariants and behavior for @three-ws/assistant-mcp.
//
// Importing src/index.js is side-effect-free: the stdio transport only connects
// when the file is the process entry point, and buildServer() needs no key or
// signer. Both tools are pure and offline, so every test here runs without ever
// touching the network.
//
// Run: node --test packages/assistant-mcp/test/registration.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS, buildServer } from '../src/index.js';

const EXPECTED_TOOLS = ['build_assistant_widget', 'list_assistant_options'];

function tool(name) {
	const t = TOOLS.find((x) => x.name === name);
	assert.ok(t, `${name} must exist in the tool registry`);
	return t;
}

test('exactly the expected tools are registered', () => {
	assert.equal(TOOLS.length, 2);
	assert.deepEqual(new Set(TOOLS.map((t) => t.name)), new Set(EXPECTED_TOOLS));
});

test('every tool has a title, description, input schema and complete annotations', () => {
	for (const t of TOOLS) {
		assert.equal(typeof t.title, 'string', `${t.name} is missing a title`);
		assert.ok(t.title.length > 0, `${t.name} has an empty title`);
		assert.equal(typeof t.description, 'string', `${t.name} is missing a description`);
		assert.ok(t.inputSchema && typeof t.inputSchema === 'object', `${t.name} is missing inputSchema`);
		assert.equal(typeof t.handler, 'function', `${t.name} is missing a handler`);
		assert.ok(t.annotations, `${t.name} is missing MCP ToolAnnotations`);
		assert.equal(typeof t.annotations.readOnlyHint, 'boolean', `${t.name} must set readOnlyHint`);
		assert.equal(typeof t.annotations.idempotentHint, 'boolean', `${t.name} must set idempotentHint`);
		assert.equal(typeof t.annotations.openWorldHint, 'boolean', `${t.name} must set openWorldHint`);
	}
});

test('both tools are read-only, idempotent and closed-world (pure, offline)', () => {
	for (const name of EXPECTED_TOOLS) {
		const t = tool(name);
		assert.equal(t.annotations.readOnlyHint, true, `${name} should be read-only`);
		assert.equal(t.annotations.idempotentHint, true, `${name} should be idempotent`);
		assert.equal(t.annotations.openWorldHint, false, `${name} makes no network call`);
	}
});

test('build_assistant_widget declares it is non-destructive', () => {
	const build = tool('build_assistant_widget');
	assert.equal(build.annotations.destructiveHint, false);
});

test('buildServer registers every tool with its annotations, without a signer', () => {
	const server = buildServer();
	const registered = server._registeredTools;
	assert.ok(registered, 'McpServer should expose its tool registry');
	for (const t of TOOLS) {
		const entry = registered[t.name];
		assert.ok(entry, `${t.name} not registered on the server`);
		assert.deepEqual(entry.annotations, t.annotations, `${t.name} annotations must survive registration`);
	}
});

// --- Functional: build_assistant_widget -------------------------------------

test('build_assistant_widget emits the configured non-default data-* attributes', async () => {
	const build = tool('build_assistant_widget');
	const res = await build.handler({
		avatar: '/avatars/selfie-girl.glb',
		background: 'ocean',
		mode: 'chat',
		accent: '#00ffcc',
		position: 'left',
	});
	assert.equal(res.ok, true);
	assert.match(res.snippet, /^<script src="https:\/\/three\.ws\/assistant\/v1\.js" async /);
	assert.match(res.snippet, /data-avatar="\/avatars\/selfie-girl\.glb"/);
	assert.match(res.snippet, /data-bg="ocean"/);
	assert.match(res.snippet, /data-mode="chat"/);
	assert.match(res.snippet, /data-accent="#00ffcc"/);
	assert.match(res.snippet, /data-position="left"/);
	assert.ok(res.snippet.endsWith('></script>'));
	assert.equal(res.builder_url, 'https://three.ws/assistant');
	assert.ok(res.frame_url.startsWith('https://three.ws/assistant-frame?'));
	assert.match(res.js_api, /^ThreeAssistant\.init\(/);
});

test('build_assistant_widget omits default-valued fields from the snippet', async () => {
	const build = tool('build_assistant_widget');
	// Every value here is a default (or omitted), so the tag must carry no data-*.
	const res = await build.handler({ mode: 'both', position: 'right', accent: '#f97316', background: 'transparent' });
	assert.equal(res.snippet, '<script src="https://three.ws/assistant/v1.js" async></script>');
	assert.ok(!res.snippet.includes('data-'), 'no data-* attributes for an all-default config');
});

test('build_assistant_widget rejects a hostile background and falls back to transparent', async () => {
	const build = tool('build_assistant_widget');
	const res = await build.handler({ background: 'red;}body{display:none}' });
	// The malformed value must not be injected anywhere.
	assert.ok(!res.snippet.includes('body'), 'hostile CSS must not reach the snippet');
	assert.ok(!res.snippet.includes('data-bg'), 'transparent is the default, so no attribute is emitted');
	assert.equal(res.config.bg, 'transparent');
	assert.ok(!res.frame_url.includes('body'), 'hostile CSS must not reach the frame URL');
});

test('build_assistant_widget escapes double quotes in text values', async () => {
	const build = tool('build_assistant_widget');
	const res = await build.handler({ name: 'Ada "the guide" Lovelace' });
	assert.ok(res.snippet.includes('data-name="Ada &quot;the guide&quot; Lovelace"'));
	assert.ok(!res.snippet.includes('data-name="Ada "the'), 'a raw quote must never break the attribute');
});

test('build_assistant_widget emits voice/badge only when explicitly false', async () => {
	const build = tool('build_assistant_widget');
	const off = await build.handler({ voice: false, badge: false });
	assert.match(off.snippet, /data-voice="false"/);
	assert.match(off.snippet, /data-badge="false"/);

	const on = await build.handler({ voice: true, badge: true });
	assert.ok(!on.snippet.includes('data-voice'), 'voice on is the default, so no attribute');
	assert.ok(!on.snippet.includes('data-badge'), 'badge on is the default, so no attribute');

	const unset = await build.handler({});
	assert.ok(!unset.snippet.includes('data-voice'));
	assert.ok(!unset.snippet.includes('data-badge'));
});

test('build_assistant_widget normalizes a valid gradient and clamps a bad accent', async () => {
	const build = tool('build_assistant_widget');
	const res = await build.handler({ background: 'gradient:#AABBCC,#112233,160', accent: 'not-a-color' });
	assert.equal(res.config.bg, 'gradient:#aabbcc,#112233,160');
	assert.match(res.snippet, /data-bg="gradient:#aabbcc,#112233,160"/);
	// A non-hex accent falls back to the default and so is omitted from the tag.
	assert.equal(res.config.accent, '#f97316');
	assert.ok(!res.snippet.includes('data-accent'));
});

// --- Functional: list_assistant_options -------------------------------------

test('list_assistant_options returns the avatars, backgrounds and modes vocabulary', async () => {
	const list = tool('list_assistant_options');
	const res = await list.handler({});
	assert.equal(res.ok, true);

	assert.ok(Array.isArray(res.avatars.builtin), 'avatars.builtin is an array');
	assert.equal(res.avatars.builtin.length, 6);
	assert.deepEqual(res.avatars.builtin[0], { id: '', label: 'Default mannequin' });

	assert.deepEqual(res.backgrounds.presets, ['ember', 'ocean', 'violet', 'forest', 'dusk', 'slate']);
	assert.ok(res.backgrounds.also.includes('transparent'));

	assert.deepEqual(res.modes.map((m) => m.id), ['chat', 'speak', 'both']);
	for (const m of res.modes) assert.ok(typeof m.description === 'string' && m.description.length > 0);

	assert.deepEqual(res.chat_lanes.map((l) => l.id), ['free', 'byok-groq', 'byok-openrouter']);
	assert.ok(Array.isArray(res.attributes) && res.attributes.length > 0);
	assert.equal(res.docs_url, 'https://three.ws/docs/assistant-widget');
});

test('list_assistant_options can return a single filtered section', async () => {
	const list = tool('list_assistant_options');
	const res = await list.handler({ filter: 'modes' });
	assert.equal(res.ok, true);
	assert.ok(res.modes, 'the requested section is present');
	assert.ok(!res.avatars, 'other sections are omitted when a filter is given');
	assert.equal(res.docs_url, 'https://three.ws/docs/assistant-widget');
});
