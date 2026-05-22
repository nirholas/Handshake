#!/usr/bin/env node
/**
 * Downloads all Mixamo FBX animations from jasongzy/Mixamo (HuggingFace)
 * and uploads them to R2 under mixamo/<slug>.fbx
 *
 * Resumable — re-run to continue from where it left off.
 *
 * Usage:
 *   node scripts/hf-mixamo-to-r2.mjs
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// ── Config ────────────────────────────────────────────────────────────────
const HF_REPO = 'jasongzy/Mixamo';
const HF_BASE = `https://huggingface.co/datasets/${HF_REPO}/resolve/main`;
const CONCURRENCY = 4;

// ── Load env ──────────────────────────────────────────────────────────────
function loadEnvVar(key) {
	if (process.env[key]) return process.env[key].trim();
	const envPath = join(process.cwd(), '.env.local');
	if (existsSync(envPath)) {
		const line = readFileSync(envPath, 'utf8').split('\n').find((l) => l.startsWith(`${key}=`));
		if (line) return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '');
	}
	return null;
}

const HF_TOKEN = loadEnvVar('HF_TOKEN');
const R2_ACCOUNT_ID = loadEnvVar('R2_ACCOUNT_ID');
const R2_ACCESS_KEY_ID = loadEnvVar('R2_ACCESS_KEY_ID');
const R2_SECRET_ACCESS_KEY = loadEnvVar('R2_SECRET_ACCESS_KEY');
const R2_BUCKET = loadEnvVar('R2_BUCKET') || 'test';

if (!HF_TOKEN) { console.error('❌ HF_TOKEN not set in .env.local'); process.exit(1); }
if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
	console.error('❌ R2 credentials not set in .env.local'); process.exit(1);
}

// ── R2 client ─────────────────────────────────────────────────────────────
const r2 = new S3Client({
	region: 'auto',
	endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
	credentials: {
		accessKeyId: R2_ACCESS_KEY_ID.trim(),
		secretAccessKey: R2_SECRET_ACCESS_KEY.trim(),
	},
});

async function existsInR2(key) {
	try {
		await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
		return true;
	} catch { return false; }
}

async function uploadToR2(key, buf) {
	await r2.send(new PutObjectCommand({
		Bucket: R2_BUCKET,
		Key: key,
		Body: buf,
		ContentType: 'application/octet-stream',
	}));
}

// ── Manifest ──────────────────────────────────────────────────────────────
mkdirSync('public/animations/mixamo', { recursive: true });
const MANIFEST_PATH = 'public/animations/mixamo/hf-manifest.json';
const manifest = existsSync(MANIFEST_PATH)
	? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
	: {};

function saveManifest() {
	writeFileSync(MANIFEST_PATH + '.tmp', JSON.stringify(manifest, null, 2));
	renameSync(MANIFEST_PATH + '.tmp', MANIFEST_PATH);
}

// ── HuggingFace helpers ───────────────────────────────────────────────────
const hfHeaders = { Authorization: `Bearer ${HF_TOKEN}` };

async function hfGet(url) {
	const res = await fetch(url, { headers: hfHeaders });
	if (!res.ok) throw new Error(`HF ${res.status} ${url}`);
	return res;
}

async function listHFFiles() {
	// Use HF API to list all files in the repo
	let files = [];
	let cursor = null;
	while (true) {
		const url = `https://huggingface.co/api/datasets/${HF_REPO}/tree/main/animation${cursor ? `?cursor=${cursor}` : ''}`;
		const res = await hfGet(url);
		const data = await res.json();
		if (!Array.isArray(data) || data.length === 0) break;
		files.push(...data.filter(f => f.path?.endsWith('.fbx')));
		// Check for next page via Link header
		const link = res.headers.get('link');
		const next = link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
		if (!next) break;
		cursor = new URL(next).searchParams.get('cursor');
		if (!cursor) break;
	}
	return files;
}

// ── Worker pool ───────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function processFile(file, index, total) {
	const uuid = file.path.replace('animation/', '').replace('.fbx', '');
	const r2Key = `mixamo/${uuid}.fbx`;
	const label = `[${index + 1}/${total}]`;

	if (manifest[uuid]?.uploaded) {
		const exists = await existsInR2(r2Key);
		if (exists) {
			process.stdout.write(`${label} ⏭  ${uuid.slice(0, 8)}...\n`);
			return;
		}
	}

	try {
		const res = await hfGet(`${HF_BASE}/animation/${uuid}.fbx`);
		const buf = Buffer.from(await res.arrayBuffer());
		await uploadToR2(r2Key, buf);

		manifest[uuid] = {
			uuid,
			r2Key,
			bytes: buf.length,
			uploaded: true,
			uploaded_at: new Date().toISOString(),
		};
		saveManifest();

		process.stdout.write(`${label} ✅ ${uuid.slice(0, 8)}... (${(buf.length / 1024).toFixed(0)} KB)\n`);
	} catch (err) {
		process.stdout.write(`${label} ❌ ${uuid.slice(0, 8)}...: ${err.message}\n`);
	}
}

async function runPool(files) {
	let cursor = 0;
	async function worker() {
		while (cursor < files.length) {
			const i = cursor++;
			await processFile(files[i], i, files.length);
			await sleep(100);
		}
	}
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

// ── Main ──────────────────────────────────────────────────────────────────
(async () => {
	console.log(`🎬 HuggingFace Mixamo → R2`);
	console.log(`   Repo:    ${HF_REPO}`);
	console.log(`   Bucket:  ${R2_BUCKET}/mixamo/`);
	console.log(`   Workers: ${CONCURRENCY}\n`);

	console.log('📚 Listing files from HuggingFace...');
	const files = await listHFFiles();
	console.log(`📦 Found ${files.length} FBX files\n`);

	const already = Object.values(manifest).filter((m) => m.uploaded).length;
	if (already > 0) console.log(`   Resuming — ${already} already uploaded\n`);

	const t0 = Date.now();
	await runPool(files);
	const mins = ((Date.now() - t0) / 60000).toFixed(1);

	const done = Object.values(manifest).filter((m) => m.uploaded).length;
	console.log(`\n${'═'.repeat(45)}`);
	console.log(`✅ Uploaded: ${done}/${files.length}`);
	console.log(`⏱  Time:     ${mins} min`);
	console.log(`📋 Manifest: ${MANIFEST_PATH}`);
})().catch((err) => {
	console.error('💥', err);
	process.exit(1);
});
