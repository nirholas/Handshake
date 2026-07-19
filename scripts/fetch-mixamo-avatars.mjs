#!/usr/bin/env node
// Bulk-download every Mixamo character avatar as FBX (With Skin).
// Resumable: re-run to pick up where it left off.
//
// Listing the catalog needs no auth (Mixamo's /products?type=Character feed is
// public). Exporting + downloading the actual FBX does need a Mixamo session
// token, same as the animation fetchers.
//
// Usage:
//   node scripts/fetch-mixamo-avatars.mjs               # catalog only, no token needed
//   MIXAMO_TOKEN=eyJ... node scripts/fetch-mixamo-avatars.mjs --download
//   # or put MIXAMO_TOKEN=... in .env.local
//
// Optional flags:
//   --download         run the export+download phase (needs MIXAMO_TOKEN)
//   --concurrency=N    parallel export jobs (default 2)
//   --limit=N          stop after N successful downloads (default: all)
//   --format=fbx7|fbx6 output format (default fbx7)
//
// Prerequisites for --download:
//   node scripts/get-mixamo-token.mjs   (first-time login, needs ADOBE_EMAIL/ADOBE_PASSWORD)

import { mkdirSync, writeFileSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

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

const RUN_DOWNLOAD = !!args.download;
const CONCURRENCY = Number(args.concurrency) || 2;
const MAX_DOWNLOADS = args.limit ? Number(args.limit) : Infinity;
const FORMAT = args.format || 'fbx7';

let globalCooldownUntil = 0;
const RATE_LIMIT_BASE_MS = 30_000;
const RATE_LIMIT_MAX_MS = 300_000;

// ── Env loading (.env.local fallback, same convention as the other mixamo scripts) ──
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

// ── R2 config — S3_* is the name production (Cloud Run) and mixamo-all.mjs use;
// R2_* accepted as a fallback for older local setups. ──────────────────────────
const S3_ENDPOINT = loadEnvVar('S3_ENDPOINT') ||
	(loadEnvVar('R2_ACCOUNT_ID') ? `https://${loadEnvVar('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com` : null);
const S3_ACCESS_KEY_ID = loadEnvVar('S3_ACCESS_KEY_ID') || loadEnvVar('R2_ACCESS_KEY_ID');
const S3_SECRET_ACCESS_KEY = loadEnvVar('S3_SECRET_ACCESS_KEY') || loadEnvVar('R2_SECRET_ACCESS_KEY');
const S3_BUCKET = loadEnvVar('S3_BUCKET') || loadEnvVar('R2_BUCKET') || 'test';
const USE_R2 = !!(S3_ENDPOINT && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY);

let r2 = null;
async function getR2Client() {
	if (r2) return r2;
	const { S3Client } = await import('@aws-sdk/client-s3');
	r2 = new S3Client({
		region: 'auto',
		endpoint: S3_ENDPOINT,
		credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
	});
	return r2;
}

async function existsInR2(key) {
	const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
	try {
		await (await getR2Client()).send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
		return true;
	} catch {
		return false;
	}
}

async function uploadToR2(key, buf) {
	const { PutObjectCommand } = await import('@aws-sdk/client-s3');
	await (await getR2Client()).send(
		new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: buf, ContentType: 'application/octet-stream' }),
	);
}

const authHeaders = {
	Accept: 'application/json',
	'Content-Type': 'application/json',
	'X-Api-Key': 'mixamo2',
	...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
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
// Export API rejects gms_hash whose `params` is the raw [[name, value], …]
// array — it wants the values flattened to a comma-joined string (e.g. "0").
// Sending the raw array still gets a 202 queued response but the job then
// fails async with "Error while generating the animation".
function flattenGmsHash(g) {
	if (!g) return null;
	const params = Array.isArray(g.params) ? g.params.map((p) => p[1]).join(',') : (g.params ?? '0');
	return { ...g, params };
}

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
	const res = await rlFetch(`${API}${path}`, { ...init, headers: { ...authHeaders, ...init.headers } });
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`HTTP ${res.status} ${path} ${body.slice(0, 200)}`);
	}
	return res.json();
}

