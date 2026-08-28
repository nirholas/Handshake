#!/usr/bin/env node
/**
 * a3s - pack, inspect, verify, extract and benchmark A3S streams.
 *
 * Every command works on a plain file with no service running, which is the
 * point: an A3S stream is a static asset, so the tooling around it should be
 * shell-shaped rather than server-shaped.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';

import { pack } from '../src/pack.js';
import { A3SStream } from '../src/reader.js';
import { decodePreamble, decodeHeader, RECOMMENDED_PREFIX_BYTES } from '../src/format.js';
import { reconstruct, triangleCount, triangleFingerprint } from '../src/reconstruct.js';

const KB = (n) => `${(n / 1024).toFixed(1)} KB`;
const PCT = (n, of) => `${((100 * n) / of).toFixed(1)}%`;

function parseArgs(argv) {
	const args = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token.startsWith('--')) {
			const [key, inline] = token.slice(2).split('=');
			const next = argv[i + 1];
			if (inline !== undefined) args[key] = inline;
			else if (next && !next.startsWith('-')) args[key] = argv[++i];
			else args[key] = true;
		} else if (token.startsWith('-') && token.length === 2) {
			args[token.slice(1)] = argv[++i];
		} else {
			args._.push(token);
		}
	}
	return args;
}

const USAGE = `a3s - progressive 3D over plain HTTP

Usage
  a3s pack <input.glb> [-o out.a3s] [--levels 0.03,0.1,0.3,1] [--base-texture 64] [--json]
  a3s inspect <file.a3s|url> [--json]
  a3s verify  <file.a3s|url> [--deep] [--json]
  a3s extract <file.a3s|url> [-o preview.glb]
  a3s bench   <input.glb> [--connection slow-3g|fast-3g|4g] [--json]

Commands
  pack     Build an A3S stream from a GLB.
  inspect  Print the layer table: bytes, triangles, and the Range each layer needs.
  verify   Re-hash every layer. With --deep, replay the stream and prove the
           refined surface matches the source triangle for triangle.
  extract  Write layer 0 out as a standalone, spec-valid GLB.
  bench    Estimate time-to-first-frame against a classic GLB fetch.
`;

/** Load a stream from a path or a URL. */
async function openTarget(target, options = {}) {
	if (/^https?:\/\//.test(target)) return A3SStream.open(target, options);
	return A3SStream.open(new Uint8Array(await readFile(target)), options);
}

async function cmdPack(args) {
	const input = args._[0];
	if (!input) throw new Error('pack needs an input .glb');
	const output = args.o || args.output || input.replace(/\.glb$/i, '') + '.a3s';
	const levels = args.levels ? String(args.levels).split(',').map(Number) : undefined;
	const baseTextureSize = args['base-texture'] ? Number(args['base-texture']) : undefined;

	const source = await readFile(input);
	const started = Date.now();
	const { container, header, stats } = await pack(source, { levels, baseTextureSize, name: basename(input) });
	await writeFile(output, container);
	const elapsed = Date.now() - started;

	if (args.json) {
		console.log(JSON.stringify({ output, elapsedMs: elapsed, ...stats, header }, null, 2));
		return;
	}
	console.log(`packed ${basename(input)} -> ${output} in ${elapsed} ms\n`);
	console.log(`  source     ${KB(stats.sourceBytes)}`);
	console.log(`  container  ${KB(stats.containerBytes)}`);
	console.log(`  base layer ${KB(stats.baseBytes)}  (${PCT(stats.baseBytes, stats.sourceBytes)} of source, ${stats.baseTriangles} of ${stats.fullTriangles} triangles)\n`);
	printLayers(header);
}

function printLayers(header) {
	console.log('  level  kind   triangles      bytes      cumulative');
	let cumulative = 0;
	for (const layer of header.layers) {
		cumulative = layer.offset + layer.length;
		console.log(
			`  ${String(layer.level).padEnd(6)} ${layer.kind.padEnd(6)} ${String(layer.triangleCount).padStart(9)} ${KB(layer.length).padStart(10)} ${KB(cumulative).padStart(14)}`,
		);
	}
}

async function cmdInspect(args) {
	const target = args._[0];
	if (!target) throw new Error('inspect needs a .a3s file or URL');
	const stream = await openTarget(target);
	const { header, preamble } = stream;
	if (args.json) {
		console.log(JSON.stringify({ preamble, header }, null, 2));
		return;
	}
	console.log(`${header.source.name || target}  (${header.version}, packed by ${header.generator})\n`);
	console.log(`  source sha256   ${header.source.sha256}`);
	console.log(`  source bytes    ${KB(header.source.byteLength)}`);
	console.log(`  geometry        ${header.geometry.triangleCount} triangles, ${header.geometry.vertexCount} vertices, ${header.geometry.primitiveCount} primitives`);
	console.log(`  first render    ${KB(preamble.baseOffset + preamble.baseLength)} (one Range request)\n`);
	printLayers(header);
	console.log(`\n  Range for layer 0:  bytes=0-${preamble.baseOffset + preamble.baseLength - 1}`);
}

async function cmdVerify(args) {
	const target = args._[0];
	if (!target) throw new Error('verify needs a .a3s file or URL');
	const bytes = /^https?:\/\//.test(target) ? null : new Uint8Array(await readFile(target));
	const stream = await openTarget(target, { verify: true });
	const results = [];
	for (let level = 0; level < stream.layerCount; level++) {
		const { descriptor, payload } = await stream.layer(level);
		const actual = createHash('sha256').update(payload).digest('hex');
		results.push({ level, expected: descriptor.sha256, actual, ok: actual === descriptor.sha256 });
	}

	let deep = null;
	if (args.deep) {
		const { primitives } = await reconstruct(bytes || target, { verify: true });
		const rebuilt = triangleCount(primitives);
		deep = { triangles: rebuilt, expected: stream.header.geometry.triangleCount, ok: rebuilt === stream.header.geometry.triangleCount };
	}

	const ok = results.every((r) => r.ok) && (!deep || deep.ok);
	if (args.json) {
		console.log(JSON.stringify({ ok, layers: results, deep }, null, 2));
	} else {
		for (const r of results) console.log(`  layer ${r.level}  ${r.ok ? 'OK  ' : 'BAD '} ${r.actual.slice(0, 16)}`);
		if (deep) console.log(`  deep replay  ${deep.ok ? 'OK' : 'MISMATCH'}  ${deep.triangles} triangles reconstructed`);
		console.log(ok ? '\nverified' : '\nFAILED');
	}
	if (!ok) process.exitCode = 1;
}

async function cmdExtract(args) {
	const target = args._[0];
	if (!target) throw new Error('extract needs a .a3s file or URL');
	const output = args.o || args.output || 'preview.glb';
	const stream = await openTarget(target);
	await writeFile(output, stream.base);
	console.log(`wrote ${output}  ${KB(stream.base.byteLength)}  (${stream.header.layers[0].triangleCount} triangles, opens in any glTF viewer)`);
}

/** Downlink speeds in bytes per second, matching the profiles browsers ship. */
const CONNECTIONS = {
	'slow-3g': 50 * 1024,
	'fast-3g': 180 * 1024,
	'4g': 1200 * 1024,
};

async function cmdBench(args) {
	const input = args._[0];
	if (!input) throw new Error('bench needs an input .glb');
	const connection = args.connection || 'fast-3g';
	const bytesPerSecond = CONNECTIONS[connection];
	if (!bytesPerSecond) throw new Error(`unknown connection profile ${connection}; try ${Object.keys(CONNECTIONS).join(', ')}`);

	const source = await readFile(input);
	const { header, stats } = await pack(source, { name: basename(input) });
	const firstFrameBytes = header.layers[0].offset + header.layers[0].length;
	const classicMs = (stats.sourceBytes / bytesPerSecond) * 1000;
	const streamMs = (firstFrameBytes / bytesPerSecond) * 1000;

	const result = {
		input: basename(input),
		connection,
		classic: { bytes: stats.sourceBytes, firstFrameMs: Math.round(classicMs), triangles: stats.fullTriangles },
		stream: { bytes: firstFrameBytes, firstFrameMs: Math.round(streamMs), triangles: stats.baseTriangles },
		speedup: Number((classicMs / streamMs).toFixed(1)),
	};
	if (args.json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	console.log(`${result.input} on ${connection}\n`);
	console.log(`  classic GLB   ${KB(result.classic.bytes).padStart(10)}  first frame at ${String(result.classic.firstFrameMs).padStart(6)} ms  (${result.classic.triangles} triangles)`);
	console.log(`  A3S stream    ${KB(result.stream.bytes).padStart(10)}  first frame at ${String(result.stream.firstFrameMs).padStart(6)} ms  (${result.stream.triangles} triangles)`);
	console.log(`\n  ${result.speedup}x faster to first frame, refining to full detail in the background.`);
}

const COMMANDS = { pack: cmdPack, inspect: cmdInspect, verify: cmdVerify, extract: cmdExtract, bench: cmdBench };

async function main() {
	const [command, ...rest] = process.argv.slice(2);
	if (!command || command === 'help' || command === '--help' || command === '-h') {
		console.log(USAGE);
		return;
	}
	const handler = COMMANDS[command];
	if (!handler) {
		console.error(`a3s: unknown command "${command}"\n`);
		console.log(USAGE);
		process.exitCode = 1;
		return;
	}
	await handler(parseArgs(rest));
}

main().catch((error) => {
	console.error(`a3s: ${error.message}`);
	process.exitCode = 1;
});
