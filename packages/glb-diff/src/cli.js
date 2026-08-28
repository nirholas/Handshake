#!/usr/bin/env node
// glb-diff: what changed between two 3D models.
//
//   glb-diff before.glb after.glb
//   glb-diff before.glb https://example.com/after.glb --markdown
//   glb-diff base.glb candidate.glb --fail-on major
//
// Exit codes are the contract a CI job depends on, so they are deliberate:
//   0  the diff ran and stayed below --fail-on (default: never fails on changes)
//   1  the diff ran and the severity reached --fail-on
//   2  the tool could not run (bad arguments, unreadable input, unparseable model)
// A tool that returns 1 for both "your model regressed" and "I could not open
// the file" is useless in a pipeline, which is why 2 exists.

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { diffModels } from './index.js';
import { formatMarkdown, formatText } from './format.js';
import { atLeast, SEVERITIES } from './severity.js';

const USAGE = `glb-diff <before> <after> [options]

  <before>, <after>   a .glb/.gltf file path or an http(s) URL

Options
  --json              print the full change set as JSON
  --markdown          print a Markdown report (for a pull-request comment)
  --fail-on <level>   exit 1 when severity reaches this level
                      (${SEVERITIES.slice(1).join(' | ')})
  --verbose           include unchanged totals in the table
  --no-color          disable ANSI colour
  -h, --help          show this help

Examples
  glb-diff avatar.v1.glb avatar.v2.glb
  glb-diff base.glb optimized.glb --fail-on breaking
  glb-diff a.glb b.glb --json > changes.json
`;

function parseArgs(argv) {
	const opts = { positional: [], json: false, markdown: false, failOn: null, color: true, verbose: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--json') opts.json = true;
		else if (arg === '--markdown' || arg === '--md') opts.markdown = true;
		else if (arg === '--verbose') opts.verbose = true;
		else if (arg === '--no-color') opts.color = false;
		else if (arg === '-h' || arg === '--help') opts.help = true;
		else if (arg === '--fail-on') {
			const level = argv[++i];
			if (!SEVERITIES.includes(level)) throw new Error(`--fail-on expects one of: ${SEVERITIES.slice(1).join(', ')}`);
			opts.failOn = level;
		} else if (arg.startsWith('--fail-on=')) {
			const level = arg.slice('--fail-on='.length);
			if (!SEVERITIES.includes(level)) throw new Error(`--fail-on expects one of: ${SEVERITIES.slice(1).join(', ')}`);
			opts.failOn = level;
		} else if (arg.startsWith('-')) {
			throw new Error(`unknown option: ${arg}`);
		} else {
			opts.positional.push(arg);
		}
	}
	return opts;
}

// A model is either on disk or behind a URL. Both are first-class: comparing a
// local build against the copy already live on a CDN is the single most common
// reason to reach for this, and making the user download it first would be
// pointless friction.
async function loadModel(ref) {
	if (/^https?:\/\//i.test(ref)) {
		const res = await fetch(ref, { redirect: 'follow' });
		if (!res.ok) throw new Error(`${ref}: HTTP ${res.status}`);
		return new Uint8Array(await res.arrayBuffer());
	}
	return new Uint8Array(await readFile(ref));
}

function label(ref) {
	if (/^https?:\/\//i.test(ref)) {
		try {
			return new URL(ref).pathname.split('/').filter(Boolean).pop() || ref;
		} catch {
			return ref;
		}
	}
	return ref.split('/').pop() || ref;
}

async function main() {
	let opts;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (err) {
		process.stderr.write(`${err.message}\n\n${USAGE}`);
		return 2;
	}

	if (opts.help || opts.positional.length === 0) {
		process.stdout.write(USAGE);
		return opts.help ? 0 : 2;
	}
	if (opts.positional.length !== 2) {
		process.stderr.write(`expected exactly two models, got ${opts.positional.length}\n\n${USAGE}`);
		return 2;
	}

	const [refA, refB] = opts.positional;
	let bytesA;
	let bytesB;
	try {
		[bytesA, bytesB] = await Promise.all([loadModel(refA), loadModel(refB)]);
	} catch (err) {
		process.stderr.write(`could not read input: ${err.message}\n`);
		return 2;
	}

	let changeset;
	try {
		changeset = await diffModels(bytesA, bytesB, { nameA: label(refA), nameB: label(refB) });
	} catch (err) {
		process.stderr.write(`could not parse model: ${err.message}\n`);
		return 2;
	}

	if (opts.json) process.stdout.write(`${JSON.stringify(changeset, null, 2)}\n`);
	else if (opts.markdown) process.stdout.write(`${formatMarkdown(changeset)}\n`);
	else {
		const color = opts.color && process.stdout.isTTY && !process.env.NO_COLOR;
		process.stdout.write(`${formatText(changeset, { color, verbose: opts.verbose })}\n`);
	}

	if (opts.failOn && atLeast(changeset.severity, opts.failOn)) {
		process.stderr.write(`glb-diff: severity "${changeset.severity}" reached --fail-on "${opts.failOn}"\n`);
		return 1;
	}
	return 0;
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(err) => {
		process.stderr.write(`glb-diff: ${err?.stack || err}\n`);
		process.exitCode = 2;
	},
);
