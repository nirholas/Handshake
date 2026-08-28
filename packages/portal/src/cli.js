#!/usr/bin/env node
// portal: walk a website from the command line, or take the world with you.
//
//   npx @three-ws/portal example.com                 summary of the world
//   npx @three-ws/portal example.com --glb site.glb  save it as a 3D file
//   npx @three-ws/portal example.com --json w.json   save the world document
//   npx @three-ws/portal example.com --open          print the walkable link
//
// It reads the public API, so there is nothing to configure. Point it at your
// own deployment with --endpoint https://your-host/api/portal.

import { writeFile } from 'node:fs/promises';
import { fetchWorld, fetchWorldGlb, describeWorld, PORTAL_API, PORTAL_PAGE, PortalError } from './index.js';

const USAGE = `portal: turn a website into a walkable 3D world

Usage
  portal <url> [options]

Options
  --glb <file>        write the world as a glTF binary
  --json <file>       write the world document as JSON
  --open              print the walkable three.ws link
  --endpoint <url>    Portal API to use (default ${PORTAL_API})
  --help              this text
`;

function parseArgs(argv) {
	const args = { url: '', endpoint: PORTAL_API };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--help' || a === '-h') args.help = true;
		else if (a === '--open') args.open = true;
		else if (a === '--glb') args.glb = argv[++i];
		else if (a === '--json') args.json = argv[++i];
		else if (a === '--endpoint') args.endpoint = argv[++i];
		else if (!a.startsWith('-') && !args.url) args.url = a;
	}
	return args;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function bar(value, max, width = 22) {
	const filled = max > 0 ? Math.round((value / max) * width) : 0;
	return `${'█'.repeat(filled)}${'·'.repeat(Math.max(0, width - filled))}`;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.url) {
		process.stdout.write(USAGE);
		process.exit(args.url ? 0 : 1);
	}

	const { world, cached } = await fetchWorld(args.url, { endpoint: args.endpoint, include: 'world' });
	const summary = describeWorld(world);
	const tallest = Math.max(...summary.districts.map((d) => d.height), 1);

	const lines = [
		'',
		`  ${summary.title}`,
		`  ${summary.host}${cached ? '  (cached)' : ''}`,
		'',
		`  ${plural(summary.sections, 'district')} · ${plural(summary.words, 'word')} · ${plural(summary.doors, 'door')} (${summary.internalDoors} internal) · ${plural(summary.billboards, 'billboard')} · ${plural(summary.monoliths, 'code monolith')}`,
		'',
	];
	for (const d of summary.districts.slice(0, 20)) {
		lines.push(`  ${bar(d.height, tallest)}  ${String(d.words).padStart(5)}w  ${d.name}`);
	}
	if (summary.districts.length > 20) lines.push(`  … and ${summary.districts.length - 20} more districts`);
	lines.push('');
	if (args.open) lines.push(`  walk it: ${PORTAL_PAGE}?url=${encodeURIComponent(args.url)}`, '');
	process.stdout.write(`${lines.join('\n')}\n`);

	if (args.json) {
		await writeFile(args.json, `${JSON.stringify(world, null, '\t')}\n`);
		process.stdout.write(`  wrote ${args.json}\n`);
	}
	if (args.glb) {
		const bytes = await fetchWorldGlb(args.url, { endpoint: args.endpoint });
		await writeFile(args.glb, Buffer.from(bytes));
		process.stdout.write(`  wrote ${args.glb} (${(bytes.byteLength / 1024).toFixed(1)} kB)\n`);
	}
}

main().catch((err) => {
	if (err instanceof PortalError) {
		process.stderr.write(`\n  ${err.code}: ${err.message}\n\n`);
		process.exit(2);
	}
	process.stderr.write(`\n  ${err?.message || err}\n\n`);
	process.exit(1);
});
