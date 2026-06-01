#!/usr/bin/env node
// Bulk-download Mixamo character avatars as FBX (With Skin).
// Resumable: re-run to pick up where it left off.
//
// Usage:
//   MIXAMO_TOKEN=eyJ... node scripts/fetch-mixamo-avatars.mjs
//   # or put MIXAMO_TOKEN=... in .env.local
//
// Optional flags:
//   --concurrency=N    parallel export jobs (default 2)
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

const CONCURRENCY = Number(args.concurrency) || 2;
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
if (!TOKEN) {
	console.error('MIXAMO_TOKEN not set. Run: node scripts/get-mixamo-token.mjs');
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

async function api(path, init = {}) {
	const res = await rlFetch(`${API}${path}`, { ...init, headers: { ...headers, ...init.headers } });
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`HTTP ${res.status} ${path} ${body.slice(0, 200)}`);
	}
	return res.json();
}

// ── Step 1: list all Character products ──────────────────────────────────
async function listAllCharacters() {
	const all = [];
	let page = 1;
	while (true) {
		process.stdout.write(`\rListing characters: page ${page} (${all.length} so far)...   `);
		const data = await api(
			`/products?page=${page}&limit=${PAGE_LIMIT}&type=Character&order=relevance`,
		);
		const results = data.results || [];
		all.push(...results);
		const totalPages =
			data.pagination?.num_pages ?? Math.ceil((data.pagination?.num_results ?? 0) / PAGE_LIMIT);
		if (!totalPages || page >= totalPages || results.length === 0) break;
		page += 1;
		await sleep(200);
	}
	process.stdout.write('\n');
	return all;
}

// ── Step 2: export + poll + download a single character ─────────────────
async function downloadOne(product) {
	const slug = slugify(product.description || product.name || product.id);
	const r2Key = `avatars/mixamo/${slug}.fbx`;
	const localPath = join(OUT_DIR, `${slug}.fbx`);
	const existing = catalog.avatars[product.id];

	if (existing?.status === 'completed') {
		const alreadyExists = USE_R2 ? await existsInR2(r2Key) : existsSync(localPath);
		if (alreadyExists) return { skipped: true, slug, reason: 'already-downloaded' };
	}
	if (existing?.status === 'permanent_fail') {
		return { skipped: true, slug, reason: 'permanent-fail' };
	}

	// Fetch product details to get gms_hash
	const productDetails = await api(`/products/${product.id}`);
	const gmsHash = productDetails?.details?.gms_hash;
	if (!gmsHash) {
		catalog.avatars[product.id] = {
			id: product.id,
			name: product.description || product.name,
			status: 'permanent_fail',
			reason: 'no_gms_hash',
			failed_at: new Date().toISOString(),
		};
		saveCatalog();
		throw new Error('no gms_hash');
	}

	const exportRes = await rlFetch(`${API}/characters/export`, {
		method: 'POST',
		headers,
		body: JSON.stringify({
			product_id: product.id,
			product_name: product.description || product.name,
			type: 'Character',
			gms_hash: [gmsHash],
			preferences: { format: FORMAT, skin: 'true', fps: '30', reducekf: '0' },
		}),
	});

	if (!exportRes.ok) {
		const status = exportRes.status;
		if (status === 400 || status === 404) {
			catalog.avatars[product.id] = {
				id: product.id,
				name: product.description || product.name,
				status: 'permanent_fail',
				http: status,
				failed_at: new Date().toISOString(),
			};
			saveCatalog();
		}
		throw new Error(`export ${status}`);
	}

	let downloadUrl = null;
	for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
		await sleep(POLL_INTERVAL_MS);
		const status = await api(`/characters/export/${product.id}`);
		if (status.status === 'completed' && status.result?.url) {
			downloadUrl = status.result.url;
			break;
		}
		if (status.status === 'failed') throw new Error('export failed');
	}
	if (!downloadUrl) throw new Error('poll timeout');

	const fileRes = await rlFetch(downloadUrl);
	if (!fileRes.ok) throw new Error(`download ${fileRes.status}`);
	const buf = Buffer.from(await fileRes.arrayBuffer());

	if (USE_R2) {
		await uploadToR2(r2Key, buf);
	} else {
		writeFileSync(localPath, buf);
	}

	catalog.avatars[product.id] = {
		id: product.id,
		name: product.description || product.name,
		file: USE_R2 ? r2Key : `${slug}.fbx`,
		bytes: buf.length,
		downloaded_at: new Date().toISOString(),
		status: 'completed',
		storage: USE_R2 ? 'r2' : 'local',
	};
	saveCatalog();

	return { slug, bytes: buf.length };
}

// ── Step 3: concurrency-limited worker pool ─────────────────────────────
async function runPool(products) {
	let cursor = 0;
	let ok = 0;
	let fail = 0;
	let skipped = 0;

	async function worker() {
		while (cursor < products.length && ok + fail < MAX_DOWNLOADS) {
			const i = cursor++;
			const product = products[i];
			const label = `[${i + 1}/${products.length}]`;
			try {
				const result = await downloadOne(product);
				if (result.skipped) {
					skipped++;
					console.log(`${label} skip  ${result.slug} (${result.reason})`);
				} else {
					ok++;
					console.log(`${label} done  ${result.slug} (${(result.bytes / 1024).toFixed(0)} KB)`);
					await sleep(500);
				}
			} catch (err) {
				fail++;
				console.warn(`${label} fail  ${product.description}: ${err.message}`);
				if (err.message.includes('HTTP 401') || err.message.includes('HTTP 403')) {
					console.error('Auth failure — token expired. Refresh MIXAMO_TOKEN and re-run.');
					process.exit(2);
				}
			}
		}
	}

	const workers = Array.from({ length: CONCURRENCY }, () => worker());
	await Promise.all(workers);
	return { ok, fail, skipped };
}

// ── Main ──────────────────────────────────────────────────────────────────
(async () => {
	console.log(`Mixamo avatar fetcher`);
	console.log(`   Format:      ${FORMAT} (with skin)`);
	console.log(`   Storage:     ${USE_R2 ? `R2 -> ${R2_BUCKET}/avatars/mixamo/` : OUT_DIR}`);
	console.log(`   Concurrency: ${CONCURRENCY}\n`);

	const products = await listAllCharacters();
	console.log(`Catalog: ${products.length} characters\n`);

	if (products.length === 0) {
		console.log('No characters found. Token may be expired.');
		console.log('Re-run: node scripts/get-mixamo-token.mjs');
		process.exit(1);
	}

	const t0 = Date.now();
	const { ok, fail, skipped } = await runPool(products);
	const mins = ((Date.now() - t0) / 60000).toFixed(1);

	console.log(`\n${'='.repeat(43)}`);
	console.log(`Downloaded: ${ok}`);
	console.log(`Skipped:    ${skipped}`);
	console.log(`Failed:     ${fail}`);
	console.log(`Time:       ${mins} min`);
	console.log(`Output:     ${USE_R2 ? `R2:${R2_BUCKET}/avatars/mixamo/` : OUT_DIR}`);
	console.log(`\nConvert FBX -> GLB with fbx2gltf:`);
	console.log(`   for f in ${OUT_DIR}/*.fbx; do`);
	console.log(`     fbx2gltf -i "$f" -o "\${f%.fbx}.glb"`);
	console.log(`   done`);
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
