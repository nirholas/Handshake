import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { cubeGlb } from './_fixture.js';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/tty-avatar.js', import.meta.url));

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), 'tty-avatar-cli-'));
	const glb = join(dir, 'cube.glb');
	await writeFile(glb, await cubeGlb());
	return { dir, glb };
}

test('snapshot renders a local GLB to plain text', async () => {
	const { glb } = await fixture();
	const { stdout } = await run(process.execPath, [BIN, 'snapshot', glb, '--mode', 'ascii', '--columns', '40', '--rows', '20', '--yaw', '35', '--pitch', '20']);
	const lines = stdout.replace(/\n$/, '').split('\n');
	assert.equal(lines.length, 20);
	assert.ok(lines.some((l) => l.trim().length > 5), 'something was drawn');
	assert.ok(!stdout.includes('\x1b['), 'ascii mode has no escapes');
});

test('the viewer runs for N frames when stdout is a pipe and exits cleanly', async () => {
	const { dir, glb } = await fixture();
	const { stdout } = await run(process.execPath, [
		BIN, glb, '--frames', '3', '--fps', '30', '--columns', '30', '--rows', '12', '--state-dir', join(dir, 'state'),
	]);
	assert.ok(stdout.includes('\x1b[H'), 'redraws from the home position');
	assert.ok(stdout.includes('cube.glb'), 'caption names the model');
});

test('mood, say, and hook write the files the viewer polls', async () => {
	const { dir } = await fixture();
	const stateDir = join(dir, 'state');
	const { stdout: a } = await run(process.execPath, [BIN, 'mood', 'happy', '--say', 'deploy landed', '--state-dir', stateDir]);
	assert.equal(a.trim(), 'happy · deploy landed');
	const { stdout: b } = await run(process.execPath, [BIN, 'say', 'hello', 'there', '--state-dir', stateDir]);
	assert.equal(b.trim(), 'hello there');
	const child = execFile(process.execPath, [BIN, 'hook', '--state-dir', stateDir]);
	child.stdin.end(JSON.stringify({ hook_event_name: 'Stop' }));
	await new Promise((resolve, reject) => child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`)))));
	const { readFile } = await import('node:fs/promises');
	assert.equal(JSON.parse(await readFile(join(stateDir, 'event.json'), 'utf8')).hook_event_name, 'Stop');
	await assert.rejects(run(process.execPath, [BIN, 'mood', 'bogus', '--state-dir', stateDir]), /unknown mood/);
});

test('install-hooks --json prints a settings fragment; a bad source fails with a sentence', async () => {
	const { stdout } = await run(process.execPath, [BIN, 'install-hooks', '--json', '--state-dir', '/tmp/s']);
	const cfg = JSON.parse(stdout);
	assert.ok(cfg.hooks.PreToolUse[0].hooks[0].command.includes('event.json'));
	await assert.rejects(run(process.execPath, [BIN, 'snapshot', 'not-a-thing']), /not a file, a URL, or a three\.ws/);
});
