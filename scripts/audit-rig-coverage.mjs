#!/usr/bin/env node
/**
 * Rig-coverage audit — measures how well src/glb-canonicalize.js actually maps
 * the skeletons in production, using real stored avatars rather than guesses.
 *
 * Why this exists: the canonicalizer's bone-name tables grew by anticipating rig
 * conventions (Mixamo, Unreal, VRM, Daz, SMPL, …). Anticipation is not evidence.
 * This walks real avatars, extracts every skin joint name, and reports which
 * rigs animate, which fall back to the default rig, and — the actionable part —
 * which unmapped bone names appear most often across the library. Each name in
 * that list is a concrete mapping worth adding.
 *
 * It is cheap to run against thousands of avatars because it never downloads a
 * whole GLB: the glTF JSON chunk always sits at byte 20, so an HTTP Range
 * request for the first slice yields the full node/skin graph. A 40 MB avatar
 * costs the same ~256 KB as a 2 MB one.
 *
 * Usage:
 *   node scripts/audit-rig-coverage.mjs                    # 300 avatars, newest first
 *   node scripts/audit-rig-coverage.mjs --limit 2000       # bigger sweep
 *   node scripts/audit-rig-coverage.mjs --source upload    # one ingest lane
 *   node scripts/audit-rig-coverage.mjs --failing          # dump rigs that do NOT animate
 *   node scripts/audit-rig-coverage.mjs --json out.json    # machine-readable report
 *
 * Requires DATABASE_URL and S3_PUBLIC_DOMAIN (both in .env).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { canonicalizeBoneName, CANONICAL_BONES } from '../src/glb-canonicalize.js';

// Bones a clip needs before a performance reads as "the character is moving"
// rather than "a limb twitches on a statue". Mirrors the intent of
// AnimationManager.supportsCanonicalClips(): a torso anchor, both arms, both legs.
const CORE_BONES = [
	'Hips',
	'LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm',
	'LeftUpLeg', 'LeftLeg', 'RightUpLeg', 'RightLeg',
];
// Legs specifically — the difference between a walk cycle and a character
// gliding across the floor with frozen legs, the most-reported rig complaint.
const LEG_BONES = ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'];

// First-pass slice. Covers the overwhelming majority of avatars outright; the
// rest declare their real chunk length in the header and get a second, exact
// request (see fetchGltfJson). Guessing high on the first pass would waste
// bandwidth on every small model to save a round trip on a few large ones.
const RANGE_BYTES = 262144; // 256 KB
// Hard ceiling for the second pass. Real glTF JSON chunks top out in the low
// megabytes (thousands of nodes plus embedded animation metadata); anything
// past this is treated as unreadable rather than pulled into memory.
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const CONCURRENCY = 12;
const FETCH_TIMEOUT_MS = 20000;

function parseArgs(argv) {
	const out = { limit: 300, source: null, json: null, failing: false };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--limit') out.limit = Number(argv[++i]);
		else if (a === '--source') out.source = argv[++i];
		else if (a === '--json') out.json = argv[++i];
		else if (a === '--failing') out.failing = true;
		else if (a === '--help' || a === '-h') out.help = true;
	}
	return out;
}

function readEnv(name) {
	if (process.env[name]) return process.env[name];
	for (const file of ['.env', '.env.local']) {
		let text;
		try {
			text = readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		const m = text.match(new RegExp(`^${name}=(.+)$`, 'm'));
		if (m) return m[1].trim().replace(/^["']|["']$/g, '');
	}
	return null;
}

/**
 * How many bytes are needed to hold a GLB's complete JSON chunk, read from the
 * header. Returns null when the slice isn't a GLB v2 with a JSON chunk 0.
 *
 * Split out from the parser so a short first read can be turned into an exact
 * second request instead of being written off as an error — a heavily-authored
 * rig can declare a multi-megabyte JSON chunk, and dropping those would bias the
 * audit away from precisely the most complex skeletons it exists to measure.
 *
 * @param {ArrayBuffer} head
 * @returns {number|null} total bytes required from offset 0
 */
export function glbJsonChunkEnd(head) {
	if (!head || head.byteLength < 20) return null;
	const view = new DataView(head);
	if (view.getUint32(0, true) !== 0x46546c67) return null; // 'glTF'
	if (view.getUint32(4, true) !== 2) return null;
	if (view.getUint32(16, true) !== 0x4e4f534a) return null; // 'JSON'
	return 20 + view.getUint32(12, true);
}

/**
 * Pull the glTF JSON chunk out of the leading bytes of a GLB. Returns null when
 * the slice isn't a GLB or doesn't yet contain the whole chunk — callers detect
 * the latter with {@link glbJsonChunkEnd} and re-request.
 *
 * @param {ArrayBuffer} head
 * @returns {object|null}
 */
export function parseGlbJsonChunk(head) {
	const end = glbJsonChunkEnd(head);
	if (end == null || end > head.byteLength) return null;
	const bytes = new Uint8Array(head, 20, end - 20);
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
}

