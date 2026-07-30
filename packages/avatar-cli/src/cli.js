#!/usr/bin/env node
import { init } from './commands/init.js';
import { validate } from './commands/validate.js';
import { hash } from './commands/hash.js';
import { preview } from './commands/preview.js';
import { style, symbols, failure, hint } from './style.js';

const COMMANDS = {
	init: {
		run: init,
		summary: 'Scaffold a new avatar manifest from a wallet and mesh',
		usage: `${style.bold('three-ws-avatar init')} ${style.dim('--owner <id> --name <name> --mesh <path> [options]')}

  Build a schema-valid avatar manifest. The mesh is hashed (SHA-256) and sized
  automatically. Prints to stdout, or writes a file with ${style.cyan('--out')}.

  ${style.bold('required')}
    --owner <caip10|0x…>   Owner identity (eip155:1:0x…, or shorthand 0x…)
    --name  <string>       Avatar display name
    --mesh  <path>         Path to a .glb / .gltf / .vrm file

  ${style.bold('optional')}
    --skeleton <name>      avaturn | mixamo | rpm | vrm-humanoid | custom  (default: avaturn)
    --mesh-uri <url>       Public URI for the mesh (default: file:// path)
    --id <string>          Override id (default: derived from owner or name)
    --out <path>           Write manifest to a file instead of stdout

  ${style.dim('example')}
    three-ws-avatar init --owner 0x742d35… --name "Nicholas" --mesh ./michelle.glb --out manifest.json`,
	},
	validate: {
		run: validate,
		summary: 'Validate an existing avatar manifest against the schema',
		usage: `${style.bold('three-ws-avatar validate')} ${style.dim('<path> [--json]')}

  Validate a manifest file against @three-ws/avatar-schema. Exits 0 when valid,
  1 otherwise, with each schema error printed in place.

  ${style.dim('example')}
    three-ws-avatar validate manifest.json`,
	},
	hash: {
		run: hash,
		summary: 'Compute SHA-256 of a mesh or accessory file (lowercase hex)',
		usage: `${style.bold('three-ws-avatar hash')} ${style.dim('<path> [--json]')}

  Print the lowercase hex SHA-256 of a file's bytes — pipe-friendly:
    sha=$(three-ws-avatar hash ./michelle.glb)

  ${style.dim('example')}
    three-ws-avatar hash ./michelle.glb --json`,
	},
	preview: {
		run: preview,
		summary: 'Print an embeddable <three-ws-avatar> snippet for a manifest',
		usage: `${style.bold('three-ws-avatar preview')} ${style.dim('<path> [--viewer <origin>] [--json]')}

  Validate a manifest and print a resolver URL, a <three-ws-avatar> web-component
  snippet, and a zero-install iframe. Snippets are emitted uncolored so they
  paste cleanly.

  ${style.dim('example')}
    three-ws-avatar preview manifest.json --viewer https://three.ws`,
	},
};

function topHelp() {
	const rows = Object.entries(COMMANDS)
		.map(([name, { summary }]) => `  ${style.cyan(name.padEnd(10))} ${summary}`)
		.join('\n');
	return `${style.bold('three-ws-avatar')} ${style.dim('— on-chain avatar tooling')}

${style.bold('usage')}
  three-ws-avatar <command> [options]

${style.bold('commands')}
${rows}

${style.bold('global options')}
  --help, -h    Show help (use ${style.cyan('<command> --help')} for command details)
  --version     Print version
  --json        Machine-readable output (validate, hash, preview)
  --no-color    Disable colored output

${style.bold('examples')}
  ${style.dim('three-ws-avatar init --owner 0xabc… --name "Nicholas" --mesh ./michelle.glb --out manifest.json')}
  ${style.dim('three-ws-avatar validate manifest.json')}
  ${style.dim('three-ws-avatar hash ./michelle.glb')}
  ${style.dim('three-ws-avatar preview manifest.json')}

${style.dim(`${symbols.arrow} docs: https://three.ws  ${symbols.bullet}  issues: https://github.com/nirholas/three.ws/issues`)}
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
	const names = Object.keys(COMMANDS);
	let best = null;
	let bestDist = Infinity;
	for (const name of names) {
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
			row[j] = Math.min(
				row[j] + 1,
				row[j - 1] + 1,
				prev + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
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
		console.log(await readVersion());
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
		hint(`run "three-ws-avatar --help" to see all commands`);
		return 1;
	}

	if (wantsHelp) {
		process.stdout.write(entry.usage + '\n');
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
	return entry.endsWith('cli.js') || entry.endsWith('three-ws-avatar');
})();

if (isDirectInvocation) {
	main(process.argv.slice(2))
		.then((code) => process.exit(code ?? 0))
		.catch((err) => {
			failure(describeError(err));
			process.exit(1);
		});
}
