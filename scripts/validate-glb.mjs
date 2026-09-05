#!/usr/bin/env node
/**
 * Khronos glTF-Validator over one or more models.
 *
 * The PBR inspectors in this directory answer "what does this model carry";
 * this one answers "is it legal glTF at all". They are different failures: a
 * GLB can carry a complete texture set and still be rejected by a strict viewer
 * because a derived WebP map was written without declaring EXT_texture_webp, an
 * accessor's min/max disagrees with its data, or a normalized attribute uses a
 * component type the spec forbids. Those show up as a blank model in a third
 * party embed and as nothing at all in our own viewer, which is forgiving.
 *
 *   node scripts/validate-glb.mjs public/avatars/default.glb
 *   node scripts/validate-glb.mjs out/            # every .glb/.gltf in a directory
 *   node scripts/validate-glb.mjs --verbose a.glb # warnings and infos too
 *   node scripts/validate-glb.mjs --json out/ > report.json
 *
 * Exit code is 1 when any model reports a validation error, so this doubles as
 * a gate on a pipeline that writes GLBs (`npm run validate:glb`).
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, resolve, join } from 'node:path';
import { validateBytes } from 'gltf-validator';

const MODEL_EXTENSIONS = new Set(['.glb', '.gltf']);
const SEVERITY = ['ERROR', 'WARNING', 'INFO', 'HINT'];

function parseArgs(argv) {
	const args = { inputs: [], verbose: false, json: false, maxIssues: 20 };
	for (const raw of argv) {
		if (raw === '--verbose') args.verbose = true;
		else if (raw === '--json') args.json = true;
		else if (raw.startsWith('--max-issues=')) args.maxIssues = Number(raw.slice('--max-issues='.length));
		else if (raw.startsWith('--')) throw new Error(`unknown flag ${raw}`);
		else args.inputs.push(raw);
	}
	if (!Number.isFinite(args.maxIssues) || args.maxIssues < 1) throw new Error('--max-issues must be a positive number');
	return args;
}

/** A directory expands to the models inside it; a file or URL stands alone. */
async function expand(input) {
	if (/^https?:\/\//i.test(input)) return [input];
	const info = await stat(resolve(input));
	if (!info.isDirectory()) return [input];
	const names = await readdir(resolve(input));
	return names
		.filter((n) => MODEL_EXTENSIONS.has(extname(n).toLowerCase()))
		.sort()
		.map((n) => join(input, n));
}

async function loadBytes(source) {
	if (/^https?:\/\//i.test(source)) {
		const res = await fetch(source, { redirect: 'follow' });
		if (!res.ok) throw new Error(`${source} returned HTTP ${res.status}`);
		return new Uint8Array(await res.arrayBuffer());
	}
	return new Uint8Array(await readFile(resolve(source)));
}

/**
 * A .gltf file keeps its buffers and images beside it, and the validator cannot
 * read them on its own. Resolving them relative to the model is what separates
 * a real structural error from a pile of phantom "resource not found" ones.
 */
function externalResourceFunction(source) {
	if (/^https?:\/\//i.test(source)) {
		const base = new URL(source);
		return async (uri) => new Uint8Array(await (await fetch(new URL(uri, base))).arrayBuffer());
	}
	const dir = dirname(resolve(source));
	return async (uri) => new Uint8Array(await readFile(join(dir, decodeURIComponent(uri))));
}

export async function validateOne(source, { maxIssues = 20 } = {}) {
	const bytes = await loadBytes(source);
	const report = await validateBytes(bytes, {
		maxIssues,
		uri: source,
		externalResourceFunction: externalResourceFunction(source),
	});
	const issues = report.issues;
	return {
		source,
		bytes: bytes.byteLength,
		generator: report.info?.generator ?? null,
		version: report.info?.version ?? null,
		extensionsUsed: report.info?.extensionsUsed ?? [],
		errors: issues.numErrors,
		warnings: issues.numWarnings,
		infos: issues.numInfos,
		hints: issues.numHints,
		messages: issues.messages.map((m) => ({
			severity: SEVERITY[m.severity] ?? String(m.severity),
			code: m.code,
			message: m.message,
			pointer: m.pointer ?? null,
		})),
	};
}

function printReport(r, verbose) {
	const head = `${basename(r.source).padEnd(34)} errors=${r.errors} warnings=${r.warnings} infos=${r.infos}`;
	console.log(head);
	const shown = verbose ? r.messages : r.messages.filter((m) => m.severity === 'ERROR');
	for (const m of shown) {
		console.log(`   ${m.severity.padEnd(7)} ${m.code} ${m.message}${m.pointer ? `  ${m.pointer}` : ''}`);
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.inputs.length === 0) {
		console.error('usage: node scripts/validate-glb.mjs [--verbose] [--json] [--max-issues=N] <glb/gltf path, directory, or url>...');
		process.exit(2);
	}

	const sources = [];
	for (const input of args.inputs) sources.push(...(await expand(input)));
	if (sources.length === 0) {
		console.error(`no .glb or .gltf files found in: ${args.inputs.join(', ')}`);
		process.exit(2);
	}

	const reports = [];
	let unreadable = 0;
	for (const source of sources) {
		try {
			reports.push(await validateOne(source, { maxIssues: args.maxIssues }));
		} catch (err) {
			unreadable++;
			reports.push({ source, error: String(err.message || err) });
		}
	}

	if (args.json) {
		console.log(JSON.stringify({ generatedAt: new Date().toISOString(), models: reports }, null, 2));
	} else {
		for (const r of reports) {
			if (r.error) console.error(`${basename(r.source).padEnd(34)} UNREADABLE ${r.error}`);
			else printReport(r, args.verbose);
		}
		const invalid = reports.filter((r) => !r.error && r.errors > 0);
		console.log('');
		console.log(
			invalid.length
				? `${invalid.length} of ${sources.length} model(s) failed validation: ${invalid.map((r) => basename(r.source)).join(', ')}`
				: `All ${sources.length - unreadable} readable model(s) are valid glTF.`,
		);
	}

	if (unreadable > 0) process.exit(2);
	if (reports.some((r) => !r.error && r.errors > 0)) process.exit(1);
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
	main().catch((err) => {
		console.error(err);
		process.exit(2);
	});
}
