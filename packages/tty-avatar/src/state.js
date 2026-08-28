// The bridge between the running viewer and everything else on the machine.
//
// One directory (default ~/.three-ws/tty-avatar) holds two files:
//   state.json  the mood/caption a person or script set explicitly
//               (`tty-avatar mood happy`, `tty-avatar say "deploying"`)
//   event.json  the last raw hook payload an agent runtime delivered
//               (Claude Code hooks pipe their JSON here with a single `cat`)
// The viewer polls both by mtime and applies whichever changed most recently,
// so a hook never has to know about the viewer and the viewer never has to
// know about the hook runner. Zero startup cost on the hook side: the command
// installed into Claude Code is `cat > event.json`, not a Node process.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isMood } from './moods.js';

export function defaultStateDir() {
	return process.env.TTY_AVATAR_DIR || join(homedir(), '.three-ws', 'tty-avatar');
}

export function statePaths(dir = defaultStateDir()) {
	return { dir, state: join(dir, 'state.json'), event: join(dir, 'event.json') };
}

/**
 * Write an explicit mood and/or caption.
 * @param {{ mood?: string, say?: string, ttlMs?: number }} patch
 * @param {string} [dir]
 */
export async function writeState(patch, dir = defaultStateDir()) {
	const paths = statePaths(dir);
	await mkdir(paths.dir, { recursive: true });
	let prev = {};
	try { prev = JSON.parse(await readFile(paths.state, 'utf8')); } catch { prev = {}; }
	if (patch.mood !== undefined && !isMood(patch.mood)) {
		throw new Error(`unknown mood "${patch.mood}"`);
	}
	const next = {
		mood: patch.mood ?? prev.mood ?? 'idle',
		say: patch.say ?? (patch.mood !== undefined ? '' : prev.say ?? ''),
		until: patch.ttlMs ? Date.now() + patch.ttlMs : null,
		at: Date.now(),
	};
	await writeFile(paths.state, JSON.stringify(next));
	return next;
}

/**
 * Store a raw hook payload for the viewer to interpret.
 * @param {string} rawJson
 * @param {string} [dir]
 */
export async function writeEvent(rawJson, dir = defaultStateDir()) {
	const paths = statePaths(dir);
	await mkdir(paths.dir, { recursive: true });
	await writeFile(paths.event, rawJson);
}

/**
 * Map a Claude Code hook payload (https://docs.claude.com/en/docs/claude-code/hooks)
 * to a mood and a one-line caption. Unknown events return null so the viewer
 * keeps its current mood. Transient moods carry a ttl so the avatar settles
 * back to idle on its own.
 *
 * @param {object} ev
 * @returns {{ mood: string, say: string, ttlMs: number|null } | null}
 */
export function moodForHookEvent(ev) {
	if (!ev || typeof ev !== 'object') return null;
	const name = ev.hook_event_name;
	const tool = typeof ev.tool_name === 'string' ? ev.tool_name : '';
	switch (name) {
		case 'SessionStart':
			return { mood: 'happy', say: 'session started', ttlMs: 2500 };
		case 'UserPromptSubmit':
			return { mood: 'think', say: 'reading your prompt', ttlMs: null };
		case 'PreToolUse':
			return { mood: 'work', say: describeTool(tool, ev.tool_input), ttlMs: null };
		case 'PostToolUse': {
			const failed = looksFailed(ev.tool_response);
			return failed
				? { mood: 'error', say: `${tool || 'tool'} failed`, ttlMs: 2500 }
				: { mood: 'think', say: `${tool || 'tool'} done`, ttlMs: null };
		}
		case 'PostToolUseFailure':
			return { mood: 'error', say: `${tool || 'tool'} failed`, ttlMs: 2500 };
		case 'Notification':
			return { mood: 'attention', say: shorten(ev.message || 'needs your input'), ttlMs: 30_000 };
		case 'Stop':
		case 'SubagentStop':
			return { mood: 'happy', say: 'done', ttlMs: 4000 };
		case 'PreCompact':
			return { mood: 'think', say: 'compacting memory', ttlMs: 4000 };
		case 'SessionEnd':
			return { mood: 'sleep', say: 'session ended', ttlMs: null };
		default:
			return null;
	}
}

function looksFailed(resp) {
	if (!resp) return false;
	if (typeof resp === 'string') return /\b(error|failed|exception)\b/i.test(resp.slice(0, 200));
	if (typeof resp === 'object') {
		if (resp.success === false || resp.is_error === true || resp.isError === true) return true;
		if (typeof resp.error === 'string' && resp.error) return true;
	}
	return false;
}

function describeTool(tool, input) {
	if (!tool) return 'working';
	const i = input && typeof input === 'object' ? input : {};
	const file = typeof i.file_path === 'string' ? i.file_path.split('/').slice(-1)[0] : '';
	switch (tool) {
		case 'Read': return file ? `reading ${file}` : 'reading';
		case 'Edit':
		case 'Write':
		case 'MultiEdit': return file ? `editing ${file}` : 'editing';
		case 'Bash': return typeof i.command === 'string' ? shorten(`$ ${i.command}`) : 'running a command';
		case 'Grep':
		case 'Glob': return 'searching';
		case 'WebFetch':
		case 'WebSearch': return 'browsing';
		case 'Agent':
		case 'Task': return 'delegating';
		default: return shorten(tool.replace(/^mcp__/, ''));
	}
}

function shorten(s, n = 56) {
	const one = String(s).replace(/\s+/g, ' ').trim();
	return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/**
 * Poll both files and return the newest instruction since `sinceMs`, or null.
 * @param {string} dir
 * @param {number} sinceMs
 */
export async function pollState(dir, sinceMs) {
	const paths = statePaths(dir);
	const [s, e] = await Promise.all([mtime(paths.state), mtime(paths.event)]);
	const newest = Math.max(s, e);
	if (newest <= sinceMs) return null;
	try {
		if (e >= s) {
			const ev = JSON.parse(await readFile(paths.event, 'utf8'));
			const mapped = moodForHookEvent(ev);
			return mapped ? { ...mapped, at: newest, source: 'hook' } : { at: newest, source: 'hook', mood: null };
		}
		const st = JSON.parse(await readFile(paths.state, 'utf8'));
		return {
			mood: st.mood,
			say: st.say || '',
			ttlMs: st.until ? Math.max(0, st.until - Date.now()) : null,
			at: newest,
			source: 'state',
		};
	} catch {
		// A partially written file (the writer is mid-`cat`) parses on the next tick.
		return null;
	}
}

async function mtime(p) {
	try { return (await stat(p)).mtimeMs; } catch { return 0; }
}
