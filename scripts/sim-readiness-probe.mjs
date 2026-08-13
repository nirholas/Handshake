#!/usr/bin/env node
// Grade real three.ws assets for simulation readiness.
//
// This is the measurement behind the simulation-ready lane: it pulls actual GLBs
// off the live site (our own generated output from /api/forge-gallery, and the
// CC0 human-authored Object Library as the control group), runs the deterministic
// grader in api/_lib/sim-readiness.js over each one, and prints the pass rate per
// source. Nothing is mocked and nothing is cached: every byte is fetched from
// production on each run, so the numbers are re-derivable by anyone.
//
// Usage:
//   node scripts/sim-readiness-probe.mjs                       # 8 forged + 8 authored
//   node scripts/sim-readiness-probe.mjs --limit 20            # per source
//   node scripts/sim-readiness-probe.mjs --base http://localhost:3000
//   node scripts/sim-readiness-probe.mjs --out tasks/sim-readiness/run.json
//   node scripts/sim-readiness-probe.mjs --url https://…/thing.glb   # one asset

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { gradeSimReadiness } from '../api/_lib/sim-readiness.js';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const BASE = (flag('base', 'https://three.ws') || '').replace(/\/$/, '');
const LIMIT = Math.max(1, Number(flag('limit', '8')) || 8);
const OUT = flag('out', null);
const SINGLE = flag('url', null);
const MAX_BYTES = 64 * 1024 * 1024;

async function getJson(url) {
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
	return res.json();
}

async function getGlb(url) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length > MAX_BYTES) throw new Error(`asset exceeds ${MAX_BYTES} bytes`);
	return buf;
}

async function collectTargets() {
	if (SINGLE) return [{ source: 'url', label: SINGLE.split('/').pop(), url: SINGLE }];
	const targets = [];

	const gallery = await getJson(`${BASE}/api/forge-gallery?limit=${LIMIT * 3}`).catch((err) => {
		console.error(`forge-gallery unavailable: ${err.message}`);
		return null;
	});
	for (const c of gallery?.creations ?? []) {
		if (targets.filter((t) => t.source === 'forge').length >= LIMIT) break;
		if (c.glb_url) targets.push({ source: 'forge', label: (c.prompt || c.id).slice(0, 44), url: c.glb_url, backend: c.backend ?? null });
	}

	const library = await getJson(`${BASE}/api/objects/library?limit=${LIMIT * 3}`).catch((err) => {
		console.error(`objects/library unavailable: ${err.message}`);
		return null;
	});
	for (const o of library?.objects ?? []) {
		if (targets.filter((t) => t.source === 'authored').length >= LIMIT) break;
		if (o.url) targets.push({ source: 'authored', label: o.label || o.name, url: o.url, backend: o.source ?? null });
	}

	return targets;
}

function fmt(n, digits = 4) {
	if (n == null || !Number.isFinite(n)) return '-';
	if (n !== 0 && Math.abs(n) < 1e-3) return n.toExponential(2);
	return n.toFixed(digits);
}

async function main() {
	const targets = await collectTargets();
	if (!targets.length) {
		console.error('No assets to grade. Is the base URL reachable?');
		process.exitCode = 1;
		return;
	}

	console.log(`Grading ${targets.length} real assets from ${SINGLE ? 'a direct URL' : BASE}\n`);
	const rows = [];

	for (const target of targets) {
		const started = Date.now();
		let report;
		let bytes = 0;
		try {
			const buf = await getGlb(target.url);
			bytes = buf.length;
			report = await gradeSimReadiness(buf);
		} catch (err) {
			report = { readable: false, verdict: 'fetch_failed', error: String(err.message || err), blockers: ['fetch_failed'] };
		}
		const ms = Date.now() - started;
		rows.push({ ...target, bytes, ms, report });

		const t = report.topology ?? {};
		console.log(`[${target.source}] ${target.label}`);
		console.log(`  verdict        ${report.verdict}${report.blockers?.length ? `  (${report.blockers.join(', ')})` : ''}`);
		if (report.readable && report.geometry) {
			console.log(`  geometry       ${report.geometry.triangles} tris, ${report.geometry.verticesWelded} welded verts (from ${report.geometry.verticesRaw}), ${(bytes / 1024).toFixed(0)} KB, ${ms} ms`);
			console.log(`  topology       watertight=${t.watertight} boundary=${t.boundaryEdges} nonManifold=${t.nonManifoldEdges} badWinding=${t.inconsistentWindingEdges} degenerate=${t.degenerateTriangles}`);
			console.log(`  scale          longest=${fmt(report.scale?.longestAxisMeters)} m  normalized=${report.scale?.normalizedGuess}  physicalWindow=${report.scale?.withinPhysicalWindow}`);
			console.log(`  mass           volume=${fmt(report.mass?.volumeM3)} m3  massAtWater=${fmt(report.mass?.massAtWaterDensityKg, 2)} kg  Ixx=${fmt(report.mass?.inertiaUnitDensity?.[0])}`);
			if (report.collision) console.log(`  collision      hull ${report.collision.hullVertices} verts / ${report.collision.hullTriangles} tris, convexity=${fmt(report.collision.convexityRatio, 3)}`);
			if (report.warnings?.length) console.log(`  warnings       ${report.warnings.join(', ')}`);
		} else if (report.error) {
			console.log(`  error          ${report.error}`);
		}
		console.log('');
	}

	const summary = {};
	for (const row of rows) {
		const s = (summary[row.source] ??= { total: 0, verdicts: {}, blockers: {} });
		s.total += 1;
		s.verdicts[row.report.verdict] = (s.verdicts[row.report.verdict] ?? 0) + 1;
		for (const b of row.report.blockers ?? []) s.blockers[b] = (s.blockers[b] ?? 0) + 1;
	}

	console.log('Summary by source');
	for (const [source, s] of Object.entries(summary)) {
		const verdicts = Object.entries(s.verdicts).map(([k, v]) => `${k}=${v}`).join(' ');
		console.log(`  ${source.padEnd(9)} n=${s.total}  ${verdicts}`);
		const blockers = Object.entries(s.blockers).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(' ');
		if (blockers) console.log(`  ${' '.repeat(9)} blockers: ${blockers}`);
	}

	if (OUT) {
		const out = path.resolve(OUT);
		await mkdir(path.dirname(out), { recursive: true });
		await writeFile(out, `${JSON.stringify({ base: SINGLE ? null : BASE, gradedAt: new Date().toISOString(), summary, rows }, null, 2)}\n`);
		console.log(`\nWrote ${out}`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
