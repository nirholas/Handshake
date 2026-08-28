#!/usr/bin/env node
// three-ws-motion: compile a prompt or a Motion Score into an AnimationClip.
//
//   three-ws-motion "wave hello twice, excitedly" -o wave.json
//   three-ws-motion --score sit.json --no-idle -o sit.json
//   three-ws-motion --schema            print the score schema for a tool call
//   three-ws-motion --actions           list what the model-free lane knows
//
// The output is a three.js AnimationClip document. Load it with
// AnimationClip.parse() and play it on any humanoid, or hand it to the three.ws
// retargeter to run on a rig it was not authored for.

import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import {
	ACTION_NAMES,
	compileScore,
	describeScore,
	motionFromText,
	scoreSchema,
} from '../src/index.js';

const USAGE = `three-ws-motion: text or a Motion Score into an AnimationClip.

Usage
  three-ws-motion <prompt> [options]
  three-ws-motion --score <file.json> [options]
  three-ws-motion --schema | --actions

Options
  -o, --out <file>    write the clip here (default: stdout)
      --score <file>  compile a Motion Score instead of a prompt
      --name <name>   clip name (default: the prompt, or the score's name)
      --loop          close the last beat back into the first
      --effort <name> override the performance quality for every beat
      --no-idle       leave out the breathing and micro-sway layer
      --no-root       leave out the hip translation track, for a clip in place
      --no-fingers    leave out the finger bones
      --score-out <f> also write the Motion Score that produced the clip
      --quiet         no summary on stderr
      --schema        print the Motion Score JSON Schema and exit
      --actions       list the actions the model-free lane recognizes
  -h, --help          this
`;

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
	process.stdout.write(USAGE);
	process.exit(argv.length ? 0 : 1);
}

if (argv.includes('--schema')) {
	process.stdout.write(`${JSON.stringify(scoreSchema(), null, 2)}\n`);
	process.exit(0);
}

if (argv.includes('--actions')) {
	process.stdout.write(`${ACTION_NAMES.join('\n')}\n`);
	process.exit(0);
}

const opts = { idle: true, rootMotion: true, fingers: true, loop: false, quiet: false };
const words = [];
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	switch (arg) {
		case '-o': case '--out': opts.out = argv[++i]; break;
		case '--score': opts.scoreFile = argv[++i]; break;
		case '--score-out': opts.scoreOut = argv[++i]; break;
		case '--name': opts.name = argv[++i]; break;
		case '--effort': opts.effort = argv[++i]; break;
		case '--loop': opts.loop = true; break;
		case '--no-idle': opts.idle = false; break;
		case '--no-root': opts.rootMotion = false; break;
		case '--no-fingers': opts.fingers = false; break;
		case '--quiet': opts.quiet = true; break;
		default:
			if (arg.startsWith('-')) fail(`unknown option ${arg}`);
			words.push(arg);
	}
}

function fail(message) {
	process.stderr.write(`three-ws-motion: ${message}\n`);
	process.exit(2);
}

let result;
try {
	if (opts.scoreFile) {
		const raw = JSON.parse(await readFile(opts.scoreFile, 'utf8'));
		if (opts.loop) raw.loop = true;
		if (opts.effort) raw.effort = opts.effort;
		result = compileScore(raw, opts);
	} else {
		if (!words.length) fail('give a prompt, or --score <file>');
		result = motionFromText(words.join(' '), opts);
	}
} catch (err) {
	fail(err.message);
}

const json = `${JSON.stringify(result.clip, null, opts.out ? 0 : 2)}\n`;
if (opts.out) await writeFile(opts.out, json);
else process.stdout.write(json);

if (opts.scoreOut) await writeFile(opts.scoreOut, `${JSON.stringify(result.score, null, 2)}\n`);

if (!opts.quiet) {
	const where = opts.out ? ` -> ${opts.out}` : '';
	process.stderr.write(`${describeScore(result.score)}, ${result.clip.tracks.length} tracks${where}\n`);
	for (const warning of result.warnings) process.stderr.write(`  warning: ${warning}\n`);
}
