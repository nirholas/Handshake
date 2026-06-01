#!/usr/bin/env node
// Bulk-download Mixamo character avatars as FBX (With Skin).
// Streams: each character is queued for download as its page is fetched —
// no waiting for a full catalog before starting.
// Resumable: re-run to pick up where it left off.
//
// Usage:
//   MIXAMO_TOKEN=eyJ... node scripts/fetch-mixamo-avatars.mjs
//   # or put MIXAMO_TOKEN=... in .env.local
//
// Optional flags:
//   --concurrency=N    parallel export jobs (default 3)
//   --limit=N          stop after N successful downloads (default: all)
//   --format=fbx7|fbx6 output format (default fbx7)
//
// Prerequisites:
//   node scripts/get-mixamo-token.mjs   (first-time login)

import { mkdirSync, writeFileSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

// ── Config ────────────────────────────────────────────────────────────────
const API = 'https://www.mixamo.com/api/v1';
const PAGE_LIMIT = 96;
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 60;

const args = Object.fromEntries(
	process.argv.slice(2).map((a) => {
		const m = a.match(/^--([^=]+)(?:=(.*))?$/);
		return m ? [m[1], m[2] ?? true] : [a, true];
	}),
);

const CONCURRENCY = Number(args.concurrency) || 3;
const MAX_DOWNLOADS = args.limit ? Number(args.limit) : Infinity;
const FORMAT = args.format || 'fbx7';

let globalCooldownUntil = 0;
const RATE_LIMIT_BASE_MS = 30_000;
const RATE_LIMIT_MAX_MS = 300_000;

// ── Token loading ──────────────────────────────────────────────────────────
function loadEnvVar(key) {
	if (process.env[key]) return process.env[key].trim();
	const envPath = join(process.cwd(), '.env.local');
	if (existsSync(envPath)) {
		const line = readFileSync(envPath, 'utf8').split('\n').find((l) => l.startsWith(`${key}=`));
		if (line) return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '');
	}
	return null;
}

const TOKEN = loadEnvVar('MIXAMO_TOKEN');
if (!TOKEN || TOKEN.startsWith('eyJ...')) {
	console.error('MIXAMO_TOKEN not set. Run: node scripts/get-mixamo-token.mjs');
	console.error('Or manually copy the Bearer token from mixamo.com DevTools -> Network -> any api/v1 request');
	process.exit(1);
}

// ── R2 config ─────────────────────────────────────────────────────────────
const R2_ACCOUNT_ID = loadEnvVar('R2_ACCOUNT_ID');
const R2_ACCESS_KEY_ID = loadEnvVar('R2_ACCESS_KEY_ID');
const R2_SECRET_ACCESS_KEY = loadEnvVar('R2_SECRET_ACCESS_KEY');
const R2_BUCKET = loadEnvVar('R2_BUCKET') || 'test';
const USE_R2 = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);

const r2 = USE_R2
	? new S3Client({
			region: 'auto',
			endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
			credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
	  })
	: null;

async function existsInR2(key) {
	try {
		await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
		return true;
	} catch {
		return false;
	}
}

async function uploadToR2(key, buf) {
	await r2.send(
		new PutObjectCommand({
			Bucket: R2_BUCKET,
			Key: key,
			Body: buf,
			ContentType: 'application/octet-stream',
		}),
	);
}

const headers = {
	Accept: 'application/json',
	'Content-Type': 'application/json',
	Authorization: `Bearer ${TOKEN}`,
	'X-Api-Key': 'mixamo2',
};

// ── Output paths ──────────────────────────────────────────────────────────
const OUT_DIR = join(process.cwd(), 'public', 'avatars', 'mixamo');
const CATALOG_PATH = join(OUT_DIR, 'catalog.json');
mkdirSync(OUT_DIR, { recursive: true });

const catalog = existsSync(CATALOG_PATH)
	? JSON.parse(readFileSync(CATALOG_PATH, 'utf8'))
	: { generated_at: null, avatars: {} };

function saveCatalog() {
	catalog.generated_at = new Date().toISOString();
	const tmp = `${CATALOG_PATH}.tmp`;
	writeFileSync(tmp, JSON.stringify(catalog, null, 2));
	renameSync(tmp, CATALOG_PATH);
}

// ── Helpers ───────────────────────────────────────────────────────────────
const slugify = (s) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForCooldown() {
	while (Date.now() < globalCooldownUntil) {
		await sleep(Math.min(2000, globalCooldownUntil - Date.now()));
	}
}

function triggerCooldown(retryAfterSec, attempt) {
	const explicit = retryAfterSec ? Number(retryAfterSec) * 1000 : 0;
	const backoff = Math.min(RATE_LIMIT_BASE_MS * 2 ** attempt, RATE_LIMIT_MAX_MS);
	const wait = Math.max(explicit, backoff);
	const until = Date.now() + wait;
	if (until > globalCooldownUntil) {
		globalCooldownUntil = until;
		console.log(`Rate limited — pausing ${(wait / 1000).toFixed(0)}s`);
	}
}

