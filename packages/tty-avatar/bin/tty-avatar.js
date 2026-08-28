#!/usr/bin/env node
// tty-avatar: a live 3D avatar in your terminal.
//
//   tty-avatar <source>                 run the viewer (file, URL, or three.ws id)
//   tty-avatar snapshot <source>        print one frame and exit
//   tty-avatar mood <name> [--say ..]   change the mood of the running viewer
//   tty-avatar say <text>               set the caption of the running viewer
//   tty-avatar hook                     stdin (a hook payload) → event file
//   tty-avatar install-hooks            wire Claude Code hooks to the viewer
//   tty-avatar moods                    list moods

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { parseGlb } from '../src/load.js';
import { resolveSource } from '../src/resolve.js';
import { TtyAvatar } from '../src/terminal.js';
import { MOODS, MOOD_NAMES, isMood } from '../src/moods.js';
import { defaultStateDir, writeEvent, writeState } from '../src/state.js';
import { claudeHooksConfig, installClaudeHooks } from '../src/hooks.js';
import { snapshot } from '../src/snapshot.js';

const { version } = createRequire(import.meta.url)('../package.json');

const HELP = `tty-avatar ${version}: a live 3D avatar in your terminal.

Usage
  tty-avatar <source> [options]         run the viewer
  tty-avatar snapshot <source> [opts]   print one frame and exit
  tty-avatar mood <name> [--say text]   set the running viewer's mood
  tty-avatar say <text>                 set the running viewer's caption
  tty-avatar hook                       pipe a hook payload (stdin) to the viewer
  tty-avatar install-hooks [--write]    Claude Code hooks → this viewer
  tty-avatar moods                      list the moods

Sources
  ./model.glb                           a local GLB
  https://…/model.glb                   a GLB URL
  81a076b6-55ff-49a2-b007-…             a three.ws avatar id
  agent:bd1b56b0-5494-47e2-…            a three.ws agent id (its 3D body)
  https://three.ws/avatars/<id>         a three.ws page URL

Options
  --mode blocks|braille|ascii   glyphs (default blocks; ascii when not a TTY)
  --mood <name>                 starting mood (default idle)
  --fps <n>                     frame rate (default 24)
  --columns <n> --rows <n>      override the terminal size
  --yaw <deg> --pitch <deg>     base rotation
  --zoom <x>                    1 fits the model; 1.4 fills a face
  --frames <n>                  exit after n frames (recording, CI)
  --no-caption                  hide the name/mood line
  --no-alt                      draw inline instead of on the alternate screen
  --max-triangles <n>           decimate above this many triangles (240000)
  --origin <url>                three.ws origin (default https://three.ws)
  --state-dir <dir>             where mood/hook files live (~/.three-ws/tty-avatar)
  --no-state                    ignore the state directory
  --say <text>                  caption (with mood, or as the initial caption)
  --ttl <ms>                    with mood: return to idle after this long
  --plain                       snapshot: strip colour
  --json                        install-hooks: print the settings fragment
`;

const options = {
	mode: { type: 'string' },
	mood: { type: 'string' },
	fps: { type: 'string' },
	columns: { type: 'string' },
	rows: { type: 'string' },
	yaw: { type: 'string' },
	pitch: { type: 'string' },
	zoom: { type: 'string' },
	frames: { type: 'string' },
	caption: { type: 'boolean', default: true },
	alt: { type: 'boolean', default: true },
	'max-triangles': { type: 'string' },
	origin: { type: 'string' },
	'state-dir': { type: 'string' },
	state: { type: 'boolean', default: true },
	say: { type: 'string' },
	ttl: { type: 'string' },
	plain: { type: 'boolean', default: false },
	json: { type: 'boolean', default: false },
	write: { type: 'boolean', default: false },
	settings: { type: 'string' },
	help: { type: 'boolean', short: 'h', default: false },
	version: { type: 'boolean', short: 'v', default: false },
};

let parsed;
try {
	parsed = parseArgs({ args: process.argv.slice(2), options, allowPositionals: true, allowNegative: true });
} catch (err) {
	fail(err.message);
}
const { values: flags, positionals } = parsed;

