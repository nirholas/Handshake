// Claude Code integration: hook config that pipes every hook payload into the
// viewer's event file. The installed command is `cat`, not Node, so it adds
// nothing measurable to a tool call. The viewer maps payload → mood itself
// (see moodForHookEvent in state.js).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultStateDir, statePaths } from './state.js';

export const HOOK_EVENTS = [
	'SessionStart',
	'UserPromptSubmit',
	'PreToolUse',
	'PostToolUse',
	'Notification',
	'Stop',
	'SubagentStop',
	'PreCompact',
	'SessionEnd',
];

const MARKER = 'three-ws-tty-avatar';

/**
 * The shell command a hook runs. POSIX: mkdir + cat. Anything else: the CLI's
 * own `hook` subcommand, which does the same thing in Node.
 * @param {string} [dir]
 */
export function hookCommand(dir = defaultStateDir()) {
	const { event } = statePaths(dir);
	if (process.platform === 'win32') return `npx --yes @three-ws/tty-avatar hook`;
	const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
	// The marker is a comment so `installClaudeHooks` can recognise its own entries later.
	return `mkdir -p ${q(dirname(event))} && cat > ${q(event)} # ${MARKER}`;
}

/**
 * The `hooks` object to merge into a Claude Code settings.json.
 * @param {string} [dir]
 */
export function claudeHooksConfig(dir = defaultStateDir()) {
	const command = hookCommand(dir);
	const hooks = {};
	for (const ev of HOOK_EVENTS) {
		hooks[ev] = [{ matcher: '', hooks: [{ type: 'command', command }] }];
	}
	return { hooks };
}

/**
 * Merge the hook config into a settings file (default ~/.claude/settings.json),
 * replacing any earlier tty-avatar entries and leaving every other hook alone.
 *
 * @param {{ settingsPath?: string, dir?: string }} [opts]
 * @returns {Promise<{ settingsPath: string, added: string[] }>}
 */
export async function installClaudeHooks({ settingsPath, dir } = {}) {
	const path = settingsPath || join(homedir(), '.claude', 'settings.json');
	let settings = {};
	try {
		settings = JSON.parse(await readFile(path, 'utf8'));
	} catch (err) {
		if (err.code !== 'ENOENT') throw new Error(`cannot parse ${path}: ${err.message}`);
	}
	const mine = claudeHooksConfig(dir).hooks;
	settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
	const added = [];
	for (const ev of HOOK_EVENTS) {
		const existing = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
		const kept = existing.filter((group) => !isMine(group));
		settings.hooks[ev] = [...kept, ...mine[ev]];
		added.push(ev);
	}
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);
	return { settingsPath: path, added };
}

function isMine(group) {
	const list = Array.isArray(group?.hooks) ? group.hooks : [];
	return list.some((h) => typeof h?.command === 'string' && (h.command.includes(MARKER) || h.command.includes('@three-ws/tty-avatar hook')));
}