async function rlFetch(url, init = {}, attempt = 0) {
	await waitForCooldown();
	const res = await fetch(url, init);
	if (res.status === 429) {
		triggerCooldown(res.headers.get('retry-after'), attempt);
		if (attempt >= 6) throw new Error('429 (max retries)');
		return rlFetch(url, init, attempt + 1);
	}
	return res;
}

async function apiRaw(path, init = {}) {
	return rlFetch(`${API}${path}`, { ...init, headers: { ...headers, ...init.headers } });
}

async function api(path, init = {}) {
	const res = await apiRaw(path, init);
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`HTTP ${res.status} ${path} ${body.slice(0, 300)}`);
	}
	return res.json();
}

// ── Character page fetcher — tries multiple endpoint patterns ─────────────
// Mixamo's internal API has changed over time; we probe the right one.
async function fetchCharacterPage(page) {
	// Try 1: products endpoint with type=Character (standard)
	const r1 = await apiRaw(`/products?page=${page}&limit=${PAGE_LIMIT}&type=Character&order=relevance`);
	if (r1.ok) {
		const d = await r1.json();
		return { results: d.results || [], pagination: d.pagination };
	}

	// Try 2: characters endpoint (some API versions)
	const r2 = await apiRaw(`/characters?page=${page}&limit=${PAGE_LIMIT}&order=relevance`);
	if (r2.ok) {
		const d = await r2.json();
		return { results: d.results || d.characters || [], pagination: d.pagination };
	}

	// Try 3: products without type (all products — filter client-side)
	const r3 = await apiRaw(`/products?page=${page}&limit=${PAGE_LIMIT}&order=relevance`);
	if (r3.ok) {
		const d = await r3.json();
		const results = (d.results || []).filter(
			(p) => p.type === 'Character' || p.product_type === 'Character' || p.category === 'Character',
		);
		return { results, pagination: d.pagination, _usedFallback: true };
	}

	const body = await r3.text().catch(() => '');
	throw new Error(`All character list endpoints failed. Last: HTTP ${r3.status} — ${body.slice(0, 200)}`);
}

// ── Download a single character ───────────────────────────────────────────
async function downloadOne(product, index, total) {
	const name = product.description || product.name || product.id;
	const slug = slugify(name);
	const r2Key = `avatars/mixamo/${slug}.fbx`;
	const localPath = join(OUT_DIR, `${slug}.fbx`);
	const label = `[${index}/${total}]`;
	const existing = catalog.avatars[product.id];

	if (existing?.status === 'completed') {
		const alreadyExists = USE_R2 ? await existsInR2(r2Key) : existsSync(localPath);
		if (alreadyExists) {
			console.log(`${label} skip  ${slug} (already downloaded)`);
			return { skipped: true };
		}
	}
	if (existing?.status === 'permanent_fail') {
		console.log(`${label} skip  ${slug} (permanent fail)`);
		return { skipped: true };
	}

	// Get product details for gms_hash
	let gmsHash;
	try {
		const details = await api(`/products/${product.id}`);
		gmsHash = details?.details?.gms_hash;
	} catch (err) {
		// Some characters expose details at /characters/:id
		try {
			const details = await api(`/characters/${product.id}`);
			gmsHash = details?.details?.gms_hash;
		} catch {
			// gms_hash not required for all export flows — continue without it
		}
	}

	// POST export — try /characters/export first, fall back to /animations/export
	let exportRes;
	const exportBody = {
		product_id: product.id,
		product_name: name,
		type: 'Character',
		preferences: { format: FORMAT, skin: 'true', fps: '30', reducekf: '0' },
		...(gmsHash ? { gms_hash: [gmsHash] } : {}),
	};

	exportRes = await rlFetch(`${API}/characters/export`, {
		method: 'POST',
		headers,
		body: JSON.stringify(exportBody),
	});

	if (!exportRes.ok) {
		// Fall back to animations/export endpoint (some Mixamo versions use this for all types)
		exportRes = await rlFetch(`${API}/animations/export`, {
			method: 'POST',
			headers,
			body: JSON.stringify(exportBody),
		});
	}

	if (!exportRes.ok) {
		const status = exportRes.status;
		if (status === 400 || status === 404) {
			catalog.avatars[product.id] = {
				id: product.id, name, status: 'permanent_fail',
				http: status, failed_at: new Date().toISOString(),
			};
			saveCatalog();
		}
		throw new Error(`export ${status}`);
	}

	// Poll for completion
	let downloadUrl = null;
	for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
		await sleep(POLL_INTERVAL_MS);
		// Try both poll endpoints
		let status;
		try {
			status = await api(`/characters/export/${product.id}`);
		} catch {
			status = await api(`/animations/export/${product.id}`).catch(() => null);
		}
		if (!status) continue;
		if (status.status === 'completed' && status.result?.url) {
			downloadUrl = status.result.url;
			break;
		}
		if (status.status === 'failed') throw new Error('export failed server-side');
		process.stdout.write(`\r${label} waiting... (${i + 1}/${POLL_MAX_ATTEMPTS})   `);
	}
	if (!downloadUrl) throw new Error('poll timeout — no download URL');
	process.stdout.write('\r');

	const fileRes = await rlFetch(downloadUrl);
	if (!fileRes.ok) throw new Error(`download ${fileRes.status}`);
	const buf = Buffer.from(await fileRes.arrayBuffer());

	if (USE_R2) {
		await uploadToR2(r2Key, buf);
	} else {
		writeFileSync(localPath, buf);
	}

	catalog.avatars[product.id] = {
		id: product.id, name,
		file: USE_R2 ? r2Key : `${slug}.fbx`,
		bytes: buf.length,
		downloaded_at: new Date().toISOString(),
		status: 'completed',
		storage: USE_R2 ? 'r2' : 'local',
	};
	saveCatalog();

	console.log(`${label} done  ${slug} (${(buf.length / 1024).toFixed(0)} KB)`);
	return { slug, bytes: buf.length };
}

