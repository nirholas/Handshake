#!/usr/bin/env node
/**
 * Mirror the public three.ws motion library to a local directory, ready to
 * upload into any S3-compatible bucket (Cloudflare R2, AWS S3, B2).
 *
 * This script is meant to be handed to third parties, so it has ZERO
 * dependencies and needs no credentials from three.ws. Everything it reads is
 * already public: the manifest at /api/animations/library lists every clip with
 * an absolute CDN URL, and the CDN serves those anonymously.
 *
 * Node 18+ (uses global fetch).
 *
 * What you get, mirroring the source key layout exactly so uploading the output
 * directory to your bucket root reproduces the same paths:
 *
 *   <out>/animations/library/manifest.json
 *   <out>/animations/library/clips/<name>.json     three.js AnimationClip JSON
 *   <out>/animations/library/thumbs/<name>.webp    poster thumbnail
 *
 * Usage:
 *   node mirror-animation-library.mjs                        # mirror everything
 *   node mirror-animation-library.mjs --out ./anims          # choose output dir
 *   node mirror-animation-library.mjs --limit 25             # try a small slice
 *   node mirror-animation-library.mjs --concurrency 16       # tune parallelism
 *   node mirror-animation-library.mjs --no-thumbs            # clips only
 *   node mirror-animation-library.mjs --base https://cdn.example.com
 *                                     # rewrite manifest URLs to your own host
 *
 * The run is resumable: a file already on disk with the expected size is
 * skipped, so re-running after an interruption only fetches what is missing.
 *
 * After it finishes, upload with either:
 *   rclone copy <out>/ r2:your-bucket/ --progress
 *   npx wrangler r2 object put your-bucket/<key> --file <out>/<key>
 */

import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const API = 'https://three.ws/api/animations/library';
const PAGE = 1000;
const PREFIX = 'animations/library';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback = null) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const OUT = opt('out', './three-ws-animations');
const CONCURRENCY = Math.min(Math.max(Number(opt('concurrency', 8)) || 8, 1), 32);
const LIMIT = Number(opt('limit', 0)) || 0;
const WANT_THUMBS = !flag('no-thumbs');
const REWRITE_BASE = opt('base', null)?.replace(/\/+$/, '') || null;

if (flag('help') || flag('h')) {
	console.log(await readFile(new URL(import.meta.url), 'utf8').then((s) => s.split('*/')[0]));
	process.exit(0);
}

/** Fetch with bounded retries. Returns a Response or throws after the last try. */
async function fetchRetry(url, tries = 4) {
	let lastErr;
	for (let attempt = 0; attempt < tries; attempt++) {
		try {
			const res = await fetch(url);
			// 4xx other than 429 is permanent; retrying only wastes time.
			if (!res.ok && res.status !== 429 && res.status < 500) {
				throw new Error(`HTTP ${res.status}`);
			}
			if (res.ok) return res;
			lastErr = new Error(`HTTP ${res.status}`);
		} catch (err) {
			lastErr = err;
		}
		await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
	}
	throw lastErr;
}

/** Pull the whole manifest through the paged endpoint. */
async function loadManifest() {
	const clips = [];
	let offset = 0;
	let total = Infinity;
	let generatedAt = null;
	while (offset < total) {
		const res = await fetchRetry(`${API}?limit=${PAGE}&offset=${offset}`);
		const body = await res.json();
		total = body.total ?? body.clips.length;
		generatedAt = body.generated_at ?? generatedAt;
		clips.push(...body.clips);
		if (body.next_offset == null) break;
		offset = body.next_offset;
		process.stdout.write(`\rmanifest: ${clips.length}/${total}`);
	}
	process.stdout.write(`\rmanifest: ${clips.length} clips\n`);
	return { clips, generatedAt };
}

/** Local path for a source URL, preserving its key under the library prefix. */
function localPathFor(url) {
	const key = new URL(url).pathname.replace(/^\/+/, '');
	return join(OUT, key);
}

/** Download one URL unless an identical-size file is already present. */
async function download(url, expectedBytes) {
	const dest = localPathFor(url);
	if (expectedBytes) {
		const existing = await stat(dest).catch(() => null);
		if (existing && existing.size === expectedBytes) return 'skipped';
	} else {
		const existing = await stat(dest).catch(() => null);
		if (existing && existing.size > 0) return 'skipped';
	}
	const res = await fetchRetry(url);
	const buf = Buffer.from(await res.arrayBuffer());
	await mkdir(dirname(dest), { recursive: true });
	await writeFile(dest, buf);
	return 'fetched';
}

/** Run tasks with a fixed-size worker pool, reporting progress as they land. */
async function pool(tasks, size, onDone) {
	let cursor = 0;
	const workers = Array.from({ length: Math.min(size, tasks.length) }, async () => {
		while (cursor < tasks.length) {
			const index = cursor++;
			try {
				onDone(await tasks[index]());
			} catch (err) {
				onDone('failed', err, index);
			}
		}
	});
	await Promise.all(workers);
}

const { clips: allClips, generatedAt } = await loadManifest();
const clips = LIMIT ? allClips.slice(0, LIMIT) : allClips;

const jobs = [];
for (const clip of clips) {
	if (clip.url) jobs.push(() => download(clip.url, clip.bytes));
	if (WANT_THUMBS && clip.thumb) jobs.push(() => download(clip.thumb, 0));
}

const totalBytes = clips.reduce((sum, c) => sum + (c.bytes || 0), 0);
console.log(
	`mirroring ${clips.length} clips (${(totalBytes / 1e9).toFixed(2)} GB of clip JSON)` +
		`${WANT_THUMBS ? ' plus thumbnails' : ''} into ${OUT}`,
);
console.log(`${jobs.length} objects, concurrency ${CONCURRENCY}\n`);

const tally = { fetched: 0, skipped: 0, failed: 0 };
const failures = [];
let done = 0;
await pool(jobs, CONCURRENCY, (result, err, index) => {
	tally[result] = (tally[result] || 0) + 1;
	if (result === 'failed') failures.push({ index, message: err?.message || String(err) });
	done++;
	if (done % 25 === 0 || done === jobs.length) {
		process.stdout.write(
			`\r${done}/${jobs.length}  fetched ${tally.fetched}  skipped ${tally.skipped}  failed ${tally.failed}`,
		);
	}
});
process.stdout.write('\n');

// Write the manifest last so its presence means the mirror is complete.
const outManifest = {
	generated_at: generatedAt,
	mirrored_from: API,
	total: clips.length,
	clips: clips.map((clip) => {
		if (!REWRITE_BASE) return clip;
		const point = (url) => (url ? REWRITE_BASE + new URL(url).pathname : url);
		return { ...clip, url: point(clip.url), thumb: point(clip.thumb) };
	}),
};
const manifestPath = join(OUT, PREFIX, 'manifest.json');
await mkdir(dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, JSON.stringify(outManifest, null, 0));

console.log(`\nmanifest: ${manifestPath}`);
if (REWRITE_BASE) console.log(`manifest URLs rewritten to ${REWRITE_BASE}`);
else console.log('manifest URLs still point at three.ws (pass --base to rewrite them)');

if (failures.length) {
	console.log(`\n${failures.length} object(s) failed. Re-run to retry just those:`);
	for (const f of failures.slice(0, 10)) console.log(`  ${f.message}`);
	process.exit(1);
}
console.log('\ncomplete. Upload with:');
console.log(`  rclone copy ${OUT}/ r2:your-bucket/ --progress`);