// ── Step 1: list all Character products — public feed, no auth required ───
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
	// Dedupe by product id — same pattern as the animation catalog fetchers,
	// Mixamo's paginated feed can repeat a product across pages.
	const seen = new Set();
	const unique = all.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
	return unique;
}

// Mixamo has no dedicated "download this character's mesh" endpoint —
// `/characters/export` 404s (not a real route). The actual mechanism the
// mixamo.com frontend uses is exporting a reference Motion (any base pose,
// here "Standing Idle") *targeted at the character* via the same
// `/animations/export` endpoint the animation fetchers use, with
// `skin: 'true'`. That bundles the character's own skinned/textured mesh
// into the exported FBX — confirmed by content-length (12.6 MB vs 900 KB
// for a skinless animation-only clip of the same character.
const REFERENCE_MOTION_ID = 'c9c972d1-b96c-11e4-a802-0aaa78deedf9'; // "Standing Idle"

// ── Step 2: export + poll + download a single character (needs MIXAMO_TOKEN) ──
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

	// Fetch the reference motion's gms_hash, targeted at this character.
	const productDetails = await api(`/products/${REFERENCE_MOTION_ID}?character_id=${product.id}`);
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

	const exportRes = await rlFetch(`${API}/animations/export`, {
		method: 'POST',
		headers: authHeaders,
		body: JSON.stringify({
			character_id: product.id,
			product_id: REFERENCE_MOTION_ID,
			product_name: 'Standing Idle',
			type: 'Motion',
			gms_hash: [flattenGmsHash(gmsHash)],
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

	// The character monitor endpoint is the per-character job status —
	// same one the export's own job_type: 'character_export' reports through.
	let downloadUrl = null;
	for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
		await sleep(POLL_INTERVAL_MS);
		const status = await api(`/characters/${product.id}/monitor`);
		if (status.status === 'completed' && status.job_result) {
			downloadUrl = status.job_result;
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
	console.log(`   Storage:     ${USE_R2 ? `R2 -> ${S3_BUCKET}/avatars/mixamo/` : OUT_DIR}`);

	const products = await listAllCharacters();
	catalog.catalog_size = products.length;
	saveCatalog();
	console.log(`Catalog: ${products.length} characters\n`);

	if (products.length === 0) {
		console.log('No characters found — Mixamo API may be unreachable.');
		process.exit(1);
	}

	if (!RUN_DOWNLOAD) {
		console.log('Catalog-only run (pass --download to export + download FBX files).');
		if (!TOKEN) {
			console.log('\nMIXAMO_TOKEN not set — the download phase needs it.');
			console.log('Get one: node scripts/get-mixamo-token.mjs (needs ADOBE_EMAIL/ADOBE_PASSWORD in .env.local)');
		}
		console.log(`\nCatalog saved: ${CATALOG_PATH}`);
		return;
	}

	if (!TOKEN) {
		console.error('MIXAMO_TOKEN not set. Run: node scripts/get-mixamo-token.mjs');
		process.exit(1);
	}

	console.log(`   Format:      ${FORMAT} (with skin)`);
	console.log(`   Concurrency: ${CONCURRENCY}\n`);

	const t0 = Date.now();
	const { ok, fail, skipped } = await runPool(products);
	const mins = ((Date.now() - t0) / 60000).toFixed(1);

	console.log(`\n${'='.repeat(43)}`);
	console.log(`Downloaded: ${ok}`);
	console.log(`Skipped:    ${skipped}`);
	console.log(`Failed:     ${fail}`);
	console.log(`Time:       ${mins} min`);
	console.log(`Output:     ${USE_R2 ? `R2:${S3_BUCKET}/avatars/mixamo/` : OUT_DIR}`);
	console.log(`\nConvert FBX -> GLB with fbx2gltf:`);
	console.log(`   for f in ${OUT_DIR}/*.fbx; do`);
	console.log(`     fbx2gltf -i "$f" -o "\${f%.fbx}.glb"`);
	console.log(`   done`);
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
