import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moodForHookEvent, pollState, writeEvent, writeState, statePaths } from '../src/state.js';
import { claudeHooksConfig, installClaudeHooks, HOOK_EVENTS, hookCommand } from '../src/hooks.js';

test('hook events map to moods with captions that name the work', () => {
	assert.deepEqual(
		moodForHookEvent({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/a/b/index.js' } }),
		{ mood: 'work', say: 'editing index.js', ttlMs: null },
	);
	assert.equal(moodForHookEvent({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }).say, '$ npm test');
	assert.equal(moodForHookEvent({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { success: false } }).mood, 'error');
	assert.equal(moodForHookEvent({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: 'ok' }).mood, 'think');
	assert.equal(moodForHookEvent({ hook_event_name: 'Notification', message: 'Claude needs your permission' }).mood, 'attention');
	assert.equal(moodForHookEvent({ hook_event_name: 'Stop' }).mood, 'happy');
	assert.equal(moodForHookEvent({ hook_event_name: 'SessionEnd' }).mood, 'sleep');
	assert.equal(moodForHookEvent({ hook_event_name: 'SomethingNew' }), null);
	assert.equal(moodForHookEvent('garbage'), null);
});

test('writeState / writeEvent round-trip through pollState, newest wins', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'tty-avatar-'));
	assert.equal(await pollState(dir, 0), null, 'nothing yet');
	const t0 = Date.now() - 1;
	const st = await writeState({ mood: 'happy', say: 'shipped', ttlMs: 5000 }, dir);
	assert.equal(st.mood, 'happy');
	const a = await pollState(dir, t0);
	assert.equal(a.source, 'state');
	assert.equal(a.mood, 'happy');
	assert.equal(a.say, 'shipped');
	assert.ok(a.ttlMs > 4000 && a.ttlMs <= 5000);
	assert.equal(await pollState(dir, a.at), null, 'nothing newer');

	await new Promise((r) => setTimeout(r, 15));
	await writeEvent(JSON.stringify({ hook_event_name: 'UserPromptSubmit' }), dir);
	const b = await pollState(dir, a.at);
	assert.equal(b.source, 'hook');
	assert.equal(b.mood, 'think');

	await new Promise((r) => setTimeout(r, 15));
	await writeFile(statePaths(dir).event, '{"hook_event_name": "PreToo', 'utf8');
	assert.equal(await pollState(dir, b.at), null, 'a half-written payload is skipped, not fatal');

	await assert.rejects(() => writeState({ mood: 'nope' }, dir), /unknown mood/);
});

test('claudeHooksConfig covers every event with the cat bridge', () => {
	const cfg = claudeHooksConfig('/tmp/x');
	assert.deepEqual(Object.keys(cfg.hooks), HOOK_EVENTS);
	for (const ev of HOOK_EVENTS) {
		const cmd = cfg.hooks[ev][0].hooks[0].command;
		assert.equal(cmd, hookCommand('/tmp/x'));
		if (process.platform !== 'win32') assert.match(cmd, /cat > '\/tmp\/x\/event\.json'/);
	}
});

test('installClaudeHooks merges into an existing settings file and is idempotent', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'tty-avatar-settings-'));
	const settingsPath = join(dir, 'settings.json');
	await writeFile(settingsPath, JSON.stringify({
		permissions: { allow: ['Bash(npm test)'] },
		hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo keep-me' }] }] },
	}));
	await installClaudeHooks({ settingsPath, dir: '/tmp/state' });
	await installClaudeHooks({ settingsPath, dir: '/tmp/state' });
	const out = JSON.parse(await readFile(settingsPath, 'utf8'));
	assert.deepEqual(out.permissions, { allow: ['Bash(npm test)'] }, 'unrelated settings survive');
	assert.equal(out.hooks.PreToolUse.length, 2, 'one foreign group + one of ours, not duplicated');
	assert.equal(out.hooks.PreToolUse[0].hooks[0].command, 'echo keep-me');
	assert.equal(out.hooks.Stop.length, 1);
});