// ── Main: stream pages, download as they arrive ───────────────────────────
(async () => {
	console.log(`Mixamo avatar fetcher (streaming)`);
	console.log(`   Format:      ${FORMAT} (with skin)`);
	console.log(`   Storage:     ${USE_R2 ? `R2 -> ${R2_BUCKET}/avatars/mixamo/` : OUT_DIR}`);
	console.log(`   Concurrency: ${CONCURRENCY}\n`);

	// Queue + worker pool that runs concurrently
	const queue = [];
	let queueDone = false;
	let totalKnown = '?';
	let fetched = 0;
	let ok = 0;
	let fail = 0;
	let skipped = 0;
	let activeWorkers = 0;

	async function worker() {
		activeWorkers++;
		while (true) {
			if (queue.length === 0) {
				if (queueDone) break;
				await sleep(200);
				continue;
			}
			if (ok + fail >= MAX_DOWNLOADS) break;
			const item = queue.shift();
			try {
				const result = await downloadOne(item.product, item.index, totalKnown);
				if (result.skipped) skipped++;
				else ok++;
			} catch (err) {
				fail++;
				console.warn(`[${item.index}/${totalKnown}] fail  ${item.product.description || item.product.id}: ${err.message}`);
				if (err.message.includes('HTTP 401') || err.message.includes('HTTP 403')) {
					console.error('Auth failure — token expired. Refresh MIXAMO_TOKEN and re-run.');
					process.exit(2);
				}
			}
			await sleep(300);
		}
		activeWorkers--;
	}

	// Start worker pool
	const workers = Array.from({ length: CONCURRENCY }, () => worker());

	// Page fetcher — enqueues products as they arrive
	let page = 1;
	let usedFallback = false;
	while (true) {
		process.stdout.write(`\rFetching page ${page}... (${fetched} characters found so far)   `);
		let pageData;
		try {
			pageData = await fetchCharacterPage(page);
		} catch (err) {
			process.stdout.write('\n');
			console.error(`Failed to list characters: ${err.message}`);
			console.error('Possible causes:');
			console.error('  - Token expired: re-run get-mixamo-token.mjs');
			console.error('  - Mixamo changed their API (check network tab at mixamo.com for the correct endpoint)');
			break;
		}

		if (pageData._usedFallback && !usedFallback) {
			usedFallback = true;
			console.log('\n  Note: using fallback products endpoint — filtering by type=Character client-side');
		}

		const results = pageData.results || [];
		const pagination = pageData.pagination;

		if (results.length === 0) break;

		for (const product of results) {
			fetched++;
			queue.push({ product, index: fetched });
		}

		const numPages = pagination?.num_pages ?? Math.ceil((pagination?.num_results ?? 0) / PAGE_LIMIT);
		if (numPages) totalKnown = (numPages * PAGE_LIMIT).toString() + '+';

		if (!numPages || page >= numPages) break;
		page++;
		await sleep(200);
	}

	process.stdout.write('\n');
	totalKnown = fetched;
	console.log(`Found ${fetched} characters. Downloading...\n`);
	queueDone = true;

	await Promise.all(workers);

	console.log(`\n${'='.repeat(43)}`);
	console.log(`Downloaded: ${ok}`);
	console.log(`Skipped:    ${skipped}`);
	console.log(`Failed:     ${fail}`);
	console.log(`Output:     ${USE_R2 ? `R2:${R2_BUCKET}/avatars/mixamo/` : OUT_DIR}`);
	if (!USE_R2) {
		console.log(`\nConvert FBX -> GLB:`);
		console.log(`   for f in ${OUT_DIR}/*.fbx; do fbx2gltf -i "$f" -o "\${f%.fbx}.glb"; done`);
	}
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
