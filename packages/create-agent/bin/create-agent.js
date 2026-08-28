#!/usr/bin/env node
/**
 * npm create @three-ws/agent "a friendly cartoon astronaut"
 *
 * From a sentence to a rigged 3D character with a working demo page, in one
 * command, with no account and no API key.
 */

import { relative } from 'node:path';

import { createAgent, embedSnippet, ForgeError } from '../src/index.js';
import { parseArgs, USAGE } from '../src/args.js';


const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, text) => (color ? `\u001b[${code}m${text}\u001b[0m` : String(text));


function progress(json) {
	let lastPhase = '';
	return ({ phase, message }) => {
		if (json) return;
		// One line per real event. No spinner, no invented percentage: the only
		// honest signal a blocking generation gives is elapsed time.
		if (phase === 'submitted') process.stdout.write(`${c('90', '·')} ${message}\n`);
		else if (phase === 'working') process.stdout.write(`${c('90', '·')} ${message}\n`);
		else if (phase === 'download') process.stdout.write(`${c('90', '·')} ${message}\n`);
		else if (phase === 'done' && lastPhase !== 'done') process.stdout.write(`${c('32', '✓')} ${message}\n`);
		lastPhase = phase;
	};
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));

	if (opts.unknown) {
		console.error(`create-agent: unknown option ${opts.unknown}\n\n${USAGE}`);
		process.exit(1);
	}
	if (opts.help || (!opts.prompt && !opts.imageUrl)) {
		console.log(USAGE);
		process.exit(opts.help ? 0 : 1);
	}

	if (!opts.json) {
		const what = opts.imageUrl ? `the character in ${opts.imageUrl}` : `"${opts.prompt}"`;
		console.log(`\n${c('1', 'three.ws')} ${c('90', 'building')} ${what}`);
		console.log(
			c('90', opts.rig ? '  a rigged humanoid, free lane, no account needed' : '  an object, free lane, no account needed'),
		);
		console.log('');
	}

	const started = Date.now();
	const made = await createAgent({ ...opts, onProgress: progress(opts.json) });
	const seconds = Math.round((Date.now() - started) / 1000);

	if (opts.json) {
		console.log(JSON.stringify({ ...made, seconds }, null, 2));
		return;
	}

	const dir = relative(process.cwd(), made.dir) || '.';
	console.log('');
	console.log(`${c('1', made.name)} ${c('90', `is ready in ${seconds}s`)}`);
	console.log('');
	console.log(`  ${c('90', 'folder ')} ${dir}/`);
	for (const file of made.files) {
		const size = file === 'agent.glb' && made.bytes ? c('90', ` (${(made.bytes / 1e6).toFixed(1)} MB)`) : '';
		console.log(`  ${c('90', '       ')} ${file}${size}`);
	}
	console.log(`  ${c('90', 'viewer ')} ${made.result.viewerUrl}`);
	if (made.result.studioUrl) console.log(`  ${c('90', 'studio ')} ${made.result.studioUrl}`);
	console.log('');
	console.log(c('90', '  Paste this anywhere:'));
	console.log('');
	console.log(
		embedSnippet({ name: made.name, glbUrl: made.result.glbUrl, instructions: null })
			.split('\n')
			.map((l) => `  ${l}`)
			.join('\n'),
	);
	console.log('');
	console.log(c('90', `  Open the demo:  npx serve ${dir}`));
	console.log('');
}

main().catch((err) => {
	if (err instanceof ForgeError) {
		console.error(`\ncreate-agent: ${err.message}`);
		if (err.code === 'timeout') {
			console.error('Nothing was lost: the forge keeps finished models at https://three.ws/creations');
		}
		process.exit(1);
	}
	console.error(`\ncreate-agent: ${err?.message || err}`);
	process.exit(1);
});
