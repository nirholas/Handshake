#!/usr/bin/env node
import { init } from './commands/init.js';
import { validate } from './commands/validate.js';
import { hash } from './commands/hash.js';
import { preview } from './commands/preview.js';

const COMMANDS = { init, validate, hash, preview };

const HELP = `three-ws-avatar — on-chain avatar tooling

usage:
  three-ws-avatar <command> [options]

commands:
  init       Scaffold a new avatar manifest from a wallet and mesh
  validate   Validate an existing avatar manifest against the schema
  hash       Compute SHA-256 of a mesh or accessory file (returns lowercase hex)
  preview    Print an embeddable <three-ws-avatar> snippet for a manifest

global options:
  --help, -h    Show help for a command
  --version     Print version

examples:
  three-ws-avatar init --owner eip155:1:0xabc... --name "Nicholas" --mesh ./avatar.glb --out manifest.json
  three-ws-avatar validate manifest.json
  three-ws-avatar hash ./avatar.glb
  three-ws-avatar preview manifest.json
`;

function parseArgs(argv) {
	const args = { _: [], flags: {} };
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i];
		if (tok.startsWith('--')) {
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

async function main(argv) {
	const args = parseArgs(argv);
	if (args.flags.version) {
		const { readFileSync } = await import('node:fs');
		const { fileURLToPath } = await import('node:url');
		const { dirname, resolve } = await import('node:path');
		const here = dirname(fileURLToPath(import.meta.url));
		const pkg = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8'));
		console.log(pkg.version);
		return 0;
	}
	const [command, ...rest] = args._;
	if (!command || args.flags.help || args.flags.h) {
		process.stdout.write(HELP);
		return command ? 0 : 1;
	}
	const fn = COMMANDS[command];
	if (!fn) {
		process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
		return 1;
	}
	return await fn({ positional: rest, flags: args.flags });
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
			process.stderr.write(`error: ${err.message}\n`);
			process.exit(1);
		});
}

export { main, parseArgs };