/**
 * Score one parsed glTF's skeleton against the canonical bone set.
 *
 * @param {object} json parsed glTF JSON
 * @returns {{skinned:boolean, joints:number, mapped:number, canonical:string[],
 *   unmapped:string[], core:number, legs:number, animates:boolean, generator:string|null}}
 */
export function scoreRig(json) {
	const generator = json?.asset?.generator || null;
	const jointIdx = new Set();
	for (const skin of json?.skins || []) {
		for (const j of skin?.joints || []) jointIdx.add(j);
	}
	if (jointIdx.size === 0) {
		return {
			skinned: false, joints: 0, mapped: 0, canonical: [], unmapped: [],
			core: 0, legs: 0, animates: false, generator,
		};
	}
	const canonical = new Set();
	const unmapped = [];
	for (const idx of jointIdx) {
		const name = json.nodes?.[idx]?.name;
		if (typeof name !== 'string' || !name) continue;
		const c = canonicalizeBoneName(name);
		if (c) canonical.add(c);
		else unmapped.push(name);
	}
	const core = CORE_BONES.filter((b) => canonical.has(b)).length;
	const legs = LEG_BONES.filter((b) => canonical.has(b)).length;
	return {
		skinned: true,
		joints: jointIdx.size,
		mapped: canonical.size,
		canonical: [...canonical],
		unmapped,
		core,
		legs,
		// The retargeter needs the torso anchor plus at least one full limb pair
		// to produce a readable performance; below that it falls back.
		animates: canonical.has('Hips') && core >= 5,
		generator,
	};
}

async function fetchRange(url, endInclusive) {
	const res = await fetch(url, {
		headers: { range: `bytes=0-${endInclusive}` },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok && res.status !== 206) {
		throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
	}
	return res.arrayBuffer();
}

/**
 * Fetch just enough of a GLB to read its glTF JSON chunk. One request for the
 * common case, a second exact-length request when the header says the chunk is
 * bigger than the first slice.
 *
 * @param {string} url
 * @returns {Promise<object|null>} parsed glTF JSON, or null if not a readable GLB
 */
async function fetchGltfJson(url) {
	const head = await fetchRange(url, RANGE_BYTES - 1);
	const end = glbJsonChunkEnd(head);
	if (end == null) return null; // not a GLB v2 at all
	if (end <= head.byteLength) return parseGlbJsonChunk(head);
	if (end > MAX_JSON_BYTES) {
		throw Object.assign(new Error(`json-chunk-too-large-${end}`), { status: 0 });
	}
	return parseGlbJsonChunk(await fetchRange(url, end - 1));
}

// Run `worker` over `items` with a fixed number of in-flight requests.
async function mapPool(items, limit, worker) {
	const out = new Array(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			out[i] = await worker(items[i], i);
		}
	});
	await Promise.all(runners);
	return out;
}

function pct(n, d) {
	return d === 0 ? '0.0%' : `${((n / d) * 100).toFixed(1)}%`;
}