if (flags.version) { console.log(version); process.exit(0); }
if (flags.help || positionals.length === 0) { process.stdout.write(HELP); process.exit(flags.help ? 0 : 1); }

const num = (key, def) => (flags[key] === undefined ? def : Number(flags[key]));
const deg = (key) => (num(key, 0) * Math.PI) / 180;
const stateDir = flags.state ? (flags['state-dir'] || defaultStateDir()) : null;

const [command, ...rest] = positionals;
try {
	switch (command) {
		case 'moods':
			for (const name of MOOD_NAMES) console.log(`${name.padEnd(10)} ${MOODS[name].label}`);
			break;
		case 'mood': {
			const name = rest[0];
			if (!isMood(name)) fail(`unknown mood "${name || ''}"; one of ${MOOD_NAMES.join(', ')}`);
			const st = await writeState({ mood: name, say: flags.say, ttlMs: num('ttl', 0) || undefined }, stateDir || defaultStateDir());
			console.log(`${st.mood}${st.say ? ` · ${st.say}` : ''}`);
			break;
		}
		case 'say': {
			const text = rest.join(' ');
			if (!text) fail('say what? pass the caption text');
			await writeState({ say: text }, stateDir || defaultStateDir());
			console.log(text);
			break;
		}
		case 'hook': {
			const raw = readFileSync(0, 'utf8');
			await writeEvent(raw, stateDir || defaultStateDir());
			break;
		}
		case 'install-hooks': {
			if (flags.json) {
				console.log(JSON.stringify(claudeHooksConfig(stateDir || defaultStateDir()), null, 2));
				break;
			}
			if (!flags.write) {
				const cfg = claudeHooksConfig(stateDir || defaultStateDir());
				process.stdout.write(`Add this to ~/.claude/settings.json (or run again with --write):\n\n${JSON.stringify(cfg, null, 2)}\n`);
				break;
			}
			const { settingsPath, added } = await installClaudeHooks({ settingsPath: flags.settings, dir: stateDir || defaultStateDir() });
			console.log(`wired ${added.length} Claude Code hooks in ${settingsPath}`);
			console.log('start a viewer in another pane:  tty-avatar <avatar id>');
			break;
		}
		case 'snapshot': {
			const mesh = await loadMesh(rest[0]);
			let text = snapshot(mesh.mesh, {
				mode: flags.mode || (process.stdout.isTTY ? 'blocks' : 'ascii'),
				columns: num('columns', Math.min(process.stdout.columns || 80, 100)),
				rows: num('rows', Math.min((process.stdout.rows || 30) - 1, 45)),
				yaw: deg('yaw'),
				pitch: deg('pitch'),
				zoom: num('zoom', 1),
				mood: flags.mood,
			});
			if (flags.plain) text = text.replace(/\x1b\[[0-9;]*m/g, '');
			process.stdout.write(`${text}\n`);
			break;
		}
		default: {
			const { mesh, name } = await loadMesh(command);
			const viewer = new TtyAvatar(mesh, {
				name,
				mode: flags.mode || (process.stdout.isTTY ? 'blocks' : 'ascii'),
				mood: flags.mood,
				fps: num('fps', 24),
				columns: num('columns', 0) || undefined,
				rows: num('rows', 0) || undefined,
				yaw: deg('yaw'),
				zoom: num('zoom', 1),
				altScreen: flags.alt && process.stdout.isTTY,
				caption: flags.caption,
				stateDir,
			});
			if (flags.say) viewer.setCaption(flags.say);
			await viewer.start({ frames: num('frames', 0) || Infinity });
		}
	}
} catch (err) {
	fail(err.message);
}

async function loadMesh(source) {
	if (!source) fail('missing source (a .glb path, a URL, or a three.ws avatar/agent id)');
	const resolved = await resolveSource(source, { origin: flags.origin });
	const mesh = await parseGlb(resolved.bytes, { maxTriangles: num('max-triangles', 240_000) });
	if (mesh.count === 0) fail(`${resolved.name} has no triangles to draw`);
	return { mesh, name: resolved.name };
}

function fail(msg) {
	process.stderr.write(`tty-avatar: ${msg}\n`);
	process.exit(1);
}
