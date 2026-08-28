#!/usr/bin/env node
/**
 * three-ws-tty: render a 3D avatar without a GPU, from a terminal.
 *
 *   npx @three-ws/render model.glb                     draw it in the terminal
 *   npx @three-ws/render model.glb --out avatar.png    write a still
 *   npx @three-ws/render model.glb --clip walk --frames 24 --out walk.png
 *   npx @three-ws/render https://three.ws/avatars/default.glb --spin 360
 *
 * With `--out` it writes a PNG (or an animated PNG when frames > 1). Without
 * one it draws into the terminal: a real image on Kitty, Ghostty, WezTerm and
 * iTerm2, and truecolor half-blocks everywhere else.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { AvatarModel } from '../src/model.js';
import { loadModel } from '../src/load.js';
import { parseClipJson } from '../src/clips.js';
import { renderFrame, renderFrames } from '../src/render.js';
import { encodePng, encodeApng } from '../src/encode.js';
import { toHalfBlocks, toKitty, toITerm, detectTerminal, CURSOR } from '../src/ansi.js';

const USAGE = `three-ws-tty <model.glb | url> [options]

  --out <file>        write a PNG (animated PNG when --frames > 1)
  --width <n>         output width in pixels (default: fits the terminal)
  --height <n>        output height in pixels
  --focus <mode>      full | bust | head            (default: full)
  --preset <name>     studio | terminal | daylight  (default: terminal for tty)
  --clip <name|idx>   clip to play, from the model or --animation
  --animation <file>  GLB or clip JSON to retarget onto this rig
  --frames <n>        frame count                   (default: 1, or 36 with --spin)
  --fps <n>           frames per second             (default: 20)
  --spin <deg>        turntable degrees across the loop
  --yaw <deg>         camera yaw                    (default: 26)
  --pitch <deg>       camera pitch                  (default: 6)
  --bg <color>        hex colour or 'transparent'
  --loop              keep animating in the terminal until interrupted
  --blocks            force half-blocks even where inline images work
  --clips             list the model's clips and exit
  --help              this text
`;

function parseArgs(argv) {
	const args = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token.startsWith('--')) {
			args._.push(token);
			continue;
		}
		const key = token.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) {
			args[key] = true;
		} else {
			args[key] = next;
			i++;
		}
	}
	return args;
}

const num = (value, fallback) => {
	const n = Number.parseFloat(value);
	return Number.isFinite(n) ? n : fallback;
};

function fail(message) {
	process.stderr.write(`three-ws-tty: ${message}\n`);
	process.exit(1);
}

async function loadAnimation(model, source) {
	if (/\.json$/i.test(source)) {
		const raw = await fs.readFile(source, 'utf8');
		return model.addClips([parseClipJson(raw)]);
	}
	const extra = await loadModel(source, { textures: false });
	return model.addClips(extra.animations);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || args._.length === 0) {
		process.stdout.write(USAGE);
		process.exit(args.help ? 0 : 1);
	}

	const source = args._[0];
	const term = detectTerminal();
	const writingFile = typeof args.out === 'string';

	// A terminal cell is about twice as tall as it is wide, and half-blocks give
	// back two pixels per cell, so a square render maps to columns x columns.
	const fitted = Math.max(24, Math.min(160, term.columns - 2));
	const width = Math.round(num(args.width, writingFile ? 512 : fitted));
	const height = Math.round(num(args.height, width));

	let model;
	try {
		model = await AvatarModel.load(source);
	} catch (err) {
		fail(err?.message || String(err));
	}

	if (args.animation) {
		try {
			await loadAnimation(model, String(args.animation));
		} catch (err) {
			fail(`could not load --animation: ${err?.message || err}`);
		}
	}

	if (args.clips) {
		const names = model.clipNames;
		process.stdout.write(names.length ? `${names.join('\n')}\n` : 'no clips in this model\n');
		return;
	}

	const spin = num(args.spin, 0);
	const explicitFrames = args.frames !== undefined;
	const frames = Math.max(1, Math.round(num(args.frames, spin || args.clip || args.loop ? 36 : 1)));
	const fps = Math.max(1, Math.round(num(args.fps, 20)));
	const options = {
		width,
		height,
		supersample: writingFile ? 2 : 1,
		preset: args.preset || (writingFile ? 'studio' : 'terminal'),
		focus: ['full', 'bust', 'head'].includes(args.focus) ? args.focus : 'full',
		yaw: num(args.yaw, 26),
		pitch: num(args.pitch, 6),
		background: args.bg === undefined ? undefined : args.bg === 'transparent' ? 'transparent' : String(args.bg),
		clip: args.clip === undefined ? null : Number.isFinite(Number(args.clip)) ? Number(args.clip) : String(args.clip),
		frames,
		fps,
		spin,
	};

	if (args.clip !== undefined && !model.play(options.clip)) {
		fail(`no clip matching "${args.clip}". Try --clips to list them.`);
	}

	if (writingFile) {
		const out = path.resolve(String(args.out));
		const rendered = frames > 1 ? await renderFrames(model, options) : [renderFrame(model, options)];
		const bytes = rendered.length > 1 ? encodeApng(rendered, { fps }) : encodePng(rendered[0]);
		await fs.writeFile(out, bytes);
		process.stdout.write(`${out} (${rendered.length} frame${rendered.length === 1 ? '' : 's'}, ${bytes.length} bytes)\n`);
		return;
	}

	const inline = !args.blocks && (term.kitty || term.iterm);
	const draw = (frame) => {
		if (inline) {
			const png = encodePng(frame, { level: 1 });
			return term.kitty ? toKitty(png, { columns: Math.round(width / 2) }) : toITerm(png, { columns: Math.round(width / 2) });
		}
		return toHalfBlocks(frame, { truecolor: term.truecolor });
	};

	const animated = frames > 1 || args.loop;
	if (!animated) {
		process.stdout.write(`${draw(renderFrame(model, options))}\n`);
		return;
	}

	const rendered = await renderFrames(model, options);
	const painted = rendered.map(draw);
	const lines = inline ? Math.round(height / 2 / 2) : Math.ceil(height / 2);

	let stop = false;
	const cleanup = () => {
		stop = true;
		process.stdout.write(CURSOR.show);
	};
	process.on('SIGINT', () => {
		cleanup();
		process.exit(0);
	});

	process.stdout.write(CURSOR.hide);
	try {
		do {
			for (const frame of painted) {
				if (stop) break;
				process.stdout.write(`${frame}\n`);
				await new Promise((resolve) => setTimeout(resolve, Math.round(1000 / fps)));
				process.stdout.write(CURSOR.up(lines + 1));
			}
		} while (args.loop && !stop);
		// Land the cursor below the last frame instead of on top of it.
		process.stdout.write(`${painted[painted.length - 1]}\n`);
	} finally {
		cleanup();
	}
	void explicitFrames;
}

main().catch((err) => fail(err?.stack || err?.message || String(err)));