async function main() {
	const args = parseArgs(process.argv);
	if (args.help) {
		console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
		return;
	}

	const dbUrl = readEnv('DATABASE_URL');
	const cdn = readEnv('S3_PUBLIC_DOMAIN');
	if (!dbUrl) throw new Error('DATABASE_URL is required (see .env)');
	if (!cdn) throw new Error('S3_PUBLIC_DOMAIN is required (see .env)');

	const { neon } = await import('@neondatabase/serverless');
	const sql = neon(dbUrl);

	const rows = args.source
		? await sql`
			SELECT id, slug, source, storage_key FROM avatars
			WHERE deleted_at IS NULL AND storage_key IS NOT NULL AND source = ${args.source}
			ORDER BY created_at DESC LIMIT ${args.limit}`
		: await sql`
			SELECT id, slug, source, storage_key FROM avatars
			WHERE deleted_at IS NULL AND storage_key IS NOT NULL
			ORDER BY created_at DESC LIMIT ${args.limit}`;

	console.log(`auditing ${rows.length} avatars${args.source ? ` (source=${args.source})` : ''}…\n`);

	const results = await mapPool(rows, CONCURRENCY, async (row) => {
		const key = row.storage_key;
		const url = /^https?:\/\//i.test(key)
			? key
			: `${cdn}/${key.split('/').map(encodeURIComponent).join('/')}`;
		try {
			const json = await fetchGltfJson(url);
			// A stored object that is not a readable GLB at all — a wrong-format
			// upload or a corrupted write. Reported separately from HTTP failures so
			// data-integrity problems don't hide inside a generic error bucket.
			if (!json) return { row, error: 'not-a-glb' };
			return { row, score: scoreRig(json) };
		} catch (err) {
			return { row, error: err?.status ? `http-${err.status}` : (err?.message || 'fetch-failed') };
		}
	});

	const ok = results.filter((r) => r.score);
	const errored = results.filter((r) => r.error);
	const skinned = ok.filter((r) => r.score.skinned);
	const animating = skinned.filter((r) => r.score.animates);
	const fullLegs = skinned.filter((r) => r.score.legs >= 6);

	// Frequency of every unmapped joint name, and which avatar first showed it.
	const unmappedFreq = new Map();
	for (const r of skinned) {
		for (const name of r.score.unmapped) {
			const e = unmappedFreq.get(name) || { count: 0, sample: r.row.slug || r.row.id };
			e.count++;
			unmappedFreq.set(name, e);
		}
	}
	// Bones the clip library drives that production rigs most often lack.
	const missingFreq = new Map();
	for (const r of skinned) {
		const have = new Set(r.score.canonical);
		for (const b of CANONICAL_BONES) {
			if (!have.has(b)) missingFreq.set(b, (missingFreq.get(b) || 0) + 1);
		}
	}
	const bySource = new Map();
	for (const r of skinned) {
		const s = r.row.source || 'unknown';
		const e = bySource.get(s) || { total: 0, animates: 0, legs: 0 };
		e.total++;
		if (r.score.animates) e.animates++;
		if (r.score.legs >= 6) e.legs++;
		bySource.set(s, e);
	}

	console.log('── coverage ───────────────────────────────────────────────');
	console.log(`fetched          ${ok.length}/${rows.length}   (errors: ${errored.length})`);
	console.log(`skinned rigs     ${skinned.length}   (${pct(skinned.length, ok.length)} of fetched)`);
	console.log(`animate          ${animating.length}   (${pct(animating.length, skinned.length)} of skinned)`);
	console.log(`full leg chain   ${fullLegs.length}   (${pct(fullLegs.length, skinned.length)} of skinned)`);

	console.log('\n── by ingest source ───────────────────────────────────────');
	console.table(
		[...bySource.entries()]
			.sort((a, b) => b[1].total - a[1].total)
			.map(([source, e]) => ({
				source,
				skinned: e.total,
				animates: `${e.animates} (${pct(e.animates, e.total)})`,
				fullLegs: `${e.legs} (${pct(e.legs, e.total)})`,
			})),
	);

	const topUnmapped = [...unmappedFreq.entries()]
		.sort((a, b) => b[1].count - a[1].count)
		.slice(0, 40);
	if (topUnmapped.length) {
		console.log('\n── top unmapped joint names (each = a candidate alias) ────');
		console.table(topUnmapped.map(([name, e]) => ({ name, count: e.count, sample: e.sample })));
	}

	const topMissing = [...missingFreq.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 15);
	console.log('\n── canonical bones most often absent from production rigs ─');
	console.table(topMissing.map(([bone, n]) => ({ bone, missingIn: n, of: skinned.length })));

	// Every rig that still falls back to the default rig, with the joint names it
	// actually shipped — the raw material for the next round of alias work.
	if (args.failing) {
		const failing = skinned.filter((r) => !r.score.animates);
		console.log(`\n── rigs that do NOT animate (${failing.length}) ──────────────────────`);
		for (const r of failing) {
			const s = r.score;
			console.log(
				`\n${r.row.slug || r.row.id}  [${r.row.source}]  ` +
				`${s.joints} joints, ${s.mapped} mapped, core ${s.core}/${CORE_BONES.length}` +
				(s.generator ? `  — ${s.generator}` : ''),
			);
			console.log(`  mapped:   ${s.canonical.sort().join(', ') || '(none)'}`);
			console.log(`  unmapped: ${s.unmapped.slice(0, 24).join(', ')}${s.unmapped.length > 24 ? ` … +${s.unmapped.length - 24}` : ''}`);
		}
	}

	if (errored.length) {
		const byErr = new Map();
		for (const r of errored) byErr.set(r.error, (byErr.get(r.error) || 0) + 1);
		console.log('\n── fetch errors ──────────────────────────────────────────');
		console.table([...byErr.entries()].map(([error, n]) => ({ error, count: n })));
	}

	if (args.json) {
		const report = {
			generatedAt: new Date().toISOString(),
			sampled: rows.length,
			fetched: ok.length,
			skinned: skinned.length,
			animating: animating.length,
			fullLegs: fullLegs.length,
			bySource: Object.fromEntries(bySource),
			unmapped: topUnmapped.map(([name, e]) => ({ name, count: e.count, sample: e.sample })),
			missingBones: topMissing.map(([bone, n]) => ({ bone, missingIn: n })),
			errors: errored.map((r) => ({ id: r.row.id, error: r.error })),
		};
		writeFileSync(args.json, JSON.stringify(report, null, 2));
		console.log(`\nwrote ${args.json}`);
	}
}

// Only run when invoked directly, so the helpers above stay unit-testable.
if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((err) => {
		console.error(err?.stack || err);
		process.exit(1);
	});
}
