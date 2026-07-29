#!/usr/bin/env node
/**
 * Rewrite the pinned `awal@<version>` across the agent skill packs.
 *
 * Why this exists
 * ---------------
 * The awal CLI version is hardcoded in every command line AND in the skills'
 * `allowed-tools:` permission strings, e.g.
 *
 *   allowed-tools: ["Bash(npx awal@2.10.0 send *)"]
 *
 * A partial bump is therefore worse than no bump: the prose tells the agent to
 * run `awal@2.11.0` while the allowlist only permits `awal@2.10.0`, so every
 * money-moving command is denied at the permission gate — or, if only the
 * allowlist moves, stale code keeps running. The pin has to change everywhere
 * in one operation, which is what this script does.
 *
 * Usage
 * -----
 *   node scripts/update-awal-version.mjs --version 2.11.0        # rewrite
 *   node scripts/update-awal-version.mjs --version 2.11.0 --dry-run
 *   node scripts/update-awal-version.mjs --list                  # show current pins
 *   npm run awal:pin -- --version 2.11.0
 *
 * Safe to re-run: rewriting to the version already in the tree reports 0
 * changes and writes nothing.
 *
 * Scope: `.agents/skills/` and `data/skills/` (Markdown + JSON). data/skills/
 * includes seed.json, whose `content` fields mirror the SKILL.md bodies — a
 * plain text substitution keeps both sides in step because the pin string is
 * identical in each.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const ROOTS = ['.agents/skills', 'data/skills'];
const EXTENSIONS = new Set(['.md', '.markdown', '.json']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

// Matches an exact npm pin: `awal@1.2.3` or `awal@1.2.3-beta.1`. Range specs
// (`awal@^2`) are intentionally NOT matched — the pin is deliberate here (an
// allowlist entry must be literal to be enforceable), so this script moves one
// exact pin to another rather than loosening it.
const PIN_RE = /awal@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function parseArgs(argv) {
	const args = { version: null, dryRun: false, list: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--version' || arg === '-v') args.version = argv[++i] ?? null;
		else if (arg.startsWith('--version=')) args.version = arg.slice('--version='.length);
		else if (arg === '--dry-run' || arg === '-n') args.dryRun = true;
		else if (arg === '--list' || arg === '-l') args.list = true;
		else if (arg === '--help' || arg === '-h') args.help = true;
		else throw new Error(`unknown argument: ${arg}`);
	}
	return args;
}

async function collectFiles(dir, out) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (err.code === 'ENOENT') return out; // a pack that isn't checked out here
		throw err;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			await collectFiles(full, out);
		} else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
			out.push(full);
		}
	}
	return out;
}

async function scan() {
	const files = [];
	for (const root of ROOTS) await collectFiles(path.resolve(REPO_ROOT, root), files);
	files.sort();

	const hits = [];
	for (const file of files) {
		const text = await readFile(file, 'utf8');
		const versions = new Map();
		for (const match of text.matchAll(PIN_RE)) {
			versions.set(match[1], (versions.get(match[1]) || 0) + 1);
		}
		if (versions.size) hits.push({ file, text, versions });
	}
	return hits;
}

function relative(file) {
	return path.relative(REPO_ROOT, file);
}

function printPins(hits) {
	const totals = new Map();
	for (const hit of hits) {
		for (const [version, count] of hit.versions) {
			totals.set(version, (totals.get(version) || 0) + count);
		}
	}
	console.log(`Pinned awal versions across ${ROOTS.join(', ')}:`);
	for (const [version, count] of [...totals].sort()) {
		console.log(`  awal@${version.padEnd(12)} ${String(count).padStart(4)} occurrence(s)`);
	}
	console.log(`Files carrying a pin: ${hits.length}`);
	for (const hit of hits) {
		const detail = [...hit.versions].map(([v, c]) => `${v}×${c}`).join(', ');
		console.log(`  ${relative(hit.file)} — ${detail}`);
	}
}

async function main() {
	let args;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(err.message);
		process.exitCode = 2;
		return;
	}

	if (args.help) {
		console.log(
			[
				'Usage: node scripts/update-awal-version.mjs --version <x.y.z> [--dry-run]',
				'       node scripts/update-awal-version.mjs --list',
				'',
				'Rewrites every `awal@<version>` pin under .agents/skills and data/skills,',
				'including the allowed-tools permission strings, in one pass.',
			].join('\n'),
		);
		return;
	}

	const hits = await scan();

	if (args.list || !args.version) {
		printPins(hits);
		if (!args.version && !args.list) {
			console.log('\nNothing rewritten — pass --version <x.y.z> to change the pin.');
			process.exitCode = 2;
		}
		return;
	}

	const target = args.version.replace(/^v/, '');
	if (!VERSION_RE.test(target)) {
		console.error(`--version must be an exact semver (e.g. 2.11.0), got: ${args.version}`);
		process.exitCode = 2;
		return;
	}

	let changedFiles = 0;
	let changedOccurrences = 0;
	let unchangedOccurrences = 0;
	const perFile = [];

	for (const hit of hits) {
		let replaced = 0;
		const next = hit.text.replace(PIN_RE, (whole, version) => {
			if (version === target) return whole;
			replaced++;
			return `awal@${target}`;
		});
		const kept = [...hit.versions].reduce(
			(sum, [version, count]) => sum + (version === target ? count : 0),
			0,
		);
		unchangedOccurrences += kept;
		if (!replaced) continue;
		changedFiles++;
		changedOccurrences += replaced;
		perFile.push({ file: hit.file, replaced });
		if (!args.dryRun) await writeFile(hit.file, next);
	}

	const verb = args.dryRun ? 'would rewrite' : 'rewrote';
	console.log(`awal pin → ${target}`);
	console.log(`  scanned: ${hits.length} file(s) carrying a pin under ${ROOTS.join(', ')}`);
	console.log(`  ${verb}: ${changedOccurrences} occurrence(s) in ${changedFiles} file(s)`);
	console.log(`  already at ${target}: ${unchangedOccurrences} occurrence(s)`);
	for (const entry of perFile) {
		console.log(`    ${relative(entry.file)} — ${entry.replaced}`);
	}
	if (changedOccurrences === 0) console.log('  no changes needed');
	else if (!args.dryRun) {
		console.log(
			'\nNext: re-read the allowed-tools lines in the touched SKILL.md files — the pin\n' +
				'appears in permission strings as well as in prose, and both moved together.',
		);
	}
}

main().catch((err) => {
	console.error(err?.stack || err);
	process.exitCode = 1;
});
