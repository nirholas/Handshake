#!/usr/bin/env node
// scripts/veo-generate.mjs
//
// Render b-roll clips with Vertex AI Veo 3 and drop them in GCS.
//
// This is the generic lane. It takes prompts (inline or from a JSON file),
// renders them in parallel, and prints the resulting gs:// URIs. Anything that
// needs generated footage — the x402 milestone video, launch teasers, site
// backgrounds — calls this rather than hand-rolling a Vertex request.
//
// Veo cannot draw legible text. Never ask it for a number, a word, or a logo;
// composite those afterwards. `NO_TEXT_NEGATIVE` in lib/veo.mjs enforces it.
//
// Usage:
//   node scripts/veo-generate.mjs --prompt "slow push through a dark server hall"
//   node scripts/veo-generate.mjs --file prompts.json --out gs://three-ws-veo/my-run
//   node scripts/veo-generate.mjs --prompt "..." --duration 6 --audio
//
// Flags:
//   --prompt <text>   one prompt (repeatable)
//   --file <path>     JSON array of prompt strings
//   --out <gs://...>  output prefix (default gs://three-ws-veo/run-<timestamp>)
//   --duration <n>    seconds per clip: 4, 6, or 8 (default 8)
//   --aspect <r>      16:9 or 9:16 (default 16:9)
//   --resolution <r>  720p or 1080p (default 1080p)
//   --audio           let Veo generate an audio track (default off)
//   --download <dir>  also pull the finished clips to a local directory
//   --json            print machine-readable results

import { readFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { generateVideos } from './lib/veo.mjs';

const execFileAsync = promisify(execFile);
const argv = process.argv.slice(2);

function flag(name) {
	return argv.includes(`--${name}`);
}
function opt(name, fallback = null) {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
function allOpts(name) {
	const out = [];
	argv.forEach((a, i) => {
		if (a === `--${name}` && argv[i + 1]) out.push(argv[i + 1]);
	});
	return out;
}

const asJson = flag('json');
const log = asJson ? () => {} : console.log;

let prompts = allOpts('prompt');
const file = opt('file');
if (file) {
	const parsed = JSON.parse(await readFile(file, 'utf8'));
	if (!Array.isArray(parsed)) throw new Error(`${file} must contain a JSON array of prompts`);
	prompts = prompts.concat(parsed);
}
if (!prompts.length) {
	console.error('No prompts. Pass --prompt "…" or --file prompts.json');
	process.exit(1);
}

// Timestamp comes from the process, not the caller, so repeat runs never
// overwrite a previous take.
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const storageUri = opt('out', `gs://three-ws-veo/run-${stamp}`);

log(`Rendering ${prompts.length} clip(s) with Veo 3 -> ${storageUri}`);

const clips = await generateVideos({
	prompts,
	storageUri,
	durationSeconds: Number(opt('duration', '8')),
	aspectRatio: opt('aspect', '16:9'),
	resolution: opt('resolution', '1080p'),
	generateAudio: flag('audio'),
	log,
});

const downloadDir = opt('download');
if (downloadDir) {
	await mkdir(downloadDir, { recursive: true });
	for (const clip of clips) {
		const dest = path.join(downloadDir, `clip-${clip.index + 1}.mp4`);
		await execFileAsync('gcloud', ['storage', 'cp', clip.gcsUri, dest]);
		clip.localPath = dest;
		log(`  downloaded -> ${dest}`);
	}
}

if (asJson) {
	console.log(JSON.stringify({ storageUri, clips }, null, 2));
} else {
	console.log('\nDone:');
	for (const c of clips) console.log(`  ${c.gcsUri}${c.localPath ? `  (${c.localPath})` : ''}`);
}
