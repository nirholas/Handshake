#!/usr/bin/env node
// three-ws-assets: find a ready-made 3D asset on three.ws and put it in your
// project, with the code that renders it.
//
// Everything this CLI reads is free and public. There is no login, no API key,
// and no payment: the catalog it searches is the platform's published CC0 prop
// library, ready-made character library, and motion-clip library.

import { add } from './commands/add.js';
import { search } from './commands/search.js';
import { show } from './commands/show.js';
import { style, symbols, failure, hint } from './style.js';

const COMMANDS = {
	search: {
		run: search,
		summary: 'Search the three.ws asset catalog',
		usage: `${style.bold('three-ws-assets search')} ${style.dim('<terms…> [options]')}

  Search every ready-made asset three.ws publishes: CC0 props, rigged
  characters, and retargetable motion clips. Every word has to match, so a
  two-word query stays precise; if nothing matches all of them you get the
  partial matches with a warning rather than an empty list.

  ${style.bold('options')}
    --kind <k>       object | character | animation
    --category <c>   Exact category from a previous result
    --tag <t>        Exact tag from a previous result
    --limit <n>      1..50 (default: 12)
    --offset <n>     Page offset (see "more:" in the output)
    --json           Raw JSON on stdout
    --api <origin>   Catalog origin (default: https://three.ws)

  ${style.dim('example')}
    three-ws-assets search wooden chair --kind object`,
	},
	show: {
		run: show,
		summary: 'Print one item and the code that renders it',
		usage: `${style.bold('three-ws-assets show')} ${style.dim('<id> [options]')}

  Print an item's facts plus paste-ready source. Without --framework you get
  the one that fits the item (model-viewer for a prop, agent-3d for a rigged
  character, three for a motion clip) and the names of the others.

  ${style.bold('options')}
    --framework <f>  agent-3d | model-viewer | three | react
    --json           Raw JSON, including every framework's snippet
    --api <origin>   Catalog origin (default: https://three.ws)

  ${style.dim('example')}
    three-ws-assets show object:painted_wooden_chair_01 --framework three`,
	},
	add: {
		run: add,
		summary: 'Download an asset into your project and print its snippet',
		usage: `${style.bold('three-ws-assets add')} ${style.dim('<id> [options]')}

  Download the GLB (or clip JSON) into your project and print the snippet
  rewritten to point at the local copy. Files land in ${style.cyan('public/three-ws/')} when
  the project has a public directory, otherwise ${style.cyan('three-ws-assets/')}.

  A re-run that would write identical bytes reports the file as already up to
  date. A file whose contents changed since it was added is never overwritten
  without ${style.cyan('--force')}.

  ${style.bold('options')}
    --dir <path>     Where to write (default: public/three-ws)
    --framework <f>  agent-3d | model-viewer | three | react
    --thumb          Download the thumbnail too
    --force          Overwrite a file whose contents differ
    --json           Raw JSON: written paths, the local url, the snippet
    --api <origin>   Catalog origin (default: https://three.ws)

  ${style.dim('example')}
    three-ws-assets add object:painted_wooden_chair_01 --thumb`,
	},
};

function topHelp() {
	const rows = Object.entries(COMMANDS)
		.map(([name, c]) => `  ${style.cyan(name.padEnd(8))} ${c.summary}`)
		.join('\n');
	return `
${style.bold('three-ws-assets')} ${style.dim('<command> [options]')}

  Ready-made 3D props, rigged characters, and motion clips from three.ws.
  Free and public: no account, no API key, no payment.

${style.bold('commands')}
${rows}

${style.bold('global')}
  --help, -h     Show help (use ${style.cyan('<command> --help')} for command details)
  --version, -V  Print the CLI version
  --no-color     Disable colored output
  --api <origin> Catalog origin, or set ${style.cyan('THREE_WS_API')}

${style.dim('quick start')}
  ${style.dim('three-ws-assets search wooden chair --kind object')}
  ${style.dim('three-ws-assets add object:painted_wooden_chair_01')}

${style.dim(`${symbols.arrow} docs: https://three.ws/docs/mcp  ${symbols.bullet}  issues: https://github.com/nirholas/three.ws/issues`)}
`;
}

export function parseArgs(argv) {
	const args = { _: [], flags: {} };
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i];
		if (tok === '--no-color') {
			args.flags['no-color'] = true;
		} else if (tok.startsWith('--')) {
			const key = tok.slice(2);
			const next = argv[i + 1];
			if (next === undefined || next.startsWith('-')) {
				args.flags[key] = true;
			} else {
				args.flags[key] = next;
				i++;
			}
		} else if (tok.startsWith('-') && tok.length > 1) {
			args.flags[tok.slice(1)] = true;
		} else {
			args._.push(tok);
		}
	}
	return args;
}

/** Closest command name within edit distance 2, for "did you mean" hints. */
function suggestCommand(input) {
	let best = null;
	let bestDist = Infinity;
	for (const name of Object.keys(COMMANDS)) {
		const d = levenshtein(input, name);
		if (d < bestDist) {
			bestDist = d;
			best = name;
		}
	}
	return bestDist <= 2 ? best : null;
}

function levenshtein(a, b) {
	const m = a.length;
	const n = b.length;
	const row = Array.from({ length: n + 1 }, (_, i) => i);
	for (let i = 1; i <= m; i++) {
		let prev = row[0];
		row[0] = i;
		for (let j = 1; j <= n; j++) {
			const tmp = row[j];
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = tmp;
		}
	}
	return row[n];
}

async function readVersion() {
	const { readFileSync } = await import('node:fs');
	const { fileURLToPath } = await import('node:url');
	const { dirname, resolve } = await import('node:path');
	const here = dirname(fileURLToPath(import.meta.url));
	return JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8')).version;
}

export async function main(argv) {
	const args = parseArgs(argv);

	if (args.flags.version || args.flags.V) {
		process.stdout.write(`${await readVersion()}\n`);
		return 0;
	}

	const [command, ...rest] = args._;
	const wantsHelp = args.flags.help || args.flags.h;

	if (!command) {
		process.stdout.write(topHelp());
		return wantsHelp ? 0 : 1;
	}

	const entry = COMMANDS[command];
	if (!entry) {
		failure(`unknown command: ${style.bold(command)}`);
		const guess = suggestCommand(command);
		if (guess) hint(`did you mean "${guess}"?`);
		hint('run "three-ws-assets --help" to see all commands');
		return 1;
	}

	if (wantsHelp) {
		process.stdout.write(`${entry.usage}\n`);
		return 0;
	}

	return entry.run({ positional: rest, flags: args.flags });
}

/** Turn low-level Node errors into a one-line, human message. */
function describeError(err) {
	switch (err?.code) {
		case 'ENOENT':
			return `file not found: ${err.path ?? err.message}`;
		case 'EACCES':
			return `permission denied: ${err.path ?? err.message}`;
		case 'EISDIR':
			return `expected a file but got a directory: ${err.path ?? err.message}`;
		default:
			return err?.message ?? String(err);
	}
}

const isDirectInvocation = (() => {
	if (typeof process === 'undefined' || !process.argv[1]) return false;
	const entry = process.argv[1];
	return entry.endsWith('cli.js') || entry.endsWith('three-ws-assets');
})();

if (isDirectInvocation) {
	main(process.argv.slice(2))
		.then((code) => process.exit(code ?? 0))
		.catch((err) => {
			failure(describeError(err));
			process.exit(1);
		});
}
