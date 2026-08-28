#!/usr/bin/env node
// three-tty: render a 3D model in your terminal.
//
//   npx @three-ws/tty-3d ./avatar.glb
//   npx @three-ws/tty-3d https://three.ws/avatars/default.glb --spin 1.4
//   npx @three-ws/tty-3d model.glb --once --width 80 > frame.txt
//
// Reads a GLB, plays its animation, and draws it with half-block characters.
// No GPU, no browser, no display server.

import process from 'node:process';
import { loadModel, createRenderer, describeModel } from '../src/index.js';
import { ansi, detectColorMode, ColorMode } from '../src/term.js';

const ESC = '\x1b';

const USAGE = `three-tty: a 3D model in your terminal

Usage
  three-tty <model.glb | https://...> [options]

Options
  --width <n>        columns (default: terminal width, capped at 400)
  --height <n>       rows (default: terminal height minus 2)
  --fps <n>          frames per second (default 24)
  --spin <n>         turntable speed in radians per second (default 0.9, 0 to stop)
  --clip <name|n>    animation to play (default: the first one)
  --no-anim          hold the rest pose
  --once             draw a single frame and exit (pipe-friendly)
  --frames <n>       draw n frames and exit
  --time <s>         timestamp for --once (default 0)
  --pitch <r>        camera elevation in radians (default 0.08)
  --zoom <n>         1 fits the model, higher moves closer
  --color <mode>     truecolor | ansi256 | mono (default: detected)
  --transparent      leave the background unpainted
  --info             print what was loaded, then exit
  --help

Controls (interactive)
  left/right or a/d   orbit      up/down or w/s   tilt
  +/-                 zoom       space            pause
  q or Ctrl-C         quit
`;

function parseArgs(argv) {
	const opts = { _: [] };
	const takesValue = new Set(['width', 'height', 'fps', 'spin', 'clip', 'frames', 'time', 'pitch', 'zoom', 'color']);
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg.startsWith('--')) { opts._.push(arg); continue; }
		const key = arg.slice(2);
		if (takesValue.has(key)) { opts[key] = argv[i + 1]; i += 1; }
		else opts[key] = true;
	}
	return opts;
}

const num = (v, fallback) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
};

function fail(message) {
	process.stderr.write(`three-tty: ${message}\n`);
	process.exit(1);
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts._.length) {
	process.stdout.write(USAGE);
	process.exit(opts.help ? 0 : 1);
}

const source = opts._[0];
const isTTY = Boolean(process.stdout.isTTY);
// Piping to a file or another program must produce ONE frame, not an infinite
// animation. Getting this wrong fills a disk, so the non-interactive default is
// a single frame and animation has to be asked for explicitly with --frames.
const once = Boolean(opts.once) || (!isTTY && opts.frames === undefined);

const cols = Math.max(20, Math.min(num(opts.width, process.stdout.columns || 80), 400));
const rows = Math.max(10, Math.min(num(opts.height, (process.stdout.rows || 26) - 2), 200));

let model;
try {
	model = await loadModel(source);
} catch (err) {
	fail(`could not load ${source}: ${err.message}`);
}

if (opts.info) {
	process.stdout.write(JSON.stringify(describeModel(model), null, 2) + '\n');
	process.exit(0);
}

const colorMode = opts.color ?? detectColorMode();
if (!Object.values(ColorMode).includes(colorMode)) fail(`unknown color mode: ${colorMode}`);

const renderer = createRenderer(model, {
	width: cols,
	height: rows,
	animation: opts['no-anim'] ? false : (opts.clip ?? undefined),
	mode: colorMode,
	transparent: Boolean(opts.transparent),
	spin: num(opts.spin, 0.9),
	pitch: num(opts.pitch, 0.08),
	zoom: num(opts.zoom, 1),
});

if (once) {
	process.stdout.write(renderer.frame(num(opts.time, 0)) + '\n');
	process.exit(0);
}

const fps = Math.max(1, Math.min(num(opts.fps, 24), 60));
const totalFrames = opts.frames !== undefined ? Math.max(1, num(opts.frames, 1)) : Infinity;

let paused = false;
let time = num(opts.time, 0);
let drawn = 0;
let timer = null;

function restore() {
	if (timer) clearInterval(timer);
	if (isTTY) process.stdout.write(ansi.showCursor + '\n');
	if (process.stdin.isTTY) process.stdin.setRawMode(false);
	process.stdin.pause();
}

function quit(code = 0) {
	restore();
	process.exit(code);
}

if (isTTY) {
	process.stdout.write(ansi.hideCursor);
	// Reserve the rows up front, then only ever move the cursor back up. A
	// full-screen clear each frame flickers on most terminals; overdrawing in
	// place does not, and it leaves the scrollback intact when the program ends.
	process.stdout.write('\n'.repeat(renderer.height));
}

if (process.stdin.isTTY) {
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.setEncoding('utf8');
	process.stdin.on('data', (key) => {
		const o = renderer.orbit;
		if (key === 'q' || key === '') quit(0);
		else if (key === ' ') paused = !paused;
		else if (key === `${ESC}[C` || key === 'd') renderer.setOrbit({ yaw: o.yaw + 0.2 });
		else if (key === `${ESC}[D` || key === 'a') renderer.setOrbit({ yaw: o.yaw - 0.2 });
		else if (key === `${ESC}[A` || key === 'w') renderer.setOrbit({ pitch: o.pitch + 0.1 });
		else if (key === `${ESC}[B` || key === 's') renderer.setOrbit({ pitch: o.pitch - 0.1 });
		else if (key === '+' || key === '=') renderer.setOrbit({ zoom: o.zoom * 1.12 });
		else if (key === '-' || key === '_') renderer.setOrbit({ zoom: o.zoom / 1.12 });
	});
}

process.on('SIGINT', () => quit(0));
process.on('SIGTERM', () => quit(0));

timer = setInterval(() => {
	const text = renderer.frame(time);
	process.stdout.write((isTTY ? ansi.up(renderer.height) : '') + text + '\n');
	if (!paused) time += 1 / fps;
	drawn += 1;
	if (drawn >= totalFrames) quit(0);
}, Math.round(1000 / fps));
